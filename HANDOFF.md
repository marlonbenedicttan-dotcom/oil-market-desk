# HANDOFF — Commodity Desk (project brief for the next agent)

## What this is
A free, self-hosted **commodity + macro dashboard**. Paper-vs-physical oil, refining margins, curve, inventories, positioning, ships (AIS), satellites, macro — plus metals & agriculture.

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
tests/            node:test (lib unit tests + API smoke tests) — 23 tests, `npm test`
Dockerfile, render.yaml, scripts/share.sh   deploy + free tunnel
```

### The registry (the key idea)
`BENCHMARKS` in `server.js` is a flat list of instruments; the whole UI is driven by it.
**Adding a commodity = one row.** Fields: `{ id, label, group, unit, dp, paper (Yahoo futures symbol), physical (FRED/EIA id or null), source }`.
- `group` drives the COMMODITIES tab grouping (Crude/Refined/Gas/Metals/Agriculture).
- `physical: null` ⇒ futures-only (metals/ags): shows price + % change, no gap.
- `paper: null` ⇒ spot-only (jet, propane): shows real price only.

### API endpoints
`/api/market` (all instruments + gaps + quality flags), `/api/history` (6M daily, all instruments + basis),
`/api/range?id=&range=6m|ytd|1y` , `/api/longterm?id=&years=` , `/api/curve` (futures curve),
`/api/curvehistory?root=CL` , `/api/continuous?root=CL` , `/api/analytics` (percentiles/vol/arb),
`/api/analogue?metric=` , `/api/inventories` (+ gas storage) , `/api/positioning` (+ open interest),
`/api/equities` (sector watchlist) , `/api/macro` , `/api/macrodash` (rates/inflation/growth/FX),
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
4. **Coal & palm oil** need paid feeds.
5. **FRED international macro** (non-US CPI/GDP/rates) is **stale/discontinued** — only **US** + **ECB rate** are current. **FX is fully live** (Yahoo).
6. **AIS in the Gulf is near-dark** (ships switch off) → we show activity levels + market-implied stress + reroute inference instead.
7. Free tier **cold-starts** (~40s) after idle unless the cron ping runs.

## Roadmap / next steps
### Phase 3 — global macro (started)
- **Currencies board is the reliable core** (expand FX: majors + EM + commodity currencies AUD/CAD/BRL/MXN/INR/…). ✔ works via Yahoo.
- Rates: **US (2y/10y/fed funds) + ECB deposit** are current; add more only if a live free source is found (FRED international is stale).
- Inflation/GDP: **US current**; label international as delayed or omit.
- Idea: **commodity ↔ currency links** (AUD=mining, CAD=oil, BRL=ags, NOK=oil).

### Remaining polish
- **Accessibility pass** (keyboard nav, contrast, aria labels).
- **Regional refining margins** (USGC/NWE/Singapore) — needs regional product data (EIA has some).
- Extend **on-demand charting** to any instrument (already works via `/api/range`).

## Conventions / gotchas
- Keep it **compact, plain-English, honest**. Explain *what it means* and *what to watch*.
- **Never** put secrets in the repo. `.env`, `.state.json`, `.reroute.json`, `.flares.json`, `digest.log` are git-ignored.
- After edits: `npm test` (23 tests) then `git push` (auto-deploys). Bump the `?v=` query on `style.css`/`app.js` in `index.html` if a cache issue appears.
- The service worker (`public/sw.js`) is **network-first** — don't make it cache-first again (caused stale-CSS pain).
- `server.js` is large (~1,100 lines); keep pure logic in `src/lib.js` so it stays testable.
