/**
 * MUFAP Industry Stats Historical Payout Collector
 *
 * Scrapes payout/dividend data from:
 *   https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=4
 *
 * The default run fetches historical payouts from 1995-01-01 through the
 * current date. The full range is split into smaller date chunks because a
 * single 30+ year request is very slow and can time out.
 *
 * Usage:
 *   node industry-stats-collector.js
 *   node industry-stats-collector.js --summary-only
 *   node industry-stats-collector.js --print-only --records-only
 *   node industry-stats-collector.js --print-only --limit 20
 *   node industry-stats-collector.js --print-only --json
 *   node industry-stats-collector.js --from 2026-01-01 --to 2026-06-13
 *   node industry-stats-collector.js --chunk-months 1
 *   node industry-stats-collector.js --sector "Open-End Funds"
 *   node industry-stats-collector.js --category "Shariah"
 *   node industry-stats-collector.js --amc "Meezan"
 *   node industry-stats-collector.js --fund "Daily Income"
 *   node industry-stats-collector.js --dry-run --from 2026-08-01 --to 2026-08-31
 *   node industry-stats-collector.js --store
 *
 * Default: collect and store. Run setup-payout-database.sql once first.
 * Use --dry-run to validate without writes or --print-only to only scrape.
 */

const cheerio = require('cheerio');
const { MufapClient, isChallenge, mufapError } = require('./mufap-client');
const { normalizeName, normalizeFundName } = require('./fund-identity');
require('dotenv').config();
require('node:dns').setDefaultResultOrder('ipv4first');

class IndustryStatsCollector {
  constructor(options = {}) {
    this.mufapBaseUrl = 'https://www.mufap.com.pk';
    this.mufap = options.mufapClient || new MufapClient({
      profileDir: require('node:path').join(__dirname, '.mufap-payout-browser'),
      ...options, log: console.error
    });
    this.stats = {
      chunksFetched: 0,
      rawRowsFound: 0,
      uniqueRowsFound: 0,
      duplicateRowsSkipped: 0,
      errors: []
    };
  }

  async fetchPage(options = {}) {
    const url = `${this.mufapBaseUrl}/Industry/IndustryStatDaily`;
    const params = {
      tab: '4',
      AMCId: options.amcId || 'null',
      fundId: options.fundId || 'null',
      datefrom: options.from,
      datetill: options.to
    };

    if (!options.silent) {
      console.log(`Fetching payouts: ${params.datefrom} to ${params.datetill}`);
    }

    return this.mufap.get(`${url}?${new URLSearchParams(params)}`);
  }

  parsePage(html, sourceRange = {}) {
    if (isChallenge(html)) throw mufapError('MUFAP_BLOCKED', 'MUFAP returned a browser challenge instead of payouts.');
    const $ = cheerio.load(html);
    const table = $('#table_id');
    const headers = table.find('thead th').map((_i, el) => normalizeName($(el).text())).get();
    const expected = ['sector', 'amc', 'fund', 'category', 'inception date', 'payout (per unit)', 'ex-nav', 'payout date'];
    if (!table.length || expected.some((header, index) => headers[index] !== header)) {
      throw mufapError('MUFAP_INVALID_RESPONSE', 'MUFAP did not return the expected payout table.');
    }
    const records = [];
    const reportDate = this.extractReportDate($);

    table.find('tbody tr').each((index, row) => {
      try {
        const cols = $(row).find('td');

        if (!cols.length) return;
        if (cols.length === 1 && /^(no data available in table|no records found)\.?$/i.test($(cols[0]).text().trim())) return;
        if (cols.length !== 8) throw new Error(`Expected 8 payout columns, received ${cols.length}.`);

        const className = $(row).attr('class') || '';
        const sectorIdMatch = className.match(/\bsectorId(\d+)\b/);
        const categoryIdMatch = className.match(/\bcatgoryId(\d+)\b/);
        const fundHref = $(cols[2]).find('a').attr('href') || '';
        const fundIdMatch = fundHref.match(/[?&]FundID=(\d+)/i);

        const record = {
          mufap_fund_id: fundIdMatch ? Number(fundIdMatch[1]) : null,
          sector_id: sectorIdMatch ? Number(sectorIdMatch[1]) : null,
          category_id: categoryIdMatch ? Number(categoryIdMatch[1]) : null,
          sector: $(cols[0]).text().trim(),
          amc_name: $(cols[1]).text().trim(),
          fund_name: $(cols[2]).text().trim(),
          category: $(cols[3]).text().trim(),
          inception_date: this.parseDisplayDate($(cols[4]).text().trim()),
          payout_per_unit: this.parseNumber($(cols[5]).text().trim()),
          ex_nav: this.parseNumber($(cols[6]).text().trim()),
          payout_date: this.parseDisplayDate($(cols[7]).text().trim()),
          report_date: reportDate,
          source_date_from: sourceRange.from || null,
          source_date_to: sourceRange.to || null,
          scraped_at: new Date().toISOString(),
          source_row: index + 1
        };
        // Undated, zero-valued placeholders do not describe a distribution.
        if (!$(cols[7]).text().trim() && record.payout_per_unit === 0 && record.ex_nav === 0) return;
        if (!record.fund_name || !record.amc_name || !record.payout_date ||
            record.payout_per_unit === null || record.payout_per_unit < 0 ||
            record.ex_nav === null || record.ex_nav < 0) {
          throw new Error('Missing or invalid fund, AMC, payout amount, ex-NAV, or payout date.');
        }
        if ((sourceRange.from && record.payout_date < sourceRange.from) ||
            (sourceRange.to && record.payout_date > sourceRange.to)) {
          throw new Error(`Payout date ${record.payout_date} is outside the requested range.`);
        }
        records.push(record);
      } catch (error) {
        throw mufapError('MUFAP_INVALID_RESPONSE', `Row ${index + 1}: ${error.message}`);
      }
    });

    return records;
  }

  extractReportDate($) {
    const text = $('body').text().replace(/\s+/g, ' ');
    const match = text.match(/Report Date:\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);

    if (match) {
      return this.parseDisplayDate(match[1]);
    }

    return null;
  }

  parseDisplayDate(value) {
    if (!value) return null;

    const months = {
      Jan: '01',
      Feb: '02',
      Mar: '03',
      Apr: '04',
      May: '05',
      Jun: '06',
      Jul: '07',
      Aug: '08',
      Sep: '09',
      Oct: '10',
      Nov: '11',
      Dec: '12'
    };

    const parts = value.trim().replace(',', '').split(/\s+/);
    if (parts.length === 3 && months[parts[0]]) {
      const iso = `${parts[2]}-${months[parts[0]]}-${parts[1].padStart(2, '0')}`;
      try { this.parseISODate(iso); return iso; } catch { return null; }
    }

    return null;
  }

  parseNumber(value) {
    const text = String(value || '').trim();
    if (!/^-?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)$/.test(text)) return null;
    const parsed = Number(text.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  getCurrentDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());

    const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${lookup.year}-${lookup.month}-${lookup.day}`;
  }

  parseISODate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
    }

    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error(`Invalid calendar date "${value}".`);
    }
    return date;
  }

  formatISODate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  addDays(date, days) {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  addMonths(date, months) {
    const next = new Date(date.getTime());
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    return next;
  }

  buildDateChunks(from, to, chunkMonths) {
    if (!Number.isInteger(chunkMonths) || chunkMonths < 1 || chunkMonths > 120) {
      throw new Error('chunk-months must be an integer from 1 to 120.');
    }
    const chunks = [];
    const finalDate = this.parseISODate(to);
    let cursor = this.parseISODate(from);

    if (cursor > finalDate) {
      throw new Error(`Start date ${from} is after end date ${to}.`);
    }

    while (cursor <= finalDate) {
      const nextStart = this.addMonths(cursor, chunkMonths);
      const chunkEndCandidate = this.addDays(nextStart, -1);
      const chunkEnd = chunkEndCandidate < finalDate ? chunkEndCandidate : finalDate;

      chunks.push({
        from: this.formatISODate(cursor),
        to: this.formatISODate(chunkEnd)
      });

      cursor = this.addDays(chunkEnd, 1);
    }

    return chunks;
  }

  getDedupKey(record) {
    return JSON.stringify([record.mufap_fund_id || normalizeFundName(record.fund_name),
      normalizeName(record.amc_name), record.payout_date]);
  }

  mergeUnique(target, records, seenKeys, preserveConflicts = false) {
    const addedRecords = [];

    records.forEach(record => {
      const key = this.getDedupKey(record);

      if (seenKeys.has(key)) {
        const previous = seenKeys.get(key);
        if (previous.payout_per_unit !== record.payout_per_unit || previous.ex_nav !== record.ex_nav) {
          if (!preserveConflicts) throw new Error(`Conflicting payouts for ${record.fund_name} on ${record.payout_date}.`);
          target.push(record);
          addedRecords.push(record);
          return;
        }
        this.stats.duplicateRowsSkipped++;
        return;
      }

      seenKeys.set(key, record);
      target.push(record);
      addedRecords.push(record);
    });

    return addedRecords;
  }

  recordMatchesFilters(record, options = {}) {
    if (options.sector) {
      const sector = options.sector.toLowerCase();
      if (!record.sector.toLowerCase().includes(sector)) return false;
    }

    if (options.category) {
      const category = options.category.toLowerCase();
      if (!record.category.toLowerCase().includes(category)) return false;
    }

    if (options.amc) {
      const amc = options.amc.toLowerCase();
      if (!record.amc_name.toLowerCase().includes(amc)) return false;
    }

    if (options.fund) {
      const fund = options.fund.toLowerCase();
      if (!record.fund_name.toLowerCase().includes(fund)) return false;
    }

    return true;
  }

  filterRecords(records, options = {}) {
    let filtered = records.filter(record => this.recordMatchesFilters(record, options));

    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  sortRecords(records) {
    records.sort((left, right) => {
      const leftDate = left.payout_date || '';
      const rightDate = right.payout_date || '';
      if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);

      const leftAmc = left.amc_name || '';
      const rightAmc = right.amc_name || '';
      if (leftAmc !== rightAmc) return leftAmc.localeCompare(rightAmc);

      return (left.fund_name || '').localeCompare(right.fund_name || '');
    });
  }

  buildSummary(records) {
    const sectors = {};
    const categories = {};
    const amcs = {};
    let earliestPayout = null;
    let latestPayout = null;

    records.forEach(record => {
      sectors[record.sector] = (sectors[record.sector] || 0) + 1;
      categories[record.category] = (categories[record.category] || 0) + 1;
      amcs[record.amc_name] = (amcs[record.amc_name] || 0) + 1;

      if (record.payout_date) {
        earliestPayout = earliestPayout && earliestPayout < record.payout_date
          ? earliestPayout
          : record.payout_date;
        latestPayout = latestPayout && latestPayout > record.payout_date
          ? latestPayout
          : record.payout_date;
      }
    });

    return { sectors, categories, amcs, earliestPayout, latestPayout };
  }

  printSummary(records, printedCount, options) {
    const summary = this.buildSummary(records);

    console.log('');
    console.log('='.repeat(100));
    console.log('MUFAP Historical Payout Data');
    console.log('='.repeat(100));
    console.log(`Requested range: ${options.from} to ${options.to}`);
    console.log(`Chunk size: ${options.chunkMonths} month(s)`);
    console.log(`Chunks fetched: ${this.stats.chunksFetched}`);
    console.log(`Raw rows scraped: ${this.stats.rawRowsFound}`);
    console.log(`Unique payout rows: ${records.length}`);
    console.log(`Duplicate rows skipped: ${this.stats.duplicateRowsSkipped}`);
    console.log(`Rows matching display filters: ${printedCount}`);
    console.log(`Payout date coverage: ${summary.earliestPayout || 'N/A'} to ${summary.latestPayout || 'N/A'}`);
    console.log(`Source: ${this.mufapBaseUrl}/Industry/IndustryStatDaily?tab=4`);
    console.log('');
    console.log('Sectors:');
    Object.entries(summary.sectors).forEach(([name, count]) => {
      console.log(`  ${count.toString().padStart(5, ' ')}  ${name}`);
    });
    console.log('');
    console.log(`AMCs: ${Object.keys(summary.amcs).length}`);
    console.log(`Categories: ${Object.keys(summary.categories).length}`);
    console.log('='.repeat(100));
    console.log('');
  }

  printRecords(records, options = {}, startIndex = 1) {
    if (options.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }

    records.forEach((record, index) => {
      console.log(`${startIndex + index}. [${record.mufap_fund_id || 'N/A'}] ${record.sector} | ${record.amc_name}`);
      console.log(`   Fund: ${record.fund_name}`);
      console.log(`   Category: ${record.category}`);
      console.log(`   Inception Date: ${record.inception_date || 'N/A'}`);
      console.log(`   Payout Per Unit: ${record.payout_per_unit ?? 'N/A'} | Ex-NAV: ${record.ex_nav ?? 'N/A'} | Payout Date: ${record.payout_date || 'N/A'}`);
      console.log(`   Report Date: ${record.report_date}`);
      console.log('');
    });
  }

  async collect(options = {}) {
    try {
      return await this.runCollection(options);
    } finally {
      await this.mufap.close();
    }
  }

  async runCollection(options = {}) {
    const chunks = this.buildDateChunks(options.from, options.to, options.chunkMonths);
    const records = [];
    const seenKeys = new Map();
    let streamedPrintCount = 0;
    const shouldStreamPrint = !options.json && !options.summaryOnly;
    const showProgress = !options.json && !options.recordsOnly;

    if (showProgress) {
      console.log(`Preparing to fetch ${chunks.length} payout chunk(s) from ${options.from} to ${options.to}.`);
    }

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const chunkOptions = {
        ...options,
        ...chunk,
        silent: options.json || options.recordsOnly
      };

      try {
        if (showProgress) {
          console.log(`[${index + 1}/${chunks.length}] ${chunk.from} to ${chunk.to}`);
        }

        const html = await this.fetchPage(chunkOptions);
        const chunkRecords = this.parsePage(html, chunk);
        this.stats.rawRowsFound += chunkRecords.length;
        this.stats.chunksFetched++;
        const addedRecords = this.mergeUnique(records, chunkRecords, seenKeys, options.quarantineConflicts);
        if (options.onChunk) await options.onChunk(addedRecords, chunk);

        if (showProgress) {
          console.log(`  Rows: ${chunkRecords.length}, unique so far: ${records.length}`);
        }

        if (shouldStreamPrint) {
          const printableRecords = addedRecords.filter(record => this.recordMatchesFilters(record, options));
          const limitedRecords = options.limit
            ? printableRecords.slice(0, Math.max(options.limit - streamedPrintCount, 0))
            : printableRecords;

          if (limitedRecords.length > 0) {
            this.sortRecords(limitedRecords);
            this.printRecords(limitedRecords, options, streamedPrintCount + 1);
            streamedPrintCount += limitedRecords.length;
          }
        }

        if (index < chunks.length - 1 && options.delayMs > 0) {
          await this.delay(options.delayMs);
        }
      } catch (error) {
        const message = `${chunk.from} to ${chunk.to}: ${error.message}`;
        this.stats.errors.push(message);
        console.error(`  Error: ${message}`);

        throw error;
      }
    }

    this.sortRecords(records);
    this.stats.uniqueRowsFound = records.length;

    const filteredRecords = this.filterRecords(records, options);

    if (!options.json && !options.recordsOnly) {
      this.printSummary(records, filteredRecords.length, options);
    }

    if (!options.summaryOnly && !shouldStreamPrint) {
      this.printRecords(filteredRecords, options);
    }

    if (!options.json && !options.recordsOnly) {
      console.log('='.repeat(100));
      console.log(`Done. Scraped ${records.length} unique historical payout records.`);
      console.log(`Errors: ${this.stats.errors.length}`);
      if (this.stats.errors.length > 0) {
        this.stats.errors.slice(0, 10).forEach((error, index) => {
          console.log(`  ${index + 1}. ${error}`);
        });
      }
      console.log('='.repeat(100));
    }

    return filteredRecords;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function readArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function readNumberArg(args, name, fallback) {
  const value = readArg(args, name);
  if (value === null || value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  return parsed;
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const valueFlags = ['--amc-id', '--fund-id', '--from', '--to', '--chunk-months', '--delay', '--timeout',
    '--sector', '--category', '--amc', '--fund', '--limit', '--challenge-timeout'];
  const switches = ['--json', '--summary-only', '--records-only', '--stop-on-error', '--store', '--dry-run',
    '--http-only', '--browser', '--help', '--print-only'];
  for (let index = 0; index < args.length; index++) {
    if (valueFlags.includes(args[index])) { readArg(args, args[index]); index++; }
    else if (!switches.includes(args[index])) throw new Error(`Unknown option: ${args[index]}`);
  }
  if (args.includes('--help')) {
    console.log('Usage: node industry-stats-collector.js [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
    console.log('Default: collect and store payouts for existing Shariah funds (requires setup-payout-database.sql once).');
    console.log('--dry-run: validate without writes. --print-only: scrape only. --store remains an optional alias for the default.');
    console.log('See PAYOUT-COLLECTOR.md for setup, filters, transport, and reruns.');
    return;
  }
  if (args.includes('--http-only') && args.includes('--browser')) throw new Error('Choose one transport flag.');
  if (args.includes('--print-only') && (args.includes('--store') || args.includes('--dry-run'))) {
    throw new Error('--print-only cannot be combined with --store or --dry-run.');
  }
  const databaseMode = !args.includes('--print-only');
  if (databaseMode && (args.includes('--limit') || args.includes('--json'))) {
    throw new Error('--limit and --json require --print-only. For database collection, narrow the date range or use --fund instead.');
  }
  const timeoutMs = readNumberArg(args, '--timeout', 180000);
  const challengeSeconds = readNumberArg(args, '--challenge-timeout', 120);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 ||
      challengeSeconds < 1 || challengeSeconds * 1000 > 2147483647) {
    throw new Error('Timeouts must be positive and at most 2147483647 milliseconds; --timeout must be an integer.');
  }
  const CollectorClass = dependencies.Collector || IndustryStatsCollector;
  const collector = new CollectorClass({ timeoutMs, challengeTimeoutMs: challengeSeconds * 1000,
    mode: args.includes('--http-only') ? 'http' : args.includes('--browser') ? 'browser' : undefined });
  const options = {
    amcId: readArg(args, '--amc-id') || 'null',
    fundId: readArg(args, '--fund-id') || 'null',
    from: readArg(args, '--from') || '1995-01-01',
    to: readArg(args, '--to') || collector.getCurrentDate(),
    chunkMonths: readNumberArg(args, '--chunk-months', 3),
    delayMs: readNumberArg(args, '--delay', 500),
    timeoutMs,
    sector: readArg(args, '--sector'),
    category: readArg(args, '--category'),
    amc: readArg(args, '--amc'),
    fund: readArg(args, '--fund'),
    limit: readNumberArg(args, '--limit', null),
    json: args.includes('--json'),
    summaryOnly: databaseMode || args.includes('--summary-only'),
    recordsOnly: args.includes('--records-only'),
    stopOnError: true
  };
  options.quarantineConflicts = databaseMode;
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0) throw new Error('--delay must be a nonnegative integer.');
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }
  collector.buildDateChunks(options.from, options.to, options.chunkMonths);
  let storage;
  const cancelled = async () => {
    console.error('Payout collection interrupted. Rerun the same range to complete it.');
    await collector.mufap.close();
    process.exit(130);
  };
  process.once('SIGINT', cancelled);
  process.once('SIGTERM', cancelled);
  try {
    if (databaseMode) {
      const createClient = dependencies.createClient || require('@supabase/supabase-js').createClient;
      const PayoutStorage = dependencies.Storage || require('./payout-storage');
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env (same as the NAV collector).');
      }
      storage = new PayoutStorage(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY),
        { dryRun: args.includes('--dry-run'), quarantineConflicts: true,
          fundId: options.fundId === 'null' ? null : options.fundId,
          amcId: options.amcId === 'null' ? null : options.amcId });
      await storage.initialize();
      if (!storage.schemaReady) console.error('Payout table is missing. Matching will be tested, but --store requires setup-payout-database.sql.');
      // Text-filtered subsets cannot prove that every distribution was seen.
      const fullReport = ![options.sector, options.category, options.amc, options.fund].some(Boolean);
      options.onChunk = async (records, chunk) => storage.storeChunk(
        records.filter(record => collector.recordMatchesFilters(record, options)), fullReport ? chunk : null);
    }
    await collector.collect(options);
    if (storage) {
      console.log(`${storage.dryRun ? 'DRY RUN (no writes)' : 'DATABASE'}: ${JSON.stringify(storage.stats)}`);
      if (!storage.schemaReady) {
        console.error('NOT READY TO STORE: run setup-payout-database.sql in Supabase, then repeat this dry run.');
        process.exitCode = 1;
      }
    }
  } finally {
    if (storage) {
      const output = storage.writeUnmatchedReport();
      if (storage.unmatched.size) {
        console.error(`Skipped ${storage.stats.unmatchedShariah} Shariah payout rows outside the matched catalog. Review ${output}. No fund mappings were guessed.`);
      }
      if (storage.issues.size) console.error(`${storage.issues.size} disputed fund/date payouts quarantined. See tmp/payout-issues.json; affected return periods require review.`);
    }
    process.removeListener('SIGINT', cancelled);
    process.removeListener('SIGTERM', cancelled);
    await collector.mufap.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Industry stats payout collection failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = IndustryStatsCollector;
module.exports.main = main;
