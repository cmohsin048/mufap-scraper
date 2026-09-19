/**
 * MUFAP Shariah Compliant Funds Data Collector
 * Stores AMCs and their Shariah-compliant funds in Supabase
 * 
 * Installation:
 * npm install @supabase/supabase-js axios dotenv
 */

const { createClient } = require('@supabase/supabase-js');
const { MufapClient } = require('./mufap-client');
const { isShariahCategory } = require('./payout-catalog');
require('dotenv').config();

class ShariahFundsCollector {
  constructor(supabaseUrl, supabaseKey) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.mufapBaseUrl = 'https://www.mufap.com.pk';
    this.mufap = new MufapClient();
    this.stats = {
      totalAmcs: 0,
      totalFunds: 0,
      shariahFunds: 0,
      errors: []
    };
  }

  /**
   * Initialize database tables in Supabase
   * Run this SQL in Supabase SQL Editor first!
   */
  async setupDatabase() {
    console.log('\n📋 Database Setup Instructions:');
    console.log('Run this SQL in your Supabase SQL Editor:\n');
    console.log(`
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

CREATE INDEX idx_amcs_amc_id ON amcs(amc_id);
CREATE INDEX idx_amcs_name ON amcs(amc_name);

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

CREATE INDEX idx_funds_fund_id ON funds(fund_id);
CREATE INDEX idx_funds_amc_id ON funds(amc_id);
CREATE INDEX idx_funds_shariah ON funds(is_shariah_compliant);
CREATE INDEX idx_funds_category ON funds(category_id);

-- ==================== Fund Categories Table ====================
CREATE TABLE IF NOT EXISTS fund_categories (
  id SERIAL PRIMARY KEY,
  category_id INTEGER UNIQUE NOT NULL,
  category_name TEXT NOT NULL,
  is_shariah_compliant BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_categories_shariah ON fund_categories(is_shariah_compliant);

-- ==================== Enable Row Level Security (Optional) ====================
ALTER TABLE amcs ENABLE ROW LEVEL SECURITY;
ALTER TABLE funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_categories ENABLE ROW LEVEL SECURITY;

-- Allow public read access (adjust based on your needs)
CREATE POLICY "Allow public read access on amcs" 
  ON amcs FOR SELECT 
  USING (true);

CREATE POLICY "Allow public read access on funds" 
  ON funds FOR SELECT 
  USING (true);

CREATE POLICY "Allow public read access on fund_categories" 
  ON fund_categories FOR SELECT 
  USING (true);

-- Allow service role full access (your backend)
CREATE POLICY "Allow service role full access on amcs" 
  ON amcs FOR ALL 
  USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access on funds" 
  ON funds FOR ALL 
  USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access on fund_categories" 
  ON fund_categories FOR ALL 
  USING (auth.role() = 'service_role');

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
CREATE TRIGGER trigger_update_amc_stats
AFTER INSERT OR UPDATE ON funds
FOR EACH ROW
EXECUTE FUNCTION update_amc_stats();
    `);
    console.log('\n✅ Copy and run the above SQL in Supabase SQL Editor\n');
  }

  /**
   * Fetch all AMCs from MUFAP
   */
  async fetchAllAmcs() {
    try {
      console.log('📡 Fetching AMCs from MUFAP...');
      const response = { data: { statusCode: '00', data:
        await this.mufap.postJson(`${this.mufapBaseUrl}/AMC/GetAMCList`) } };

      if (response.data.statusCode === '00') {
        const amcs = response.data.data;
        console.log(`✅ Found ${amcs.length} AMCs`);
        this.stats.totalAmcs = amcs.length;
        return amcs;
      } else {
        throw new Error(response.data.message);
      }
    } catch (error) {
      console.error('❌ Error fetching AMCs:', error.message);
      this.stats.errors.push({ operation: 'fetchAmcs', error: error.message });
      return [];
    }
  }

  /**
   * Fetch funds for a specific AMC
   */
  async fetchFundsForAmc(amcId) {
    try {
      const response = { data: { statusCode: '00', data: await this.mufap.postJson(
        `${this.mufapBaseUrl}/TopHolding/GetFundNameByAMC`, { AMCId: amcId }) } };

      if (response.data.statusCode === '00') {
        return response.data.data || [];
      } else {
        console.warn(`⚠️  No funds found for AMC: ${amcId}`);
        return [];
      }
    } catch (error) {
      console.error(`❌ Error fetching funds for AMC ${amcId}:`, error.message);
      this.stats.errors.push({ operation: 'fetchFunds', amcId, error: error.message });
      return [];
    }
  }

  /**
   * Check if a fund is Shariah compliant
   */
  isShariahCompliant(categoryDesc) {
    return isShariahCategory(categoryDesc);
  }

  /**
   * Store AMC in Supabase
   */
  async storeAmc(amc) {
    try {
      const { data, error } = await this.supabase
        .from('amcs')
        .upsert({
          amc_id: amc.AMCId,
          amc_name: amc.AMC_Desc.trim(),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'amc_id',
          returning: 'minimal'
        });

      if (error) throw error;
      return true;
    } catch (error) {
      console.error(`❌ Error storing AMC ${amc.AMC_Desc}:`, error.message);
      this.stats.errors.push({ operation: 'storeAmc', amc: amc.AMC_Desc, error: error.message });
      return false;
    }
  }

  /**
   * Store funds in Supabase (Shariah compliant only)
   */
  async storeFunds(amcId, funds) {
    try {
      // Filter only Shariah compliant funds
      const shariahFunds = funds.filter(fund => 
        this.isShariahCompliant(fund.Cat_Desc)
      );

      if (shariahFunds.length === 0) {
        console.log(`  ℹ️  No Shariah-compliant funds found`);
        return 0;
      }

      const fundsToInsert = shariahFunds.map(fund => ({
        fund_id: fund.FundID,
        amc_id: amcId,
        fund_name: fund.Fund_Desc.trim(),
        fund_type: fund.fund_type,
        category_id: fund.CatId,
        category_name: fund.Cat_Desc.trim(),
        pricing_mechanism: fund.PricingMechanism,
        is_shariah_compliant: true,
        updated_at: new Date().toISOString()
      }));

      // Insert in batches to avoid payload size issues
      const batchSize = 50;
      let insertedCount = 0;

      for (let i = 0; i < fundsToInsert.length; i += batchSize) {
        const batch = fundsToInsert.slice(i, i + batchSize);
        
        const { data, error } = await this.supabase
          .from('funds')
          .upsert(batch, {
            onConflict: 'fund_id',
            returning: 'minimal'
          });

        if (error) {
          console.error(`❌ Error in batch ${i / batchSize + 1}:`, error.message);
          this.stats.errors.push({ 
            operation: 'storeFunds', 
            batch: i / batchSize + 1, 
            error: error.message 
          });
        } else {
          insertedCount += batch.length;
        }
      }

      // Store unique categories
      await this.storeCategories(shariahFunds);

      this.stats.totalFunds += funds.length;
      this.stats.shariahFunds += shariahFunds.length;

      return insertedCount;
    } catch (error) {
      console.error(`❌ Error storing funds:`, error.message);
      this.stats.errors.push({ operation: 'storeFunds', error: error.message });
      return 0;
    }
  }

  /**
   * Store fund categories
   */
  async storeCategories(funds) {
    try {
      const uniqueCategories = [...new Map(
        funds.map(fund => [fund.CatId, {
          category_id: fund.CatId,
          category_name: fund.Cat_Desc.trim(),
          is_shariah_compliant: this.isShariahCompliant(fund.Cat_Desc)
        }])
      ).values()];

      if (uniqueCategories.length === 0) return;

      const { error } = await this.supabase
        .from('fund_categories')
        .upsert(uniqueCategories, {
          onConflict: 'category_id',
          returning: 'minimal'
        });

      if (error) {
        console.error('❌ Error storing categories:', error.message);
      }
    } catch (error) {
      console.error('❌ Error in storeCategories:', error.message);
    }
  }

  /**
   * Add delay to be respectful to the server
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Main collection process
   */
  async collectAllData() {
    console.log('\n' + '='.repeat(60));
    console.log('🕌 MUFAP Shariah Compliant Funds Collector');
    console.log('='.repeat(60) + '\n');

    const startTime = Date.now();

    // Step 1: Fetch all AMCs
    const amcs = await this.fetchAllAmcs();
    if (amcs.length === 0) {
      console.error('❌ No AMCs found. Exiting.');
      return;
    }

    console.log('\n📥 Storing data in Supabase...\n');

    // Step 2: Process each AMC
    for (let i = 0; i < amcs.length; i++) {
      const amc = amcs[i];
      const progress = `[${i + 1}/${amcs.length}]`;

      console.log(`\n${progress} ${amc.AMC_Desc}`);

      // Store AMC
      await this.storeAmc(amc);

      // Fetch and store funds
      console.log(`  📡 Fetching funds...`);
      const funds = await this.fetchFundsForAmc(amc.AMCId);

      if (funds.length > 0) {
        const shariahCount = await this.storeFunds(amc.AMCId, funds);
        console.log(`  ✅ Stored ${shariahCount} Shariah-compliant funds (out of ${funds.length} total)`);
      } else {
        console.log(`  ℹ️  No funds found`);
      }

      // Be respectful - delay between requests
      await this.delay(1000);
    }

    // Final statistics
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n' + '='.repeat(60));
    console.log('✅ Collection Complete!');
    console.log('='.repeat(60));
    console.log(`⏱️  Duration: ${duration}s`);
    console.log(`📊 Statistics:`);
    console.log(`   - Total AMCs: ${this.stats.totalAmcs}`);
    console.log(`   - Total Funds: ${this.stats.totalFunds}`);
    console.log(`   - Shariah-Compliant Funds: ${this.stats.shariahFunds}`);
    console.log(`   - Errors: ${this.stats.errors.length}`);
    
    if (this.stats.errors.length > 0) {
      console.log('\n⚠️  Errors encountered:');
      this.stats.errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. ${err.operation}: ${err.error}`);
      });
    }

    console.log('\n🎉 Data collection successful!');
    console.log('='.repeat(60) + '\n');
  }

  /**
   * Query helper functions
   */
  async getShariahFundsByAmc(amcName) {
    const { data, error } = await this.supabase
      .from('funds')
      .select(`
        *,
        amcs (amc_name)
      `)
      .eq('is_shariah_compliant', true)
      .ilike('amcs.amc_name', `%${amcName}%`);

    if (error) {
      console.error('Error fetching funds:', error);
      return [];
    }
    return data;
  }

  async getAllShariahCategories() {
    const { data, error } = await this.supabase
      .from('fund_categories')
      .select('*')
      .eq('is_shariah_compliant', true)
      .order('category_name');

    if (error) {
      console.error('Error fetching categories:', error);
      return [];
    }
    return data;
  }
}

// ==================== Main Execution ====================
async function main() {
  // Load environment variables
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service key for admin operations

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('\n❌ Missing environment variables!');
    console.log('\nCreate a .env file with:');
    console.log('SUPABASE_URL=your_supabase_url');
    console.log('SUPABASE_SERVICE_KEY=your_supabase_service_key\n');
    process.exit(1);
  }

  const collector = new ShariahFundsCollector(SUPABASE_URL, SUPABASE_KEY);

  if (process.argv[2] === 'setup') { await collector.setupDatabase(); return; }
  try {
    await collector.collectAllData();
    if (collector.stats.errors.length) process.exitCode = 1;
  } finally { await collector.mufap.close(); }

  // Example queries
  console.log('\n📖 Example Queries:');
  console.log(`
const categories = await collector.getAllShariahCategories();
console.log('Shariah Categories:', categories);

const meezan = await collector.getShariahFundsByAmc('Meezan');
console.log('Meezan Shariah Funds:', meezan);
  `);
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = ShariahFundsCollector;
