/**
 * MUFAP fund profile collector: risk profile, loads, fees, benchmark, trustee,
 * rating, net assets, published returns and expense ratios for each Shariah fund.
 *
 *   node fund-profile-collector.js --dry-run --limit 3   # scrape and print, no writes
 *   node fund-profile-collector.js                      # scrape and upsert fund_profiles
 *   node fund-profile-collector.js --cached             # re-parse tmp/profiles without fetching
 *
 * The profile page fills itself with JavaScript, so it is rendered in the same
 * persistent browser session the payout collector uses. Funds are taken from the
 * verified fund-profile-map.json (exact MUFAP ID -> catalog UUID), never by fuzzy name.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { createClient } = require('@supabase/supabase-js');
const { MufapClient } = require('./mufap-client');

const PROFILE_URL = 'https://www.mufap.com.pk/FundProfile/FundDetail?FundID=';
const CACHE_DIR = path.join(__dirname, 'tmp', 'profiles');
const LABELS = {
  'Front-End Load': 'front_end_load', 'Back-End Load': 'back_end_load', 'Contingent Load': 'contingent_load',
  'Management Fee': 'management_fee', 'Dealing Days': 'dealing_days', 'Cut-off Time': 'cutoff_time',
  'Risk Profile': 'risk_profile', 'Pricing Mechanism': 'pricing_mechanism', 'Benchmark': 'benchmark',
  'Trustee': 'trustee', 'Auditor': 'auditor', 'Rating': 'rating', 'Rating Company': 'rating_company',
  'Rating Date': 'rating_date', 'Leverage': 'leverage', 'Fund Manager': 'fund_manager',
};
const NUMERIC_LABELS = {
  'Net Assets': 'net_assets_pkr_mn', 'Net Assets (excluding FoFs)': 'net_assets_ex_fof_pkr_mn',
  'Total Expense Ratio (TER-YTD %)': 'ter_ytd_pct', 'Total Expense Ratio (TER-MTD %)': 'ter_mtd_pct',
  'Government Levies (YTD %)': 'gov_levies_ytd_pct', 'Government Levies (MTD %)': 'gov_levies_mtd_pct',
  'Selling And Marketing (S&M %)': 'selling_marketing_pct',
};
const RETURN_TENURES = ['YTD', 'MTD', '1 Month', '3 Month', '6 Month', '9 Month', '1 Year'];
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const number = value => {
  const cleaned = String(value || '').replace(/[,%\s]/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
};
const blank = value => !value || /^(?:N\/A|NA|-|Data Not Found)$/i.test(value.trim());

function parseInceptionDate(text) {
  const match = text.match(/Inception Date:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const month = match && MONTHS[match[1].toLowerCase()];
  return month ? `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}` : null;
}

// Pure parser over the rendered page text, so it can be tested offline.
// The page prints "Label:" on one line and the value on the next; empty fields are hidden or "N/A".
function parseProfileText(text, allocation = []) {
  const lines = text.split(/\r?\n/).map(line => line.replace(/​/g, '').trim()).filter(Boolean);
  const profile = { inception_date: parseInceptionDate(text), returns: {}, asset_allocation: allocation, top_holdings: [] };
  for (const column of [...Object.values(LABELS), ...Object.values(NUMERIC_LABELS)]) profile[column] = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const label = lines[i].replace(/:$/, '');
    if (!lines[i].endsWith(':')) continue;
    const value = lines[i + 1];
    if (LABELS[label] && !blank(value) && !value.endsWith(':')) profile[LABELS[label]] = value;
    if (NUMERIC_LABELS[label]) profile[NUMERIC_LABELS[label]] = number(value);
  }
  const returnsStart = lines.indexOf('Fund Returns');
  if (returnsStart >= 0) {
    for (const line of lines.slice(returnsStart, returnsStart + 12)) {
      const [tenure, value] = line.split('\t').map(part => part.trim());
      if (RETURN_TENURES.includes(tenure) && number(value) !== null) profile.returns[tenure] = number(value);
    }
  }
  const asOf = text.match(/Asset Allocation\s*\(PKR millions\)\s*as of\s*([A-Za-z]+-\d{4})/i);
  profile.asset_allocation_as_of = asOf ? asOf[1] : null;
  return profile;
}

class FundProfileCollector {
  constructor(options = {}) {
    this.mufap = options.mufap || new MufapClient({ mode: 'browser', log: options.log });
    this.delayMs = options.delayMs ?? Number(process.env.RATE_LIMIT_DELAY || 1500);
    this.log = options.log || console.log;
  }

  async scrape(entry) {
    const url = PROFILE_URL + entry.mufap_fund_id;
    await this.mufap.get(url);
    const page = this.mufap.page;
    // The values arrive by XHR after the HTML loads. Wait for the returns table or a quiet network.
    // The fund heading ("Inception Date: May 20, 2003") is filled by the same XHR batch as the details.
    const rendered = await page.waitForFunction(() => /Inception Date:\s*[A-Za-z]+ \d/.test(document.body.innerText), null, { timeout: 30000 })
      .then(() => true, () => false);
    if (!rendered) throw new Error(`Profile ${entry.mufap_fund_id} did not load its data`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const { text, allocation } = await page.evaluate(() => {
      const chart = (window.Highcharts?.charts || []).find(c => c && c.title?.textStr === 'Assets Allocation');
      const axis = chart?.xAxis?.[0];
      const allocation = chart ? chart.series.flatMap(s => s.data.map(p => ({
        asset: String(p.name || (Array.isArray(axis?.categories) ? axis.categories[p.x] : axis?.names?.[p.x]) || p.category || ''),
        pkr_mn: p.y,
      }))) : [];
      return { text: document.body.innerText, allocation };
    });
    const heading = text.match(/^\s*(.+)\n.*Inception Date:/m);
    if (!/Fund Information/.test(text)) throw new Error(`Profile ${entry.mufap_fund_id} did not render`);
    return { entry, url, text, allocation, heading: heading?.[1]?.trim() || null, scraped_at: new Date().toISOString() };
  }

  toRow(raw) {
    const profile = parseProfileText(raw.text, raw.allocation.filter(a => a.asset && Number.isFinite(a.pkr_mn)));
    return { fund_id: raw.entry.fund_id, mufap_fund_id: raw.entry.mufap_fund_id, ...profile,
      source_url: raw.url, scraped_at: raw.scraped_at, updated_at: new Date().toISOString() };
  }

  async collect({ entries, cached = false, onRow }) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const rows = [], failures = [];
    for (const [index, entry] of entries.entries()) {
      const file = path.join(CACHE_DIR, `${entry.mufap_fund_id}.json`);
      try {
        let raw;
        if (cached) {
          if (!fs.existsSync(file)) { failures.push({ entry, error: 'not cached' }); continue; }
          raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } else {
          raw = await this.scrape(entry);
          fs.writeFileSync(file, JSON.stringify(raw));
          await sleep(this.delayMs);
        }
        const row = this.toRow(raw);
        rows.push(row);
        if (onRow) await onRow(row);
        this.log(`  [${index + 1}/${entries.length}] ${entry.fund_name}: risk=${row.risk_profile || '-'} TER=${row.ter_ytd_pct ?? '-'} assets=${row.net_assets_pkr_mn ?? '-'}`);
      } catch (error) {
        failures.push({ entry, error: error.message });
        this.log(`  [${index + 1}/${entries.length}] ${entry.fund_name}: FAILED ${error.message.split('\n')[0]}`);
      }
    }
    return { rows, failures };
  }
}

async function main(args = process.argv.slice(2)) {
  const flag = name => args.includes(name);
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (flag('--help')) {
    console.log('Usage: node fund-profile-collector.js [--dry-run] [--cached] [--limit N] [--fund "name"]');
    return;
  }
  const dryRun = flag('--dry-run');
  let entries = require('./fund-profile-map.json');
  // VPS sub-funds and plans can share a MUFAP ID with siblings; one fund_id per MUFAP ID is enough here.
  entries = [...new Map(entries.map(e => [e.fund_id, e])).values()];
  if (value('--fund')) entries = entries.filter(e => e.fund_name.toLowerCase().includes(value('--fund').toLowerCase()));
  if (value('--limit')) entries = entries.slice(0, Number(value('--limit')));
  if (!entries.length) throw new Error('No funds selected.');

  const db = dryRun ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  if (db) {
    const { error } = await db.from('fund_profiles').select('fund_id', { head: true, count: 'exact' });
    if (error) throw new Error(`fund_profiles is not available (${error.message}). Apply migrations/001-ai-assistant.sql first.`);
  }
  console.log(`${dryRun ? 'DRY RUN: ' : ''}Collecting ${entries.length} MUFAP fund profiles${flag('--cached') ? ' from cache' : ''}...`);
  const collector = new FundProfileCollector();
  const pending = [];
  const flush = async () => {
    if (!db || !pending.length) return;
    const batch = pending.splice(0);
    const { error } = await db.from('fund_profiles').upsert(batch, { onConflict: 'fund_id' });
    if (error) throw new Error(`Upsert failed: ${error.message}`);
  };
  try {
    const { rows, failures } = await collector.collect({ entries, cached: flag('--cached'),
      onRow: async row => { pending.push(row); if (pending.length >= 25) await flush(); } });
    await flush();
    const filled = column => rows.filter(r => r[column] !== null && r[column] !== undefined).length;
    console.log(`\nParsed ${rows.length}, failed ${failures.length}. Coverage: risk ${filled('risk_profile')}, TER ${filled('ter_ytd_pct')}, ` +
      `mgmt fee ${filled('management_fee')}, benchmark ${filled('benchmark')}, fund manager ${filled('fund_manager')}, net assets ${filled('net_assets_pkr_mn')}`);
    if (dryRun && rows[0]) console.log('Sample row:', JSON.stringify(rows[0], null, 2));
    if (failures.length) fs.writeFileSync(path.join(__dirname, 'tmp', 'profile-failures.json'), JSON.stringify(failures, null, 2));
    if (db) {
      const { count, error } = await db.from('fund_profiles').select('fund_id', { count: 'exact', head: true });
      if (error) throw new Error(`Readback failed: ${error.message}`);
      console.log(`Readback: fund_profiles now has ${count} rows.`);
    }
  } finally {
    await collector.mufap.close();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(`Fund profile collection failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { FundProfileCollector, parseProfileText, parseInceptionDate, main };
