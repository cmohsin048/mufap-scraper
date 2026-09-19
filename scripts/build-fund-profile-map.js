// Verify profile IDs against a current NAV report using the catalog's exact
// fund/AMC identity and category. This is not fuzzy name matching.
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const Collector = require('../industry-stats-collector');
const Storage = require('../payout-storage');
const { normalizeName, normalizeFundNameForAMC } = require('../fund-identity');

async function main() {
  const c = new Collector();
  try {
    const storage = new Storage(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));
    await storage.initialize();
    const url = 'https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3';
    const sourceFile = path.join(__dirname, '..', 'tmp', 'profile-map-nav-source.html');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    const cached = process.argv.includes('--cached');
    const html = cached ? fs.readFileSync(sourceFile, 'utf8') : await c.mufap.get(url);
    if (!cached) fs.writeFileSync(sourceFile, html);
    const $ = cheerio.load(html);
    const headers = $('#table_id th').map((_i, e) => normalizeName($(e).text())).get();
    if (!headers.includes('nav') || !headers.includes('fund') || !headers.includes('amc')) throw new Error('Unexpected NAV report');
    const mapping = new Map();
    $('#table_id tr.fund-block').each((_i, row) => {
      const cells = $(row).find('td');
      const name = $(cells[2]).text().trim(), amc = $(cells[1]).text().trim(), category = $(cells[3]).text().trim();
      const profile = $(cells[2]).find('a').attr('href')?.match(/[?&]FundID=(\d+)(?:&|$)/i);
      if (!profile) return;
      let candidates = storage.catalog.filter(f => normalizeFundNameForAMC(f.fund_name, amc) === normalizeFundNameForAMC(name, amc) &&
        normalizeName(f.amcs.amc_name) === normalizeName(amc));
      if (candidates.length > 1) candidates = candidates.filter(f => normalizeName(f.category_name) === normalizeName(category));
      if (candidates.length !== 1) return;
      const fund = candidates[0];
      const numericId = Number(profile[1]);
      if (mapping.has(numericId) && mapping.get(numericId).fund_id !== fund.fund_id) throw new Error(`Conflicting profile ID ${numericId}`);
      mapping.set(numericId, { mufap_fund_id: numericId, fund_id: fund.fund_id, amc_id: fund.amc_id,
        fund_name: fund.fund_name, source_fund_name: name, source_amc_name: amc, category,
        verified_at: fs.statSync(sourceFile).mtime.toISOString(), source: url });
    });
    if (!mapping.size) throw new Error('No verified profile mappings found');
    fs.writeFileSync(path.join(__dirname, '..', 'fund-profile-map.json'), JSON.stringify([...mapping.values()], null, 2));
    console.log(`Verified ${mapping.size} numeric MUFAP profile IDs against the database catalog.`);
  } finally { await c.mufap.close(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
