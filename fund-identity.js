function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeFundName(name) {
  const normalized = normalizeName(name)
    .replace(/(?:\s*\(formerly(?:\s*:\s*|\s+)[^()]+\))+$/, '').trim();
  const wrapped = normalized.match(/^(.+?)\s*\(([^()]+)\)$/);
  if (wrapped) {
    const parent = wrapped[1].trim();
    const plan = wrapped[2].trim();
    const family = parent.replace(/\s+fund$/, '');
    if (family !== parent && plan.startsWith(`${family} `)) return plan;
  }
  return normalized;
}

function normalizeFundNameForAMC(name, amc) {
  const normalized = normalizeFundName(name);
  const alias = require('./fund-name-aliases.json').find(row => normalizeName(row.amc_name) === normalizeName(amc) &&
    normalizeFundName(row.former_name) === normalized);
  return alias ? normalizeFundName(alias.current_name) : normalized;
}

module.exports = { normalizeName, normalizeFundName, normalizeFundNameForAMC };
