require('dotenv').config({ quiet: true });
require('node:dns').setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { MufapClient } = require('../mufap-client');
const { planReconciliation, isShariahCategory } = require('../payout-catalog');
const root = path.resolve(__dirname, '..');

async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--apply', '--cached', '--all-shariah'].includes(arg))) throw new Error('Usage: node scripts/reconcile-payout-catalog.js [--apply] [--cached] [--all-shariah]');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  let unmatched = args.includes('--all-shariah') ? [] : JSON.parse(fs.readFileSync(path.join(root, 'tmp/payout-unmatched.json')));
  const catalog = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from('funds').select('fund_id,amc_id,fund_name,category_name,is_shariah_compliant').order('fund_id').range(offset, offset + 999);
    if (error) throw error; catalog.push(...data); if (data.length < 1000) break;
  }
  const sourcePath = path.join(root, 'tmp/catalog-reconciliation-source.json');
  let sourceGroups;
  if (args.includes('--cached')) sourceGroups = JSON.parse(fs.readFileSync(sourcePath)).sourceFunds;
  else {
    const client = new MufapClient({ profileDir: path.join(root, '.mufap-payout-browser') });
    try {
      const amcs = await client.postJson('https://www.mufap.com.pk/AMC/GetAMCList');
      sourceGroups = [];
      for (const amc of amcs.filter(a => args.includes('--all-shariah') || unmatched.some(u => u.amc_name.trim().toLowerCase() === a.AMC_Desc.trim().toLowerCase()))) {
        sourceGroups.push({ amc, funds: await client.postJson('https://www.mufap.com.pk/TopHolding/GetFundNameByAMC', { AMCId: amc.AMCId }) });
      }
      fs.writeFileSync(sourcePath, JSON.stringify({ fetchedAt: new Date().toISOString(), sourceFunds: sourceGroups }, null, 2));
    } finally { await client.close(); }
  }
  if (args.includes('--all-shariah')) unmatched = sourceGroups.flatMap(group => group.funds
    .filter(f => isShariahCategory(f.Cat_Desc))
    .map(f => ({ fund_name: f.Fund_Desc.trim(), amc_name: group.amc.AMC_Desc.trim(), mufap_fund_id: Number(f.fund) })));
  const mapPath = path.join(root, 'fund-profile-map.json');
  const plan = planReconciliation(unmatched, sourceGroups, catalog, JSON.parse(fs.readFileSync(mapPath)));
  fs.writeFileSync(path.join(root, 'tmp/payout-catalog-plan.json'), JSON.stringify(plan, null, 2));
  console.log(`Verified ${unmatched.length} source identities; ${plan.additions.length} catalog additions; ${plan.profileMap.length} profile mappings.`);
  if (!args.includes('--apply')) { console.log('Dry run. Use --apply to store the verified additions.'); return; }
  const { data: amcs, error: amcError } = await db.from('amcs').select('amc_id,amc_name');
  if (amcError) throw amcError;
  for (const row of unmatched) {
    const mapping = plan.profileMap.find(m => m.mufap_fund_id === row.mufap_fund_id);
    if (!amcs.some(a => a.amc_id === mapping.amc_id && a.amc_name.trim().toLowerCase() === row.amc_name.trim().toLowerCase())) {
      throw new Error(`AMC must be reconciled first: ${row.amc_name}`);
    }
  }
  if (plan.additions.length) {
    const { error } = await db.from('funds').upsert(plan.additions, { onConflict: 'fund_id', ignoreDuplicates: true });
    if (error) throw error;
    const { data, error: readError } = await db.from('funds').select('fund_id,amc_id,fund_name,is_shariah_compliant').in('fund_id', plan.additions.map(f => f.fund_id));
    if (readError) throw readError;
    for (const row of plan.additions) if (!data.some(f => f.fund_id === row.fund_id && f.amc_id === row.amc_id && f.fund_name === row.fund_name && f.is_shariah_compliant)) {
      throw new Error(`Catalog readback failed: ${row.fund_name}`);
    }
  }
  fs.writeFileSync(mapPath, JSON.stringify(plan.profileMap, null, 2) + '\n');
  console.log('Catalog additions verified by readback; profile map saved. Rerun payouts to backfill history.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
