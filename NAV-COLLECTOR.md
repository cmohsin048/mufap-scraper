# NAV collector

Install dependencies with `npm install`, then run:

```powershell
node nav-collector.js
```

Node 22+ and an installed Google Chrome or Microsoft Edge are required. The normal
command resumes from saved progress. If an old collector is still waiting, stop it
with Ctrl+C before starting this version.

The collector tries HTTP first. If Cloudflare returns a browser challenge, it
opens Chrome (or Edge if Chrome is missing) and uses that browser for the rest of
the run. Its dedicated `.mufap-browser` profile keeps MUFAP cookies across runs.
Keep this directory private and run only one collector at a time. Your usual
browser profile is not used.

If MUFAP displays a verification prompt, complete it in the collector's browser.
Collection continues automatically after the report loads. The default timeout
is 120 seconds; `--challenge-timeout 300` allows five minutes for verification.
The program never clicks or solves CAPTCHAs. If verification cannot finish, it
stops with exit code 1 instead of repeating five-minute cooldowns for every fund.
When possible, the failed verification screen is saved as
`.mufap-browser/last-challenge.png` for troubleshooting.

Useful commands:

```powershell
# Read the live site and saved progress, without writing anything to Supabase.
node nav-collector.js --dry-run --limit 2

# Start directly in the persistent browser.
node nav-collector.js --browser

# HTTP only: no browser window; fail immediately if browser verification is required.
node nav-collector.js --http-only

# Process two funds, or adjust the spacing between fund requests (milliseconds).
node nav-collector.js --limit 2
node nav-collector.js --delay 5000

# Offline regression tests, without MUFAP or Supabase access.
npm run test:nav
```

You can set `MUFAP_TRANSPORT=auto|browser|http` and `MUFAP_BROWSER=chrome|msedge`
in `.env`. Command-line transport flags take precedence. `--force` still requests
all available history, starting in 1962; use it only when a full backfill is needed.

Challenge pages, unexpected report layouts, wrong funds, out-of-range dates, and
invalid NAV rows cannot advance saved progress. Valid empty reports preserve the
last collected date, including MUFAP's undated zero-price placeholders when no
NAV has been published for the requested dates. NAV batches are deduplicated and written oldest first;
storage stops at the first failed batch so later dates cannot skip over that
failure. The process exits with code 1 if collection is incomplete, and closes
its browser when finished or stopped with Ctrl+C.

Fund-name checks accept MUFAP's redundant family prefix, such as
`Family Fund (Family Plan II)` versus `Family Plan II`, while retaining plan
numbers and checking the AMC. Unrecognized mismatches stop collection and print
the expected and returned names so the discrepancy can be checked.

MUFAP controls its Cloudflare rules. No client-side fix can guarantee permanent
unattended access. If verification keeps failing, ask MUFAP for an approved data
feed or access arrangement. The old collector could advance progress on empty
responses or partial write failures; this change prevents those paths going
forward, but does not automatically repair older missing historical records.

References: [Cloudflare challenge detection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)
and [Playwright browser connections](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp).
