const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseProfileText, parseInceptionDate } = require('../fund-profile-collector');
const { documentMonth, uploadMonth, classifyLink, buildMatcher, isShariahText } = require('../document-text');
const { selectCandidates, dedupePerFund, parseRobots } = require('../document-collector');

const PROFILE = `786 Smart Fund
Open-End Funds Shariah Compliant Income
Inception Date: May 20, 2003
Fund Information
Front-End Load:
0%
Management Fee:
N/A
Risk Profile:
Medium
Trustee:
Central Depository Company of Pakistan Ltd (CDC)
Rating:
AA-(f)
Fund Manager:
Ali Khan
Asset Allocation(PKR millions) as of September-2026
Net Assets:
1,328.00
Net Assets (excluding FoFs):
N/A
Fund Returns
Tenure\tReturns
YTD\t10.5%
1 Month\t-4.03%
1 Year\tN/A
Top 10 Holdings
Data Not Found
Expense Ratio
Total Expense Ratio (TER-YTD %):
2.08%
Selling And Marketing (S&M %):
0%`;

test('MUFAP profile text parses labels, numbers, returns and hides N/A', () => {
  const p = parseProfileText(PROFILE, [{ asset: 'Cash', pkr_mn: 10 }]);
  assert.equal(p.inception_date, '2003-05-20');
  assert.equal(p.risk_profile, 'Medium');
  assert.equal(p.front_end_load, '0%');
  assert.equal(p.management_fee, null);
  assert.equal(p.trustee, 'Central Depository Company of Pakistan Ltd (CDC)');
  assert.equal(p.fund_manager, 'Ali Khan');
  assert.equal(p.net_assets_pkr_mn, 1328);
  assert.equal(p.net_assets_ex_fof_pkr_mn, null);
  assert.equal(p.ter_ytd_pct, 2.08);
  assert.equal(p.selling_marketing_pct, 0);
  assert.deepEqual(p.returns, { YTD: 10.5, '1 Month': -4.03 });
  assert.equal(p.asset_allocation_as_of, 'September-2026');
  assert.deepEqual(p.asset_allocation, [{ asset: 'Cash', pkr_mn: 10 }]);
  assert.equal(parseInceptionDate('Inception Date: Sometime'), null);
});

test('document months come from link text or file names in many spellings', () => {
  assert.equal(documentMonth('Fund Manager Report - August 2026'), '2026-08-01');
  assert.equal(documentMonth('fmr_2026_aug.pdf'), '2026-08-01');
  assert.equal(documentMonth('JSIL_FMR_JAN_2026-6.pdf'), '2026-01-01');
  assert.equal(documentMonth('fmr_dec-06.pdf'), '2006-12-01');
  assert.equal(documentMonth("Fund Manager's Report - December,2025"), '2025-12-01');
  assert.equal(documentMonth('Consolidated offering document'), null);
  assert.equal(uploadMonth('https://x.com/wp-content/uploads/2026/09/FMR.pdf'), '2026-09-01');
});

test('links are classified by type; forms, deeds, conventional and non-PDFs are dropped', () => {
  const c = (text, href = 'https://x/a.pdf', page = 'offering') => classifyLink({ text, href }, page);
  assert.equal(c('Key Fact Statement - Meezan Cash Fund'), 'key_fact_statement');
  assert.equal(c('3rd Supplemental Offering Document'), 'supplemental_offering_document');
  assert.equal(c('MAAF Consolidated Offering Document', 'https://x/MAAF-Consolidated-OD-till-9th-SOD.pdf'), 'offering_document');
  assert.equal(c('Trust Deed of PQISF'), null);
  assert.equal(c('Account Opening Form'), null);
  assert.equal(c('Conventional FMR August 2026', undefined, 'fmr'), null);
  assert.equal(c('KFS', 'https://x/Key-Fact-Statement.docx', 'kfs'), null);
  assert.equal(c('Download', 'https://x/FMR-August-2026.pdf', 'fmr'), 'fmr');
  assert.equal(c('Fund Manager Report - July 2026', 'button:x#0', 'fmr'), 'fmr');
});

test('fund matcher prefers longest names, uses unique plan variants, and refuses ambiguous ones', () => {
  const funds = [
    { fund_id: 'mif', fund_name: 'Meezan Islamic Fund' }, { fund_id: 'miif', fund_name: 'Meezan Islamic Income Fund' },
    { fund_id: 'mmmp', fund_name: 'Meezan Daily Income Fund (Meezan Mahana Munafa Plan)' }, { fund_id: 'mdip', fund_name: 'Meezan Daily Income Fund (MDIP I)' },
    { fund_id: 'aicf', fund_name: 'AKD Islamic Cash Fund (Formerly: AKD Islamic Daily Dividend Fund)' },
  ];
  const match = buildMatcher(funds);
  const ids = text => match(text).map(f => f.fund_id).sort();
  assert.deepEqual(ids('Fund Manager Report MEEZAN ISLAMIC INCOME FUND (MIIF)'), ['miif']);
  assert.deepEqual(ids('Meezan Islamic Fund and Meezan Islamic Income Fund'), ['mif', 'miif']);
  assert.deepEqual(ids('KFS Meezan Mahana Munafa Plan'), ['mmmp']);
  assert.deepEqual(ids('Meezan Daily Income Fund overview'), [], 'shared family name matches no single plan');
  assert.deepEqual(ids('AKD Islamic Cash Fund (Formerly: AKD Islamic Daily Dividend Fund) Fund Manager Comments'), ['aicf']);
  assert.equal(isShariahText('Alhamra Islamic Stock Fund'), true);
  assert.equal(isShariahText('Al-Ameen Islamic FMR'), true);
  assert.equal(isShariahText('MCB Cash Management Optimizer'), false);
});

test('robots rules apply to the * group with longest-match Allow overrides', () => {
  const rules = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n#Disallow: /\n');
  assert.deepEqual(rules, [{ path: '/wp-admin/', allow: false }, { path: '/wp-admin/admin-ajax.php', allow: true }]);
});

test('selection keeps the newest FMR (Islamic edition) and newest documents per fund', () => {
  const fmr = (date, text) => ({ docType: 'fmr', date, text, href: `${text}-${date}`, nameHits: [] });
  const picked = selectCandidates([fmr('2026-07-01', 'FMR Islamic'), fmr('2026-08-01', 'FMR Islamic'), fmr('2026-08-01', 'FMR Conventional'),
    { docType: 'offering_document', text: 'UBL Cash Fund OD', href: 'u', nameHits: [] }, { docType: 'offering_document', text: 'Al-Ameen OD', href: 'a', nameHits: [] }], { allShariah: false });
  assert.deepEqual(picked.map(p => p.href), ['FMR Islamic-2026-08-01', 'a']);
  const doc = (url, type, date, fund) => ({ source_url: url, doc_type: type, document_date: date, title: url, funds: [{ fund_id: fund }] });
  const kept = dedupePerFund([doc('s1', 'supplemental_offering_document', '2021-01-01', 'f'), doc('s2', 'supplemental_offering_document', '2022-01-01', 'f'),
    doc('s3', 'supplemental_offering_document', '2023-01-01', 'f'), doc('s4', 'supplemental_offering_document', '2024-01-01', 'f'),
    doc('o1', 'offering_document', '2019-01-01', 'f'), doc('o2', 'offering_document', '2024-01-01', 'f'), doc('fmr', 'fmr', '2026-08-01', 'f')]);
  assert.deepEqual(kept.map(d => d.source_url).sort(), ['fmr', 'o2', 's2', 's3', 's4']);
});

const { layoutText, displayTitle, undouble } = require('../document-text');
// pdf.js text item: transform = [scaleX, skewY, skewX, scaleY, x, y]; y grows upwards.
const item = (str, x, y, width = str.length * 5, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width, height: size });

test('layout text rebuilds rows in reading order, keeps label | value pairs, drops shadow copies', () => {
  const items = [
    item('2.00%', 300, 700), item('Front End Load', 50, 700),          // drawn out of order
    item('Management', 50, 680), item('Fee', 107, 680), item('1.5% p.a.', 300, 680),
    item('Fund Details', 50, 720), item('Fund Details', 50, 720),        // shadow copy
    item('Page 3', 50, 40),
  ];
  assert.equal(layoutText(items), 'Fund Details\nFront End Load | 2.00%\nManagement Fee | 1.5% p.a.\nPage 3');
  assert.equal(layoutText([]), '');
  assert.equal(undouble('Fund ReviewFund Review'), 'Fund Review');
  assert.equal(undouble('Front End Load | 2.00%'), 'Front End Load | 2.00%');
});

test('citation titles name the AMC for FMRs and the fund for single-fund documents', () => {
  assert.equal(displayTitle({ docType: 'fmr', amcName: 'Al Meezan Investment Management Limited', fundNames: ['A', 'B'], date: '2026-08-01' }),
    'Al Meezan · Fund Manager Report · Aug 2026');
  assert.equal(displayTitle({ docType: 'key_fact_statement', amcName: 'UBL Fund Managers Limited', fundNames: ['Al Ameen Shariah Stock Fund'], date: null }),
    'Al Ameen Shariah Stock Fund · Key Fact Statement');
  assert.equal(displayTitle({ docType: 'supplemental_offering_document', amcName: 'NBP Fund Management Limited', fundNames: ['NBP Islamic Stock Fund'],
    date: '2025-03-01', title: 'Download Ninth Supplemental To The Offering Document' }), 'NBP Islamic Stock Fund · Ninth Supplemental Offering Document · Mar 2025');
  assert.equal(displayTitle({ docType: 'fmr', amcName: 'National Investment Trust Limited', fundNames: [] }), 'National Investment Trust · Fund Manager Report');
});
