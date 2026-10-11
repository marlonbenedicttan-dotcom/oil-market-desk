# HANDOFF — Commodity Desk (project brief for the next agent)

## What this is
A free, self-hosted **commodity + global-macro dashboard**. Paper-vs-physical oil, refining margins, curve, inventories, positioning, ships (AIS), satellites — plus metals & agriculture, a 14-pair currencies board, and live commodity↔currency link checks.

- **Live:** https://oil-market-desk.onrender.com
- **Repo:** https://github.com/marlonbenedicttan-dotcom/oil-market-desk (public)
- **Local:** `~/projects/oil-basis` · run with `npm start` → http://localhost:4173
- **Stack:** zero-dependency Node (built-in `http`, `fetch`, `WebSocket`), vanilla JS front end. Node ≥ 22.

## Architecture
```
server.js         the whole backend (HTTP server + all data logic + schedulers)
src/lib.js        pure helpers (unit-tested): sgn, inBox, haversineNm, isoWeek,
                  monthly, pctOver, percentile, realizedVol, computeCracks, backAdjust
public/index.html tabs + panels
public/app.js     all front-end rendering + charting
public/style.css  Bloomberg-terminal dark theme
tests/            node:test (lib unit tests + API smoke tests) — 31 tests, `npm test`
Dockerfile, render.yaml, scripts/share.sh   deploy + free tunnel
```

### The registry (the key idea)
`BENCHMARKS` in `server.js` is a flat list of instruments; the whole UI is driven by it.
**Adding a commodity = one row.** Fields: `{ id, label, group, unit, dp, paper (Yahoo futures symbol), physical (FRED/EIA id or null), source }`.
- `group` drives the COMMODITIES tab grouping (Crude/Refined/Gas/Metals/Agriculture).
- `physical: null` ⇒ futures-only (metals/ags): shows price + % change, no gap.
- `paper: null` ⇒ spot-only (jet, propane): shows real price only.

### Markets (Big Picture groups)
`MARKETS` sits **above** benchmarks — the unit the Big Picture is built around. A market bundles related instruments, e.g. **Crude oil = WTI + Brent**. Eight markets: **Crude · Gasoline · Diesel/jet/LPG · Natural gas · Precious metals · Industrial metals · Grains · Softs**. Each has a `primary` (headline instrument), `components`, and capability flags (`hasBasis` / `hasInventories` / `hasShips` / `hasCurve` / `hasCOT`) that will decide which panels apply (Phase C). Exposed at `/api/markets`. The Big Picture and curve pickers select a **market**, not a raw benchmark.

### Charting (the merged COMMODITIES & PRICES tab)
BIG PICTURE has a **PICK A MARKET** panel (any of the 20 commodities — price, day %, 6-month move, jumpiness, range position, sparkline). The **PRICES FOR MONTHS AHEAD** curve has a picker too: choose any commodity and it fetches that root's contract months (see `CURVE_SPEC` — each root has its own exchange suffix NYM/CMX/CBT/NYB).
The commodity tile grid and the old PRICE TRENDS charts are now **one tab**. Clicking a tile (or a currency/link tile on the MACRO tab) selects it and renders the chart below. `renderChart()` resolves **any** metric — benchmark · `basis:<bench>` · `fx:<fx>` — across ranges **1M / 3M / 6M / YTD / 1Y / 5Y / 10Y** (spreads stay 6M-only). Hovering a point shows its **% change vs the window start**; clicking drops an anchor (●) to measure between two points. 6M draws the 5-year seasonal band; gap views draw p10/p90/median bands. Tiles carry a 6-month sparkline.

### API endpoints
`/api/market` (all instruments + gaps + quality flags), `/api/history` (6M daily, all instruments + basis),
`/api/markets` (Big-Picture market groups) , `/api/fx` (chartable currencies) , `/api/range?id=&range=1m|3m|6m|ytd|1y` , `/api/longterm?id=&years=` (both resolve `id` = benchmark | `basis:<bench>` | `fx:<fx>`) , `/api/curve` (WTI+Brent curve) , `/api/termstructure?id=` (curve for any one commodity),
`/api/curvehistory?root=CL` , `/api/continuous?root=CL` , `/api/analytics` (percentiles/vol/arb),
`/api/analogue?metric=` , `/api/inventories` (+ gas storage) , `/api/positioning` (+ open interest),
`/api/equities` (sector watchlist) , `/api/macro` , `/api/macrodash` (rates + rateGap · inflation · growth · growthProxy copper÷gold · fx board · links commodity↔currency),
`/api/correlations` , `/api/events` , `/api/flows` , `/api/chokepoints` , `/api/reroute` , `/api/sar` , `/api/sar/image` , `/api/flares` ,
`/api/alerts` , `/api/digest` , `/api/export.csv` , `/api/seasonal?id=` , `/api/products` (+ crack history) , `/health`.

## Data sources (all free)
| Need | Source | Key? |
|---|---|---|
| Futures (oil/metals/ags) | Yahoo Finance chart API | no |
| Spot/real (energy) | FRED CSV (`fredgraph.csv`) + EIA v2 | EIA key (free) |
| Inventories / gas storage | EIA v2 | EIA key |
| Positioning + open interest | CFTC Socrata (`6dca-aqww`) | no |
| Ships (AIS) | aisstream.io WebSocket | free key |
| Satellites: radar pass + image | CDSE OData + AWS `sentinel-s1-l1c` | no |
| Gas flares (production proxy) | NASA FIRMS global 24h CSV | no |
| Macro | FRED CSV | no |
| FX | Yahoo | no |

## Deploy (Render, free tier)
- Blueprint from GitHub → **auto-deploys on push to `main`** (~2–3 min). Secrets: `AISSTREAM_KEY`, `EIA_API_KEY` set in Render.
- Free tier **sleeps after 15 min** → a free **cron-job.org** ping every 5 min keeps it awake.
- `.env` (local only, git-ignored) holds the keys; **no secrets in the repo**.
- Basic auth available via `AUTH_USER`/`AUTH_PASS` (off by default).

## Known limitations (do NOT fake these)
1. **Roll-adjusted futures & curve-history** need ~25 contract-month quotes; **Yahoo rate-limits these from Render's IP**, so on the host they can be sparse. They're **lazy-loaded** (PRICE TRENDS tab) and self-hide if sparse. The main chart uses the reliable front-month (`CL=F`/`BZ=F`).
2. **Real-vs-futures gap** mixes a **lagged official spot** with live futures — flagged in "data checks". A clean fix is Dated Brent (paid).
3. **Metals/agri** have no free spot → futures-only.
4. **Coal** needs a paid feed. **Palm oil** is now free via Yahoo `CPO=F` (CME USD Malaysian Crude Palm Oil) — but only the **front month**, so it has **no month-by-month curve** (unlike the 17 roots in `CURVE_SPEC`).
5. **FRED international macro** (non-US CPI/GDP/rates) is **stale/discontinued** — only **US** + **ECB rate** are current. **FX is fully live** (Yahoo), including the **commodity↔currency link correlations** — so no international CPI/GDP is shown rather than faking it.
6. **AIS in the Gulf is near-dark** (ships switch off) → we show activity levels + market-implied stress + reroute inference instead.
7. Free tier **cold-starts** (~40s) after idle unless the cron ping runs.

## Roadmap / next steps
### Phase 3 — global macro (core shipped)
- **Currencies board** — 14 pairs via Yahoo: majors (DXY/EUR/JPY/GBP/CHF), EM (CNY/INR/MXN/ZAR) and **commodity currencies tagged with their link** (AUD=mining, CAD=oil, NOK=oil, BRL=ags, ZAR=gold, MXN=oil). ✔ live.
- **Commodity ↔ currency links** — a live **3-month daily-return correlation** per pair, judged against the *normal* sign and shown as **holding / weak / broken** (see the MACRO tab). All free (Yahoo). Sign note: on a `USD/xxx` pair the normal oil/gold correlation is **negative** (stronger dollar ↔ weaker commodity).
- **Rates** — US 2y/10y/fed funds **+ ECB deposit** are current, plus a **US–ECB policy-gap** tile (a classic dollar driver). More sovereigns need a live free source — **FRED international is stale/discontinued**.
- **Inflation/GDP** — **US current** (CPI YoY, real GDP QoQ, unemployment). Non-US CPI/GDP on free feeds is stale → deliberately **not** shown.
- **Growth proxy** — **copper ÷ gold** ratio + 3-month change (a free, live read on global risk-on / growth appetite).
- Still open: more *current* non-US yields/CPI/GDP if a free source appears.

### Phase C — commodity-aware Big Picture (planned; Phase A ✔ shipped)
Phase A ✔: `MARKETS` registry + Big-Picture/curve pickers now select a **market** (Crude = WTI + Brent).
Still to do, in order:
1. **Generalize CFTC positioning to every market** — `getPositioning(marketId)`; COT covers all of them (verified Gold/Silver/Copper/Corn/Wheat/Soy/Sugar/Coffee/Cocoa/Cotton/NatGas/Brent/WTI). Biggest content win.
2. **Replace the oil-only panels when a non-energy market is picked**: stress score → a generic *market read*; "Is oil tight?" → *"Is it stretched?"* (positioning + range + vol); per-market insights & alerts; keep the oil versions only for energy.
3. **Generic "How extreme is this?"** — add COT percentile + seasonality; per-market macro link via the existing `pairCorr`.
   **Honest gaps (label, never fake):** no free real-vs-futures basis or inventories for metals/ags; ships/satellites are oil-only.

### Remaining polish
- **Accessibility pass** (keyboard nav, contrast, aria labels).
- **Regional refining margins** (USGC/NWE/Singapore) — needs regional product data (EIA has some).
- ~~Extend on-demand charting to any instrument~~ ✔ done — every benchmark, gap and currency charts at 1M–10Y.

## Conventions / gotchas
- Keep it **compact, plain-English, honest**. Explain *what it means* and *what to watch*.
- **Never** put secrets in the repo. `.env`, `.state.json`, `.reroute.json`, `.flares.json`, `digest.log` are git-ignored.
- After edits: `npm test` (31 tests) then `git push` (auto-deploys). Bump the `?v=` query on `style.css`/`app.js` in `index.html` if a cache issue appears.
- The service worker (`public/sw.js`) is **network-first** — don't make it cache-first again (caused stale-CSS pain).
- `server.js` is large (~1,100 lines); keep pure logic in `src/lib.js` so it stays testable.
