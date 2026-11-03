# NEXT TASK — add Australia (ASX) to Marlon's Watchtower

**Read `HANDOFF.md` first** (architecture, registries, deploy conventions), then the two most recent
sections in it: **Taiwan** and **Hong Kong**. Hong Kong is the template to copy — it solved the hard
parts (per-issuer statement currency, throttled source, coverage honesty) and this market reuses them.

Repo `~/projects/oil-basis` — a git repo; **push to `main` auto-deploys to Render** (~2–3 min).
Node: `export PATH="$HOME/.local/node/bin:$PATH"` (Node ≥ 22, zero runtime dependencies).
Tests: `npm test` — must stay green. **Bump `?v=` in `public/index.html`** (`app.js` and `style.css`)
after any client change. **Never fake a number**: every figure carries its source and as-of date, and a
company you could not fetch is excluded and *counted*, never estimated.

Current tip: the Hong Kong commit. Markets today: **US · Japan · Korea · Taiwan · Hong Kong**.

> **Prerequisite.** This brief leans on the Hong Kong work (`scripts/stockanalysis.mjs`,
> `scripts/derive-hongkong.mjs`, the throttled-cache behaviour). Those files are in the working tree
> while Hong Kong is still being built — **start only after the Hong Kong commit is on `main`** and
> `git log --oneline -1` mentions it. If you must start earlier, ask for that commit first rather than
> re-inventing the statement fetcher.

---

## Why Australia

It is the cheapest market on the board and the only one that talks directly to the COMMODITIES tab:
BHP, RIO, FMG, WDS, NCM, PLS, ALD, S32 — iron ore, copper, gold, lithium, LNG. Every other company
market is tech/financials-heavy; ASX is the producers' exchange. AUD is already in the macro tape and in
`FX_CONV`, so nothing new is needed on the currency side.

---

## Verified data sources (tested 2026-11-02, all keyless)

| Need | Source | Verified |
|---|---|---|
| Universe + sectors | **`https://www.asx.com.au/asx/research/ASXListedCompanies.csv`** | 200 · **2,060 companies**, exactly 3-character codes, 27 GICS **industry groups**. Skip the first **two** lines (a date line, then the header). Encoding: UTF-8 with BOM. |
| Statements + share count + DPS | **stockanalysis.com `/quote/asx/{CODE}/financials/...`** | 200 for BHP, PLS, CBA. Page says `Financials in millions AUD` (BHP/RIO report **USD** — see below). `Shares Outstanding (Diluted)` / `Diluted Shares Outstanding` both appear. |
| Five years of closes | **Yahoo `{CODE}.AX`** (via `https.get`, **not** `fetch` — undici's fingerprint is rejected) | 200 for `BHP.AX` |
| Index | **Yahoo `^AXJO`** (S&P/ASX 200) | 200 · 1,266 daily points over 5y, currency AUD |
| FX | `https://open.er-api.com/v6/latest/USD` (`AUD`); AUD is also in the ECB feed | 200 |

No free official all-stock daily price file exists for ASX, so prices come from Yahoo, exactly as Japan
and Korea do. Do **not** try to scrape `asx.com.au` market data pages.

---

## The one trap in this market

**A big share of ASX issuers do not report in AUD.** BHP and RIO report in **USD**; a few others report
in EUR/GBP. A P/E built from an **AUD market cap over a USD profit** is wrong by ~35%.

This is already solved: `scripts/derive-hongkong.mjs` reads `reportCurrency` per company, converts the
HKD cap into the statement currency, and computes every ratio there. **Generalise it** (rename to
`scripts/derive-listing.mjs`, take `{ companies, fx, baseCurrency }`) and use it for both markets — or
copy it if generalising feels risky. Do not write a second ratio engine. Same for:

- `scripts/stockanalysis.mjs` — shared `getCached` (global 429/403 park + 6 retries + 404 cached as a
  miss), `parseSaTable`, `rowOf`, `periodFromTitle`, `statementCurrency`.
- `scripts/fetch-hongkong-profiles.mjs` — copy to `fetch-australia-profiles.mjs`; the extractor already
  pulls name, description, GICS **sector** and **industry**. Use it to fill the 300 rows whose CSV
  sector is literally `Not Applic`.
- `scripts/audit-hongkong.mjs` — copy and adapt.

---

## Build shapes (copy the Hong Kong files, swap the source)

Create:

- `scripts/asx.mjs` — CSV parser + helpers:
  - `asxCsv()` → `{ code, name, gicsIndustryGroup }`, skipping the two header lines and stripping the BOM.
  - Sector rule: use the CSV's **GICS industry group** (it is finer than the 11 GICS sectors); when the
    value is `Not Applic`, fall back to the profile's `sector`, then `'Other'`.
  - `pad = (code) => code` — ASX codes are **already 3 characters**, no padding.
  - `saPage(code, page, quarterly)` → `https://stockanalysis.com/quote/asx/{code}/financials/{page}/`
  - `yaSymbol(code)` → `{code}.AX`
- `scripts/build-australia.mjs` — universe → Yahoo 5y → 4 statement pages → derive → profiles → write.
  - CLI: `--limit=30`, `--codes=BHP,CBA,PLS`, `--skip-prices`, `--skip-fin`, `--fin-workers=3`.
  - Output `data/australia.json`, `data/australia-series/{XX}.json` (bucket by the **first character** of
    the code — 2,000 codes over 26 letters is fine), `data/australia-list.json`.
  - Audit counters: `quoted`, `companies`, `considered`, `withStatements`, `withoutStatements`,
    `throttled`, `foreignReporters`, `notApplicSectors`.
- `scripts/derive-australia.mjs` (or the shared `derive-listing.mjs` above).
- `scripts/fetch-australia-profiles.mjs`, `scripts/audit-australia.mjs`.
- `data/australia-themes.json` — **curated by hand**; the build filters tickers that do not exist.
  Suggested themes: `materials` (BHP, RIO, FMG, S32, MIN, PLS, ALD, IGO), `gold` (NCM, EVN, NST, GMD,
  RMS), `energy` (WDS, STO, KAR, ORG), `banks` (CBA, WBC, NAB, ANZ, MQG, SUN), `healthcare` (CSL, RMD,
  COH, SHL), `consumer` (WES, WOW, COL, JBH, ALL), `industrials` (TLS, TCL, AMC, QAN, BXB),
  `realestate` (GMG, SCG, GPT, VCX), `tech` (XRO, WTC, REA, CPU, ALU).

Then:

- `src/project.js` — `projectAu` + `australiaList` (copy `projectHk`/`hongkongList`, add `FILTER_FIELDS.au`).
- `server.js` — `readAustralia()` / `readAustraliaList()` / `readAustraliaSeries()`; endpoints
  `/api/australia`, `/api/australia/company/{code}`, `/api/australia/chart?code=&range=`; add `au:` to
  `searchIndex()`, `peerIndex()`, `PEER_BUCKET.au`, and to the peer "one per market" loop. `AUD` is
  already in `FX_CONV`.
- `public/index.html` — `AUSTRALIA` region button next to HONG KONG; bump the two `?v=` values.
- `public/app.js` — copy the whole Hong Kong block (`hk*` → `au*`): `CO_VIEWS.au`, `coScreenAu`,
  `AU_SCREEN_COLS`, `renderAustraliaScreen`, `renderAustralia(Market|Themes|Screener|Page)`,
  `drawAuChart`, `seriesFor` branch, `currentCmpRef`/`clearCompare`/`setCompare`, `syncCoTools`,
  `syncCmpClear`, the region-click loader text, `renderCompanies` dispatch, search routing, warm-up,
  compare input handlers (`au-cmp`), and the delegated click/change handlers (`data-au…`).
- `public/style.css` — `#p-deals[data-market="au"] { --mkt: #6f8f3f; }`.
- `package.json` — `build:australia`, `audit:australia`.
- `tests/asx.test.js` (CSV parse, `Not Applic` fallback, code/URL builders),
  `tests/australia-derive.test.js` (AUD vs USD reporter, missing FX, loss/negative equity, bands),
  `tests/australia-data.test.js` (cap = price × shares, ratio bounds, totals, sector partition, index,
  FX, list projection), plus `filters.test.js` entries and three `/api/australia` tests in `api.test.js`
  (copy the Hong Kong ones — one of them must assert a USD reporter is valued in USD).

---

## Gotchas learned on Hong Kong — do not repeat them

1. **Never record a throttle as a missing page.** `getCached` parks every worker on 429/403 and caches
   only real 404s. A company you could not fetch is `audit.throttled`, printed loudly; rerun to fill it.
2. **Two currencies.** See above. Store `reportCurrency`, ship it in the list payload, print it on the
   company page ("statements in USD"), and convert the cap at the build's rate.
3. **"Not Applic" is a real sector value** for 300 of the 2,060 rows. Do not print it; resolve it from
   the profile, then `'Other'`.
4. **ASX codes are 3 characters and collide with US tickers** (BHP, RIO, CSL). Search refs must carry the
   market (`au:BHP`), and the search index should add the ASX name and the profile name so both
   "BHP Group" and "BHP" find it.
5. **Half-yearly reporting.** Australian companies report H1/H2, so the "quarterly" page is half-year
   periods. Label the table **REPORTED PERIODS**, not quarters (Hong Kong already does).
6. **No daily price limit.** Small caps can double legitimately. Do not "sanitise" real moves; at most
   flatten a one-day spike that fully reverses within three sessions (bad print). Yahoo closes are
   already split-adjusted.
7. **Shares are a filing number.** Use diluted shares (fallback basic) from the income statement and
   label the cap as price × filing shares. Do not pull a cap from a screener.
8. **Statement page size** is ~200 KB × 4 pages × 2,060 companies. Cache everything on disk; the build
   must be resumable and must reuse the cache on `--skip-prices` / `--skip-fin`.
9. **Do not add ETFs, listed investment companies or debt.** The ASX CSV is companies only — keep it
   that way and count anything without a statement page instead of inventing a cap.
10. **Render's free instance** parses these files on first request: bucket the price series, keep the
    list artifact under ~1 MB, and never ship per-company history in the list endpoint.

---

## Verify before pushing

```sh
export PATH="$HOME/.local/node/bin:$PATH"
node --check scripts/*.mjs && node --check public/app.js
node scripts/build-australia.mjs --limit=30          # smoke first
node scripts/build-australia.mjs                     # full (resumable; expect ~1–2 h on a throttled day)
node scripts/build-australia.mjs --skip-prices --skip-fin   # attach profiles, re-derive from cache
node scripts/audit-australia.mjs
npm test
PORT=4911 node server.js &                            # then:
curl -s localhost:4911/api/australia | head -c 400
curl -s 'localhost:4911/api/australia/company/BHP' | head -c 400   # must say reportCurrency USD if it does
curl -s 'localhost:4911/api/australia/chart?code=BHP&range=5y' | head -c 200
curl -s 'localhost:4911/api/search?q=bhp' | head -c 300
```

Then open the local page: AUSTRALIA shows MARKET (ASX 200 level, breadth, 27 sector rows), SCREENER
(filters work, paging 25/50/100/250), THEMES (curated lists fill), and a company page with price, five
year record, reported periods, compare and cross-market peers. Only then `git push`.

## Acceptance criteria

- `australia.json` has **> 1,500 companies** with a positive price, a share count, a sector and a
  `reportCurrency`; every one reconciles `marketCap = price × shares`.
- At least the ten largest names by cap are present with a P/E, P/B and ROE that reproduce from their
  own inputs (the audit checks this).
- `audit.throttled` is 0, or the audit prints it as a warning and the build is rerun.
- Zero console errors in the browser; the other four markets still render.
