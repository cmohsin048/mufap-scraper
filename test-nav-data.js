/**
 * Test and verify NAV data collection
 * Run: node test-nav-data.js
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function runTests() {
  console.log('\n🧪 Running NAV Data Verification Tests\n');
  console.log('='.repeat(60));

  try {
    // Test 1: Total NAV Records
    console.log('\n1️⃣ Total NAV Records:');
    const { data: navRecords, error: navError, count } = await supabase
      .from('daily_nav')
      .select('*', { count: 'exact', head: true });

    if (navError) throw navError;
    console.log(`   ✅ ${count?.toLocaleString()} NAV records in database`);

    // Test 2: Collection Progress
    console.log('\n2️⃣ Collection Progress:');
    const { data: progress, error: progressError } = await supabase
      .from('nav_collection_progress')
      .select('status, COUNT(*)', { count: 'exact' });

    if (progressError) throw progressError;

    const statusGroups = {};
    progress.forEach(p => {
      statusGroups[p.status] = (statusGroups[p.status] || 0) + 1;
    });

    Object.entries(statusGroups).forEach(([status, count]) => {
      const emoji = {
        'completed': '✅',
        'in_progress': '⏳',
        'error': '❌',
        'pending': '⏸️'
      }[status] || '❓';
      console.log(`   ${emoji} ${status}: ${count} funds`);
    });

    // Test 3: Date Coverage
    console.log('\n3️⃣ Date Coverage:');
    const { data: dateRange, error: dateError } = await supabase
      .from('daily_nav')
      .select('nav_date')
      .order('nav_date', { ascending: true })
      .limit(1);

    const { data: latestDate } = await supabase
      .from('daily_nav')
      .select('nav_date')
      .order('nav_date', { ascending: false })
      .limit(1);

    if (dateError) throw dateError;

    if (dateRange && dateRange.length > 0) {
      console.log(`   📅 Earliest data: ${dateRange[0].nav_date}`);
      console.log(`   📅 Latest data: ${latestDate[0].nav_date}`);
      
      const earliest = new Date(dateRange[0].nav_date);
      const latest = new Date(latestDate[0].nav_date);
      const years = (latest - earliest) / (1000 * 60 * 60 * 24 * 365);
      console.log(`   📊 Coverage: ${years.toFixed(1)} years`);
    }

    // Test 4: Top Funds by Data Points
    console.log('\n4️⃣ Top 10 Funds by Data Points:');
    const { data: topFunds, error: topError } = await supabase
      .rpc('get_top_funds_by_data_points', { limit_count: 10 });

    if (topError) {
      // Fallback query if RPC doesn't exist
      const { data: fundStats } = await supabase
        .from('daily_nav')
        .select('fund_id, funds(fund_name)')
        .limit(1000);

      if (fundStats) {
        const counts = {};
        fundStats.forEach(record => {
          const fundName = record.funds?.fund_name || 'Unknown';
          counts[fundName] = (counts[fundName] || 0) + 1;
        });

        const sorted = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        sorted.forEach(([name, count], idx) => {
          console.log(`   ${idx + 1}. ${name}: ${count} records`);
        });
      }
    } else if (topFunds) {
      topFunds.forEach((fund, idx) => {
        console.log(`   ${idx + 1}. ${fund.fund_name}: ${fund.record_count} records`);
      });
    }

    // Test 5: Recent NAV Data
    console.log('\n5️⃣ Sample Recent NAV Data:');
    const { data: recentNav, error: recentError } = await supabase
      .from('daily_nav')
      .select(`
        nav_date,
        nav,
        funds(fund_name)
      `)
      .order('nav_date', { ascending: false })
      .limit(5);

    if (recentError) throw recentError;

    recentNav.forEach(record => {
      console.log(`   • ${record.funds.fund_name.trim()}`);
      console.log(`     NAV: ${record.nav} on ${record.nav_date}`);
    });

    // Test 6: Data Quality Check
    console.log('\n6️⃣ Data Quality Checks:');
    
    // Check for null NAVs
    const { data: nullNavs, count: nullCount } = await supabase
      .from('daily_nav')
      .select('*', { count: 'exact', head: true })
      .is('nav', null);

    console.log(`   ${nullCount === 0 ? '✅' : '⚠️'} Null NAVs: ${nullCount}`);

    // Check for negative NAVs
    const { data: negativeNavs, count: negCount } = await supabase
      .from('daily_nav')
      .select('*', { count: 'exact', head: true })
      .lt('nav', 0);

    console.log(`   ${negCount === 0 ? '✅' : '⚠️'} Negative NAVs: ${negCount}`);

    // Check for duplicates
    const { data: duplicates } = await supabase
      .rpc('check_nav_duplicates');

    if (!duplicates) {
      console.log(`   ✅ No duplicate fund-date combinations`);
    }

    // Test 7: Fund with Most History
    console.log('\n7️⃣ Fund with Longest History:');
    const { data: longestHistory } = await supabase
      .from('daily_nav')
      .select(`
        fund_id,
        funds(fund_name, amcs(amc_name))
      `)
      .order('nav_date', { ascending: true })
      .limit(1);

    if (longestHistory && longestHistory.length > 0) {
      const fund = longestHistory[0];
      const { data: fundData } = await supabase
        .from('daily_nav')
        .select('nav_date')
        .eq('fund_id', fund.fund_id)
        .order('nav_date');

      if (fundData && fundData.length > 0) {
        const earliest = fundData[0].nav_date;
        const latest = fundData[fundData.length - 1].nav_date;
        console.log(`   📜 ${fund.funds.fund_name.trim()}`);
        console.log(`      by ${fund.funds.amcs.amc_name}`);
        console.log(`      From: ${earliest}`);
        console.log(`      To: ${latest}`);
        console.log(`      Records: ${fundData.length}`);
      }
    }

    // Test 8: NAV Trends
    console.log('\n8️⃣ NAV Value Ranges:');
    const { data: navRanges } = await supabase
      .from('daily_nav')
      .select('nav');

    if (navRanges) {
      const navs = navRanges.map(r => r.nav).filter(n => n > 0);
      const min = Math.min(...navs);
      const max = Math.max(...navs);
      const avg = navs.reduce((a, b) => a + b, 0) / navs.length;
      
      console.log(`   📊 Minimum NAV: ${min.toFixed(4)}`);
      console.log(`   📊 Maximum NAV: ${max.toFixed(4)}`);
      console.log(`   📊 Average NAV: ${avg.toFixed(4)}`);
    }

    // Test 9: Storage Size Estimate
    console.log('\n9️⃣ Storage Estimate:');
    if (count) {
      const avgRowSize = 200; // bytes (approximate)
      const totalSize = (count * avgRowSize) / (1024 * 1024); // MB
      console.log(`   💾 Estimated size: ${totalSize.toFixed(2)} MB`);
      console.log(`   💾 Average per fund: ${(totalSize / 245).toFixed(2)} MB`);
    }

    // Test 10: Data Freshness
    console.log('\n🔟 Data Freshness:');
    const today = new Date().toISOString().split('T')[0];
    const { data: todayData, count: todayCount } = await supabase
      .from('daily_nav')
      .select('*', { count: 'exact', head: true })
      .eq('nav_date', today);

    console.log(`   📅 Records for today (${today}): ${todayCount || 0}`);

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    const { count: yesterdayCount } = await supabase
      .from('daily_nav')
      .select('*', { count: 'exact', head: true })
      .eq('nav_date', yesterdayStr);

    console.log(`   📅 Records for yesterday: ${yesterdayCount || 0}`);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ All Tests Passed!');
    console.log('='.repeat(60));
    console.log('\n📊 Summary:');
    console.log(`   • ${count?.toLocaleString()} total NAV records`);
    console.log(`   • ${Object.values(statusGroups).reduce((a, b) => a + b, 0)} funds tracked`);
    console.log(`   • ${dateRange && dateRange[0] ? dateRange[0].nav_date : 'N/A'} to ${latestDate && latestDate[0] ? latestDate[0].nav_date : 'N/A'}`);
    console.log(`   • ${(count / 245).toFixed(0)} avg records per fund`);
    console.log('\n');

  } catch (error) {
    console.error('\n❌ Test Failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Additional helper functions
async function getFundHistory(fundName, limit = 30) {
  console.log(`\n📈 NAV History for: "${fundName}"\n`);

  const { data, error } = await supabase
    .from('daily_nav')
    .select(`
      nav_date,
      nav,
      offer_price,
      repurchase_price,
      funds(fund_name, amcs(amc_name))
    `)
    .ilike('funds.fund_name', `%${fundName}%`)
    .order('nav_date', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error:', error.message);
    return;
  }

  if (data.length === 0) {
    console.log('No data found for this fund.');
    return;
  }

  console.log(`Fund: ${data[0].funds.fund_name.trim()}`);
  console.log(`AMC: ${data[0].funds.amcs.amc_name}`);
  console.log(`\nLast ${Math.min(limit, data.length)} NAV entries:\n`);

  data.forEach((record, idx) => {
    console.log(`${idx + 1}. ${record.nav_date}: NAV ${record.nav}`);
  });

  // Calculate returns
  if (data.length >= 2) {
    const latest = data[0].nav;
    const oldest = data[data.length - 1].nav;
    const returns = ((latest - oldest) / oldest * 100).toFixed(2);
    
    console.log(`\n📊 Period Return: ${returns}% (${data[data.length - 1].nav_date} to ${data[0].nav_date})`);
  }
}

async function compareFunds(fund1, fund2) {
  console.log(`\n📊 Comparing Funds:\n`);

  const funds = [fund1, fund2];
  const results = [];

  for (const fundName of funds) {
    const { data } = await supabase
      .from('daily_nav')
      .select(`
        nav_date,
        nav,
        funds(fund_name, amcs(amc_name))
      `)
      .ilike('funds.fund_name', `%${fundName}%`)
      .order('nav_date', { ascending: false })
      .limit(365); // Last year

    if (data && data.length > 0) {
      const latest = data[0].nav;
      const yearAgo = data[data.length - 1].nav;
      const ytdReturn = ((latest - yearAgo) / yearAgo * 100).toFixed(2);

      results.push({
        name: data[0].funds.fund_name.trim(),
        amc: data[0].funds.amcs.amc_name,
        latestNav: latest,
        ytdReturn: ytdReturn,
        dataPoints: data.length
      });
    }
  }

  results.forEach((fund, idx) => {
    console.log(`${idx + 1}. ${fund.name}`);
    console.log(`   AMC: ${fund.amc}`);
    console.log(`   Latest NAV: ${fund.latestNav}`);
    console.log(`   YTD Return: ${fund.ytdReturn}%`);
    console.log(`   Data Points: ${fund.dataPoints}\n`);
  });

  if (results.length === 2) {
    const diff = (parseFloat(results[0].ytdReturn) - parseFloat(results[1].ytdReturn)).toFixed(2);
    console.log(`Performance Difference: ${diff}%`);
    console.log(`${results[0].name} is ${diff > 0 ? 'outperforming' : 'underperforming'} ${results[1].name}\n`);
  }
}

// Command-line interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing environment variables!');
    process.exit(1);
  }

  switch (command) {
    case 'history':
      if (!args[1]) {
        console.log('Usage: node test-nav-data.js history <fund_name>');
        console.log('Example: node test-nav-data.js history "Meezan Islamic"');
        return;
      }
      await getFundHistory(args[1], args[2] ? parseInt(args[2]) : 30);
      break;

    case 'compare':
      if (!args[1] || !args[2]) {
        console.log('Usage: node test-nav-data.js compare <fund1> <fund2>');
        console.log('Example: node test-nav-data.js compare "Meezan Islamic" "HBL Islamic"');
        return;
      }
      await compareFunds(args[1], args[2]);
      break;

    default:
      await runTests();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { getFundHistory, compareFunds };