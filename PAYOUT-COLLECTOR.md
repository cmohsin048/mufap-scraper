# Payout collector

Run the collector with no flags:

```powershell
node industrystatecollector.js
```

This fetches and stores payouts for the existing Shariah fund catalog. The original
`industry-stats-collector.js` filename runs the same implementation. The configured
Supabase project already has the payout tables and return-data function installed.
Use `setup-payout-database.sql` only when setting up another project or applying a
future schema update. Credentials remain in `.env` as `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY`; never use the service key in the web app.

## What has been verified

The 1995-01-01 through 2026-09-18 source history was audited in all 127 quarterly
ranges. The completed live import upserted **26,787** matched payout records and
read back every chunk. A repeated January 2020 import verified duplicate-safe
upserts. No synthetic financial records were inserted into production.

Source exceptions are explicit:

- 202 Shariah source rows from 25 unmatched fund names were outside the existing
  catalog. These were not assigned to an unrelated fund or silently added as new
  database funds. See `tmp/payout-unmatched.json` and the import report.
- AKD Islamic Cash Fund has conflicting source values for 2024-08-22: 0.0285 and
  0.0248, both with ex-NAV 50. Neither disputed value was imported. The affected
  fund's coverage is marked `needs_review`.
- A successful request for an empty historical report proves what MUFAP returned,
  not that MUFAP has published every historical distribution.

The migration and its constraints/access policies were also tested against a
local PostgreSQL engine. The separate live test using the web app's public key
was initially blocked by the tool approval system's usage limit; its final result,
when run, is saved in `tmp/payout-history/live-verification.json`.

Evidence from the completed work:

- `tmp/payout-history/verification.json`: every source range, row counts, snapshot
  hashes, unmatched names, and quarantined conflicts.
- `tmp/payout-history/import-verification.json`: every imported range and database
  readback result.
- `tmp/collector-tests.log`: latest offline test results.

## Matching and source quality

Matching retains fund/AMC identity, plan qualifiers, and pension categories.
`fund-profile-map.json` records 213 MUFAP numeric profile IDs verified against the
current NAV report and catalog. These public profile IDs are separate from the
UUIDs used by `funds` and `daily_nav`. A profile/AMC disagreement stops collection.

Explicit former-name notes and redundant family wrappers are normalized.
`fund-name-aliases.json` contains the AMC-confirmed rename from Alfalah Islamic
Rozana Amdani Fund to Alfalah Islamic Amdani Fund, with its supporting source.
No general fuzzy matching is used.

Unmatched names are reported in `tmp/payout-unmatched.json`. Conflicting source
values are isolated in `tmp/payout-issues.json`; normal database collection
continues with undisputed records and marks affected coverage for review.
Print-only collection remains strict about conflicting rows. Unexpected layouts,
invalid amounts/dates, identity disagreements, and database failures stop the run.

## Storage, coverage, and reruns

`fund_payouts` stores raw per-unit amounts, ex-NAV, date, source names, profile ID,
fund/AMC UUIDs, report range, and scrape time. The fund/date uniqueness constraint
prevents duplicates. Numeric checks reject negative and non-finite amounts, and a
composite foreign key enforces the correct fund/AMC pair.

`fund_payout_coverage` tracks each fund and requested interval. A full-report
collection marks it `pending` before writes. It becomes `verified` only after
readback agrees with the source, or `needs_review` if identity/amount issues affect
completeness. A previously stored row missing from a new report is flagged; it is
not silently deleted or certified. The return calculator uses the most recent
coverage check for each subperiod, so newer pending work overrides old verified
coverage.

The no-flag command requests 1995-01-01 through today in Pakistan in three-month
chunks. Reruns re-fetch that range and upsert; they do not automatically skip old
chunks. Earlier successful batches remain saved after a failure. To resume a
failed range manually, use the start date printed in the error:

```powershell
node industrystatecollector.js --from 2024-07-01
```

Text-filtered collections write their matched records but do not certify full
coverage. UUID-filtered full reports can certify the requested fund/AMC scope.
Missing payout rows alone are never treated as proof of zero distributions.

## Optional commands

```powershell
# No database writes.
node industrystatecollector.js --dry-run --from 2026-08-01 --to 2026-08-31

# Scrape/print only, with no database connection.
node industrystatecollector.js --print-only --json --from 2026-08-01 --to 2026-08-31

# Smaller requests if a quarterly report times out.
node industrystatecollector.js --chunk-months 1

# Offline tests, including PostgreSQL schema and return calculations.
npm.cmd run test:collectors
```

`--sector`, `--category`, `--amc`, and `--fund` are case-insensitive substring
filters. `--amc-id` and `--fund-id` use catalog UUIDs in database mode. `--limit`
and `--json` require `--print-only`. `--store` is retained as an optional alias for
the default; `--store --dry-run` never writes.

Chrome or Edge handles MUFAP challenges using `.mufap-payout-browser`, separate
from the NAV collector. Run only one payout collector at a time. `--browser`,
`--http-only`, `MUFAP_TRANSPORT`, and `MUFAP_BROWSER` select transport. `--delay`
is milliseconds between chunks; `--timeout` is request milliseconds;
`--challenge-timeout` is seconds to allow browser verification.

## Web app integration

The database provides `get_fund_return_inputs(fund_id, from, to)` through the
Supabase RPC API, using the parameter names `p_fund_id`, `p_from`, and `p_to`.
It returns closing NAV endpoints, all intervening payouts, and coverage in one
consistent database snapshot. It runs with the caller's permissions, and the
payout tables allow public reads but service-role-only writes.

Copy `payout-data.js`, `payout-returns.js`, and their `.d.ts` files into the web
app's library folder, then use its existing **public/anon** Supabase client:

```typescript
import { loadFundReturns } from './payout-data';

const result = await loadFundReturns(supabase, {
  fundId: fund.fund_id,
  from: '2026-01-01',
  to: '2026-08-31',
});

// Only show a complete reinvested return when result.status === 'ready'.
// For partial/unavailable results, show the reason instead of substituting 0.
```

Returned metrics distinguish NAV-only change, cash distributions without
reinvestment, and total return with reinvestment. Simple annualization and CAGR
are separate values and must be labeled accordingly. The calculator follows
MUFAP's dividend adjustment method and excludes distributions on the starting
closing-NAV date while including those on the ending date. It exposes actual NAV
dates and rejects stale endpoints, invalid reinvestment NAVs, conflicting records,
and unverified coverage. Figures are before investor-specific taxes and loads.

This folder provides the database/data/calculation integration. The live web app
UI and its SIP calculator have not been changed or deployed. The supplied
buy-and-hold return function must not be presented as an SIP money-weighted return.

Reference: [MUFAP return methodology](https://mufap.com.pk/Upload/WebDoc/Communication/MUFAP_Return_Methodology1043.pdf).

## Reproducible verification tools

- `node scripts/verify-payout-history.js`: read-only full source audit, with local HTML
  snapshots to resume interrupted verification. Refresh snapshots when checking
  for later source corrections.
- `node scripts/build-fund-profile-map.js`: rebuild the numeric identity map from live NAV
  data; `--cached` uses the saved public NAV report.
- `node scripts/import-verified-payout-history.js`: import the completed, hash-checked
  audit snapshots and read back every range. This performs live writes.
- `node scripts/verify-payout-live.js <web-app-.env-path>`: verify public reads, denied
  identical-record writes, return calculations, and large histories. Credentials
  are read locally and never printed. Its date scenarios currently target the
  September 2026 audit dataset.
