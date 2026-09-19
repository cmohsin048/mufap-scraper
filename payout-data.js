// Use a read-only/anon Supabase client in the web app. No credentials live here.
const { calculateFundReturns } = require('./payout-returns');

async function loadFundReturns(client, { fundId, from, to, maxNavAgeDays = 7 }) {
  if (typeof client.rpc === 'function') {
    const { data, error } = await client.rpc('get_fund_return_inputs', { p_fund_id: fundId, p_from: from, p_to: to });
    if (error) throw new Error(`Could not load a consistent fund snapshot: ${error.message}`);
    if (!data || !Array.isArray(data.navRecords) || !Array.isArray(data.payouts) || !Array.isArray(data.coverage)) {
      throw new Error('Invalid fund snapshot response');
    }
    return calculateFundReturns({ fundId, from, to, maxNavAgeDays,
      navRecords: data.navRecords, payouts: data.payouts, coverage: data.coverage });
  }
  // Non-Supabase adapters may use this paginated path against a fixed snapshot.
  const endpoint = async date => {
    const { data, error } = await client.from('daily_nav').select('fund_id,nav_date,nav')
      .eq('fund_id', fundId).lte('nav_date', date).order('nav_date', { ascending: false }).limit(1);
    if (error) throw new Error(`Could not load NAV: ${error.message}`);
    return data?.[0];
  };
  const [start, end] = await Promise.all([endpoint(from), endpoint(to)]);
  const navRecords = [start, end].filter(Boolean);
  const payouts = [];
  const coverage = [];
  if (start && end && start.nav_date < end.nav_date) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from('fund_payouts')
        .select('fund_id,payout_date,payout_per_unit,ex_nav').eq('fund_id', fundId)
        .gt('payout_date', start.nav_date).lte('payout_date', end.nav_date)
        .order('payout_date').range(offset, offset + 999);
      if (error) throw new Error(`Could not load payouts: ${error.message}`);
      payouts.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from('fund_payout_coverage')
        .select('fund_id,date_from,date_to,status,checked_at').eq('fund_id', fundId)
        .lte('date_from', end.nav_date).gte('date_to', start.nav_date)
        .order('date_from').order('date_to').range(offset, offset + 999);
      if (error) throw new Error(`Could not load payout coverage: ${error.message}`);
      coverage.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
  }
  return calculateFundReturns({ fundId, from, to, maxNavAgeDays, navRecords, payouts, coverage });
}

module.exports = { loadFundReturns };
