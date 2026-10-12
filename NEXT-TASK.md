# NEXT TASK — add Aluminium + a Livestock segment (replace nickel)

**Read `HANDOFF.md` and `INVESTOR-ROADMAP.md` first.** Repo: `~/projects/oil-basis` (NOT a git repo
snapshot — it IS a git repo; `git push` to `main` auto-deploys to Render). Node: `export PATH="$HOME/.local/node/bin:$PATH"`.
Zero-dependency Node ≥22. Tests: `npm test` (~59, must stay green). Bump `?v=` in `public/index.html`
after client changes. **Never fake a number** — label the source + as-of.

## The task (from the user)
1. **Remove nickel** and **add Aluminium** to the **Industrial metals** segment.
2. **Add a new "Livestock" segment** (protein/food inflation — currently missing).
3. Be accurate, no bugs, and it must **auto-update** (it will, via the existing refresh loops).

## Why remove nickel (do not re-add it)
Nickel has **no free daily source**. `NI=F` is 404 on Yahoo; FRED `PNICKUSDM` is real ($/t) but
**monthly**. We used the WisdomTree Nickel ETC (`NICK.L`, daily) as a proxy — **measured accuracy is
poor**: monthly-return correlation vs real nickel = **0.71**, with months moving in *opposite*
directions (2026-07 ETC +5.4% vs nickel −5.4%). So it was removed as misleading.

## Verified free/daily data (Yahoo Finance chart API, no key) — use these
| Instrument | Yahoo symbol | Unit | Note |
|---|---|---|---|
| **Aluminium** | `ALI=F` | **$/t** (COMEX) | daily + 10y history; ~3,161 now (a 10y high) |
| **Live Cattle** | `LE=F` | ¢/lb (CME) | daily + 10y; ~225 |
| **Lean Hogs** | `HE=F` | ¢/lb (CME) | daily + 10y; ~75 |
| **Feeder Cattle** | `GF=F` | ¢/lb (CME) | daily + 10y; ~344 |

NOT available free/daily (don't try): nickel, LME aluminium/zinc/lead/tin, iron ore, lumber (`LBS=F` 404),
gas oil (`LGO=F` 404), uranium. Ethanol `EH=F` works but has only ~1y history (skip).

## Exact edits (all in `server.js` unless noted)
1. **`BENCHMARKS`** — DELETE the `nickel` row
   `{ id: 'nickel', label: 'Nickel', group: 'Metals', unit: 'USD', dp: 2, paper: 'NICK.L', physical: null }`.
   ADD (Metals group, after copper):
   `{ id: 'aluminium', label: 'Aluminium', group: 'Metals', unit: '$/t', dp: 0, paper: 'ALI=F', physical: null }`
   ADD (new Livestock group):
   `{ id: 'cattle', label: 'Live Cattle', group: 'Livestock', unit: '¢/lb', dp: 2, paper: 'LE=F', physical: null }`
   `{ id: 'hogs',   label: 'Lean Hogs',   group: 'Livestock', unit: '¢/lb', dp: 2, paper: 'HE=F', physical: null }`
   `{ id: 'feeder', label: 'Feeder Cattle', group: 'Livestock', unit: '¢/lb', dp: 2, paper: 'GF=F', physical: null }`
2. **`MARKETS`**
   - `industrial` components: `['copper','nickel']` → `['copper','aluminium']`.
   - ADD `{ id: 'livestock', label: 'Livestock', group: 'Livestock', primary: 'cattle', components: ['cattle','hogs','feeder'], hasBasis: false, hasInventories: false, hasShips: false }`.
3. **`MARKET_CONTENT`** — update `industrial` copy to Copper & Aluminium (remove nickel wording; e.g.
   tickers keep FCX/RIO/BHP/VALE, add `AA` (Alcoa), `CENX`; sectors "Copper & aluminium smelters",
   "Aerospace, packaging & autos" as users). ADD a `livestock` entry: tightQ e.g. "ARE CATTLE & HOGS TIGHT?",
   catalysts ['feed costs (corn/soy)', 'herd cycle & drought', 'export demand (China, Mexico)', 'disease (bird flu / swine fever)'],
   sectorsUp ['Protein producers & processors', 'Farm equipment & feed'], sectorsDown ['Restaurants & food makers', 'Consumers'],
   tickersUp ['TSN', 'JBS', 'PPC', 'SEB', 'ADM'], tickersDown ['MCD', 'CMG', 'YUM'], ideas '…'.
4. **`COUNTRY_COMMODITY_LINKS`** — replace Indonesia's `['Nickel','NICK.L']` with
   `['Aluminium','ALI=F']`; optionally add `['Live Cattle','LE=F']` to `brl` (Brazil is a big beef exporter).
5. **`getMarket()` `notes`** — DELETE the "Nickel uses the WisdomTree Nickel ETC…" line. Optionally add
   "Aluminium (COMEX ALI) and livestock (CME) are Yahoo futures — live, no key."
6. **`CURVE_SPEC`** (optional) — aluminium has COMEX contract months: try `aluminium: { root: 'ALI', exch: 'CMX' }`
   and verify `/api/termstructure?id=aluminium` returns contracts; if sparse, leave it out. Livestock: skip.
   (Physical tightness is `null` for all of these anyway — no basis/inventories — by design.)
7. **`tests/api.test.js`** — the `/api/markets` test asserts **7** segments → change to **8**.
   Add a small assertion that `aluminium` is in `industrial` and `livestock` exists with primary `cattle`.
   (The palm-oil/curve test and others are unaffected.)

No `public/` change should be needed — the segment picker, component strip, COMPARE, the read, and
attribution are all generic over `MARKETS`/`BENCHMARKS`. **Verify** that livestock shows up in the
segment picker (grouped) and the segments board.

## Auto-update — already handled, just confirm
Prices refresh every 60 s (client) / 3 min (server); history (deltas/sparklines) every 10 min;
country/attribution on the slow cycle. New symbols ride the existing `paperFor`/`hPaperFor` caches
keyed by symbol — no new plumbing. Do NOT add manual refresh steps.

## Verify before pushing (do all)
- `node --check server.js && node --check public/app.js`
- `npm test` → all green (fix the 7→8 count).
- Local server: `curl localhost:4910/api/markets` → industrial = copper,aluminium; livestock present.
  `curl '…/api/marketread?id=industrial&component=aluminium'` and `'…?id=livestock&component=hogs'` →
  sensible price + price-stretch; physical `null`. `curl '…/api/attribution?id=livestock'` → drivers.
- Then `git push` and poll the live site (Render, ~2–3 min) for the new payloads.

## Gotchas (learned this session — don't repeat)
- **Cache-key collisions**: `cached()` keys must be unique per (symbol, range). Two were found and fixed
  (`hp:` getSeasonal vs hPaperFor; `cur:` curveFor vs contractSeries). New symbols use the generic
  `p:/hp:/dl2y:/mrlt:` keys keyed by symbol → fine, but double-check any new key.
- **Monthly ≠ daily**: don't put monthly series (e.g. FRED IMF prices) behind the daily 1D/1W delta UI.
- **Blocked hosts**: the deploy host (Render) gets a **403 from imf.org**; IMF/OECD data is served via a
  committed snapshot (`scripts/fetch-macro.mjs` → `data/macro.json`, refreshed weekly by a launchd job).
  Use that pattern for any source Render can't reach. FRED, Yahoo, BIS, World Bank, EIA all work from Render.
- **Dockerfile**: if you add a new top-level dir the app reads at runtime, add `COPY <dir>` (a missing
  `COPY data ./data` once broke the macro snapshot).
- Run tests serially (external APIs); the suite hits live feeds and can be flaky.
