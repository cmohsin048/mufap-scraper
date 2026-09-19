-- Additive migration: run once in the Supabase SQL Editor before --store.
-- Uses the same UUID fund IDs as daily_nav. MUFAP profile IDs are separate.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_funds_payout_identity ON public.funds(fund_id, amc_id);

CREATE TABLE IF NOT EXISTS public.fund_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL REFERENCES public.funds(fund_id) ON DELETE CASCADE,
  amc_id UUID NOT NULL REFERENCES public.amcs(amc_id) ON DELETE CASCADE,
  payout_date DATE NOT NULL,
  payout_per_unit NUMERIC NOT NULL CHECK (payout_per_unit >= 0 AND payout_per_unit <> 'NaN'::numeric),
  ex_nav NUMERIC NOT NULL CHECK (ex_nav >= 0 AND ex_nav <> 'NaN'::numeric),
  mufap_fund_id BIGINT,
  source_fund_name TEXT NOT NULL,
  source_amc_name TEXT NOT NULL,
  category TEXT,
  inception_date DATE,
  report_date DATE,
  source_date_from DATE NOT NULL,
  source_date_to DATE NOT NULL,
  scraped_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fund_id, payout_date),
  CHECK (source_date_from <= payout_date AND payout_date <= source_date_to)
);

-- Named constraints also upgrade a table created by an earlier version.
ALTER TABLE public.fund_payouts DROP CONSTRAINT IF EXISTS payout_amounts_finite;
ALTER TABLE public.fund_payouts ADD CONSTRAINT payout_amounts_finite CHECK (
  payout_per_unit NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
  ex_nav NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
);
ALTER TABLE public.fund_payouts DROP CONSTRAINT IF EXISTS payout_fund_amc_identity;
ALTER TABLE public.fund_payouts ADD CONSTRAINT payout_fund_amc_identity
  FOREIGN KEY (fund_id, amc_id) REFERENCES public.funds(fund_id, amc_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_payouts_date ON public.fund_payouts(payout_date DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_amc ON public.fund_payouts(amc_id);
ALTER TABLE public.fund_payouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public payout read access" ON public.fund_payouts;
CREATE POLICY "Public payout read access" ON public.fund_payouts FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON public.fund_payouts FROM anon, authenticated;
GRANT SELECT ON public.fund_payouts TO anon, authenticated;
GRANT ALL ON public.fund_payouts TO service_role;

COMMENT ON TABLE public.fund_payouts IS
  'MUFAP distributions matched to the existing fund catalog. Absence of rows does not prove complete payout history.';
COMMENT ON COLUMN public.fund_payouts.payout_per_unit IS 'Reported cash distribution per unit, not a percentage.';
COMMENT ON COLUMN public.fund_payouts.ex_nav IS 'Reported ex-distribution NAV; zero must not be used as a reinvestment divisor.';

CREATE TABLE IF NOT EXISTS public.fund_payout_coverage (
  fund_id UUID NOT NULL REFERENCES public.funds(fund_id) ON DELETE CASCADE,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'needs_review')),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  checked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (fund_id, date_from, date_to),
  CHECK (date_from <= date_to)
);
ALTER TABLE public.fund_payout_coverage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public payout coverage read access" ON public.fund_payout_coverage;
CREATE POLICY "Public payout coverage read access" ON public.fund_payout_coverage
  FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON public.fund_payout_coverage FROM anon, authenticated;
GRANT SELECT ON public.fund_payout_coverage TO anon, authenticated;
GRANT ALL ON public.fund_payout_coverage TO service_role;
COMMENT ON TABLE public.fund_payout_coverage IS
  'Source-report coverage, not a guarantee of MUFAP publication completeness. Pending writes or unresolved Shariah matches must not be presented as complete total returns.';

-- One statement / one MVCC snapshot prevents mixing old payouts with newly
-- verified coverage while the collector is updating the same date range.
CREATE OR REPLACE FUNCTION public.get_fund_return_inputs(p_fund_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB LANGUAGE SQL STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH first_nav AS (
    SELECT fund_id, nav_date, nav FROM public.daily_nav
    WHERE fund_id=p_fund_id AND nav_date<=p_from ORDER BY nav_date DESC LIMIT 1
  ), last_nav AS (
    SELECT fund_id, nav_date, nav FROM public.daily_nav
    WHERE fund_id=p_fund_id AND nav_date<=p_to ORDER BY nav_date DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'navRecords', COALESCE((SELECT jsonb_agg(n ORDER BY nav_date) FROM
      (SELECT * FROM first_nav UNION SELECT * FROM last_nav) n), '[]'::jsonb),
    'payouts', COALESCE((SELECT jsonb_agg(p ORDER BY payout_date) FROM
      (SELECT fund_id,payout_date,payout_per_unit,ex_nav FROM public.fund_payouts
       WHERE fund_id=p_fund_id AND payout_date>(SELECT nav_date FROM first_nav)
       AND payout_date<=(SELECT nav_date FROM last_nav)) p), '[]'::jsonb),
    'coverage', COALESCE((SELECT jsonb_agg(c ORDER BY date_from,date_to) FROM
      (SELECT fund_id,date_from,date_to,status,checked_at FROM public.fund_payout_coverage
       WHERE fund_id=p_fund_id AND date_from<=(SELECT nav_date FROM last_nav)
       AND date_to>=(SELECT nav_date FROM first_nav)) c), '[]'::jsonb)
  );
$$;
REVOKE ALL ON FUNCTION public.get_fund_return_inputs(UUID,DATE,DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fund_return_inputs(UUID,DATE,DATE) TO anon,authenticated,service_role;
COMMIT;
