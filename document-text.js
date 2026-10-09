// Pure helpers for the AMC document collector: link classification, document
// dates, and catalog fund matching. No network or database access here.
const { normalizeFundName } = require('./fund-identity');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const SHARIAH_WORDS = /islamic|shariah|alhamra|al.?ameen|sharia|halal|meezan|amanah|sukuk|takaful|mehfooz|ijarah|musharakah|mudarabah|murabaha|aitemaad|barakah|tijarah|sahulat/i;
// Pages and files that are not about a fund's terms or performance.
const IRRELEVANT = /application|account.?opening|redemption|investment.?form|conversion.?form|transfer.?form|zakat|complain|stewardship|code.?of.?conduct|whistle|governance|proxy|provisioning|booklet|brochure|walkthrough|privacy|alignment.?of.?interest|harassment|diversity|esg|policy|certificate|financial.?statement|annual.?report|quarterly.?report|half.?year|accounts|directors|faq|form\b|kyc|fatca|crs|pledge|nominee|risk.?profiler|video/i;

const clean = text => String(text || '').replace(/ |​/g, ' ').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
// Like clean(), but keeps line breaks: one line per visual row of the page.
const cleanLines = text => String(text || '').split('\n').map(clean).filter(Boolean).join('\n');

// Shadowed headings are drawn twice a few points apart: "Fund ReviewFund Review" -> "Fund Review".
const undouble = line => line.replace(/([A-Z][A-Za-z0-9&'’(). -]{3,80}?)\1/g, '$1');

// Rebuild a page's visual lines from pdf.js text items (page.getTextContent().items).
// Text items arrive in drawing order, not reading order, and joining them with spaces turns a
// fee table into "Front End Load Back End Load 2.00% Nil". Grouping items by baseline (y) and
// sorting by x keeps "Front End Load | 2.00%" together on one line, which is what retrieval needs.
// A wide horizontal gap becomes " | " (a column break); a small gap becomes a space.
// Many FMRs draw headings twice (a shadow effect): identical text at the same spot is dropped.
function layoutText(items) {
  const rows = [];
  const seen = new Set();
  for (const item of items || []) {
    const text = String(item.str || '');
    if (!text.trim() || !item.transform) continue;
    const [, , , d, x, y] = item.transform;
    const height = Math.abs(d) || item.height || 8;
    const key = `${Math.round(x)}:${Math.round(y)}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let row = rows.find(r => Math.abs(r.y - y) <= Math.max(2, Math.min(r.height, height) * 0.45));
    if (!row) rows.push(row = { y, height, items: [] });
    row.items.push({ x, width: item.width || 0, text });
  }
  rows.sort((a, b) => b.y - a.y);   // PDF y grows upwards: top of the page first
  return rows.map(row => {
    row.items.sort((a, b) => a.x - b.x);
    let line = '', end = null;
    for (const item of row.items) {
      if (end !== null) {
        const gap = item.x - end;
        line += gap > row.height * 1.2 ? ' | ' : gap > row.height * 0.15 && !/\s$/.test(line) && !/^\s/.test(item.text) ? ' ' : '';
      }
      line += item.text;
      end = item.x + item.width;
    }
    return undouble(clean(line));
  }).filter(Boolean).join('\n');
}

// Lowercase letters and digits only, so "Meezan Cash Fund (MCF)" and "MEEZAN CASH FUND" compare equal.
const flat = text => clean(text).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// Find a month/year in link text or a file name: "FMR August 2026", "fmr_2026_aug", "JSIL_FMR_JAN_2026", "fmr_dec-06".
function documentMonth(text) {
  const value = clean(text).toLowerCase().replace(/%20/g, ' ');
  const month = '(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*';
  let match = value.match(new RegExp(`${month}[^a-z0-9]{0,3}(20\\d{2}|\\d{2})(?!\\d)`));
  if (match) return toIso(match[2], match[1]);
  match = value.match(new RegExp(`(20\\d{2})[^a-z0-9]{0,3}${month}`));
  if (match) return toIso(match[1], match[2]);
  return null;
}
function toIso(year, monthName) {
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  const m = MONTHS[monthName.slice(0, 4)] || MONTHS[monthName.slice(0, 3)];
  if (!m || y < 2000 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}
// WordPress-style upload paths carry the publish month: /uploads/2026/09/...
function uploadMonth(url) {
  const match = String(url).match(/\/(20\d{2})\/(0[1-9]|1[0-2])\//);
  return match ? `${match[1]}-${match[2]}-01` : null;
}

// Decide what a PDF link is, from the listing page it was found on and its own text.
function classifyLink(link, pageType) {
  const text = `${link.text} ${decodeURIComponent(String(link.href).split('/').pop() || '')}`;
  if (IRRELEVANT.test(text) && !/key.?fact|offering|fmr|fund.?manager/i.test(text)) return null;
  if (/trust.?deed/i.test(text)) return null;              // legal deed: little investor-facing content
  if (/conventional/i.test(text)) return null;
  if (/\.(?:docx?|xlsx?|pptx?|zip)(?:$|[?#])/i.test(link.href)) return null;   // only PDFs are extracted
  if (/key.?fact|\bkfs\b/i.test(text)) return 'key_fact_statement';
  if (/consolidated/i.test(text) && /offering|\bod\b|\bcod\b/i.test(text)) return 'offering_document';
  if (/supplement|\bsod\b|\d(?:st|nd|rd|th)[ _-]*s(?:upp|od)/i.test(text)) return 'supplemental_offering_document';
  if (/offering|\bod\b|\bcod\b|^od[_-]/i.test(text)) return 'offering_document';
  if (/expense.?ratio|\bter\b/i.test(text)) return 'expense_ratio';
  if (pageType === 'fmr' && (/fmr|fund.?manager|report/i.test(text) || documentMonth(text))) return 'fmr';
  if (pageType === 'kfs') return 'key_fact_statement';
  if (pageType === 'ter') return 'expense_ratio';
  if (pageType === 'offering') return 'offering_document';
  return null;
}

// Catalog matcher for one AMC. Longest names are tried first so "Meezan Islamic Income Fund"
// wins over "Meezan Islamic Fund" when both appear in the same text.
// Catalog names often wrap a plan in parentheses: "Meezan Daily Income Fund (Meezan Mahana
// Munafa Plan)". Documents may name only the plan, or only the name without the bracket, so
// both are added as variants, but only when no other fund of the AMC shares that variant.
function nameVariants(fundName) {
  const variants = [fundName, normalizeFundName(fundName)];
  const withoutFormerly = fundName.replace(/\(formerly[^)]*\)/gi, ' ');
  variants.push(withoutFormerly, withoutFormerly.replace(/\([^)]*\)/g, ' '));
  for (const [, inner] of withoutFormerly.matchAll(/\(([^)]+)\)/g)) {
    if (inner.trim().split(/\s+/).length >= 2 && /[a-z]{4,}/i.test(inner)) variants.push(inner);
  }
  return [...new Set(variants.map(flat).filter(name => name.split(' ').length >= 2))];
}

function buildMatcher(funds) {
  const counts = new Map();
  const raw = funds.map(fund => ({ fund, variants: nameVariants(fund.fund_name) }));
  for (const { variants } of raw) for (const v of variants) counts.set(v, (counts.get(v) || 0) + 1);
  // The full catalog name always counts (VPS sub-funds legitimately share one); extra variants only if unique.
  const entries = raw.map(({ fund, variants }) => ({ fund, names: variants.filter(v => v === flat(fund.fund_name) || counts.get(v) === 1)
    .sort((a, b) => b.length - a.length) })).filter(e => e.names.length).sort((a, b) => b.names[0].length - a.names[0].length);
  return function match(text) {
    let haystack = ` ${flat(text)} `;
    const found = new Map();
    for (const entry of entries) {
      for (const name of entry.names) {
        const needle = ` ${name} `;
        if (haystack.includes(needle)) {
          found.set(entry.fund.fund_id, entry.fund);
          haystack = haystack.split(needle).join(' | ');   // consume, so a shorter sibling name does not also match
          break;
        }
      }
    }
    return [...found.values()];
  };
}

function isShariahText(text) { return SHARIAH_WORDS.test(text); }

// Readable citation title: "Meezan · Fund Manager Report · Aug 2026" or "Meezan Cash Fund · Key Fact Statement".
// Link texts on AMC sites are often just "Download", so the stored title is not good enough to cite.
const DOC_LABELS = { fmr: 'Fund Manager Report', offering_document: 'Offering Document', supplemental_offering_document: 'Supplemental Offering Document',
  key_fact_statement: 'Key Fact Statement', expense_ratio: 'Expense Ratio Report', trust_deed: 'Trust Deed', financial_report: 'Financial Report' };
function displayTitle({ docType, amcName, fundNames = [], date, title }) {
  // "Al Meezan Investment Management Limited" -> "Al Meezan", "UBL Fund Managers Limited" -> "UBL".
  let amc = clean(amcName);
  for (let prev = ''; prev !== amc;) { prev = amc; amc = amc.replace(/\s+(limited|ltd\.?|company|management|asset|investments?|fund|managers?|wealth)$/i, ''); }
  const subject = docType === 'fmr' || fundNames.length !== 1 ? amc || clean(fundNames[0]) : clean(fundNames[0]);
  const month = date ? new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
  const extra = docType === 'supplemental_offering_document' ? (clean(title).match(/\b(\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|eight|ninth|tenth)\b(?= supplement)/i)?.[0] || '') : '';
  return [subject, [extra, DOC_LABELS[docType] || docType].filter(Boolean).join(' '), month].filter(Boolean).join(' · ');
}

module.exports = { clean, cleanLines, undouble, layoutText, displayTitle, DOC_LABELS, flat, documentMonth, uploadMonth, classifyLink, buildMatcher, isShariahText, SHARIAH_WORDS };
