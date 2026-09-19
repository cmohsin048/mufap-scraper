const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateFundReturns, missingCoverage } = require('../payout-returns');
const { loadFundReturns } = require('../payout-data');
const fid = 'fund-1';
const nav = (nav_date, value) => ({ fund_id: fid, nav_date, nav: value });
const payout = (payout_date, amount, exNav = 100) => ({ fund_id: fid, payout_date, payout_per_unit: amount, ex_nav: exNav });
const covered = (date_from = '2020-01-01', date_to = '2026-12-31', status = 'verified', checked_at = '2026-09-18T10:00:00Z') =>
  ({ fund_id: fid, date_from, date_to, status, checked_at });
const base = { fundId: fid, from: '2026-01-01', to: '2026-02-01',
  navRecords: [nav('2026-01-01', 100), nav('2026-02-01', 100)], payouts: [], coverage: [covered()] };
const calc = changes => calculateFundReturns({ ...base, ...changes });
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('price-only, cash-distribution, and reinvested returns remain distinct', () => {
  const r = calc({ payouts: [payout('2026-01-10', 10), payout('2026-01-20', 10)] });
  assert.equal(r.status, 'ready');
  close(r.navReturnPct, 0); close(r.cashReturnPct, 20); close(r.totalReturnPct, 21);
  close(r.reinvestmentFactor, 1.21); assert.equal(r.distributionCount, 2);
});
test('an ex-dividend NAV drop is not misreported as a loss', () => {
  const r = calc({ navRecords: [nav('2026-01-01', 100), nav('2026-02-01', 90)], payouts: [payout('2026-02-01', 10, 90)] });
  close(r.navReturnPct, -10); close(r.totalReturnPct, 0); close(r.cashReturnPct, 0);
});
test('start-day distribution excluded and end-day distribution included exactly once', () => {
  const r = calc({ payouts: [payout('2026-01-01', 99), payout('2026-02-01', 10), payout('2026-02-02', 99)] });
  close(r.totalReturnPct, 10); assert.equal(r.distributionCount, 1);
});
test('zero payouts with zero ex-NAV do not invent units or divide by zero', () => {
  const r = calc({ payouts: [payout('2026-01-15', 0, 0)] });
  close(r.totalReturnPct, 0); assert.equal(r.distributionCount, 0);
});
test('missing or zero ex-NAV suppresses reinvestment but retains verified cash return', () => {
  for (const exNav of [0, null, undefined]) {
    const r = calc({ payouts: [{ ...payout('2026-01-15', 10), ex_nav: exNav }] });
    assert.equal(r.status, 'partial'); assert.equal(r.totalReturnPct, null);
    close(r.cashReturnPct, 10); assert.deepEqual(r.reasons, ['invalid_reinvestment_nav']);
  }
});
test('empty payout rows alone are not evidence of complete history', () => {
  const r = calc({ coverage: [] });
  assert.equal(r.status, 'unavailable'); assert.equal(r.totalReturnPct, null);
  assert.equal(r.cashReturnPct, null); assert.equal(r.navReturnPct, 0);
  assert.deepEqual(r.missingCoverage, [{ from: '2026-01-02', to: '2026-02-01' }]);
});
test('missing intervals and newer failed/pending collections invalidate older coverage', () => {
  const intervals = [covered(), covered('2026-01-10', '2026-01-12', 'pending', '2026-09-18T11:00:00Z')];
  assert.deepEqual(missingCoverage(fid, '2026-01-02', '2026-02-01', intervals), [{ from: '2026-01-10', to: '2026-01-12' }]);
  intervals.push(covered('2026-01-10', '2026-01-12', 'verified', '2026-09-18T12:00:00Z'));
  assert.deepEqual(missingCoverage(fid, '2026-01-02', '2026-02-01', intervals), []);
  assert.equal(calc({ coverage: [covered(undefined, undefined, 'needs_review')] }).totalReturnPct, null);
});
test('adjacent coverage joins, real gaps remain, and another fund cannot supply coverage', () => {
  const intervals = [covered('2026-01-02', '2026-01-10'), covered('2026-01-12', '2026-02-01'),
    { ...covered(), fund_id: 'other' }];
  assert.deepEqual(missingCoverage(fid, '2026-01-02', '2026-02-01', intervals), [{ from: '2026-01-11', to: '2026-01-11' }]);
  intervals.push(covered('2026-01-11', '2026-01-11'));
  assert.deepEqual(missingCoverage(fid, '2026-01-02', '2026-02-01', intervals), []);
});
test('equal-time coverage conflicts are conservative', () => {
  assert.notEqual(calc({ coverage: [covered(), covered(undefined, undefined, 'pending')] }).status, 'ready');
});
test('uses prior available closing NAV, exposes actual dates, and rejects stale prices', () => {
  const navRecords = [nav('2025-12-31', 100), nav('2026-01-30', 110)];
  const r = calc({ navRecords });
  assert.equal(r.actualFrom, '2025-12-31'); assert.equal(r.actualTo, '2026-01-30'); close(r.totalReturnPct, 10);
  assert.equal(calc({ navRecords, maxNavAgeDays: 0 }).reasons[0], 'stale_nav');
  assert.equal(calc({ navRecords: [nav('2026-01-02', 100), nav('2026-02-01', 100)] }).reasons[0], 'insufficient_nav_history');
});
test('unsorted identical duplicates do not double count distributions', () => {
  const r = calc({ navRecords: [...base.navRecords].reverse().concat(base.navRecords),
    payouts: [payout('2026-01-20', 10), payout('2026-01-10', 10), payout('2026-01-20', 10)] });
  close(r.totalReturnPct, 21); assert.equal(r.distributionCount, 2);
});
test('rejects conflicting duplicates, mixed funds, null prices and malformed numbers', () => {
  for (const changes of [
    { navRecords: [...base.navRecords, nav('2026-01-01', 99)] },
    { payouts: [payout('2026-01-10', 10), payout('2026-01-10', 11)] },
    { payouts: [{ ...payout('2026-01-10', 10), fund_id: 'wrong' }] },
    { navRecords: [{ ...base.navRecords[0], fund_id: 'wrong' }] },
    ...[0, -1, null, '', NaN, Infinity, '0x10'].map(value => ({ navRecords: [nav('2026-01-01', value), base.navRecords[1]] })),
    { payouts: [payout('2026-01-10', -1)] }, { payouts: [payout('2026-01-10', 1, -1)] },
    { from: '2026-02-30' }, { from: base.to }, { from: '2027-01-01' }
  ]) assert.throws(() => calc(changes));
});
test('decimal strings from Postgres work and leap-year duration uses actual elapsed days', () => {
  const r = calc({ from: '2024-01-01', to: '2025-01-01', navRecords: [nav('2024-01-01', '100'), nav('2025-01-01', '110')] });
  close(r.totalReturnPct, 10); close(r.simpleAnnualizedReturnPct, 10 * 365 / 366);
  assert.notEqual(r.simpleAnnualizedReturnPct, r.cagrPct);
});
test('large values cannot leak Infinity into web app metrics', () => {
  const r = calc({ payouts: [payout('2026-01-10', 1e308, 1e-308)] });
  assert.equal(r.totalReturnPct, null); assert.ok(r.reasons.includes('numeric_overflow'));
});
test('matches MUFAP published worked examples within their printed rounding', () => {
  // MUFAP Guidelines for Calculation of Return, examples 2 and 3 (2010).
  const r = calc({ from: '2010-06-30', to: '2010-12-31', coverage: [covered('2010-07-01', '2010-12-31')],
    navRecords: [nav('2010-06-30', 513.60), nav('2010-12-31', 515.50)],
    payouts: [payout('2010-07-09', 13.5, 500.10), payout('2010-10-12', 11.5, 503.47)] });
  close(r.totalReturnPct, 5.4286, 0.01); close(r.simpleAnnualizedReturnPct, 10.7686, 0.02);
  const equity = calc({ from: '2010-06-30', to: '2010-12-31', coverage: [covered('2010-07-01', '2010-12-31')],
    navRecords: [nav('2010-06-30', 73.6389), nav('2010-12-31', 65.9654)], payouts: [payout('2010-07-09', 15, 58.6389)] });
  close(equity.totalReturnPct, 12.4941, 0.001);
});

test('web data loader paginates beyond 1,000 payouts and never hides database errors', async () => {
  const from = '2020-01-01', to = '2023-12-31';
  const events = Array.from({ length: 1100 }, (_, i) => payout(new Date(Date.parse(from) + (i + 1) * 86400000).toISOString().slice(0, 10), 0.01));
  const datasets = { daily_nav: [nav(from, 100), nav(to, 100)], fund_payouts: events, fund_payout_coverage: [covered()] };
  const ranges = [];
  const db = { from(table) {
    let rows = [...datasets[table]];
    return {
      select() { return this; }, eq(field, value) { rows = rows.filter(r => r[field] === value); return this; },
      lte(field, value) { rows = rows.filter(r => r[field] <= value); return this; },
      gte(field, value) { rows = rows.filter(r => r[field] >= value); return this; },
      gt(field, value) { rows = rows.filter(r => r[field] > value); return this; },
      order(field, options = {}) { rows.sort((a, b) => String(a[field]).localeCompare(String(b[field])) * (options.ascending === false ? -1 : 1)); return this; },
      limit: async n => ({ data: rows.slice(0, n) }),
      range: async (start, end) => { ranges.push([table, start]); return { data: rows.slice(start, end + 1) }; }
    };
  } };
  const result = await loadFundReturns(db, { fundId: fid, from, to });
  assert.equal(result.distributionCount, 1100);
  close(result.totalReturnPct, (Math.pow(1.0001, 1100) - 1) * 100, 1e-9);
  assert.ok(ranges.some(([table, offset]) => table === 'fund_payouts' && offset === 1000));
  const broken = { from() { return { select() { return this; }, eq() { return this; }, lte() { return this; },
    order() { return this; }, limit: async () => ({ error: { message: 'unavailable' } }) }; } };
  await assert.rejects(loadFundReturns(broken, { fundId: fid, from, to }), /Could not load NAV/);
});

test('Supabase loader uses one consistent RPC snapshot and validates its result', async () => {
  const client = { rpc: async (name, params) => {
    assert.equal(name, 'get_fund_return_inputs');
    assert.deepEqual(params, { p_fund_id: fid, p_from: base.from, p_to: base.to });
    return { data: { navRecords: base.navRecords, payouts: [payout('2026-01-15', 10)], coverage: base.coverage,
      fundId: 'untrusted-extra-field', from: '1900-01-01' }, error: null };
  } };
  const result = await loadFundReturns(client, { fundId: fid, from: base.from, to: base.to });
  assert.equal(result.fundId, fid); assert.equal(result.requestedFrom, base.from); close(result.totalReturnPct, 10);
  for (const response of [{ data: null, error: { message: 'denied' } }, { data: {}, error: null }]) {
    await assert.rejects(loadFundReturns({ rpc: async () => response }, { fundId: fid, from: base.from, to: base.to }));
  }
});
