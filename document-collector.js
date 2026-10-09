/**
 * AMC document collector: Fund Manager Reports, offering documents (and supplements),
 * key fact statements and expense-ratio reports for Shariah funds, from each AMC's
 * own website. Text is extracted page by page for the assistant's RAG search.
 *
 *   node document-collector.js --dry-run                 # discover, download, extract, match; no DB writes
 *   node document-collector.js --dry-run --amc "Atlas"   # one AMC
 *   node document-collector.js --cached                  # store what an earlier run cached in tmp/documents
 *                                                        # (text is re-extracted from the cached PDFs; no network)
 *   node document-collector.js --discover "https://..."  # list document-like links on a page (for configuring sources)
 *
 * Politeness: listing pages are opened in a real browser one at a time, PDFs are
 * downloaded sequentially with a delay, robots.txt is checked per site, and
 * interactive challenges are never solved: that source is skipped instead.
 */
require('dotenv').config();
require('node:dns').setDefaultResultOrder('ipv4first');   // some networks resolve Supabase to an unreachable IPv6 address
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { createClient } = require('@supabase/supabase-js');
const { MufapClient, isChallenge } = require('./mufap-client');
const { clean, layoutText, displayTitle, flat, documentMonth, uploadMonth, classifyLink, buildMatcher, isShariahText } = require('./document-text');
const SOURCES = require('./amc-sources');

const ROOT = path.join(__dirname, 'tmp', 'documents');
const PDF_DIR = path.join(ROOT, 'pdf');
const TEXT_DIR = path.join(ROOT, 'text');
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 400;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// Bump when extraction changes, so cached text is rebuilt from the cached PDFs.
// v2: lines rebuilt from text positions (layoutText) instead of one flattened line per page.
const EXTRACTOR_VERSION = 'v2';
// Keep this many supplemental offering documents per fund (newest first); one main OD and KFS.
const KEEP = { offering_document: 1, supplemental_offering_document: 3, key_fact_statement: 1, expense_ratio: 1 };

class DocumentCollector {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.delayMs = options.delayMs ?? Number(process.env.RATE_LIMIT_DELAY || 1500);
    // A separate browser profile so this can run alongside the MUFAP collectors.
    this.browser = options.browser || new MufapClient({ mode: 'browser', profileDir: path.join(__dirname, '.amc-browser'), log: this.log,
      timeoutMs: 60000, challengeTimeoutMs: 45000 });
    this.robots = new Map();
  }

  // Minimal robots.txt check for "User-agent: *" groups: Disallow prefixes, with Allow overrides.
  async allowed(url) {
    const { origin, pathname } = new URL(url);
    if (!this.robots.has(origin)) {
      let rules = [];
      try {
        const response = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
        if (response.ok) rules = parseRobots(await response.text());
      } catch { /* Unreachable robots.txt: treat as no rules, like most crawlers. */ }
      this.robots.set(origin, rules);
    }
    const rules = this.robots.get(origin).filter(rule => decodeURIComponent(pathname).startsWith(rule.path));
    if (!rules.length) return true;
    const longest = rules.sort((a, b) => b.path.length - a.path.length)[0];
    return longest.allow;
  }

  // Render a listing page and return every PDF-like link with surrounding text for context.
  // Open a page in the browser. Unlike MufapClient.get, redirects are fine here (AMC sites
  // move pages around). Cloudflare's automatic check is waited out; an interactive
  // challenge is never solved, the source is reported as blocked instead.
  async render(url) {
    await this.browser.openBrowser();
    const page = this.browser.page;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (error) {
      if (!/net::ERR_|Timeout/i.test(error.message)) throw error;
      await sleep(5000);   // one retry for transient network errors
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    const deadline = Date.now() + 45000;
    // content() throws while a challenge redirect is navigating; treat that as "still checking".
    const html = () => page.content().catch(() => '<title>Just a moment</title>');
    while (isChallenge(await html())) {
      if (Date.now() > deadline) throw new Error('blocked by a browser challenge');
      await sleep(2000);
    }
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    return page;
  }

  // Card-and-button pages (no <a href>): return the card titles; URLs are resolved later by clicking.
  async listButtonCards(listing) {
    const page = await this.render(listing.url);
    const { card, title = 'h1,h2,h3,h4,h5' } = listing.buttons;
    const titles = await page.locator(card).evaluateAll((cards, selector) => cards.map(c => (c.querySelector(selector)?.innerText || c.innerText).trim()), title);
    return titles.map((text, index) => ({ href: `button:${listing.url}#${index}`, text, buttonIndex: index }));
  }

  // Click a card's View/Download button and read the PDF URL from the tab (or download) it opens.
  async resolveButton(listing, index) {
    const page = this.browser.page.url() === listing.url ? this.browser.page : await this.render(listing.url);
    const { card, button = 'View' } = listing.buttons;
    const popup = page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null);
    const download = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await page.locator(card).nth(index).locator('button, a', { hasText: button }).first().click({ timeout: 10000 });
    const opened = await Promise.race([popup, download]);
    if (!opened) throw new Error('button did not open a document');
    const url = opened.url();
    if (typeof opened.cancel === 'function') await opened.cancel(); else await opened.close();
    await sleep(this.delayMs);
    return url;
  }

  // Sub-pages to visit instead of the listing itself, e.g. MCB's month folders or per-fund pages.
  async followLinks(listing) {
    const page = await this.render(listing.url);
    const pattern = new RegExp(listing.follow.pattern, 'i');
    const anchors = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: a.innerText.trim() })));
    const unique = [...new Map(anchors.filter(a => pattern.test(a.href)).map(a => [a.href, a])).values()];
    const filtered = listing.follow.shariahOnly ? unique.filter(a => isShariahText(`${a.text} ${a.href}`)) : unique;
    return filtered.slice(0, listing.follow.max || 1).map(a => a.href);
  }

  async listLinks(url) {
    const page = await this.render(url);
    return page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!/^https?:/i.test(href)) continue;
        const pdfLike = /\.pdf(?:$|[?#])/i.test(href) || (/\/uploads\/|\/files\/|ufiles|getfile|\.ashx|\/download\/\d+|[?&]file=/i.test(href) && /download|view|open|pdf/i.test(a.textContent + a.title)) || /[?&]wpfb_dl=\d+/i.test(href);
        if (!pdfLike) continue;
        // "Download" buttons carry no name, so read the nearest row/card for context.
        // Climb until the next ancestor would also contain a different document link.
        let context = '';
        for (let node = a.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
          const others = [...node.querySelectorAll('a[href]')].filter(x => x.href !== href && /\.pdf|uploads|files/i.test(x.href));
          if (others.length || (node.innerText || '').length > 600) break;
          context = node.innerText || '';
        }
        let heading = '';
        for (let node = a; node && !heading; node = node.parentElement) {
          let sibling = node.previousElementSibling;
          for (let hops = 0; sibling && hops < 6 && !heading; sibling = sibling.previousElementSibling, hops++) {
            if (/^H[1-6]$/.test(sibling.tagName) || sibling.querySelector?.('h1,h2,h3,h4,h5,h6')) heading = sibling.innerText.slice(0, 120);
          }
        }
        out.push({ href, text: `${a.innerText || a.title || ''} ${context} ${heading}`.trim() });
      }
      return out;
    });
  }

  async download(url) {
    fs.mkdirSync(PDF_DIR, { recursive: true });
    const file = path.join(PDF_DIR, `${sha(url).slice(0, 24)}.pdf`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file);
    let bytes = null;
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' }, signal: AbortSignal.timeout(90000) });
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_PDF_BYTES) throw new Error(`too large (${Math.round(length / 1e6)} MB)`);
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (/too large/.test(error.message)) throw error;
    }
    // Cloudflare-protected sites: fetch through the browser session, which carries its cookies.
    if (!bytes || bytes.subarray(0, 5).toString() !== '%PDF-') {
      await this.browser.openBrowser();
      // An incomplete TLS chain (UBL) fails in Node but not in the browser, which fetches the
      // missing intermediate certificate itself. Verification still happens, in the browser.
      const response = await this.browser.page.context().request.get(url, { timeout: 90000 }).catch(error => {
        if (/certificate/i.test(error.message)) return null;
        throw error;
      });
      if (response?.ok()) bytes = Buffer.from(await response.body());
      else if (!response || response.status() === 403) bytes = await this.downloadInPage(url);
      else throw new Error(`HTTP ${response.status()}`);
    }
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
    if (bytes.length > MAX_PDF_BYTES) throw new Error(`too large (${Math.round(bytes.length / 1e6)} MB)`);
    fs.writeFileSync(file, bytes);
    await sleep(this.delayMs);
    return bytes;
  }

  // Some sites (MCB's download plugin) only serve files to requests made by their own pages.
  // Fetch from inside a page on the same origin, as the site's own download link would.
  async downloadInPage(url) {
    const page = this.browser.page;
    if (new URL(page.url()).origin !== new URL(url).origin) await this.render(new URL(url).origin + '/');
    const base64 = await page.evaluate(async target => {
      const response = await fetch(target, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    }, url);
    return Buffer.from(base64, 'base64');
  }

  async extract(url) {
    fs.mkdirSync(TEXT_DIR, { recursive: true });
    const file = path.join(TEXT_DIR, `${sha(url).slice(0, 24)}.${EXTRACTOR_VERSION}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const bytes = await this.download(url);
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PAGES) throw new Error(`${pdf.numPages} pages exceeds ${MAX_PAGES}`);
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      pages.push(layoutText((await page.getTextContent()).items));
      page.cleanup();
    }
    const result = { url, pages, bytes: bytes.length };
    fs.writeFileSync(file, JSON.stringify(result));
    return result;
  }

  // Collect one AMC: list -> classify -> select -> download/extract -> match to Shariah funds.
  async collectAmc(source, funds) {
    const matcher = buildMatcher(funds);
    this.fundNames = new Map(funds.map(f => [f.fund_id, f.fund_name]));
    const allShariah = source.allShariah === true;
    const candidates = [];
    const listings = [];
    for (const listing of source.pages) {
      if (!listing.follow) { listings.push(listing); continue; }
      try {
        for (const url of await this.followLinks(listing)) listings.push({ ...listing, url, follow: undefined });
      } catch (error) { this.log(`    ${listing.type} follow failed: ${error.message.split('\n')[0]}`); }
    }
    for (const listing of listings) {
      if (!await this.allowed(listing.url)) { this.log(`    robots.txt disallows ${listing.url}; skipped`); continue; }
      let links;
      try { links = listing.buttons ? await this.listButtonCards(listing) : await this.listLinks(listing.url); } catch (error) {
        this.log(`    ${listing.type} listing failed: ${error.message.split('\n')[0]}`); continue;
      }
      const seen = new Set();
      for (const link of links) {
        if (seen.has(link.href)) continue;
        seen.add(link.href);
        const docType = classifyLink(link, listing.type);
        if (!docType) continue;
        if (listing.include && !new RegExp(listing.include, 'i').test(`${link.text} ${link.href}`)) continue;
        const nameHits = matcher(`${link.text} ${decodeURIComponent(link.href.split('/').pop()).replace(/[-_]/g, ' ')}`);
        candidates.push({ ...link, docType, listing: listing.url, listingConfig: listing.buttons ? listing : undefined, nameHits,
          date: documentMonth(`${link.text} ${decodeURIComponent(link.href)}`) || uploadMonth(link.href) });
      }
      this.log(`    ${listing.type}: ${links.length} links, ${candidates.filter(c => c.listing === listing.url).length} candidates`);
    }
    const selected = selectCandidates(candidates, { allShariah });
    const documents = [];
    const buttonFailures = new Map();   // listing url -> consecutive click failures
    for (const candidate of selected) {
      try {
        if (candidate.listingConfig) {
          if ((buttonFailures.get(candidate.listing) || 0) >= 3) continue;   // layout differs from config; stop clicking
          try {
            candidate.href = await this.resolveButton(candidate.listingConfig, candidate.buttonIndex);
            buttonFailures.set(candidate.listing, 0);
          } catch (error) {
            buttonFailures.set(candidate.listing, (buttonFailures.get(candidate.listing) || 0) + 1);
            throw error;
          }
        }
        if (!await this.allowed(candidate.href)) continue;
        const extracted = await this.extract(candidate.href);
        const doc = this.matchDocument(candidate, extracted, matcher, source);
        if (doc) documents.push(doc);
        else this.log(`    - no Shariah fund found in ${candidate.href.split('/').pop()}`);
      } catch (error) {
        this.log(`    - ${candidate.href.split('/').pop()}: ${error.message.split('\n')[0]}`);
      }
    }
    return dedupePerFund(documents);
  }

  matchDocument(candidate, extracted, matcher, source) {
    const { pages } = extracted;
    const textChars = pages.reduce((sum, page) => sum + page.length, 0);
    if (textChars < 200) { this.log(`    - ${candidate.href.split('/').pop()}: no text layer (scanned PDF); skipped`); return null; }
    const fundPages = new Map();
    if (candidate.docType === 'fmr') {
      // FMRs: one or two pages per fund. Map each page to the funds named in its first lines.
      pages.forEach((page, index) => {
        // Most FMRs name the fund at the top. Some (ABL) put it in a side panel further down:
        // then use the whole page, but only if it names one or two funds (not a summary table).
        let hits = matcher(page.slice(0, 600));
        if (!hits.length) { const all = matcher(page); if (all.length <= 2) hits = all; }
        for (const fund of hits) fundPages.set(fund.fund_id, [...(fundPages.get(fund.fund_id) || []), index + 1]);
      });
    } else {
      // Single-fund documents name the fund on the cover. Fall back to the link text.
      let hits = matcher(pages.slice(0, 3).join(' ').slice(0, 6000));
      if (!hits.length) hits = candidate.nameHits;
      if (hits.length > 6) hits = hits.filter(fund => candidate.nameHits.some(hit => hit.fund_id === fund.fund_id));
      for (const fund of hits) fundPages.set(fund.fund_id, null);
    }
    if (!fundPages.size) return null;
    const head = pages.slice(0, 2).join(' ');
    const date = candidate.date || documentMonth(head.slice(0, 1500));
    const title = clean(candidate.text).slice(0, 160) || decodeURIComponent(candidate.href.split('/').pop());
    const fundNames = [...fundPages.keys()].map(id => this.fundNames?.get(id)).filter(Boolean);
    return {
      amc_id: source.amc_id, doc_type: candidate.docType, title,
      display_title: displayTitle({ docType: candidate.docType, amcName: source.amc, fundNames, date, title }),
      source_url: candidate.href, source_page_url: candidate.listing, document_date: date,
      page_count: pages.length, pages, content_hash: sha(pages.join('\f')),
      funds: [...fundPages].map(([fund_id, fundPagesList]) => ({ fund_id, pages: fundPagesList })),
      fetched_at: new Date().toISOString(),
    };
  }
}

// --cached: rebuild the text from the cached PDF with the current extractor (never downloads)
// and fill in fields added since the manifest was written. Page -> fund links are kept,
// because page numbers do not change when only the text layout does.
async function refreshCached(collector, doc, source, funds) {
  const names = new Map(funds.map(f => [f.fund_id, f.fund_name]));
  let pages = doc.pages;
  if (fs.existsSync(path.join(PDF_DIR, `${sha(doc.source_url).slice(0, 24)}.pdf`))) {
    try {
      const fresh = (await collector.extract(doc.source_url)).pages;
      if (fresh.length === doc.pages.length) pages = fresh;
    } catch (error) { collector.log(`    - re-extract failed for ${doc.source_url.split('/').pop()}: ${error.message}`); }
  }
  return { ...doc, pages, content_hash: sha(pages.join('\f')),
    display_title: displayTitle({ docType: doc.doc_type, amcName: source.amc, fundNames: doc.funds.map(f => names.get(f.fund_id)).filter(Boolean), date: doc.document_date, title: doc.title }) };
}

function parseRobots(text) {
  const rules = [];
  let applies = false, sawRule = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (/^user-agent$/i.test(key)) { if (sawRule) { applies = false; sawRule = false; } applies = applies || value === '*'; continue; }
    if (/^(dis)?allow$/i.test(key)) { sawRule = true; if (applies && value) rules.push({ path: value.replace(/\*.*$/, ''), allow: /^allow$/i.test(key) }); }
  }
  return rules;
}

// FMR: newest month only (Islamic edition when the AMC splits them). Others: Shariah-relevant links.
function selectCandidates(candidates, { allShariah }) {
  const fmrs = candidates.filter(c => c.docType === 'fmr' && c.date);
  const latest = fmrs.map(c => c.date).sort().at(-1);
  let currentFmrs = fmrs.filter(c => c.date === latest);
  if (currentFmrs.some(c => isShariahText(c.text + c.href))) currentFmrs = currentFmrs.filter(c => isShariahText(c.text + c.href));
  const others = candidates.filter(c => c.docType !== 'fmr' && (allShariah || c.nameHits.length || isShariahText(`${c.text} ${c.href}`)));
  const unique = new Map();
  for (const c of [...currentFmrs.slice(0, 4), ...others]) if (!unique.has(c.href)) unique.set(c.href, c);
  return [...unique.values()];
}

// Keep the newest N documents of each type per fund, so 18 historical supplements do not crowd the index.
function dedupePerFund(documents) {
  const keep = new Set();
  for (const type of Object.keys(KEEP)) {
    const byFund = new Map();
    for (const doc of documents.filter(d => d.doc_type === type)) {
      for (const { fund_id } of doc.funds) byFund.set(fund_id, [...(byFund.get(fund_id) || []), doc]);
    }
    for (const docs of byFund.values()) {
      docs.sort((a, b) => String(b.document_date || '').localeCompare(String(a.document_date || '')) ||
        Number(/consolidated/i.test(b.title)) - Number(/consolidated/i.test(a.title)));
      docs.slice(0, KEEP[type]).forEach(doc => keep.add(doc.source_url));
    }
  }
  return documents.filter(doc => doc.doc_type === 'fmr' || keep.has(doc.source_url));
}

// Supabase calls that fail on the network ("fetch failed", reset connection) are retried a few
// times; database errors (bad data, missing table) are returned at once.
async function withRetry(call, attempts = 4) {
  for (let i = 1; ; i++) {
    const result = await call();
    const transient = result.error && /fetch failed|ECONNRESET|ETIMEDOUT|socket|network|timeout/i.test(String(result.error.message || result.error));
    if (!transient || i >= attempts) return result;
    await sleep(2000 * i);
  }
}

async function storeDocuments(db, documents) {
  let stored = 0;
  for (const doc of documents) {
    const { funds, pages, ...row } = doc;
    // Postgres text cannot hold NUL (\u0000), which some PDFs emit; drop it and other control characters
    // except tab, newline and form feed (our page separator).
    const text = pages.join('\f').replace(/[\u0000-\u0008\u000B\u000E-\u001F]/g, '');
    const { data, error } = await withRetry(() => db.from('fund_documents').upsert({ ...row, extracted_text: text,
      updated_at: new Date().toISOString() }, { onConflict: 'source_url' }).select('id').single());
    if (error) throw new Error(`Could not store ${row.source_url}: ${error.message}`);
    const del = await withRetry(() => db.from('fund_document_funds').delete().eq('document_id', data.id));
    if (del.error) throw new Error(`Could not reset fund links: ${del.error.message}`);
    // One row per fund (a fund named twice gets its page lists merged); upsert so a retried write is harmless.
    const links = new Map();
    for (const f of funds) {
      const prev = links.get(f.fund_id);
      links.set(f.fund_id, !prev ? f.pages : prev === null || f.pages === null ? null : [...new Set([...prev, ...f.pages])].sort((a, b) => a - b));
    }
    const ins = await withRetry(() => db.from('fund_document_funds').upsert([...links].map(([fund_id, fundPages]) => ({ document_id: data.id, fund_id, pages: fundPages })),
      { onConflict: 'document_id,fund_id' }));
    if (ins.error) throw new Error(`Could not link funds: ${ins.error.message}`);
    stored++;
  }
  return stored;
}

async function main(args = process.argv.slice(2)) {
  const flag = name => args.includes(name);
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (flag('--help')) { console.log('Usage: node document-collector.js [--dry-run] [--cached] [--amc "name"] [--discover URL]'); return; }
  const collector = new DocumentCollector();
  try {
    if (value('--discover')) {
      const links = await collector.listLinks(value('--discover'));
      const page = collector.browser.page;
      const navLinks = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => `${a.innerText.trim().replace(/\s+/g, ' ').slice(0, 60)} => ${a.href}`)
        .filter(t => /fmr|fund.?manager|report|download|offering|constitutive|document|key.?fact|expense|kfs/i.test(t)));
      console.log([...new Set(navLinks)].join('\n'));
      console.log(`\nPDF links (${links.length}):\n` + links.slice(0, 40).map(l => `${clean(l.text).slice(0, 90)} => ${l.href}`).join('\n'));
      return;
    }
    const dryRun = flag('--dry-run');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const { data: catalog, error } = await db.from('funds').select('fund_id,fund_name,amc_id,category_name,amcs(amc_name)').eq('is_shariah_compliant', true);
    if (error) throw new Error(`Catalog unavailable: ${error.message}`);
    if (!dryRun) {
      const check = await db.from('fund_documents').select('id', { head: true, count: 'exact' });
      if (check.error) throw new Error(`fund_documents is not available (${check.error.message}). Apply migrations/001-ai-assistant.sql first.`);
    }
    let sources = SOURCES;
    if (value('--amc')) sources = sources.filter(s => s.amc.toLowerCase().includes(value('--amc').toLowerCase()));
    if (!sources.length) throw new Error('No AMC sources selected.');
    fs.mkdirSync(ROOT, { recursive: true });
    const summary = [];
    for (const source of sources) {
      const funds = catalog.filter(f => f.amcs?.amc_name === source.amc);
      if (!funds.length) { console.log(`\n${source.amc}: no Shariah funds in catalog; skipped`); continue; }
      source.amc_id = funds[0].amc_id;
      const manifest = path.join(ROOT, `${flat(source.amc).replace(/ /g, '-')}.json`);
      console.log(`\n${source.amc} (${funds.length} Shariah funds)`);
      let documents;
      if (flag('--cached')) {
        if (!fs.existsSync(manifest)) { console.log('  not cached; skipped'); continue; }
        documents = [];
        for (const doc of JSON.parse(fs.readFileSync(manifest, 'utf8'))) documents.push(await refreshCached(collector, doc, source, funds));
        fs.writeFileSync(manifest, JSON.stringify(documents));
      } else {
        documents = await collector.collectAmc(source, funds);
        fs.writeFileSync(manifest, JSON.stringify(documents));
      }
      const covered = new Set(documents.flatMap(d => d.funds.map(f => f.fund_id)));
      const byType = documents.reduce((acc, d) => ({ ...acc, [d.doc_type]: (acc[d.doc_type] || 0) + 1 }), {});
      console.log(`  ${documents.length} documents ${JSON.stringify(byType)}, covering ${covered.size}/${funds.length} funds`);
      for (const doc of documents.slice(0, 6)) console.log(`    ${doc.doc_type} ${doc.document_date || '----'} ${doc.page_count}p ${doc.title.slice(0, 70)} -> ${doc.funds.length} fund(s)`);
      if (!dryRun) console.log(`  stored ${await storeDocuments(db, documents)} documents`);
      summary.push({ amc: source.amc, funds: funds.length, covered: covered.size, documents: documents.length, byType });
    }
    fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
    const total = summary.reduce((acc, s) => ({ docs: acc.docs + s.documents, covered: acc.covered + s.covered, funds: acc.funds + s.funds }), { docs: 0, covered: 0, funds: 0 });
    console.log(`\n${dryRun ? 'DRY RUN: ' : ''}${total.docs} documents covering ${total.covered}/${total.funds} Shariah funds across ${summary.length} AMCs.`);
  } finally {
    await collector.browser.close();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(`Document collection failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { DocumentCollector, selectCandidates, dedupePerFund, parseRobots, storeDocuments, refreshCached, main };
