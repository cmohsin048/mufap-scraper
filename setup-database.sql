-- ==================== AMCs Table ====================
CREATE TABLE IF NOT EXISTS amcs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amc_id UUID UNIQUE NOT NULL,
  amc_name TEXT NOT NULL,
  total_funds INTEGER DEFAULT 0,
  shariah_funds_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_amcs_amc_id ON amcs(amc_id);
CREATE INDEX IF NOT EXISTS idx_amcs_name ON amcs(amc_name);

-- ==================== Funds Table ====================
CREATE TABLE IF NOT EXISTS funds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID UNIQUE NOT NULL,
  amc_id UUID REFERENCES amcs(amc_id) ON DELETE CASCADE,
  fund_name TEXT NOT NULL,
  fund_code TEXT,
  fund_type INTEGER,
  category_id INTEGER,
  category_name TEXT,
  pricing_mechanism TEXT,
  is_shariah_compliant BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funds_fund_id ON funds(fund_id);
CREATE INDEX IF NOT EXISTS idx_funds_amc_id ON funds(amc_id);
CREATE INDEX IF NOT EXISTS idx_funds_shariah ON funds(is_shariah_compliant);
CREATE INDEX IF NOT EXISTS idx_funds_category ON funds(category_id);

-- ==================== Fund Categories Table ====================
CREATE TABLE IF NOT EXISTS fund_categories (
  id SERIAL PRIMARY KEY,
  category_id INTEGER UNIQUE NOT NULL,
  category_name TEXT NOT NULL,
  is_shariah_compliant BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_shariah ON fund_categories(is_shariah_compliant);

-- ==================== Enable Row Level Security (Optional) ====================
ALTER TABLE amcs ENABLE ROW LEVEL SECURITY;
ALTER TABLE funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_categories ENABLE ROW LEVEL SECURITY;

-- Allow public read access (adjust based on your needs)
DROP POLICY IF EXISTS "Allow public read access on amcs" ON amcs;
CREATE POLICY "Allow public read access on amcs" 
  ON amcs FOR SELECT 
  USING (true);

DROP POLICY IF EXISTS "Allow public read access on funds" ON funds;
CREATE POLICY "Allow public read access on funds" 
  ON funds FOR SELECT 
  USING (true);

DROP POLICY IF EXISTS "Allow public read access on fund_categories" ON fund_categories;
CREATE POLICY "Allow public read access on fund_categories" 
  ON fund_categories FOR SELECT 
  USING (true);

-- Allow service role full access (your backend)
DROP POLICY IF EXISTS "Allow service role full access on amcs" ON amcs;
CREATE POLICY "Allow service role full access on amcs" 
  ON amcs FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "Allow service role full access on funds" ON funds;
CREATE POLICY "Allow service role full access on funds" 
  ON funds FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "Allow service role full access on fund_categories" ON fund_categories;
CREATE POLICY "Allow service role full access on fund_categories" 
  ON fund_categories FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- ==================== Helper Functions ====================
-- Function to update AMC stats
CREATE OR REPLACE FUNCTION update_amc_stats()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE amcs
  SET 
    total_funds = (
      SELECT COUNT(*) 
      FROM funds 
      WHERE amc_id = NEW.amc_id
    ),
    shariah_funds_count = (
      SELECT COUNT(*) 
      FROM funds 
      WHERE amc_id = NEW.amc_id 
      AND is_shariah_compliant = TRUE
    ),
    updated_at = NOW()
  WHERE amc_id = NEW.amc_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update AMC stats
DROP TRIGGER IF EXISTS trigger_update_amc_stats ON funds;
CREATE TRIGGER trigger_update_amc_stats
AFTER INSERT OR UPDATE ON funds
FOR EACH ROW
EXECUTE FUNCTION update_amc_stats();


-- ==================== Daily NAV Table ====================
CREATE TABLE IF NOT EXISTS daily_nav (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL REFERENCES funds(fund_id) ON DELETE CASCADE,
  amc_id UUID NOT NULL REFERENCES amcs(amc_id) ON DELETE CASCADE,
  nav_date DATE NOT NULL,
  nav DECIMAL(15, 4),
  offer_price DECIMAL(15, 4),
  repurchase_price DECIMAL(15, 4),
  front_end_load DECIMAL(5, 2) DEFAULT 0,
  back_end_load DECIMAL(5, 2) DEFAULT 0,
  contingent_load DECIMAL(5, 2) DEFAULT 0,
  market_value DECIMAL(20, 4) DEFAULT 0,
  inception_date DATE,
  category TEXT,
  trustee TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fund_id, nav_date)
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_nav_fund_date ON daily_nav(fund_id, nav_date DESC);
CREATE INDEX IF NOT EXISTS idx_nav_date ON daily_nav(nav_date DESC);
CREATE INDEX IF NOT EXISTS idx_nav_amc ON daily_nav(amc_id);
CREATE INDEX IF NOT EXISTS idx_nav_fund ON daily_nav(fund_id);
CREATE INDEX IF NOT EXISTS idx_nav_fund_date_range ON daily_nav(fund_id, nav_date DESC, nav);

-- ==================== Fund Progress Tracking ====================
CREATE TABLE IF NOT EXISTS nav_collection_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL REFERENCES funds(fund_id) ON DELETE CASCADE,
  amc_id UUID NOT NULL REFERENCES amcs(amc_id) ON DELETE CASCADE,
  last_collected_date DATE,
  total_records INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fund_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_status ON nav_collection_progress(status);
CREATE INDEX IF NOT EXISTS idx_progress_fund ON nav_collection_progress(fund_id);

-- ==================== Enable RLS for NAV tables ====================
ALTER TABLE daily_nav ENABLE ROW LEVEL SECURITY;
ALTER TABLE nav_collection_progress ENABLE ROW LEVEL SECURITY;

-- Allow public read access (adjust based on your needs)
DROP POLICY IF EXISTS "Allow public read access on daily_nav" ON daily_nav;
CREATE POLICY "Allow public read access on daily_nav"
  ON daily_nav FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Allow public read access on nav_collection_progress" ON nav_collection_progress;
CREATE POLICY "Allow public read access on nav_collection_progress"
  ON nav_collection_progress FOR SELECT
  USING (true);

-- Allow service role full access (backend)
DROP POLICY IF EXISTS "Allow service role full access on daily_nav" ON daily_nav;
CREATE POLICY "Allow service role full access on daily_nav"
  ON daily_nav FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "Allow service role full access on nav_collection_progress" ON nav_collection_progress;
CREATE POLICY "Allow service role full access on nav_collection_progress"
  ON nav_collection_progress FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- ==================== Helper Function: Update Fund NAV Stats ====================
CREATE OR REPLACE FUNCTION update_fund_nav_stats()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO nav_collection_progress (fund_id, amc_id, last_collected_date, total_records, status, updated_at)
  VALUES (
    NEW.fund_id,
    NEW.amc_id,
    NEW.nav_date,
    1,
    'completed',
    NOW()
  )
  ON CONFLICT (fund_id)
  DO UPDATE SET
    last_collected_date = GREATEST(nav_collection_progress.last_collected_date, NEW.nav_date),
    total_records = nav_collection_progress.total_records + 1,
    status = 'completed',
    completed_at = NOW(),
    updated_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update progress
DROP TRIGGER IF EXISTS trigger_update_nav_stats ON daily_nav;
CREATE TRIGGER trigger_update_nav_stats
AFTER INSERT ON daily_nav
FOR EACH ROW
EXECUTE FUNCTION update_fund_nav_stats();

-- ==================== Views ====================
CREATE OR REPLACE VIEW latest_nav
WITH (security_invoker = true) AS
SELECT DISTINCT ON (fund_id)
  fund_id,
  amc_id,
  nav_date,
  nav,
  offer_price,
  repurchase_price
FROM daily_nav
ORDER BY fund_id, nav_date DESC;

CREATE OR REPLACE VIEW fund_performance
WITH (security_invoker = true) AS
SELECT 
  f.fund_id,
  f.fund_name,
  f.category_name,
  a.amc_name,
  COUNT(dn.id) as total_nav_records,
  MIN(dn.nav_date) as earliest_data,
  MAX(dn.nav_date) as latest_data,
  MIN(dn.nav) as min_nav,
  MAX(dn.nav) as max_nav,
  AVG(dn.nav) as avg_nav
FROM funds f
JOIN amcs a ON f.amc_id = a.amc_id
LEFT JOIN daily_nav dn ON f.fund_id = dn.fund_id
WHERE f.is_shariah_compliant = true
GROUP BY f.fund_id, f.fund_name, f.category_name, a.amc_name;
