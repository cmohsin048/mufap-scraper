const { test } = require('node:test');
const assert = require('node:assert/strict');
const NAVDataCollector = require('../nav-collector');
const { MufapClient, isChallenge, mufapError } = require('../mufap-client');

const fund = {
  fund_id: 'fund-1', amc_id: 'amc-1', fund_name: 'Test Fund',
  amcs: { amc_name: 'Test AMC' }
};
const challenge = '<html><title>Just a moment...</title><script>window._cf_chl_opt = {};</script></html>';
const table = rows => `<table id="table_id"><thead><tr><th>NAV</th><th>Validity Date</th></tr></thead><tbody>${rows}</tbody></table>`;
function row(date = 'Sep 11, 2026', nav = '1,234.5678', name = fund.fund_name) {
  const values = ['Open-End Funds', 'Test AMC', name, 'Shariah Compliant Income',
    'May 20, 2003', '1,240', '1,234', nav, date, '0', '0', '0', '0', 'CDC'];
  return `<tr class="fund-block">${values.map(value => `<td>${value}</td>`).join('')}</tr>`;
}
function collector(options = {}) {
  const result = new NAVDataCollector('https://example.supabase.co', 'test-key', {
    mufapClient: { mode: 'test', get: async () => table(row()), close: async () => {} },
    ...options
  });
  result.delay = async () => {};
  return result;
}
function response(status, html, headers = {}) {
  return { status, html, headers: new Headers(headers) };
}
function client(options = {}) {
  return new MufapClient({ log: () => {}, sleep: async () => {}, ...options });
}

test('detects challenge headers on any status, plus common challenge HTML', () => {
  assert.equal(isChallenge('verify', new Headers({ 'cf-mitigated': 'challenge' })), true);
  assert.equal(isChallenge(challenge), true);
  assert.equal(isChallenge('<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>'), true);
  assert.equal(isChallenge(table(row())), false);
});

test('switches to the browser on a challenge and reuses it for later funds', async () => {
  const c = client();
  let httpCalls = 0;
  const browserUrls = [];
  c.getHttp = async () => { httpCalls++; return response(403, challenge); };
  c.getBrowser = async url => { browserUrls.push(url); return response(200, table(row())); };
  assert.match(await c.get('https://www.mufap.com.pk/report?fund=1'), /table_id/);
  await c.get('https://www.mufap.com.pk/report?fund=2');
  assert.equal(httpCalls, 1);
  assert.equal(browserUrls.length, 2);
});

test('HTTP-only challenge fails immediately without sleeping or opening a browser', async () => {
  const c = client({ mode: 'http', sleep: () => assert.fail('must not sleep') });
  c.getHttp = async () => response(503, 'verification', { 'cf-mitigated': 'challenge' });
  c.getBrowser = () => assert.fail('must not open browser');
  await assert.rejects(c.get('https://www.mufap.com.pk/report'), { code: 'MUFAP_BLOCKED' });
});

test('plain access denial stops without disguising it as a challenge', async () => {
  const c = client();
  c.getHttp = async () => response(403, 'Forbidden');
  c.getBrowser = () => assert.fail('must not open browser');
  await assert.rejects(c.get('https://www.mufap.com.pk/report'), { code: 'MUFAP_BLOCKED' });
});

test('429 retries respect Retry-After and have a fixed bound', async () => {
  const waits = [];
  const c = client({ sleep: async ms => waits.push(ms) });
  let requests = 0;
  c.getHttp = async () => { requests++; return response(429, 'Too many requests', { 'retry-after': '7' }); };
  await assert.rejects(c.get('https://www.mufap.com.pk/report'), { code: 'MUFAP_UNAVAILABLE' });
  assert.equal(requests, 3);
  assert.deepEqual(waits, [7000, 7000]);
});

test('long Retry-After stops the run instead of retrying before permitted', async () => {
  const c = client({ sleep: () => assert.fail('must not sleep') });
  c.getHttp = async () => response(429, 'Too many requests', { 'retry-after': '300' });
  await assert.rejects(c.get('https://www.mufap.com.pk/report'), { code: 'MUFAP_UNAVAILABLE' });
});

test('temporary server and network errors recover with bounded retries', async () => {
  const c = client();
  let calls = 0;
  c.getHttp = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return response(calls === 2 ? 502 : 200, table(row()));
  };
  assert.match(await c.get('https://www.mufap.com.pk/report'), /table_id/);
  assert.equal(calls, 3);
});

test('browser waits for the final report HTML and does not return a challenge document', async () => {
  const c = client();
  const listeners = new Map();
  const frame = {};
  const url = 'https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3&fundId=1';
  const document = html => ({
    request: () => ({ isNavigationRequest: () => true }), frame: () => frame,
    status: () => 200, headers: () => ({}), text: async () => html, url: () => url
  });
  c.page = {
    on: (event, listener) => listeners.set(event, listener),
    removeListener: event => listeners.delete(event), mainFrame: () => frame,
    goto: async () => listeners.get('response')(document(challenge)), isClosed: () => false
  };
  c.openBrowser = async () => {};
  c.sleep = async () => listeners.get('response')(document(table(row())));
  const result = await c.getBrowser(url);
  assert.equal(result.html, table(row()));
  assert.equal(listeners.size, 0);
});

test('unresolved browser challenge stops once its deadline expires', async () => {
  const c = client({ challengeTimeoutMs: 0 });
  const frame = {};
  let listener;
  c.openBrowser = async () => {};
  c.page = {
    on: (_event, callback) => { listener = callback; }, removeListener: () => {},
    mainFrame: () => frame, isClosed: () => false,
    goto: async () => listener({ request: () => ({ isNavigationRequest: () => true }),
      frame: () => frame, status: () => 403, headers: () => ({}), text: async () => challenge })
  };
  await assert.rejects(c.getBrowser('https://www.mufap.com.pk/report'), { code: 'MUFAP_BLOCKED' });
});

test('parses NAV precision, names and dates from the server table', () => {
  const c = collector();
  const records = c.parseNavTable(table(row()));
  assert.equal(records.length, 1);
  assert.equal(records[0].nav, 1234.5678);
  assert.equal(records[0].nav_date, '2026-09-11');
  assert.equal(records[0].fund_name, 'Test Fund');
  assert.equal(records[0].amc_name, 'Test AMC');
});

test('also parses DataTables grouped rows with the AMC column removed', () => {
  const grouped = '<tr class="group"><td>Test AMC</td></tr>' + row().replace('<td>Test AMC</td>', '');
  const records = collector().parseNavTable(table(grouped));
  assert.equal(records[0].fund_name, 'Test Fund');
  assert.equal(records[0].amc_name, 'Test AMC');
  assert.equal(records[0].nav, 1234.5678);
});

test('refuses unexpected pages and malformed records instead of returning empty data', () => {
  const c = collector();
  assert.throws(() => c.parseNavTable(challenge), { code: 'MUFAP_BLOCKED' });
  for (const html of ['<h1>Maintenance</h1>', table(row('Feb 30, 2026')),
    table(row('Bad 01, 2026')), table(row('Sep 11, 2026', 'N/A')),
    table('<tr class="fund-block"><td>truncated</td></tr>')]) {
    assert.throws(() => c.parseNavTable(html), { code: 'MUFAP_INVALID_RESPONSE' });
  }
  assert.deepEqual(c.parseNavTable(table('')), []);
});

test('fetch validates the requested range', async () => {
  const c = collector();
  await assert.rejects(c.fetchNavData('amc-1', 'fund-1', '2026-09-12', '2026-09-13'),
    { code: 'MUFAP_INVALID_RESPONSE' });
});

test('MUFAP zero-price rows without a validity date mean no NAV is published', () => {
  const c = collector();
  const placeholder = row('', '0.0000')
    .replace('<td>1,240</td>', '<td>0.0000</td>')
    .replace('<td>1,234</td>', '<td>0.0000</td>');
  assert.deepEqual(c.parseNavTable(table(placeholder)), []);
  assert.equal(c.parseNavTable(table(placeholder + row())).length, 1);
  // Missing dates on nonzero prices must still be reported as malformed data.
  assert.throws(() => c.parseNavTable(table(row('', '100'))), { code: 'MUFAP_INVALID_RESPONSE' });
});

test('a challenged fund and all subsequent funds retain their existing progress', async () => {
  const c = collector();
  const calls = [];
  let closed = false;
  c.getAllFunds = async () => [fund, { ...fund, fund_id: 'fund-2' }];
  c.getProgressMap = async () => new Map([['fund-1', '2026-08-25']]);
  c.fetchNavData = async () => { calls.push('fetch'); throw mufapError('MUFAP_BLOCKED', 'challenge'); };
  c.updateProgress = async () => assert.fail('progress must not change');
  c.mufap.close = async () => { closed = true; };
  c.delay = async () => assert.fail('no cooldown retries');
  const result = await c.collectAllNavData();
  assert.deepEqual(calls, ['fetch']);
  assert.equal(result.success, false);
  assert.equal(result.stoppedEarly, true);
  assert.equal(closed, true);
});

test('a valid empty report never advances the last collected date', async () => {
  const c = collector();
  const updates = [];
  c.fetchNavData = async () => [];
  c.updateProgress = async (...args) => updates.push(args);
  await c.collectFundNavData(fund, false, '2026-08-25');
  assert.deepEqual(updates, [['fund-1', 'amc-1', 'completed']]);
});

test('wrong fund rows are rejected before any database writes', async () => {
  const c = collector();
  c.fetchNavData = async () => c.parseNavTable(table(row('Sep 11, 2026', '100', 'Different Fund')));
  c.updateProgress = async () => assert.fail('must not write progress');
  c.storeNavData = async () => assert.fail('must not store NAV');
  await assert.rejects(c.collectFundNavData(fund, false, '2026-08-25'), { code: 'MUFAP_FUND_MISMATCH' });
});

test('Alfalah rename is accepted in both directions only for the exact fund and AMC', async () => {
  const oldName = 'Alfalah Islamic Rozana Amdani Fund';
  const newName = 'Alfalah Islamic Amdani Fund';
  const amc = 'Alfalah Asset Management Limited';
  const c = collector();
  assert.notEqual(c.normalizeFundName(oldName, 'Other AMC'), c.normalizeFundName(newName, 'Other AMC'));
  assert.notEqual(c.normalizeFundName(`${oldName} Plan II`, amc), c.normalizeFundName(newName, amc));
  for (const [expected, returned] of [[oldName, newName], [newName, oldName]]) {
    c.fetchNavData = async () => c.parseNavTable(table(row('Sep 11, 2026', '100', returned)))
      .map(record => ({ ...record, amc_name: amc }));
    let stored = 0;
    c.storeNavData = async (_fundId, _amcId, records) => {
      stored += records.length;
      return { inserted: records.length, updated: 0 };
    };
    c.updateProgress = async () => {};
    const renamed = { ...fund, fund_name: expected, amcs: { amc_name: amc } };
    await c.collectFundNavData(renamed, false, '2026-08-25');
    assert.equal(stored, 1);
    c.storeNavData = async () => assert.fail('wrong AMC must not store NAV');
    c.updateProgress = async () => assert.fail('wrong AMC must not update progress');
    await assert.rejects(c.collectFundNavData({ ...renamed, amcs: { amc_name: 'Other AMC' } },
      false, '2026-08-25'), { code: 'MUFAP_FUND_MISMATCH' });
  }
});

test('unresolved fund mismatch leaves its progress untouched and continues remaining funds', async () => {
  const c = collector();
  c.getAllFunds = async () => [fund, { ...fund, fund_id: 'fund-2' }];
  c.getProgressMap = async () => new Map();
  c.fetchNavData = async (_amcId, fundId) => c.parseNavTable(table(row('Sep 11, 2026', '100',
    fundId === 'fund-1' ? 'Unverified Rename' : fund.fund_name)));
  const stored = [];
  c.storeNavData = async (fundId, _amcId, records) => {
    stored.push(fundId);
    return { inserted: records.length, updated: 0 };
  };
  c.updateProgress = async fundId => assert.equal(fundId, 'fund-2');
  const result = await c.collectAllNavData({ delayBetweenFunds: 0 });
  assert.deepEqual(stored, ['fund-2']);
  assert.equal(result.stoppedEarly, false);
  assert.equal(result.success, false);
  assert.equal(result.stats.errors.length, 1);
  assert.equal(result.stats.errors[0].fund, fund.fund_name);
  assert.equal(result.stats.fundsProcessed, 1);
});

test('redundant parent fund prefixes match the full plan name without losing plan identity', () => {
  const c = collector();
  const short = 'Faysal Islamic Financial Growth Plan II';
  const wrapped = 'Faysal Islamic Financial Growth Fund (Faysal Islamic Financial Growth Plan II)';
  assert.equal(c.normalizeFundName(short), c.normalizeFundName(wrapped));
  assert.notEqual(c.normalizeFundName(short), c.normalizeFundName(wrapped.replace('Plan II', 'Plan III')));
  assert.notEqual(c.normalizeFundName(short), c.normalizeFundName(`Unrelated Fund (${short})`));
  assert.notEqual(c.normalizeFundName('Family Fund'), c.normalizeFundName('Family Fund (Plan II)'));
});

test('the reported Faysal plan name variation is accepted for collection', async () => {
  const c = collector();
  const faysal = { ...fund, fund_name: 'Faysal Islamic Financial Growth Plan II' };
  c.fetchNavData = async () => c.parseNavTable(table(row('Sep 11, 2026', '100',
    'Faysal Islamic Financial Growth Fund (Faysal Islamic Financial Growth Plan II)')));
  const updates = [];
  let stored = 0;
  c.updateProgress = async (...args) => updates.push(args);
  c.storeNavData = async (_fundId, _amcId, records) => {
    stored += records.length;
    return { inserted: records.length, updated: 0 };
  };
  await c.collectFundNavData(faysal, false, '2026-08-26');
  assert.equal(stored, 1);
  assert.equal(updates.at(-1)[2], 'completed');
  assert.equal(updates.at(-1)[3], '2026-09-11');
});

test('a matching plan name from another AMC remains rejected', async () => {
  const c = collector();
  c.fetchNavData = async () => c.parseNavTable(table(row())).map(record => ({ ...record, amc_name: 'Other AMC' }));
  c.updateProgress = async () => assert.fail('must not write progress');
  c.storeNavData = async () => assert.fail('must not write NAV');
  await assert.rejects(c.collectFundNavData(fund, false, '2026-08-25'), { code: 'MUFAP_FUND_MISMATCH' });
});

test('former-name notes match only the current fund name and preserve plan qualifiers', () => {
  const c = collector();
  const current = 'AKD Islamic Cash Fund';
  const annotated = `${current} (Formerly AKD Islamic Daily Dividend Fund)`;
  assert.equal(c.normalizeFundName(annotated), c.normalizeFundName(current));
  assert.equal(c.normalizeFundName(` ${current}  (FORMERLY Old Name) `), c.normalizeFundName(current));
  assert.notEqual(c.normalizeFundName(annotated), c.normalizeFundName('AKD Islamic Daily Dividend Fund'));
  assert.notEqual(c.normalizeFundName('Family Fund (Plan II) (Formerly Old Name)'),
    c.normalizeFundName('Family Fund (Plan III)'));
  assert.notEqual(c.normalizeFundName('Family Fund (Plan II)'), c.normalizeFundName('Family Fund'));
});

test('former-name punctuation is normalized consistently for every fund', () => {
  const c = collector();
  for (const current of ['AKD Islamic Cash Fund', 'JS Islamic Money Market Fund', 'Family Fund (Plan II)']) {
    for (const note of ['(Formerly Old Name)', '(Formerly: Old Name)', '(Formerly:Old Name)',
      '(FORMERLY Old Name)', '(Formerly : Old Name)', '(Formerly:\u00a0Old Name)']) {
      assert.equal(c.normalizeFundName(`${current}${note}`), c.normalizeFundName(current));
      assert.equal(c.normalizeFundName(`${current} ${note}`), c.normalizeFundName(current));
    }
  }
  assert.notEqual(c.normalizeFundName('Family Fund (FormerlyKnown Plan II)'), c.normalizeFundName('Family Fund'));
  assert.notEqual(c.normalizeFundName('Family Fund (Plan II) (Formerly: Old Name)'),
    c.normalizeFundName('Family Fund (Plan III)'));
  assert.equal(c.normalizeFundName('Family Fund (Family Plan II) (Formerly: Old Name)'),
    c.normalizeFundName('Family Plan II'));
});

test('JS Formerly: variation is accepted on either side and across all report rows', async () => {
  const current = 'JS Islamic Money Market Fund';
  const annotated = `${current} (Formerly: JS Islamic Daily Dividend Fund)`;
  for (const databaseName of [current, annotated]) {
    const c = collector();
    c.fetchNavData = async () => c.parseNavTable(table(
      row('Sep 11, 2026', '100', current) + row('Sep 12, 2026', '101', annotated)));
    c.updateProgress = async () => {};
    let stored = 0;
    c.storeNavData = async (_fundId, _amcId, records) => {
      stored += records.length;
      return { inserted: records.length, updated: 0 };
    };
    await c.collectFundNavData({ ...fund, fund_name: databaseName }, false, '2026-08-27');
    assert.equal(stored, 2);
    assert.equal(c.stats.fundsProcessed, 1);
  }
});

test('AKD current name is collected despite the database former-name note', async () => {
  const c = collector();
  const akd = { ...fund, fund_name: 'AKD Islamic Cash Fund (Formerly AKD Islamic Daily Dividend Fund)',
    amcs: { amc_name: 'AKD Investment Management Limited' } };
  c.fetchNavData = async () => c.parseNavTable(table(row('Sep 11, 2026', '100', 'AKD Islamic Cash Fund')
    .replace('<td>Test AMC</td>', `<td>${akd.amcs.amc_name}</td>`)));
  const updates = [];
  c.updateProgress = async (...args) => updates.push(args);
  c.storeNavData = async (fundId, amcId, records) => {
    assert.equal(fundId, akd.fund_id);
    assert.equal(amcId, akd.amc_id);
    assert.equal(records.length, 1);
    return { inserted: 1, updated: 0 };
  };
  await c.collectFundNavData(akd, false, '2026-08-27');
  assert.equal(c.stats.fundsProcessed, 1);
  assert.equal(updates.at(-1)[3], '2026-09-11');

  c.updateProgress = async () => assert.fail('must not write progress');
  c.storeNavData = async () => assert.fail('must not store NAV');
  await assert.rejects(c.collectFundNavData({ ...akd, amcs: { amc_name: 'Other AMC' } }, false,
    '2026-08-27'), { code: 'MUFAP_FUND_MISMATCH' });
});

test('failed batch stops writes in chronological order and never marks the fund completed', async () => {
  const c = collector();
  c.batchSize = 1;
  const records = c.parseNavTable(table(row('Sep 13, 2026') + row('Sep 11, 2026') + row('Sep 12, 2026')));
  const writes = [];
  const updates = [];
  c.supabase = { from: () => ({ upsert: async batch => {
    writes.push(batch[0].nav_date);
    return { error: writes.length === 2 ? { message: 'database unavailable' } : null };
  } }) };
  c.fetchNavData = async () => records;
  c.updateProgress = async (...args) => updates.push(args);
  await c.collectFundNavData(fund, false, '2026-08-25');
  assert.deepEqual(writes, ['2026-09-11', '2026-09-12']);
  assert.deepEqual(updates.map(args => args[2]), ['in_progress', 'error']);
  assert.equal(c.stats.fundsProcessed, 0);
});

test('identical dates are deduplicated and conflicting values fail before storage', async () => {
  const c = collector({ dryRun: true });
  const record = c.parseNavTable(table(row()))[0];
  assert.equal((await c.storeNavData('fund-1', 'amc-1', [record, record])).inserted, 1);
  await assert.rejects(c.storeNavData('fund-1', 'amc-1', [record, { ...record, nav: 50 }]), /Conflicting NAV/);
});

test('dry-run exercises collection without writing NAV or progress', async () => {
  const c = collector({ dryRun: true });
  c.supabase = { from: () => assert.fail('dry run must not write') };
  c.fetchNavData = async () => c.parseNavTable(table(row()));
  await c.collectFundNavData(fund, false, '2026-08-25');
  assert.equal(c.stats.fundsProcessed, 1);
});

test('browser cleanup also runs if reading database progress fails', async () => {
  const c = collector();
  let closed = false;
  c.getAllFunds = async () => { throw new Error('database offline'); };
  c.mufap.close = async () => { closed = true; };
  await assert.rejects(c.collectAllNavData(), /database offline/);
  assert.equal(closed, true);
});
