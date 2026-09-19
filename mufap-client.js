const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

function mufapError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Cloudflare documents cf-mitigated: challenge as the authoritative signal.
// The HTML checks also cover cached challenges and older challenge templates.
function isChallenge(html, headers = {}) {
  const get = name => typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return get('cf-mitigated') === 'challenge' ||
    /<title>\s*(?:Just a moment|Attention Required)/i.test(html) ||
    /(?:window\._cf_chl_opt|\/cdn-cgi\/challenge-platform\/.*chl_page)/i.test(html);
}

class MufapClient {
  constructor(options = {}) {
    this.mode = options.mode || process.env.MUFAP_TRANSPORT || 'auto';
    if (!['auto', 'browser', 'http'].includes(this.mode)) {
      throw new Error('MUFAP_TRANSPORT must be auto, browser, or http.');
    }
    this.profileDir = path.resolve(options.profileDir || path.join(__dirname, '.mufap-browser'));
    this.channel = options.channel || process.env.MUFAP_BROWSER || 'chrome';
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.challengeTimeoutMs = options.challengeTimeoutMs ?? 120000;
    this.fetch = options.fetch || globalThis.fetch;
    this.sleep = options.sleep || sleep;
    this.log = options.log || console.log;
    this.context = null;
    this.browser = null;
    this.browserProcess = null;
    this.page = null;
    this.useBrowser = this.mode === 'browser';
    this.closed = false;
  }

  async openBrowser() {
    if (this.context) return;
    const { chromium } = require('playwright-core');
    try {
      if (process.platform === 'win32') {
        // Start the installed browser normally, with its own persistent profile.
        // CDP is restricted to loopback and an OS-assigned port. No personal
        // profile, spoofed user-agent, extensions, or disabled sandbox is used.
        const executable = this.findWindowsBrowser();
        const port = await new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            const availablePort = server.address().port;
            server.close(error => error ? reject(error) : resolve(availablePort));
          });
        });
        const endpoint = await new Promise((resolve, reject) => {
          const child = spawn(executable, [
            '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
            `--user-data-dir=${this.profileDir}`, '--no-first-run',
            '--no-default-browser-check', 'about:blank'
          ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
          this.browserProcess = child;
          let output = '';
          const timer = setTimeout(() => finish(new Error('Browser startup timed out. Close any other collector using .mufap-browser.')), 30000);
          const finish = (error, url) => {
            clearTimeout(timer);
            child.removeListener('error', onError);
            child.removeListener('exit', onExit);
            child.stderr.removeListener('data', onData);
            if (error) reject(error); else resolve(url);
          };
          const onError = error => finish(error);
          const onExit = () => finish(new Error('Browser exited before connecting. Close any other collector using .mufap-browser.'));
          const onData = data => {
            output = (output + data.toString()).slice(-8192);
            const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);
            if (match) finish(null, match[1]);
          };
          child.on('error', onError);
          child.on('exit', onExit);
          child.stderr.on('data', onData);
        });
        this.browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
        this.context = this.browser.contexts()[0];
      } else {
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          channel: this.channel, headless: false, chromiumSandbox: true, viewport: null, timeout: 30000
        });
      }
    } catch (error) {
      if (this.browserProcess && this.browserProcess.exitCode === null) this.browserProcess.kill();
      this.browserProcess = null;
      throw mufapError('MUFAP_BROWSER_ERROR', `Could not open the MUFAP browser: ${error.message.split('\n')[0]}`);
    }
    if (this.closed) {
      await this.close();
      throw mufapError('MUFAP_BROWSER_ERROR', 'Collection was cancelled.');
    }
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.log('      Browser session ready (cookies are retained for the next run).');
    // Visit the report landing page first, as the website's own UI does. This
    // initializes MUFAP/Cloudflare session cookies before requesting histories.
    const landing = await this.getBrowser('https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3');
    if (landing.status !== 200) {
      throw mufapError('MUFAP_UNAVAILABLE', `MUFAP report landing page returned HTTP ${landing.status}.`);
    }
  }

  findWindowsBrowser() {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const chrome = roots.map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    const edge = roots.map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    const candidates = this.channel === 'msedge' ? edge : this.channel === 'chrome' ? [...chrome, ...edge] : [];
    const executable = candidates.find(candidate => fs.existsSync(candidate));
    if (!executable) throw new Error('Install Chrome or Edge, and set MUFAP_BROWSER to chrome or msedge.');
    return executable;
  }

  async getHttp(url) {
    const response = await this.fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    return { status: response.status, headers: response.headers, html: await response.text() };
  }

  async getBrowser(url) {
    await this.openBrowser();
    let latestDocument = null;
    const rememberDocument = response => {
      if (response.request().isNavigationRequest() && response.frame() === this.page.mainFrame()) {
        latestDocument = response;
      }
    };
    this.page.on('response', rememberDocument);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      let announced = false;
      const deadline = Date.now() + this.challengeTimeoutMs;
      while (true) {
        if (this.page.isClosed() || this.closed) {
          throw mufapError('MUFAP_BROWSER_ERROR', 'The MUFAP browser was closed. Run the collector again to resume.');
        }
        const document = latestDocument;
        if (!document) throw mufapError('MUFAP_INVALID_RESPONSE', 'MUFAP returned no report document.');
        const result = { status: document.status(), headers: document.headers(), html: await document.text() };
        if (!isChallenge(result.html, result.headers)) {
          const actual = new URL(document.url());
          const requested = new URL(url);
          if (actual.origin !== requested.origin || actual.pathname !== requested.pathname ||
              [...requested.searchParams].some(([key, value]) => actual.searchParams.get(key) !== value)) {
            throw mufapError('MUFAP_INVALID_RESPONSE', 'MUFAP redirected away from the requested report. Progress was not advanced.');
          }
          // Parse the server HTML, before DataTables removes/group-filters rows.
          return result;
        }
        if (!announced) {
          this.log(`      MUFAP requires browser verification. If prompted, complete it in the opened browser. Waiting up to ${this.challengeTimeoutMs / 1000}s...`);
          announced = true;
        }
        if (Date.now() >= deadline) {
          if (typeof this.page.screenshot === 'function') {
            const screenshotPath = path.join(this.profileDir, 'last-challenge.png');
            try {
              await this.page.screenshot({ path: screenshotPath, timeout: 5000 });
              this.log(`      Verification screen saved to ${screenshotPath}`);
            } catch { /* A closed or navigating page may not allow a screenshot. */ }
          }
          throw mufapError('MUFAP_BLOCKED',
            'MUFAP browser verification did not finish. Run again and complete any verification in the browser. ' +
            'If it keeps failing, request automated data access from MUFAP. Saved NAV dates have not been advanced by this request.');
        }
        // Wait for the browser's own challenge flow; do not reload or solve CAPTCHAs.
        await this.sleep(1000);
      }
    } catch (error) {
      if (this.closed || this.page?.isClosed()) {
        throw mufapError('MUFAP_BROWSER_ERROR', 'The MUFAP browser was closed. Run the collector again to resume.');
      }
      throw error;
    } finally {
      this.page.removeListener('response', rememberDocument);
    }
  }

  async get(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.closed) throw mufapError('MUFAP_BROWSER_ERROR', 'Collection was cancelled.');
      try {
        let result = this.useBrowser ? await this.getBrowser(url) : await this.getHttp(url);
        if (isChallenge(result.html, result.headers)) {
          if (this.mode === 'http') {
            throw mufapError('MUFAP_BLOCKED', 'MUFAP requires browser verification. Remove --http-only or set MUFAP_TRANSPORT=auto.');
          }
          this.log('      Cloudflare requires a browser; switching to a persistent Chrome/Edge session.');
          this.useBrowser = true;
          result = await this.getBrowser(url);
        }
        if (result.status === 403) {
          throw mufapError('MUFAP_BLOCKED', 'MUFAP denied access (HTTP 403). Request data access from MUFAP if this persists.');
        }
        if (result.status === 429 || result.status >= 500) {
          const retryAfter = typeof result.headers.get === 'function'
            ? result.headers.get('retry-after') : result.headers['retry-after'];
          const wait = retryAfter
            ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()))
            : (attempt + 1) * 5000;
          if (attempt === 2 || !Number.isFinite(wait) || wait > 60000) {
            throw mufapError('MUFAP_UNAVAILABLE',
              `MUFAP returned HTTP ${result.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ''}. Resume later; saved progress is retained.`);
          }
          this.log(`      MUFAP HTTP ${result.status}; retrying in ${wait / 1000}s (${attempt + 1}/2).`);
          await this.sleep(wait);
          continue;
        }
        if (result.status !== 200) {
          throw mufapError('MUFAP_INVALID_RESPONSE', `MUFAP returned HTTP ${result.status}. Progress was not advanced.`);
        }
        return result.html;
      } catch (error) {
        if (error.code?.startsWith('MUFAP_')) throw error;
        const transient = /fetch failed|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_(?:CONNECTION|TIMED_OUT|NETWORK)/i.test(error.message);
        if (!transient || attempt === 2) {
          throw mufapError('MUFAP_UNAVAILABLE', `Could not fetch MUFAP data: ${error.message.split('\n')[0]}`);
        }
        const wait = (attempt + 1) * 2000;
        this.log(`      MUFAP network error; retrying in ${wait / 1000}s (${attempt + 1}/2).`);
        await this.sleep(wait);
      }
    }
  }

  async close() {
    this.closed = true;
    try {
      if (this.browser?.isConnected()) {
        // Browser.close() on a CDP connection only disconnects Playwright.
        // Explicitly close the dedicated browser that this collector launched.
        const session = await this.browser.newBrowserCDPSession();
        await session.send('Browser.close');
        await this.browser.close();
      } else if (this.context) {
        await this.context.close();
      }
    } catch (error) {
      // A user may have closed the window or pressed Ctrl+C while Chrome exits.
      if (!/closed|disconnected/i.test(error.message)) throw error;
    } finally {
      if (this.browserProcess && this.browserProcess.exitCode === null) {
        const child = this.browserProcess;
        await new Promise(resolve => {
          const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      this.browserProcess = null;
      this.browser = null;
      this.context = null;
    }
  }
}

module.exports = { MufapClient, isChallenge, mufapError };
