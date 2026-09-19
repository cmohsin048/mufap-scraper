/**
 * MUFAP NAV Data Collector
 * Collects and stores historical daily NAV data for all Shariah-compliant funds
 * 
 * Features:
 * - Efficient batch processing
 * - Handles large datasets (20+ years of data per fund)
 * - Prevents duplicates with upsert
 * - Resume capability if interrupted
 * - Progress tracking
 * 
 * Installation:
 * npm install
 */

const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');
const { MufapClient, isChallenge, mufapError } = require('./mufap-client');
const dns = require('dns');
require('dotenv').config();

// Prefer IPv4: undici (used by supabase-js) intermittently fails with
// "TypeError: fetch failed" on Windows when IPv6 is advertised but unreliable.
dns.setDefaultResultOrder('ipv4first');

class NAVDataCollector {
  constructor(supabaseUrl, supabaseKey, options = {}) {
    // Surface the underlying network error code (ECONNRESET, EAI_AGAIN, ...)
    // instead of undici's opaque "TypeError: fetch failed".
    const resilientFetch = async (url, options) => {
      try {
        return await fetch(url, options);
      } catch (err) {
        const cause = err.cause?.code || err.cause?.message || '';
        throw new Error(`fetch failed${cause ? ` (${cause})` : ''}`);
      }
    };
    this.supabase = createClient(supabaseUrl, supabaseKey, {
      global: { fetch: resilientFetch }
    });
    this.mufapBaseUrl = 'https://www.mufap.com.pk';
    this.mufap = options.mufapClient || new MufapClient(options);
    this.dryRun = options.dryRun || false;
    this.stats = {
      fundsProcessed: 0,
      totalNavRecords: 0,
      newRecords: 0,
      updatedRecords: 0,
      errors: [],
      skipped: 0
    };
    this.batchSize = 100; // Insert 100 NAV records at a time
  }

  /**
   * Setup NAV data table in Supabase
   * Run this SQL first in Supabase SQL Editor
   */
  async setupDatabase() {
    console.log('\n📋 Database Setup for NAV Data:');
    console.log('Run this SQL in your Supabase SQL Editor:\n');
    console.log(`
-- ==================== Daily NAV Table ====================
CREATE TABLE IF NOT EXISTS daily_nav (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL REFERENCES funds(fund_id) ON DELETE CASCADE,
  amc_id UUID NOT NULL REFERENCES amcs(amc_id) ON DELETE CASCADE,
  nav_date DATE NOT NULL,
  nav DECIMAL(15, 4),
  offer_price DECIMAL(15, 4),
  repurchase_price DECIMAL(15, 4),
  front_end_load DECIMAL(5, 2) DEFAULT 0,
  back_end_load DECIMAL(5, 2) DEFAULT 0,
  contingent_load DECIMAL(5, 2) DEFAULT 0,
  market_value DECIMAL(20, 4) DEFAULT 0,
  inception_date DATE,
  category TEXT,
  trustee TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Unique constraint to prevent duplicates
  UNIQUE(fund_id, nav_date)
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_nav_fund_date ON daily_nav(fund_id, nav_date DESC);
CREATE INDEX IF NOT EXISTS idx_nav_date ON daily_nav(nav_date DESC);
CREATE INDEX IF NOT EXISTS idx_nav_amc ON daily_nav(amc_id);
CREATE INDEX IF NOT EXISTS idx_nav_fund ON daily_nav(fund_id);

-- Composite index for range queries
CREATE INDEX IF NOT EXISTS idx_nav_fund_date_range ON daily_nav(fund_id, nav_date DESC, nav);

-- ==================== Fund Progress Tracking ====================
CREATE TABLE IF NOT EXISTS nav_collection_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL REFERENCES funds(fund_id) ON DELETE CASCADE,
  amc_id UUID NOT NULL REFERENCES amcs(amc_id) ON DELETE CASCADE,
  last_collected_date DATE,
  total_records INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending, in_progress, completed, error
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fund_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_status ON nav_collection_progress(status);
CREATE INDEX IF NOT EXISTS idx_progress_fund ON nav_collection_progress(fund_id);

-- ==================== Helper Function: Update Fund Stats ====================
CREATE OR REPLACE FUNCTION update_fund_nav_stats()
RETURNS TRIGGER AS $$
BEGIN
  -- Update progress table
  INSERT INTO nav_collection_progress (fund_id, amc_id, last_collected_date, total_records, status, updated_at)
  VALUES (
    NEW.fund_id,
    NEW.amc_id,
    NEW.nav_date,
    1,
    'completed',
    NOW()
  )
  ON CONFLICT (fund_id)
  DO UPDATE SET
    last_collected_date = GREATEST(nav_collection_progress.last_collected_date, NEW.nav_date),
    total_records = nav_collection_progress.total_records + 1,
    status = 'completed',
    completed_at = NOW(),
    updated_at = NOW();
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update progress
DROP TRIGGER IF EXISTS trigger_update_nav_stats ON daily_nav;
CREATE TRIGGER trigger_update_nav_stats
AFTER INSERT ON daily_nav
FOR EACH ROW
EXECUTE FUNCTION update_fund_nav_stats();

-- ==================== View: Latest NAV per Fund ====================
CREATE OR REPLACE VIEW latest_nav
WITH (security_invoker = true) AS
SELECT DISTINCT ON (fund_id)
  fund_id,
  amc_id,
  nav_date,
  nav,
  offer_price,
  repurchase_price
FROM daily_nav
ORDER BY fund_id, nav_date DESC;

-- ==================== View: Fund Performance Summary ====================
CREATE OR REPLACE VIEW fund_performance
WITH (security_invoker = true) AS
SELECT 
  f.fund_id,
  f.fund_name,
  f.category_name,
  a.amc_name,
  COUNT(dn.id) as total_nav_records,
  MIN(dn.nav_date) as earliest_data,
  MAX(dn.nav_date) as latest_data,
  MIN(dn.nav) as min_nav,
  MAX(dn.nav) as max_nav,
  AVG(dn.nav) as avg_nav
FROM funds f
JOIN amcs a ON f.amc_id = a.amc_id
LEFT JOIN daily_nav dn ON f.fund_id = dn.fund_id
WHERE f.is_shariah_compliant = true
GROUP BY f.fund_id, f.fund_name, f.category_name, a.amc_name;
    `);
    console.log('\n✅ Copy and run the above SQL in Supabase SQL Editor\n');
  }

  /**
   * Parse HTML table to extract NAV data
   */
  parseNavTable(html) {
    if (isChallenge(html)) throw mufapError('MUFAP_BLOCKED', 'MUFAP returned a browser challenge instead of NAV data.');
    const $ = cheerio.load(html);
    const navData = [];
    const table = $('#table_id');
    const headings = table.find('thead').text().replace(/\s+/g, ' ');
    if (!table.length || !/NAV/i.test(headings) || !/Validity\s*Date/i.test(headings)) {
      throw mufapError('MUFAP_INVALID_RESPONSE', 'MUFAP did not return the expected NAV table. Progress was not advanced.');
    }
    let groupAmc = '';
    table.find('tbody tr').each((index, row) => {
      if ($(row).hasClass('group')) {
        groupAmc = $(row).text().trim();
        return;
      }
      if ($(row).hasClass('fund-block')) {
        const cols = $(row).find('td');
        // Raw server HTML includes AMC; DataTables may remove it when grouping.
        const offset = cols.length === 13 ? -1 : 0;
        if (![13, 14].includes(cols.length)) {
          throw mufapError('MUFAP_INVALID_RESPONSE', `Unexpected NAV columns in row ${index + 1}. Progress was not advanced.`);
        }
        const cell = i => $(cols[i + offset]).text().trim();
        const navText = cell(7).replace(/[,\s]/g, '');

        // MUFAP keeps a fund row when the requested dates have no NAV: its
        // validity date is blank and all three prices are explicitly zero.
        // This is a placeholder, not a dated NAV record or a parsing failure.
        if (!cell(8) && cell(2) && [5, 6, 7].every(i => /^0(?:\.0+)?$/.test(cell(i).replace(/[,\s]/g, '')))) {
          return;
        }

        const record = {
          sector: $(cols[0]).text().trim(),
          amc_name: offset ? groupAmc : $(cols[1]).text().trim(),
          fund_name: cell(2),
          category: cell(3),
          inception_date: this.parseDate(cell(4)),
          offer_price: this.parseFloat(cell(5)),
          repurchase_price: this.parseFloat(cell(6)),
          nav: navText ? Number(navText) : NaN,
          nav_date: this.parseDate(cell(8)),
          front_end_load: this.parseFloat(cell(9)),
          back_end_load: this.parseFloat(cell(10)),
          contingent_load: this.parseFloat(cell(11)),
          market_value: this.parseFloat(cell(12)),
          trustee: cell(13)
        };

        if (!record.nav_date || !Number.isFinite(record.nav) || record.nav < 0 || !record.fund_name) {
          throw mufapError('MUFAP_INVALID_RESPONSE', `Invalid NAV or date in row ${index + 1}. Progress was not advanced.`);
        }
        navData.push(record);
      }
    });

    return navData;
  }

  /**
   * Parse date from various formats
   */
  parseDate(dateStr) {
    if (!dateStr) return null;
    
    try {
      // Format: "Nov 01, 2025" or "Aug 08, 2003"
      const months = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
        'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
        'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
      };

      const parts = dateStr.trim().replace(',', '').split(/\s+/);
      if (parts.length === 3) {
        const month = months[parts[0]];
        const day = parts[1].padStart(2, '0');
        const year = parts[2];
        const iso = `${year}-${month}-${day}`;
        const date = new Date(`${iso}T00:00:00Z`);
        return month && /^\d{4}-\d{2}-\d{2}$/.test(iso) &&
          !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
      }
    } catch (error) {
      console.error('Date parse error:', dateStr, error.message);
    }
    
    return null;
  }

  /**
   * Parse float values safely
   */
  parseFloat(str) {
    if (!str) return 0;
    const cleaned = str.replace(/[,\s]/g, '');
    const value = parseFloat(cleaned);
    return isNaN(value) ? 0 : value;
  }

  /**
   * MUFAP sometimes repeats the fund family around the full plan name:
   * "Family Fund (Family Plan II)" and "Family Plan II" identify the same plan.
   * Ignore trailing former-name notes and redundant wrappers, but retain plan
   * numbers and other qualifiers that identify a distinct fund.
   */
  normalizeFundName(name, amcName = '') {
    // Both "(Formerly Old Name)" and "(Formerly: Old Name)" occur in
    // database names. Strip only explicit trailing rename notes, never
    // arbitrary parentheses (which can contain a distinct plan or class).
    const normalized = name.trim().replace(/\s+/g, ' ').toLowerCase()
      .replace(/(?:\s*\(formerly(?:\s*:\s*|\s+)[^()]+\))+$/, '').trim();
    // MUFAP's current and legacy directories use these two names for the
    // same Alfalah fund (inception 2020-09-21). Keep aliases exact and AMC-scoped.
    // https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3
    // https://beta.mufap.com.pk/Industry/IndustryStatDaily?tab=4
    if (amcName.trim().replace(/\s+/g, ' ').toLowerCase() === 'alfalah asset management limited' &&
        normalized === 'alfalah islamic rozana amdani fund') {
      return 'alfalah islamic amdani fund';
    }
    const wrapped = normalized.match(/^(.+?)\s*\(([^()]+)\)$/);
    if (wrapped) {
      const parent = wrapped[1].trim();
      const plan = wrapped[2].trim();
      const family = parent.replace(/\s+fund$/, '');
      if (family !== parent && plan.startsWith(`${family} `)) return plan;
    }
    return normalized;
  }

  /**
   * Fetch NAV data from MUFAP for a specific date range
   */
  async fetchNavData(amcId, fundId, dateFrom, dateTo) {
    const params = new URLSearchParams({
      tab: '3',
      AMCId: amcId,
      fundId: fundId,
      datefrom: dateFrom,
      datetill: dateTo
    });
    const url = `${this.mufapBaseUrl}/Industry/IndustryStatDaily?${params}`;

    const records = this.parseNavTable(await this.mufap.get(url));
    if (records.some(record => record.nav_date < dateFrom || record.nav_date > dateTo)) {
      throw mufapError('MUFAP_INVALID_RESPONSE', 'MUFAP returned dates outside the requested range. Progress was not advanced.');
    }
    return records;
  }

  /**
   * Retry a Supabase query on transient network failures.
   * queryFn must return a fresh query each call; result keeps the
   * { data, error } shape so callers are unchanged.
   */
  async withRetry(queryFn, label, attempts = 6) {
    const delays = [2000, 5000, 10000, 20000, 40000];
    let result;
    for (let i = 1; i <= attempts; i++) {
      result = await queryFn();
      const msg = result.error?.message || '';
      const transient = msg.includes('fetch failed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('EAI_AGAIN');
      if (!result.error || !transient) return result;
      if (i < attempts) {
        const wait = delays[Math.min(i - 1, delays.length - 1)];
        console.warn(`      ⚠️  ${label}: ${msg} (attempt ${i}/${attempts}), retrying in ${wait / 1000}s...`);
        await this.delay(wait);
      }
    }
    return result;
  }

  /**
   * Get all Shariah-compliant funds from database
   */
  async getAllFunds() {
    const { data, error } = await this.withRetry(() => this.supabase
      .from('funds')
      .select(`
        fund_id,
        amc_id,
        fund_name,
        category_name,
        amcs (amc_name)
      `)
      .eq('is_shariah_compliant', true)
      .order('fund_name'), 'getAllFunds');

    if (error) throw error;
    return data;
  }

  /**
   * Get last collected date for a fund
   */
  async getLastCollectedDate(fundId) {
    const { data, error } = await this.withRetry(() => this.supabase
      .from('nav_collection_progress')
      .select('last_collected_date')
      .eq('fund_id', fundId)
      .single(), 'getLastCollectedDate');

    if (error && error.code !== 'PGRST116') { // Not found is okay
      // Don't fall back to a full 1962 re-collection on a network blip —
      // fail this fund so it is retried on the next run instead.
      throw new Error(`Could not read collection progress: ${error.message}`);
    }

    return data?.last_collected_date || null;
  }

  /**
   * Fetch collection progress for all funds in one query
   */
  async getProgressMap() {
    const { data, error } = await this.withRetry(() => this.supabase
      .from('nav_collection_progress')
      .select('fund_id,last_collected_date')
      .limit(10000), 'getProgressMap');

    if (error) throw new Error(`Could not read collection progress: ${error.message}`);

    const map = new Map();
    (data || []).forEach(row => map.set(row.fund_id, row.last_collected_date));
    return map;
  }

  /**
   * Store NAV data in batches
   */
  async storeNavData(fundId, amcId, navRecords) {
    if (navRecords.length === 0) return { inserted: 0, updated: 0 };

    // The database trigger advances the date after every inserted batch. Store
    // oldest first and stop at the first failure so it cannot skip a failed gap.
    const byDate = new Map();
    for (const record of navRecords) {
      const previous = byDate.get(record.nav_date);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
        throw new Error(`Conflicting NAV rows for ${record.nav_date}; refusing to choose a value.`);
      }
      byDate.set(record.nav_date, record);
    }
    navRecords = [...byDate.values()].sort((a, b) => a.nav_date.localeCompare(b.nav_date));
    if (this.dryRun) return { inserted: navRecords.length, updated: 0 };

    let inserted = 0;
    let updated = 0;

    // Process in batches
    for (let i = 0; i < navRecords.length; i += this.batchSize) {
      const batch = navRecords.slice(i, i + this.batchSize);
      
      const recordsToInsert = batch.map(record => ({
        fund_id: fundId,
        amc_id: amcId,
        nav_date: record.nav_date,
        nav: record.nav,
        offer_price: record.offer_price,
        repurchase_price: record.repurchase_price,
        front_end_load: record.front_end_load,
        back_end_load: record.back_end_load,
        contingent_load: record.contingent_load,
        market_value: record.market_value,
        inception_date: record.inception_date,
        category: record.category,
        trustee: record.trustee,
        updated_at: new Date().toISOString()
      }));

      const { error } = await this.withRetry(() => this.supabase
        .from('daily_nav')
        .upsert(recordsToInsert, {
          onConflict: 'fund_id,nav_date',
          returning: 'minimal'
        }), 'storeNavData');

      if (error) {
        throw new Error(`NAV batch ${Math.floor(i / this.batchSize) + 1} failed: ${error.message}`);
      }
      inserted += batch.length;
      await this.delay(100);
    }

    return { inserted, updated };
  }

  /**
   * Update collection progress
   */
  async updateProgress(fundId, amcId, status, lastDate = null, errorMsg = null) {
    if (this.dryRun) return;
    const updateData = {
      fund_id: fundId,
      amc_id: amcId,
      status: status,
      updated_at: new Date().toISOString(),
      error_message: errorMsg || null
    };

    if (lastDate) {
      updateData.last_collected_date = lastDate;
    }

    if (status === 'completed') {
      updateData.completed_at = new Date().toISOString();
    }

    if (status === 'in_progress' && !lastDate) {
      updateData.started_at = new Date().toISOString();
    }

    const { error } = await this.withRetry(() => this.supabase
      .from('nav_collection_progress')
      .upsert(updateData, {
        onConflict: 'fund_id',
        returning: 'minimal'
      }), 'updateProgress');

    if (error) throw error;
  }

  /**
   * Collect NAV data for a single fund
   */
  async collectFundNavData(fund, forceFullCollection = false, knownLastDate = undefined) {
    const fundName = fund.fund_name.trim();
    const amcName = fund.amcs.amc_name;

    console.log(`\n  📊 ${fundName}`);
    console.log(`      AMC: ${amcName}`);

    try {
      // Determine date range
      let startDate = '1962-01-01'; // Oldest fund in Pakistan
      let endDate = new Date().toISOString().split('T')[0]; // Today

      if (!forceFullCollection) {
        const lastDate = knownLastDate !== undefined
          ? knownLastDate
          : await this.getLastCollectedDate(fund.fund_id);
        if (lastDate) {
          // Resume from last collected date + 1 day
          const lastDateObj = new Date(lastDate);
          lastDateObj.setUTCDate(lastDateObj.getUTCDate() + 1);
          startDate = lastDateObj.toISOString().split('T')[0];
          console.log(`      📅 Resuming from: ${startDate}`);
        } else {
          console.log(`      📅 Full collection: ${startDate} to ${endDate}`);
        }
      } else {
        console.log(`      📅 Force full collection: ${startDate} to ${endDate}`);
      }

      // Check if we need to collect
      if (startDate > endDate) {
        console.log(`      ✓ Already up to date`);
        this.stats.skipped++;
        return;
      }

      // Fetch NAV data
      console.log(`      ⏳ Fetching data...`);
      const navRecords = await this.fetchNavData(
        fund.amc_id,
        fund.fund_id,
        startDate,
        endDate
      );

      const normalizeName = name => name.trim().replace(/\s+/g, ' ').toLowerCase();
      if (navRecords.some(record => this.normalizeFundName(record.fund_name, record.amc_name || amcName) !== this.normalizeFundName(fundName, amcName) ||
          (record.amc_name && normalizeName(record.amc_name) !== normalizeName(amcName)))) {
        const returnedNames = [...new Set(navRecords.map(record => `${record.fund_name} / ${record.amc_name}`))];
        throw mufapError('MUFAP_FUND_MISMATCH',
          `MUFAP fund/AMC did not match the database. Expected: ${fundName} / ${amcName}. ` +
          `Received: ${returnedNames.slice(0, 3).join('; ')}. No records were stored for this fund.`);
      }

      if (navRecords.length === 0) {
        console.log(`      ℹ️  No new NAV data found`);
        // No data is not evidence that all dates through today were collected.
        await this.updateProgress(fund.fund_id, fund.amc_id, 'completed');
        this.stats.skipped++;
        return;
      }

      console.log(`      💾 ${this.dryRun ? 'Validating' : 'Storing'} ${navRecords.length} records...`);
      await this.updateProgress(fund.fund_id, fund.amc_id, 'in_progress');
      
      // Store data
      const result = await this.storeNavData(
        fund.fund_id,
        fund.amc_id,
        navRecords
      );

      // Update progress
      const latestDate = navRecords.reduce((latest, record) => {
        return record.nav_date > latest ? record.nav_date : latest;
      }, navRecords[0].nav_date);

      await this.updateProgress(fund.fund_id, fund.amc_id, 'completed', latestDate);

      console.log(`      ✅ ${this.dryRun ? 'Would store' : 'Stored'} ${result.inserted} records`);
      console.log(`      📈 Latest NAV: ${navRecords.find(record => record.nav_date === latestDate).nav} (${latestDate})`);

      this.stats.fundsProcessed++;
      this.stats.totalNavRecords += navRecords.length;
      this.stats.newRecords += result.inserted;

    } catch (error) {
      // Site-wide failures leave progress untouched and stop the run once.
      if (error.code?.startsWith('MUFAP_')) throw error;

      console.error(`      ❌ Error: ${error.message}`);
      try {
        await this.updateProgress(fund.fund_id, fund.amc_id, 'error', null, error.message);
      } catch (progressError) {
        console.error(`      ⚠️  Could not record error status: ${progressError.message}`);
      }
      this.stats.errors.push({
        fund: fundName,
        amc: amcName,
        error: error.message
      });
    }
  }

  /**
   * Delay helper
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Main collection process
   */
  async collectAllNavData(options = {}) {
    try {
      return await this.runCollection(options);
    } finally {
      await this.mufap.close();
    }
  }

  async runCollection(options = {}) {
    const {
      forceFullCollection = false,
      fundsLimit = null,
      delayBetweenFunds = 2000 // 2 seconds between funds
    } = options;

    console.log('\n' + '='.repeat(60));
    console.log('📈 MUFAP NAV Data Collection');
    console.log('='.repeat(60));
    console.log(`Force Full Collection: ${forceFullCollection}`);
    console.log(`Delay Between Funds: ${delayBetweenFunds}ms`);
    console.log(`MUFAP transport: ${this.mufap.mode}`);
    if (this.dryRun) console.log('DRY RUN: NAV data and collection progress will not be written.');
    console.log('='.repeat(60) + '\n');

    const startTime = Date.now();

    // Get all funds
    console.log('📋 Fetching Shariah-compliant funds...');
    let funds = await this.getAllFunds();

    if (fundsLimit) {
      funds = funds.slice(0, fundsLimit);
      console.log(`⚠️  Limited to first ${fundsLimit} funds for testing\n`);
    }

    console.log(`Found ${funds.length} funds to process\n`);

    // Process least-recently-collected funds first, so an eventual
    // Cloudflare block costs the freshest data, not the stalest.
    const progressMap = forceFullCollection ? new Map() : await this.getProgressMap();
    if (!forceFullCollection) {
      funds.sort((a, b) => {
        const da = progressMap.get(a.fund_id) || '1900-01-01';
        const db = progressMap.get(b.fund_id) || '1900-01-01';
        return da < db ? -1 : da > db ? 1 : 0;
      });
    }

    let stoppedEarly = false;
    let stopReason = null;

    // Process each fund
    for (let i = 0; i < funds.length; i++) {
      const fund = funds[i];
      const progress = `[${i + 1}/${funds.length}]`;

      console.log(`${progress} Processing...`);

      try {
        const knownLastDate = forceFullCollection
          ? undefined
          : (progressMap.has(fund.fund_id) ? progressMap.get(fund.fund_id) : null);
        await this.collectFundNavData(fund, forceFullCollection, knownLastDate);
      } catch (error) {
        if (error.code?.startsWith('MUFAP_') && error.code !== 'MUFAP_FUND_MISMATCH') {
          stoppedEarly = true;
          stopReason = error.message;
          this.stats.errors.push({
            operation: 'fetchNavData',
            error: error.message
          });
          break;
        }

        // Never let a single fund abort the whole run — record and move on.
        console.error(`      ❌ Unexpected error: ${error.message} — continuing with next fund`);
        this.stats.errors.push({
          fund: fund.fund_name?.trim(),
          error: error.message
        });
      }

      // Space out report requests to limit load on MUFAP.
      if (i < funds.length - 1) {
        await this.delay(delayBetweenFunds + Math.floor(Math.random() * 1500));
      }
    }

    // Final statistics
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const durationMins = (duration / 60).toFixed(1);
    const success = !stoppedEarly && this.stats.errors.length === 0;

    console.log('\n' + '='.repeat(60));
    console.log(success ? '✅ Collection Complete!' : stoppedEarly ? 'Collection Stopped' : 'Collection Completed with Errors');
    console.log('='.repeat(60));
    console.log(`⏱️  Duration: ${durationMins} minutes (${duration}s)`);
    console.log(`📊 Statistics:`);
    console.log(`   - Funds Processed: ${this.stats.fundsProcessed}`);
    console.log(`   - Funds Skipped: ${this.stats.skipped}`);
    console.log(`   - Total NAV Records: ${this.stats.totalNavRecords}`);
    console.log(`   - Records ${this.dryRun ? 'Validated' : 'Upserted'}: ${this.stats.newRecords}`);
    console.log(`   - Errors: ${this.stats.errors.length}`);

    if (stoppedEarly) {
      console.log(`   - Stop Reason: ${stopReason}`);
    }
    
    if (this.stats.errors.length > 0) {
      console.log('\n⚠️  Errors encountered:');
      this.stats.errors.slice(0, 10).forEach((err, idx) => {
        console.log(`   ${idx + 1}. ${err.fund || err.operation}: ${err.error}`);
      });
      if (this.stats.errors.length > 10) {
        console.log(`   ... and ${this.stats.errors.length - 10} more`);
      }
    }

    console.log(success ? (this.dryRun ? '\nDry run completed; no database writes.' : '\n🎉 NAV data collection successful!') : '\nNAV data collection incomplete; rerun to resume.');
    console.log('='.repeat(60) + '\n');
    return { success, stoppedEarly, stopReason, stats: this.stats };
  }
}

// ==================== Main Execution ====================
async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('\n❌ Missing environment variables!');
    console.log('\nMake sure .env file has:');
    console.log('SUPABASE_URL=your_supabase_url');
    console.log('SUPABASE_SERVICE_KEY=your_supabase_service_key\n');
    process.exit(1);
  }

  // Check command line arguments
  const args = process.argv.slice(2);
  const command = args[0];
  const numberOption = (flag, fallback, minimum) => {
    if (!args.includes(flag)) return fallback;
    const value = Number(args[args.indexOf(flag) + 1]);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${flag} requires an integer >= ${minimum}.`);
    return value;
  };
  if (args.includes('--browser') && args.includes('--http-only')) {
    throw new Error('Use either --browser or --http-only.');
  }
  const collector = new NAVDataCollector(SUPABASE_URL, SUPABASE_KEY, {
    dryRun: args.includes('--dry-run'),
    mode: args.includes('--browser') ? 'browser' : args.includes('--http-only') ? 'http' : undefined,
    challengeTimeoutMs: numberOption('--challenge-timeout', 120, 1) * 1000
  });

  if (command === 'setup') {
    await collector.setupDatabase();
    return;
  }

  // Collection options
  const options = {
    forceFullCollection: args.includes('--force'),
    fundsLimit: numberOption('--limit', null, 1),
    delayBetweenFunds: numberOption('--delay', 2000, 0)
  };

  // Run collection
  const stop = () => {
    console.log('\nStopping; saved NAV data will be resumed on the next run.');
    collector.mufap.close().finally(() => process.exit(130));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await collector.collectAllNavData(options);
    if (!result.success) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = NAVDataCollector;
