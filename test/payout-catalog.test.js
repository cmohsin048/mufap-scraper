const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planReconciliation } = require('../payout-catalog');
const { MufapClient } = require('../mufap-client');
const uuid = '00000000-0000-4000-8000-000000000001';
const amcId = '00000000-0000-4000-8000-000000000002';
const unmatched = [{ fund_name: 'Islamic Plan II', amc_name: 'Example AMC', mufap_fund_id: 123 }];
const groups = [{ amc: { AMCId: amcId, AMC_Desc: 'Example AMC' }, funds: [
  { FundID: uuid, fund: 123, Fund_Desc: 'Islamic Plan II ', Cat_Desc: 'Shariah Compliant Income', CatId: 9, fund_type: 1, PricingMechanism: 'forward' }
] }];
const plan = (g = groups, catalog = [], map = []) => planReconciliation(unmatched, g, catalog, map);
test('catalog reconciliation preserves official UUIDs and is idempotent', () => {
  const first = plan(); assert.equal(first.additions[0].fund_id, uuid);
  assert.equal(first.profileMap[0].mufap_fund_id, 123);
  const second = plan(groups, first.additions, first.profileMap);
  assert.equal(second.additions.length, 0); assert.equal(second.profileMap.length, 1);
});
test('rejects conventional, malformed, wrong-plan and ambiguous identities', () => {
  for (const change of [{ Cat_Desc: 'Income' }, { Cat_Desc: 'Non-Shariah Compliant Income' }, { FundID: 'not-uuid' }, { Fund_Desc: 'Islamic Plan I' }, { fund: 124 }]) {
    const g = structuredClone(groups); Object.assign(g[0].funds[0], change); assert.throws(() => plan(g));
  }
  const duplicate = structuredClone(groups); duplicate[0].funds.push(duplicate[0].funds[0]);
  assert.throws(() => plan(duplicate), /uniquely/);
});
test('rejects existing AMC conflicts, duplicate names and profile reassignment', () => {
  assert.throws(() => plan(groups, [{ fund_id: uuid, amc_id: uuid, is_shariah_compliant: true }]), /disagrees/);
  assert.throws(() => plan(groups, [{ fund_id: amcId, amc_id: amcId, fund_name: 'Islamic Plan II' }]), /duplicate/);
  assert.throws(() => plan(groups, [], [{ mufap_fund_id: 123, fund_id: amcId, amc_id: amcId }]), /Conflicting/);
});
test('pension subfunds with the same name retain separate category identities', () => {
  const other = { fund_id: amcId, amc_id: amcId, fund_name: 'Islamic Plan II', category_name: 'VPS-Shariah Compliant Equity' };
  assert.equal(plan(groups, [other]).additions.length, 1);
});
test('catalog POST validates status and JSON instead of treating errors as an empty catalog', async () => {
  const url = 'https://www.mufap.com.pk/AMC/GetAMCList';
  for (const body of ['<html>error</html>', JSON.stringify({ statusCode: '01', data: [] }), JSON.stringify({ statusCode: '00', data: null })]) {
    const c = new MufapClient({ fetch: async () => new Response(body) });
    await assert.rejects(c.postJson(url), { code: 'MUFAP_INVALID_RESPONSE' });
  }
  const c = new MufapClient({ fetch: async (_url, options) => {
    assert.equal(options.method, 'POST'); return new Response(JSON.stringify({ statusCode: '00', data: [1] }));
  } });
  assert.deepEqual(await c.postJson(url), [1]);
  await assert.rejects(c.postJson('https://example.com/'), /origin/);
});
test('catalog POST supports browser fallback but fails closed on a remaining challenge', async () => {
  const url = 'https://www.mufap.com.pk/AMC/GetAMCList';
  const c = new MufapClient({ fetch: async () => new Response('<title>Just a moment</title>') });
  c.getBrowser = async () => { c.page = { url: () => url, evaluate: async () => ({ status: 200, headers: {}, html: JSON.stringify({ statusCode: '00', data: [] }) }) }; return { status: 200 }; };
  assert.deepEqual(await c.postJson(url), []); assert.equal(c.useBrowser, true);
  c.page.evaluate = async () => ({ status: 403, headers: {}, html: '<title>Just a moment</title>' });
  await assert.rejects(c.postJson(url), { code: 'MUFAP_BLOCKED' });
});
test('fund catalog collector stores only explicitly Shariah categories', async () => {
  const Collector = require('../collector');
  const c = new Collector('https://example.supabase.co', 'test-key');
  const writes = [];
  c.supabase = { from: table => ({ upsert: async rows => { writes.push({ table, rows }); return { error: null }; } }) };
  const islamic = groups[0].funds[0];
  const count = await c.storeFunds(amcId, [islamic,
    { ...islamic, FundID: amcId, Cat_Desc: 'Income' },
    { ...islamic, Cat_Desc: 'Non-Shariah Compliant Equity' }]);
  assert.equal(count, 1);
  assert.deepEqual(writes.find(w => w.table === 'funds').rows.map(r => r.fund_id), [uuid]);
  assert.equal(writes.find(w => w.table === 'fund_categories').rows.length, 1);
});
