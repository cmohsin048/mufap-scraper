# MUFAP scrapers

Collect the Shariah fund catalog, daily NAVs, and payouts into Supabase.

## Run

From this folder, install dependencies with `npm ci` (use `npm.cmd ci` if PowerShell blocks npm). On a new installation, copy `.env.example` to `.env` and configure the Supabase URL and service key. Keep the service key private. Chrome or Edge must be installed for browser fallback.

| Data | Command |
| --- | --- |
| Fund catalog | `node collector.js` |
| Daily NAV | `node nav-collector.js` |
| Payouts | `node industrystatecollector.js` |
| Fund profiles (risk, loads, TER, net assets) | `node fund-profile-collector.js` |
| AMC documents (FMR, offering docs, KFS) for the assistant | `node document-collector.js` |

The payout command stores data by default. `node industrystatecollector.js --dry-run` checks without writing. `industry-stats-collector.js` is its implementation, so both files are required.

The configured database already has the payout schema installed. For a new database, review and apply `setup-database.sql`, then `setup-payout-database.sql` in Supabase. See [NAV instructions](NAV-COLLECTOR.md) and [payout instructions](PAYOUT-COLLECTOR.md).

## Verification and coverage

Run `npm test` (or `npm.cmd test`) for offline collector, return calculation, and local PostgreSQL tests. This command does not write to production.

The completed historical import audited 127 quarterly ranges from 1995-01-01 through 2026-09-18 and upserted 26,989 matched payout records with database readback. Collection targets the 331-fund catalog. The 202 previously unmatched Shariah payouts were recovered after adding 86 verified funds. Their 11,992 NAV records were also imported and read back. One conflicting AKD distribution remains quarantined; complete payouts for every source fund cannot be claimed. Details and evidence locations are in the payout instructions.

The web app now reads payout history using its public Supabase key and shows payout-adjusted returns on fund detail pages. `payout-data.js`, `payout-returns.js`, and their TypeScript declarations are vendored into the app for independent deployment. Public read verification passed for 26,989 payouts and all 331 fund snapshots on 2026-09-19. See `../islamicfunds/PAYOUT-INTEGRATION.md` for integration details and repeatable checks.

## Folder contents

- Root scripts and identity files: the three collectors and their required support modules.
- `test/`: automated regression tests and a public report fixture.
- `scripts/`: optional historical auditing, verified import, profile-map maintenance, and live integration verification tools. Run these from the repository root; ordinary collection does not require them.
- SQL files: database setup and payout schema with access policies and return-data function.
- `tmp/`: local audit reports and source evidence, excluded from Git.

Credentials, browser sessions, downloaded audit files, and `node_modules` stay local and are ignored by Git. When moving this existing folder, preserve `.env` and the local audit evidence. Obsolete probes and one-off repair SQL were removed after the initial backup commit, and remain available in Git history.

## AI assistant data: fund profiles and documents

Both collectors need the tables from `migrations/001-ai-assistant.sql`. Apply it once in the Supabase SQL Editor. It is additive: existing tables are not changed. Both collectors refuse to write if the tables are missing.

**Fund profiles.** `node fund-profile-collector.js --dry-run --limit 3` checks without writing. It renders each MUFAP fund profile (`/FundProfile/FundDetail?FundID=`) in the persistent browser session, for the 299 funds in `fund-profile-map.json`, and stores risk profile, loads, management fee, dealing days, trustee, auditor, rating, fund manager, net assets, MUFAP's published returns, expense ratios, and asset allocation in `fund_profiles`. Rendered pages are cached in `tmp/profiles/`. `--cached` re-parses and stores them without fetching. `--fund "name"` selects funds. About 6 s per fund; a full run takes about 35 minutes. Pages that do not load are listed in `tmp/profile-failures.json` and can be retried with `--fund`.

**Documents.** `node document-collector.js --dry-run [--amc "name"]` checks without writing. For each AMC in `amc-sources.js` it opens the official listing pages in a separate browser profile (`.amc-browser/`), and:
- checks robots.txt,
- keeps the newest FMR (the Islamic edition where the AMC splits them), the newest offering document, the 3 newest supplements, and the newest key fact statement per Shariah fund,
- downloads PDFs one at a time with `RATE_LIMIT_DELAY` between them,
- extracts text per page (`unpdf`),
- maps documents (and FMR pages) to catalog funds by exact normalized name.

Cloudflare's automatic check is waited out. Interactive challenges are never solved, and forms asking for visitor details are never filled (Pak Oman is skipped for this reason). Downloads, extracted text, and a manifest per AMC are cached in `tmp/documents/`. `--cached` stores a previous dry run without network access; it also re-extracts the text from the cached PDFs with the current extractor, so extraction improvements never need a re-download. Text is extracted line by line from each PDF's text positions (`layoutText` in `document-text.js`), so table rows such as `Front End Load | 2.00%` stay together, and every document gets a readable citation title (`display_title`, e.g. "Al Meezan · Fund Manager Report · Aug 2026"). `--discover <url>` lists a page's document links when adding or fixing a source. Scanned PDFs without a text layer are skipped.

After storing documents, build the search index from the web app folder: `npm run ai:ingest:check`, then `npm run ai:ingest` (see `../islamicfunds/docs/ai/LEARNING-LOG.md`, Phase 3).

Tests: `npm run test:documents` (offline parser, classification, matching, robots, and selection tests; also included in `npm test`).
