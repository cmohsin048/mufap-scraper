# MUFAP scrapers

Collect the Shariah fund catalog, daily NAVs, and payouts into Supabase.

## Run

From this folder, install dependencies with `npm ci` (use `npm.cmd ci` if PowerShell blocks npm). On a new installation, copy `.env.example` to `.env` and configure the Supabase URL and service key. Keep the service key private. Chrome or Edge must be installed for browser fallback.

| Data | Command |
| --- | --- |
| Fund catalog | `node collector.js` |
| Daily NAV | `node nav-collector.js` |
| Payouts | `node industrystatecollector.js` |

The payout command stores data by default. `node industrystatecollector.js --dry-run` checks without writing. `industry-stats-collector.js` is its implementation, so both files are required.

The configured database already has the payout schema installed. For a new database, review and apply `setup-database.sql`, then `setup-payout-database.sql` in Supabase. See [NAV instructions](NAV-COLLECTOR.md) and [payout instructions](PAYOUT-COLLECTOR.md).

## Verification and coverage

Run `npm test` (or `npm.cmd test`) for offline collector, return calculation, and local PostgreSQL tests. This command does not write to production.

The completed historical import audited 127 quarterly ranges from 1995-01-01 through 2026-09-18 and upserted 26,787 matched payout records with database readback. Collection targets the existing 245-fund catalog. Unmatched source funds are reported, and one conflicting AKD distribution is quarantined; complete payouts for every source fund cannot be claimed. Details and evidence locations are in the payout instructions.

`payout-data.js`, `payout-returns.js`, and their TypeScript declarations are retained for the upcoming web app integration. The web app has not yet been integrated; the final public-access live check remains pending.

## Folder contents

- Root scripts and identity files: the three collectors and their required support modules.
- `test/`: automated regression tests and a public report fixture.
- `scripts/`: optional historical auditing, verified import, profile-map maintenance, and live integration verification tools. Run these from the repository root; ordinary collection does not require them.
- SQL files: database setup and payout schema with access policies and return-data function.
- `tmp/`: local audit reports and source evidence, excluded from Git.

Credentials, browser sessions, downloaded audit files, and `node_modules` stay local and are ignored by Git. When moving this existing folder, preserve `.env` and the local audit evidence. Obsolete probes and one-off repair SQL were removed after the initial backup commit, and remain available in Git history.
