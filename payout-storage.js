const { normalizeName, normalizeFundNameForAMC } = require('./fund-identity');

const identity = (fund, amc) => JSON.stringify([normalizeFundNameForAMC(fund, amc), normalizeName(amc)]);

class PayoutStorage {
  constructor(supabase, { dryRun = true, batchSize = 100, fundId = null, amcId = null,
    quarantineConflicts = false, profileMap = null } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid payout batch size.');
    this.supabase = supabase;
    this.dryRun = dryRun;
    this.batchSize = batchSize;
    this.fundId = fundId;
    this.amcId = amcId;
    this.quarantineConflicts = quarantineConflicts;
    if (profileMap === null) {
      const file = require('node:path').join(__dirname, 'fund-profile-map.json');
      profileMap = require('node:fs').existsSync(file) ? JSON.parse(require('node:fs').readFileSync(file, 'utf8')) : [];
    }
    this.profileMap = new Map(profileMap.map(row => [row.mufap_fund_id, row]));
    this.issues = new Map();
    this.fundsByName = new Map();
    this.unmatched = new Map();
    this.stats = { matched: 0, upserted: 0, outsideCatalog: 0, unmatchedShariah: 0 };
  }

  async initialize() {
    // Paginate even though today's catalog has fewer than 1,000 funds.
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await this.supabase.from('funds')
        .select('fund_id,amc_id,fund_name,category_name,amcs(amc_name)')
        .eq('is_shariah_compliant', true).order('fund_id').range(offset, offset + 999);
      if (error) throw new Error(`Cannot read fund catalog: ${error.message}`);
      for (const fund of data || []) {
        if (!fund.amcs?.amc_name) throw new Error(`Missing AMC for ${fund.fund_name}.`);
        const key = identity(fund.fund_name, fund.amcs.amc_name);
        const matches = this.fundsByName.get(key) || [];
        matches.push(fund);
        this.fundsByName.set(key, matches);
      }
      if (!data || data.length < 1000) break;
    }
    if (!this.fundsByName.size) throw new Error('The Shariah fund catalog is empty.');
    const catalog = [...this.fundsByName.values()].flat();
    this.catalog = catalog;
    if ((this.fundId || this.amcId) && !catalog.some(fund =>
      (!this.fundId || fund.fund_id === this.fundId) && (!this.amcId || fund.amc_id === this.amcId))) {
      throw new Error('Requested fund/AMC UUID is not in the existing Shariah catalog.');
    }
    const { error } = await this.supabase.from('fund_payouts')
      .select('fund_id,amc_id,payout_date,payout_per_unit,ex_nav,mufap_fund_id,source_fund_name,source_amc_name,category,inception_date,report_date,source_date_from,source_date_to,scraped_at').limit(1);
    if (error && !['PGRST205', '42P01', '42703', 'PGRST204'].includes(error.code)) {
      throw new Error(`Cannot check payout schema: ${error.message}`);
    }
    const { error: coverageError } = await this.supabase.from('fund_payout_coverage')
      .select('fund_id,date_from,date_to,status,row_count,checked_at').limit(1);
    if (coverageError && !['PGRST205', '42P01', '42703', 'PGRST204'].includes(coverageError.code)) {
      throw new Error(`Cannot check payout coverage schema: ${coverageError.message}`);
    }
    this.schemaReady = !error && !coverageError;
    if (!this.schemaReady && !this.dryRun) {
      throw new Error('Payout schema is missing or incomplete. Run setup-payout-database.sql in Supabase first.');
    }
    return this.schemaReady;
  }

  prepareRecords(records) {
    const rows = new Map();
    this.chunkIssueFundIds = new Set();
    this.chunkIssueKeys = new Set();
    for (const record of records) {
      let matches = this.fundsByName.get(identity(record.fund_name, record.amc_name)) || [];
      const profile = this.profileMap.get(record.mufap_fund_id);
      if (profile) {
        const exact = this.catalog.filter(fund => fund.fund_id === profile.fund_id && fund.amc_id === profile.amc_id &&
          normalizeName(fund.amcs.amc_name) === normalizeName(record.amc_name));
        if (exact.length !== 1 || (matches.length && !matches.some(fund => fund.fund_id === profile.fund_id))) {
          throw new Error(`Verified MUFAP profile identity disagrees with the report/catalog for ${record.fund_name}.`);
        }
        matches = exact;
      }
      if (matches.length > 1) {
        const byCategory = matches.filter(fund => normalizeName(fund.category_name) === normalizeName(record.category));
        if (byCategory.length !== 1) {
          throw new Error(`Ambiguous database fund: ${record.fund_name} / ${record.amc_name} / ${record.category}. No writes for this chunk.`);
        }
        matches = byCategory;
      }
      if (!matches.length) {
        if (this.fundId || this.amcId) {
          throw new Error(`Unrecognized payout in the requested fund/AMC report: ${record.fund_name} / ${record.amc_name}.`);
        }
        this.stats.outsideCatalog++;
        if (/shariah|islamic/i.test(record.category)) {
          this.stats.unmatchedShariah++;
          const key = identity(record.fund_name, record.amc_name);
          const previous = this.unmatched.get(key);
          this.unmatched.set(key, { fund_name: record.fund_name, amc_name: record.amc_name,
            mufap_fund_id: record.mufap_fund_id, rows: (previous?.rows || 0) + 1 });
        }
        continue;
      }
      const fund = matches[0];
      if ((this.fundId && fund.fund_id !== this.fundId) || (this.amcId && fund.amc_id !== this.amcId)) {
        throw new Error(`MUFAP returned payouts outside the requested fund/AMC: ${record.fund_name}.`);
      }
      const row = {
        fund_id: fund.fund_id, amc_id: fund.amc_id,
        payout_date: record.payout_date, payout_per_unit: record.payout_per_unit, ex_nav: record.ex_nav,
        mufap_fund_id: record.mufap_fund_id,
        source_fund_name: record.fund_name, source_amc_name: record.amc_name,
        category: record.category, inception_date: record.inception_date,
        report_date: record.report_date, source_date_from: record.source_date_from,
        source_date_to: record.source_date_to, scraped_at: record.scraped_at
      };
      const key = JSON.stringify([row.fund_id, row.payout_date]);
      const previous = rows.get(key);
      if (this.chunkIssueKeys.has(key) || (previous && (previous.payout_per_unit !== row.payout_per_unit || previous.ex_nav !== row.ex_nav ||
          previous.mufap_fund_id !== row.mufap_fund_id))) {
        if (!this.quarantineConflicts) throw new Error(`Conflicting payouts for ${record.fund_name} on ${row.payout_date}. No writes for this chunk.`);
        const issue = this.issues.get(key) || { fund_id: row.fund_id, payout_date: row.payout_date,
          reason: 'conflicting_source_payouts', records: previous ? [previous] : [] };
        if (!issue.records.some(r => r.payout_per_unit === row.payout_per_unit && r.ex_nav === row.ex_nav && r.mufap_fund_id === row.mufap_fund_id)) issue.records.push(row);
        this.issues.set(key, issue);
        this.chunkIssueKeys.add(key);
        this.chunkIssueFundIds.add(row.fund_id);
        rows.delete(key);
        continue;
      }
      rows.set(key, row);
    }
    return [...rows.values()].sort((a, b) => a.payout_date.localeCompare(b.payout_date) || a.fund_id.localeCompare(b.fund_id));
  }

  async storeChunk(records, chunk = null) {
    // Validate every match and same-day collision before making any writes.
    const unmatchedBefore = this.stats.unmatchedShariah;
    const rows = this.prepareRecords(records);
    this.stats.matched += rows.length;
    if (this.dryRun) return;
    if (chunk) await this.writeCoverage(chunk, rows, 'pending');
    for (let offset = 0; offset < rows.length; offset += this.batchSize) {
      const batch = rows.slice(offset, offset + this.batchSize);
      const { error } = await this.supabase.from('fund_payouts')
        .upsert(batch, { onConflict: 'fund_id,payout_date' });
      if (error) throw new Error(`Payout storage failed: ${error.message}. Rerun the same range; upserts prevent duplicates.`);
      this.stats.upserted += batch.length;
    }
    if (chunk) {
      await this.verifyStoredChunk(rows, chunk);
      await this.writeCoverage(chunk, rows,
        this.stats.unmatchedShariah > unmatchedBefore ? 'needs_review' : 'verified');
    }
  }

  async verifyStoredChunk(rows, chunk) {
    const expected = new Map(rows.map(row => [JSON.stringify([row.fund_id, row.payout_date]), row]));
    const catalogIds = new Set(this.catalog.map(fund => fund.fund_id));
    for (let offset = 0; ; offset += 1000) {
      let query = this.supabase.from('fund_payouts')
        .select('fund_id,amc_id,payout_date,payout_per_unit,ex_nav')
        .gte('payout_date', chunk.from).lte('payout_date', chunk.to)
        .order('fund_id').order('payout_date').range(offset, offset + 999);
      if (this.fundId) query = query.eq('fund_id', this.fundId);
      if (this.amcId) query = query.eq('amc_id', this.amcId);
      const { data, error } = await query;
      if (error) throw new Error(`Payout readback failed: ${error.message}. Coverage remains pending.`);
      for (const row of data || []) {
        if (!catalogIds.has(row.fund_id)) continue;
        const key = JSON.stringify([row.fund_id, row.payout_date]);
        if (this.chunkIssueKeys.has(key)) continue; // Existing disputed data is withheld by needs_review coverage.
        const source = expected.get(key);
        if (!source) throw new Error(`Stored payout ${row.fund_id}/${row.payout_date} is absent from this source report. Review it; no rows were deleted and coverage remains pending.`);
        if (row.amc_id !== source.amc_id || Number(row.payout_per_unit) !== source.payout_per_unit || Number(row.ex_nav) !== source.ex_nav) {
          throw new Error(`Payout readback differs from source for ${row.fund_id}/${row.payout_date}. Coverage remains pending.`);
        }
        expected.delete(key);
      }
      if (!data || data.length < 1000) break;
    }
    if (expected.size) throw new Error(`${expected.size} payouts missing on database readback. Coverage remains pending.`);
  }

  async writeCoverage(chunk, rows, status) {
    const counts = new Map();
    for (const row of rows) counts.set(row.fund_id, (counts.get(row.fund_id) || 0) + 1);
    const entries = this.catalog.filter(fund => (!this.fundId || fund.fund_id === this.fundId) &&
      (!this.amcId || fund.amc_id === this.amcId)).map(fund => ({
      fund_id: fund.fund_id, date_from: chunk.from, date_to: chunk.to,
      status: status === 'pending' ? status : this.chunkIssueFundIds.has(fund.fund_id) ? 'needs_review' :
        status === 'needs_review' && [...this.profileMap.values()].some(p => p.fund_id === fund.fund_id) ? 'verified' : status,
      row_count: counts.get(fund.fund_id) || 0, checked_at: new Date().toISOString()
    }));
    for (let offset = 0; offset < entries.length; offset += this.batchSize) {
      const { error } = await this.supabase.from('fund_payout_coverage')
        .upsert(entries.slice(offset, offset + this.batchSize), { onConflict: 'fund_id,date_from,date_to' });
      if (error) throw new Error(`Payout coverage update failed: ${error.message}. Rerun this range before using its total return.`);
    }
  }

  writeUnmatchedReport() {
    const fs = require('node:fs');
    const path = require('node:path');
    const output = path.join(__dirname, 'tmp', 'payout-unmatched.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify([...this.unmatched.values()], null, 2));
    fs.writeFileSync(path.join(__dirname, 'tmp', 'payout-issues.json'), JSON.stringify([...this.issues.values()], null, 2));
    return output;
  }
}

module.exports = PayoutStorage;
