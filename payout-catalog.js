const { normalizeName, normalizeFundNameForAMC } = require('./fund-identity');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isShariahCategory = category => /^(?:VPS-)?Shariah Compliant\b/i.test(String(category || '').trim());

// Only add funds explicitly reported as unmatched; never invent UUIDs or use fuzzy matching.
function planReconciliation(unmatched, sourceGroups, catalog, profileMap, verifiedAt = new Date().toISOString()) {
  const source = sourceGroups.flatMap(group => group.funds.map(fund => ({ ...fund, amc: group.amc })));
  const additions = new Map(), mappings = new Map(profileMap.map(row => [row.mufap_fund_id, row]));
  for (const row of unmatched) {
    const candidates = source.filter(f => Number(f.fund) === row.mufap_fund_id &&
      normalizeName(f.amc.AMC_Desc) === normalizeName(row.amc_name) &&
      normalizeFundNameForAMC(f.Fund_Desc, row.amc_name) === normalizeFundNameForAMC(row.fund_name, row.amc_name));
    if (candidates.length !== 1) throw new Error(`Cannot uniquely verify official catalog identity: ${row.fund_name}`);
    const f = candidates[0];
    if (!UUID.test(f.FundID) || !UUID.test(f.amc.AMCId) || !Number.isSafeInteger(row.mufap_fund_id) || row.mufap_fund_id < 1 || !isShariahCategory(f.Cat_Desc)) {
      throw new Error(`Invalid official Shariah identity: ${row.fund_name}`);
    }
    const existing = catalog.find(item => item.fund_id === f.FundID);
    if (existing && (existing.amc_id !== f.amc.AMCId || !existing.is_shariah_compliant)) {
      throw new Error(`Existing fund disagrees with official catalog: ${row.fund_name}`);
    }
    const sameName = catalog.filter(item => item.amc_id === f.amc.AMCId &&
      (!item.category_name || normalizeName(item.category_name) === normalizeName(f.Cat_Desc)) &&
      normalizeFundNameForAMC(item.fund_name, row.amc_name) === normalizeFundNameForAMC(f.Fund_Desc, row.amc_name));
    if (sameName.some(item => item.fund_id !== f.FundID)) throw new Error(`Possible duplicate catalog identity: ${row.fund_name}`);
    const old = mappings.get(row.mufap_fund_id);
    if (old && (old.fund_id !== f.FundID || old.amc_id !== f.amc.AMCId)) throw new Error(`Conflicting profile map: ${row.fund_name}`);
    if (!existing) additions.set(f.FundID, { fund_id: f.FundID, amc_id: f.amc.AMCId,
      fund_name: f.Fund_Desc.trim(), fund_type: f.fund_type, category_id: f.CatId,
      category_name: f.Cat_Desc.trim(), pricing_mechanism: f.PricingMechanism,
      is_shariah_compliant: true, updated_at: verifiedAt });
    mappings.set(row.mufap_fund_id, { mufap_fund_id: row.mufap_fund_id, fund_id: f.FundID,
      amc_id: f.amc.AMCId, fund_name: existing?.fund_name || f.Fund_Desc.trim(),
      source_fund_name: f.Fund_Desc.trim(), source_amc_name: f.amc.AMC_Desc.trim(), category: f.Cat_Desc.trim(),
      verified_at: verifiedAt, source: 'https://www.mufap.com.pk/TopHolding/GetFundNameByAMC' });
  }
  return { additions: [...additions.values()], profileMap: [...mappings.values()] };
}
module.exports = { planReconciliation, isShariahCategory };
