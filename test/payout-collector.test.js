const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Collector = require('../industry-stats-collector');
const Storage = require('../payout-storage');
const { normalizeFundName } = require('../fund-identity');
const html = fs.readFileSync(path.join(__dirname, 'fixtures/mufap-payout-sample.html'), 'utf8');
const headers = ['Sector', 'AMC', 'Fund', 'Category', 'Inception Date', 'Payout (Per Unit)', 'Ex-NAV', 'Payout Date'];
const table = rows => `<table id="table_id"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
const row = (changes = {}) => {
  const values = ['Open-End Funds', 'Test AMC', '<a href="/FundProfile/FundDetail?FundID=123">Test Fund</a>',
    'Shariah Compliant Income', 'Jan 01, 2020', '0.1234', '100.0000', 'Aug 01, 2026'];
  for (const [index, value] of Object.entries(changes)) values[index] = value;
  return `<tr class="fund-block">${values.map(v => `<td>${v}</td>`).join('')}</tr>`;
};
const range = { from: '2026-08-01', to: '2026-08-31' };
function collector(page = html) {
  return new Collector({ mufapClient: { get: async () => page, close: async () => {} } });
}
const fund = { fund_id: '00000000-0000-0000-0000-000000000001',
  amc_id: '00000000-0000-0000-0000-000000000002', fund_name: 'Test Fund', amcs: { amc_name: 'Test AMC' } };
function database({ funds = [fund], schemaError = null, failBatch = 0, coverageError = null, readbackError = null, seedRows = [] } = {}) {
  const writes = [];
  const coverageWrites = [];
  const persisted = new Map(seedRows.map(r => [`${r.fund_id}/${r.payout_date}`, r]));
  const db = { from(name) {
    if (name === 'funds') return { select() { return this; }, eq() { return this; }, order() { return this; },
      range: async (start, end) => ({ data: funds.slice(start, end + 1), error: null }) };
    if (name === 'fund_payout_coverage') return { select() { return this; },
      limit: async () => ({ error: schemaError }),
      upsert: async rows => { coverageWrites.push(rows); return { error: coverageError }; } };
    assert.equal(name, 'fund_payouts');
    let selected = [...persisted.values()];
    return { select() { return this; }, limit: async () => ({ error: schemaError }),
      gte(field, value) { selected = selected.filter(r => r[field] >= value); return this; },
      lte(field, value) { selected = selected.filter(r => r[field] <= value); return this; },
      order() { return this; },
      range: async (start, end) => ({ data: selected.slice(start, end + 1), error: readbackError }),
      upsert: async (rows, options) => { writes.push({ rows, options });
        if (writes.length === failBatch) return { error: { message: 'database offline' } };
        rows.forEach(r => persisted.set(`${r.fund_id}/${r.payout_date}`, r));
        return { error: null }; } };
  } };
  return { db, writes, coverageWrites, persisted };
}

test('parses the actual MUFAP August 2026 HTML layout and numeric profile IDs', () => {
  const records = collector().parsePage(html, range);
  assert.equal(records.length, 3);
  assert.equal(records[0].mufap_fund_id, 13124);
  assert.equal(records[0].payout_per_unit, 0.0292);
  assert.equal(records[2].ex_nav, 99.51);
  assert.equal(records[0].payout_date, '2026-08-01');
  assert.equal(records[0].report_date, null);
});

test('rejects challenge, maintenance, NAV table, and malformed payout rows', () => {
  const c = collector();
  assert.throws(() => c.parsePage('<title>Just a moment...</title>'), { code: 'MUFAP_BLOCKED' });
  for (const page of ['<h1>Maintenance</h1>', table(row()).replace('Payout (Per Unit)', 'NAV'),
    table('<tr><td>truncated</td></tr>'), table(row({ 5: 'N/A' })), table(row({ 5: '-1' })),
    table(row({ 6: '' })), table(row({ 7: 'Feb 30, 2026' })), table(row({ 7: '' })),
    table(row({ 1: '' })), table(row({ 5: '0x10' })), table(row({ 5: '1,23' }))]) {
    assert.throws(() => c.parsePage(page), { code: 'MUFAP_INVALID_RESPONSE' });
  }
  assert.deepEqual(c.parsePage(table('')), []);
  assert.deepEqual(c.parsePage(table('<tr><td colspan="8">No data available in table</td></tr>')), []);
  assert.deepEqual(c.parsePage(table(row({ 5: '0', 6: '0', 7: '' }))), []);
});

test('rejects out-of-range dates and retains dated zero payouts without inventing distributions', () => {
  const c = collector();
  assert.throws(() => c.parsePage(table(row({ 7: 'Sep 01, 2026' })), range), /outside/);
  assert.equal(c.parsePage(table(row({ 5: '0' })), range)[0].payout_per_unit, 0);
  assert.equal(c.parseNumber('1,234.5678'), 1234.5678);
  // Actual MUFAP JS Islamic Money Market payout on 2024-07-16.
  assert.equal(c.parsePage(table(row({ 5: '.0474' })), range)[0].payout_per_unit, 0.0474);
});

test('date chunks validate input and cover end-of-month and leap dates without gaps', () => {
  const c = collector();
  for (const invalid of ['2026-02-30', '2026-13-01', 'bad', '2026-00-10']) {
    assert.throws(() => c.parseISODate(invalid), /Invalid/);
  }
  for (const count of [0, -1, 0.5, NaN, Infinity, 121]) {
    assert.throws(() => c.buildDateChunks(range.from, range.to, count), /chunk-months/);
  }
  assert.throws(() => c.buildDateChunks(range.to, range.from, 1), /after/);
  const chunks = c.buildDateChunks('2024-01-31', '2024-04-02', 1);
  assert.deepEqual(chunks[0], { from: '2024-01-31', to: '2024-02-28' });
  assert.equal(chunks.at(-1).to, '2024-04-02');
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(c.formatISODate(c.addDays(c.parseISODate(chunks[i - 1].to), 1)), chunks[i].from);
  }
});

test('duplicate payouts collapse but conflicting same-day amounts fail', () => {
  const c = collector();
  const record = c.parsePage(table(row()), range)[0];
  const seen = new Map();
  assert.equal(c.mergeUnique([], [record, { ...record }], seen).length, 1);
  assert.throws(() => c.mergeUnique([], [{ ...record, payout_per_unit: 2 }], seen), /Conflicting/);
});

test('a failed chunk stops subsequent requests and always closes the transport', async () => {
  const c = collector();
  let requests = 0;
  let closed = false;
  let callbacks = 0;
  c.fetchPage = async () => { requests++; throw new Error('unavailable'); };
  c.mufap.close = async () => { closed = true; };
  await assert.rejects(c.collect({ from: '2026-01-01', to: '2026-03-31', chunkMonths: 1,
    summaryOnly: true, recordsOnly: true, onChunk: async () => { callbacks++; } }), /unavailable/);
  assert.equal(requests, 1);
  assert.equal(callbacks, 0);
  assert.equal(closed, true);
});

test('invalid rows prevent the entire chunk from reaching storage', async () => {
  const c = collector(table(row() + row({ 5: 'bad' })));
  await assert.rejects(c.collect({ ...range, chunkMonths: 1, summaryOnly: true, recordsOnly: true,
    onChunk: async () => assert.fail('must not store partial table') }), /invalid/);
});

test('database dry-run validates schema and mapping without writes', async () => {
  const { db, writes } = database();
  const storage = new Storage(db);
  assert.equal(await storage.initialize(), true);
  await storage.storeChunk(collector().parsePage(table(row()), range));
  assert.equal(storage.stats.matched, 1);
  assert.deepEqual(writes, []);
});

test('missing schema can be diagnosed in dry-run but blocks real storage', async () => {
  const { db } = database({ schemaError: { code: 'PGRST205', message: 'missing table' } });
  assert.equal(await new Storage(db).initialize(), false);
  await assert.rejects(new Storage(db, { dryRun: false }).initialize(), /setup-payout-database.sql/);
});

test('name matching ignores explicit former-name notes but preserves AMC and plan identity', async () => {
  const { db, writes } = database({ funds: [{ ...fund, fund_name: 'Test Fund (Formerly: Old Fund)' }] });
  const storage = new Storage(db, { dryRun: false });
  await storage.initialize();
  const records = collector().parsePage(table(row() + row({ 1: 'Other AMC' }) + row({ 2: 'Test Fund (Plan II)' })), range);
  await storage.storeChunk(records);
  assert.equal(writes[0].rows.length, 1);
  assert.equal(writes[0].rows[0].fund_id, fund.fund_id);
  assert.equal(writes[0].rows[0].mufap_fund_id, 123);
  assert.equal(storage.stats.unmatchedShariah, 2);
  assert.notEqual(normalizeFundName('Test Fund (Plan II)'), normalizeFundName('Test Fund (Plan III)'));
});

test('ambiguous UUID matches fail before writes instead of choosing the first pension subfund', async () => {
  const { db, writes } = database({ funds: [fund, { ...fund, fund_id: 'other-id' }] });
  const storage = new Storage(db, { dryRun: false });
  await storage.initialize();
  await assert.rejects(storage.storeChunk(collector().parsePage(table(row()), range)), /Ambiguous/);
  assert.deepEqual(writes, []);
});

test('database collision detection runs before writes, including differing source profile IDs', async () => {
  const { db, writes } = database();
  const storage = new Storage(db, { dryRun: false });
  await storage.initialize();
  const record = collector().parsePage(table(row()), range)[0];
  for (const change of [{ payout_per_unit: 20 }, { ex_nav: 20 }, { mufap_fund_id: 987 }]) {
    await assert.rejects(storage.storeChunk([record, { ...record, ...change }]), /Conflicting/);
  }
  assert.deepEqual(writes, []);
});

test('pension subfunds with identical names are disambiguated by the exact report category', async () => {
  const { db, writes } = database({ funds: [
    { ...fund, category_name: 'VPS-Shariah Compliant Debt' },
    { ...fund, fund_id: 'equity-id', category_name: 'VPS-Shariah Compliant Equity' }
  ] });
  const storage = new Storage(db, { dryRun: false });
  await storage.initialize();
  await storage.storeChunk(collector().parsePage(table(row({ 3: 'VPS-Shariah Compliant Equity' })), range));
  assert.equal(writes[0].rows[0].fund_id, 'equity-id');
  await assert.rejects(storage.storeChunk(collector().parsePage(table(row({ 3: 'Unknown Category' })), range)), /Ambiguous/);
  assert.equal(writes.length, 1);
});

test('a report that ignores the requested UUID filter is rejected before storage', async () => {
  const second = { ...fund, fund_id: 'second-id', fund_name: 'Second Fund' };
  const { db, writes } = database({ funds: [fund, second] });
  const storage = new Storage(db, { dryRun: false, fundId: fund.fund_id });
  await storage.initialize();
  await assert.rejects(storage.storeChunk(collector().parsePage(table(row() + row({ 2: 'Second Fund' })), range)), /outside the requested/);
  await assert.rejects(storage.storeChunk(collector().parsePage(table(row({ 2: 'Unknown Fund' })), range)), /Unrecognized/);
  assert.deepEqual(writes, []);
  await assert.rejects(new Storage(db, { fundId: 'missing-id' }).initialize(), /not in the existing/);
});

test('failed batch prevents subsequent writes and idempotent upsert uses fund/date', async () => {
  const { db, writes } = database({ failBatch: 2 });
  const storage = new Storage(db, { dryRun: false, batchSize: 1 });
  await storage.initialize();
  const records = collector().parsePage(table(row({ 7: 'Aug 03, 2026' }) + row() + row({ 7: 'Aug 02, 2026' })), range);
  await assert.rejects(storage.storeChunk(records), /storage failed/);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].rows[0].payout_date, '2026-08-01');
  assert.deepEqual(writes[0].options, { onConflict: 'fund_id,payout_date' });
  assert.equal(storage.stats.upserted, 1);
});

test('rerunning a chunk replaces the same primary business keys', async () => {
  const { db } = database();
  const persisted = new Map();
  const original = db.from.bind(db);
  db.from = name => {
    const query = original(name);
    if (name === 'fund_payouts') query.upsert = async rows => {
      rows.forEach(r => persisted.set(`${r.fund_id}/${r.payout_date}`, r));
      return { error: null };
    };
    return query;
  };
  const storage = new Storage(db, { dryRun: false });
  await storage.initialize();
  const records = collector().parsePage(table(row()), range);
  await storage.storeChunk(records);
  await storage.storeChunk(records);
  assert.equal(persisted.size, 1);
});

test('CLI rejects invalid options before any network or database access', () => {
  for (const args of [['--chunk-months', '0'], ['--from', '2026-02-30'], ['--delay', '-1'],
    ['--timeout', 'oops'], ['--from'], ['--dry-run', '--limit', '2'], ['--store', '--json'], ['--typo']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../industry-stats-collector.js'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /failed:/);
  }
});

test('both entry points default to storage; dry-run and print-only make no writes', async () => {
  assert.equal(require('../industrystatecollector'), Collector);
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  try {
    for (const args of [[], ['--dry-run'], ['--store', '--dry-run'], ['--print-only']]) {
      const { db, writes } = database();
      let fetched = false;
      let closed = false;
      class TestCollector extends Collector {
        constructor() { super({ mufapClient: { close: async () => { closed = true; } } }); }
        async collect(options) {
          fetched = true;
          assert.equal(options.from, '1995-01-01');
          assert.equal(options.to, this.getCurrentDate());
          if (options.onChunk) await options.onChunk(this.parsePage(table(row()), range));
        }
      }
      class TestStorage extends Storage { writeUnmatchedReport() { return 'test-only'; } }
      await Collector.main(args, { Collector: TestCollector, Storage: TestStorage, createClient: () => db });
      assert.equal(fetched, true);
      assert.equal(closed, true);
      assert.equal(writes.length, args.length === 0 ? 1 : 0, JSON.stringify(args));
      if (!args.length) assert.equal(writes[0].rows[0].fund_id, fund.fund_id);
    }
    const { db, writes } = database({ schemaError: { code: 'PGRST205', message: 'missing table' } });
    class NoFetchCollector extends Collector {
      constructor() { super({ mufapClient: { close: async () => {} } }); }
      async collect() { assert.fail('missing schema must stop before fetching'); }
    }
    class TestStorage extends Storage { writeUnmatchedReport() { return 'test-only'; } }
    await assert.rejects(Collector.main([], { Collector: NoFetchCollector, Storage: TestStorage,
      createClient: () => db }), /setup-payout-database.sql/);
    assert.deepEqual(writes, []);
  } finally {
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = oldKey;
  }
});

test('coverage is verified only after successful writes and exact database readback', async () => {
  const { db, coverageWrites } = database();
  const storage = new Storage(db, { dryRun: false });
  await storage.initialize();
  await storage.storeChunk(collector().parsePage(table(row()), range), range);
  assert.deepEqual(coverageWrites.map(batch => batch[0].status), ['pending', 'verified']);
  assert.equal(coverageWrites.at(-1)[0].row_count, 1);
});

test('failed writes or readback leave coverage pending, never completed', async () => {
  for (const failure of [{ failBatch: 1 }, { readbackError: { message: 'read unavailable' } }]) {
    const { db, coverageWrites } = database(failure);
    const storage = new Storage(db, { dryRun: false });
    await storage.initialize();
    await assert.rejects(storage.storeChunk(collector().parsePage(table(row()), range), range), /failed/);
    assert.deepEqual(coverageWrites.map(batch => batch[0].status), ['pending']);
  }
});

test('stored payouts absent from a newer report are flagged, not silently deleted or certified', async () => {
  const old = { fund_id: fund.fund_id, amc_id: fund.amc_id, payout_date: '2026-08-02', payout_per_unit: 1, ex_nav: 100 };
  const { db, coverageWrites, persisted } = database({ seedRows: [old] });
  const storage = new Storage(db, { dryRun: false });
  await storage.initialize();
  await assert.rejects(storage.storeChunk(collector().parsePage(table(row()), range), range), /absent from this source report/);
  assert.deepEqual(coverageWrites.map(batch => batch[0].status), ['pending']);
  assert.ok(persisted.has(`${fund.fund_id}/2026-08-02`));
});

test('quarantines every disputed value and marks only the affected matched fund for review', async () => {
  const second = { ...fund, fund_id: 'fund-2', fund_name: 'Second Fund' };
  const { db, writes, coverageWrites } = database({ funds: [fund, second] });
  const storage = new Storage(db, { dryRun: false, quarantineConflicts: true, profileMap: [] });
  await storage.initialize();
  const raw = collector().parsePage(table(row({ 5: '0.0285' }) + row({ 5: '0.0248' }) + row({ 2: 'Second Fund' })), range);
  await storage.storeChunk(raw, range);
  assert.equal(writes[0].rows.length, 1);
  assert.equal(writes[0].rows[0].fund_id, second.fund_id);
  assert.equal(storage.issues.size, 1);
  assert.equal([...storage.issues.values()][0].records.length, 2);
  assert.deepEqual(coverageWrites.at(-1).map(r => r.status), ['needs_review', 'verified']);
});

test('verified numeric profile mapping accepts an old name but rejects another AMC', async () => {
  const { db } = database();
  const storage = new Storage(db, { profileMap: [{ mufap_fund_id: 123, fund_id: fund.fund_id, amc_id: fund.amc_id }] });
  await storage.initialize();
  assert.equal(storage.prepareRecords(collector().parsePage(table(row({ 2: '<a href="?FundID=123">Historic Name</a>' })), range))[0].fund_id, fund.fund_id);
  assert.throws(() => storage.prepareRecords(collector().parsePage(table(row({ 1: 'Other AMC' })), range)), /identity disagrees/);
});

test('AMC-verified Alfalah rename does not collapse unrelated fund names', () => {
  const { normalizeFundNameForAMC: normalize } = require('../fund-identity');
  const amc = 'Alfalah Asset Management Limited';
  assert.equal(normalize('Alfalah Islamic Rozana Amdani Fund', amc), normalize('Alfalah Islamic Amdani Fund', amc));
  assert.notEqual(normalize('Alfalah Islamic Rozana Amdani Fund', 'Other AMC'), normalize('Alfalah Islamic Amdani Fund', 'Other AMC'));
  assert.notEqual(normalize('Alfalah Islamic Money Market Fund', amc), normalize('Alfalah Islamic Amdani Fund', amc));
});
