// Official document listing pages per AMC (amc must equal amcs.amc_name).
// type: fmr | offering (offering docs, supplements, KFS mixed) | kfs | ter
// allShariah: every fund the AMC lists is Shariah compliant, so no keyword filter is needed.
// include: optional regex a link must match (for pages that mix in unrelated PDFs).
// Verified 2026-10-07. When a site is redesigned, update its URLs here; run
// `node document-collector.js --discover <url>` to see what a page links to.
module.exports = [
  { amc: 'Al Meezan Investment Management Limited', allShariah: true, pages: [
    { type: 'fmr', url: 'https://www.almeezangroup.com/download-category/fund-manager-reports/' },
    { type: 'offering', url: 'https://www.almeezangroup.com/download-category/constitutive-documents/' },
    { type: 'kfs', url: 'https://www.almeezangroup.com/download-category/key-fact-statements/' },
  ] },
  // Faysal renders cards with View buttons instead of links; the collector clicks View on selected cards.
  { amc: 'Faysal Asset Management Limited', pages: [
    { type: 'fmr', url: 'https://www.faysalfunds.com/fund-managers-report', buttons: { card: '.certificate-card', title: 'h3', button: 'View' } },
    { type: 'offering', url: 'https://www.faysalfunds.com/offering-document', buttons: { card: '.certificate-card', title: 'h3', button: 'View' } },
    { type: 'kfs', url: 'https://www.faysalfunds.com/key-fact-statements', buttons: { card: '.certificate-card', title: 'h3', button: 'View' } },
    { type: 'ter', url: 'https://www.faysalfunds.com/total-expense-ratio', buttons: { card: '.certificate-card', title: 'h3', button: 'View' } },
  ] },
  { amc: 'NBP Fund Management Limited', pages: [
    { type: 'fmr', url: 'https://www.nbpfunds.com/type/fund-manager-reports/' },
    { type: 'offering', url: 'https://www.nbpfunds.com/type/constitutive-documents/' },
  ] },
  { amc: 'Alfalah Asset Management Limited', pages: [
    { type: 'fmr', url: 'https://alfalahamc.com/downloads/fund-manager-reports/' },
    { type: 'offering', url: 'https://alfalahamc.com/downloads/offering-documents/' },
    { type: 'ter', url: 'https://alfalahamc.com/downloads/expense-ratio/' },
  ] },
  // MCB files FMRs in month folders and offering documents in per-fund folders (Alhamra = its Islamic brand).
  { amc: 'MCB Investment Management Limited', pages: [
    { type: 'fmr', url: 'https://www.mcbfunds.com/downloads-2-2/fund-managers-reports/', follow: { pattern: 'fund-managers-reports/year-\\d{4}/[a-z]+/?$', max: 1 } },
    { type: 'offering', url: 'https://www.mcbfunds.com/downloads-2-2/regulatory-documents-of-the-funds/',
      follow: { pattern: 'regulatory-documents-of-the-funds/[^/]+/(?:consolidated-offering|offering-document)[^/]*/?$', shariahOnly: true, max: 40 } },
    { type: 'kfs', url: 'https://www.mcbfunds.com/downloads-2-2/regulatory-documents-of-the-funds/key-fact-statement/' },
  ] },
  { amc: 'Lucky Investments Limited', pages: [
    { type: 'fmr', url: 'https://luckyinvestments.com.pk/downloads/fund-manager-reports/' },
    { type: 'offering', url: 'https://luckyinvestments.com.pk/downloads/constitutive-documents/' },
    { type: 'kfs', url: 'https://luckyinvestments.com.pk/downloads/key-fact-statements/' },
  ] },
  { amc: 'ABL Asset Management Company Limited', pages: [
    { type: 'fmr', url: 'https://www.ablfunds.com/type/fund-manager-reports' },
    { type: 'offering', url: 'https://www.ablfunds.com/type/offering-documents' },
  ] },
  { amc: 'Atlas Asset Management Limited', pages: [
    { type: 'fmr', url: 'https://www.atlasfunds.com.pk/downloads/fund-manager-reports/' },
    { type: 'offering', url: 'https://www.atlasfunds.com.pk/downloads/offering-documents/' },
    { type: 'kfs', url: 'https://www.atlasfunds.com.pk/downloads/key-fact-statements/' },
  ] },
  { amc: 'HBL Asset Management Limited', pages: [
    { type: 'fmr', url: 'https://hblasset.com/downloadcategories/fund-manager-report/' },
    { type: 'offering', url: 'https://hblasset.com/downloadcategories/constitutive-documents/' },
    { type: 'ter', url: 'https://hblasset.com/downloadcategories/total-expense-ratio/' },
  ] },
  { amc: 'UBL Fund Managers Limited', pages: [
    { type: 'fmr', url: 'https://www.ublfunds.com.pk/download/performance-reports/' },
    { type: 'offering', url: 'https://www.ublfunds.com.pk/download/fund-documents/' },
  ] },
  { amc: 'AL Habib Asset Management Limited', pages: [
    { type: 'fmr', url: 'https://alhabibfunds.com/fmr', include: 'fmr' },
  ] },
  { amc: 'JS Investments Limited', pages: [
    { type: 'fmr', url: 'https://jsil.com/all-downloads/fund-manager-reports/' },
    { type: 'offering', url: 'https://jsil.com/constitutive-documents/' },
    { type: 'kfs', url: 'https://jsil.com/all-downloads/key-fact-statements/' },
  ] },
  { amc: 'Pak-Qatar Asset Management Company Limited', allShariah: true, pages: [
    { type: 'fmr', url: 'https://pqamcl.com/fund-manager-reports/' },
    { type: 'offering', url: 'https://pqamcl.com/constitutive-documents/' },
  ] },
  { amc: 'AWT Investments Limited', pages: [
    { type: 'fmr', url: 'https://www.awtinvestments.com/downloads/fund-manager-reports' },
  ] },
  { amc: 'National Investment Trust Limited', pages: [
    { type: 'fmr', url: 'https://nit.com.pk/ConsolidatedFMR' },
  ] },
  // Mahaana (app-only portal), Lakson (no document links rendered) and Pak Oman (FMRs behind a
  // visitor-details form, which we do not fill) have no automatable source yet.
  { amc: 'Mahaana Wealth Limited', pages: [] },
  { amc: 'AKD Investment Management Limited', pages: [
    { type: 'fmr', url: 'https://www.akdinvestment.com/Home/FundManagerReports' },
    { type: 'ter', url: 'https://www.akdinvestment.com/Home/FundExpenseRatioReports' },
  ] },
  { amc: 'Pak Oman Asset Management Company Limited', pages: [] },
  { amc: '786 Investments Limited', allShariah: true, pages: [
    { type: 'fmr', url: 'https://786investments.com/786-immf-fmrs/' },
    { type: 'offering', url: 'https://786investments.com/principal_documents/' },
  ] },
  { amc: 'Lakson Investments Limited', pages: [] },
];
