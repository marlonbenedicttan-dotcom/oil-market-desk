# HANDOFF — Commodity Desk (project brief for the next agent)

## What this is
A free, self-hosted **commodity + global-macro dashboard**. Paper-vs-physical oil, refining margins, curve, inventories, positioning, ships (AIS), satellites — plus metals & agriculture, a 14-pair currencies board, and live commodity↔currency link checks. The UI is a **two-tab product**: **COMMODITIES** (everything commodity-related) and **MACRO** (rates, inflation/growth, the currencies board, commodity↔currency links).

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
tests/            node:test (lib unit tests + API smoke tests) — run with `npm test`
Dockerfile, render.yaml, scripts/share.sh   deploy + free tunnel
```

### The registry (the key idea)
`BENCHMARKS` in `server.js` is a flat list of instruments; the whole UI is driven by it.
**Adding a commodity = one row.** Fields: `{ id, label, group, unit, dp, paper (Yahoo futures symbol), physical (FRED/EIA id or null), source }`.
- `group` drives the COMMODITIES tab grouping (Crude/Refined/Gas/Metals/Agriculture).
- `physical: null` ⇒ futures-only (metals/ags): shows price + % change, no gap.
- `paper: null` ⇒ spot-only (jet, propane): shows real price only.

### Markets (segments — the Big-Picture unit)
`MARKETS` sits **above** benchmarks — the unit the Big Picture is built around. A **market = a segment** that bundles related instruments. There are **seven segments**: **Crude oil** (WTI + Brent) · **Refined products** (RBOB + ULSD + Jet + Propane — all fuels merged into one) · **Natural gas** · **Precious metals** (gold/silver/platinum/palladium) · **Industrial metals** (copper) · **Grains** (corn/wheat/soy) · **Softs** (sugar/coffee/cocoa/cotton/palm).
Each market has a `primary` (headline instrument), `components`, and capability flags `hasBasis` / `hasInventories` / `hasShips` / `hasCurve` / `hasCOT` that decide which panels apply. Exposed at `/api/markets`. The Big Picture and the curve pickers select a **market**, not a raw benchmark.

### The Big Picture is adaptive
Picking a segment changes the panes. The **Bottom Line** becomes that segment's read, with three actionable blocks:
- **WHAT HAPPENED** — data-driven (what the numbers just did).
- **WHAT'S NEXT** — the catalysts to watch.
- **TRADE IDEAS — who benefits / who's in trouble** — sectors + example tickers.

The **"IS OIL ACTUALLY TIGHT?"** pane becomes **"IS <SEGMENT> TIGHT/STRETCHED?"**, using range / vol / positioning / curve. Insights, alerts and the "how extreme" panel all follow the segment (basis rows only for energy). Segment-specific blocks fold in: **ships & satellites** under Crude; **fuels (cracks) + sector stocks** under Refined; **supply** (US oil stockpiles + gas storage) under the energy segments; **hedge-fund positioning for every segment**.

`/api/marketread?id=<marketId>` assembles a per-market read server-side: price trend (1m/3m/6m/1y), 2-year range percentile, 30-day volatility + its percentile, curve shape, CFTC positioning (net / percentile / OI change), macro correlations (vs US dollar / VIX / S&P 500), and basis (energy only). It also returns a plain-English verdict with a 0–100 **"stretch"** score.

### Charting (COMMODITIES tab)
The **global segment picker** drives the whole tab: pick a segment and the chart, tiles and read all follow it. The **PRICES FOR MONTHS AHEAD** curve has a picker too — the **curve works for every segment** (see `CURVE_SPEC` — each root has its own exchange suffix NYM/CMX/CBT/NYB).
The commodity tile grid and the price-trends charts are now **one tab**. Clicking a tile (or a currency/link tile on the MACRO tab) selects it and renders the chart below. `renderChart()` resolves **any** metric — benchmark · `basis:<bench>` · `fx:<fx>` — across ranges **1M / 3M / 6M / YTD / 1Y / 5Y / 10Y** (spreads stay 6M-only). Hovering a point shows its **% change vs the window start**; clicking drops an anchor (●) to measure between two points. 6M draws the 5-year seasonal band; gap views draw p10/p90/median bands. Tiles carry a 6-month sparkline.

### API endpoints
`/api/market` (all instruments + gaps + quality flags),
`/api/markets` (segment registry — the Big-Picture unit),
`/api/marketread?id=<marketId>` (per-segment read + verdict + stretch score),
`/api/news?id=<segment|us|eu|jp|apac>` (tier-1 wire headlines via Google News RSS — headline + source + link only, never article text; cached 45 min),
`/api/transmission` (cross-asset: real-move triggers → coded transmission chains across segments & regions, e.g. oil↑→inflation→rates↑→precious-metals headwind; triggers are data, chains are a labelled framework),
`/api/history` (6M daily, all instruments + basis),
`/api/fx` (chartable currencies),
`/api/range?id=&range=1m|3m|6m|ytd|1y` , `/api/longterm?id=&years=` (both resolve `id` = benchmark | `basis:<bench>` | `fx:<fx>`) ,
`/api/curve` (WTI+Brent curve) , `/api/termstructure?id=` (curve for any one commodity) , `/api/positioning?id=<benchId>` (CFTC COT for any segment; default `wti`) ,
`/api/curvehistory?root=CL` , `/api/continuous?root=CL` , `/api/analytics` (percentiles/vol/arb),
`/api/analogue?metric=` , `/api/inventories` (+ gas storage) ,
`/api/equities` (sector watchlist) , `/api/macro` , `/api/macrodash` (rates + rateGap · inflation · growth · growthProxy copper÷gold · fx board · links commodity↔currency),
`/api/correlations` , `/api/events` , `/api/flows` , `/api/chokepoints` , `/api/reroute` , `/api/sar` , `/api/sar/image` , `/api/flares` ,
`/api/alerts` , `/api/digest` , `/api/export.csv` , `/api/seasonal?id=` , `/api/products` (+ crack history) , `/api/tightness` , `/health`.

## Data sources (all free)
| Need | Source | Key? |
|---|---|---|
| Futures (oil/metals/ags) | Yahoo Finance chart API | no |
| Spot/real (energy) | FRED CSV (`fredgraph.csv`) + EIA v2 | EIA key (free) |
| Inventories / gas storage | EIA v2 | EIA key |
| Positioning + open interest | CFTC Socrata (`6dca-aqww`) | no |
| Palm oil (front month) | Yahoo `CPO=F` | no |
| Ships (AIS) | aisstream.io WebSocket | free key |
| Satellites: radar pass + image | CDSE OData + AWS `sentinel-s1-l1c` | no |
| Gas flares (production proxy) | NASA FIRMS global 24h CSV | no |
| Macro | FRED CSV | no |
| FX | Yahoo | no |

**CFTC positioning is now available for every segment** via a `COT_NAMES` map (verified contract names): CRUDE OIL, LIGHT SWEET-WTI · CRUDE OIL, BRENT · GASOLINE RBOB · NY HARBOR ULSD · NATURAL GAS · GOLD · SILVER · COPPER · PLATINUM · PALLADIUM · CORN · WHEAT-SRW · SOYBEANS · SUGAR NO. 11 · COFFEE C · COCOA · COTTON NO. 2 · MALAYSIAN PALM OIL CALENDAR SW. Served at `/api/positioning?id=<benchId>` (default `wti`).

## Deploy (Render, free tier)
- Blueprint from GitHub → **auto-deploys on push to `main`** (~2–3 min). Secrets: `AISSTREAM_KEY`, `EIA_API_KEY` set in Render.
- Free tier **sleeps after 15 min** → a free **cron-job.org** ping every 5 min keeps it awake.
- `.env` (local only, git-ignored) holds the keys; **no secrets in the repo**.
- Basic auth available via `AUTH_USER`/`AUTH_PASS` (off by default).

## Known limitations (do NOT fake these)
1. **Roll-adjusted futures & curve-history** need ~25 contract-month quotes; **Yahoo rate-limits these from Render's IP**, so on the host they can be sparse. They're **lazy-loaded** (PRICE TRENDS tab) and self-hide if sparse. The main chart uses the reliable front-month (`CL=F`/`BZ=F`).
2. **Real-vs-futures gap** mixes a **lagged official spot** with live futures — flagged in "data checks". A clean fix is Dated Brent (paid).
3. **Metals/agri** have no free spot → futures-only. There is **no free real-vs-futures basis or inventories** for metals/agriculture — those would need LME/USDA feeds. Say so; never fake it.
4. **Coal** needs a paid feed. **Palm oil** is now free via Yahoo `CPO=F` (CME USD Malaysian Crude Palm Oil) — but only the **front month**, so it has **no month-by-month curve** (unlike the roots in `CURVE_SPEC`).
5. **FRED international macro** (non-US CPI/GDP/rates) is **stale/discontinued** — only **US** + **ECB rate** are current. **FX is fully live** (Yahoo), including the **commodity↔currency link correlations** — so no international CPI/GDP is shown rather than faking it.
6. **AIS in the Gulf is near-dark** (ships switch off) → we show activity levels + market-implied stress + reroute inference instead. **Ships/satellites are oil-only** — no ship or satellite layers for metals/ags.
7. Free tier **cold-starts** (~40s) after idle unless the cron ping runs.

## Roadmap / next steps
### Phase 3 — global macro (core shipped)
- **Currencies board** — 14 pairs via Yahoo: majors (DXY/EUR/JPY/GBP/CHF), EM (CNY/INR/MXN/ZAR) and **commodity currencies tagged with their link** (AUD=mining, CAD=oil, NOK=oil, BRL=ags, ZAR=gold, MXN=oil). ✔ live.
- **Commodity ↔ currency links** — a live **3-month daily-return correlation** per pair, judged against the *normal* sign and shown as **holding / weak / broken** (see the MACRO tab). All free (Yahoo). Sign note: on a `USD/xxx` pair the normal oil/gold correlation is **negative** (stronger dollar ↔ weaker commodity).
- **Rates** — US 2y/10y/fed funds **+ ECB deposit** are current, plus a **US–ECB policy-gap** tile (a classic dollar driver). More sovereigns need a live free source — **FRED international is stale/discontinued**.
- **Inflation/GDP** — **US current** (CPI YoY, real GDP QoQ, unemployment). Non-US CPI/GDP on free feeds is stale → deliberately **not** shown.
- **Growth proxy** — **copper ÷ gold** ratio + 3-month change (a free, live read on global risk-on / growth appetite).
- Still open: more *current* non-US yields/CPI/GDP if a free source appears.

### Phase C — commodity-aware Big Picture (✔ shipped)
The segment refactor is done. What landed:
1. **CFTC positioning for every segment** — a `COT_NAMES` map generalizes COT to all seven segments (verified names listed above). `getPositioning(marketId)` + `/api/positioning?id=<benchId>`.
2. **The Big Picture is adaptive** — the oil-only panes were replaced when a non-energy segment is picked: the Bottom Line is a generic *segment read* with WHAT HAPPENED / WHAT'S NEXT / TRADE IDEAS; "Is oil tight?" → **"Is <SEGMENT> tight/stretched?"** (positioning + range + vol + curve). Insights, alerts and the "how extreme" panel all follow the segment; basis rows remain **energy-only**.
3. **"How extreme is this?" per segment** — COT percentile + 2-year range percentile + 30-day vol percentile + per-segment macro correlations (vs USD / VIX / S&P 500), assembled by `/api/marketread?id=`.
   **Honest gaps (label, never fake):** no free real-vs-futures basis or inventories for metals/ags; ships/satellites are oil-only.

### Remaining polish
- **Accessibility pass** (keyboard nav, contrast, aria labels).
- **Regional refining margins** (USGC/NWE/Singapore) — needs regional product data (EIA has some).
- ~~Extend on-demand charting to any instrument~~ ✔ done — every benchmark, gap and currency charts at 1M–10Y.

## Conventions / gotchas
- Keep it **compact, plain-English, honest**. Explain *what it means* and *what to watch*.
- **Never** put secrets in the repo. `.env`, `.state.json`, `.reroute.json`, `.flares.json`, `digest.log` are git-ignored.
- After edits: `npm test` then `git push` (auto-deploys). Bump the `?v=` query on `style.css`/`app.js` in `index.html` if a cache issue appears.
- The service worker (`public/sw.js`) is **network-first** — don't make it cache-first again (caused stale-CSS pain).
- `server.js` is large (~1,100 lines); keep pure logic in `src/lib.js` so it stays testable.
