/**
 * Test queries to verify data collection
 * Run: node test-queries.js
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function runTests() {
  console.log('\n🧪 Running Data Verification Tests\n');
  console.log('='.repeat(60));

  try {
    // Test 1: Count AMCs
    console.log('\n1️⃣ Total AMCs:');
    const { data: amcs, error: amcError } = await supabase
      .from('amcs')
      .select('*', { count: 'exact' });

    if (amcError) throw amcError;
    console.log(`   ✅ ${amcs.length} AMCs in database`);

    // Test 2: Count Shariah Funds
    console.log('\n2️⃣ Total Shariah-Compliant Funds:');
    const { data: funds, error: fundsError, count } = await supabase
      .from('funds')
      .select('*', { count: 'exact' })
      .eq('is_shariah_compliant', true);

    if (fundsError) throw fundsError;
    console.log(`   ✅ ${count} Shariah-compliant funds found`);

    // Test 3: Funds by Category
    console.log('\n3️⃣ Shariah Funds by Category:');
    const { data: categories, error: catError } = await supabase
      .from('funds')
      .select('category_name')
      .eq('is_shariah_compliant', true);

    if (catError) throw catError;

    const categoryCounts = categories.reduce((acc, fund) => {
      acc[fund.category_name] = (acc[fund.category_name] || 0) + 1;
      return acc;
    }, {});

    Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        console.log(`   • ${cat}: ${count} funds`);
      });

    // Test 4: Top AMCs by Shariah Funds
    console.log('\n4️⃣ Top AMCs by Shariah-Compliant Funds:');
    const { data: topAmcs, error: topError } = await supabase
      .from('amcs')
      .select('amc_name, shariah_funds_count')
      .order('shariah_funds_count', { ascending: false })
      .limit(5);

    if (topError) throw topError;

    topAmcs.forEach((amc, idx) => {
      console.log(`   ${idx + 1}. ${amc.amc_name}: ${amc.shariah_funds_count} funds`);
    });

    // Test 5: Sample Funds from Meezan
    console.log('\n5️⃣ Sample Meezan Shariah Funds:');
    const { data: meezanFunds, error: meezanError } = await supabase
      .from('funds')
      .select('fund_name, category_name')
      .ilike('fund_name', '%Meezan%')
      .eq('is_shariah_compliant', true)
      .limit(5);

    if (meezanError) throw meezanError;

    meezanFunds.forEach(fund => {
      console.log(`   • ${fund.fund_name.trim()}`);
      console.log(`     Category: ${fund.category_name}`);
    });

    // Test 6: Fund Types Distribution
    console.log('\n6️⃣ Fund Types Distribution:');
    const { data: fundTypes, error: typeError } = await supabase
      .from('funds')
      .select('fund_type')
      .eq('is_shariah_compliant', true);

    if (typeError) throw typeError;

    const typeCounts = fundTypes.reduce((acc, fund) => {
      const type = fund.fund_type || 'Unknown';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});

    const typeNames = {
      1: 'Open-End Scheme',
      2: 'Exchange Traded Fund',
      3: 'Pension Fund',
      4: 'Dedicated Fund'
    };

    Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        const typeName = typeNames[type] || `Type ${type}`;
        console.log(`   • ${typeName}: ${count} funds`);
      });

    // Test 7: Verify Data Freshness
    console.log('\n7️⃣ Data Freshness:');
    const { data: latest, error: latestError } = await supabase
      .from('amcs')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (latestError) throw latestError;

    const lastUpdate = new Date(latest.updated_at);
    const now = new Date();
    const hoursSince = ((now - lastUpdate) / (1000 * 60 * 60)).toFixed(1);

    console.log(`   Last update: ${lastUpdate.toLocaleString()}`);
    console.log(`   Time since: ${hoursSince} hours ago`);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ All Tests Passed!');
    console.log('='.repeat(60));
    console.log('\n📊 Summary:');
    console.log(`   • ${amcs.length} Asset Management Companies`);
    console.log(`   • ${count} Shariah-Compliant Funds`);
    console.log(`   • ${Object.keys(categoryCounts).length} Different Categories`);
    console.log(`   • Data is ${hoursSince} hours old`);
    console.log('\n');

  } catch (error) {
    console.error('\n❌ Test Failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Additional utility functions
async function searchFunds(query) {
  console.log(`\n🔍 Searching for: "${query}"\n`);

  const { data, error } = await supabase
    .from('funds')
    .select(`
      fund_name,
      category_name,
      amcs (amc_name)
    `)
    .eq('is_shariah_compliant', true)
    .or(`fund_name.ilike.%${query}%,category_name.ilike.%${query}%`);

  if (error) {
    console.error('Error:', error.message);
    return;
  }

  if (data.length === 0) {
    console.log('No results found.');
    return;
  }

  data.forEach((fund, idx) => {
    console.log(`${idx + 1}. ${fund.fund_name.trim()}`);
    console.log(`   AMC: ${fund.amcs.amc_name}`);
    console.log(`   Category: ${fund.category_name}\n`);
  });
}

async function getFundsByCategory(category) {
  console.log(`\n📁 Funds in category: "${category}"\n`);

  const { data, error } = await supabase
    .from('funds')
    .select(`
      fund_name,
      amcs (amc_name)
    `)
    .eq('is_shariah_compliant', true)
    .ilike('category_name', `%${category}%`)
    .order('fund_name');

  if (error) {
    console.error('Error:', error.message);
    return;
  }

  if (data.length === 0) {
    console.log('No funds found in this category.');
    return;
  }

  console.log(`Found ${data.length} funds:\n`);
  data.forEach((fund, idx) => {
    console.log(`${idx + 1}. ${fund.fund_name.trim()}`);
    console.log(`   by ${fund.amcs.amc_name}\n`);
  });
}

// Command-line interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing environment variables!');
    console.log('Make sure .env file has SUPABASE_URL and SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  switch (command) {
    case 'search':
      if (!args[1]) {
        console.log('Usage: node test-queries.js search <query>');
        console.log('Example: node test-queries.js search equity');
        return;
      }
      await searchFunds(args[1]);
      break;

    case 'category':
      if (!args[1]) {
        console.log('Usage: node test-queries.js category <category>');
        console.log('Example: node test-queries.js category equity');
        return;
      }
      await getFundsByCategory(args[1]);
      break;

    default:
      await runTests();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { searchFunds, getFundsByCategory };