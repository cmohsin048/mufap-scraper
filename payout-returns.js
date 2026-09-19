// Browser-compatible, dependency-free calculations. Percent results are numbers,
// not formatted strings. Distributions on the starting NAV date are excluded:
// that NAV is already ex-distribution. End-date distributions are included.
// Methodology: https://mufap.com.pk/Upload/WebDoc/Communication/MUFAP_Return_Methodology1043.pdf
const DAY = 86400000;

function dateDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ISO date: ${value}`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error(`Invalid calendar date: ${value}`);
  return time / DAY;
}
const iso = day => new Date(day * DAY).toISOString().slice(0, 10);

function numeric(value, field, minimum = 0) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) {
    throw new Error(`Invalid ${field}`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum) throw new Error(`Invalid ${field}`);
  return result;
}

function missingCoverage(fundId, from, to, coverage = []) {
  const start = dateDay(from);
  const end = dateDay(to);
  if (start > end) return [];
  const relevant = coverage.filter(r => r.fund_id === fundId).map(r => {
    const left = dateDay(r.date_from);
    const right = dateDay(r.date_to);
    const checked = Date.parse(r.checked_at);
    if (left > right || !Number.isFinite(checked)) throw new Error('Invalid payout coverage interval');
    return { ...r, left: Math.max(start, left), right: Math.min(end, right), checked };
  }).filter(r => r.left <= r.right);
  const boundaries = [...new Set([start, end + 1, ...relevant.flatMap(r => [r.left, r.right + 1])])].sort((a, b) => a - b);
  const missing = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const left = boundaries[i];
    const right = boundaries[i + 1] - 1;
    const active = relevant.filter(r => r.left <= left && r.right >= right);
    const latest = Math.max(...active.map(r => r.checked));
    // Tied timestamps are conservative: an unverified interval wins.
    const verified = active.length > 0 && active.filter(r => r.checked === latest).every(r => r.status === 'verified');
    if (!verified) {
      if (missing.length && missing.at(-1).end + 1 === left) missing.at(-1).end = right;
      else missing.push({ start: left, end: right });
    }
  }
  return missing.map(r => ({ from: iso(r.start), to: iso(r.end) }));
}

function calculateFundReturns({ fundId, navRecords, payouts, coverage = [], from, to, maxNavAgeDays = 7 }) {
  if (!fundId || !Array.isArray(navRecords) || !Array.isArray(payouts)) throw new Error('Fund ID, NAV records, and payouts are required');
  const requestedStart = dateDay(from);
  const requestedEnd = dateDay(to);
  if (requestedStart >= requestedEnd) throw new Error('Return period must have an end after its start');
  if (!Number.isInteger(maxNavAgeDays) || maxNavAgeDays < 0) throw new Error('Invalid maximum NAV age');
  const navs = new Map();
  for (const r of navRecords) {
    if (r.fund_id !== fundId) throw new Error('NAV belongs to a different fund');
    const day = dateDay(r.nav_date);
    const nav = numeric(r.nav, 'NAV');
    if (nav <= 0) throw new Error('NAV must be positive');
    if (navs.has(day) && navs.get(day) !== nav) throw new Error('Conflicting NAVs on the same date');
    navs.set(day, nav);
  }
  const dates = [...navs.keys()].sort((a, b) => a - b);
  const start = dates.filter(d => d <= requestedStart).at(-1);
  const end = dates.filter(d => d <= requestedEnd).at(-1);
  const result = { fundId, requestedFrom: from, requestedTo: to,
    actualFrom: start === undefined ? null : iso(start), actualTo: end === undefined ? null : iso(end),
    status: 'unavailable', reasons: [], navReturnPct: null, cashReturnPct: null,
    totalReturnPct: null, simpleAnnualizedReturnPct: null, cagrPct: null,
    payoutPerInitialUnit: null, distributionCount: 0, reinvestmentFactor: null, missingCoverage: [] };
  if (start === undefined || end === undefined || start >= end) {
    result.reasons.push('insufficient_nav_history'); return result;
  }
  if (requestedStart - start > maxNavAgeDays || requestedEnd - end > maxNavAgeDays) {
    result.reasons.push('stale_nav'); return result;
  }
  const initialNav = navs.get(start);
  const finalNav = navs.get(end);
  const navReturn = (finalNav / initialNav - 1) * 100;
  if (!Number.isFinite(navReturn)) { result.reasons.push('numeric_overflow'); return result; }
  result.navReturnPct = navReturn;
  result.missingCoverage = missingCoverage(fundId, iso(start + 1), iso(end), coverage);
  const events = new Map();
  for (const r of payouts) {
    if (r.fund_id !== fundId) throw new Error('Payout belongs to a different fund');
    const day = dateDay(r.payout_date);
    if (day <= start || day > end) continue;
    const amount = numeric(r.payout_per_unit, 'payout');
    const exNav = r.ex_nav === null || r.ex_nav === undefined ? null : numeric(r.ex_nav, 'ex-NAV');
    const previous = events.get(day);
    if (previous && (previous.amount !== amount || previous.exNav !== exNav)) throw new Error('Conflicting payouts on the same date');
    events.set(day, { amount, exNav });
  }
  if (result.missingCoverage.length) {
    result.reasons.push('unverified_payout_coverage'); return result;
  }
  let factor = 1;
  let cash = 0;
  let reinvestmentValid = true;
  for (const [, event] of [...events].sort((a, b) => a[0] - b[0])) {
    cash += event.amount;
    if (event.amount === 0) continue;
    result.distributionCount++;
    if (event.exNav === null || event.exNav <= 0) reinvestmentValid = false;
    else factor *= 1 + event.amount / event.exNav;
  }
  result.payoutPerInitialUnit = Number.isFinite(cash) ? cash : null;
  result.cashReturnPct = ((finalNav + cash) / initialNav - 1) * 100;
  if (!reinvestmentValid || !Number.isFinite(factor) || !Number.isFinite(result.cashReturnPct)) {
    result.status = 'partial';
    result.reasons.push(!reinvestmentValid ? 'invalid_reinvestment_nav' : 'numeric_overflow');
    if (!Number.isFinite(result.cashReturnPct)) result.cashReturnPct = null;
    return result;
  }
  const growth = finalNav * factor / initialNav;
  const total = (growth - 1) * 100;
  const annualized = total * 365 / (end - start);
  const cagr = Math.expm1(Math.log(growth) * 365 / (end - start)) * 100;
  if (![growth, total, annualized, cagr].every(Number.isFinite)) {
    result.status = 'partial'; result.reasons.push('numeric_overflow'); return result;
  }
  result.status = 'ready';
  result.totalReturnPct = total;
  result.simpleAnnualizedReturnPct = annualized;
  result.cagrPct = cagr;
  result.reinvestmentFactor = factor;
  return result;
}

module.exports = { calculateFundReturns, missingCoverage };
