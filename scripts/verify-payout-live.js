// Read live data with the web app's public key and confirm it cannot write.
// Usage: node scripts/verify-payout-live.js <path-to-web-app-.env>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
require('node:dns').setDefaultResultOrder('ipv4first');
const { loadFundReturns } = require('../payout-data');

async function main() {
  if (!process.argv[2]) throw new Error('Pass the web app .env path; credentials are read locally and never printed.');
  const webEnv = dotenv.parse(fs.readFileSync(process.argv[2]));
  assert.equal(new URL(webEnv.NEXT_PUBLIC_SUPABASE_URL).hostname, new URL(process.env.SUPABASE_URL).hostname, 'Web app points to a different database');
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const publicClient = createClient(webEnv.NEXT_PUBLIC_SUPABASE_URL, webEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const report = { checkedAt: new Date().toISOString(), status: 'running', funds: [] };
  const count = async (client, table, status) => {
    let query = client.from(table).select('*', { count: 'exact', head: true });
    if (status) query = query.eq('status', status);
    const { count, error } = await query;
    if (error) throw error;
    return count;
  };
  const output = path.join(__dirname, '..', 'tmp', 'payout-history', 'live-verification.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
  try {
    report.payoutRows = await count(admin, 'fund_payouts');
    assert.ok(report.payoutRows > 0);
    assert.equal(await count(publicClient, 'fund_payouts'), report.payoutRows);
    report.pendingCoverage = await count(admin, 'fund_payout_coverage', 'pending');
    assert.equal(report.pendingCoverage, 0, 'Unfinished collection exists');
    report.verifiedCoverage = await count(publicClient, 'fund_payout_coverage', 'verified');
    report.reviewCoverage = await count(publicClient, 'fund_payout_coverage', 'needs_review');
    const { data: sample, error: sampleError } = await admin.from('fund_payouts').select('*').limit(1);
    if (sampleError) throw sampleError;
    // Attempt only an identical existing real record; never delete or add fake financial data.
    const denied = await publicClient.from('fund_payouts').upsert(sample, { onConflict: 'fund_id,payout_date' });
    assert.equal(denied.error?.code, '42501', 'Public payout writes must be denied');
    const { data: coverageSample, error: coverageSampleError } = await admin.from('fund_payout_coverage').select('*').limit(1);
    if (coverageSampleError) throw coverageSampleError;
    assert.equal(coverageSample.length, 1, 'Coverage sample is required');
    // Even if a policy is unexpectedly permissive, preserve the existing status.
    const deniedCoverage = await publicClient.from('fund_payout_coverage')
      .upsert(coverageSample, { onConflict: 'fund_id,date_from,date_to' });
    assert.equal(deniedCoverage.error?.code, '42501', 'Public coverage writes must be denied');
    report.publicReadAllowed = true; report.publicWritesDenied = true;
    const { data: funds, error } = await admin.from('funds').select('fund_id,fund_name').eq('is_shariah_compliant', true).order('fund_id');
    if (error) throw error;
    for (let offset = 0; offset < funds.length; offset += 3) {
      const results = await Promise.all(funds.slice(offset, offset + 3).map(async fund => {
        const result = await loadFundReturns(publicClient, { fundId: fund.fund_id, from: '2026-01-01', to: '2026-08-31' });
        for (const key of ['navReturnPct', 'cashReturnPct', 'totalReturnPct', 'cagrPct', 'simpleAnnualizedReturnPct']) {
          assert.ok(result[key] === null || Number.isFinite(result[key]));
        }
        if (result.status !== 'ready') assert.equal(result.totalReturnPct, null);
        return { name: fund.fund_name, ...result };
      }));
      report.funds.push(...results); save();
      console.log(`Verified web reads/calculations for ${report.funds.length}/${funds.length} funds`);
    }
    const map = require('../fund-profile-map.json');
    const akd = map.find(r => r.mufap_fund_id === 12813);
    report.disputedPeriod = await loadFundReturns(publicClient, { fundId: akd.fund_id, from: '2024-08-01', to: '2024-08-31' });
    assert.equal(report.disputedPeriod.totalReturnPct, null);
    const daily = map.find(r => r.mufap_fund_id === 12743);
    const longSnapshot = await publicClient.rpc('get_fund_return_inputs', { p_fund_id: daily.fund_id, p_from: '2020-01-01', p_to: '2026-08-31' });
    if (longSnapshot.error) throw longSnapshot.error;
    report.longHistoryPayoutCount = longSnapshot.data.payouts.length;
    assert.ok(report.longHistoryPayoutCount > 1000, 'RPC must return complete daily distribution history beyond the REST row cap');
    report.status = 'complete';
    report.summary = report.funds.reduce((counts, fund) => ({ ...counts, [fund.status]: (counts[fund.status] || 0) + 1 }), {});
    console.log(JSON.stringify({ status: report.status, rows: report.payoutRows, publicWritesDenied: true,
      checkedFunds: report.funds.length, summary: report.summary, longHistoryPayoutCount: report.longHistoryPayoutCount }));
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { save(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
