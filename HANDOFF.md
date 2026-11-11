# HANDOFF — Marlon's Watchtower (brief for the next agent)

> **Briefing a new AI agent? Paste `AGENT-BRIEF.md`** — a short, ready-to-use prompt with the
> environment, the hard rules and the working style. Then read this file for the detail.

## What this is
A free, self-hosted **commodity + global-macro dashboard**. Three tabs: **HOME** (watchlist + alerts + segments at a glance), **COMMODITIES** and **MACRO**. It gives each commodity segment and each macro country an adaptive, plain-English read with trade ideas — plus charts, curves, supply data, live ships and a news/fundamentals scanner.

- **Live:** https://oil-market-desk.onrender.com
- **Repo:** https://github.com/marlonbenedicttan-dotcom/oil-market-desk (public, auto-deploys on push to `main`)
- **Local:** `~/projects/oil-basis` · run with `npm start` → http://localhost:4173
  - **Node is at `~/.local/node/bin/node`** (not on the default PATH) — `export PATH="$HOME/.local/node/bin:$PATH"` first.
- **Stack:** zero-dependency Node (built-in `http`, `fetch`, `WebSocket`) + vanilla JS/Chart.js + Leaflet. Node ≥ 22.

## Architecture
```
server.js         the whole backend (HTTP server + all data logic + schedulers)  ~1,800 lines
src/lib.js        pure helpers (unit-tested): sgn, inBox, haversineNm, isoWeek, monthly,
                  pctOver, percentile, realizedVol, computeCracks, backAdjust, pearson, logReturns,
                  horizonDeltas (1D/1W/1M/YTD/1Y), curveTightness, inventoryTightness, weightedScore,
                  seasonalGrade, seasonalAhead, contractMonthsBetween
public/index.html tabs + panels (3 tabs: HOME, COMMODITIES, MACRO)
public/app.js     all front-end rendering, charts, adaptive logic
public/style.css  Bloomberg-terminal dark theme
tests/            node:test — 53 tests (lib unit tests + API smoke tests), `npm test`
Dockerfile, render.yaml, scripts/share.sh   deploy + free tunnel
```
Keep pure logic in `src/lib.js` so it stays testable.

## The registries (the key ideas)

### `BENCHMARKS` — the data layer
A flat list of instruments; the whole UI is driven by it. **Adding a commodity = one row.**
Fields: `{ id, label, group, unit, dp, paper (Yahoo futures symbol), physical (FRED/EIA id or null), source }`.
- `physical: null` ⇒ futures-only (metals/ags): price + %, no gap.
- `paper: null` ⇒ spot-only (jet, propane): real price only.
- Current instruments (31): WTI, Brent, RBOB, ULSD, Jet, Propane, NatGas, Gold, Silver, Copper, **Aluminium**, Platinum, Palladium, Corn, Wheat, Soybeans, **Soybean Meal, Soybean Oil**, Sugar, Coffee, Cocoa, Cotton, **Palm Oil** (Yahoo `CPO=F`, front-month only — no curve), **Live Cattle, Lean Hogs, Feeder Cattle**, **Class III Milk, Butter, Nonfat Dry Milk, Cheddar Cheese, Dry Whey**.

### `MARKETS` — the segment layer (Big-Picture unit) — **9 segments**
```
crude       Crude oil          WTI + Brent
refined     Refined products   RBOB + ULSD + Jet + Propane   (all fuels merged)
gas         Natural gas        NatGas
precious    Precious metals    Gold + Silver + Platinum + Palladium
industrial  Industrial metals  Copper + Aluminium
grains      Grains & oilseeds  Corn + Wheat + Soybeans + Soybean Meal + Soybean Oil
softs       Softs              Sugar + Coffee + Cocoa + Cotton + Palm Oil
livestock   Livestock          Live Cattle + Lean Hogs + Feeder Cattle
dairy       Dairy              Milk + Butter + Nonfat Dry Milk + Cheese + Dry Whey
```
Each has `primary` (headline instrument), `components`, and capability flags `hasBasis / hasInventories / hasShips / hasCurve / hasCOT`. Exposed at `/api/markets`. The COMMODITIES picker selects a **segment**, and the tiles/chart are scoped to it.

### `MACRO_COUNTRIES` — the macro regions/countries — **6 regions**
```
us     United States
eu     Euro area, Germany, UK, France
jp     Japan
cn     China, Hong Kong
in     India
apac   Singapore, Indonesia, Thailand, Malaysia, Philippines, Vietnam, South Korea, Australia, Taiwan
```
Each country has a verified-live Yahoo `fx` + `index`, a World Bank `iso3`, an `oil` exposure (importer/exporter), and (where available) a BIS `area` for the policy rate. Exposed at `/api/countries`.

## Front-end layout (investor-first, 3 tabs)

**Hero:** the **live important-headlines board** (`#headlines`, `/api/headlines`, tier-1 wire, ranked by event materiality + recency, auto-refresh 10 min) now lives at the **top of the HOME tab** — it is no longer pinned above the tabs on every page.

**Top ticker (`#ticker`):** animated marquee. On **HOME**/**COMMODITIES** it shows all commodities + currencies; on **MACRO** it shows the **full macro tape** (`/api/macro-tickers`, all 34 currencies+indices).

**HOME tab (default landing):** **📰 LIVE HEADLINES** (`/api/headlines`, tier-1 wire) → **☀️ DAILY BRIEF** (`/api/brief`: headline + what happened / what's on today) → **📌 WATCHLIST** — pinned instruments from any segment in one board (each tile shows price + 1D/1W/1M/YTD/1Y + a source/as-of badge; ★ toggles) → **⚠ ALERTS** — the server alert engine (`/api/alerts`: basis extremes, data checks, idle ships) merged with the client threshold engine, severity-sorted → **🔎 SEGMENTS AT A GLANCE** — the 9-segment board (click to open).

**COMMODITIES tab** (order = decision-first): PICK A SEGMENT + snapshot → **🎯 THE READ** (price/physical score · what happened · key points · what's next · trade ideas with benefits-vs-trouble sectors+tickers) → **🔗 HOW IT TRANSMITS** (cross-asset) → **INSTRUMENTS** tiles → **PRICE HISTORY** chart (1M–10Y, hover %) → **⚖️ COMPARE / SPREAD** (overlay any two chartable series; indexed or difference) → **PRICES FOR MONTHS AHEAD** curve (follows the segment; numeric roll yield + calendar spreads) → gas/grains/softs-only **🌱 SEASONALITY** (vs the 5-yr norm) → **IS <SEGMENT> TIGHT/STRETCHED** → refined-only **REFINING MARGINS** + **WHO IT HELPS/HURTS** → energy-only **SUPPLY** (inventories/storage) → **🔬 FUNDAMENTALS** (auto-tagged events) → **📰 IN THE NEWS** → folded **SHIPS & SATELLITES** (crude only) → folded **MORE DETAIL** (flags, how-extreme, analogue). Panels tagged `data-when="..."` (market ids, `*` = always) show/hide per segment via `toggleMarketBlocks()`.

**MACRO tab:** REGION & COUNTRY picker → **country card dashboard** (Bloomberg-style cards: MARKET / RATES & INFLATION / GROWTH & DEBT / COMMODITY LINKAGE / KEY TAKEAWAYS / CROSS-ASSET) → **CENTRAL BANK RATE** history chart → **CPI** chart → **INDEX vs CURRENCY** chart (both indexed to 100, hover %) → **CURRENCIES** (scoped to the region) → **REGIONAL NEWS** (importance-ranked) → catalysts.

## API endpoints
```
/api/market                 all instruments + gaps + quality flags (rows carry curve/cot flags)
/api/history               6M daily, all instruments + basis
/api/range?id=&range=1m|3m|6m|ytd|1y      daily series (resolves idle bench | basis:<id> | fx:<id>)
/api/longterm?id=&years=   multi-year, monthly (same id resolution)
/api/fx                    chartable currencies
/api/rates                 chartable rates (FRED): real 10y, nominal 10y, 2y
/api/markets               the 9 segments (registry + component meta)
/api/marketread?id=<seg>   per-segment read: price trend, 2-yr range pctile, vol pctile,
                           curve, macro links, basis, a 0-100 'stretch' verdict + takeaways
/api/termstructure?id=     the curve for ONE commodity (contract months)
/api/curve                 WTI+Brent curve (used by digest/market)
/api/curvehistory?root=    m1-m2 over time (NYMEX energy roots only)
/api/analytics             percentiles/vol/arb
/api/analogue?metric=      "last time it was this extreme"
/api/inventories           EIA weekly (crude/cushing/gasoline/distillate/SPR) + gas storage
/api/positioning?id=       CFTC COT (kept; NOT surfaced in the UI — user doesn't want it)
/api/macro /api/macrodash  macro context / rates+inflation+growth+growthProxy+fx+links+regions
/api/correlations          oil vs dollar/VIX/S&P
/api/countries             macro regions → countries (registry)
/api/country?id=           one country: fx, index, official macro (US/EU), World Bank fund
                           (gdpGrowth series, debtToGdp, inflation, unemployment), policy (BIS:
                           latest+history) or policyNote, oilLink, links (its commodities),
                           perf (1y), cpi (annual series), takeaways
/api/country-series?id=&range=   index + fx series (for the macro chart)
/api/region-quotes?id=     one region's currencies+indices (kind: fx|index)
/api/macro-tickers         ALL macro tickers (the tape)
/api/news?id=              tier-1 headlines per segment OR region OR country
/api/macro-news?id=        importance-ranked macro news (central bank/sovereign/politics/geo)
/api/headlines             ranked, event-tagged commodity headlines (hero board)
/api/fundamentals?id=      event scanner over recent + past-year coverage (weather/sanctions/strikes…)
/api/transmission          cross-asset transmission engine (real moves → coded chains)
/api/events /api/flows /api/chokepoints /api/reroute /api/sar /api/sar/image /api/flares
/api/alerts /api/digest /api/brief /api/export.csv /api/seasonal?id= /api/products /api/crush /health
```

## Data sources (all free)
| Need | Source | Key? |
|---|---|---|
| Futures, FX, indices | Yahoo Finance chart API | no |
| US + euro-area macro (rates, CPI, HICP) | FRED CSV (`fredgraph.csv`) | no |
| Annual fundamentals per country (GDP growth, debt/GDP, CPI, unemployment) | **World Bank** API | no |
| Grain/oilseed/dairy/livestock **stocks-to-use** (US balance) | **USDA PSD** (FAS) bulk CSV → `data/usda.json` snapshot | no |
| Central-bank policy rates (latest + history) | **BIS** `WS_CBPOL` (request CSV via `Accept: application/vnd.sdmx.data+csv`) | no |
| Positioning (COT) | CFTC Socrata (`6dca-aqww`) | no |
| Inventories / gas storage / spot | EIA v2 | EIA key (free) |
| Headlines / news | Google News RSS (`news.google.com/rss/search?q=`) | no |
| Ships (AIS) | aisstream.io WebSocket | free key |
| Gas flares | NASA FIRMS global 24h CSV | no |
| Radar satellite | CDSE OData + AWS `sentinel-s1-l1c` | no |

## Deploy (Render, free tier)
- Blueprint from GitHub → **auto-deploys on push to `main`** (~2–3 min). Secrets `AISSTREAM_KEY`, `EIA_API_KEY` set in Render.
- Free tier sleeps after 15 min → a cron-job.org ping every 5 min keeps it awake.
- `.env` (local only, git-ignored) holds keys. **No secrets in the repo.**
- Bump `?v=` on `style.css` / `app.js` in `index.html` after front-end changes (the SW is network-first but browsers cache hard).

## Known limitations (do NOT fake these)
1. **Contract-month chains** (roll-adjusted, curve-history) need ~25 Yahoo quotes; Yahoo rate-limits these from Render's IP, so on the host they can be sparse. The curve-history is NYMEX-energy-only and self-hides otherwise.
2. **Real-vs-futures gap** mixes a **lagged official spot** with live futures — flagged in "data checks". Metals/ags have **no free spot → futures-only**.
3. **No free basis or inventories for metals & agriculture** (needs LME/USDA). Labelled, never invented.
4. **International macro on FRED is stale** — only **US** and **euro-area** official macro are current. Japan/China free CPI/GDP lag by 1–3 years → not shown; those countries show market data + headlines instead.
5. **World Bank fundamentals are annual** and can be old (e.g. Indonesia's debt/GDP latest is 2009). Always labelled by year; debt/GDP is suppressed when the year is pre-2018.
6. **Country gaps:** Singapore has **no policy rate** (MAS runs S$NEER FX policy — benchmark is SORA, not wired); Taiwan/Vietnam/Philippines have no BIS policy rate. **Stock indexes:** Thailand's Yahoo index (`^SET.BK`) is broken and the Philippines/Vietnam indexes aren't free, so those three now use **trusted US-listed ETF proxies** — `THD` (iShares MSCI Thailand), `EPHE` (iShares MSCI Philippines), `VNM` (VanEck Vietnam) — labelled "ETF proxy" in the UI. (They're USD-denominated, so on the index-vs-currency chart those three double-count FX; the alternative was showing nothing.)
7. **AIS in the Gulf is near-dark** → we show activity levels + market-implied stress + reroute inference instead.
8. **Ships/satellites are oil-only.**
9. **News/event tagging is keyword-based** — a prompt to investigate, always linking to the source. Not a verdict. Google News RSS is undocumented and can rate-limit; endpoints self-degrade.
10. Free tier **cold-starts** (~40 s) after idle.

## Conventions / gotchas
- Keep it **compact, plain-English, honest**. Explain *what it means* and *what to watch*. **Never fake a number.**
- **Never** put secrets in the repo. `.env`, `.state.json`, `.reroute.json`, `.flares.json`, `digest.log` are git-ignored.
- After edits: `npm test` (**53 tests**) then `git push` (auto-deploys). Bump the `?v=` query in `index.html`.
- The service worker (`public/sw.js`) is **network-first** — don't make it cache-first.
- **Front-end request guards matter**: `loadCountry`/`loadCountryChart`/`loadMacroNews` capture `req` and bail if the selection changed, so a slow earlier response can't overwrite the newer choice. The client also caches country payloads (`countryCache`, 5 min) and **prefetches the region** so switching is instant.
- `server.js` is large; keep pure logic in `src/lib.js`.

## Roadmap — investor backlog (do these ONE AT A TIME; each = code + tests + deploy)
> See **`INVESTOR-ROADMAP.md`** for the investor-value backlog (surface COT positioning, a
> cross-asset regime board, a screener/leaderboard, custom alerts, an economic calendar) — written
> after a full review. It supersedes this list in priority; #9 here is cosmetic.
> For **quality** — trust/timestamps, accessibility, wording, IA, SEO/PWA completeness — see
> **`POLISH-ROADMAP.md`** (a full audit with evidence). Do its **quick wins 1–5** before the feature
> backlog; they are small and high-visibility.
> ✅ **DONE (2026-10-13) — `NEXT-TASK-2.md`**: (1) the mobile top bar is now one tidy row and the
> ticker is a JS `requestAnimationFrame` marquee (never `:hover`, honours Reduce Motion). NB: that
> fix **had been written but never committed**, so the live site was still serving the frozen CSS
> marquee — it is now committed + deployed. (2) news matching has a pure context guard
> (`newsContextOk` in `src/lib.js`) that drops sports/entertainment/surname hits ("Adam Silver"/NBA
> on silver) without over-filtering real coverage. Next: see `INVESTOR-ROADMAP.md`.
Agreed order (impact-weighted):
1. ~~**Deltas + freshness everywhere** — every number shows chg vs 1d/1w/1m/YTD/1y, plus a source + as-of badge.~~ **DONE (2026-10-12)** — pure `horizonDeltas` in `src/lib.js`; `/api/history` carries per-instrument deltas, `/api/market` rows carry source + as-of, `/api/country` + `/api/region-quotes` carry deltas; instrument tiles, segment snapshot, top ticker, country cards and the region currency board all show a 1D/1W/1M/YTD/1Y strip + a source/as-of badge. Deltas come from a 2-year daily window (a plain 1y range leaves the 1Y move null). The macro marquee tape stays 1D; structure data (inventories/curve/COT) keeps its existing as-of labels.
2. ~~**Fundamental "stretch" score** — rebuild the score from curve + basis + inventories-vs-seasonal (not just price range/vol), or rename it "price stretch".~~ **DONE (2026-10-12)** — split into two honest scores: **price stretch** (price range + vol, renamed) and **physical tightness** (curve + real-vs-futures basis + stocks-vs-seasonal, re-weighted over whatever exists; pure helpers `curveTightness`/`inventoryTightness`/`weightedScore` in `src/lib.js`). Precious metals are excluded from the curve input (their curve is rates/carry, not tightness) so they show "no free data" rather than a fake number. Metals/ags are curve-only; the panel notes what's missing. **v3 (same day):** "price stretch" is now a **signed** read (−100 = cheap/washed-out … +100 = rich), built from signed range position (2y + 10y) and signed, self-normalised 3-mo/1-yr moves. The old symmetric version scored a market at its **lows** as "stretched" (lean hogs at 2-yr lows read 78/STRETCHED) — direction now carries through, and the blend is a plain re-normalised mean so no single input can hijack it. Volatility left the score (not directional, double-counted the move) and shows as its own line. Pure helpers `signedPosition`/`signedMove`/`stretchLabel`/`stretchScore`.
3. ~~**Watchlist + Alerts home screen** — pin instruments, one board, alerts firing.~~ **DONE (2026-10-12)** — new **HOME** tab (default landing): a cross-segment **watchlist** board (pinned instruments, reusing the deltas + freshness tiles), an **alerts** board merging the server engine (`/api/alerts` — basis extremes, data checks, idle ships; previously never fetched by the UI) with the client threshold engine, severity-sorted, plus the 8-segment board (revived the dead `renderMarketState`). Thresholds still edited in COMMODITIES → MORE DETAIL.
4. ~~**On-screen daily brief** — "what happened / what's on today" in 60 seconds.~~ **DONE (2026-10-12)** — new structured `/api/brief` (JSON: headline, `happened[]`, `next[]`, `alerts[]`, `movers[]`) built from the day's biggest 1D movers, the WTI curve, the crude-stocks-vs-seasonal surprise, upcoming events and the server alerts. HOME leads with a **DAILY BRIEF** panel rendering it. The raw-text `/api/digest` is kept for email/log.
5. ~~**Compare / spread charts** — overlay two series (Brent–WTI, oil vs dollar, gold vs real yields), % view.~~ **DONE (2026-10-12)** — **COMPARE / SPREAD** panel on COMMODITIES: any two chartable series (commodities, currencies, rates), range 1M–1Y, view = Indexed to 100 or Difference, presets (Brent−WTI, oil vs dollar, gold vs dollar, gold vs real yield, copper vs oil). Added a chartable `rate:` kind via FRED (real 10y `DFII10`, nominal 10y `DGS10`, 2y `DGS2`) + `/api/rates`.
6. ~~**Seasonality surfaced** — a "vs 5-yr seasonal" grade for gas/grains/softs.~~ **DONE (2026-10-12)** — `/api/seasonal` now returns `grade` (0-100 position in the 5-yr day-of-year band + label + vs-median) and `ahead` (the normal median-path move over the next month), via pure `seasonalGrade`/`seasonalAhead` in `src/lib.js`. A **SEASONALITY** panel on COMMODITIES (gas/grains/softs) shows the grade, a low—median—high bar with a marker for now, and a plain read. Deliberately gated to gas/grains/softs — metals' "seasonality" is really a secular trend.
7. ~~**Numeric curve & carry** — calendar spreads + implied roll yield in $ terms.~~ **DONE (2026-10-12)** — `buildCurve` returns `rollMonthly` ($/unit/month), `rollMonthlyPct`, `rollYieldAnn` and a `calendar[]` ladder (adjacent month spreads, true gaps via pure `contractMonthsBetween`). The curve panel shows a roll-yield line (+X/unit/month ≈ Y%/yr, paid vs costs) and the calendar ladder under each curve.
8. ~~**Collapse redundant reads** — merge Key Takeaways + What it means + Reading the numbers + How extreme into one read + a detail fold.~~ **DONE (2026-10-12)** — COMMODITIES now has one **🎯 THE READ** panel (price/physical score | what happened | key points | what's next, plus a full-width trade-ideas row); the old KEY TAKEAWAYS panel and the READING THE NUMBERS insights are merged in (dead `insightsFor`/`marketInsights`/`renderInsights` removed); ship insights moved into the ships fold; the detail fold keeps flags, how-extreme and analogue. Same session: the **live headlines board moved off the top of every page into the HOME tab**.
9. **Single macro picker** (region+country → one grouped country picker) and merge the 3 country charts into one small multi-panel.

### Remaining polish
- Accessibility pass (keyboard nav, contrast, aria).
- Regional refining margins (USGC/NWE/Singapore).
- Dead code: `renderKPIs`, `renderRegime`, `renderBottomLine`, `renderTightness`, `renderContext`, `computeAlerts` remain defined but unused after the adaptive rewrite — safe to delete.

## Latest (2026-10-13)
- **Mobile top bar + ticker — shipped.** The intended fix (rAF marquee + one-line header) had been
  written but left **uncommitted**, so the live site still served the CSS marquee with the
  `@media (hover: hover)` pause (iOS latches `:hover` after a touch → frozen tape) and the 2-line
  header. Committed + deployed: `style.css?v=29`, `app.js?v=68`. The tape never uses `:hover`; a
  press pauses it; Reduce Motion is honoured (and resumes on toggle); soft edge fades. Verified on
  the **live** URL at 390×844 via headless Chrome: no sideways scroll, header 54px one row, 38px
  taps, transform advancing.
- **News context guard (all news, all graphs, all commodities AND countries).** Pure
  `newsContextOk(title, { domain })` in `src/lib.js` is the single filter. **Commodity domain:**
  drops sports/entertainment and a commodity used as a surname ("Adam Silver"/NBA → silver), and
  requires market framing only for homonym-prone words (gold/silver/corn/coffee/…), so unambiguous
  coverage ("cattle ranchers", "cocoa regulator") survives. **Macro domain:** requires an
  economy/market story, so "US Open" / "Japan film" never attach to a country. Wired into every
  path — `titleMatches` (`getNews` / `getFundamentals` / `getAttribution`), `getMoveWho` (commodity
  **and** macro charts), `getHeadlines`, `getMacroNews`. 66 tests (3 new). Live check: 0 leaks
  across all countries/regions; macro chart markers now show Fed/BOJ/ECB/China-stimulus stories.
- **Mobile refinements + professional-polish pass 1 (2026-10-13).** Ticker speed made identical to
  desktop (one copy / 120 s); boot splash is now full-screen (was `z-index:200`, below the sticky
  header); smaller refresh/help buttons with space after the clock; segment/country pickers got a
  visible amber chevron (the native arrow was near-black) and are 44px full-width on phones. Then
  `POLISH-ROADMAP.md` items **1–4**: a header freshness **dot** (green/amber/red, visible on phones)
  replacing the confusing `prices 1:53:58 PM`; a11y (icon-button labels, a real `tablist` + arrow
  keys, a **ticker pause/play** control for WCAG 2.2.2, onboarding `role="dialog"` with Escape +
  focus trap, error banner `role="alert"`); PNG icons 192/512 + apple-touch-icon + a **1200×630 OG
  image** (the old `og:image` was an SVG → blank link previews) + refreshed manifest; and a styled
  **404 page** + `<noscript>` note + `.png` MIME + a single `theme-color`. `style.css?v=33`,
  `app.js?v=70`. 66 tests.
- **Professional-polish pass 2 (2026-10-13) — `POLISH-ROADMAP.md` items 5–6.** (5) Every panel state
  now uses one voice + one look via `stLoading` / `stEmpty` / `stError` (+ a shared `.state` style:
  a pulsing dot for loading, a calm "nothing here" for empty, "couldn't load … — retrying" for
  errors), replacing ~25 ad-hoc strings; boot status capitalised. (6) A **📖 DATA & METHODOLOGY**
  section in the footer — a sources/freshness table, what both scores mean, how basis works, the
  rules and the caveats — sourced from `METHODOLOGY` in `src/lib.js` (served at
  `/api/market.methodology`) so it can't drift; unit-tested. `style.css?v=35`, `app.js?v=72`. 67 tests.
- **Professional-polish pass 3 (2026-10-13) — `POLISH-ROADMAP.md` item 7 (IA).** A sticky in-page
  **jump-nav** on HOME (Brief · Watchlist · Alerts · Headlines · Segments) that pins just under the
  top bar (a `--topbar-h` var set from the header's real height) and scroll-margins the targets clear;
  a **score key** under THE READ scores (`−100 cheap → +100 rich · 0 oversupplied → 100 undersupplied`)
  plus `title` tooltips on both score numbers; and **heading consistency** — every panel header now
  carries one emoji (PRICE HISTORY, PRICING, WHO IT HELPS/HURTS, SUPPLY, CURRENCIES, CATALYSTS, HOW
  EXTREME, LAST TIME, INSTRUMENTS, …). `style.css?v=36`, `app.js?v=73`. 67 tests.
- **Professional-polish pass 4 (2026-10-13) — `POLISH-ROADMAP.md` item 8 (robustness).** Every chart
  now carries a text alternative (`role="img"` + an `aria-label` naming the series and latest values,
  set in `mountChart`); if the Chart.js or Leaflet CDN fails, the chart shows "Charts are unavailable
  right now…" and the map shows "Map unavailable…" instead of throwing. Every response sets
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` and a
  **report-only** CSP (verified 0 violations, 0 console errors across all tabs). `app.js?v=74`. 68 tests.
- **Professional-polish pass 5 (2026-10-13) — `POLISH-ROADMAP.md` item 9 (transfer size + build stamp).**
  Static assets and API JSON are now compressed on the fly with the built-in `zlib` (brotli when the
  client asks, else gzip), cached per file+mtime — `app.js` 149 KB→47 KB, `/api/market` 12.3 KB→2.8 KB.
  `/health` and `/api/market` expose a **build stamp** (`RENDER_GIT_COMMIT`, else `GIT_SHA`, else `dev`),
  and the footer shows it, so "am I on the new build?" is answerable. New api tests. `app.js?v=75`.
  70 tests. **This completes `POLISH-ROADMAP.md` (items 1–9).**
- **INVESTOR-ROADMAP #1 — positioning surfaced (2026-10-13).** A **📊 POSITIONING** panel on
  COMMODITIES: managed-money net, **3-yr percentile**, WoW change, long/short split, open interest,
  a 3-yr net sparkline, and a **CROWDED LONG / STRETCHED / WASHED-OUT / NEUTRAL** flag + plain read.
  `/api/positioning?segment=<seg>` bundles every COT-covered component in one call; the single-series
  mode gained `long`/`short`/`pct3y`/`weeks`/`flag`/`read`. The daily brief adds a positioning line
  when crude is crowded (≥90th or ≤10th pctile). Pure `positioningFlag`/`positioningRead` in
  `src/lib.js` (unit-tested). Label is honest: "CFTC · managed money · weekly · as of <date>".
  `style.css?v=37`, `app.js?v=76`. 72 tests.
- **INVESTOR-ROADMAP #2 — cross-asset regime board (2026-10-13).** A **🌐 MARKETS AT A GLANCE** panel
  on HOME: DXY · VIX · US 10y · S&P 500 · gold · copper · WTI · Brent, each with its level, a
  **1D/1W/1M/YTD/1Y strip** and a source/as-of line. Served by **`/api/regime`** (Yahoo + FRED, no new
  source). A yield can't show a % move, so the 10y uses the new pure **`horizonDeltasAbs`**
  (`src/lib.js`, tested) and renders the strip in **basis points**. Gotcha logged: the board div is
  `#regime-board`, NOT `#regime` — the legacy market-state line already owns `#regime`. A HOME
  **jump-nav** chip ("Regime") added. `style.css?v=38`, `app.js?v=77`. 74 tests.
- **INVESTOR-ROADMAP #3 — screener / leaderboard (2026-10-13).** A **🔎 SCREENER** panel on HOME:
  all 31 instruments in one **sortable** table — INSTRUMENT · LAST · 1D/1W/1M/YTD/1Y · STRETCH ·
  TIGHT · BASIS% · CROWD — click a header to sort, a row to open its chart. Assembled server-side by
  **`/api/screen`** (deltas, the two `marketread` verdict scores, `analytics` basis percentiles,
  `getPositioning` CROWD). NB the read's scores live under **`verdict.priceStretch` /
  `verdict.supplyDemand`**, not top-level. `style.css?v=39`, `app.js?v=78`. 75 tests.
- **INVESTOR-ROADMAP #4 — custom alerts (2026-10-13).** A **⚙ MY RULES** builder in the HOME alerts
  panel: pick a **metric** (any instrument price, any real-vs-futures basis, any currency when the
  fx quotes have landed), a **condition** (`is above` / `is below` / `crosses`), a level and an
  optional note. Rules persist in `localStorage['oilbasis.rules']`, are evaluated on every refresh
  (merged into `allAlerts`), show as WATCH entries and fire a **browser notification**. Honest
  footnote: checked client-side while the tab is open. `style.css?v=40`, `app.js?v=79`. 75 tests.
- **FIX — the READ's KEY POINTS now follow the chosen instrument (2026-10-13).** Bug: `getMarketRead`
  called `getFundamentals(id)` with the **segment** id, so Softs + sugar picked up cotton (and cocoa,
  …) events — and `getNews` did the same for the 📰 IN THE NEWS panel. Both now take a
  `componentId`: they query the **chosen instrument** (`<label> (tier1)` for news, `<label> (events)`
  for fundamentals), then keep only headlines that match its `NEWS_FOCUS` regex **and** the
  `newsContextOk` guard; if a sparse day returns nothing they fall back to the segment feed, still
  filtered. `/api/news` + `/api/fundamentals` accept `&component=`; the client passes
  `currentComponent`. Verified with a **full sweep of all 31 instruments × both endpoints: 0 leaks**
  (every returned item names the chosen instrument), 300 items. `app.js?v=80`. 75 tests.
- **Mobile polish (2026-10-13).** The ticker **pause/play control was an emoji** (`⏸`/`▶`) — off-theme
  and oversized; it is now monochrome, theme-coloured text (`❚❚` / `▸`), 30px, centered, amber on
  press. Also fixed a **white default input**: the custom-rule *level* field had no styling, so it
  rendered as a light box on the dark theme — `.rule-add input` is now themed like the rest.
  Re-audited mobile (HOME/SCREENER/RULES/POSITIONING/MACRO): no page overflow (`docWidth == 390`),
  tables scroll inside their wrappers. `style.css?v=41`, `app.js?v=81`.
- **INVESTOR-ROADMAP #5 — economic calendar (2026-10-13) — completes the investor backlog (Tier 1).**
  A **📅 ECONOMIC CALENDAR** panel on HOME: dated upcoming releases + source + day-count — EIA weekly,
  CME expiry, **FOMC rate decisions** (parsed live from the Federal Reserve's keyless
  `fomccalendars.htm`, deduped by month, with the published 2026 schedule as a fallback),
  USDA WASDE, OPEC+, and FRED's release calendar when `FRED_API_KEY` is set. New `/api/calendar`;
  the DAILY BRIEF now reuses it for "what's on today". **No forecast is invented** — the panel says
  "dates only — no free consensus". `style.css?v=42`, `app.js?v=82`. 76 tests.
- **End-to-end sweep + fix (2026-10-13).** Swept **all 56 routes** (live + local) and **every tab** at
  1440×900 and 390×844: **0 bad endpoints**, and **0 JS errors / 0 failed requests / 0 console errors
  / 0 page overflow / 0 error states** on HOME · COMMODITIES · MACRO (desktop and mobile). One real
  bug found & fixed: **`/api/continuous`** fetched its 27 contract months **sequentially** (~30 s → the
  request timed out); it now uses a 4-worker pool (~14 s cold, cached 6 h). `/api/curvehistory`
  (~13–30 s) is the known Yahoo-rate-limited endpoint (cached 6 h) — not a regression.
- **TIER-2 #1 — risk metrics (2026-10-13).** A **⚠️ RISK & CORRELATION** panel on HOME: 1-year
  **max drawdown** + a **30/60/90-day realised-vol term structure** per key asset (WTI, gold, copper,
  S&P, DXY, US 10y, VIX), and a colour-coded **correlation matrix** over ~1y of aligned daily
  log-returns. New `/api/risk`; pure `maxDrawdown` / `realizedVolTerm` / `corrMatrix` in
  `src/lib.js` (tested). `style.css?v=43`, `app.js?v=83`. 80 tests.
- **TIER-2 #2 — currency-adjusted returns (2026-10-13).** A **base-currency selector** on the
  SCREENER (USD/EUR/GBP/JPY/CNY/CAD/AUD/CHF): the 1D–1Y columns (and the default sort) become
  **local-currency** returns — the USD move folded with the currency's own move over the same window.
  New `/api/fxadjusted?base=`; pure `fxAdjust` in `src/lib.js` (tested). `app.js?v=84`. 82 tests.
- **TIER-2 #3 — options signals (2026-10-13).** A **🎚️ OPTIONS** panel on COMMODITIES: ATM implied
  vol, **put/call** (open interest + volume) and a **25-Δ skew**, from each commodity's **CBOE
  delayed** ETF-proxy options (USO crude, GLD gold, SLV silver, UNG gas, CPER copper, CORN/WEAT/SOYB,
  CANE/JO/NIB …). Yahoo's own options chain is **crumb-gated (401)**, so CBOE is the free source.
  Coverage is uneven (no proxy → honest empty); **IV rank is deliberately not shown** (needs a stored
  history). New `/api/options?id=`; pure `parseOcc` in `src/lib.js` (tested). `style.css?v=44`,
  `app.js?v=85`. 84 tests.
- **Calendar made a real month grid (2026-10-13).** The ECONOMIC CALENDAR is now an actual
  **month grid** — ‹ MONTH YEAR › navigation + a TODAY button, Mon-first weekday header, today
  outlined, and each event sitting on its day (name chips on desktop, dots on mobile); the month's
  events are listed underneath and undated ones (OPEC+) below that. The server now generates the
  **recurring** events across a 150-day window (weekly EIA, monthly expiry, monthly WASDE) plus FOMC,
  so ~43 dated events (months are no longer bare). `style.css?v=45`, `app.js?v=86`. 84 tests.
- **Risk panel redesigned for readability (2026-10-13).** The raw 7×7 matrix + `MAX DD`/`VOL 30/60/90`
  table is gone. It now leads with a **plain-English read** ("Wildest here: VIX… Most independent:
  WTI crude… Strongest link: S&P 500 ↔ VIX −0.82"), shows each instrument as a **bar + word**
  (`−39% ▇ deep fall · 43% jumpy →`), and gives a **default "what X moves with" diverging-bar view**
  with the full matrix behind a fold. Colour is always paired with a sign/label. New pure helpers
  `drawdownWord` / `volWord` / `volTrend` / `focusRows` / `topPairs` / `bestDiversifier` / `riskRead`
  in `src/lib.js` (tested); `/api/risk` returns them. `style.css?v=46`, `app.js?v=87`. 87 tests.
- **Copy & naming pass (2026-10-13).** Macro region **"United States" → "Americas"** (the country stays
  *United States*), so the region and country selectors no longer read identically. Swept the copy for
  a professional, non-AI tone: **removed all decorative emoji** from panel headers and notices (kept
  the **functional** glyphs ★ ☆ ▲ ▼ ✓ and the rook in the brand); renamed the clever headers to plain
  ones (RISK & CORRELATION, POSITIONING, OPTIONS, SCREENER, SEGMENTS, DATA CHECKS, GUIDE, FORWARD
  CURVE, TIGHTNESS…); replaced **paired em-dash asides with parentheses** in the transmission/ideas
  prose (single dashes and the “—” no-data glyph kept); and dropped first-person "we" ("how the Gulf is
  visible from space"). Decorative emoji are easy to restore if wanted. `app.js?v=88`. 87 tests.
- **Loading: faster boot, a real progress bar, and a mobile beacon fix (2026-10-13).**
  1. **Faster.** `loadExtraCore` no longer *awaits* the below-the-fold fetches (inventories/sector
     quotes/ships/refining margins) — it now fires them fire-and-forget (`loadBelowFold`), so the
     read/chart/news start immediately instead of waiting for ~40 sector quotes. The boot's small
     config feeds (`/api/fx`, `/api/rates`, `/api/markets`, `/api/countries`) now fetch **in parallel**
     with the heavy history load, and `index.html` **preconnects** to the CDNs. Server-side, the warm
     loop now starts at **0.8 s** and warms in order: base feeds → **CFTC positioning (parallel)** →
     regime/calendar → the 9 segment reads → `/api/screen` (positioning was the screener's long pole).
     Cold-ish boot **8.6 s → 1.55 s**; warm **~0.4 s**.
  2. **Beacon = progress, hides when the core is in.** The overlay now tracks **9 core panels**
     (`data, read, chart, news, headlines, regime, screen, calendar, positioning`), shows an amber
     **progress bar** and fills the radar dots **proportionally**, and only drops when they are all in
     — with an **8 s hard cap** (plus the 9 s inline fallback). Verified: it hid at 1.55 s with all 9
     ready (0 missing).
  3. **Mobile beacon fix.** The 6 radar **blips used fixed px** positions, so on the smaller (116 px)
     mobile scope the edge dots fell **outside the circle**. They are now **percentages**, so they
     scale — verified all 6 inside at 116 px. `style.css?v=47`, `app.js?v=90`. 87 tests.
- **Final finish: the intro "?" + a maker credit (2026-10-13).** The **"?"** (and first visit) now opens
  a short, plain about — **no "Welcome"/"Got it"**: *"Marlon's Watchtower — A live commodity and macro
  desk: what moved, why it moved, and what to watch next, with a source and an as-of date on every
  number."* (that one line only — the separate HOME/COMMODITIES/MACRO line was later dropped), a
  CLOSE button and the disclaimer. It is led by a small **animated tower** — the brand rook inside a
  radar scope with a **sweeping beam and random green "contacts" that blip in and out** around it
  (phase/duration re-seeded each time it opens) — pure CSS/SVG, static under `prefers-reduced-motion`.
  The footer credit is now **"built and maintained by Marlon Benedict Tan"** (the `build abc1234`
  stamp was removed from the footer at the user's request; `/health` + `/api/market` still expose it).
  `style.css?v=49`, `app.js?v=92`. 87 tests.
- **FIX — palm oil (CPO) was showing a stale price (2026-10-13).** `CPO=F` is a Yahoo **alt/legacy
  symbol**: its `meta.regularMarketPrice` is a **March-2024** number (820) even though its daily bars
  are current — so /api/market showed Palm Oil at **820 $/t** dated 2026-10-12 (inconsistent). No
  alternative Yahoo palm symbol exists (`FCPO=F` / `KPO=F` / `PALM=F` all 404). Fix: `yahooSeries` now
  returns the **newest close in the series** (falling back to the meta price only if the series is
  empty), via pure `lastNonNull` in `src/lib.js` (tested). Palm now reads **1145.5 $/t @ 2026-10-12**.
  Swept **all 99 Yahoo symbols** the app touches (29 commodity futures + macro FX/indices + sector
  ETFs + FX pairs) with 0 errors: only CPO was stale, every other symbol fresh within 0–1 days. The
  same sweep found Yahoo's `meta.regularMarketPrice` also disagrees with its own daily bars on a few
  ag futures — HE=F 68.35 vs 75.60, DY=F 79.80 vs 72.75, GF=F 341.28 vs 343.48, LE=F 226.58 vs
  224.75 — and in each case the meta value sits **outside the last bar's high/low**, i.e. it is a
  different/erroneous contract print, not a real move. So the fix is correct beyond palm: the app now
  shows the same front-month close as the chart it draws. Independent cross-check against FRED (no
  key): `DCOILWTICO` 96.24 matches the /api/market WTI physical exactly; `DGS10` 5.22 matches the
  regime-board 10y exactly; `VIXCLS` 14.84 ≈ VIX 15.30. Caveat: Brent physical (FRED `DCOILBRENTEU`
  125.44) is reported faithfully but sits ~$21 over Brent futures — that is FRED's own print, not an
  app bug. 88 tests.
- **MACRO tab — tidier currency rows + country-scoped, collapsed catalysts (2026-10-13).** Two fixes
  the user flagged from a screenshot. (1) The CURRENCIES panel was one stretched tile with the
  1D/1W/1M/YTD/1Y deltas flung to opposite edges. It is now **one tidy row per currency** (name ·
  price · today · deltas) via `#macro-fx` grid overrides — the delta column absorbs the slack so the
  numbers stay packed left. Verified at 1440 and 390 px across **all six regions** (US 1 row, EU 2,
  JP 1, CN 2, APAC 9): no overflow, no horizontal scroll. (2) UPCOMING CATALYSTS was a ~120-row flat
  list of US-only items. It is now a **collapsed `<details>` panel that adapts to the chosen
  country**, backed by a new **`/api/catalysts?country=`** endpoint reading **TradingView's public
  economic calendar** (`economic-calendar.tradingview.com/events`; needs an `Origin` header or it
  403s). Real dated high/medium-impact releases, times in ET, capped at 12; if a country only has
  low-impact ones (HK, VN, TW) those are shown and tagged `Low`; holidays are filtered out; a US
  fallback uses the built-in recurring list. Also fixed a real **race**: switching region before the
  boot `/api/countries` fetch resolved fell back to the US for both the country panel and the
  catalysts — `renderMacroRegion` now waits for the list (`ensureCountries`) instead of guessing.
  0 console errors / 0 failed requests over a full region+country sweep. `style.css?v=50`,
  `app.js?v=93`. 88 tests.
- **MACRO — one scope per panel: the currency panel is now country-scoped too (2026-10-13).** The user
  flagged that in Asia-Pacific the two bottom panels disagreed: `CURRENCIES — APAC` (region, 9 pairs)
  sat above `UPCOMING CATALYSTS — SINGAPORE` (country). Verified first that the *order* was already
  identical in all six regions (news → currencies → catalysts; currencies at child #7, catalysts #8)
  and then confirmed the real mismatch was the scope. Chosen fix: **both panels are now country-scoped**
  — the board is retitled `CURRENCY — <COUNTRY>`, shows the chosen country's pair, and gains the click
  target it always promised (the subtitle said "click one for its chart" but `metric` was `null`; now
  the pair is clickable when its label matches `/api/fx`). `loadRegionCurrencies()` moved out of
  `renderMacroRegion()` into `loadCountry()` so a country change refreshes both panels together, with
  a region+country stale-guard. All **22 countries** verified: both panes read the same country, exactly
  1 row, no overflow, 0 console errors. `app.js?v=94`. 88 tests.
- **FEATURE — screener filters: by segment, and by an explicit instrument pick-list (2026-10-13).**
  `/api/screen` rows now carry `seg` + `segLabel` (joined from `MARKETS`, the app's own 9 segments) and
  the payload gains a `segments` list. The HOME screener gets a filter bar above the table: a
  **SEGMENT** dropdown (All + the 9 segments) and an **INSTRUMENTS** `<details>` pick-list with a
  checkbox per instrument, grouped by segment, plus `ALL / NONE / THIS SEGMENT / RESET`. The two
  combine (segment AND picked), a live `N of M shown` count and a "Filtered to N of M" note keep it
  honest, and an empty selection renders a proper empty state instead of a blank table. Selections
  persist in `localStorage` (`scSeg` / `scPicks`) like the rest of the view state. The bar renders
  once and only the table repaints, so an open pick-list stays open while boxes are ticked. Bug caught
  in testing: the pick-list styles were written as `.sc-pick-list` but the element is
  `id="sc-pick-list"`, so the labels/checkboxes fell back to browser defaults (two per line, blue
  boxes) — now `#sc-pick-list`. Verified 1440/390 px: 31 rows → 5 (Softs) → 4 (untick Sugar) → 0
  (NONE) → 5 (THIS SEGMENT) → 31 (RESET); survives a reload; `oflow:false`; 0 console errors.
  `style.css?v=51`, `app.js?v=95`. 88 tests.
- **SWEEP — bug + cleanup pass (2026-10-13).** Full audit: all **488 endpoints** hit with real ids, and a
  DOM sweep of HOME (every jump-nav target) + **9 commodity segments** + **6 macro regions × 22
  countries** + the interactive controls, at 1440 and 390 px. Found and fixed:
  1. **Perf bug — `getCurveHistory` was sequential.** It fetched its 16 contract months one at a time
     with `await sleep(120)` (~26–28 s cold). Its sibling `getContinuous` already used a 4-wide worker
     pool (with a comment saying sequential was ~30 s) — the fix was never applied here. Now **6.2–7.9 s
     (~4×)**. Only the slowest remaining endpoint is `/api/continuous` at ~13.8 s (27 months, cached 6 h,
     no UI caller).
  2. **No HTML escaping anywhere.** Wire headlines, their URLs, TradingView event titles and user-typed
     rule notes were interpolated straight into `innerHTML`. Added `esc()` and applied it at every
     external injection point (news, headlines, chart-move markers, cross-asset chain, catalysts, rule
     notes) — **not** to server prose, which deliberately contains `<b>` tags. Verified with a hostile
     payload (`<img onerror>`, `"><script>`): nothing executes, no elements are created, and normal text
     (incl. `&`) is unaffected.
  3. **Dead code** removed: `benchCard` / `spreadCard` / `crackCard` / `fmt` (app.js), `lastEntry`
     (server.js) — all defined, never referenced.
  4. **Dead CSS** removed: 12 unused rules (`.t-chg`, `.insights` + `.col`, `.disc`, `.regime-k`,
     `.cal-undated`, `.hl-h`, `.wb-bars`, `.wb-bar`, `.wb-bar.neg`) plus `.insights` in the mobile
     min-width list. Braces re-checked.
  5. **a11y** — the SAR satellite canvas was never labelled; it now gets `role="img"` + a descriptive
     `aria-label` (loading / N objects circled / image unavailable), and `curvehist` / `crushhist` carry
     static base labels. Canvas labelling went **9/12 → 12/12**.
  Checked and confirmed **not** bugs (don't re-investigate): `/api/termstructure` takes `?id=` not
  `?root=`; `/api/fundamentals` + `/api/news` take a *segment* `id` plus optional `component`;
  `no free options proxy` / `no CFTC series` / `no free bond-yield data` / `no data` are expected for
  instruments without that feed and render as friendly states; `/api/fxadjusted` covers all 31
  benchmarks. Result: **0 console errors, 0 failed requests, 0 overflow, 0 stuck panels** at both
  widths; 88 tests. `style.css?v=52`, `app.js?v=96`.
- **FIX — India/China macro felt slow: `getMoveWho` was sequential, and a dead `$('#id')` lookup
  (2026-10-14).** User reported the MACRO data for India/China took longer to load on mobile.
  Instrumented the real mobile flow (CDP network timings + "time until no panel is loading") and found
  the culprit was **not** `/api/country` (0.6 s cold) but **`/api/movewho` at 8.6–10.3 s per call** —
  it fetched up to 6 days of Google News news in a **sequential loop**, and several are fired per
  country switch. Parallelised just the fetch phase (scoring/order unchanged) → **1.2 s**. Measured on
  mobile: **China 6051 ms → 754 ms (~8×)**, India 504 → 252 ms. Found and fixed the **same sequential
  pattern** in two more places: `getAnalytics` (per-benchmark physical/paper fetches) and
  `getMarketRead`'s macro correlations (`pairCorr` ×3) — both now `Promise.all`. Verified the derived
  values are unchanged (screen `basisPct`/`vol30` on the 5 physical instruments, marketread
  `macro:{usd,vix,spx}`).
  While verifying that the chart news markers still rendered, found a **serious pre-existing bug**: `$`
  is `document.getElementById(id)` but **all 8** marker call sites pass a `#`-prefixed selector
  (`attachMarkers(..., '#chart-events')`), so every lookup returned `null` and the entire
  "big moves on this chart — hover a marker for the headline" feature was **silently dead** (all 8
  containers empty, not even the empty state). `$` is now tolerant (`String(id).replace(/^#/, '')`) →
  markers render again on 6 charts (real headlines, dates, % moves, sources) with dots on the line.
  `app.js?v=97`. 88 tests; full UI sweep clean at 1400 px.
- **SWEEP 2 — three more bugs eliminated + hardening (2026-10-14).** Went after the classes of bug that
  had already bitten (external text into HTML, untrusted stores, method handling) rather than just
  re-running the same checks.
  1. **Server-side XSS: raw wire headlines embedded in server prose.** `getMarketRead` and the country
     panel push takeaways like `` `<b>${kind}</b>: ${title}` `` — and the client injects takeaways as
     HTML (`<li>${t}</li>`). A headline containing markup would execute. Added a pure, unit-tested
     **`escHtml()`** to `src/lib.js` and escaped *only the external fragment* at those two sites, so the
     prose keeps its intentional `<b>` tags.
  2. **Self-XSS via the `rules` localStorage store.** `r.level` was interpolated raw
     (`<b>${r.level}</b>`) and `ruleLabel()`'s fallback returned the raw metric — I reproduced actual
     execution (a tampered entry set `window.__p` and created an `<img>`). `rules()` now **validates and
     coerces every field on read** (op must be one of `> < crosses`, level must be a finite Number,
     metric must be one of the known instruments, note bounded) and `ruleLabel()` escapes its fallbacks.
     Verified: the same payload is now dropped and executes nothing; legitimate rules still render and
     delete correctly.
  3. **Method handling.** Every route answered POST/PUT/DELETE/PATCH/OPTIONS with 200 (Node's default).
     No route mutates state and the alert webhook is outbound, so the server is now explicitly
     read-only: non-GET/HEAD → **405** with `allow: GET, HEAD`.
  Verified-safe and recorded here so they are **not re-investigated**: static-file **path traversal**
  (explicit `full.startsWith(PUBLIC)` containment guard; 8 encoded/bypass payloads all 404), security
  headers (nosniff, referrer-policy, X-Frame-Options, permissions-policy, report-only CSP), malformed
  and hostile query params (no 500s anywhere — the one `000` was curl sending a raw space in the URL,
  not a server fault), watchlist ids (filtered against real benchmarks), thresholds (numeric-only,
  never rendered), compare/range/scSeg/scPicks restores (validated against the option lists), listener
  leaks (`tickerWired` guard; threshold inputs are replaced wholesale), and a **full a11y audit**
  beyond canvases (no unlabelled controls/buttons/images, `lang` set, one `h1`, no positive tabindex).
  Result: **89 tests**; sweeps **0 problems** at 1400 and 390; canvases 12/12. `app.js?v=98`.

## UX backlog (picked by the user, 2026-10-14 — work through ONE at a time)
1. ✅ **Jump-nav on COMMODITIES + MACRO** (done below)
2. ✅ **Quick-jump (⌘K / Ctrl-K)** (done below)
3. ✅ **Deep links + back button** (done below)
4. ✅ **Defer off-screen panels** (done below)
5. ✅ **Keep-alive + cold-start UX** (done below)
6. ✅ **Finish alerts + the daily email/digest** (done below, including server-side rules) — the user called this out explicitly. Known broken:
   `Dockerfile` copies no `node_modules` and never runs `npm install`, so **`nodemailer` can never
   import → the daily email has never worked in production**; `render.yaml` declares no
   `SMTP_*`/`DIGEST_TO`; **`alertSeen` is in-memory** so every restart/redeploy re-fires every alert;
   **user alert rules are client-side only** ("checked in this tab while it is open") so they never
   reach `deliver()`; the digest only fires if the instance happens to be awake at `DIGEST_HOUR`
   (free plan sleeps after 15 min); and there's **no UI** showing whether email/webhook is configured
   or when the last digest actually sent.

- **UX 1 — jump-nav on COMMODITIES + MACRO (2026-10-14).** HOME had a jump-nav; the two longest panes
  had none (COMMODITIES = 22 sections; MACRO stacks ~3,200–4,400 px, 6,900 px on mobile). Added ids to
  every top-level panel in both panes and put a sticky `.jumpnav` at the top of each. Because ~a dozen
  COMMODITIES panels are segment-conditional (`data-when`), `syncJumpnavs()` **hides any chip whose
  target isn't currently rendered** — wired into `toggleMarketBlocks()`, `showTab()` and `loadCountry()`
  (the US–Japan panel). Verified: crude shows 12 chips (hides Season/Cracks), refined hides Season/Ships,
  grains hides Cracks/Supply/Ships, precious hides Season/Cracks/Supply/Ships; macro shows all 9.
  Anchors land 72–102 px below the sticky bar at both 1400 and 390 px. Also generalised the
  `scroll-margin-top` rule from a hard-coded id list to `.tabpane > section[id], .tabpane > details[id]`
  so new anchors never need a CSS edit. `style.css?v=53`, `app.js?v=99`.
- **UX 2 — quick-jump (⌘K / Ctrl-K, or the JUMP button) (2026-10-14).** A command palette over a modal
  (`#palette`), built from data already in memory: **instruments** (`markets` components), **segments**,
  **countries** (`macroCountries`) and every **live section** (read from the rendered jump-navs, so it
  can't drift from what the app can show). Ranked substring match (exact > prefix > label > keywords),
  8 results, `↑↓ / Enter / Esc`, backdrop-click and ⌘K to toggle. Two details that mattered:
  (1) the `#metric` select only holds the **current segment's** instruments, so a jump does
  `selectMarket(seg)` **then** `pickMetric(id)` — otherwise `pickMetric` silently no-ops;
  (2) added a small aliases map so people can type what they mean ("diesel" → ULSD / Heating,
  "gasoline" → RBOB, "beef" → cattle, "lpg" → propane, "smp" → nonfat dry milk). Verified: "gold" →
  commodities tab + segment *precious* + metric *gold*; "japan" → macro tab + region/country *jp*;
  "screener" → the section; "zzz" → empty state; 0 console errors, no overflow at 1400/390
  (palette box 620 → 362 px). `style.css?v=54`, `app.js?v=100`.
- **UX 3 — deep links + Back (2026-10-14).** The URL hash now mirrors the view:
  `#/commodities/<segment>/<metric>` (metric URL-encoded) and `#/macro/<region>/<country>`, else
  `#/home`. So a view is bookmarkable/shareable, and the browser **Back button walks your tabs**
  instead of leaving the app (verified: back → commodities, back → home, forward → commodities).
  Tab changes `pushState` (the history steps); segment/metric/country changes `replaceState` so Back
  stays clean; a boot deep link wins over the restored tab, and an unknown hash falls back gracefully.
  Jump-nav chips stay real anchors for a11y but are intercepted so they never overwrite the route hash.
  **Trap worth remembering:** `app.js` declares its own `let history` (the price-history payload) at
  line 46, which **shadows `window.history`** — my first cut called `history.pushState(...)` and it
  silently threw into the catch. The History API must be reached via `window.history` here.
  `app.js?v=101`.
- **UX 4 — defer off-screen panels (2026-10-14).** Added `whenNear(el, fn, margin)`: run a loader once the
  element first comes near the viewport. A panel inside a **hidden pane never intersects**, so this also
  means "don't render another tab's panels until that tab is opened" — which is where the win is:
  at boot on HOME the client now fetches **zero** hidden-pane endpoints (equities, inventories,
  chokepoints, analytics, flows, products, flares, sar, options, positioning, country, country-series,
  yields, region-quotes, curvehistory) — previously all of those fired at boot. What stayed eager:
  `renderMacroRegion`'s `loadMacroTickers()` (the top tape) and the **macrodash fetch** (because `md.fx`
  feeds the tape's currency section) — only its *render* is gated.
  Two things learned the hard way: (1) gating HOME's own below-fold panels is unreliable — those panels
  define the page height, so their on-screen position is only known once they've rendered (they either
  fire immediately or never); they stay eager, but **`screen` and `calendar` are out of `BOOT_CORE`**, so
  the loading overlay no longer waits on below-the-fold work. (2) Put the *fetch* inside the gate, not
  just the render — the first cut still downloaded the 26s NASA fire CSV at boot.
  Also: `/api/flares` takes ~25s cold (it parses NASA FIRMS' global 24h CSV), so the server now warms it
  (and the SAR image) **90s after boot and every 3h**, well clear of the first paint. Verified: 0
  hidden-pane fetches on HOME; screener/risk/calendar/tape all intact (31 rows / 7 rows / 35 days /
  2036 ticker chars); opening COMMODITIES loads sectors+products+inventories, reaching SHIPS &
  SATELLITES renders the SAR canvas (512px, 1664 chars), opening MACRO renders the country panel +
  5 charts (6802 chars) — 0 console errors, full sweep clean. `app.js?v=102`.
- **UX 5 — cold start: keep-alive + an honest "waking" state (2026-10-14).** Render's *free* plan sleeps a
  service after ~15 min idle and takes 20–30s to wake; no client code can prevent that, so this does the
  two things that can be done. (1) **`scripts/keepalive.sh`** — a one-ping / `--loop` curl script against
  `/health` (every 10 min keeps the idle timer from expiring), with the exact `crontab` line and a note
  that a free uptime monitor pointed at `/health` does the same without a machine of your own; also
  annotated in `render.yaml`. (2) **An honest wake state** — the boot beacon now detects a cold start
  (first response arriving > 2.5s after script start) and says "waking the server…" plus a line
  explaining the free-plan sleep, and the 9s failsafe extends to 25s rather than revealing a half-empty
  shell. Verified both paths: warm → note hidden, beacon normal; cold → note visible, status
  "waking the server…", 330px wide with no overflow at 390px. `style.css?v=55`, `app.js?v=103`.
- **UX 6 — the daily email + alert delivery actually work now (2026-10-14).** The user was right that this
  was unfinished. Root cause: `sendEmail()` imported **nodemailer**, which can never install — the Docker
  image copies no `node_modules` and never runs `npm install` (by design: the project is zero-dependency),
  so **the daily email had never once sent in production** and only logged "nodemailer not installed".
  Fixes:
  1. **Hand-rolled SMTP client** in `src/smtp.js` (~110 lines, `node:net`/`node:tls`) — implicit TLS (465),
     STARTTLS upgrade (587, only when advertised), AUTH PLAIN/LOGIN, base64 body with 76-char folding.
     It **refuses to send credentials over an unencrypted connection**. Keeps the zero-dependency promise.
  2. **4 protocol tests** (`tests/smtp.test.js`) run against a fake SMTP server on `node:net`, so the real
     dialogue is verified with no credentials and no network: full envelope + DATA + decoded body (em-dash
     intact), multi-line EHLO handling, and the plaintext-credential refusal. **The test caught a genuine
     bug**: extra lines in a multi-line reply were dropped instead of queued — Gmail always answers EHLO
     with several `250-…` lines, so email would have hung forever against a real server.
  3. **`alertSeen` is persisted** into `.state.json` (it was in-memory), so a restart/redeploy no longer
     re-fires every alert. (Learned: it must be hydrated *after* `state` loads — initialising it inline hit
     a TDZ ReferenceError that took the whole server down.)
  4. **Delivery status + a test button in the UI.** `GET /api/notify` reports whether email/webhook/desktop
     are configured, when the last digest went, and the last error; the ALERTS panel renders it with a
     **SEND TEST** button (`POST /api/notify/test`, rate-limited to 1/min, the only non-GET route — the
     read-only guard allows exactly that one path). `render.yaml` now declares
     `SMTP_USER/SMTP_PASS/SMTP_HOST/SMTP_PORT/DIGEST_TO/MAIL_FROM/WEBHOOK_URL`.
  Verified: 93 tests (89 + 4 SMTP); locally the panel shows "Server alerts · desktop · digest 7:00 (last
  digest 2026-10-14)" and SEND TEST surfaces the exact reason it can't send.
  5. **User rules now run on the server too** (so they fire with the app closed). `POST/GET /api/rules`
     store rules in `.state.json`; `evaluateRules()` mirrors the client's metric semantics exactly
     (`bench:<id>` price, `basis:<id>` real−futures, `fx:<id>`) and runs inside `alertLoop` every 5 min,
     delivering through the same `deliver()` path (email/webhook/desktop) with the same 12 h cooldown.
     `rulePrev` is persisted so `crosses` works across restarts. **Server rules are site-wide** (there's
     no per-user model), so the endpoints deliberately require the login: without `AUTH_USER`/`AUTH_PASS`
     they answer **401** and the UI says "browser only — set AUTH_USER + AUTH_PASS"; reaching the route at
     all means the auth check already passed. Posted rules are validated (op allow-list, finite level,
     `^(bench|basis|fx):[a-z0-9]+$` metric, 80-char note, max 20) — a POST containing a bogus metric is
     silently dropped. The client adopts the server's rules as the source of truth, seeds the server from
     local storage on first run, and pushes on every add/delete; it only talks to `/api/rules` once
     `/api/notify` reports the login is on, so an unconfigured deployment doesn't log a 401 on every load.
     Verified end-to-end: with a login, adding a rule in the UI put it on the server, and a deliberately
     trivial rule (`WTI > 1`) fired through `alertLoop` — `[notify:alert]` + `digest.log` show
     "WTI (Cushing) price is above 1 — should fire immediately (now 95.34)". `app.js?v=106`.
- **FEATURE — public alert subscriptions: "anyone may get the alerts" (2026-10-15).** A visitor can enter
  **their own email or chat-webhook URL** in the ALERTS panel and receive the same alert stream the
  dashboard shows. Built with the abuse surface in mind, because this is the one feature where "open to
  anybody" is genuinely dangerous:
  1. **Double opt-in.** `POST /api/subscribe` only *sends a confirmation* to the destination; nothing is
     delivered until the subscriber clicks `/api/confirm?t=<token>`. That stops anyone signing up somebody
     else, and stops the mail account being an open relay (the #1 way to get an SMTP provider to suspend
     you).
  2. **Host allowlist (SSRF guard).** The target must be an email address or an `https` URL on a *known*
     chat host (`ntfy.sh`, `api.telegram.org`, `discord(app).com`, `slack.com`). Without this, "enter your
     webhook URL" would let a stranger make the server POST to its own network (e.g. cloud metadata).
     `https://127.0.0.1:9999/…` is refused — verified.
  3. **Caps and limits.** Max 200 stored subscriptions, 5 sign-ups per IP per hour, 20 messages per
     subscriber per day (so a noisy market can't spam somebody's phone on our bill).
  4. **Unsubscribe in every message** plus one-click `/api/unsubscribe?t=<token>`.
  5. **The subscription surface stays public even when the login is on** — `/api/subscribe`,
     `/api/confirm`, `/api/unsubscribe` are excluded from the auth check (visitors have no login; the
     confirm link is clicked from a mail client). Every other route stays private.
  Subscribers get the **shared stream** (the server checks), not the owner's private rules. Storage is
  `.state.json`, so a free-tier redeploy/sleep can drop them (the UI hints at that); a free Upstash Redis
  is the obvious upgrade. Delivery reuses the shaped webhook (`webhookPayload`) so ntfy/Telegram/Discord/
  Slack all work, with email through the hand-rolled SMTP client.
  **Verified end-to-end against the real ntfy.sh**: subscribe → the confirmation genuinely arrived on the
  topic (read back via ntfy's own API) → the confirm link flipped the record to active → the next alert
  tick (≈5 min) delivered **both** a server check and a rule hit to the subscriber, each with its
  unsubscribe link. Also verified: email without SMTP is politely refused, a non-allowlisted host is
  refused, and the panel shows "(N active · M awaiting confirmation, cap 200)".
  `style.css?v=57`, `app.js?v=107`. 94 tests; sweep clean.
  Follow-ups the same day, both fixed rather than just noted:
  * **Durability.** Because the free tier wipes `.state.json` on redeploy *and* on every sleep/wake,
    subscriptions/rules/cooldowns are now optionally kept in any free Redis over REST —
    `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (still zero-dependency: plain `fetch`). The file
    stays the instant local copy and the fallback; the remote write is debounced 1.5 s. Verified by
    **simulating a redeploy**: with the env vars set, a rule was created, the process killed, the local
    `.state.json` deleted — and on boot it logged `restored from Redis: 1 keys` with the rule intact.
    `/api/notify` reports `subscribers.durable`, and the panel says "stored durably" or "may reset on
    redeploy" so the mode is never a silent trap.
  * **Our own fan-out rate.** We were sending **one message per alert per subscriber**, which for 5 alerts
    × N subscribers is exactly what gets a chat service to rate-limit us (the free ntfy tier 429'd us
    during testing). Now it's **one batched message per subscriber** listing everything that just
    happened, with a 250 ms gap between subscribers.
  * Channel errors are actionable now: a 429 says "rate-limiting us right now — try again in a few
    minutes", a 401/403 says to check the webhook URL. `app.js?v=108`.

## Recent work log (this build)
Commodity Desk rebranded from the oil-only "Oil Basis"; merged COMMODITIES+PRICE TRENDS; ranges 1M–10Y with hover %; currencies chartable; Phase 3 global macro (rates, FX, commodity↔currency links, copper/gold). Then: `MARKETS` (7 segments), adaptive Big Picture (what happened / what's next / trade ideas), `/api/marketread`, CFTC positioning generalized then **removed from the UI**, `/api/termstructure`, palm oil, actionable trade ideas with ETFs + EM names, cross-asset transmission engine, 2-tab IA (ships/satellites under Crude; fuels/stocks under Refined; supply under energy), hero headlines board, fundamentals event-scanner, context-aware tickers, macro regions → countries with World Bank fundamentals + BIS policy rates + CPI charts + index-vs-currency chart, region-scoped currencies, country-specific commodity linkages, instant country switching (cache + prefetch), Bloomberg-style country cards. Then **roadmap item 1 — deltas + freshness**: every price now shows 1D/1W/1M/YTD/1Y + a source/as-of badge. Then **roadmap item 2 — two stretch scores**: the old price-only "stretch" is now "price stretch", joined by a fundamentals-based "physical tightness" (curve + basis + stocks-vs-seasonal). Then **roadmap item 3 — HOME tab**: cross-segment watchlist + a merged alerts board (server + thresholds) + the 8-segment board, as the default landing. Then **roadmap item 4 — on-screen daily brief**: `/api/brief` + a HOME DAILY BRIEF panel (what happened / what's on today). Then **roadmap item 5 — compare / spread**: a COMPARE panel overlaying any two series (indexed or difference) + chartable FRED rates. Then **roadmap item 6 — seasonality**: a 5-yr seasonal grade + forward bias for gas/grains/softs. Then **roadmap item 7 — curve carry**: numeric roll yield ($/unit/month + %/yr) and a calendar-spread ladder in the curve panel. Then **roadmap item 8 — one read**: merged WHAT IT MEANS + KEY TAKEAWAYS + READING THE NUMBERS into a single THE READ panel (+ detail fold), and moved the live headlines board off the top of every page into HOME. See the roadmap entries above. 53 tests. Then **industrial metals + livestock (2026-10-12)**: removed **nickel** (no free daily source; the ETC proxy `NICK.L` correlated only 0.71 with real nickel and moved in opposite months — misleading) and replaced it with **Aluminium** (`ALI=F`, COMEX, $/t, with contract months), and added a new **Livestock** segment (`LE=F` live cattle, `HE=F` lean hogs, `GF=F` feeder cattle — protein/food inflation). `MARKETS` is now **8 segments** / **24 benchmarks**; `getMarket` notes, `MARKET_CONTENT`, `NEWS_QUERIES`, `SCAN_QUERIES` and the Indonesia commodity link all updated; the aluminium curve resolves. 59 tests. Then **signed price scoring (2026-10-12)**: the price "stretch" was rebuilt as a **signed** −100…+100 read (rich ↔ cheap) because the old symmetric score labelled a market at 2-yr lows as "stretched" (lean hogs: −23% y/y, 0th percentile → wrongly 78/STRETCHED; now −83/VERY CHEAP). Every input is a percentile of the market's own history (2y/10y range position + self-normalised 3-mo/1-yr moves), so scores are comparable across commodities; volatility moved out to its own line. `src/lib.js` gains `signedPosition`/`signedMove`/`stretchLabel`; the READ panel now reads "IS X RICH, CHEAP OR TIGHT?" with plain-word labels; `app.js?v=40`. 59 tests. Then **Dairy segment (2026-10-12)**: new **Dairy** segment (group `Dairy`) covering the full CME complex — Class III Milk (`DC=F`), Butter (`CB=F`), Nonfat Dry Milk (`GNF=F`), Cheddar Cheese (`CSC=F`), Dry Whey (`DY=F`). All are live daily on Yahoo with contract months (so each has a real curve) and current CFTC COT series (`MILK, Class III`, `BUTTER (CASH SETTLED)`, `CHEESE (CASH-SETTLED)`, `NON FAT DRY MILK`, `DRY WHEY`); no free spot/inventories, so physical tightness stays `null` (labelled). `MARKETS` is now **9 segments** / **29 benchmarks**; added `MARKET_CONTENT.dairy`, `NEWS_QUERIES.dairy`, `SCAN_QUERIES.dairy`, `CURVE_SPEC` CME entries and the dairy COT names. No client change needed (picker/board are generic). 59 tests. Then **soybean complex + crush (2026-10-12)**: added **Soybean Meal** (`ZM=F`, $/ton) and **Soybean Oil** (`ZL=F`, ¢/lb) to the (now renamed) **Grains & oilseeds** segment — both have live daily prices, real contract-month curves and current CFTC COT (`SOYBEAN MEAL`/`SOYBEAN OIL`). New pure helper `computeCrush` (board crush = meal×48/2000 + oil×11/100 − beans/100 $/bu, plus the **oil share**), served by a new **`/api/crush`** (current + 1-yr percentile + 6-mo history). A **SOYBEAN CRUSH** panel on COMMODITIES (grains) shows the margin, the oil share, the three legs and a twin-axis history chart; `app.js?v=41`. 61 tests. Then **supply & demand score (2026-10-12)**: the tightness read became **SUPPLY & DEMAND** — the futures curve now feeds *every* commodity (energy adds spot basis + weekly US stocks; ags/dairy/livestock add USDA stocks-to-use when present), with an **evidence badge** (`real data` vs `curve only`) and plain labels UNDERSUPPLIED · TIGHT · BALANCED · WELL SUPPLIED · OVERSUPPLIED (pure `sdLabel`). Curve-only reads carry a class caveat (metals: financing cost; crops/livestock: seasonal); livestock curves enabled (`LE`/`HE`/`GF`, CME); precious metals stay honestly blank. `app.js?v=42`. 62 tests. Then **USDA supply/demand (2026-10-12)**: added `scripts/fetch-usda.mjs` → `data/usda.json` (keyless USDA PSD bulk CSVs; **US stocks-to-use** = ending stocks ÷ (domestic consumption + exports), by market year, 30-yr history) and wired it into the S&D score as a **real-fundamental leg** for corn / wheat / soybeans / soymeal / soyoil / butter / cheese / NFDM / beef / pork — those now read `physical` (real data + curve), not curve-only. Refreshed weekly by `scripts/snapshot-and-push.sh` (Render can't be relied on to fetch+parse the big CSVs); the read shows the stocks-to-use row + year. `app.js?v=43`. 62 tests. Then **news tilt (2026-10-12)**: the FUNDAMENTALS panel now shows a **qualitative news tilt** (bullish vs bearish tagged shocks) — deliberately **NOT scored** into supply & demand, since headlines are keyword-tagged prompts, not data. `app.js?v=44`. Then **chart kit (2026-10-12, Phase 1 — standardize)**: every chart now comes from **one kit** in `public/app.js` — `baseOptions({dp,unit,percentAxis,yTitle,y1Title,legend,log})` (shared grid/axes/legend + a unified tooltip: value + % change over the window, plus "vs ●" on the main chart when an anchor is set), `mountChart(id,data,opts,plugins)` (a `charts` registry so re-renders update in place — no leaks, no 0-height canvases), a **`CT` role palette** (c1 futures / c2 real / c3 / c4 / accent) replacing ~12 ad-hoc hexes, one empty state, and unified heights via `.chart-wrap` / `.lg` / `.sm`. All 12 charts migrated; `chartOpts()` removed; **no new controls** (deliberately, to stay intuitive). `app.js?v=45`, `style.css?v=23`. 62 tests. **Planned next: Phase 2 — interactivity** (crosshair already exists; add drag-to-zoom + reset, legend series-toggles, and **event annotations** — EIA/WASDE/OPEC/news markers on the time axis — plus a forward-curve overlay and log/rebase). **Phase 3 — UX**: consolidate chart panels into PRICE / STRUCTURE / MACRO groups, persist per-panel prefs, mobile + a11y, PNG/CSV export. Then **chart event annotations (2026-10-12, Phase 2 · part 1)**: dated news shocks are drawn as faint vertical markers on the PRICE chart and listed under it (click → the source headline), built from `/api/fundamentals` (client-cached 5 min). `/api/fundamentals` now also carries `ageDays` (fixing a latent "NaNmo ago" bug in the panel). Deliberately **no zoom controls** — the 1M–10Y range selector *is* the zoom, and Chart.js legend clicks already toggle series for free — to stay uncluttered. `app.js?v=46`. 62 tests. Still open for Phase 2/3: drag-zoom, forward-curve overlay, log/rebase, panel consolidation, per-panel prefs, PNG/CSV export. Then **forward-curve overlay (2026-10-12, Phase 2 · part 2)**: a dashed line on the PRICE chart extends the **futures months** (from `/api/termstructure`, client-cached 5 min, up to 6 contracts) to the right of the last price — so the price chart now visually links to the "prices for months ahead" panel ("where the futures say it goes"). Segment benchmarks only; skipped when there is no curve (e.g. palm oil). `app.js?v=47`. 62 tests. Then **UX pass (2026-10-12, Phase 3)**: the app now **remembers your view** across visits (localStorage — `tab`, `segment`, chart `range`, compare `{a,b,range,view}`, `macroRegion`/`macroCountry`) and restores it on load, with **no new UI**. Accessibility: `aria-label`s on the key selectors + a `:focus-visible` outline for keyboard users. Mobile: control rows wrap. **Panel consolidation (PRICE/STRUCTURE/MACRO grouping) was deliberately deferred** — folding panels would hide content and fight the "answer-first" layout; revisit only if wanted. `app.js?v=48`. 62 tests. Then **move-explaining markers (2026-10-12)**: replaced the "every news date" markers (which read as green clutter) with **big-move markers** — the client detects the chart's largest swings (top ~4, well above the market's typical daily move) and the server looks up the news published in a tight window around each move (`/api/movewho`, Google News `after:`/`before:`, **tier-1 sources only** — Reuters / Bloomberg / FT / AP / CNBC), picking the closest, direction-consistent story. Only moves we can actually explain get a marker; the chips below link to the source (e.g. corn +4.6% → *"Corn Surges as USDA Makes Bigger-Than-Expected Cut to US Yield"*, Bloomberg). GDELT was trialled for a historical archive but is hard rate-limited (429) — Google News date operators proved reliable instead. `app.js?v=50`. 63 tests. Then **marker hover + headline chips (2026-10-12)**: hovering a move marker pops a tooltip with the **headline + source** (the client hit-tests the plugin-drawn marker x-position via `options.onHover`), and the chips under the chart now show the **headline text** instead of the generic "Market news" kind. `app.js?v=51`. Then **macro charts get the same treatment + missing indexes fixed (2026-10-12)**: the move-marker/hover pipeline is now **shared** (`attachMarkers`, a body-level hover tooltip positioned by the mouse) and applied to the macro **INDEX vs CURRENCY** chart and the **BOND YIELDS** chart (chips under each; hover → headline). `/api/movewho` now accepts **macro region/country ids** too (it resolves the news topic from `NEWS_QUERIES`, which already covered regions + countries). **Missing stock indexes fixed:** Thailand (`^SET.BK` is broken on Yahoo) → `THD`; Philippines → `EPHE`; Vietnam → `VNM` — trusted US-listed ETF proxies, labelled "ETF proxy". Bond-yield sources unchanged (no better free source, as agreed). `app.js?v=52`. 63 tests. Then **macro markers on every line + the Euro area (2026-10-12)**: the client now detects big moves across **every line on a chart** — so the macro chart's **currency** is annotated too, not just the index. Broadened the Euro-area news query (`ea`, 1/5 → 5/5 matched). Verified all **18 tracked countries**: index + currency big moves matched to tier-1 news (5/5 for every country). `app.js?v=53`. Then **marker coverage + stale-news fixes (2026-10-12)**: (1) **5Y/10Y charts had no markers** — those labels are `YYYY-MM` and the server's date filter rejected them; it now accepts month labels (news window ±15 days) → verified 5Y 3/3, 10Y 5/5 (incl. 2018/2020/2021 moves). (2) Clicking a commodity in the **component strip now also switches the PRICE chart** to that commodity, so its markers apply (before, the strip changed only the READ). (3) Added a per-chart **race guard** in `attachMarkers` (`$mseq`) so an in-flight news lookup can't land after a segment/country/metric switch — this was the "stale headlines" bug. `app.js?v=54`. 63 tests. Then **race guards + client cache (2026-10-12)**: every commodity loader (`loadMarketRead` / `loadNews` / `loadFundamentals` / `loadSeasonal` / `loadCrush` / `renderCurveForSegment` / `loadCurveHistory`) now captures the selection (`segKey()`) and **drops its result if the user switched away while it was in flight** — this fixes "I clicked oil but it still shows corn". `renderChart` got the same guard (metric/range/segment). Added **`jget(url, ttl)`**, a per-session memo cache, for the per-segment endpoints (read / news / fundamentals / curve / termstructure / curvehistory / movewho) so **re-visiting a segment is instant** and switching fires far fewer round-trips. `app.js?v=55`. 63 tests. Then **READ fixes — wrong segment + slow load (2026-10-12)**: (1) `selectMarket` never synced the segment picker and `renderSnapshot` read the picker instead of `currentMarket`, so switching via the HOME board / watchlist showed the **previous** segment's snapshot — now the picker is synced and `renderSnapshot` uses `currentMarket`. (2) Cold `/api/marketread` was **5–8s**, dominated by `curveFor` firing **14 sequential** Yahoo calls; the **front 6 are now fetched in parallel** (cold READ **8.2s → 1.4s**). (3) Attribution split to **`/api/marketwhy`** (lazily filled into `#read-attr`) + an instant **skeleton** showing the segment's price/6m while the verdict loads. (4) `cached()` now **de-dupes in-flight** requests (concurrent callers share one job). (5) A background **warm loop** precomputes every segment's READ every 8 min → **all segments ~0.7ms after warm-up**. `app.js?v=56`. 63 tests. Then **event-news hover, done properly (2026-10-12)**: replaced the floating `#chart-tip` card (screen-anchored → **stuck on scroll**, and needed 7px pixel-hunting) with the **news inside the normal Chart.js tooltip** — an invisible `$news` dataset with a point at each big move, whose tooltip line reads `📰 <headline> — <source> (+x%)`. Chart.js draws it on the canvas, so it **scrolls with the chart and hides properly**; the legend filters the synthetic dataset out. Coverage: **every commodity segment** (price chart) plus macro **index/currency, bond yields, US–JP 10-yr and central-bank-rate** (all countries). Hardened `detectBigMoves` for **stepped rate series** (a policy change counts even when most months are flat) — verified US Fed cuts → Reuters, BoE hikes → CNBC, RBI → Reuters. Removed the dead `#chart-tip` element + CSS. `app.js?v=57`. 63 tests. Then **event-news coverage + forgiving hover (2026-10-12)**: each event now covers a **±2–3 column hit band** (was a single column → needed pixel accuracy) and the tooltip line carries the event's **date** (`📰 08-12 · headline — source (+x%)`). Extended the markers to the **segment's own charts** — **cracking-margin history** (refined), **curve-over-time** (the segment), **crush** (grains) — and to the price chart's **gap/spread** metrics (news id derived from the metric). Net coverage: a segment shows news on its **price chart, curve-over-time and margins/crush**; macro shows it on **index/currency, bond yields, US–JP and central-bank rate**. (Compare and CPI stay unannotated: arbitrary overlays / annual.) `app.js?v=58`. 63 tests. Then **the marker plugin was only on the main chart (2026-10-12)**: `eventsPlugin` (which draws the dots/lines) was passed only in the *price* chart's `mountChart`, so the macro and segment charts had no visible markers — the tooltip news existed but nothing showed WHERE to hover, so they looked empty. Fixed by **`Chart.register(eventsPlugin)`** (global — it no-ops on charts with no events) and dropping it from the price chart's per-chart plugins. Every annotated chart now draws its markers. `app.js?v=59`. 63 tests. Then **rate changes shown in pp/bp, not % (2026-10-13)**: for **rate/yield charts** a *relative* change is meaningless — a policy rate near zero made it explode (Japan's tooltip read ≈ −1000%). Rate charts (policy rate, bond yields, US–JP) now format the change as **basis points / percentage points** (`+20 bp`, `−25 bp`, `+1.50 pp`) in both the tooltip and the move chips, and their move detector uses the **absolute** change (a 5 bp move is 5 bp, not ±100%). Added `chgText`/`moveText`; threaded a `mode` ('pct'|'abs') through `attachMarkers`→`chartMoveMarkers`→`detectBigMoves`; `winPct` removed. `app.js?v=60`. 63 tests. Then **news relevance gate (2026-10-13)**: news was matched on tier-1 + date + direction only, so a **US–Japan yield move could show a UK or China story** (the query terms are broad — e.g. "interest rates"). Added **`NEWS_MUST`** — a per-id (segment / region / country) list of patterns a headline must match to be attached — applied in **`getMoveWho`, `getFundamentals`, `getNews` and `getAttribution`**, on top of the tier-1 + date + direction match. Some patterns are case-sensitive on purpose (`/\bUS\b/` so the pronoun "us" doesn't match). Verified: a US move now shows **Fed** stories, Japan shows **BoJ**, crude shows **oil**, grains shows **corn**, precious shows **gold**; the panels stay populated (thin-but-on-topic where tier-1 coverage is genuinely sparse). 63 tests. Then **news context + precision (2026-10-13)**: an attached story must now (1) **name the specific instrument** on the chart (`NEWS_FOCUS` — a cocoa chart prefers cocoa over sugar; the API returns `match: instrument|segment`), (2) **agree with the move's direction** — a new `newsDir` reads the headline's own up/down words ("surges / soars / rallies" vs "plunges / slides / falls") and a story that contradicts the move is **dropped**, and (3) be **ranked by topical relevance** (`mustScoreFor` weighs *where* the topic sits in the headline — subject vs passing mention). `/api/movewho` takes a `focus` param. Verified: corn **up → "Corn Surges…"** and corn **down → "Corn Plunges…"** (both tagged `instrument`), and a bullish story is not attached to a fall. `app.js?v=61`. 63 tests. Then **professional price wording (2026-10-13)**: the signed price score's labels changed from RICH/CHEAP to **AT A BIG PREMIUM · AT A PREMIUM · AT A SLIGHT PREMIUM · IN LINE WITH HISTORY · AT A SLIGHT DISCOUNT · AT A DISCOUNT · AT A BIG DISCOUNT** (`stretchLabel`), the READ title now asks "IS X AT A PREMIUM, A DISCOUNT, OR TIGHT?", and the prose reads "trades **at a premium** versus its own history" (the middle label reads "is in line with history", so it never says "in line with history vs its own history"). Supply & Demand labels left as-is per the call. `app.js?v=62`. 63 tests. Then **fast first load + boot beacon (2026-10-13)**: the boot awaited one long chain (~8s cold) in which the heaviest requests (**flares 3.1s, sar 2.8s**) were *below the fold*. Split `loadExtra` into **`loadExtraCore`** (inventories / equities / chokepoints / analytics / flows / products) and **`loadExtraSlow`** (flares + sar → ships/satellite; macrodash + correlations + events → MACRO); the boot now renders the core then fires the slow half **after first paint** (and on demand when the MACRO tab opens). Also always `selectMarket(...)` at boot so a **first visit** loads the read (it was skipped when there was no saved segment). Added a **static boot beacon** — a sweeping-light watchtower with signal rings + a live status line ("loading history… → prices → reading the market…") — painted on the first byte, faded when the read is up (with 6s/9s safety nets) and disabled under `prefers-reduced-motion`. `app.js?v=63`. 63 tests. Then **kill the 47s curve-history stall (2026-10-13)**: `getCurveHistory` (25 contract-months of history, each ~1.7s + a 200ms sleep) was the single slowest request at **47s cold**, and it fired on every segment switch even though it sits below the fold. It is now **lazy** — fetched only when `#curvehist-block` scrolls into view (IntersectionObserver, 300px margin) — and **trimmed to 16 months / 120ms sleep** (~30s, cached 6h). The **boot beacon now waits for the segment's core**: the read **+ the price chart + the news** (`markReady`), not just the read — so the sub-second panel fill-in happens behind it. `app.js?v=64`. 63 tests. Then **radar boot beacon (2026-10-13)**: the loading screen became a **radar scope** — concentric range rings, a crosshair, an **eased sweep** (a conic-gradient arm on a `cubic-bezier` rotation), the **♜ core**, and **six contact blips that light for real load steps** (`bootStep` + `markReady`) — genuine progress, not a decorative spinner. Static markup (paints on the first byte), fades when the segment's core is up, and `prefers-reduced-motion` stops the motion. `app.js?v=65`. 63 tests. Then **concise welcome (2026-10-13)**: the onboarding intro was rewritten to a one-line lead + three short bullets (HOME / COMMODITIES / MACRO) — no segment enumeration, no wordiness. `style.css?v=24`. Then **mobile pass (2026-10-13)**: added `viewport-fit=cover` + a dark `theme-color`; a ≤640px block now **stacks panel headers** (`.ph`), bumps **tap targets to ≥36–44px** (tabs, ghost buttons, stars, selects), adds **safe-area insets** (notched phones), **`overflow-wrap`**, and **horizontal-scroll wrappers** for the tables (`.tbl` / `#analogue` / `.glossary`), and shortens the ticker; a ≤480px block compacts further. `style.css?v=25`.
- Then **fit-the-phone width (2026-10-13)**: the page could be forced wider than the screen by any single wide child — grid items default to `min-width:auto`, so "too big / won't fit". Added `min-width: 0` to the layout containers and their children, `max-width: 100%` on canvas/img/svg/table/pre, and `flex-wrap` on the mobile top bar, so the whole app now fits the portrait width. `style.css?v=26`. Then **fix the `/api/history` 500 (2026-10-13)**: it was the one route with **no `.catch`**, and `getHistory` fetched every Yahoo/FRED/EIA series with **no per-symbol guard** — so a single flaky upstream call rejected the whole `Promise.all` and the outer handler returned **500** (surfacing as "error /api/history -> HTTP 500"). Now each benchmark is fetched in its own try/catch, the route has a `.catch` returning a valid empty shape, and the client `loadHistory` **retries once then degrades to empty** rather than showing the error banner. `app.js?v=66`. 63 tests. Then **final sweep — hardening + tidy (2026-10-13)**: `/api/market` + `/api/analytics` now `.catch` to a safe shape (no bare 500s); the client's `loadMarket`/`loadTankers` keep their **last-good** payload and `refreshLive` no longer pops the error banner on a transient; the **glossary** was rewritten to cover all commodities + macro (it was oil-only); the **README** refreshed (three tabs, nine segments, the two scores, news-on-charts, positioning marked not-surfaced); **five dead functions removed** (`renderContext` / `renderBottomLine` / `renderTightness` / `renderRegime` / `renderKPIs`) + `kpiTile`; annotated charts now say *"No big move with a trusted-news match on this chart right now."* when empty. `app.js?v=67`. 63 tests. Then **tidy the mobile top bar + ticker (2026-10-13)**: the ≤640 block had **duplicate/conflicting top-bar rules** (from two earlier passes), so the header looked messy — rewritten to a clean **two-line layout** (wordmark on its own line, controls below). The ticker now moves **visibly** on phones (`animation-duration: 45s`), **touch pauses** it, and under `prefers-reduced-motion` it becomes **swipe-scrollable** rather than frozen. `style.css?v=27`. Then **fix the mobile ticker + de-crowd the header (2026-10-13)**: the ticker *froze on iOS* because the pause-on-hover rule (`:hover`) **latches after a touch and never releases** — made worse by a `:active` pause I had added. The hover-pause is now scoped to `@media (hover: hover)` and the `:active` pause is gone, so the 45s marquee runs on phones. The crowded header (clock · updated · CSV · DAILY BRIEF · ↻ · ?) is de-cluttered: **CSV + DAILY BRIEF now live in the footer on phones** (`.desk-only` / `.mobile-only`), leaving a tidy single-line header. `style.css?v=28`.

## Latest (2026-10-15) — the alert surface is retired from the site
- **The user's call: they don't need the on-site alerting.** Removed from the **UI** (the endpoints stay):
  * **HOME → the whole `#p-alerts` panel** — the alert board (`#home-alerts` + count), the custom
    **ALERT RULES** editor (`#home-rules`, the "tell me when X is above/below/crosses Y" form + list),
    the **delivery-status** line (`#notify-status`) and the public **GET THESE ALERTS** subscribe form
    (`#subscribe` / `#sub-target` / `#sub-go` / `#sub-msg`).
  * **Header: `EXPORT CSV` + `DAILY BRIEF`** buttons, and their duplicate pair in the mobile footer
    (`.exports.mobile-only`). The `#p-alerts` chip is gone from the HOME jump-nav.
  * **Dead code/CSS** that only existed for the panel: `loadAlerts` / `renderHomeAlerts` / `allAlerts`
    / `loadNotifyStatus` / `renderRules` / `pushRules` / `syncServerRules` / `computeRules` + the
    localStorage rules cluster (`RULES_KEY`, `rules()`, `saveRules`, `metricGroups`, `ruleLabel`,
    `ruleValue`, `rulePrev`, `ALERT_RANK`, `serverAlerts`, the server-rules flags) and ~24 CSS rules
    (`.subscribe*`, `#home-rules`, `.rules-*`, `.rule*`, `.exports`). `app.js` −63 lines.
- **Deliberately kept** (still correct and tested, just no longer reachable from the page): every
  endpoint — `/api/alerts`, `/api/rules`, `/api/notify`, `/api/subscribe`, `/api/confirm`,
  `/api/unsubscribe`, `/api/digest`, `/api/export.csv` — so the **server-side alert loop and the daily
  email brief keep working** for the owner (Resend/SMTP delivery is unchanged), and the **COMMODITIES →
  DATA CHECKS** alert list + THRESHOLDS editor is untouched (it is a different panel; `.alert`/`.alerts`
  CSS is shared with it, so those rules stay).
- **Tests:** `tests/api.test.js` now asserts the panel is *gone* (`#p-alerts`, `#home-rules`,
  `#subscribe`, the `EXPORT CSV` button, the `href="/api/digest"` link) while `#alerts` /
  `#alert-count` / `#alert-settings` (DATA CHECKS) remain. **94 tests pass.** Headless sweep: all eight
  removed nodes absent, all eight kept HOME panels present, **zero console errors**.
  `app.js?v=111`, `style.css?v=57`.
- **Quick-jump tidied into a grouped menu (2026-10-15).** The ⌘K / JUMP box opened on a wall of
  **instrument** names — `WTI (Cushing)`, `Brent`, `RBOB Gasoline`, `ULSD / Heating`, `Jet Fuel (USGC)`…
  each tagged `Instrument` — which buried the things people actually navigate by. It is now a short
  **grouped menu**: `COMMODITIES` (one row per commodity) · `COUNTRIES` · `SECTIONS`, with a group
  heading instead of a per-row tag, and no echoed labels (`Japan` no longer reads `Japan · Japan`).
  Instrument names are gone from the list but stay **searchable** — each commodity row carries its
  instruments' names *and* the everyday words for them, so `brent` → Crude oil, `diesel` → Refined
  products, `gold` → Precious metals, `wti` → Crude oil. Ordering is group-first then best-match, so
  groups never interleave and ↑/↓ never lands on a heading. The default list shows 12 rows and
  `.palette-list` grew 46vh → 58vh so the *second* heading is visible on open (countries used to be
  hidden below the fold). Wording follows: placeholder "Jump to a commodity, country or section…",
  JUMP's aria-label drops "instruments". Verified in headless Chrome at 1200×820 **and** 390×844:
  groups render in order, ArrowDown walks rows only, Enter on `crude` → COMMODITIES/crude, Enter on
  `japan` → MACRO/jp, **zero console errors**. 94 tests. `app.js?v=112`, `style.css?v=59`.
## Latest (2026-10-15) — pruning the navigation surface + a real "open this instrument" fix
- **Quick-jump removed (⌘K / JUMP).** The user tried it, had it tidied, then decided it isn't needed:
  gone are the header `JUMP` button, the `#palette` dialog, the `⌘K`/`Ctrl-K` binding, its CSS
  (`.palette*`, `.pl-*`, ~15 rules) and its JS (`paletteIndex` / `paletteMatch` / `palettePaint` /
  `paletteMove` / `paletteGo` / `openPalette` / `closePalette`, `PALETTE_GROUPS`, `PALETTE_ALIAS` —
  ~124 lines). The **in-page chip nav (`.jumpnav`) stays**.
- **HOME → SEGMENTS board removed** (`#p-segments` / `#marketstate`, its jump-nav chip, the
  `renderMarketState()` function + its 4 calls + the tile click handler + its CSS). The SCREENER
  (every instrument, ranked) and the WATCHLIST already cover that ground. HOME now ends at HEADLINES,
  and its chips are Brief · Markets · Screener · Risk · Calendar · Watchlist · Headlines.
- **Clicking a watchlist tile (or a screener row / component card) now opens THAT instrument.** The bug
  behind "it sent me to some random segment": `pickMetric(id)` only sets `#metric` **if the open
  segment's dropdown already contains that option** — and the dropdown is rebuilt per segment — so an
  instrument belonging to another segment was silently ignored and you stayed on whatever segment
  happened to be open. New shared `goToInstrument(id, range)`: find the segment that owns the
  instrument → `selectMarket()` (which rebuilds the metric options) → set `currentComponent` so the
  snapshot **and THE READ** follow the instrument, not the segment headline → `pickMetric()` →
  `renderSnapshot()` + `loadMarketRead()`. Wired into the HOME watchlist tiles, the COMMODITIES
  component cards and the screener rows. Verified headless: with `crude` open, a pinned **Corn** →
  `#/commodities/grains/corn` ("Grains & oilseeds · CORN"); then **WTI** → `#/commodities/crude/wti`;
  a screener row for **sugar** → `#/commodities/softs/sugar`. Zero console errors. 94 tests throughout.
  `app.js?v=114`, `style.css?v=60`.
- **Mobile pass for the pruned UI (2026-10-15).** Everything removed above is gone on phones too, and the
  mobile layout was re-measured at **320 / 360 / 390 / 430px** across all three tabs:
  * **Dead CSS dropped:** the `.desk-only` / `.mobile-only` utilities (their only users were the header
    CSV/BRIEF links and the phone footer pair — all removed), the `.ms-*` SEGMENTS-board tiles (+ its
    ≤480 override), and a stale "CSV/DAILY BRIEF live in the footer on phones" comment.
  * **Every control is now ≥32px tall on a phone** (the audit found 21–31px): the tape's pause button
    (24 → 34px, via `.tk` padding so the tape and the button grow together), the section chips
    (28 → 36px), the panel fold headers `.fold-panel > summary` / `.fold summary` (29 → 42/37px), the
    calendar month arrows (28 → 40px), the screener's filter dropdown + ALL/NONE/THIS SEGMENT buttons
    (21 → 34px), its picker labels and checkboxes, the watchlist stars (31 → 36px), the screener table
    headers (29 → 34px) and Leaflet's zoom buttons (30 → 34px — needs `.leaflet-control-zoom
    a.leaflet-control-zoom-in` to outrank Leaflet's own `.leaflet-touch .leaflet-bar a`).
  * **Measured after the pass: 0 tap targets under 32px and 0 horizontal overflow** at every width on
    every tab. The two remaining sub-32px hits are prose credit links (aisstream.io, Leaflet) — correctly
    inline text, not controls. The chips' and screener table's edge clipping is their own
    `overflow-x: auto` scrollers, by design. `style.css?v=62`.
- **Watchlist/screener taps now open the instrument's page at the TOP (2026-10-15).** `pickMetric()`
  ended by scrolling `#chart-panel` into view, so a tap on a watchlist tile switched tabs but left you
  part-way down the page you had just opened (in the middle of it). It now takes a `land` argument:
  `'chart'` (the default — unchanged, and still right when you switch metric from *inside* the page,
  where the chart is what you want to see) or `'top'`, which scrolls the window straight to the top.
  `goToInstrument()` — i.e. the watchlist tiles, the screener rows and the component cards — passes
  `'top'`, so a tap is treated as a page change. Measured on a phone: tapping a pinned **Corn** from a
  page scrolled to y=4106 → `commodities / grains / corn` at **y=0**; the same for a screener row.
  Verified the in-page path is untouched: a macro metric link still lands with the chart panel at its
  72px `scroll-margin-top`. Back/forward is untouched too (`applyRoute` keeps its own behaviour, since
  `popstate` should preserve the browser's scroll). 94 tests. `app.js?v=115`.
## Latest (2026-10-16) — Gulf + Africa macro countries (Phase 1)
Six new countries in **two new regions**: **Middle East → Saudi Arabia, UAE, Qatar** and **Africa →
South Africa, Nigeria, Kenya**. Every source was probed live before any code was written; the honest
gaps are handled, not hidden.
- **Currencies (all 6)** — Yahoo FX, live and rich history. The three Gulf pairs are **USD-pegged**
  (SAR 3.75 · AED 3.6725 · QAR 3.64), so they carry a `peg` field and the app **drops their % moves**:
  the upstream series holds bad ticks (USDSAR reads 3.6397 for days then jumps to the true 3.7526) and
  a peg is a constant, so *any* % change off it is noise. The card shows the level and states the peg;
  the chart plots the equity line only ("a flat line says nothing"); and the commodity-correlation block
  is replaced by "nothing to correlate". This kills three separate lies at once.
- **Equity lines** — **no Yahoo index exists** for Tadawul/DFM/QSE/NGX/NSE (`^TASI.SR`, `DFMGI.AE`,
  `^CASE30`, `^NGX`, `^NSE20` all return empty; every `.LAG`/`.QA`/`.MA` listing 404s). The US-listed
  iShares country ETFs are the live proxy at every chart range (22/65/127/198/251/61 pts, same as the
  existing THD/EPHE/VNM): **KSA, UAE, QAT, EZA** — labelled "(KSA ETF proxy)" etc.
  **Nigeria and Kenya have no free equity line at all** — `NGE` (Global X Nigeria) is gone, `EGPT`/`MOR`
  are dead, and **`KEN` is Kenon Holdings, an Israeli company, NOT Kenya** (caught before shipping).
  Both ship `index: null`, which the app already declared honestly ("No free equity index exists for
  this country") — the path had never been exercised before.
- **Annual macro** — `scripts/fetch-macro.mjs` (IMF WEO → `data/macro.json`) extended to all six and
  re-run: 24 countries now. It tolerates gaps (no unemployment line for AE/QA/KE → World Bank fallback),
  and unemployment now **prefers the newer vintage** (Nigeria's IMF line stops in 2018; the World Bank
  has 2025) with the card's source line saying exactly which is which.
- **Policy rates** — BIS carries **Saudi (4.5%)** and **South Africa (7.25%)**; it does **not** carry
  AE/QA/NG/KE, so those four get a `POLICY_NOTE` explaining why (the Gulf rates mechanically track the
  Fed behind the peg) instead of a blank.
- **Catalysts** — TradingView's calendar has SA (13), ZA (59), NG (4), KE (3), AE (1) but **zero for
  Qatar**; the panel says "No releases scheduled" rather than inventing one. Holidays are now dropped by
  `indicator === 'Holidays'` (the word filter alone let Kenya's *Mashujaa Day* through as a catalyst).
- **News relevance** (the user's hard rule) — 6 fresh on-topic items each, verified. Two real leaks were
  found and fixed: (1) the country queries were **double-bracketed**, and `getMacroNews` already wraps
  them, so Google treated them as one phrase — 100 results became 1 (`sa` kept a 626-day-old story);
  (2) `getMacroNews` matched on the *query* alone, so a Qatar outlet's Africa story and a **Ugandan
  shilling** story reached Qatar/Kenya cards. Country news must now also **name the country**
  (`titleMatches`), and "shilling" was dropped from the Kenya query. All 24 countries still return 4–6
  items — tighter, nothing starved. `app.js?v=116`.
## Sweep of the Gulf/Africa addition (2026-10-16) — 3 bugs found and fixed, + the Nigeria ETF verdict
The user asked for a sweep and a harder look at a Nigeria equity line. Both done.
- **Nigeria: there is no usable equity instrument, definitively.** Yahoo's own symbol search (which
  is how you find anything) returns **no ETF** ("Nigeria ETF" → 0 hits; Global X's `NGE` is gone),
  **no Lagos listings** (`.LAG` 404s), and only **reference-only MSCI entries** — `^704932-USD-GRTR`,
  `^704932-USD-STRD`, `^704958-USD-*` and friends exist in search but return **no chart data at any
  range**, exactly like `^TASI.SR`. Same story for Kenya ("MSCI Kenya" → 0 hits). So `index: null` is
  the honest answer and it stays. Dangote reaches the desk through news instead, which is where the
  story actually lives.
- **Bug 1 — the pegged-currency fix only covered the country card.** The fake "+3.3% today" on USD/SAR
  (from Yahoo's bad prior tick) still leaked into **three other publish paths**: the all-country top
  tape (`/api/macro-tickers`), the region board behind the CURRENCIES panel (`/api/region-quotes`) and
  the macrodash currency tape. All three now run quotes through one helper — `noMoveIfPegged(c, quote)`
  — and the peg lives on the currency definition too (`FX_SYMS … peg: 3.75`). A regression test asserts
  the Gulf region board reports `pct: null` **and** empty deltas while still reporting the level.
- **Bug 2 — the new currencies were not chartable.** `FX_SYMS` drives both the CHART's CURRENCIES
  dropdown and whether a CURRENCIES tile is clickable, and SAR/AED/QAR/NGN/KES weren't in it (ZAR
  already was) — so the Gulf/Africa tiles were inert. Added, with the three pegs marked. Verified: the
  tile now carries `data-metric=fx:usdsar` and clicking it charts that pair.
- **Bug 3 — the new regions could never show a cross-asset signal.** The transmission rules' `regions`
  tags covered only us/eu/jp/apac/cn/in, so "CROSS-ASSET — HOW THIS REGION IS AFFECTED" was **always
  empty** for Middle East and Africa, even with oil down 6% in a month. Tagged: the two oil rules now
  include **me + af** (both are oil-exporting regions), and the dollar / gold / copper / food-inflation
  rules include **af**. Verified live: me = 1 idea, af = 2 (was 0/0).
- **Label fixed:** the inflation panel said "(World Bank)" while the number is the **IMF WEO snapshot**
  for most countries → "(IMF WEO / World Bank)".
- Regression checks: all 24 countries still return 4–6 fresh news items, all 6 new country cards load
  (1–5 ms warm), no console errors, no horizontal overflow, 94 tests pass.
## Ticker + relevance sweep (2026-10-16) — every symbol verified, country news gated to tier-1
- **Symbol audit (134 symbols).** Every Yahoo symbol in `BENCHMARKS`, `FX_SYMS`, `MACRO_COUNTRIES` and the
  dashboard tickers was fetched and compared against the name Yahoo actually reports. The only
  mismatches are benign labels: `CL=F` → "Crude Oil Nov 26" (the app says WTI — correct), `ALI=F` →
  "Aluminum Futures", `DX-Y.NYB` → "ICE US Dollar Index", `^STI`, `^TWII` → "TSEC CAPITALIZATION
  WEIGHTED" (= TAIEX ✓), `^VIX`, `^TNX`. No `KEN`-style error left anywhere.
- **Two tickers were blank, and I know why.** Jet fuel and propane are **spot-only** and came from the
  **keyed** EIA v2 API, so with no `EIA_API_KEY` (any local run) they rendered "—" with no explanation
  — production has the key, which is why the live site looked fine (4.562 / 1.07). They now use EIA when
  the key is present and fall back to **FRED's mirror of the same series** (`DJFUELUSGULF`,
  `DPROPANEMBTX`) when it isn't, so they populate with no key at all — verified: 4.562 and 1.070, the
  same numbers production reports.
- **The "random news" in Nigeria and Kenya — root-caused.** The country news path never *required* a
  tier-1 wire, it only *scored* one, so the panels filled with content farms and blogs
  (`UA.NEWS`, `nigeriahousingmarket.com`). Country news now carries the site filter **and** must match
  `TIER1_RE` on the source. Result across all 24 countries: **0 with a non-tier-1 source, 0 empty.**
  Nigeria now leads with inflation + the Dangote refinery stories (Reuters/Bloomberg) — better content
  than before, not just cleaner.
- **The 30-item window was hiding Qatar.** Of 100 tier-1 stories, only 28 actually *name* Qatar and none
  were in the first 30, so its panel read as empty. The fetcher now asks for the full 100.
- **"Not available" is now said out loud.** The country card silently dropped the equity tile for
  Nigeria and Kenya, which reads as an omission rather than a fact. It now shows an **"Equity market ·
  N/A · no free index exists for this country"** tile plus a note naming the country. (Bond yields and
  CPI already said "no free … for this country", and the INDEX vs FX chart already said it.)
- **`newsLabel` showed the raw id** — the panel header read "ke · tier-1 wire". It now resolves country
  names ("Kenya"), and the two new regions gained the `NEWS_QUERIES` / `NEWS_MUST` entries every other
  region already had.
- 94 tests pass, including a new assertion that country news comes from a real wire.
## The daily brief now covers macro, not just commodities (2026-10-17)
- **The gap:** `buildBrief()` built "what happened" from `m.benchmarks` only (the 31 commodity
  instruments) plus the WTI curve, US crude stocks and CFTC positioning. So a day like *"MSCI may cut
  Indonesia from its indices → stocks fall the most since 1998"* never appeared on HOME at all.
- **New `macro` section.** Every country tape item already carries the same multi-horizon deltas as the
  commodity tape, so the brief now ranks all 24 countries' indices and currencies by today's move.
  Bars: index **≥1.5%**, floating currency **≥0.75%** (below that the block would cry wolf every day).
  **Pegged Gulf currencies carry no deltas at all**, so they can never appear as a fake mover.
- **Each top mover gets the wire story that explains it** — the most recent (≤4 days) tier-1 headline,
  preferring one whose own direction agrees with the move (a "stocks tumble" story for a fall), and the
  line deep-links to that country's MACRO page (`#/macro/<region>/<id>`).
- **The headline names a dramatic macro move too:** *"Biggest move: Class III Milk up 15.0% · South
  Korea's index down 7.6% · WTI (Cushing) basis at the 100th percentile — physical dislocation."*
- **Rendered as its own block** directly under the headline — **always present**, with an honest line on
  quiet days ("No country index moved more than 1.5% …") so a reader can tell macro *is* covered; the
  commodity column is now labelled **COMMODITIES — WHAT HAPPENED** so the two never blur. Verified on
  desktop and mobile (no overflow). `app.js?v=118`, `style.css?v=63`.
- 95 tests — new: the brief carries a macro section, each mover has a country deep link, and a pegged
  currency is never listed as a mover.
## Americas: Brazil + Venezuela added (2026-10-19)
The Americas region had only the United States. Brazil and Venezuela are now there (3 countries).
- **Brazil — a full card, and better than the others: it has a REAL index.** `^BVSP` (Ibovespa) works at
  every chart range (22/65/127/198/249/61 pts), so it needs no ETF proxy. Yahoo FX ✓, IMF WEO complete
  (GDP 2.3% · CPI 5.0% · debt 93.3% · unemployment 6.0%), **BIS Selic 13.75%**, 12 TradingView releases,
  tier-1 news ✓, and real commodity links (soybeans −0.32, sugar 0.19, coffee 0.17, Brent −0.04) because
  the real floats. `iso3 BRA`, `oil: exporter` (net crude exporter).
- **Venezuela — thinner, and every gap is stated.** FX `USDVES=X` ✓ (with the collapse visible: +198.7%
  YTD, +337.3% 1y). **No ETF and no usable index**: "Venezuela ETF" returns 0 hits on Yahoo; the frontier
  funds that once held it (`FM`, `FRN`) are gone; the LatAm ETFs (ILW/FLLA/EWZ) exclude Venezuela (MSCI
  dropped it in 2016), so using one would be the `KEN` mistake again; and the Caracas index `IBC.CR`
  returns exactly **one** data point at every range (the exchange's two single stocks, `BVL.CR` and
  `TDV-D.CR`, do quote — but two names are not a market). So `index: null` → the card says "Equity market:
  not available" ✓. No BIS policy rate → a `POLICY_NOTE` explaining that the rate shown is the **official
  BCV reference** and a parallel rate trades weaker ✓. No calendar (0 events) ✓. Debt/GDP missing →
  "not available" ✓. IMF CPI **252%** and the WB unemployment (2025) via the newer-vintage rule ✓.
- **The CPI chart now switches to a log axis when the spread is extreme** (Venezuela runs 21% → **65,374%**
  in 2018; on a linear axis that is one spike and a flat line). Condition: every value > 0 and max/min > 50,
  and the note says "· log scale" so the reader knows. Other countries are unaffected.
- Snapshot regenerated: **26 countries**. 95 tests (new: Brazil has a real chartable index + its Selic and
  soybean link; Venezuela declares its missing index and explains the controlled rate). `app.js?v=119`.
## Americas: Mexico added (2026-10-19) — the set's biggest hole
**Why it was the obvious one to add:** the app already treated the peso as a first-class ticker — `usdmxn`
sits in `FX_SYMS` ("USD / MXN · oil") and `FX_LINKS` pairs **USD/MXN with WTI** — but there was no
country page behind it. So the app was internally inconsistent. It also has the most complete data of any
candidate tried: a **real index** (`^MXX`, S&P/BMV IPC, at every chart range), **Banxico's rate on BIS**
(6.50%), full IMF WEO + World Bank (GDP 0.5% · CPI 3.8% · debt 61.7% · unemployment 2.6%), **30
TradingView releases**, and **100% tier-1 news coverage**. The Americas region is now
**United States · Mexico · Brazil · Venezuela**.
- Links: **WTI crude** (Pemex exports Maya crude — and this matches the existing MXN↔WTI link) and
  **silver** (Mexico is the world's largest silver producer). `oil: exporter` on a crude basis, which is
  how the app frames it (it is a net importer of refined product, worth knowing but not what the field means).
- News deliberately does **not** match a bare `/\bpeso\b/` — that would pull Argentina/Chile/Colombia.
  It matches Mexico / Mexican / Banxico / Pemex / CDMX.
- Snapshot regenerated: **27 countries**. 95 tests (new: Mexico's IPC quotes, its Banxico rate is present,
  and it links to both silver and crude).
## Americas: Argentina added (2026-10-19)
The Americas region is now **United States · Mexico · Brazil · Argentina · Venezuela** (5).
- **Real index:** `^MERV` (MERVAL) works at every chart range (22/65/126/195/246/61) — no ETF proxy.
  Verified charting locally: 246 points on the 1y window, +47.7% over a year.
- **IMF WEO complete:** GDP 4.5% · CPI 41.9% · debt 80.1% · unemployment 7.4%. World Bank agrees on
  GDP/CPI/unemployment but has no debt series, so the snapshot is what shows.
- **The policy rate is deliberately left out.** BIS's Argentina series **stops at 2025-07-10** (29%) —
  fifteen months stale while Brazil's runs to today. The BCRA rate moves often, so rather than print an
  old level as "the policy rate", `POLICY_NOTE.ar` says exactly that. (This is the first country where I
  chose to omit a rate that *exists* but is too stale to be useful — the app's rule is show or say why,
  never show stale-as-current.)
- **Commodity links, the Pampas complex:** soybeans 0.34 · wheat 0.10 · corn 0.21 · live cattle −0.26.
  `oil: exporter` on the Vaca Muerta flip (it remains a net importer of refined product).
- News avoids a bare `/\bpeso\b/` (would pull Chile/Colombia/Uruguay/Mexico) — matches
  Argentina/Argentine/Milei/BCRA/Buenos Aires. Tier-1 coverage is plentiful (100/100 in the probe);
  first live headline: *"Argentina analysts hike up 2026 inflation, trim growth"* (Reuters).
- The CPI chart stays linear for Argentina: the log rule needs every value > 0, and 2000–01 are negative
  (−1%), so the 2024 spike (220%) is shown as-is rather than reshaped.
- Snapshot regenerated: **28 countries**. 95 tests (new: the MERVAL quotes, soybeans are linked, and
  `policy` is null **with** the note explaining the stale BIS series).
## Commodities: steel, iron ore, orange juice, rough rice (2026-10-19) — 31 → 35 instruments
I probed every plausible addition first. Most are **data-blocked**, so these four are the ones with a real
free daily futures market:
- **Steel (HRC)** `HRC=F` · $/st · ~$1,320 → into **Industrial metals**. The app had no steel at all, which
  is the industrial cycle itself (autos, construction, machinery).
- **Iron ore 62% Fe** `TIO=F` · $/t · ~$90.9 → into **Industrial metals**. The China-demand bellwether, and
  paired with HRC it makes the **steel margin** visible (ore → coil) — the same idea as the refining
  cracks and the soybean crush. The component strip now reads Copper · Aluminium · Iron ore · Steel.
- **Orange juice** `OJ=F` · ¢/lb · ~140.9 → into **Softs** (now 6).
- **Rough rice** `ZR=F` · $/cwt · ~17.3 → into **Grains & oilseeds** (now 6).

Wiring that each new instrument needed, and what it turned out to support:
- **Curves:** OJ and rice quote individual months on Yahoo (`OJ F27.NYB`, `ZR H27.CBT`) — but only their
  *odd* months resolve, so the curve panel shows the 3 of the next 6 that exist (the app already tolerates
  gaps, as it does for coffee). **Steel and iron ore have no monthly contracts on Yahoo** (`HRC*.CME` 404s),
  so `curve: false` — declared, not broken.
- **CFTC positioning:** exact `contract_market_name` values fetched from the live report —
  `STEEL-HRC` (net +8,854, 77th pctile), `FRZN CONCENTRATED ORANGE JUICE` (+472, 12th), `ROUGH RICE`
  (+3,496, 88th), all as of 2026-10-13. Iron ore is **not** a CFTC contract → `cot: false`.
- **News markers:** `NEWS_FOCUS` added for all four so their price charts get big-move annotations.
- **Segment copy:** the industrial block now asks "ARE COPPER, ALUMINIUM & STEEL TIGHT?", lists iron ore &
  steel as catalysts, and names **the steel margin (iron ore → HRC)** as a thing to watch.

**What I checked and could NOT add** (so nobody re-tries it): lumber `LBS=F` 404 · canola `RS=F` empty,
`CAN=F` 404 · robusta `RC=F` 404 · Minneapolis wheat `MW=F` 404 · uranium `UX=F` returns **one** point ·
Baltic Dry `^BDI`/`BDIY` 404 · nickel only as an ETC proxy (removed once already for being misleading) ·
coal, TTF gas, lithium, cobalt, carbon have no free futures. The miners ETFs that do work
(`SLX`, `URA`, `LIT`, `CPER`) are **equity baskets, not the commodity** — the promise is physical prices,
so they are not used for rows (they remain fine as cross-asset chips, e.g. GDX).

**35 instruments.** 95 tests (the pinned segment-component assertions updated). Verified in the browser:
35 screener rows, the 4-tile industrial strip, the OJ chart, no console errors, no overflow.
## Steel margin — the industrial twin of the soybean crush (2026-10-19)
The steel chain was visible but not analysed. There is now a **STEEL MARGIN** panel on the INDUSTRIAL
segment (only that segment — the same `data-when` gating as the crush on grains).
- **The maths** (`computeSteel`, pure + unit-tested): HRC is quoted per **short ton** and iron ore per
  **metric tonne**, and a tonne of crude steel takes ~**1.6 t of ore** — so the coil price is converted
  ($/st ÷ 0.90718474) and 1.6 × ore subtracted. It also returns the **coil ÷ ore multiple**, which is what
  analysts quote alongside the spread. Live: HRC $1,320/st → $1,455/t · ore $90.9 × 1.6 = $145/t →
  **margin +$1,310/t · ratio 16.0×**, both in the 100th percentile of the last two years.
- **It is labelled a GROSS spread** — the header, the legs card and the note all say it excludes coking
  coal, energy and scrap, so nobody mistakes it for a mill's profit.
- **The read is relative, not absolute** ("wide / normal / compressed vs its own history"), because a gross
  spread has no universal line between healthy and thin the way a $/bu crush does.
- **The chart** is the margin ($/t) + the coil ÷ ore multiple over six months, with big-move markers —
  focused on `steel` news so a margin move is explained by a steel story rather than the copper headline
  that happens to be in the segment's feed.
- `/api/steel` (cached 3 h) returns margin, percentile, ratio, both percentiles, the two legs and 180 days
  of history. Verified in the browser on desktop and mobile: the panel shows only on INDUSTRIAL, hides for
  grains (where the crush shows instead), no console errors, no overflow.
- **96 tests** (new: `computeSteel` — the exact 907.18474 $/st → $1,000/t conversion, the 1.6 t ore cost, the
  ratio, and that a missing leg invents nothing). `app.js?v=120`.
## Positioning-vs-price divergence (2026-10-20) — the last open investor-roadmap item
- **The tell:** price rising while speculators *cut* (fading the move) or price falling while they *add*
  (buying weakness). Both legs have to be material — price **≥3%** and net **≥1 point of open interest** —
  so it does not cry wolf every week.
- **How it is measured:** net positioning as a **share of open interest** (so contracts of different sizes
  compare), over a **13-week** window of the weekly CFTC series, with the price taken **at or before** each
  report date (the reports are as-of Tuesday). Pure `positioningDivergence()` in `src/lib.js`, unit-tested
  for bear / bull / aligned / not-enough-history / no-price.
- **Where it shows:** the POSITIONING panel's `PRICE vs POSITIONING` line, with a watch/ok chip. Live now:
  **WTI — price +18.7% over 13 weeks while specs cut 5.2 points of open interest → "fading the move, not
  driving it"**; soyoil reads bullish divergence, NFDM and whey bearish, everything else aligned or flat.
- **Bug found and fixed while wiring it:** the **livestock** segment had **no CFTC mapping at all**, so its
  positioning panel always said "no series" even though the app's flags claimed COT coverage. Added the
  exact contract names verified against the live report — `LIVE CATTLE`, `LEAN HOGS`, `FEEDER CATTLE`.
  Live: cattle +26.3k contracts (2nd pctile), hogs −81.8k (1st), feeder −1.2k (26th).
- 97 tests. `app.js?v=121`.
## Economic calendar: every macro country, with consensus (2026-10-20)
The HOME calendar used to be **structural only** — EIA weekly, futures expiry, WASDE, FOMC, OPEC+. It now
also carries **every macro country's upcoming releases**, in one TradingView request (the feed accepts a
country list): **195 events across 26 of 28 countries** in the 45-day window.
- **Qatar and Venezuela are genuinely absent** — TradingView publishes **zero** events for either. Nothing
  is invented to fill the gap.
- **Importance fallback per country:** high-impact releases first; if a country has none in the window, its
  medium ones; if it only publishes low-impact data (Kenya's GDP print is flagged low there), its next
  couple — so no country goes silently missing. The structural events stay alongside.
- **Consensus and prior are real.** The payload carries `forecast`/`previous`, so the panel's old line
  *"dates only — no free consensus, so no forecasts (never invented)"* was simply wrong; it now reads
  "every macro country · high-impact releases · consensus & prior where TradingView publishes them", and
  each event carries e.g. `2:00am ET · consensus 3.4 · prior 3.1`.
- **UI:** month cells show at most **2 chips + "+N"** (a busy day carries 20+ releases across 28
  countries), each prefixed with the country code; the tooltip has the country, time and consensus; the
  month list below spells every event out (`AR · Leading Indicator MoM · TradingView · Argentina ·
  1:30pm ET · prior −0.27`). On phones the chips stay dots and the "+N" is hidden.
- **Two incidental fixes:** `calRow` now **escapes** feed text (it didn't), and the brief's "WHAT'S ON
  TODAY / NEXT" names the country and **dedupes** — it used to list the same weekly EIA print four times.
- 98 tests (new: ≥15 countries present, each with a readable country name, consensus/prior appears, and
  the structural events survive). `app.js?v=122`, `style.css?v=64`.
## Economic calendar: a short list, not a wall (2026-10-20)
The user's note: *"when I scroll the economic calendar you showed me too much — just put a list of
important events on that day."* Fair: the panel was a month grid **plus** a 73-row month list.
- **It is now one list**: the next **10 days** of releases worth acting on — the structural ones (EIA,
  futures expiry, WASDE, FOMC, OPEC+) plus country releases flagged **high-impact** — grouped by day
  (`TODAY · OCT 20`, `TOMORROW · OCT 21`, `THU · OCT 22`, …), at most **4 per day** and **12 in total**,
  with a `DATE VARIES` group for the undated OPEC+ meeting.
- Each row: **time (ET) · country · event**, the source on the right, and the **consensus / prior** on
  the line beneath. The panel went from ~1,600px of grid+list to **827px**.
- **Removed with it:** the month nav (`‹ OCTOBER 2026 ›`, TODAY), `calMonth` state and its click handler,
  and all the grid CSS (`.cal-grid`, `.cal-dow`, `.cal-day*`, `.cal-ev`, `.cal-more`, `.cal-nav`,
  `.cal-title`, `.cal-head`, `.cal-date`, `.cal-list` — 31 rules), replaced by `.cal-dayh` / `.cal-time`
  and a 4-column row. Phones keep the same list with the source hidden.
- `/api/calendar` now sends `time` separately from the consensus note, so the list can lay them out.
- 98 tests still pass (the calendar test is unchanged and still checks ≥15 countries + consensus).
  `app.js?v=123`, `style.css?v=66`.
## Calendar: the month grid is BACK, with one selected day's events under it (2026-10-20)
**My mistake:** I read "just put a list of important events" as "replace the calendar with a list" and
removed the month grid — which the user likes. It is back, and the real complaint (a 73-row month dump
under the grid) is fixed properly:
- **The grid stays** — every macro country's **high-impact** releases plus the structural ones, max **2
  chips per day + "+N"**, tooltips carrying the country, time and consensus, month nav `‹ OCTOBER 2026 ›`
  and TODAY, and cells that respond to click *and* Enter/Space.
- **Only ONE day is listed underneath** — `TODAY · OCT 20` by default, or whichever date you click
  (`FRI · OCT 23`), showing that day's rows: **time · country · event · source**, with consensus / prior
  on the line beneath. No month dump.
- **Restoring the grid also restored `.cal-row` / `.cal-date` / `.cal-name` / `.cal-src` / `.cal-note`,
  which the MACRO catalysts list shares** — those rules had been deleted with the grid, so the catalysts
  panel was unstyled for a commit. Both lists now use one 3-column `118px · 1fr · auto` row, note spanning
  the width; phones stack it.
- 98 tests pass. `app.js?v=124`, `style.css?v=67`.
## Loading screen: the "free plan" blurb is gone (2026-10-20)
The boot beacon printed *"Waking the server — the free plan sleeps when it's idle, so the first visit after
a while can take 20–30 seconds. It'll fill in on its own."* — yes, I added it during the cold-start work
(cold starts really were 20–30s and the splash looked broken without an explanation), but it reads like
pricing chatter on a professional desk.
- **Removed**: the `#boot-note` markup, the code that un-hid it, and `.boot-note` CSS. Nothing else
  references it.
- **Kept**: the subtle status line *"waking the server…"* and the 25s failsafe (driven by
  `window.__coldStart`), so a cold start still doesn't flash a half-empty shell at 9s — it just no longer
  explains the hosting plan.
- `app.js?v=125`, `style.css?v=68`.
## Reload always starts on HOME (2026-10-20)
The app restored the last tab from **two** places, so a reload dropped you back into MACRO:
`localStorage['oilbasis.tab']` (`showTab` wrote it, the boot re-applied it) **and** the URL hash — every
navigation rewrote it to e.g. `#/macro/us/us`, and the boot replayed it through `applyRoute`.
- **Both are ignored at boot now.** The boot calls `showTab('home')` and rewrites the hash to `#/home`, so
  neither the saved tab nor a stale hash can restore a view. The remembered COMMODITIES *segment* is still
  restored (useful, harmless) — only the tab is pinned.
- **Deep links still work when you actually go to them**: a new `hashchange` listener applies the route,
  so pasting `#/macro/us/mx` while the app is open navigates there. Back/forward still works (`popstate`).
- Verified in the browser: first load → home · click MACRO → `#/macro/us/us` · **reload → home** · reload
  from COMMODITIES → home · paste `#/macro/us/mx` → macro. No console errors.
- `app.js?v=126`.
## Country loading: what was actually slow (2026-10-20)
Measured every country before touching anything:
```
cold /api/country   fr 913ms   us 1028ms   de 1015ms   in 1368ms   au 1283ms
warm                all 1-3ms
```
**France was never the slow one** — the fastest of the big four. What made a country *feel* slow was the
app firing the **region prefetch immediately**: the EU is 4 countries and each payload is ~15 upstream
calls, so it competed with the country you had just opened. Three per-country calls also had **no client
cache** (region-quotes, catalysts, macro-news).
- The prefetch now runs on **idle** (`requestIdleCallback`, 2.5s fallback), so the visible panel gets the
  connections first.
- `region-quotes` / `catalysts` / `macro-news` are cached client-side (5 / 10 / 5 min), so switching back
  to a country is instant.

## MACRO chart: INDEX vs BENCHMARK, not vs currency (2026-10-20)
The chart compared a country's index with **its own currency**. It now compares the index with whatever
you choose — **another country's index by default** (S&P 500; Euro Stoxx 50 when you are looking at the
US), or a **currency**, or a **commodity**.
- `resolveVs()` + `vs=` on `/api/country-series`: `idx:<country>` (that country's index), `fx:<currency>`,
  `bench:<commodity future>`. Cached per (country, range, vs); the response carries `vs`, `vsSpec`,
  `vsLabel`.
- The panel has a selector with **78 options in three groups** — INDICES / CURRENCIES / COMMODITIES — and
  the pick is remembered in `oilbasis.macroVs`. The panel and its jump-nav chip are renamed
  **Benchmark**.
- Countries with no free index (Nigeria, Kenya, Venezuela) chart their **currency** against the benchmark
  instead, and the note says so.
- Verified: Japan → Nikkei vs S&P 500 (243 / 251 points) · US → S&P vs Euro Stoxx 50 · France → CAC 40 vs
  EUR/USD · Japan → Nikkei vs Gold; switching saves and redraws.
- `app.js?v=127`.
## HOME daily brief — visual redesign (2026-10-20)
It was three identical bulleted lists of sentences: every line carried three facts, the numbers were bold
but not coloured, and the run-on headline repeated the top of each list.
- **Three stat tiles replace the headline** — `BIGGEST MOVE` (with a **1-month sparkline**), `MACRO`
  (country + its index + 1y), `NEXT` (the next release as "Today / Tomorrow · time · note"). The big
  number is colour-coded and the macro tile is clickable through to that country's page.
- **A one-line strip** under them: *"20 OCT · 6 moves worth flagging · 4 macro · 4 scheduled"*.
- **Movers are rows, not sentences**: `name · coloured % · sparkline · 1y` for commodities, and
  `country [index] · % · 1y` plus the wire story as a why-line for macro. `+17.7%` is green, `−6.4%` red.
- **What's next** is the same row shape: event · note · "Today/Tomorrow + time" (no truncated dates).
- The qualitative items (curve / stocks / positioning) stay as bullets beneath the commodity rows.
- **No new data sources**: sparklines are built client-side from the price history the app already holds
  (`tileSpark`), and `/api/brief`'s `next[]` now also carries `time`.
- Verified: desktop panel 566px, mobile 960px (tiles stack, sparkline and 1y hidden), 98 tests, no console
  errors. `app.js?v=129`, `style.css?v=70`.

## HOME daily brief — one hero, two lists, and a fix for the dairy problem (2026-10-20)
The tile version was still three competing blocks, and the "biggest move" was whichever market twitched
hardest in raw percent — which meant Class III Milk or cheese most days, because dairy quotes step.
- **The hero is chosen by news value, not raw percent.** `score = (|1d| / σ_daily) × liquidity`, where
  `liquidity = clamp(1 − flatShare/12, 0.15, 1)` and `flatShare` is the share of unchanged daily closes
  over a year. A market that prints the same price 13% of days can no longer win by jumping 18%.
  Measured flat-day share: Dry Whey 50%, HRC 44%, Butter 41%, NFDM 17%, Cheese 16%, **Milk 13%**,
  while WTI / Brent / gold / copper / coffee are 0% and corn 2%. Snapping alone was not enough (milk
  scored 9.3σ vs WTI's 1.9σ), hence the liquidity damping.
- **One hero block**: tag, name, a 34px coloured number, a full-width 30-session sparkline, one dim line
  ("−35% over a year · normal day 1.8%"), and at most one tier-1 wire line that direction-matches the
  move. Tapping it opens that instrument or country.
- **WHAT HAPPENED** — one grammar for everything else: `TAG · NAME · % · SPARK`. Commodities are tagged
  by segment (CRUDE, REFINED, DAIRY…), macro rows MACRO; a market with ≥10% flat days gets an amber
  "stepped quotes" tag. Top five by the same score.
- **WHAT'S NEXT** — `TODAY/TOMORROW · event · time`, four rows.
- **One dim context line** carries the qualitative items (backwardation, stocks surprise, CFTC percentile).
- The score is a ranking aid only — it is never shown. `/api/brief` now returns `hero` plus `spark` and
  `kind` on each mover, so the client draws every row from server data instead of re-deriving it.
- Sparkline colour now follows the number beside it (today's sign), not the window's drift — the old
  `tileSpark` painted a red line next to a green +5.7%.
- Verified: desktop panel 451px, mobile 697px with names wrapping instead of truncating, 0 horizontal
  overflow at 390px, 98 tests, no console exceptions.

## Daily brief: the hero graph, the WHY line, and two real data bugs (2026-10-21)
The hero's sparkline spanned the full panel width — a 340px near-flat line that read as a rule, not a
chart — and the brief said WHAT moved but never WHY. Four fixes:
- **Hero graph is compact and sits beside the number**: 190px × 54px (130px on a phone), area-filled,
  `vector-effect: non-scaling-stroke` so the hairline stays a hairline at any size.
- **Every row can carry one WHY line**: a tier-1 wire story that names the thing and agrees with the
  direction, or a computed `ROLL` note. No matching story means no line — never a guess.
  - Commodities use `getNews(segment, instrument)` (already instrument-scoped).
  - **Country indices now query the STOCK MARKET** (`"Indonesia stocks" OR "IDX Composite"`), not
    "Indonesia economy OR rupiah" — that old query explained a +5.7% index rally with a rupiah story.
    It now finds "Indonesia Stocks Rebound as Authorities Step Up Response to MSCI" (Bloomberg).
  - Candidates must contain a market/price word (`STORY_WORD`); "Qatari electricity lifeline for
    Lebanon" names LNG and explains nothing.
  - Three commodities + three countries are merged, so a 3% index day cannot be crowded out by oil.
- **Contract rolls are named, not reported as selloffs.** On expiry day a continuous front-month
  series jumps to the next contract: WTI printed −6.0% with the curve $5.3 backwardated, i.e. ~5% of
  that move was the roll. `buildBrief` detects it (expiry within a day, backwardation, roll ≥ 50% of
  the move), tags the row "Roll, not a selloff — X% of this move is the expiring contract", and bars
  it from the hero slot. Contango + an up move (dairy) is NOT a roll and is not flagged.
- **Two data bugs behind "where is Korea?"**:
  - `yahooSeries` ignored the live quote, so while today's daily bar is still null every 1-day number
    compared the two PREVIOUS closes — KOSPI printed +1.8% while it was actually **−3.7%**. A fresh
    `regularMarketPrice` now fills a missing day (`lastKey < liveDay`, never overwrite, never future).
  - The brief's macro ranking scored only the first three countries before sorting. It now scores
    every country that clears the threshold, so a big index move can't sort on a missing σ.
- Verified: desktop panel 465px, mobile 749px, 0 overflow, 98 tests, no console exceptions.
  `app.js?v=134`, `style.css?v=75`.

## The daily brief is now a ranked system, not a hand-tuned page (2026-10-21)
The brief used to be a quota (three commodities + three countries) and the explanation was whatever
wire story happened to match. Both now come from one explicit pipeline, so the page produces the same
standard on any day, for any asset class.
**1. One leaderboard.** Every benchmark and every country (index and currency) is scored on the same
number and sorted once:
```
score = max( |1-day move| / own daily σ , |1-day move| / 2 )   × liquidity
liquidity = clamp(1 − flatShare/12, 0.15, 1)        flatShare = % of unchanged daily closes, 1y
```
- The σ term means "big for THIS market"; the 2% term is a **materiality floor** for countries — a
  2% index or currency move is a macro event even where the market is chronically volatile (KOSPI's
  daily σ is ~3.5%, so −3.7% was ranking below milk before the floor).
- The liquidity term is what stops stepped quotes (dairy, HRC) from winning on a quote refresh.
- **fx is scored against FX volatility**, not its country's equity index (it used the index symbol).
- No history? Score against a conservative 2% day instead of dropping the move.
**2. Diversity is applied AFTER ranking**, never instead of it: at most two contracts from one
commodity complex and one entry per country, so an oil session can't fill the page but the top is
still the sharpest move.
**3. The hero is `picked[0]`** — the top of that board, unless it is a contract roll (a roll can be the
loudest number on screen without being the story). WHAT HAPPENED is the next five on the same board,
sent to the client already ranked and never re-sorted downstream.
**4. Every move carries an explanation**, in this order:
1. `roll` — computed: expiry day + backwardated curve + roll ≥ 50% of the move.
2. `why` — a tier-1 wire story that names the instrument or country, agrees with the direction, and is
   ≤3 days old; commodity stories must also say which way prices went or name a supply event (kills
   "Qatari electricity lifeline..."); single-company IPO stories are down-weighted for index moves.
3. `facts` — computed, and **guaranteed non-empty**: same-complex breadth (with the biggest peer),
   "crude set the direction", regional index breadth (region-scoped), the same country's currency or
   index, quote quality ("13% of days print unchanged"), and finally size vs its own norm.
**5. Tested.** `tests/api.test.js` now asserts the brief's invariants: ≤5 rows, ranked order, no
instrument twice, and every row carries a wire story or a computed driver. 99 tests pass.
Verified across categories by forcing each hero in turn (WTI, RBOB, gas, gold, copper, corn, soy,
coffee, sugar, cattle, milk, cheese, iron ore) and across countries (VN, SG, TH, KR, TW, JP, CN, IN,
ZA, NG, KE, MX, BR, AR, QA, VE) — every case returns either a wire line or a computed driver.
`app.js?v=136`, `style.css?v=77`.

## Follow-up: currencies and breadth (2026-10-21)
- An **fx** row's wire story must be about money (`FX_STORY`: rates, inflation, central bank, flows,
  budget, reserves, yields). "Poultry Disease Found at MBRF Supplier in Risk to Brazil Exports" was
  explaining a −1.1% real move; it is now dropped and the row falls back to the computed driver.
- Breadth now compares like with like: currencies against currencies, indices against indices, and
  always inside the same region. `REGION_LABEL.us` is "Americas" — that key holds Mexico, Brazil,
  Argentina and Venezuela, so it was calling the real a "US currency".

## MARKETS AT A GLANCE was broken — and FRED took the market down with it (2026-10-22)
Two separate faults landed on the same panel:
- **Layout**: `repeat(auto-fill, minmax(148px,1fr))` fitted seven tiles across, so the eighth (Brent)
  sat alone on a second row with a dead gap beside it. Now a strict four-up grid (two-up under 900px),
  so eight tiles always form two clean rows, with a slightly larger number.
- **US 10y tile showed `400 %` with an HTML fragment as its source.** FRED answers HTTP **200** with a
  "Site Maintenance" page during outages; `fredSeries` was splitting that HTML on commas and treating
  numbers in it as observations. It now requires a real CSV header, validates every row, and returns
  `{}` (never throws) when the feed is down — one dead feed used to reject the whole market payload.
  - The 10y now falls back to Yahoo `^TNX` (normalised if it is quoted ×10), and the board reports the
    source it actually used.
  - `/api/yields` falls back to the US Treasury's own daily curve (all tenors), which keeps answering
    when FRED does not; if a country has no fallback it says "yield feed unavailable right now"
    instead of showing an unexplained blank.
  - The RISK panel's US 10y row used the same dead feed and is fixed by the same fallback.
- **Why the SCREENER said "Couldn't load":** `getMarket()` awaited `spotSeries` for the physical spot
  price (FRED), so a single FRED 403 rejected the entire market response — 0 benchmarks, empty
  screener. The spot feed is now optional: the futures/paper price carries the row and the spot only
  feeds the basis.
- Verified: `/api/market` 35 benchmarks, `/api/screen` 35 rows, `/api/regime` 8/8 with a live 10y,
  `/api/risk` 7 rows including US 10y. 99 tests pass (the JP-yield assertion now accepts a named
  outage instead of failing the build on a third-party feed).

## MACRO tab: first-open cost (2026-10-22)
Measured in headless Chrome against a cold server: opening MACRO took ~1.9s, a country switch ~0.7s.
Two avoidable costs, both client-side:
- `/api/macro-tickers` (~1.7s) was re-fetched on **every** region render. It is the same list every
  time, so it now goes through `jget` with a 5-minute TTL.
- The background prefetch of the rest of the region used three workers and started 4s after load, so it
  competed with the country the reader had just opened. Now two workers, starting at 8s idle.
Result on a cold server: MACRO opens in ~0.7s, a country switch ~0.65s; warm it is ~0.3s / ~0.2s.
(Server-side `/api/country` is already cached 15 min; the remaining cold cost is World Bank + BIS + FRED.)

## Closing the three bounded fixes (2026-10-22)
**1. The board's grid follows the tile count.** `gridCols(n)` picks the squarest real divisor (8 -> 4,
9 -> 3, 10 -> 5, capped at 6) and writes `--rb-cols`; if `n` has no tidy divisor the last tile is given
a `grid-column: span` to fill the final row. Adding or removing a tile no longer leaves a half-empty row.
**2. Real contract expiries.** `src/lib.js:frontExpiry(root, refIso)` implements each exchange's own
rule instead of one shared "the 20th":
| root | rule |
|---|---|
| CL | 3 business days before the 25th of the month before delivery |
| BZ | last business day of the 2nd month before delivery |
| RB / HO / softs / livestock / dairy | last business day of the month before delivery |
| NG | 3 business days before the 1st of the delivery month |
| GC / SI / HG / PL / PA / ALI | 3rd last business day of the delivery month |
| ZC / ZW / ZS / ZM / ZL / ZR | business day before the 15th of the month before delivery |
Weekends only (exchange holidays shift a day or two), which is why the roll window is 0-2 days. The
brief's roll detection and the calendar's expiry event both use it now. Unit-tested: on 2026-10-21 the
front CL is still October's, on 2026-10-22 it has rolled to November's.
Consequence this week: WTI's roll was on the 21st, but Brent/RB/HO expire on the 30th — under the old
"one date for everything" rule the whole complex was flagged as rolling on the same day.
The recurring calendar had the same bug in a second code path (a hardcoded 20th of every month); it now
posts the real dates — 2026-11-20, 2026-12-22, 2027-01-20, 2027-02-22.
**3. A second source for non-US yields.** `tvYields()` pulls live 2y/10y quotes for 18 sovereigns from
TradingView's scanner (same host the calendar already uses) whenever FRED returns nothing. Tenors are
2y/10y rather than FRED's 3-month, so the frequency label says `daily · TradingView (2y / 10y)` and the
note names the fallback instead of passing it off as the same series. China (no FRED long end) is served
by it permanently; Japan/Germany/UK/Korea use it only when FRED is down.
100 tests pass.

## M&A tab — deal wire + a verified seed (2026-10-23)
A global, 10-year M&A database with valuations and advisers is licensed data (Dealogic, Refinitiv,
PitchBook, Mergermarket). No free source provides it, so the tab states exactly what it covers.
**WIRE (default)** — announced deals as tier-1 wires reported them, last 7 days, from Google News.
Each row: date · acquirer → target · value · sector · the headline, linked.
- `parseDealTitle` pulls the parties and the price out of the headline; `dealSector` tags the sector.
- Relevance is enforced, because the raw feed is full of non-deals: procurement ("US agrees to buy 850
  F-35s"), law-firm moves, analyst ratings ("upgraded to buy"), court/trial stories, and speculative
  "would/could merge" pieces are all filtered out.
- One row per deal: deduped on acquirer+price AND on the target's key word, because Reuters, Bloomberg
  and CNBC all report the same deal with slightly different wording.
**SECTORS** — the week's stories counted and summed by sector. The note says it is not a census.
**VERIFIED (2)** — deals read out of the company's own 8-K press release: Microsoft/Activision $68.7B
(Goldman, Allen & Co) and Kroger/Albertsons $24.6B (Goldman), each with the verbatim rationale and a
link to the filing. This is a seed, labelled as one.
**What we tried first, and why it is not the default:** `scripts/fetch-ma.mjs` discovers 8-Ks via EDGAR
full-text search and parses the press-release exhibit. Mechanically it works (the exhibit lookup bug —
files named `tm223212d1_ex99-1.htm` — cost most of the yield), but the *values* are unreliable: on a
120-filing sample it produced 1-8 rows and mispriced Xilinx at "$135 billion". Deal terms live in prose
next to revenue and market-cap figures, so a wrong number is one regex away. It stays as a QA tool
(`--dry` parses the cache without network) until the extraction is good enough to trust at scale.
`scripts/verify-deal.mjs` is the manual counterpart: give it a target and a month, and it prints the
deal-value sentence from the filing, which is how the two verified rows were confirmed.
Verified: 15 wire rows, 0 horizontal overflow at 390px, 0 tap targets under 32px, 101 tests.

## M&A: browse the wire by sector (2026-10-23)
The sector view was read-only. Now every sector tile is a button, and the wire has a filter bar:
`ALL SECTORS · <sectors present>` on the left, `7D / 30D / ALL` on the right, with a running summary
("4 deals in Healthcare · $15.8B disclosed").
- Wire items accumulate into a local log (`data/deals-log.json`, capped at 2,000, deduped by the same
  key as the tape) so a sector can be browsed beyond the current fetch. The header states the real
  span — "11 deals logged · since 15 Oct" — rather than claiming a fixed window.
- The free host's disk is ephemeral, so the log survives restarts on the same instance but not a
  redeploy; the UI never implies otherwise.
- `/api/deals` accepts `?days=` and `?sector=` and returns `deals` (filtered), `sectors` (over the
  filtered set) and `log {count, since}`. The client filters locally for instant switching.
- What a wire row can and cannot tell you: date, acquirer, target, value (when the headline states one),
  sector and a source link. It cannot tell you advisers, multiples or the rationale — those come from
  the filing, which is what VERIFIED is for.

## M&A rebuilt as two pages, with status on every deal (2026-10-23)
The tab was three equal segments over a table. It is now the two things a reader actually does:
- **HIGHLIGHTS** — the biggest VERIFIED deal as a hero (price, quoted rationale, advisers), then the
  eight largest deals logged, then the latest ten with dates.
- **SECTORS** — sector grid → company list (monogram, role, deal count, value) → the deal itself
  (price, date, consideration, rationale, advisers, link). Breadcrumb back at each level.
**Verification is a flag, not a page.** Every row carries `VERIFIED` (read from the filing),
`REPORTED` (a wire says so) or `RUMOUR` (the wire says talks/exploring — `DEAL_RUMOUR` in server.js).
A verified row replaces the wire version of the same target, so a deal never appears twice at two
levels of confidence. On a phone the chip is replaced by a ✓ (verified) or ● (rumour) on the value.
**Logos are monograms** — initials in a colour derived from the name. We have no domain for most
companies, Clearbit's free endpoint is unreliable and a broken image is worse than a clean monogram.
`/api/deals` now returns one unified `deals` list (verified + wire, deduped) with `sectors` counts.
101 tests pass; mobile 0 overflow, 0 tap targets under 32px.

## M&A: a deal store with a lifecycle, not a feed (2026-10-23)
The wire only looked for *new announcements with a price*, so the biggest deal in the world was
invisible: Paramount/WBD was announced 27 Feb and completed 6 Oct, and neither moment had a value in a
headline on the day we looked. Rebuilt as a store:
- **Four discovery channels** feed one entity: announcement (needs a price), rumour ("in talks",
  "exploring"), completion ("completes", "closes", "wraps up") and termination ("scraps", "calls off").
- **Entity matching**: an article is attached to an existing deal when its target matches, or when the
  title contains both the target and the acquirer (completion headlines drop the acquirer). One deal =
  one row with an `events[]` timeline, never two rows at two confidence levels.
- **Status** is derived from the latest event: `rumour → announced → closed / terminated`. `verified`
  is a separate boolean (read from the filing), so a verified deal can still show CLOSED.
- **The UI** shows the lifecycle chip (RUMOUR / ANNOUNCED / CLOSED / TERMINATED, or VERIFIED when we
  have the filing) and the detail panel carries the timeline: announced 27 Feb → closed 6 Oct.
- Seeded from `data/ma.json` (verified) + `data/deals-log.json` (wire), then grows on each refresh.
  The store is generated (`data/deals-store.json`, gitignored).
- Guards: no entity without a company name, no duplicate keys, no events before 2020, and prose
  fragments ("struggling rival WOW Air", "Part of Cranes Unit") are rejected as names.
Paramount/WBD now leads the page at $110B with both events. 101 tests pass.

## Sectors page: ranked bars, evidence mix, company value bars (2026-10-23)
The sector grid was five identical boxes with a number — no sense of scale, no identity, no reason to
tap. Rebuilt as a ranked board:
- **Ranked rows, not tiles**: sector · deal count · disclosed value · a bar whose width is proportional
  to the largest sector · share of total disclosed · the top three company monograms · a thin evidence
  bar (green verified / grey reported / amber rumour). Sorted by value.
- **Time filter** `7D / 30D / 1Y / ALL` at the top; the whole board recomputes client-side.
- **Drill-down header**: `3 deals · $112.5B disclosed · 2 verified`, then a **BIGGEST HERE** card (the
  sector's largest deal, tappable), then the company list.
- **Company rows carry a value bar** relative to the sector's largest, so "Paramount $110B" visibly
  dwarfs everything else.
- Empty sectors disappear rather than showing a zero row.
- Fixed on the way: the header counted `status === 'verified'` after verification became a boolean, so
  it read "0 verified" while five deals were verified; and the "since" span now includes the year when
  it is not the current one.

## Daily brief: M&A when it matters (2026-10-23)
The brief now carries a **DEALS** block under the two columns — but only when something qualifies:
a deal that is verified, or worth ≥ $1B, seen in the last 21 days. A quiet stretch renders nothing at
all rather than an empty heading. Three rows max, largest first, each with date · acquirer → target ·
value · status chip (VERIFIED / RUMOUR / ANNOUNCED / CLOSED). Tapping one opens that deal in M&A
(segment buttons kept in step via `syncMaTabs`, since the state can now be entered from HOME).
Today it shows Paramount/WBD ($110B, VERIFIED), SoftBank → Allied Universal ($18B, RUMOUR) and
Proofpoint → Varonis ($6.3B, ANNOUNCED) beneath a Natural Gas hero — which is the right split: the hero
is the sharpest *move*, M&A is a separate signal.

## M&A: one row per deal, search, filters (2026-10-23)
- **The doubling is gone.** The sector page listed companies, so one deal produced two rows (Chevron
  and Hess). It now lists **deals** — `acquirer → target`, one line, both monograms — which is what a
  reader is actually scanning. The sector's biggest deal is no longer repeated in a "BIGGEST HERE"
  card above the same list, and HIGHLIGHTS no longer shows a deal in both BIGGEST LOGGED and LATEST.
- **Search** across acquirer, target and sector, filtering instantly (client-side, no refetch).
- **Quick filters**: `ALL SIZES / $1B+ / $5B+`, `PE BUYERS` (a keyword map over KKR, Blackstone, EQT,
  Vista, Thoma Bravo, Apollo, Carlyle, Bain, Advent, CVC…), `RUMOURS`, `VERIFIED`.
- **Company page** gained a summary line: N deals, how many as buyer vs target, total disclosed.
- Dates in lists now carry the year when it is not the current one (23 Oct 2023, not 23 Oct).

## M&A: filters that say what they are, deep links, clickable parties (2026-10-23)
- **Filters regrouped** into three labelled, single-select groups — `SIZE (All / $1B+ / $5B+)`,
  `EVIDENCE (All / Verified / Rumour)`, `BUYER (All / PE)`. Before, eight chips of mixed semantics sat
  in one row, so pressing several could produce an empty page with no explanation. Now one press means
  one thing, the active chip is obvious, a `CLEAR n FILTERS` button appears when anything is set, and a
  line under the bar reports `N deals · filtered`. Empty results say so instead of showing a blank.
- **Deep links**: `#/deals`, `#/deals/sector/Energy`, `#/deals/sector/Energy/company/EQT`. Back/forward
  work, and a link opens the exact view.
- **Parties are clickable** on a deal: the acquirer and target are buttons, so you can hop from a deal
  to either company page without going back to the sector.

## M&A: the archive problem, and a lookup that works today (2026-10-23)
The Berkshire/OxyChem deal (2 Oct 2025, $9.7B) was missing because **Google News RSS ignores date
ranges** — `after:`/`before:` return nothing, so nothing older than the store can ever enter. Verified
by test. Two responses:
1. **`scripts/backfill-deals.mjs`** — a GDELT walker (monthly windows, auto-split into weeks when a
   window hits the 250-record cap, 6s pacing, domain allowlist, title de-tokenising). GDELT *does* have
   the archive: a probe for "OxyChem" over 1–10 Oct 2025 returned the CNBC/Houston/Yahoo coverage.
   It is written but **not run**: GDELT rate-limited this IP after the probes (429 for several minutes).
   Run it when the quota resets: `node scripts/backfill-deals.mjs --from=2024-01`.
2. **Search is also a lookup.** If the local book has no match for a term of 3+ characters, the client
   calls `/api/deals/lookup?q=…`, which queries the news for that name, parses and merges the results,
   then re-renders. Typing "OxyChem" now returns *Berkshire Hathaway → OxyChem, $9.7B, CLOSED*.
**Parser work this needed:** sell-side headlines ("Occidental closes $9.7B sale of OxyChem to Berkshire"),
possessive forms ("Berkshire Hathaway's $9.7bn Acquisition of OxyChem"), `$9.7B`/`$9.7bn` shorthand, and
a tighter `validName` (no %/fragments/verbs, ≤5 words).
**Entity resolution bug found and fixed:** the title-containment fallback attached OxyChem stories to an
unrelated "Berkshire" row, and "OxyChem From Occidental" split into a second entity. Matching now uses
a shared significant token and containment only when no target was parsed.
`src/deals.js` is now the single home for parsing/sector/lifecycle/merge, imported by both the server and
the backfill script — no duplicated logic.

## M&A: EDGAR backfill — the book now has history (2026-10-23)
GDELT stayed blocked (429 on every attempt, minutes apart), so the backfill ran on the source that works:
**SEC EDGAR full-text search**, month by month from Jan 2024 to Oct 2026.
- `scripts/backfill-edgar.mjs` walks each month's 8-Ks matching "has agreed to acquire" (567 filings
  read), fetches the filing, and extracts the counterparty from the merger paragraph.
- **Only identity is asserted**: filer (acquirer), target, date, filing link. A value is recorded only
  when the filing states one in an unambiguous phrase ("purchase price … $X"), otherwise the deal is
  stored with no value rather than a guess. 42 of 126 have one.
- Guards added after inspecting the first run: reject the filing company "acquiring itself"
  (Bowhead → Bowhead, Whitestone → Whitestone) and generic objects (Fixed Shares, Equity Interests).
- `data/deals-store.json` is now committed (124 KB) so a redeploy keeps the book; the server seeds from
  it on boot, then merges live news on top.
Result: **126 deals** across 2024–2026 (Financials 39, Other 31, Energy 16, Technology 13, Healthcare 12,
Industrials 7, Media 3, Consumer 3, Telecom 2). Quality caveat: EDGAR identity is solid, but many rows
have no value, and the sector tag comes from the filing text so "Other" is large.

## Deal quality: SIC sectors, junk targets, duplicates (2026-10-23)
The EDGAR backfill's weakest point was classification: 31 deals sat in "Other" because the sector came
from words in the filing text. `scripts/fix-deals.mjs` fixes that properly:
- **Sector from the filer's SEC SIC code** (`SIC_SECTOR` in `src/deals.js`), using the CIK already in the
  stored filing URL — 80 deals retagged, "Other" fell from 31 to 8.
- **Generic objects dropped** (`isGenericTarget`): "New Lease and Previous Lease", "Fixed Shares",
  "membership interests" are not companies.
- **Duplicates merged** by target token, keeping the row with a value and the most events.
Result: 124 deals — Financials 23, Technology 20, Healthcare 20, Industrials 19, Energy 14, Materials 6,
Mining 6, Consumer 5, Construction 3, Other 8.
Run it after any backfill: `node scripts/fix-deals.mjs`.

## Sectors: a real historical list per segment (2026-10-23)
Opening a sector used to inherit the board's time window and offered no way to change it, so the list
looked like a snapshot. Now:
- The sector view reads the **whole book**, not the board's filtered slice.
- Its own range filter: `ALL / 3Y / 12M / 6M`, plus `LATEST / LARGEST` sorting.
- A span line (`11 Oct 2023 → 31 Aug`) and a header with count, disclosed value and how many are
  verified.
- Dates carry the year when it is not the current one, so a 2023 deal is never mistaken for this year.
Energy now shows its 14 deals across the range; 12M narrows to 3.

## GDELT: unlocked once, then re-blocked (2026-10-23)
Status check: the 429 cleared briefly, GDELT served exactly one request, and re-blocked immediately.
There is no published cooldown; it is not a reliable backfill channel from this IP. Two things learned:
- The query syntax matters: GDELT rejects `(a OR b) (c)` — parentheses may only wrap OR'd terms. The
  working form is `(acquisition OR merger OR takeover) billion`.
- Pacing at 12s, then 30s, still 429s after the first success. A 34-month walk would take days.
So the historical book came from EDGAR instead: **backfilled 2016–2023 as well**, 1,725 filings read,
+233 deals. The book is now **268 deals (2020–2026)**, 62 with a disclosed value, sectors:
Industrials 55 · Technology 52 · Healthcare 50 · Financials 48 · Energy 19 · Consumer 16 · Materials 11 ·
Mining 7 · Other 5 · Construction 3 · Agriculture 1 · Real estate 1.
(EDGAR's full-text index returns nothing for this phrase before 2020, which is why the book starts there.)

## Archive hunt: four sources tested, one works (2026-10-23)
The demand was historical/global coverage now. Tested in order:
1. **GDELT DOC API** — the 429 is **global, not per-IP**: the same request through r.jina.ai (different
   network) also returned 429. It serves roughly one request per window, then closes. A patient crawler
   (exponential backoff, resumable, saves per window) ran for ~40 minutes and never completed a window,
   so it was stopped rather than left racing the store.
2. **Wayback CDX** — works for single queries (Reuters slugs are headlines with dates) but 503/504s on
   bulk/paginated queries; not viable as a bulk archive right now.
3. **Reuters sitemaps** — only ~2 weeks deep (`from=` beyond 5,000 returns empty).
4. **Google News** — no date operators; relevance search returns mostly recent items.
**The source that works: EDGAR, with more phrasings.** `backfill-edgar.mjs --q='…'` now accepts a phrase,
saves after every month, and "completed the acquisition" alone adds ~30 deals per month. Running over
2024–2026 it took the book from 271 to **412+ deals** in ten minutes, with more still arriving.
Lesson recorded: when a free API throttles globally, the answer is a different *kind* of source (filings),
not a faster retry loop.

## Brief: M&A belongs IN "what happened", not beside it (2026-10-23)
Removed the separate DEALS block. A big deal is a thing that happened that day, so it now joins the
same WHAT HAPPENED list, tagged **M&A**, with its price in the value column, its status chip where the
sparkline sits, and one dim line (`announced 27 Feb · closed 6 Oct`). Threshold unchanged: verified or
≥ $1B, seen in the last 21 days, max two deals, and the list is capped at seven rows.
Also fixed the truncation complaint: company names and headlines now wrap to **two lines** with a
`title` tooltip instead of being chopped by the value column.

## M&A: honest status, two-digit dates, comparables, deeper book (2026-10-23)
- **Status is no longer frozen at "announced".** `inferStatus()` marks a deal closed when it is 18+
  months old and has no termination event, and the chip says so in a tooltip ("no closing filing on
  record — closed inferred from age"). We never claim a filing we don't have.
- **Dates use two-digit years** ("23 Oct 26"), which frees the column so company names stop being cut.
- **Comparable deals** on a deal page: same sector, value between 0.5× and 2×, within three years.
- **Deal type** is classified in the data (`merger / asset / tender / stake / acquisition`).
- The book grew to **796 deals** after the "completed the acquisition" phrase walk (2,028 filings read,
  +1,118 deals), and a balanced walk over 2020–2023 is running so the year-on-year shape isn't an
  artefact of which phrases we happened to run.
- **Value enrichment** (`scripts/enrich-values.mjs`) was built and tested: it reads the EX-99.1 and
  accepts a price only from an explicit phrase ("valued at", "purchase price of") or a deal verb within
  the same clause. Yield is low (7 in 120) — most 8-Ks simply don't state a price — so values remain
  ~15% of the book. Better to be empty than wrong.
- SIC retag of 425 deals cut "Other" from 131 to **8**.

## Deal values: computed from price × shares, validated (2026-10-23)
`scripts/value-by-shares.mjs` computes equity value = **offer price per share × shares outstanding**,
both public: the price from the press release, the share count from XBRL
(`dei:EntityCommonStockSharesOutstanding`). Delisted targets are resolved through full-text search of
their old 10-Ks, since they vanish from `company_tickers.json`.
**Validation against five known deals** (equity basis, since price × shares gives equity):
Pioneer −0.9%, Hess −0.9%, WBD −5.1%, Activision +7.7%, Albertsons −8.3% → all within 9%.
Values are rounded to two significant figures and carry `valueSource: 'computed'` plus `valueBasis`;
the UI shows them as `≈ $59.0B` with the basis on hover. A value read from the filing is never marked.
**The honest limit:** the EDGAR corpus is dominated by small asset purchases that state no price at all —
only 16 of 200 had a per-share figure. The book is 1,536 deals with 223 priced (15%). The method is
accurate where it applies; the universe, not the parser, is the constraint.
Consequence for the UI: a `PRICED` filter was added so the defensible subset is one tap away.

## The real value problem: a polluted corpus, not a parser (2026-10-23)
Sampled six unpriced "deals" and opened their filings: an **earnings presentation**, a **quarterly
results release**, a **lawsuit description**. The EDGAR backfill matched any 8-K containing "has agreed
to acquire" anywhere in the document, so earnings releases and credit agreements were being stored as
acquisitions. That is why values looked impossible — most of those documents never stated a price
because they were not deal announcements.
**New admission test** (`scripts/audit-deals.mjs`): the filing's own text must name an acquisition in
the first 2,500 characters and the target within 4,000. 1,535 → **872 deals**, 663 dropped (earnings
releases, unrelated 8-Ks), documents cached so a re-run is instant.
The year spread is now sane (2020 137 · 2021 186 · 2022 129 · 2023 75 · 2024 115 · 2025 107 · 2026 123)
because the audit applies the same test to every year.
Priced: 140 of 872 (16%) — 133 disclosed, 7 computed. The audit does not create prices; it removes the
rows that made the denominator dishonest.

## Tender offers: the bidder matcher works, the volume doesn't (2026-10-24)
`scripts/backfill-offers.mjs` reads SC TO-T cover pages. Two fixes made it correct:
- The cover page is a **table**, so cell boundaries (`</td>`) must break lines or the issuer name and
  its label collapse into one string.
- The filer is often a merger subsidiary; the real acquirer is the line above
  "(Name of Filing Persons (Parent of Offeror))" — a flat regex now extracts it
  (Concentra Biosciences → Theseus, $3.90/share, par value $0.0001 correctly rejected).
**But the yield is small.** Over six months of 2024 it added 3 deals and priced 1: most tender targets
are already in the book from the 8-K walk, and the tenders that aren't are small companies with no
other coverage. The pipeline is in the repo and correct, not a game-changer for coverage.
Current book: **875 deals, 145 priced (16.6%), 14 computed.**
The honest ceiling: EDGAR gives identity and occasional price; tender offers give price but only for the
subset that tenders. A mostly-priced book needs a licensed feed.

## Free trusted source that actually works: Wikipedia's acquisition tables (2026-10-24)
Searched the free landscape properly. Results: **Discoperi is a mockup** (its "download" is
`href="#"` plus an `alert()`), **Acquirezy is Cloudflare-walled**, the GitHub/Kaggle tech datasets stop at
2014–2021 and are narrow, and ONS/Eurostat are aggregate only.
**Wikipedia's "List of mergers and acquisitions by X" pages are real**: community-maintained, cited,
tabular (Date · Company · Business · Country · Value), and current. `scripts/import-wikipedia.mjs` reads
them through the MediaWiki API, maps columns by header name, parses dates and values, and merges into the
store with `source: 'Wikipedia'` and a link to the page (CC BY-SA, attribution shown).
- 20 pages, 1,602 rows read, **+182 deals, +42 priced**.
- Value provenance now has a priority order in `mergeEvent`: **verified > filing > computed > wikipedia >
  wire**, so a Wikipedia figure can never overwrite a filing's.
- Book: **994 deals, 172 priced (17.3%)**, sources: SEC 8-K 854 · Wikipedia 119 · wires 13 · SC TO-T 3.
The honest note: Wikipedia's tables are historical — most rows predate 2020 — so the modern-period yield
is modest. It adds depth, not the missing 80%.

## Wikipedia removed at the user's request (2026-10-24)
Deleted all 119 Wikipedia-sourced deals and the importer. The book is back to **875 deals, 150 priced**,
every row from a primary source (SEC 8-K / SC TO-T) or a tier-1 wire. Value provenance priority stays in
`mergeEvent` for future sources, but Wikipedia is no longer one of them.

## Brief: M&A is news, not size (2026-10-25)
Paramount kept appearing because the rule was "verified or ≥ $1B, seen in the last 21 days" — a deal's
size kept it on the page long after the news. It now needs an **event today or yesterday**: the deal's
`lastSeen` must be today/yesterday, which only happens when an article attaches (announced, closed,
terminated). Size is only a floor (verified or ≥ $1B), not a reason to stay.
Result today: no M&A row at all — nothing happened to a qualifying deal in the last two days, and that
is the correct behaviour. Paramount will surface again only on a day it makes news.

## M&A tab replaced by COMPANIES (SEC XBRL) — 2026-10-25
The deal tab is now a **company directory** built from SEC XBRL, because that is the one global dataset
that is structured, free and primary — no parsing, no estimates.
- `scripts/build-companies.mjs` walks every company with an SEC CIK in the deal book, pulls the latest
  annual 10-K facts for **revenue, net income and total assets** plus SIC industry from submissions.
  Four concepts are fetched in parallel; the file is saved every 25 companies so a long run can't lose
  its work.
- **338 companies, 294 with revenue** (Exxon $276.7B, Chevron $184.4B, WBD $37.3B…). Sectors from SIC,
  with broadcast/cable → Media and telephone → Telecom fixed.
- UI: search, sector chips, size bands ($1B/$10B), revenue bars, margin column. A company page shows the
  four headline figures, the fiscal year, a link to its 10-Ks, and **its deals from the same store**.
- The tab id stays `deals` so routing and the brief keep working; the label is COMPANIES.
Honest coverage line on screen: companies that file with the SEC — US listings and foreign issuers with
ADRs. Other markets have no free structured fundamentals.

## Companies: ticker mapping bug, full pricing, screener (2026-10-25)
- **The wrong-ticker bug**: `company_tickers.json` maps a CIK to several symbols (classes, preferreds) and
  a naive "last one wins" picked `JPM-PM`, `GOOGM`, `BRK-A`. Tickers are now chosen by preference
  (no dash, no `-P` preferred suffix, shortest), which fixed Alphabet, JPMorgan, Meta and others.
- **Share-count fallback**: `WeightedAverageNumberOfDilutedSharesOutstanding` where the cover page has no
  count — companies with shares went 2,517 → 6,050.
- **Full pricing run**: 2,992 companies now carry market cap / P/E (TTM) / P/B / EV/EBITDA.
- **Screener**: sort chips (MKT CAP · P/E · EV/EBITDA · MARGIN · GROWTH, toggling direction), plus CSV
  export of the current filter.
- **Peers** on the company page: same SIC industry, ranked by market cap.
- **Forward P/E removed** entirely — no free consensus estimates exist, so the field is gone rather than
  shown as a dash.

## The calculation engine is now audited, not trusted (2026-10-25)
Before adding anything else, every derived number was recomputed from its primitives and checked.
`scripts/audit-calculations.mjs` re-derives market cap, P/E, P/B, EV, EV/EBITDA, current ratio, D/E and
growth, compares them with what is stored, then runs sanity ranges and reference checks.
**First run: 2601 companies had stale or wrong derived values** — P/B computed before share counts were
filled, P/E on a one-cent EPS, and 183 cases where net income exceeded revenue (the two tags came from
different scopes). Fixes are structural, in `scripts/derive-companies.mjs` (one place, run after any
build), with guards that encode *why* a number is meaningless:
- EPS below $0.05 → no P/E (a penny of earnings is noise).
- Market cap below $1M or ≤ 0 → null (a broken share count, not a company).
- Net income > 1.2 × revenue → the pair is inconsistent; drop the net income.
- **Financials → margin and EV/EBITDA are `n/a`**: banks report net interest income as "revenue", so a
  margin is meaningless by construction, not missing.
- Current ratio > 50, D/E > 20, P/B > 100 → null (equity is a rounding error, not leverage).
Pipeline order, now explicit: `build-companies-frames` → `price-companies` → `derive-companies` →
`audit-calculations` (`npm run audit:companies` runs the last two).
**Audit result: 8,297 companies · 0 reconciliation mismatches · 0 out-of-range values · reference checks pass.**

## Market cap now comes from Nasdaq, not from a share count (2026-10-25)
Deriving market cap as price × shares kept breaking on dual-class shares, ADRs and stale cover-page
counts — the last audit found 26 companies where the two paths disagreed by more than 10% (BRK-B 2,400×,
BKNG 24×, KLAC 10×, V 3.8×). Fixed at the source: **Nasdaq's quote summary publishes MarketCap directly**,
so `scripts/fetch-nasdaq.mjs` pulls it for all 499 constituents (498 succeeded, BRK-B via the dot ticker),
along with dividend yield, sector and industry.
- P/E = market cap ÷ net income; P/B = market cap ÷ equity; EV = market cap + debt − cash. All from the
  authoritative cap, so class/ADR mismatches cannot propagate into the ratios.
- **Cross-check between two independent paths**: Nasdaq market cap vs Yahoo price × SEC share count agree
  within 10% for **415 of 441 companies (94.1%)**. The 26 exceptions are exactly the multi-class names.
- Audit updated to reconcile against the same primitives: **0 mismatches, 0 out-of-range values**.
- Money formatting now goes to trillions ($5.07T, not $5074.8B).

## Companies: filters, search and missing data (2026-10-25)
- **Filter bar rebuilt** into labelled rows — SECTOR / SIZE / VALUATION / QUALITY / VIEW — with a CLEAR
  button when anything is active. The search box no longer stretches into an empty half-panel.
- **Search from a company page was broken**: typing left you on the company (renderCompanies early-returns
  when a CIK is selected). Search now clears the selection, and an alias map covers names that differ
  from the filing ("google" → GOOGL, "facebook" → META, "berkshire" → BRK-B, ~25 entries). An empty
  result now says so instead of showing nothing.
- **Sectors now come from the exchange** (Nasdaq's own sector), not SIC: Apple was "Industrials",
  Amazon "Other"; now Technology and Consumer. SIC only fills gaps.
- **Missing data**: added `RevenueFromContractWithCustomerIncludingAssessedTax` and `LongTermDebt` frames,
  plus a fourth revenue tag. Revenue 468 → **488 of 499**, TTM earnings 445 → 447, descriptions 0 → **406**.
- Audit after the rebuild: **0 mismatches, 0 out-of-range**.

## Companies: the missing-data pass (2026-10-26)
Goal was to stop showing "—" wherever a filing actually has the number, without inventing anything.

**Where the gaps came from**
- The annual XBRL *frames* pass only returns companies that tagged a given concept for that exact
  period, so banks (revenue = "Revenues, Net of Interest Expense"), utilities ("Regulated and
  Unregulated Operating Revenue") and REITs (rental revenue) came back empty.
- The 10-K Item 1 description pass failed on ~90 companies (wrapper documents, exhibits, boilerplate
  filter), and the earlier rebuild had wiped descriptions entirely.

**What was added**
- `scripts/fill-gaps.mjs` — per-company SEC `companyconcept` lookups with a fallback family per field
  (revenue, equity, debt, cash, D&A, operating income, net income). Every response is cached under
  `data/cache/concepts/`; failed fetches are never cached (a 403 used to look like "this tag does not
  exist" forever — that is how Mastercard's net income became a 2013 figure).
- `scripts/ttm-earnings.mjs` — recomputes FY and TTM net income from the freshest of `NetIncomeLoss`,
  `ProfitLoss`, `NetIncomeLossAvailableToCommonStockholdersBasic`. Two real bugs fixed here:
  Broadcom's `NetIncomeLoss` stops in 2019, so "last four quarters" summed 2018–19; and Q4 is never
  tagged as a quarter, so it is rebuilt as FY minus the three quarters inside that year. Guards: TTM
  must be newer than the FY, within 5× of it, four contiguous quarters, and no quarter may be more
  than 3× the trailing median (one 2026 quarter doubling would have halved Alphabet's P/E).
- `scripts/repair-revenue.mjs` — where net income exceeded revenue, the revenue tag was a component
  (MetLife $2.4B instead of $77B). Re-asks for total revenue and clears the field if none qualifies.
- `scripts/fix-net-income.mjs` — for the handful whose tag stopped years ago, reads the whole XBRL
  index and picks the newest after-tax concept (never "…BeforeIncomeTaxes…", which is pre-tax).
- `scripts/describe-nasdaq.mjs` — Nasdaq's own company profile as the description fallback.

**Coverage now (of 499)**
| field | before | after |
|---|---|---|
| revenue | 488 | **495** |
| net income (FY) | 457 | **497** |
| net income (TTM) | 447 (wrong for some) | 361, all verified |
| equity | 476 | **499** |
| debt | 349 | **464** |
| cash | 426 | **498** |
| D&A | 306 | **441** |
| description | 406 | **499** |
| P/E | 458 | **468** (347 on TTM, 121 on FY) |
| EV/EBITDA | 373 | **387** |
| debt/equity | 305 | **431** |

**Guards added**
- derive: TTM within 5× of FY; TTM not older than 500 days vs the newest filing; profits capped at
  1.2× revenue but losses allowed to 3× (a collapsing company can lose more than it sells); EV marked
  `≈ cap` when neither debt nor cash is tagged; EV/EBITDA is n/a for financials.
- audit: a new `ttm` check flags any trailing figure built from quarters more than 500 days old.

Audit: **0 reconciliation mismatches, 0 out-of-range values, 0 stale TTM**. 101/101 tests pass.

## Companies: the verification harness (2026-10-26, later)
Stopped fixing companies one at a time. Three layers now catch a wrong input before it ships.

**1. Second source — `scripts/reconcile-nasdaq.mjs`**
Compares revenue, net income, assets and equity for all 499 against Nasdaq's own annual tables
(`api.nasdaq.com/api/company/{t}/financials?frequency=1`), matched line-for-line (parent net income,
parent equity) and by period end date, ranked by absolute dollars rather than percent.
Agreement: **87.7% of 489 comparable companies within 10%**. The residual is dominated by bank revenue
definitions (24) and period offsets, not errors.

**2. Input invariants — `scripts/invariants.mjs`**
Eleven checks on whether a number is *possible*, grouped by cause: profit above revenue, revenue
implausibly small against assets, equity above assets, current assets above total assets, debt above
assets, stale fiscal year, stale trailing quarters, TTM disagreeing with the fiscal year, and cap not
reproducible from price × shares. Output is a work queue by cause, with informational flags separated:
**62 flags · 4 actionable · 58 informational**.

**3. Golden-file gate — `scripts/check-snapshot.mjs`**
`data/snapshot.json` holds the current value of eight fields per company. Any rebuild that moves one
beyond tolerance fails unless the baseline is deliberately refreshed, so a 6× change cannot ship unseen.

**Real errors this found (all fixed)**
- **DTE** was mapped to CIK 28385, which stopped filing in 2014 — the correct CIK is 936340. Every
  DTE figure was a decade old.
- **Stale equity tags**: UnitedHealth's `StockholdersEquity` last filed 2014 ($32.5B), Qualcomm's 2019
  ($4.9B), Broadcom's 2019 ($24.9B), Garmin's 2010 ($3.0B). P/B was wrong by 2–4×. Fixed by
  `scripts/balance-pass.mjs`, which takes the newest 10-K instant across the acceptable tag family and
  refuses anything more than two years behind the universe.
- **Revenue components**: URI $3.7B→$16.1B, FIX $1.8B→$9.1B, ADM $25.0B→$80.3B, BG $16.9B→$70.3B,
  DOC $0.6B→$2.8B, CFG $1.6B→$8.2B, KEY $1.7B→$7.5B, HBAN $0→$6.0B, IBKR $2.4B→$6.2B.
- **Stale assets** for companies with off-calendar fiscal years: PANW $25B→$48.5B, MU $86B→$195.9B.
  Cause: frames key on CY…Q4I, not on the company's fiscal year.
- **Impossible debt**: TDG $29.3B against $22.9B of assets — now nulled rather than shown.
- Bunge's `Revenues` was a transient 404 cached as "no such tag"; 404s are no longer cached.

**Commands**
- `npm run companies:verify` — audit + reconciliation + invariants
- `npm run companies:rebuild` — the whole pipeline, in dependency order
- `npm run companies:reconcile` / `companies:invariants` / `companies:diff`
- `node scripts/fix-from-facts.mjs TICKER…` — exception-queue repair from a company's full XBRL index

Audit: **0 reconciliation mismatches, 0 out-of-range**. 101/101 tests. Reconciliation 87.7% within 10%.

## Companies: closing the remaining flags (2026-10-26, final)
- **Banks**: revenue now uses each issuer's own "revenues net of interest expense" where that is the
  top line (COF 8.1→53.4B, L 3.2→18.5B, NTRS 5.0→8.1B, AXP 41.3→72.2B, CFG/KEY/HBAN already done).
  The 21 remaining revenue gaps against Nasdaq are classified as **definition**, not error: the two
  publishers scope bank revenue differently, and we keep the issuer's figure.
- **HONA** (Honeywell Aerospace) has only a 10-Q and Form 10 — no 10-K. It now carries the latest
  quarter (revenue $4.5B, net income $0.2B, assets $19.4B, equity −$5.7B) marked `quarterly`, and derive
  refuses to build a P/E from a quarter.
- **APA / CPT** have no consolidated revenue tag in XBRL; they now take the exchange's total revenue
  with `revenueSource: 'nasdaq'` and `revenueBasis: 'total revenue (exchange)'`.
- **Share counts** that could not reproduce the market cap (one class of a dual-class company) are now
  derived as cap ÷ price and marked `sharesDerived`, instead of contradicting the cap.
- **Operating income** is period-checked: KLA's `OperatingIncomeLoss` last filed in 2014, so EV/EBITDA
  was 166× on a 2014 profit. Stale operating income is now dropped and the ratio shown as n/a.

Invariants: **0 actionable**, 32 informational (high P/E, high P/B, EV/EBITDA above 60 where EBITDA is
genuinely thin). Audit: 0 mismatches. Reconciliation: **87.9% within 10%**, 21 definition, 8 period, 4 none.

## Companies: compact filters, trillions, and the "missing" Tesla (2026-10-26)
- **Filter bar** rebuilt as one row: search + five labelled selects (SECTOR / SIZE / P/E / MARGIN / GROWTH)
  + Priced / Board / CSV + a CLEAR count. Five rows of chips became 28px tall.
- **Money formatting** now steps B → T everywhere. The company page and the five-year table were still
  using a B-only formatter, so $1.47T rendered as $1,472.5B. One helper (`coMoney`) now serves both.
- **Tesla was not missing — it was hidden.** P/E 457 and EV/EBITDA 285 were nulled by caps meant to
  catch broken data (400x / 200x). A genuine extreme multiple is data, not an error: caps raised to
  2000x / 500x, with the invariants report flagging extremes instead of the UI hiding them.
- **Descriptions**: 64 started mid-sentence ("(“AI”) into the real world…"). Nasdaq's profile text is a
  continuation of the company name, so the parenthetical is stripped and the name restored; four
  comma-led fragments repaired. 0 bad starts.
- Description truncation now cuts at a sentence boundary, not mid-clause.
- Footnote corrected: market cap is Nasdaq quote data, not price × shares.

## Companies: arbitration, and the earnings-scope bug (2026-10-26, evening)
**B is now enforced.** `scripts/arbitrate.mjs` stamps a verdict on every company:
`verified` (all four reconciled fields within 5% and $250m), `disputed` (both values recorded),
`definition` (a bank's revenue basis), or `unchecked` (different fiscal period / no second source).
Current: **451 verified · 12 disputed · 23 definition · 13 unchecked**.

- The company page shows a badge and a `≠` on any disputed cell; hovering gives "SEC $X · Nasdaq $Y".
- The screener has a **Cross-checked** toggle.
- `npm run companies:verify` now runs audit → reconcile → arbitrate → invariants.

**Two real bugs the arbitration exposed**
1. **Earnings scope.** Freeport and Interactive Brokers were using `ProfitLoss` — total earnings
   *including* non-controlling interests — against a common-share market cap. FCX showed $4.15B when
   common holders earned $2.20B (P/E 18 vs 34); IBKR showed $4.36B vs $0.98B (P/E 7.4 vs 32.3).
   Net income now prefers `NetIncomeLoss` → `NetIncomeLossAvailableToCommonStockholdersBasic` →
   `ProfitLoss`, and **scope beats freshness**: a total-earnings figure six months newer is still the
   wrong number for a common-share cap.
2. **Line matching.** Nasdaq publishes both consolidated and parent-attributable net income, and parent
   and total equity. Comparing across scopes invented disputes that were just NCI. The comparator now
   picks the line matching our tag.

**Charts.** `loadCoChart` rejected any series with ≤5 points and defaulted to 10Y, so recent spin-offs
(HONA: 5 monthly points) showed "No price history". Default is now 5Y, with a step-down to 1Y, and the
canvas gets a resize nudge after mount.

## Daily brief: M&A freshness, and party-name cleanup (2026-10-27)
**The bug:** Exxon→Pioneer (announced October 2023) appeared on the brief because a retrospective
article dated yesterday was appended to the deal's `events`, which bumped `lastSeen` to today. The
brief trusted the last *mention*, not the last *development*.

- `mergeEvent` now only appends an event when the status moves forward (announced → closed/terminated).
  Re-mentions increment a counter instead of becoming timeline entries.
- The brief's deal gate is now about the deal, not the wire: it qualifies only if it was **announced in
  the last two days**, or something **happened to it** (closed/terminated/withdrawn) in the last two
  days. Value no longer admits an old deal.
- Cleaned 221 deals that carried retrospective "announced" mentions, and 10 party names mangled by
  headline grammar ("DoorDash Is Said to Near" → "DoorDash", "Bain-backed Surgery Partners, FT reports"
  → "Surgery Partners"). `cleanParty` now runs at ingestion.

Live brief after the fix: `DoorDash → Instacart` (rumour, 26 Oct) and `Bon Secours → Surgery Partners`
(announced, 25 Oct) — nothing older.

## Companies: dispute count down to 12 (2026-10-27)
- Fiscal-year window tightened: Broadcom's FY2024 `NetIncomeLoss` was beating its FY2025 `ProfitLoss`
  under the 2-year window; it is now 30 days.
- Net income prefers **after-preferred, attributable to common** (GS, BA, GM, COF disputes were
  preferred dividends).
- Equity subtracts non-controlling interests when only the including-NCI tag is available
  (UNH 100.1 → 94.1, T 126.5 → 110.5) — the market cap covers common shares only.
- Reconciliation matches the Nasdaq column by fiscal-period date instead of always the newest, which
  cleared most of the 13 "unchecked".
Result: **458 verified · 12 disputed · 23 definition · 6 unchecked**.

## Companies: the full 503 / 500 set (2026-10-27)
The list stopped at 499 because three companies are dual-class pairs (GOOGL/GOOG, FOXA/FOX, NWSA/NWS)
and one 2026 spin-off (VYLR) had no row at all.

- `scripts/add-share-classes.mjs` adds the three second classes by cloning the sibling's filings and
  taking their own Nasdaq price and market cap, marked `shareClass`. VYLR is added as a new listing
  with its Nasdaq quote and description, marked `noFilings` (Form 10 filed, no 10-K yet).
- Second classes appear in the list with a `2ND CLASS` badge but are **excluded from totals, medians and
  the sector board**, so Alphabet/Fox/News are not counted twice. Header now reads
  **"503 securities · 500 companies"**; total market cap stays $69.55T.

**Two regressions found and fixed while doing this**
1. Alphabet's TTM was accepted at $244B (a 61% net margin) because the quarter-outlier guard required
   four prior quarters and only two existed. The guard now works with two.
2. `fix-net-income` reprocessed every company whose tag was not NetIncomeLoss/ProfitLoss, re-inserting
   trailing figures the guard had just rejected — and the two passes cleared each other's values
   (ABT, WELL, CB, BIIB, CTSH oscillated between $0 and their real earnings). It now targets only
   genuinely broken rows, never wipes a fresh value, and the stale sweep only clears what that pass
   itself wrote.

Result: **462 verified · 23 definition · 11 disputed · 7 unchecked**, 0 actionable invariant flags,
0 audit mismatches.

## Companies: period alignment and a deep audit (2026-10-27, later)
**The defect:** five companies carried a balance sheet from one year beside earnings from another
(FTV showed $11.7B of assets next to 2024 earnings when its 2024 balance was $17.0B). The frames pass
dates an instant by calendar period; the earnings pass dates a fiscal year, and they did not have to
agree.

- `scripts/align-periods.mjs` pins assets and equity to the **same fiscal date as net income**, reading
  the company's own instants. Two data traps it now handles: the SEC returns a valid document with an
  empty `units.USD` for some CIKs (falls back to the full filing index), and the same date can appear
  as a zero-valued shell 10-Q beside the real 10-K (zeros are skipped, 10-K wins).
- `scripts/sync-series.mjs` makes the five-year table's latest row agree with the audited headline.
  The series predated the revenue/equity repairs, so AXP printed $41.3B in the table and $72.2B above
  it for the same year. 248 companies synced.

**New audit — `scripts/audit-deep.mjs`** (in `npm run companies:verify`)
Checks what arithmetic cannot: coverage per field, the universe count, share classes pointing at a real
sibling with the same CIK, the five-year table agreeing with the headline *for the same year*,
description quality, and ratios that have their inputs. **0 coherence issues.**

Result: **463 verified · 23 definition · 10 disputed · 7 unchecked**, 7 reconciliation divergences
(LYV, BE, DTE, VMRK, T, HAS, TDG — one-offs and revenue definitions), 0 audit mismatches,
0 actionable invariants, 101/101 tests.

## More audits (2026-10-28)
Three new audit layers, all wired into `npm run audit:all`:

- **`audit-universe.mjs`** — counts against the SPY file, ticker/CIK uniqueness, identity fields, sector
  coverage, share classes resolving to a sibling with the same CIK, index weights present and summing to
  ~100, and market cap vs weight (float-adjusted, so only a 10× gap is flagged). Found VYLR missing a
  weight and SKYD's 8.8× gap — which turned out to be legitimate low float, not an error.
- **`audit-freshness.mjs`** — age of the dataset, the universe snapshot and every company's fiscal data,
  plus a check that the balance sheet shares the earnings date. Found Ford/Fortive/Masco a full year
  behind.
- **`audit-deals.mjs`** — party names, generic nouns, future dates, duplicate keys, event order, and the
  brief's own freshness gate. Found 122 deals with out-of-order events.

**The big catch: the per-concept endpoint returns `units.USD: {}` for most CIKs.** `ttm-earnings` now
falls back to the company's full filing index (like `align-periods` already did). Ford had been showing
**+$5.88B of FY2024 profit** when its FY2025 result was a **$8.18B loss**; Fortive and Masco were a year
stale too. 1,000+ companies were reading empty concept documents.

Also fixed:
- 13 descriptions that were table-of-contents residue ("Market for Registrant's Common Equity…") or
  mid-sentence fragments (JPM, HD, ECL, DOW, KHC, DPZ, ROL, GOOGL, GOOG, FOXA, FOX, NWSA, NWS).
- Prices for the four new rows via the quote `info` endpoint (the `summary` endpoint returns a null
  `primaryData` for some share classes).
- `apply-weights.mjs` — index weights are now a pass, not a one-time edit; 503/503 matched, sum 99.92%
  (SPY holds the rest in cash).
- Deal events sorted chronologically on insert and in the store.
- The filing-index cache is slimmed to the eight concepts we read: it had reached **1.8 GB**.

## Deal titles and full verification (2026-10-28)
**The M&A title was cut at the arrow.** The row clamped the name to two lines, and a long
"acquirer → target" lost the target. The row now renders the two names and the arrow as separate
elements that wrap (`-webkit-line-clamp: unset`, `white-space: normal`), the grid uses `minmax(0,1fr)`,
and the server never emits "— → Target" for a missing buyer. Verified by injecting a 66-character
acquirer and a 51-character target: two lines, nothing clipped.

**500 of 503 securities now verify.** 494 against Nasdaq + 6 against the filing index.
- `align-revenue.mjs` makes revenue mean one thing: it keeps the filing tag that measures the standard
  total, and where none does (banks, utilities, three others) adopts the exchange's total revenue with
  `revenueSource: 'nasdaq'`. Period-gated, so JBL's FY2025 exchange row cannot land on its FY2026 books.
- `verify-filing-index.mjs` re-derives revenue, earnings, assets and equity from the XBRL index for the
  companies Nasdaq does not cover (HONA, FERG, CBOE, JBL, TXT, BF-B) and records `method: 'filing-index'`.
- Reconciliation: **99.4% within 10%**, 0 disputed, 2 definition, 1 unchecked.
- The 2 definitions are C and LYV: the gap is the preferred dividend (we use earnings attributable to
  common, which is the right numerator for a common-share market cap). VYLR has filed no annual report.

## Auto-update, provenance, and the chart bug (2026-10-28, later)
**The chart bug was real and client-side.** The API returned data for all 1,509 ticker/range
combinations, so the failure was in the browser: `renderCompanyPage` replaces its innerHTML, which
destroys the canvas, but `charts['co-chart']` kept pointing at the detached element. The second company
you opened drew into a canvas that was no longer in the document. `mountChart` now checks
`charts[id].canvas !== cv`, destroys the stale instance and recreates it; `renderCompanies` destroys the
chart when returning to the list. Verified by navigating AAPL → MSFT → TSLA: each mounts a live chart
with 263 points.

**Provenance.** `scripts/attach-provenance.mjs` stores the exact filing behind each company: form,
period, filing date, accession number and a direct document URL (502/503; VYLR has no 10-K/10-Q).
The company page now reads "GAAP, as filed … Latest filing · 10-Q · period 27 Jun 2026 · filed 31 Jul
2026 · 10-Q ↗" with a link straight to the document, and the revenue / net income / assets cells carry
the XBRL tag in their tooltip.

**Auto-update.** `.github/workflows/companies-daily.yml` runs `scripts/refresh-daily.mjs` every weekday
at 22:40 UTC: refresh prices and caps, detect new 10-K/10-Q filings, re-derive earnings and the balance
sheet only for the companies that filed, then ratios → second source → verdicts. A weekly workflow does
the full rebuild. Both commit and let Render's `autoDeploy` publish. The SEC response cache is shared
between runs, so the daily job is minutes rather than an hour.

NOTE: `.github/` was previously untracked by choice; scheduling is impossible without it, so the two
workflows are now committed.

## TTM coverage (2026-10-28, later)
Trailing earnings were missing for 146 companies because of three separate faults:
1. The per-concept endpoint was read before the filing index, and it is sometimes truncated to an older
   quarter. `units()` now reads the index first.
2. The tag with the best scope was chosen even when it had no quarterly data (NVIDIA, Microsoft, AMD
   kept an annual figure and lost the TTM). The selection now prefers a same-year tag that has quarters.
3. The outlier guard compared each quarter with the trailing median, which rejects genuine ramps. It now
   compares with the **same quarter a year earlier** — NVIDIA's latest is 2.3× last year's (real), while
   Alphabet's is 4.0× (an artifact).

Where no quarter is newer than the fiscal year, the fiscal year *is* the trailing twelve months, and it
is now used as TTM (`ttmFromFY`). Where the quarters are implausible, the company stays on FY and
`ttmRejected` says why; the P/E tooltip explains it.

Result: **TTM 391/503** (was 357), 52 of them the fiscal year by definition, 60 rejected as implausible
(NVDA's implied TTM margin would be 89%, Alphabet's 61% — the quarterly data does not reconcile with the
annual). AZO's assets and equity were also wrong (19.4B vs 21.6B) and are now taken from its filing index.

Verdicts: **500 verified · 2 definition · 1 unchecked**. 0 audit mismatches, 0 coherence issues,
0 universe issues, 0 deal issues, 101/101 tests.

## EV/EBITDA coverage and regression tests (2026-10-28, later)
The blocker for EV/EBITDA was not D&A (5 companies) but **operating income** (29). Filers either never
tag `OperatingIncomeLoss` or stopped years ago — J&J's last tag was 2014, so the "latest" value was a
decade stale and derive rightly discarded it.

- `fix-from-facts` now picks the **newest** of `OperatingIncomeLoss` and two pre-tax proxies, and marks
  the basis when it uses pre-tax (`opIncBasis: 'pre-tax income'`, 24 companies). D&A falls back to
  `Depreciation + AmortizationOfIntangibleAssets` when the combined tag is absent.
- **EV/EBITDA 394 → 415.** The 19 remaining are 10 with negative EBITDA (INTC, MRNA, CNC, KHC, ECHO…,
  where the ratio is meaningless) and 9 with no operating-income tag at all.

**`tests/companies-data.test.js`** encodes the classes of bug rather than exact numbers, so new filings
do not break it but regressions do: Ford's FY2025 loss, MetLife's revenue total, Broadcom's stopped tag,
DTE's CIK, AutoZone's balance sheet, share classes sharing a CIK but not a cap, TTM/FY magnitude, P/E
basis consistency, description residue, VYLR's missing filings, and the index weights.

It immediately caught two live defects: **BBY and IP** had table-of-contents descriptions again, and
VYLR's revenue was absent rather than null. Both fixed. 115 tests, all passing.

## Restatements (2026-10-28, later)
`scripts/detect-restatements.mjs` scans for 10-K/A and 10-Q/A, matches the amendment's period to our
fiscal date, re-derives the four headline figures from the filing index (the last-filed value for a
period wins), and records what changed. The stored figure becomes the amended one — it is the correct
number — but the previous value is kept in `restatement.changes`, with the form, filing date and a
direct link to the amendment.

129 companies in the universe have an amendment on file; **2 actually changed a headline figure**:
Tesla equity $81.47B → $82.14B and EchoStar $5.72B → $5.77B, both from a 10-K/A filed 30 Apr 2026.
The company page shows a `RESTATED · 10-K/A filed … · equity $81.5B → $82.1B · amendment ↗` badge.

A test asserts that every restatement carries a filing date, at least one changed field, and that the
stored value equals the amended one. Added to the weekly rebuild chain.

116 tests. 500 verified · 2 definition · 1 unchecked · 99.0% within 10%.

## Quarterly table (2026-10-28, later)
`scripts/build-quarters.mjs` builds the last eight quarters of revenue and net income per company from
the same filing index as the annual figures, and the company page renders them under the five-year table
(period, revenue, net income, margin). 461/503 have revenue quarters; the rest file annually only.

Two traps, both the same lesson as elsewhere:
- The slim facts cache did not keep revenue tags (the earnings passes never needed them), so revenue is
  read per concept and falls back to the full index for the CIKs where that endpoint is empty.
- The picker took the first tag with four rows. Apple's `Revenues` stopped being tagged quarterly in
  **2018**, so the table would have shown 2018 quarters. It now picks the tag whose latest quarter is
  newest — Apple's current series lives under `RevenueFromContractWithCustomerExcludingAssessedTax`.

A test asserts the series is chronological, capped at eight, and never contains an empty row.
117 tests.

## 503 rows, TTM for all, and description cleanup (2026-10-29)
- **The list was capped at 150 rows** (`rows.slice(0, 150)`), so two thirds of the index were invisible.
  It now renders every row; the last one is #503.
- **TTM is on 502/503.** Where no quarterly series exists or the quarters are inconsistent with the
  annual, the fiscal year is used as the twelve-month figure (`ttmFromFY`) and the reason is kept
  (`ttmRejected`), with the P/E tooltip explaining it. Only VYLR — no annual report — has none.
- **Descriptions**: a cleaning pass strips heading residue ("GENERAL At Pentair", "Overview IDEX"),
  drops legal-terms openings ("The terms 'we', 'us' … mean …"), and prefixes the company name when the
  text never names it (190 companies). 23 headings and 2 legal openings removed, 0 residue left.
  The Nasdaq sentence splitter now respects abbreviations, so "U.S. Bancorp" is one sentence rather
  than a truncation at "U.S.".

## Free cash flow and bank margins (2026-10-29)
`scripts/build-cashflow.mjs` computes FCF = operating cash flow − capex from the same fiscal year as the
income statement, and derive adds FCF yield, FCF margin, cash conversion (FCF ÷ net income) and net
debt/FCF. **405/503 have FCF**; the 69 financials are marked n/a (a bank's operating cash flow moves with
loans and deposits — JPM's is −$148B, which is not a cash-flow signal) and 29 lack one of the two tags.

The company page gains four cells: free cash flow, FCF yield, cash conversion, net debt/FCF, each with a
tooltip explaining the inputs.

**Net margin for financials is back.** It had been suppressed for the whole sector because bank revenue
used to be net interest income. Revenue is now a consistent total, so the margin is computable — Amex
13.4%, JPM 33.1%, Visa 50.1%. Only a profit above revenue still marks the margin n/a.

119 tests (FCF cannot exceed operating cash flow; banks have FCF n/a but a margin).

## Valuation bands (2026-10-29)
`scripts/build-valuation.mjs` takes the price at each fiscal-year end and divides by that year's EPS,
giving a five-year P/E range per company and a percentile for today's figure. Prices come from Nasdaq's
historical chart (one request per company, cached); the fiscal year end month/day is taken from the
latest filing and applied to earlier years.

- **442 companies** have a band. Apple: 24.8–37.5, median 34.2, today 39.4 → 100th percentile.
- **Index**: Σ market cap ÷ Σ trailing net income = **28.5**, against 18.9–27.2 over the last five fiscal
  years (median 22.9) → **100th percentile**. The page says so in the fourth hero cell.
- Shares are today's, so historical caps are approximate (buybacks/issuance). That is stated in the
  tooltip rather than hidden.

The company page shows a band with a marker at the current percentile; the companies header gains a
fourth hero cell for the index P/E. 121 tests.

## Bands completed, TTM cash flow, live prices, mixed watchlist, mobile (2026-10-29)
- **P/E bands 478/503.** The gap was mostly missing EPS for multi-class names (Visa, Berkshire, Monster):
  EPS now falls back to net income ÷ shares, and shares fall back to cap ÷ price. The band minimum is two
  years. The remaining 25 lost money in most of the last five years — a P/E range cannot exist, and the
  page says so instead of leaving a blank.
- **FCF is trailing.** Cash flow is reported year-to-date, not quarterly, so TTM = last fiscal year +
  current YTD − the same YTD a year earlier. AAPL: $98.8B FY → **$136.7B TTM**, cash conversion 0.88× →
  **1.06×**. Ratios use the TTM figure with a basis label.
- **Live price and change.** `build-price-changes.mjs` reads the cached daily closes and stores price,
  price date, and 1-day / 6-month / year-to-date change. The company page shows a price strip; every
  screener row carries its price and day change under the ticker.
- **Watchlist is mixed.** Company tiles live beside commodity tiles in the same board; pin with the star
  on a company page, unpin from the tile. Clicking a company tile opens its page.
- **Mobile.** The chart canvas sat below the compare controls inside a fixed-height box, so it overflowed
  by 25px and printed its axis labels over the note. The canvas now has its own flex box, and the date
  axis uses four short labels ("Oct 21") on narrow screens.

## Screener, copy, and a structural description fix (2026-10-29)
- **Home screener covers companies.** A COMMODITIES / COMPANIES switch at the top; the company view sorts
  by price, 1D, 6M, YTD, P/E, FCF yield or market cap, filters by sector and search, and opens the company
  on click. It lazy-loads the companies payload if the home page is the first thing opened.
- **Copy**: the tagline is now `COMMODITIES · COMPANIES · MACRO`, and the onboarding explains the three
  universes plus the data basis (SEC filings, cross-checked against Nasdaq).
- **Descriptions are resolved, not patched.** `finalize-descriptions.mjs` scores every candidate — the
  10-K Item 1 text and the Nasdaq profile — against one gate: names the company in the first 90
  characters, 80–420 characters, a complete sentence, no TOC residue, not about a foundation. The best
  candidate wins; if neither passes, it writes an honest generated line with the sector, industry and
  revenue. Result: **495 from filings, 7 from Nasdaq, 1 generated, 0 failing**. A test enforces the gate
  so this cannot regress.

## FCF completion, growth/quality, sector valuation (2026-10-29)
- **FCF 405 → 428 of 503.** The per-concept endpoint 404s on capex for many filers; the cash-flow pass now
  falls back to the filing index, and the capex family gained the industry variants that actually get
  tagged — `PaymentsToAcquireOtherPropertyPlantAndEquipment` (Lilly), `…OilAndGasPropertyAndEquipment`
  (EOG), `…DevelopRealEstateAssets` (Digital Realty). 69 financials remain n/a by design.
- **Growth and quality, previously absent entirely:** revenue CAGR, EPS CAGR, margin change over the filed
  history, return on capital (net income ÷ equity + debt − cash, marked approximate) and net debt/EBITDA.
  Coverage: revenue CAGR 487, EPS CAGR 427, ROIC 480, net debt/EBITDA 320.
- **Sector valuation.** `build-sector-valuation.mjs` applies the index construction per sector on a
  like-for-like company set: Technology 33.6× (100th percentile of 20–33), Energy 27.5× (100th of 7.8–17.6),
  Financials 14.8× (75th), Utilities 22.6× (25th). Shown on the sector board.
- The company screener gained REV CAGR and ROIC columns; the company page gained four cells.
123 tests.

## CAGR labels, trailing ratios, and the Berkshire class (2026-10-29)
- **CAGR is labelled with its period** (`REVENUE CAGR · 3Y`) and every missing rate carries a reason
  ("loss at either end", "history too short") in the tooltip. EPS now falls back to net income ÷ shares
  for filers that never tag it — Berkshire, Visa, Monster.
- **ROIC and net debt/EBITDA are trailing.** ROIC uses TTM earnings; net debt/EBITDA uses a trailing
  EBITDA built by `build-ebitda.mjs` (quarterly operating income + YTD D&A), with a staleness guard so a
  tag that stopped in 2012 cannot supply a quarter.
- **The Berkshire class.** A blanket "Financials → no FCF, no EV/EBITDA" rule was wrong for conglomerates.
  The test is now whether the company reports **material capex** (>4% of revenue): Berkshire (5.6%) gets
  FCF $24.2B and EV/EBITDA 11.9×; Amex (2.9%) and JPM (none) stay n/a. Operating income falls back to
  pre-tax income when the direct tag is stale — Berkshire's last filed in 2012.
- The audit now reconciles EV/EBITDA (it never did), and uses the same series fallback as derive.
FCF 480/503 (17 banks n/a) · EV/EBITDA 423.

## Metrics for the companies FCF does not fit (2026-10-29)
- **Bank metrics**: `build-capital-metrics.mjs` reads goodwill, non-interest expense, net interest income
  and buybacks for the financials. The company page swaps the FCF row for **P/TBV, efficiency ratio, net
  interest margin and shareholder yield** when the company is a financial. JPM: 2.86× tangible book,
  57% efficiency, 2.16% NIM.
- **Shareholder yield for everyone**: dividends + buybacks ÷ market cap, from the filings rather than the
  exchange's yield field (which is missing for Coca-Cola, Exxon, JPMorgan). Coverage 502/503.
- **Fallbacks for non-financials without FCF**: EBIT yield and asset turnover now render instead of a
  wall of dashes; net debt/EBITDA is suppressed for bank-like financials.
- 24 tests.

## Company events in the calendar (2026-10-29)
- `build-events.mjs` estimates each company's next report date from **its own filing lag** (quarter end →
  filed date, clamped 18–60 days), not a generic +30. Every event is labelled `expected` or `confirmed`.
- `/api/calendar` now returns `companies`; the calendar has a mode row — **MACRO / WATCHLIST / TOP 50 /
  ALL 500** — defaulting to the watchlist so 500 companies never flood the grid. Day cells show the
  tickers reporting; clicking a company row opens its page.
- Deals (last 30 days) and restatements are added as confirmed events.

## Japan — TSE Prime from J-Quants (2026-10-29)
- **Source**: J-Quants (JPX's own API), Light plan. No scraping, no EDINET, no JP-GAAP XBRL mapping.
  Prices come one trading day at a time (all issues per call); financials one company at a time.
- **Universe**: TSE Prime, top 225 by market cap — not the Nikkei 225, which is a licensed index whose
  membership is not in the exchange master.
- **`scripts/jquants.mjs`** — client: `x-api-key`, 1.1s pacing (Light allows 60/min), 429 backoff, pagination.
- **`scripts/build-japan.mjs`** — master → prices → rank → financials → calendar → FX → `data/japan.json`
  (0.85MB). Cache in `data/cache/jquants/` (gitignored). `--limit=N` for a smoke test.
- **`scripts/derive-japan.mjs`** — FY basis (labelled with the period end), P/E, P/B, ROE, operating margin,
  cash after investing (CFO + CFI — capex is inside investing, not broken out), and **forward P/E from the
  company's own guidance** (never consensus).
- **Split trap**: BPS and EPS in the summary are not restated for splits (Tokyo Electron, SMFG, Kioxia), so
  share count is market cap ÷ price and forward P/E uses the profit forecast only — never EPS × shares.
- **Market cap unit**: the bars API returns `MktCap` in **millions of yen** (verified against JPX itself).
- **UI**: COMPANIES now has an `S&P 500 / JAPAN · TSE PRIME` switch. Yen throughout, USD shown as a
  conversion, sectors mapped from the exchange's 33 into English, 225-row list + detail page with chart.
- Coverage: 214/225 P/E, 225/225 P/B and cash flow, 212/225 forward P/E, 23 with a scheduled results date.
- 133 tests.

## Japan, round two: native UI and the exchange as the second source (2026-10-30)
- **Visual parity.** The Japan page was rebuilt on the components the US page already uses — `ma-crumb`,
  `co-head`, `coMono`, `co-price`, `co-stats` — instead of its own `co-top`/`jp-price`/`<h2>`. That fixes
  the unstyled back button (`.co-back` never existed), the oversized title, and the text sitting on the
  panel edge (the 12px inset comes from those components, not the container). The market switch is now
  the same amber-underline tab pattern as the main nav, and list rows use `.co-row` with a monogram.
- **Market cap now comes from `/equities/valuation`**, not the bars endpoint: it excludes treasury shares
  and is split-adjusted (JPX is retiring the bars field). Median treasury is 2.1% of shares; Ricoh is 34%.
- **P/E, P/B, ROE and forward P/E are JPX's own**, on a TTM basis — so Japan finally matches the US page's
  TTM preference. `peBasis` says TTM or FY per company.
- **Cross-check**: P/B is rebuilt from the filing's equity and compared with JPX's. 220 of 225 agree within
  5%; the 5 that do not keep both values and say so. Two definition traps found on the way:
  - `Eq` includes non-controlling interests; `ShEq` is the parent's equity. P/B must use `ShEq`
    (SoftBank: 21.35T vs 18.42T — a 14% error).
  - JPX's BPS uses the latest disclosed period, not the fiscal year, so the comparison is period-matched.
- **Data used, not discarded**: ordinary profit, equity ratio, cash, dividends (yield, payout, forecast),
  total assets. Banks show ordinary margin and total assets instead of an operating margin they do not
  report, and cash-after-investing is withheld for financials (it is loans and securities, not FCF).
- **YTD is measured from 1 January**, not from the start of the price window: the default history is now
  300 days. A company listed mid-year says "since <date>" instead of "YTD".
- Price series are cached for the whole Prime market (`data/cache/jquants/series.json`) and deduplicated —
  an overlapping run was appending the same trading day twice.
- 135 tests.

## Japan: quarters, guidance vs delivered, TOPIX, sector medians (2026-10-30)
- **Quarterly series.** Japanese summaries report *cumulative* YTD figures, so standalone quarters are the
  differences (Q2 = 2Q − 1Q, Q4 = FY − 3Q). The page has a **PRICE / QUARTERS** toggle: sales bars against
  operating profit on a second axis, eight quarters. 224/225 companies have at least four.
- **Guidance vs delivered.** The first forecast published during a fiscal year is compared with what was
  actually reported — a late revision cannot flatter it. Toyota guided ¥2.66T and delivered ¥3.85T (+45%);
  213/225 have the comparison. This is the Japanese-conservative-guidance signal, from the same source.
- **TOPIX** (`/indices/bars/daily/topix`, included in Light) gives the benchmark: level, 1D/6M/YTD, shown in
  the price strip so a return can be read against the market.
- **Sector medians** across the 33 TSE sectors appear inline beside P/E and P/B ("sector 11.6×"), computed
  from our own 225 names.
- Ordinary profit is only shown where it exists — IFRS filers (Toyota, Sony) have no such line, so the cell
  falls back to total assets rather than displaying a dash.
- 137 tests.

## Japan: valuation bands, screener, calendar, quarters section (2026-10-30)
- **Five-year valuation bands.** `/equities/valuation?code=X` returns the daily PER/PBR history; we keep the
  distribution (min/p25/median/p75/max/percentile). 215/225 have a P/E band, 225/225 a P/B band. Toyota's
  8.81× sits at the **26th percentile** of five years (5.94–13.92, median 9.81). `scripts/japan-bands.mjs`.
- **Screener.** Sort by cap / P/E / P/B / ROE / dividend / YTD; filter by P/E band, ROE floor, yield floor and
  the 33 sectors. Persisted in localStorage. (Selects fire `change` on some browsers, so both `input` and
  `change` are handled.)
- **Calendar.** Japan results now appear in the home calendar as scheduled events (23 currently); clicking one
  opens the Japanese company page. Watchlist mode matches `jp:code` pins.
- **Watchlist.** Japanese companies can be pinned (`jp:7203`) and render as tiles with ¥ prices.
- **Quarters moved out of the toggle**: the price chart is always shown, and a dedicated **QUARTERLY RESULTS**
  section follows with its own chart and a table (quarter, net sales, YoY, operating profit, margin, net profit).
- **Still to do (requested):** Japan has no market-level stats — aggregate market cap, market median P/E, the
  valuation distribution and sector-level aggregates that the US index panel has. Compute them from the 225
  names (or from the full master) and add a Japan market summary.

## Japan: the whole Prime market, three views (2026-10-30)
- **Universe expanded from 225 to 1,543** — every TSE Prime issue with a market cap. This is where the
  regional banks and the below-book names live; Standard/Growth added almost none of them (41 of 949
  below-book names are outside Prime).
- **Payload kept flat.** Chart series are thinned to 60 points and the valuation cache stores only the
  distribution, not 1,220 dated rows. Result: 6.45 MB raw, **1.20 MB gzipped** — the same wire weight as
  the US file. One payload, no new endpoints.
- **Three views**: MARKET / SCREENER / BANKS.
  - MARKET: TOPIX level and changes, Prime market cap ¥1,270T, median P/E 14.4×, P/B 1.27×, ROE 9.9%,
    yield 2.79%, 527 companies below book, 729 up / 777 down today, TOPIX chart, and a 33-sector table.
  - SCREENER: 1,543 names, four presets (below book, regional banks, high yield, cash rich), sort and
    filter. Rendered capped at 500 rows so a phone stays responsive; the count line says so.
  - BANKS: all 69 Prime banks sorted by P/B — Shimizu Bank 0.39×, Tsukuba 0.49×, FIDEA 0.50×.
- **Observation worth recording**: the re-rating has already started — regional banks are +50% to +120% YTD,
  so "below book" today is not the same setup as "below book" two years ago. The screen shows both P/B and
  YTD for exactly that reason.
- The daily workflow no longer passes `--limit`, so CI keeps the full universe.
- 137 tests.

## Home screener covers Japan; every company listed (2026-10-30)
- The home screener's COMPANIES mode now has a **US / JAPAN** switch. Japan gets its own columns
  (¥ price, 1D, 6M, YTD, P/E, P/B, ROE, market cap) and its own filters — never mixed into the dollar table.
- **The 500-row cap is gone**: both the COMPANIES tab and the home screener render all 1,543 companies.
  Measured re-render at a 390px viewport: **115 ms**, no horizontal overflow, so no virtualisation needed.
- The screener's search input was unstyled (a browser default); it now uses the same dark field, amber
  focus and 30px height as the rest of the site.
- The "returns in USD" control is hidden on the Japan table, where it would be meaningless.

## Japan: five-year charts, on demand (2026-10-30)
- The Japan price chart now offers **1M / 6M / YTD / 1Y / 5Y**, the same idea as the US page's 1Y/5Y/10Y.
- Five years of daily closes for 1,552 issues would be ~10 MB, so charts moved out of the list payload:
  `data/japan-series.json` holds two shared-axis blocks — **140 daily dates** for the recent window and
  **245 weekly dates** back to Nov 2021 — and `/api/japan-chart?code=&range=` slices one company at a time.
- Effect on the wire: `japan.json` fell from 6.45 MB to **3.67 MB raw / 0.69 MB gzipped**, and a chart
  costs ~250 numbers instead of a whole market history.
- Price history now goes back 1,900 days in the build; the daily workflow passes the same window.
- Mobile: Japan rows were 73 px tall because ticker · sector · price · 1D · YTD wrapped onto three lines.
  Sector is now its own span, hidden under 640 px, so rows are **51 px** and the metadata is one line.
  The filter row is two-per-line at 8.5 px instead of five stacked full-width selects.
- The search box is hidden in MARKET and BANKS, where it has nothing to act on.

## Japan: five-year record, liquidity, valuation-percentile screen, compare (2026-10-30)
Built and verified in that order.
1. **Five-year record.** `history` carries five fiscal years per company (1,512 of 1,544 have 4+), shown as a
   table under the quarterly section: sales, operating profit, net profit, ROE, equity ratio, dividend per
   share. Short keys (`y,s,o,n,e,b,a,q,c,i,d`) keep 1,500 companies inside the payload.
2. **Liquidity.** The bars carry `Va` (traded value in yen), which was being discarded. The build now averages
   it over the last 30 sessions and shows **daily traded value** on the page. Toyota ¥72.7B/day. This is the
   filter that separates an investable company from a list entry.
3. **CHEAP VS ITSELF preset.** P/E at or below its own 20th percentile of five years with positive ROE —
   353 companies today. This is the closest thing to a "hidden gem" screen the dataset supports.
4. **Compare**, mirroring the US chart: type a code next to the ranges and both companies are indexed to 100
   at the first shared date. Toyota vs Sony over 6M: Sony +20%, Toyota −1%.
- **Build fix**: the price loop was retrying 2021 dates on every run. Light's history is five years measured
  from today, so the window is now clamped to 1,795 days; TOPIX gets the same clamp and three attempts after
  one transient failure left it null.

## Why the US daily change was two days old (2026-10-30)
Three things stacked:
1. **`build-price-changes.mjs` was only in `companies:rebuild`** — a manual command. It never ran in the
   daily workflow, so `priceAsOf`, `chg1d`, `chg6m` and `chgYtd` froze at the last manual rebuild (27 Oct)
   while `refresh-prices.mjs` kept updating `price` every day. Fresh price, stale change.
2. **The chart cache never expired.** `build-valuation.mjs` returned any file that existed, so "today" was
   computed from a chart written days earlier, and the Actions cache carried it forward.
3. **A timezone bug.** `Date.parse('Oct 29, 2026')` is local midnight; in UTC+8 that is the 28th in UTC, so
   even a correct quote was labelled a day early.

Fixes: the live quote now supplies `chg1d` and `priceAsOf` (it carries `percentageChange` and
`lastTradeTimestamp`), the quote timestamp is parsed as UTC, `build-price-changes` owns only the 6M/YTD
windows and refreshes any chart older than 18 hours, and it runs in the daily workflow.
Result: 502 of 503 prices dated **2026-10-29**, AAPL $348.91 +1.48%.

## US segment: MARKET / SCREENER / MAG 7 (2026-10-30)
- The US side now mirrors Japan's shape: a **MARKET** view, the existing **SCREENER**, and **MAG 7**.
- **MARKET**: S&P 500 level from the macro quote feed (7,720.39), a cap-weighted YTD computed from the
  constituents (+23.1%), total cap $70.39T, median P/E 25.7×, P/B 4.10×, ROE 15.8%, yield 1.46%, 7 companies
  below book, the cap-weighted index P/E (28.5×, 100th percentile of five years), breadth (403 up / 96 down)
  and an 11-sector table. The note states which figures are equal-weighted and which are cap-weighted.
- **MAG 7**: weight, cap, 1D, YTD, P/E and margin for the seven, sorted by index weight. They are **31.7%** of
  the index — $23.47T of $70.39T — so the other 493 share 68.3%. Weight comes from the SPY holdings file, so
  it is the index's own number rather than a derivation.
- The search box and the methodology note are hidden in MARKET and MAG 7, where they have nothing to act on.

## Filters, brief M&A, and the S&P chart (2026-10-30)
- **The US filter chips stayed on screen after switching to Japan**, where they were inert — Japan has its
  own filters inside the body and ignores SECTOR / SIZE / P/E. `syncCoTools()` now hides `#co-chips` whenever
  the Japan segment is active. Verified: US 503 → 78 on Technology, Japan 1,544 → 69 on Banks, chips gone.
- **Brief M&A is now same-day only.** It used a two-day window, so a deal announced on the 28th was still
  appearing on the 30th. The rule is now: announced or changed **today**, worth **$1B+** (or independently
  verified), at most **two**. An empty day produces no M&A block at all. Today's brief returns zero deal rows.
- **S&P 500 chart** in the US MARKET view, mirroring the TOPIX chart: one year of the index, 251 points. The
  `/api/company-chart` ticker guard rejected `^GSPC` because of the caret; it now accepts index symbols.

## Loading: list and detail split, ETag, chunked rows (2026-10-30)
- **The list payload was 90% detail nobody had opened.** `/api/companies` and `/api/japan` now send a
  projection (the ~25 fields a screener row actually reads); the full record is fetched on open from
  `/api/company/{cik}` or `/api/japan/company/{code}` and cached for the session.
  - `/api/companies`  0.39 MB → **0.055 MB** gzip
  - `/api/japan`      1.02 MB → **0.137 MB** gzip
- **ETag / 304** on both list endpoints: a repeat visit transfers **nothing** (verified: 304).
- **Japan's 1,543 rows now paint in chunks of 250** — first rows appear at 0 ms, all rows by ~160 ms,
  instead of one blocking innerHTML. Tab switches no longer flash a loading state when the list is cached.
- `/api/japan` was re-reading and re-parsing 5 MB on every request; it is now a read-through cache keyed
  by file mtime.
- Nothing was removed: every field is still available, just fetched when it is actually read.

## Japan: peer comparison (2026-10-30)
- The Japan company page now ends with **PEERS**: the nearest six companies by size within the same
  exchange sector (a quarter to two and a half times the market cap), with P/E, P/B, ROE, yield and YTD,
  and a header line stating where this company sits against the peer median ("P/E 8.8× vs 15.1×, 42% below").
- Peers come from the list projection the page already holds, so this cost no new request and no new field.
- Toyota against its own sector: 8.8× earnings against a peer median of 15.1×, 0.98× book against 1.03×.

## Japan: descriptions and brand search (2026-10-30)
- Every one of the 1,544 companies now has a description. **150 are curated** (`data/japan-descriptions.json`):
  what the business actually is, plus the brands that hide behind the corporate name — Fast Retailing is
  Uniqlo, Recruit is Indeed, Seven & i is 7-Eleven, Kao is Bioré.
- The other **1,394 are generated** from the filing data and labelled `generated` on the page: sector, size,
  sales, margin, sector count, dividend. Honest, and clearly not a written profile.
- **Brands are searchable**: typing "uniqlo", "7-eleven" or "indeed" in the Japan search finds the company.
  This is the fastest fix for "I don't recognise the corporate name".
- Brands appear as chips under the company name; only brands whose ownership is certain are listed.
- The list payload carries brands only (~7 KB); descriptions travel with the detail record.

## Japan descriptions: 556 curated, the rest enriched (2026-10-30)
- Curated coverage is now **556 companies** — every company above ¥226B of market cap, **93.6% of the index
  by capitalisation**. Each entry says what the business is and, where ownership is certain, the brands
  behind the corporate name (Dunlop is Sumitomo Rubber, Glico is Pocky, Tsumura is kampo medicine).
- The remaining **988 are generated**, and the generator now uses the five-year record instead of a single
  snapshot: revenue path, how many of the last five years were profitable, sector count, dividend.
  *"Sales went from ¥X to ¥Y over five years (+Z%). Profitable in 4 of the last 5 years."*
- **Why it stops there**: below roughly rank 550 the companies are small enough that writing a profile from
  memory would be invention, not knowledge. The project's rule is accuracy over coverage, so those keep a
  factual line and are labelled `generated` on the page.
- Going further accurately needs EDINET — the annual securities report's business-description section —
  which is another API key and a Japanese-text extraction step, not a writing exercise.

## Japan descriptions: fetched for the whole market (2026-10-30)
- **987 more descriptions fetched** from stockanalysis.com's company-profile pages, which are server-rendered
  and cover every TSE code. `scripts/fetch-japan-profiles.mjs`, cached per code in `data/cache/profiles/`.
- Final split: **556 curated · 987 fetched · 1 generated** (Eco's Co. has no profile page). Zero blanks.
- The fetched text is real: ARCHION "manufactures and sells commercial vehicles under the FUSO and HINO
  brands"; Procrea "operates as a holding company for the Aomori Michinoku Bank".
- Precedence is curated → fetched → generated, and `attach-japan-descriptions.mjs` will not overwrite a
  fetched profile with a generated line. The page credits the source on fetched entries.

## US screener: aggregates moved out (2026-10-30)
- The four-cell header (market cap, median P/E, median EV/EBITDA, index P/E) is gone from the SCREENER.
  Those numbers now live in the MARKET view, so the screener opens straight on the rows.

## Japan: THEMES view (2026-10-30)
- **BANKS became THEMES**, a picker instead of more tabs: BANKS · AI & SEMICONDUCTORS · DEFENCE · TSE REFORM.
  Adding a fourth theme would otherwise have pushed the view bar past what a phone can hold.
- **AI & SEMICONDUCTORS** — 32 curated names: equipment (Tokyo Electron, Advantest, Lasertec, DISCO, SCREEN,
  Kokusai, Ebara), materials (Shin-Etsu, SUMCO, Tokyo Ohka, Resonac), memory and logic (Kioxia, Renesas,
  Socionext, ROHM), components and connectivity (Murata, TDK, Taiyo Yuden, Fujikura, Furukawa, Sumitomo
  Electric) and the platforms (Hitachi, Fujitsu, LY, NRI, BayCurrent, SHIFT).
- **DEFENCE** — 8 curated: Mitsubishi Heavy, Kawasaki Heavy, IHI, NEC, Mitsubishi Electric, Japan Steel Works,
  ShinMaywa, Tokyo Keiki.
- **TSE REFORM** — computed, 328: below book, profitable, ROE under 8%. The pool the exchange has been
  pressuring, not a list of activist targets.
- Curated lists live in `data/japan-themes.json`; rules are computed client-side so they never go stale.
- **Rebuild safety**: `build-japan.mjs` rewrites the dataset from scratch, which would have wiped every
  description and theme on the next daily run. It now re-attaches both at the end, and fetched profiles are
  committed to `data/japan-profiles.json` so the gitignored cache is not required.

## US: THEMES view and screener presets (2026-10-30)
- **THEMES** joins MARKET / SCREENER / MAG 7, curated only: AI & SEMICONDUCTORS (33), DEFENCE (12),
  NUCLEAR & POWER (16). Lists live in `data/us-themes.json`; `attach-us-themes.mjs` runs in the daily
  workflow so a rebuild cannot drop them.
- The computed screens the user asked to keep out of THEMES are **screener presets** instead, matching the
  Japan pattern: BUYBACK HEAVY (127), QUALITY (68, ROIC > 15% and revenue CAGR > 10%), CASH RICH (28),
  HIGH YIELD (15).
- Both needed fields the list projection did not carry (`buybacks`, `cash`) — the same class of bug as
  Japan's missing `np`, caught by the preset returning zero rows.

## Themes rebuilt as rules, not typed lists (2026-10-30)
- **The failure**: a hand-written list is always incomplete — Sandisk was missing from AI. Themes are now
  `members = (industry rule ∪ curated additions) − exclusions`, so the taxonomy keeps them current and the
  curated list only fills the gaps it misfiles (KLAC and LRCX are filed as "Industrial Machinery").
- **AI & SEMICONDUCTORS** US: 40 (16 from `industry = Semiconductors` + 24 curated, now including SNDK, WDC,
  STX, NTAP, LRCX, KLAC, TER, COHR). Japan: 50, now including **Ajinomoto** (build-up film for CPU
  substrates), Ibiden, Toppan and DNP (photomasks), Canon and Nikon (lithography), Niterra, JX Metals.
- **DEFENCE** US: 14 (+ Teledyne), Japan: 8.
- **`scripts/audit-themes.mjs`** runs in `audit:all`: every theme must contain its **anchors** (NVDA, AMD, MU,
  SNDK…) or the audit fails, and it prints every company whose own description mentions the business but
  who is not in the theme — the list to review next time.
- **CASH RICH removed from the US screener.** Berkshire's Treasury bills are not a tagged line in SEC XBRL
  (`companyfacts` has no short-term-investment tag for it), so "cash ÷ market cap" cannot be made accurate
  across 500 companies. Better absent than wrong.
- **Click-through fixed**: theme and peer rows use `.jp-bank-row`, and the handler matched only `.co-row`.
  It now matches any `#co-body [data-cik]`.

## Defence theme, methodology and the intro (2026-10-30)
- **Palantir is in DEFENCE.** It was in AI but not defence because the industry rule only caught `Aerospace`
  and the curated list only held hardware primes. Added, anchored, and the audit's defence vocabulary now
  includes "intelligence community", "national security", "government agency", "surveillance".
- **DATA & METHODOLOGY now documents the company data**: 8 source rows (universe US/JP, SEC XBRL, Nasdaq,
  J-Quants, Japan valuation history, descriptions, themes) and a **WHAT IS NOT COVERED** list — Prime and
  S&P 500 only, no ownership data, estimated US earnings dates, no US cash-rich screen and why.
- **The intro (? / onboarding) now describes both markets**: S&P 500 from SEC filings cross-checked against
  Nasdaq, TSE Prime from J-Quants, three views each, and the brand names on company pages.

## Home screener: pagination instead of one endless page (2026-10-30)
- The company screener rendered every match, so Japan was a 1,543-row page. It now pages at **50 rows**
  (25 / 50 / 100 / 250 selectable), with `1–50 of 1,544`, PREV / PAGE n OF m / NEXT.
- Page height for Japan fell from ~90,000 px to ~4,600 px. No infinite scroll, nothing hidden — the whole
  list is reachable and the sort still applies to the full set, not the page.
- Changing the search, sector or sort resets to page 1; changing the page size resets to page 1.
- Same pager on the US screener (503 rows, 11 pages).

## Auto-update audit: three files were never being committed (2026-10-30)
Checked whether new results actually reach the site on their own. They did not, for three reasons:
1. **`data/japan-series.json` was not in the commit list.** Japan price charts would have frozen at the last
   manual commit. Now committed daily.
2. **`data/valuation.json` was never committed** by either workflow — the S&P 500 index P/E and its
   five-year percentile were stuck at 29 Oct. Now committed daily and weekly.
3. **`build-events.mjs` never ran in CI**, and `data/events.json` was not committed, so company earnings
   dates in the calendar were frozen. It now runs daily and is committed.
Also: Japan financials had a **7-day cache TTL**, so a company reporting on Monday could show old numbers
until the following week. The build now asks J-Quants which companies disclosed in the last four sessions
(one request per trading day for the whole market) and refreshes exactly those — results land the day after
they are filed. Today's run picked up **295 companies** that had filed.
- **US home screener bug**: `coScreen` had no `page`/`per` after the pagination change, so `slice(NaN, NaN)`
  returned nothing. US now shows 50 of 500.

## Closing the silent-failure gap (2026-10-30)
- **The daily digest email now leads with data age.** `DATA current — US 2026-10-30 07:46Z (0h) · Japan
  07:53Z (0h)`, or `DATA ⚠ STALE — the nightly refresh has not landed` if either dataset is over 36 hours
  old. The digest is server-side, so it still arrives when the workflow does not — that is the point.
- **New workflow `data-freshness.yml`** runs daily at 12:00 UTC, ~13 hours after the evening refresh.
  `scripts/check-freshness.mjs` exits non-zero if either market is older than 36h; the job then opens a
  GitHub issue ("Data refresh is stale") and fails the run, so there is both a durable record and the usual
  failure notification. It closes the issue automatically once data is fresh again.
- Verified: the check reports both datasets at 0.1–0.2h, and the digest line renders at the top.

## Flaky test: a feed outage was failing the build (2026-10-30)
- `/api/positioning works for any covered market` failed in CI after 45s. It hits the CFTC feed live; when
  that feed is slow or unavailable the endpoint returns `{error}`, and the test treated an upstream outage
  as a defect here. A false alarm is worse than no alarm — it teaches you to ignore the real one.
- `softGet()` retries once, then **skips with the upstream error in the diagnostic** if the failure looks
  like a feed problem (timeout, 429, 5xx, connection). Any other error still fails the assertion, so a real
  regression is not hidden.
- Applied to the positioning and transmission tests; both assert on live feeds.

## Korea: DART client and ratio maths (2026-10-30)
- **`scripts/dart.mjs`** — DART (FSS) client. `corpCode.xml` (zipped XML, parsed with a hand-rolled ZIP
  reader because the project has no dependencies), `fnlttMultiAcnt.json` for up to 100 companies per call,
  and `fnlttSinglAcntAll.json` for a full statement. Key comes from `DART_API_KEY`.
- **`scripts/derive-korea.mjs`** — Korean companies file cumulatively (Q1, H1, Q3, annual), so standalone
  quarters are the differences and the annual report is Q4 — the same arithmetic as Japan, written for
  DART's shape. TTM = last four standalone quarters; a company with fewer falls back to the fiscal year
  and says so.
- Ratios: P/E and P/B from market cap, ROE from equity, operating and net margin, FCF = operating +
  investing cash flow. Guards reject P/E above 500 and P/B above 50.
- **11 tests** across the two modules, all fixture-based — the maths is verified before a key exists.
- **Blocked on**: a free DART API key (40 characters) to fetch the real market.

## Korea: pipeline, endpoints and segment (2026-10-30)
- **`scripts/build-korea.mjs`** — every KOSPI company. Market class and industry come from DART's
  `company.json` (`corp_cls === 'Y'`), shares from `stockTotqySttus`, statements from `fnlttSinglAcntAll`
  (five annual years plus the current year's Q1/H1/Q3), prices from **Naver Finance** (Yahoo is
  rate-limiting this IP), FX from Frankfurter.
- **Two real errors found and fixed while validating on four companies:**
  1. DART's share table returns common, preferred **and a 합계 (total)** row — summing all three double
     counted. Now the total row is used.
  2. Issued shares are not the count the market capitalises after treasury cancellations, so shares are
     now taken from net income ÷ basic EPS where both exist, with the DART total as fallback.
  After both fixes: Samsung ₩222,500 · P/E 33.7 · P/B 3.49; SK Hynix P/E 22.7; Hana 8.6; IBK 6.1.
- **Server**: `/api/korea` (list projection) and `/api/korea/company/{code}` (full record), ETag + cache,
  same shape as Japan.
- **UI**: a third region button `KOREA · KOSPI` with the list and a company page carrying price strip,
  eight stats, five-year record and quarterly table. No guidance section — Korean companies do not
  publish forecasts.

## Korea: 816 KOSPI companies identified; statements blocked by DART rate limiting (2026-10-30)
- The full run found **816 KOSPI companies** (`corp_cls === 'Y'`) and fetched prices for all of them.
- Financial statements stalled: DART stopped answering after a parallel burst, then refused connections
  entirely (even the homepage). This is a rate limit, not a bug — the build is **resumable from cache**
  (`data/cache/dart/`), so a later run picks up where it stopped.
- Pacing lowered for the retry: scan pool 6 → 3, statement pool 4 → 2.
- Validated on four companies before the block, with correct ratios: Samsung ₩222,500 · P/E 33.7 · P/B 3.49;
  SK Hynix P/E 22.7; Hana Financial 8.6; IBK 6.1.

## Korea: MARKET / SCREENER / THEMES (2026-10-30)
- The Korea segment now mirrors the other two: a **MARKET** view with the KOSPI level (5,730.74), 1D/6M/YTD,
  total cap, median P/E, P/B, ROE, below-book count and breadth, plus a KOSPI chart; a **SCREENER**; and
  **THEMES** with four curated lists — SEMICONDUCTORS, BATTERIES & EV, DEFENCE, BANKS.
- KOSPI index history comes from Naver Finance (the same feed as the prices), 260 sessions.
- Market aggregates and themes are written by the build and served through `/api/korea`.
- **English names**: the build now captures `corp_name_eng` from DART's `company.json` (cache schema v2).
  The 3,958 cached entries predate that field, so names show in Korean until the next DART run — DART has
  been refusing connections since the rate-limit burst.
- Guard added: a build that produces zero companies no longer overwrites a good `korea.json`.

## DART: an IP block, and a committed universe to work around it (2026-10-30)
- The site is **up** — fetched through a public reader while every direct call returned 000. So the failure
  is an IP-level block from DART's firewall after a parallel burst, not an outage. DART documents a
  20,000/day limit (error 020) but no block duration; we were well under the quota, so it is a rate block.
- **`data/korea-universe.json`** now commits the KOSPI universe (821 companies, 816 with share counts,
  99 KB) so a CI run does not rescan 4,000 filers — that scan is what tripped the limiter. The build uses
  it when present and falls through straight to prices and statements.

## Korea: English names via OpenFIGI (2026-10-30)
- DART's `corp_name_eng` is the right field but the API is still blocking us, so English names come from
  **OpenFIGI** (Bloomberg's open symbology): batches of 10 tickers with `exchCode: KS`, 83 requests,
  ~9 minutes. **820 of 821** KOSPI companies now have an English name.
- Names are stored in `data/korea-universe.json` and carried through the build, so a CI run needs no extra
  requests. Verified in the UI: SAMSUNG ELECTRONICS CO LTD, SK HYNIX INC, HANA FINANCIAL GROUP,
  INDUSTRIAL BANK OF KOREA.
- OpenFIGI rejects 25 identifiers without a key — 10 is the working batch size, at 10 requests a minute.

## Korea: descriptions, brands, full market live (2026-10-31)
- **737 KOSPI companies** with statements, prices, TTM ratios, five-year history and quarterly tables.
  Market aggregates: median P/E 10.3×, median P/B 0.57×, median ROE 4.5%, 491 of 737 below book — the
  Korea discount, measured rather than asserted.
- **Descriptions**: 727 fetched from stockanalysis.com KRX company pages, 10 generated from filing data.
  Zero blanks. **46 companies carry brand chips** (Samsung → Galaxy, Exynos, Bespoke; Hyundai → Genesis,
  IONIQ; Naver → LINE, Webtoon; Nongshim → Shin Ramyun).
- **Quarter bug fixed**: DART's quarterly filings carry the period NAME but no date (`thstrm_dt` is null),
  so every quarter was being skipped. The end date is now derived from the report code — Q1 31 March,
  H1 30 June, Q3 30 September. 662 of 737 now have quarters.
- UI reuses the Japan components, so the Korea page looks like the other two: price strip, eight ratios,
  five-year record, quarterly table, description and brand chips.

## Korea: sectors, dividends, bands, presets, charts (2026-10-31)
- **Sectors**: DART's KSIC industry code (first two digits) maps to 29 English sectors. This unlocked the
  sector table in MARKET (cap, P/E, P/B, ROE, payout, YTD), the sector filter in the SCREENER, and the
  market aggregates. Electronics ₩2,822T across 43 companies; Finance & Insurance 103 companies.
- **Dividends**: cash paid out ÷ market cap, from the cash-flow statement — 395 companies. Labelled
  "payout" rather than dividend yield because it is total cash returned, not per-share.
- **Five-year P/E bands**: year-end price against that year's EPS plus today, giving a percentile — 526
  companies. "CHEAP VS ITSELF" is the preset built on it.
- **Screener**: BELOW BOOK (491), HIGH ROE, CHEAP VS ITSELF, PAYS CASH, plus a sector filter. The filter row
  is hidden on MARKET and THEMES, exactly like the other two markets.
- **Charts**: the Korea company page now has the same 1M / 6M / YTD / 1Y / 5Y tabs as Japan, served by
  `/api/korea/chart` from five years of stored Naver prices. The **US chart now uses the same range set** —
  it was 1Y/5Y/10Y — so all three markets read identically.
- **English names in the list**: `nameEn` was missing from the list projection, so rows fell back to Korean.
  Fixed; the screener and theme tables now show SAMSUNG ELECTRONICS CO LTD.

## Companies: one chart component, and a market you can see (2026-10-31)
- **The chart header is now one component.** The US used solid amber chips with a COMPARE box; Japan and
  Korea used underlined text tabs. All three now use the same `.co-ranges` header — chips plus a compare
  field — so the graph looks identical in every market. Korea gained a working compare (indexed to 100).
- **Market identity**: each market has a colour — US blue `#4f8cff`, Japan crimson `#e05252`, Korea teal
  `#2fb5a8` — applied to the active tab and to a new **market bar** under the region switch:
  `● S&P 500 7,569.87 −1.95% today · 500 companies`, which becomes `TOPIX 3,965.07 −0.95% · 1,547` or
  `KOSPI 5,730.74 −3.48% · 737`. The bar re-reads after each market's data loads.
- **A market badge follows you into the company page**: the breadcrumb now reads
  `← COMPANIES 005930 [KOREA]`, coloured to match.

## Companies: breathing room above the chart header (2026-10-31)
- The US chart gets its inset from `.co-chartwrap` (10px top padding). Japan and Korea put `.co-ranges`
  straight after the stats grid, so the chips sat flush against it. A rule on `.co-stats + .co-ranges`,
  `.co-verif + .co-ranges` and `.jp-bands + .co-ranges` now gives 12px of padding plus a hairline border —
  measured as a 15px separation. The US is untouched, because it never had the problem.

## Korea descriptions survive rebuilds; one row per company in the US (2026-10-31)
- **Korea lost its descriptions** because `build-korea.mjs` rewrites `korea.json` from scratch and nothing
  re-attached them — the same trap Japan had. `attach-korea-descriptions.mjs` now runs at the end of every
  build: 727 fetched, 10 generated, 46 with brand chips. Samsung reads with Galaxy / Exynos / Bespoke.
- **Alphabet appeared twice** in the US list: GOOGL and GOOG are the same company, and a second share class
  was getting its own row. Second classes are now excluded from the list (500 rows, one per company); they
  remain in the data and in the index weights, so nothing is lost from the totals.

## Companies: no stale renders, instant switches (2026-10-31)
- **Race fixed**: each market render takes a token; if you switch again while one is still fetching, the
  older render bails instead of painting the S&P list over Korea. Verified: US → JP → KR with no pause ends
  on 737 Korea rows and zero US rows.
- **Prefetch**: once the first market paints, the other two payloads load in the background (~370 KB
  gzipped total), so switching is instant rather than a spinner.

## Korea in the home screener, and cross-market compare (2026-10-31)
- **Home screener**: US / JAPAN / KOREA. Korea gets its own columns (won price, 1D, 6M, YTD, P/E, P/B, ROE,
  cap), a sector filter, sorting and pagination — 737 companies, 15 pages. Clicking a row opens the company.
- **Cross-market compare**: the compare box on any company page accepts a prefixed reference —
  `us:AAPL`, `jp:7203`, `kr:005930` — and a shared `seriesFor()` resolves it to the right market's series.
  Both are indexed to 100 at the first shared date, so currencies never mix. Verified: Samsung vs US:AAPL
  renders two datasets.
- **Won prices** now print in full (₩222,500) rather than the compact 만 form used for market caps.
- The compare handler had been wired into the home-screener listener again, so it never fired inside the
  COMPANIES tab; moved to the document-level listener.

## US list shows ROE; Korea searches by brand; universe gaps (2026-10-31)
- **US screener column**: the list showed MARGIN while Japan and Korea showed ROE. Changed to ROE so all
  three read the same (NVIDIA 76.3%).
- **Brand search in Korea**: the filter only looked at name/ticker. It now also matches brands and the Korean
  name — "galaxy" finds Samsung, "shin ramyun" finds Nongshim.
- **Missing companies**: YG Entertainment, SM and JYP are **KOSDAQ** (`corp_cls: 'K'` in DART), not KOSPI, so
  they are correctly outside the index. Ottogi *was* present but named "OTOKI CORP" by the symbology source;
  corrected to OTTOGI CORP and now searchable.
- **Universe gaps**: 48 listed filers had no market class because their `company.json` call failed during the
  DART block. `refresh-korea-universe.mjs` refetches only those — the universe went 821 → 829.
- **Regression caught**: that refresh overwrote the OpenFIGI English names with nulls; it now merges the
  previous names instead of replacing them.

## Korea company profiles now survive CI; full English names (2026-10-31)
- **The real bug**: Korea descriptions were fetched into `data/cache/korea-profiles/`, which is gitignored.
  The daily workflow rebuilds `korea.json` in CI, found no cache, and replaced all 727 real profiles with
  the generated "no company profile was available" line. Japan had already solved this by committing its
  profiles; Korea now does the same via `data/korea-profiles.json` (574 KB), read by
  `attach-korea-descriptions.mjs` and written by `fetch-korea-descriptions.mjs`.
- **Verified the fix the hard way**: hid the local cache, rebuilt, and the profiles still attached — 727/737.
- **The last 10**: 8 REITs get a REIT-specific line (owns property, collects rent, must distribute most
  taxable income) instead of the generic revenue sentence; DH Autonex and Hanyang Securities get curated
  lines. Now 729 real profiles, 8 REIT lines, zero placeholder text.
- **Truncated names**: the symbology source caps English names at 30 characters, so 88 read "SAMSUNG LIFE
  INSURANCE CO LT". `fix-korea-names.mjs` refetches DART's full `corp_name_eng` for only those; 75 extended,
  the rest normalised to the house style (CO LTD, no trailing periods).
- **Guard test**: `tests/korea-data.test.js` fails the build if the committed profile store is missing, if
  fewer than 95% of companies carry a real profile, or if any placeholder line reappears.

## US 1D was a session behind; one filter bar for all three markets (2026-10-31)
- **Why the US daily move looked stale**: the workflow ran at 22:40 UTC, but Nasdaq's quote endpoint was
  still serving the *previous* session three hours after the close. Every US company carried the prior
  day's close and its 1D move. Japan (J-Quants) and Korea (Naver) were current — only the US was behind.
- **Fix**: the cron moved to 01:10 UTC Tue–Sat, after Nasdaq settles its end-of-day batch, and
  `refresh-prices.mjs` now checks the session it received against the expected one and goes back for the
  stragglers (up to six 10-minute retries) instead of shipping a day-old number.
- **Visibility**: every company table now ends its filter bar with "prices as of <date>" — the modal
  `priceAsOf` (US) or `priceDate` (Japan, Korea) — so a stale feed is obvious instead of implied.
- **Uniform filter bar**: the three markets had three different designs — the US in the toolbar, Japan's
  own row of selects inside the body, Korea a single sector dropdown. All three now render through
  `coFilterBar()` into the same `#co-chips` container: preset chips on top, labelled selects below, CLEAR
  and the session date at the end. Each market keeps its own filters (the US has SIZE/MARGIN/GROWTH and
  BUYBACK/QUALITY, Japan P/E/ROE/YIELD, Korea P/E/ROE), which is the point — same shape, different rules.
- **Dead US chips on Korea**: `syncCoTools` hid the US chips for Japan only, so Korea showed BUYBACK
  HEAVY / QUALITY / MARGIN filters that filtered nothing (no buyback data exists for KOSPI or TSE).
  Korea now gets its own bar; nothing US-specific leaks into either market.
- **Sorting**: ROE and YIELD sorted ascending (worst first) in Japan and Korea; both now sort
  best-first, and a blank cell goes last whichever way the column runs.

## Korea's CHEAP VS ITSELF was reading a field the API never sent (2026-10-31)
- **PAYS CASH removed** from Korea: `payoutYield` exists in the dataset but was never projected into the
  list endpoint, so the preset matched nothing.
- **CHEAP VS ITSELF fixed**: same class of bug — it read `bands.pe.percentile`, which `projectKr` did not
  ship. `projectKr` now carries the percentile, so the screen returns 117 companies instead of 0.
- **US REV GROWTH fixed**: the filter read `c.growth`, a field that was never computed anywhere. It now
  filters on the revenue CAGR (484 of 500 companies have one; 152 clear 10%).
- **Root cause removed**: the projections moved to `src/project.js` so they can be tested, and
  `tests/filters.test.js` now asserts, for all three markets, that (a) every field a filter reads survives
  projection, (b) it is populated for most of the market, (c) no preset or select matches nothing, and
  (d) no preset matches more than 75% of the market.

## Kia was missing, nine caps were negative, and the sector table was shifted (2026-10-31)
- **Kia, Hyundai Steel, HMM, Hotel Shilla, Hanmi Pharm were absent** from the Korean list. The build drops
  any company without a share count, and their `stockTotqySttus` calls had failed during the DART block.
  `backfill-korea-shares.mjs` refetched the 13 gaps — 9 filled, 4 are funds with no share table. Korea is
  now **745 companies** (was 737).
- **Nine market caps were negative**, including LG Energy Solution at −₩6.2T. Shares are derived from
  net income ÷ basic EPS, and when the two disagree in sign that division yields a negative share count.
  Both signs must now agree, and a cap is only emitted when the count is positive.
- **The KSIC table was shifted one division from 27 onward.** DART reports KSIC 10th-revision codes, so
  Kia and Hyundai Motor were filed under "Shipbuilding", every shipbuilder under "Furniture", and cable and
  battery makers under "Machinery". Corrected: 27 precision/medical, 28 electrical equipment, 29 machinery,
  30 vehicles, 31 shipbuilding, 32–33 furniture.
- **Brand tags for the US**: `data/us-brands.json` holds 246 curated sets, attached by
  `scripts/attach-us-brands.mjs` (wired into the daily refresh) and shown as chips on the company page and
  matched by search, the same as Japan and Korea.
- **Cross-market peers on the chart**: `/api/peers?ref=kr:000270` returns same-bucket, nearest-size
  companies from the other two markets — Kia comes back with Ford, Paccar, Denso, Honda. Buckets come from
  the four-digit SIC for the US (so a drugmaker is not compared with a health insurer) and from the sector
  for Japan and Korea. Clicking a chip puts it on the same indexed-100 chart.
- **Guards**: tests now fail on a negative cap, on a sector that contradicts the KSIC division, and on any
  filter that reads a field the list projection does not ship.

## Full three-market audit (2026-10-31)
Every check below was run against the committed data and the live API, not assumed.
- **Prices reconcile with the sources.** US: AAPL $344.63 −1.23%, XOM $187.25 +2.16%, JPM $337.04 −1.90%,
  all matching Nasdaq exactly and all stamped 2026-10-30. Korea matches Naver (Samsung ₩220,500,
  Kia ₩94,800). Japan's 400 sampled rows reconcile with the J-Quants series for both price and 1D.
- **Totals reconcile.** US $69.14T over 500 companies; Japan ¥1,259.35T over 1,546; Korea ₩5,255.88T over
  745. Sector caps add to the market total in both markets that publish them.
- **Fixed: a preferred share class counted as a company.** ITO EN's preferred (25935) was in the Japanese
  list and totals as a separate company. It is now flagged `shareClass`, excluded from the count, the
  totals and the list — the same rule the US uses.
- **Fixed: negative market caps.** Korea divided net income by EPS without checking the signs agreed,
  which produced a negative share count and a negative cap (LG Energy Solution at −₩6.2T). Fixed earlier
  today; the audit confirms zero remaining.
- **Fixed: published shares did not reconcile with the cap.** Korea now publishes the count the cap was
  built from (`shares`) alongside the issued count (`sharesIssued`), so price × shares equals the cap for
  all 745 companies.
- **Fixed: ROE with negative equity.** Dividing by negative book equity flips the sign — STX Corporation
  showed +336.6% ROE with no book equity at all. Korea now requires equity > 0. Japan keeps JPX's own
  figure, which is attributed to JPX on the page.
- **Extremes checked, not "fixed".** P/E above 400 (TSLA 416, PANW 975), P/B above 60 (AAPL 68, MA 72) and
  ROE above 300% (Colgate 3,804% on $54M of equity) are arithmetically correct for buyback-shrunk balance
  sheets. MRNA's +614% YTD matches its own price series (24.16 → 221.72).
- **UI audit**: all nine market views render (US 500/11, Japan 1547/33/69, Korea 745/30/8), no horizontal
  overflow at 390 px, no JS exceptions, every company page draws its chart, six cross-market peers, brand
  chips and a description.
- **Guards added**: `tests/markets-data.test.js` fails on a negative cap, a preferred class counted as a
  company, a total that does not equal its parts, a share count that does not reconcile, an ROE printed
  without positive equity, or prices spanning more than one session.

## The compare box takes a company name; US profiles are real profiles (2026-10-31)
- **Typing a name in COMPARE did nothing** because the box only understood a ticker, and the datalist
  filtered on the ticker value. It now asks `/api/search`, which matches across all three markets on name,
  ticker, Japanese name, brands and industry, and returns chartable refs. Typing "jpmorgan" lists
  JPMorgan Chase; click it or press Enter and the chart redraws. Ranking prefers an exact first word and
  then the larger company, so "samsung" opens Samsung Electronics, not Samsung Card.
- **A real bug behind it**: `/api/japan-chart` only accepted the 5-digit JPX code (72030), while every
  cross-market path passes the 4-digit ticker (7203). Comparing anything against a Japanese company
  returned an empty series — including the peer chips shipped earlier today. The endpoint now accepts both.
- **US descriptions**: the 10-K "Item 1" text is what a lawyer wrote — fragments like "Originally organized
  as Caterpillar Tractor Co." and mangled prefixes like "JPMORGAN CHASE & — J P Morgan Chase". All 503 now
  carry a written profile from Nasdaq's own company-profile endpoint, stored in `data/us-profiles.json`
  (115 KB, committed) and re-attached by `attach-us-descriptions.mjs` inside the daily refresh, the same
  pattern as Japan and Korea.
- **Tests**: search resolves a name to a ref, prefers the biggest namesake, spans all three markets, and the
  Japanese chart answers to both the ticker and the code.

## Korea loads in 0.4s instead of 1.1s; the calendar is two tabs (2026-10-31)
- **Cold Korea was 1,128 ms.** Measured, not guessed: 548 ms for `/api/korea` plus parse and paint. Three
  fixes:
  1. `warmMarkets()` now fires the moment the COMPANIES tab opens (it used to wait until a market had
     already rendered, so the first switch paid the full fetch). Japan and Korea start together.
  2. `loadKorea()` / `loadJapan()` keep the in-flight promise, so the prefetch and the click no longer race
     and issue two identical requests (the second was 312 ms of dead time).
  3. The list projection now ships only what the list, the screens and the search read. Margins beyond the
     operating one, free-cash-flow yield, USD cap, share counts and the P/E basis live on the company page,
     which loads the full record separately. Korea: 77.6 → 57.2 KB gzipped (−26%). Japan: 150.6 → 138.5 KB.
  Result: **435 ms** to 745 rows on a cold visit, one request.
- **Calendar**: four modes (MACRO / WATCHLIST / TOP 50 / ALL 500) collapsed to two — MACRO and COMPANIES —
  and they are exclusive: one shows economic releases, the other earnings and filings. Old stored modes
  fall back to MACRO.

## Mobile pass on COMPANIES (US, Japan, Korea) — 2026-10-31
Audited at 360, 390 and 430 px with screenshots of every view, then fixed what looked wrong.
- **Rows**: the meta line was a run of "·" separators, so a wrap left an orphan dot ("₩220,500 −4.3% ·")
  and every Korean and Japanese legal name was truncated to one line. The meta is now a wrapping flex
  row with gaps instead of dots, and names get two lines on a phone. The sector is dropped from the row
  on mobile — it lives on the company page.
- **Filter bar**: five selects plus presets ate 400 px, nearly half the screen, before any company. Presets
  stay visible; the selects fold behind a FILTERS button that shares a row with the search box.
- **Company page**: the avatar sat beside a full paragraph, squeezing the description into a column. On a
  phone the head stacks (avatar, name, sub, description full width), stats go to two columns, the watchlist
  star moves to the corner, and the filter bar is hidden entirely — a company page starts at the top.
- **Theme tables**: eight columns in a 390 px viewport truncated names ("SAMSUNG ELECTRONICS C…") and
  wrapped caps ("₩1509.17 / T"). Four columns with a wider cap cell and a two-line name.
- **Japan count**: the market bar said 1547 companies while the header said 1546 — the bar was not
  excluding the preferred share class.
- Verified: no horizontal overflow at 360/390/430 px on any of the nine market views, no JS exceptions,
  and the desktop layout is unchanged.

## Methodology covers Korea; the intro is one line; screener tables fit a phone (2026-10-31)
- **DATA & METHODOLOGY** now lists Korea: the KOSPI universe (745, and why KOSDAQ names such as YG
  Entertainment are absent), DART statements with the cumulative-quarter rule, Naver prices and ECB FX,
  the five-year valuation history, and the KSIC sector fold. The Japan count was corrected to 1,546 and
  the description counts now match the data. Two Korea limits added: no company guidance means no forward
  P/E, and ~80 small filers are absent rather than estimated.
- **The ? intro** is now the single lead line. The two paragraphs under it were stale (they still said
  "two company markets" and "1,544 Japanese companies").
- **Home screener on a phone**: the company table carried `min-width: 760px`, so in a 390 px viewport the
  reader saw COMPANY and PRICE and had to scroll sideways for the rest. Company tables now fit the width
  with four columns — COMPANY · PRICE · 1D · YTD — the ticker and sector on a second line, and the face
  dropped from 12 px to 10.5 px. The commodity table keeps all its columns; the rule is scoped to
  `.sc-cotable` only. The COMPANIES tab list went from 12.5 px to 11.5 px to match.

## The scheduled workflows were failing on a push race (2026-10-31)
- **Symptom**: the 05:54 UTC `companies-weekly` run failed after 40 minutes. The rebuild itself succeeded;
  the last step died with `! [rejected] main -> main (fetch first)`.
- **Cause**: the workflow commits data and runs a bare `git push`. I was pushing commits to the same branch
  at the same moment, so the push was rejected and the whole job went red. `companies-daily` and
  `macro-snapshot` had the same unguarded push and would have hit it eventually.
- **Fix**: all three now rebase onto whatever landed and retry five times before failing:
  `git pull --rebase -X theirs origin main && git push`. `-X theirs` prefers the CI's fresh data when the
  same data file changed on both sides — the CI copy is the one that was just fetched.
- Also: `fetch-depth: 0` on checkout (a shallow clone cannot rebase cleanly) and a `concurrency` group per
  workflow so a manual dispatch cannot overlap a scheduled run.
- **Verified**: reproduced the race in a throwaway repo (human commit lands, CI commit tries to push) and
  the new block rebases and pushes, with the CI data winning.

## US data: three real bugs, and the ceiling of the tag-whitelist approach (2026-10-31)
- **Dividend yield was missing for most payers** (96 of 500). Nasdaq's `yield` field is blank for Coca-Cola,
  Exxon, JPMorgan, AT&T, Verizon, McDonald's, Procter & Gamble. It is now computed from cash dividends
  paid ÷ market cap when the exchange figure is absent, and labelled `computed` (404 of 500 now carry one;
  the rest genuinely pay nothing). The HIGH YIELD screen went from 13 matches to 82.
- **Net interest margin was computed for non-banks.** Insurers, brokers and asset managers also tag an
  interest line, so Chubb, Moody's and T. Rowe Price showed a "NIM". NII/NIM/non-interest expense are now
  only kept for SIC 60xx and 6199 — 10 companies, all banks.
- **A rebuild reverted amendments.** `detect-restatements` writes the corrected value and keeps the record,
  but the next rebuild rewrote the field from the original 10-K: TSLA's equity went back to $81.47B against
  its own recorded 10-K/A value of $82.14B. `apply-restatements.mjs` now re-applies every recorded change
  and runs inside both rebuild workflows.
- **Quarterly revenue**: a single tag per company left 59 companies with eight blank quarters (Visa, Abbott,
  HCA, Ford, JCI). Quarters are now merged across every candidate tag per period, with year-to-date figures
  differenced when a filer only tags cumulative amounts. 50 companies still have gaps.
- **What is still wrong, and why it needs a different approach**: operating income is present for only 72%
  of companies, EBITDA 69%, TTM EPS 77%, and `epsDiluted` is never populated. The cause is the same one
  behind the quarter gaps: the pipeline asks for a fixed list of XBRL tags. Companies that tag the same
  concept differently get a null. The fix is a per-company `companyfacts` resolver with derivation rules
  (opInc = revenue − costs; EBITDA = opInc + D&A; EPS = net income ÷ shares) rather than a longer whitelist.

## Quarters resolved from the full XBRL index (2026-10-31)
- **The whitelist was the problem.** `build-quarters` asked for six revenue tags and used ONE of them for all
  eight quarters. Companies that tag revenue under a concept outside the list — or that only tag cumulative
  year-to-date figures — came back with blank columns. 59 companies had eight blank revenue quarters.
- **`resolve-quarters.mjs`** reads one `companyfacts` document per company (cached at ~100 KB each), keeps
  every us-gaap tag, and resolves each period by: the highest-priority tag that has that exact quarter →
  a quarter differenced from year-to-date figures sharing the same start → for operating income, revenue −
  costs. Banks get net interest income + non-interest income, because they do not tag a revenue line.
- **Two bugs found while building it**: the `/tax/` exclusion was throwing away
  `RevenueFromContractWithCustomerExcludingAssessedTax` (the most common revenue concept in the index), and
  differencing across two different tags produced a 37.5B "quarter" for Visa. Cumulative rows are now keyed
  by tag AND start, and a value is dropped if it sits more than 4× from the median quarter.
- **Result**: eight complete revenue quarters for **488 of 500** companies (was 441), operating margin for
  432, net margin for 487. The company page now shows REVENUE · OP INCOME · MARGIN · NET INCOME per quarter
  instead of a net-margin-only table. The remaining 12 are recent listings (fewer than eight quarters filed)
  or banks that tag no revenue concept at all.

## US data audit: the flaws that were still there (2026-10-31)
- **P/E fell back to an old profitable year when the trailing twelve months were a loss.** Gilead showed
  a trailing P/E of 24.9× while its last four quarters were a −$3.9B loss, because the code quietly used the
  prior fiscal year. A trailing loss now means no trailing P/E, labelled n/a with the reason.
- **Financial ratios that do not exist were being printed.** Banks and insurers were given a current ratio,
  an enterprise value, EV/EBITDA, net debt/EBITDA, ROIC, FCF yield and cash conversion — all meaningless for
  them. `naRatios` now records which ratios do not exist for a business, and the company page omits those
  tiles instead of printing "n/a". Banks keep P/TBV, efficiency ratio and NIM; REITs drop the current ratio.
- **TTM EPS was missing for 23% of companies** because the per-share tag is absent. It is now derived from
  net income ÷ shares where both exist (110 companies), marked as derived: coverage 77% → 99%.
- **Known and not fixed**: 165 companies have a market cap that differs from price × shares by 2–6%, because
  Nasdaq capitalises every share class while the filing's share count is the primary class. The cap is the
  authoritative figure, so this is documented rather than "corrected". `epsDiluted` is still never populated.

## Structural gap closed: annual fundamentals resolved from the full index (2026-10-31)
- **`resolve-fundamentals.mjs`** reads the broad facts already cached for every company and rebuilds the
  five-year series by priority tag, then by derivation: operating income = revenue − costs when the
  operating line is not tagged; EBITDA = operating income + D&A; EPS = net income ÷ shares.
- **Operating income 362 → 488 of 500 (97.6%)**, EBITDA 0 → 432 (86.4%). The series went from four years to
  five for most companies, so the CAGR windows are longer and the financials table is complete.
- **TTM EBITDA** now falls back to the last four quarters' operating income plus annual D&A: 343 → 438.
- **EPS growth is never a dash.** Where a CAGR does not exist because one end is a loss, the tile shows the
  change itself — `−$6.04 → $8.14` for GE, `$3.76 → −$0.05` for Intel — with the years and the reason on
  hover. 58 companies use it.
- Revenue CAGR 484 → 491; the nine still missing are three recent listings and six with non-positive
  revenue in a year.

## EV and the Berkshire case: a structural fix (2026-10-31)
- **Enterprise value was null for 87 companies** because it required both a debt and a cash tag. It is now
  built from whatever is tagged — market cap + debt − cash — and records which part was missing
  (`evApprox`), so the page shows `$1.14T ≈` with the reason on hover instead of a blank.
- **Berkshire files a custom taxonomy.** It tags no debt total, no `LongTermDebt`, no `NotesPayable` and no
  `ShortTermInvestments` (its `CashAndCashEquivalentsAtCarryingValue` stops at 2017), so its balance sheet
  is largely invisible to us-gaap. Two consequences fixed:
  - EBITDA was taken from a tagged total of $66.4B while its own operating income was $82.5B and D&A $13.5B.
    EBITDA is now built from its parts when both exist: **$95.9B**, and EV/EBITDA is 11.9× — a plausible
    multiple instead of a blank.
  - Insurers were being treated like banks and losing EV, EV/EBITDA, ROIC, FCF and EBIT yield. Only the
    current ratio is genuinely absent for them. Berkshire now shows 17 ratios, including return on capital
    at 12.9%.
- **"n/d" instead of a dash** where an input is not tagged at all: Debt/Equity and Net Debt/EBITDA say
  `n/d` with "this company does not tag a debt total in its XBRL filings" on hover, rather than looking
  like a failed calculation.

## The company chart no longer depends on Yahoo, and revenue is now TTM (2026-10-31)
- **Why charts were missing**: `/api/company-chart` called Yahoo at request time. Yahoo rate-limits this
  host, so one month and six months came back with a single point for **every** company — the graph drew
  nothing. The five-year range only worked because its Yahoo response was cached.
- **Fix**: `build-us-charts.mjs` turns the daily closes already cached from Nasdaq into a committed series
  (`data/us-charts.json`, 6.4 MB, ~500 points per ticker: daily for the last 400 days, weekly before that).
  The endpoint slices it by range and only falls back to Yahoo for symbols it does not hold. Verified:
  1m 24 points, 6m 133, 5y 626, for AAPL and BRK-B alike. It runs in both workflows.
- **Why some companies showed 2026 revenue and others 2025**: `revenue` was the last **fiscal year**, while
  the net income beside it was **TTM**. Microsoft's year ends in June, so it showed FY2026 next to a TTM
  profit, while Apple showed FY2025. Revenue is now TTM too (sum of the last four quarters, 487 of 500),
  labelled TTM with the fiscal-year figure in the tooltip. Where quarters are incomplete it falls back to
  the fiscal year and says which year it is.

## Last gaps closed, and the US quarter table now reads newest-first (2026-10-31)
- **Operating income fallbacks**: revenue − costs was not enough for filers with no operating line, so two
  more derivations were added — gross profit − operating expenses, and pretax income + interest expense.
  Operating income is now present for **494 of 500** (was 488); EBITDA for 488.
- **The remaining six** (PSX, COHR, CASY, HONA, VMRK, VYLR) genuinely file no operating line in any form.
  VYLR has no SEC filing at all, so a ticker with `noFilings` is no longer listed — a company page where
  every field is blank is worse than no page.
- **Bank and insurer pages now say why** the ratios are missing: "No enterprise value, EBITDA, free cash
  flow, current ratio or return on capital: those ratios do not apply to a bank or an insurer, so they are
  omitted rather than shown as blanks."
- **US quarterly table reads newest-first**, matching Japan and Korea. It was oldest-first, so 2024 sat
  above 2026.

## EV/EBITDA on the same period as the rest, and the series synced (2026-10-31)
- **The 350 EV/EBITDA "mismatches" were one policy, not 350 bad numbers.** `derive-companies` preferred the
  fiscal-year parts (operating income + D&A); `audit-calculations` preferred the trailing figure. All 350
  were explained by that difference (0 unexplained). The fiscal year is a year stale for a fast grower:
  NVDA 37.0x vs 24.5x, AAPL 35.0x vs 30.2x.
- **The newer period wins now.** TTM is used when its as-of date is later than the fiscal year's
  operating-income end; otherwise the parts. Berkshire keeps 11.9x (its tagged TTM stops in 2013). MSFT
  keeps 20.5x (same period). Bloom Energy's TTM carried no D&A leg (it equalled the four quarters'
  operating income exactly) and was repaired: 488x → 97.5x.
- **The five-year table is synced after arbitration.** `sync-series` ran before the final `arbitrate` pass,
  so 199 companies had a latest row that contradicted the headline. It is now the last data step in
  `companies:rebuild`; coherence issues 106 → 0.
- **VYLR is excluded from coverage, not counted as twelve gaps.** A 10-Q-only listing has no annual
  figures; it is reported separately instead of dragging every field percentage down.
- **Three Nasdaq differences are documented, not hidden** (`data/recon-explanations.json`): LYV (the 10-K
  files two annual net-income concepts), BE and TDG (the Nasdaq number does not appear anywhere in the
  filing). They are labelled `definition` with the reason — reconciliation is 0 unexplained.
- **Verified:** `npm run audit:all` exits 0 · 0 reconciliation mismatches · 0 coherence · 0 universe · 0
  deals · 18 informational flags · 174 tests pass. Honest gaps that remain: SKYD's last 10-K is FY2024 (no
  FY2025 10-K exists), FDXF does not tag cash, debt coverage 92.4%, FCF 86.9%.

## Korea market caps were built on the wrong share count (2026-10-31, corrected)
- **The earlier three-market audit said Korea reconciled. It reconciled to itself.** `derive-korea`
  computed shares as net income ÷ EPS, and the DART EPS feed rounds some filers to ₩1. 드림텍's ₩1 EPS
  turned a 66M-share company into 13.2B shares and a ₩87T market cap (actual ₩0.43T); 포스코퓨처엠
  716M vs 89M shares; 한화 489M vs 69M.
- **The stock table has two look-alike counts.** `now_to_isu_stock_totqy` is everything ever issued —
  Samsung 8.98B and SK Hynix 5.72B. `distb_stock_co` is listed now (issued − retired − treasury):
  Samsung 5.83B, SK Hynix 0.70B. The old code used the first.
- **Fixed**: `shares` is now DART's common line, listed (the common quote does not price the preferred
  line); EPS is only a fallback for funds with no table. `sharesIssued` keeps the total issued count.
  `scripts/refresh-korea-shares.mjs` (`npm run build:korea`) re-reads all 829 filers and caches the
  table. A sanity guard rejects a filed count that implies a market cap above 10,000× revenue or 20×
  the EPS-implied count — LS에코에너지 filed 30.6 trillion shares.
- **Result**: 633 of 829 counts moved. Samsung ₩1,285.0T (Naver ₩1,289.1T), Hyundai ₩56.57T (Naver
  ₩56.67T), LG Chem ₩16.27T (Naver ₩16.27T), SK Hynix ₩976.1T (Naver ₩1,016.1T — Naver's cap lags its
  own quote). KOSPI total **₩5,255.88T → ₩4,358.22T**; the old figure was inflated by the bad counts.
- **Verified**: price × shares = cap for 745/745; sector caps = total; 1D/6M/YTD recompute exactly;
  30/30 prices against Naver; 174 tests pass.
- **Still open**: Korea P/E stays FY (`peBasis: 'FY'`) because only the 2026 interim filings are cached
  — Samsung shows 28.4× on FY2025 against Naver's 9.9× TTM. A real TTM needs the 2025 Q1/H1/Q3 filings
  fetched (≈2,200 DART calls). Labelled, not faked.

## Japan: duplicate fiscal years and IFRS-only filers (2026-10-31)
- **`/fins/summary` returns the same fiscal year twice when a filing is amended.** SoftBank (9984) has
  2026-03 filed on 05-13 and 05-15. The five-year table printed the year twice, and "latest fiscal year"
  could pick the older revision. **316 of 1,546** companies were affected. `derive-japan` now keeps one
  row per fiscal year, newest disclosure.
- **Cybozu (7157) files IFRS with `Sales` blank and only `NCSales` filled**, so it had no statement block
  at all and its period was stuck at 2023. The consolidated field is preferred but the non-consolidated
  one is now accepted, for every statement field and for the quarterly flows.
- **Rebuilt from J-Quants (v2)**: 0 duplicate fiscal years · oldest period 2025-09-30 · ¥1,259.35T total
  · P/E and ROE exactly as JPX publishes them (trailing) · market cap ex-treasury · 1,485 with a P/E.
- **14 companies show "P/B differs from JPX"**: their Q3 equity (30 Sep) was filed after JPX's valuation
  snapshot, so the cross-check sees a small timing gap. The published P/B is still JPX's.
- **3 insurers** (Tokio Marine, MS&AD, Sompo) have no revenue line in the summary — shown as "—",
  not invented.

## Korea P/E is trailing now, not the last fiscal year (2026-10-31)
- **A TTM needs four reported quarters.** `build-korea` only fetched the current year's interims, so
  before Q3 was filed there were two, `ttmKr` returned null, and every P/E fell back to FY2025. Samsung
  read **28.4×** on FY2025 while the trailing figure was **11.5×**.
- **Fetched the prior year's Q1/H1/Q3** for all 829 filers (2,109 new filings, 378 with no report) via
  `scripts/refresh-korea-quarters.mjs`; `npm run build:korea` now runs shares → quarters → build.
- **Empty statement caches are retried daily, not weekly** — a company that had not filed in the morning
  is picked up the same session. Same change applied to `build-japan`.
- **Result**: 665 of 746 companies carry a TTM P/E (was 0). Samsung **11.5×** (trailing through Jun 2026;
  DART has no Q3 filing yet, so Naver's 9.9× is not reproducible from the filings). One more company
  gained statements (746 vs 745). KOSPI total unchanged at **₩4,358.30T**.
- **Verified**: P/E = market cap ÷ four-quarter profit for all 665; P/B and ROE reconcile; price × shares =
  cap for every row; 174 tests pass.

## Korea P/E: banks and insurers are trailing too (2026-11-01)
- **686 of 746 companies now carry a TTM P/E** (518 with a positive P/E; the rest are loss-makers).
  The 60 that remain FY are young listings/REITs with fewer than four reported quarters — 40 of them
  still have a P/E, 20 are loss-making.
- **Banks and insurers file interims as standalone quarters, not cumulative.** KB Financial's Q3 2025
  report shows ₩1.66T against a ₩1.75T half-year, which cannot be a nine-month total; their statements
  also carry no revenue line, so the cumulative builder produced nothing. A standalone builder (Q1, Q2,
  Q3, Q4 = FY − first three) runs when the cumulative one returns no quarters.
- **Cross-check against Naver's TTM PER**: KB 8.77× (Naver 9.23), Shinhan 7.76 (7.98), Hana 7.80 (8.13),
  Woori 6.84 (7.11), Samsung Life 16.35 (19.16). The residual gap is Naver using a later window.
- `quartersBasis` on each record says which construction was used (`cumulative` or `standalone`).

## Automated refresh: what updates itself, and what was wired (2026-11-01)
- **US** — `companies-daily` (01:10 UTC Tue–Sat) runs `refresh-daily`: prices, Nasdaq caps,
  `detect-new-filings` (10-K/10-Q accession changes), then `ttm-earnings` for only the tickers that
  filed, followed by derive/reconcile/arbitrate/sync/audit. A new quarter becomes the TTM P/E the same
  night.
- **Japan** — the same job runs `build-japan`. P/E and ROE come from JPX's valuation file, fetched on
  every run, so a new quarter changes the TTM P/E the next session. The statement block refreshes when
  a company filed in the last 4 sessions, otherwise on the 7-day cache.
- **Korea** — the same job runs `build-korea`. The report currently due (Q1 Apr–Jun, H1 Jul–Sep, Q3
  Oct–Dec, annual Jan–Mar) is re-read **daily**, so a new quarter lands the day after it is filed;
  TTM = the last four reported quarters. The rest of the statements keep a 7-day cache.
- **Weekly** (Sat 05:20 UTC) now also refreshes Korean share counts and prior-year quarters and commits
  `data/korea-universe.json` — before this, Korea was only touched by the daily job and share counts
  never refreshed.
- **`check-freshness` now watches Korea too** (US/Japan/Korea), and the daily commit includes
  `data/korea-universe.json`.
- **Hong Kong and Australia** joined the schedule on 2026-11-04 — see the last section of this file.
- **Secrets** `DART_API_KEY` and `JQUANTS_API_KEY` are present in the GitHub repo.
- **Not live yet**: the workflows run `main`, and the fixes on this machine are uncommitted. Push before
  the next weekday run (Tuesday 01:10 UTC) or CI will refresh data with the old code.

## Three-market audit: the chart file, Korea's caps, and a year-stale TTM (2026-11-01)
- **The committed chart series was wiped by CI.** `data/us-charts.json` went from 6.7 MB to 36 bytes
  (`series: {}`) in the 2026-10-31 daily commit, so every US company chart fell back to Yahoo, which
  rate-limits this host — the exact failure the file was created to fix. Cause: `build-us-charts.mjs`
  reads `data/cache/charts`, which is gitignored and therefore empty in CI, and it wrote the empty
  result over the committed file. It now starts from what is committed, keeps any ticker it could not
  rebuild, and refuses to write at all when the cache is empty (`no chart cache found — keeping the
  502 committed series`). Reproduced the CI case by hiding the cache: the file is unchanged.
- **Korea's market caps were stale after 2026 splits and consolidations.** The share count comes from
  DART's stock table for the **previous fiscal year**, so a 1:5 split left LS ELECTRIC at a fifth of
  its cap and a 1:10 consolidation left 신성이엔지 ten times too large. Checked against Naver's own
  market-value feed (25 pages, 2,481 issues): **159 of 746 companies were more than 10% off, 49 by more
  than 100%**, in both directions. The market's cap is now the authority and the share count is derived
  back from it, so price × shares still reconciles on screen. `sharesDart` keeps the filing's number and
  `sharesBasis` says which was used. KOSPI total **₩4,358.22T → ₩4,459.29T**; Samsung ₩1,289.1T and SK
  Hynix ₩1,016.1T, both matching Naver.
- **244 of 746 share counts differ from the last annual report by more than 5%** — that is the size of
  the split/consolidation drift, now reported by the audit instead of silently mis-capitalising.
- **Dividends paid had mixed signs.** DART tags `DividendsPaid` as an outflow for some filers and a
  positive amount for others (Samsung's 2023 annual is −₩102.0B, 2024 is +₩10.9T), so **52 companies
  published a negative payout yield**. `mapAccounts` now keeps the magnitude.
- **A Korean filing in the wrong unit was published as fact.** DY E&C's 2026 half-year revenue is filed
  as ₩253T against a ₩633B year — 400× its own business — which produced a ₩14.5T quarter and a
  **P/E of 0.00**. Reports more than 20× out of line with the company's own annual revenue are dropped
  (a missing quarter is honest), and a P/E that rounds below 0.01 is now `null`.
- **The US headline TTM was up to a year behind the quarterly table.** The concept cache and the broad
  facts cache refresh independently; 173 of 500 companies had a `netIncomeTTM` that did not equal the
  four quarters shown beside it, and 140 had fallen back to a fiscal year with newer quarters right
  there. `reconcile-ttm.mjs` makes the contiguous quarter window the trailing figure when it is the
  newer side: **GOOGL $132.17B (2025-12-31) → $235.69B (2026-09-30)**, NVDA $120.07B → $192.88B, AMZN
  $77.67B → $134.78B, MRK $18.25B → $3.17B (two loss quarters). 163 companies corrected; where the
  quarter table is the *older* side it is flagged (`ttmQuarterGap`), not silently overridden.
- **`ttm-earnings` selected the wrong tag.** `fresh.find((x) => x.ttm)` always matched the highest-priority
  tag because `trailing()` returns an object even on failure, so a tag whose quarters stopped a year
  earlier won over one that was current. It now requires a value and picks the latest window. The
  plausibility band (0.2×–5× the fiscal year) also rejected legitimate near-zero years — APD's −$0.39B
  year against a −$0.05B trailing year — so below $0.5B the ratio is treated as noise.
- **The daily refresh never re-read anything for the companies it detected.** `--only` still served the
  permanent concept cache, so "new filing detected" produced the same old number. `--only` now forces a
  refetch, and the daily job also runs `resolve-quarters --fetch` and `resolve-fundamentals` for those
  filers before reconciling the TTM.
- **New `audit-markets.mjs`**, wired into `audit:all` and `companies:verify`: 28 checks across the three
  markets that reproduce every published ratio from its own inputs (cap ÷ TTM profit, cap ÷ equity,
  op ÷ sales), check JPX's PER×EPS and PBR×BPS against the price, check Korea against Naver, and fail
  when the TTM is not the four quarters shown. **0 failures**; 284 warnings, all labelled: 15 JP P/B
  filing-date differences, 21 JP ROE-vs-FY-sign (JPX ROE is trailing), 4 US multi-class caps, 244 KR
  split drifts.
- **Verified**: `npm run audit:all` exits 0 · 0 reconciliation mismatches · 0 coherence · 0 universe ·
  180 tests pass. Snapshot baseline refreshed after the deliberate TTM corrections.
- **Still open**: Japan publishes JPX's trailing ROE beside the fiscal-year profit with no `roeBasis`
  label; Korea's 41 FY-basis P/Es are young listings/REITs without four quarters; the 13 companies whose
  quarter table has a hole keep the concept-based TTM and are flagged rather than guessed.

## The SHIPS & SATELLITES segment is gone (2026-11-01)
- **Removed on request.** The crude-only folded panel, the live AIS client, the NASA FIRMS gas-flare
  count, the Sentinel-1 radar pass and its pixel scan, the chokepoint counters, the Cape-vs-Suez
  reroute index and the AIS anomaly tracker are all deleted — not hidden behind a flag.
- **Server**: `/api/tankers`, `/api/flares`, `/api/sar`, `/api/sar/image`, `/api/chokepoints`,
  `/api/reroute` and `/api/flows` are gone, along with `startAIS`, the WebSocket subscription, the
  `tankerMMSI` persistence and the flare/reroute state files. `hasShips` is no longer a market field.
  The digest's source line no longer credits aisstream.io.
- **Front-end**: the panel, its jump-nav link, the Leaflet map (and both CDN includes, so one fewer
  third-party dependency), the satellite renderer, the reroute chart and every related loader and
  interval. `style.css` lost the map/tanker/satellite/flow rules; `?v=` bumped to 112 / 258.
- **Freshness**: `/api/tankers` and the two satellite endpoints are gone from the API test list.
  **178 tests pass.**
- **Deliberately kept**: the `Tankers / shipping` row in the refined-products *stock* watchlist
  (FRO, DHT, INSW, STNG, TNK) and the trade-idea copy that mentions product tankers. Those are
  shipping equities, not the AIS segment — say so if they should go too.
- **Env**: `AISSTREAM_KEY` is no longer read, documented or required; `render.yaml`, `.env.example`
  and the README are updated. The Render env var can be deleted.
- **Verified**: page renders with no `#c-ships`/`#map`/`#satellite` elements, removed endpoints 404,
  `/api/market`, `/api/tightness`, `/api/inventories`, `/api/products` still 200.

## The free instance no longer sleeps between visits (2026-11-01)
- **Symptom**: the first request after a quiet spell opened on the boot screen for 20–30 seconds. Render's
  free plan sleeps a web service after ~15 minutes without traffic, and a cold resurrection is slow
  enough that the site looks broken rather than sleeping.
- **Fix**: `.github/workflows/keepalive.yml` pings `/health` every five minutes from Actions — not from
  a laptop, so it works while the Mac is asleep. GitHub's scheduler runs late under load, so the spacing
  is five minutes rather than ten; the real gap stays well inside Render's fifteen-minute idle timeout.
- Three attempts per run with a 45s timeout, and the job deliberately **does not fail**: a red run every
  five minutes trains you to ignore the colour. `data-freshness` remains the job that raises an issue
  when the site is genuinely down.
- `scripts/keepalive.sh` still exists for a manual ping or a local cron; the Actions job is the one that
  keeps production warm.
- **Cost**: a public repo gets free Actions minutes, and Render's free tier allows 750 instance hours a
  month — an always-warm single service is ~730, so this stays inside the free plan.

## Loading: immutable assets, cached JSON, ten-second boots (2026-11-01)
- **The largest asset was re-downloaded on every visit.** `app.js` is 364 KB raw / ~105 KB gzipped and
  the header was plain `no-cache` with **no ETag and no Last-Modified** — a conditional request still
  got a full 200. Every `?v=` asset is now `public, max-age=31536000, immutable` (the `?v=` already
  promises the bytes never change), and unversioned files carry an ETag and answer 304.
- **JSON revalidated on every tab switch.** Cached endpoints moved from `private, max-age=0,
  must-revalidate` to `public, max-age=30, stale-while-revalidate=60` — shorter than any refresh the
  page uses, and none of it is per-user. `/api/market`, `/api/calendar`, `/api/brief`, `/api/seasonal`,
  `/api/screen`, `/api/inventories`, `/api/analytics`, `/api/positioning`, `/api/equities`,
  `/api/macrodash` and `/api/macro-tickers` now use it.
- **`/api/history` was fetched twice on every boot** — once in boot and again from `reloadHistory()`.
  The reload now reuses what is already loaded: 24 KB saved per visit.
- **Chart.js is self-hosted** (`public/vendor/chart.umd.min.js`, 205 KB → 66 KB brotli) instead of a
  jsdelivr CDN request. One less third-party DNS + TLS handshake, and it caches immutably.
- **Boot runs history and prices in parallel** instead of back to back (~0.3s).
- **`macro-tickers` is warmed at boot** with the other slow feeds; it is a 2.2s Yahoo call.
- **Keepalive**: a Cloudflare Worker cron (`workers/keepalive/`) pings `/health` every five minutes —
  live at https://watchtower-keepalive.marlonbenedicttan.workers.dev. Redeploy with
  `cd workers/keepalive && npx wrangler deploy` after `npx wrangler login`. The GitHub Actions job
  stays as a best-effort fallback, and the page pings `/health` itself every five minutes while a tab
  is open. The cold start is the single largest perceived delay: 20–30 seconds on Render's free plan.
- **Measured after**: 318 KB → 293 KB first load; repeat visits skip app.js, style.css and Chart.js
  entirely (162 KB of the total). 178 tests pass.
- **Not done**: minifying `app.js`. With immutable caching the 105 KB is paid once per version, so a
  minifier would add a build step to a repo that deliberately has none for a one-off saving.

## The boot screen was waiting for a panel that never loads (2026-11-01)
- **Every visit sat on "reading the market…" for the full 8-second cap.** `BOOT_CORE` gated the overlay on
  seven panels, including `positioning` — which is a below-the-fold panel loaded by `whenNear()`. It never
  reports ready during boot, so the gate could never complete and the 8s fallback always fired.
- Removing it from the gate: **9.0s → 3.5s** to a usable page (measured locally, warm cache). The overlay
  now hides when the first-screen panels are actually ready.
- `/api/history` and `/api/headlines` were the last two `no-store` feeds; both are cached for 30s now.
- Repeat-visit transfer measured with a warm browser profile: **267 KB → 56 KB** (10 requests served from
  cache), because `app.js`, `style.css` and the self-hosted Chart.js are immutable for a year.

## Regression: the segment picker went empty (2026-11-01, fixed)
- **Symptom**: the COMMODITIES tab had no segments — the picker was blank, so nothing could be selected.
- **Cause**: my own boot parallelisation. `loadMarket()` builds the picker (`buildBpOptions()`) and bails
  out when `markets` is still empty. Prices and the segment list used to load in sequence, so the list
  was always ready first; loading them in parallel let `/api/market` win the race, the picker saw an
  empty list, and `selectMarket()` never rebuilt it.
- **Fix**: `buildBpOptions()` is idempotent and now runs again after `markets` arrives and on every
  `selectMarket()`, so either order works.
- **Also true of the earlier change**: hiding the overlay when prices land means panels can be on screen
  before their data arrives. Every panel must therefore *fill in* rather than depend on boot ordering —
  the picker was the one place that did not.

## COMPANIES prefetches itself now (2026-11-01)
- **The idle prefetch never ran.** `warmMarkets()` — which pulls /api/companies, japan and korea in the
  background — was only called from the screener render, i.e. *after* opening the tab it was supposed to
  make fast. It is now scheduled 2.5s after the loading screen lifts.
- Measured on mobile (390x844, 4x CPU, Fast 3G): COMPANIES opens in **0.2s** (was 0.8s), a company page
  plus its chart in **0.7s** (was 1.5s).
- It is skipped when `navigator.connection.saveData` is set or the connection reports 2G — that is ~250 KB
  of background payload for a tab the reader may never open.
- The company chart is deliberately NOT part of the loading gate: it belongs to another tab, and gating
  the first screen on it would cost every visitor two seconds they do not need.

## The tape stuttered once a minute (2026-11-01)
- **Cause**: `renderTicker()` replaced `innerHTML` with ~110 freshly created spans on every data refresh
  (every 60s). Re-creating the track made the browser repaint the whole strip and re-reset its measured
  width, right while the rest of the page was also updating — the visible "lag" was that burst.
- **Second cause, removed while there**: the rAF loop read `track.scrollWidth` on every frame, which can
  force a layout flush per frame. The width is now measured once and cached, and invalidated only when
  the cells change or the window is resized.
- **Fix**: cells are matched by label and their text is updated in place. Same DOM nodes, no rebuild,
  no repaint of the strip.
- **Speed is unchanged**: `TICKER_MS` is still 120000 (one copy per two minutes) — measured 96.4 px/s
  before and after. `?v=276`.

## The RISK panel now answers a question (2026-11-02)
- **The old panel told the wrong story first.** Its headline said "Wildest here: VIX, down 54%" —
  but VIX is a level, not a holding, so a 54% drop is not a loss. "What WTI moves with" then opened
  with an *opposite* move, the heading said "lately" while the matrix was a full year, and the
  drawdown bars were scaled to the worst row, so a 4% bar meant nothing on its own.
- **Risk rows are decision-ordered now:** `off its 1-year high` (with a fixed 0–50% bar), `worst fall`
  as context, `jumpy now` (annualised 30-day vol), and **`normal for it?`** — today's vol ranked
  against *that instrument's own* year (`volPercentile`), not a global threshold. US 10y and VIX carry
  a `LEVEL` tag so their "fall" is never read as P&L.
- **Correlation is grouped by decision, not dumped as a matrix:** `MOVE TOGETHER` / `MOVE OPPOSITE`
  for every pair at |r| ≥ 0.40, with the 1-year value beside the 3-month one and a `stronger` /
  `weaker` / `flipped` tag when the link changed. Loose pairs are counted, and the most independent
  series is named. The full matrix is still behind a fold, now with a diverging heat scale and a
  3-month / 1-year toggle.
- **API additions** (`/api/risk`): `drawdownNow`, `level`, `volPct`, `volVsOwn` per metric;
  `matrix3m`, `pairs3m`, `groups3m` (with `r1` + `shift` per pair), `days3m`. New pure helpers in
  `src/lib.js`: `drawdownNow`, `volPercentile`, `volVsOwnWord`, `corrWord`, `corrShift`, `pairGroups`;
  `riskRead` is risk-only now (correlation has its own section). **200+ tests**.
- **Also landed:** the `?v=` on `app.js` / `style.css` is now stamped from the file mtime at serve
  time, so a deploy can't leave returning readers on a year-cached old asset. No manual bump needed.

## MACRO across every country/region: one card request, extras off the critical path (2026-11-02)
- **A country switch used to fan out into five requests** after the card landed: `/api/macro-news`,
  `/api/country-series`, `/api/yields` and `/api/catalysts`, on top of `/api/country` — then the region
  prefetch warmed every *other* country in parallel. Flipping through regions multiplied that burst.
- **The card now carries its news and chart series** (`/api/country` → `news`, `series`). Both were
  already computed inside `getCountry`, so this adds no server work — it just removes two round trips.
- **Yields + the release calendar come together from `/api/country-extras?id=`**, one request, fired
  after the card paints. Neither feed can hold the card. (A bundle with all four was tried first and
  made the card *slower* — the card is supposed to appear before the slow feeds.)
- **The World Bank / FRED are only asked for fields the IMF snapshot lacks.** `macro.json` already has
  GDP / CPI / debt / unemployment for every country, but the code still fetched all four World Bank
  series (plus FRED debt) on every cold country. Skipped fetch → ~4 fewer upstream calls per country.
- **1m/3m/6m/YTD/1y chart ranges are sliced from the same 2-year daily series** the card already needs
  for its 1D/1W/…/1Y moves (`deltaSeries`). One Yahoo fetch per symbol instead of four. 5y keeps its
  own monthly request.
- **Macro chart markers load only when the reader scrolls near them** (`whenNear` on the chart wrap),
  so flipping countries at the top no longer fires 3–4 `/api/movewho` lookups (each up to 6 Google News
  queries) per switch. They still appear as soon as the chart is on screen.
- **Region prefetch starts 2.5s after the visible panel settles** (idle on top of that), is cancelled
  when the reader changes region, and is skipped on `saveData`/2G.
- **The panel no longer snaps back to the region's first country** on a background macrodash refresh:
  `renderMacroRegion` keeps the current country when it is already in the region list, and
  `renderMacroDash` only builds the picker once.
- Measured locally (cold server, MACRO opened from HOME): the country card paints in ~0.3–0.7s, the
  extras land in parallel, and the network shows **no** separate news/series/yields/catalysts requests
  and **no** movewho burst while the card is in view.
- Tests: `/api/country` must carry `news.items` + `series.dates`; `/api/country-extras` must carry
  `yields` + `catalysts` (and 404 an unknown country). **202 tests pass.**

## The daily brief: priorities first, then events (2026-11-02)
- **The dairy problem was a scoring inversion.** `score = |move| / own σ` gave a thin market a huge
  number for a quote refresh (milk/cheese/HRC print unchanged on 40–50% of days), and the "max two per
  complex" rule did not block it because Dairy is its own group. A 5% cheddar print could outrank Brent.
- **`PRIORITY` in `src/lib.js` is now editorial, not statistical.** Tier 1 may lead (WTI, Brent, gas,
  gold, copper, US/China/Japan/euro-area/India), Tier 2 may appear, Tier 3 only with a confirmed event
  (dairy, livestock, rice, OJ). Any instrument flat on ≥25% of days is auto-demoted to Tier 3.
  `rankByPriority` fills Tier 1 first, then Tier 2, and never lets a score promote a band. A quiet day
  produces fewer rows, not cheddar.
- **`IMPORTANT TODAY` is event-first.** `classifyEvent` assigns category/weight (market access, sanctions,
  OPEC, geopolitics, sovereign, central bank, data, supply, politics, policy, markets, regulation, M&A);
  `clusterEvents` folds duplicate wires into one event per category/subject/day and counts corroboration;
  `scoreEvents` adds source tier, market confirmation, novelty (from `state.eventHistory`) and freshness;
  `selectEvents` enforces five events, two per category, one per subject, and the Tier-3 proof rule.
- **The why is extracted, never invented.** `splitCause` takes the headline's own causal clause
  ("stocks sink **as MSCI flags a review**"); a curated transmission rule is the fallback and the UI
  labels it `WHY IT MATTERS`, not `WHY`. Market chips are the day's actual move, not a claim that the
  event caused it.
- **Freshness:** event items are today/yesterday only; the pool is cached 30 min, warmed before the
  brief at boot, and attached outside the brief's 5-minute cache so a cold pool cannot freeze the page.
  `at` carries the best headline timestamp; the browser labels it in the reader's local time.
- **M&A is a first-class event** (same-day announcement or development, $1B+ unless verified), not just
  a tape row.
- **The brief follows the session, not the wall clock.** `sessionDate` is the latest
  `paperDate`/`physicalDate`. A Sunday brief describing Friday's close uses Friday's news, so the event
  pool, freshness window and header are about the session the prices actually belong to.
- **Every row now carries a reason** (`explainRows` in `src/lib.js`): the row's own story, then a peer
  row that already has one (US tech for Japan/Korea, gold for South Africa), then a global theme, then
  a regional peer. Shared drivers are labelled `GLOBAL` / `COMMODITY`; a row with no wire reason says
  `CONTEXT — …`, never a bare number.
- **API:** `/api/brief` gains `events[]` (`key, category, label, what, why, mechanism, primary, market,
  sources, source, url, at, novelty, score`) and `sessionDate`. The old `hero`/`rows`/`next` shape is
  unchanged.
- **Known limits:** Google News RSS gives titles, not article bodies, so a wire that does not state its
  cause falls back to the category rule. Event day keys are the session date; the UI shows local time.
  The pool is ~26 cached queries, so a cold first request can show no events until the next one.
- **Tests:** 211 pass serially (`node --test --test-concurrency=1`). The default parallel run can
  occasionally reset one `/api/korea` socket under load; the file alone is 54/54.

## Index ranges are redraws, and a market switch cannot paint the old market (2026-11-02)
- **A range click on MARKET is now a local re-slice, never a page render or a request.** The S&P 500,
  TOPIX and KOSPI charts all draw from a series already in memory through `drawMarketIndexChart` —
  the strip and the line come from the same dates, and `mountChart` updates the existing instance in
  place. Japan and Korea used to call `renderJapan()`/`renderKorea()` for a window click, rebuilding
  the whole market view (33-sector table included) and remounting the chart.
- **The US index used to fetch twice per click.** `drawUsMarketChart` requested both the ten-year daily
  series and the clicked window, destroying the chart first, so the frame blanked and the network had
  to answer before anything appeared. Now one `^GSPC` ten-year daily series is fetched once per
  session; every window (1M–10Y) is sliced from it. Headless check: five rapid 1M/1Y/5Y/1M/10Y clicks
  made **zero** requests, kept the same canvas and strip, and moved the active chip.
- **Every market render takes a token, the US included.** `renderCompanies` used to skip `takeToken()`
  when moving back to the US, so an in-flight Japan render stayed valid: when its fetch finished it
  painted TOPIX over the S&P 500 page. All three renderers now share the token and bail if a newer
  market won.
- **The region switch clears the old screen immediately** with the new market's name
  (`Loading the S&P 500…`), and the US market view no longer waits for `/api/macro-tickers` before it
  paints — the quote pill reads the cached tape, or fills in after paint. Headless check on Japan → US:
  no TOPIX in the DOM at 0 ms, 120 ms or after settle.
- **A chart that cannot load now says so.** `.co-chartwrap[data-empty]` had no CSS rule (only
  `.chart-wrap` did), so a failed S&P/KOSPI fetch left a silent empty frame.
- **Tests:** 209 pass. New UI regressions: a window change reuses the chart instance and re-slices;
  a window longer than the series falls back honestly; the US market page paints before the quote
  lands. Headless CDP run reported no console exceptions.

## The company compare box stopped following you (2026-11-02)
- **Symptom:** the COMPARE benchmark on a company page stayed on the previous company when you opened
  another one, and could not be removed. Changing the chart range then dropped the comparison line
  while the box still showed it.
- **Cause:** `coCompare` / `jpCompare` / `krCompare` were page-global. Opening a company never reset
  them, there was no clear action, the range handler called `loadCoChart(coTicker, coRange)` without
  the compare, and the self-check compared a ref (`jp:7203`) with a code (`7203`), so a company could
  be compared with itself. Korea was worse: the selected company is a DART code (`00126380`) while
  search returns a ticker ref (`kr:005930`).
- **Fix:** the benchmark is per company — a new company starts clean; the same company keeps it across
  re-renders. Added a `×` clear button, preserved the compare on range changes, guarded self-compare
  in all three markets (Korea resolves the DART code to its ticker), and the box/legend show the code
  (`MSFT`, `7203`, `005930`) instead of the internal `us:MSFT` ref. Focusing the box selects the
  existing value so typing replaces it. **211 tests**.

## Mobile scroll: less work per frame in Safari (2026-11-02)
- **The address-bar resize no longer forces layout.** iOS Safari fires `resize` repeatedly while the
  URL bar collapses, with the width unchanged. The top-bar height is now re-measured only on a
  **width** change (`setTopbarH`), and the ticker resets its cached half-width only on a width change
  too. Both used to do a forced layout read in the middle of the scroll gesture.
- **The ticker stops when it cannot be seen.** An IntersectionObserver stops the rAF loop when the
  tape scrolls off screen, and `visibilitychange` stops it in a background tab; it restarts on return
  with `tickerLast` reset so the tape does not jump. The pause button now stops the loop instead of
  leaving it running with a no-op transform.
- **`-webkit-overflow-scrolling: touch` is gone** from the wide-table wrappers (`.sc-wrap`,
  `.m-tbl-wrap`, `.corr-wrap`, `.tbl/#analogue/.glossary`). It is obsolete on modern iOS and creates
  nested scroll layers that can pull scrolling onto the main thread.
- **Mobile-only layer promotion:** `.topbar` and `.jumpnav` get `translateZ(0)` under
  `@media (max-width: 640px)` so Safari composites the sticky bars instead of repainting them on
  every scroll frame. Desktop computed styles are unchanged (`transform: none`).
- **Verified at 390×844:** the tape animates → stops offscreen → resumes; pause/play works; a
  height-only resize leaves `--topbar-h` at 48px and the tape running; a width change re-measures;
  no horizontal overflow; screenshots unchanged; no long tasks. 211 tests pass.
- **Honest limit:** a 60 Hz iPhone cannot match a ProMotion MacBook. If it still feels heavy after
  this, the next lever is dropping the second sticky layer (the jump-nav) on phones.

## Taiwan: every TWSE-listed common stock (2026-11-02)
- **Universe**: 1,089 four-digit TWSE common stocks with issued shares and a price. TDRs (91xx),
  ETFs, warrants and preferred lines are excluded. The index is TAIEX, the exchange's own
  cap-weighted benchmark (~1,060 constituents, TSMC ~41%).
- **Sources**: TWSE OpenAPI for the master, the latest close and the official P/E / P/B / dividend
  yield; Yahoo (`query2`, via `https.get` — undici's fingerprint is rejected) for five years of daily
  closes; TWSE's monthly market report (`FMTQIK`) for TAIEX history; `open.er-api.com` for USD/TWD
  (the ECB does not publish TWD). Statements and English profiles come from stockanalysis.com's TPE
  pages, the same source the Japan/Korea profile fetchers use.
- **Why not MOPS for statements**: the per-company MOPS HTML works but is rate-limited and needs ~20k
  requests for the full market. stockanalysis gives annual (5y + TTM) and quarterly (20q) statements
  in four pages per company; TWSE's own P/E/P/B are the cross-check (the build prints the number of
  names more than 15% away).
- **Build**:
  `npm run build:taiwan` — build → fetch English names/descriptions for all 1,089 → rebuild from
  cache to attach them. `--limit=20 --days=400` is the smoke test; `--codes=2330,2454` builds named
  companies. Caches live in `data/cache/{twse,taiwan-yahoo,taiwan-finmind,taiwan-sa,taiwan-profiles}`
  and the build is resumable.
- **Output**: `data/taiwan.json` (records + reports + annual/quarterly history),
  `data/taiwan-series/{0..9}.json` (daily last ~400 sessions + weekly 5y, keyed by code; ten buckets so one chart reads ~2–6 MB, not 23 MB),
  `data/taiwan-list.json` (the compact `/api/taiwan` payload), `data/taiwan-profiles.json`.
- **Server**: `/api/taiwan`, `/api/taiwan/company/{code}`, `/api/taiwan/chart?code=&range=`. The UI
  adds a fourth region button (`TAIWAN`) with MARKET / SCREENER / THEMES, a company page, the home
  screener tab, search (`tw:2330`), peers and compare.
- **Limits**: no free structured guidance, so no forward P/E; TAIEX is official but the market
  aggregates are computed from the covered constituents. Returns are TWD; the base-currency control
  does not convert TWD (ECB has no TWD), so it is hidden for Taiwan.
- **Tests**: `tests/taiwan-derive.test.js` (TTM ratios, loss/negative-equity guards, bands) and
  `tests/taiwan-data.test.js` (cap = price × shares, ratio bounds, market totals, index ordering,
  list projection fields).
- **Built (2026-11-02):** 1,084 companies · 865 P/E · 1,081 with statements · 1,084 English
  descriptions · TAIEX 45,211.83. Audit against TWSE: 48/865 P/E and 142/1,079 P/B more than 15%
  away — the exchange's ratios use its own reporting lag, and our P/B is the latest reported quarter
  (TTM to 2026-09-30). Three new listings have no statement page yet.

## Company screeners: the same 50-row pager in every market (2026-11-02)
- US, Japan and Korea now paginate their COMPANIES screener exactly like Taiwan: 25 / 50 / 100 / 250
  per page, PREV / PAGE n OF m / NEXT, and a `1–50 of N` count. The full filtered set is sorted first,
  then sliced, so the ranking is global, not page-local.
- Any filter, preset, search or sort resets to page 1; the page size is per market. US 500 → 10 pages,
  Japan 1,546 → 31, Korea 746 → 15.
- Japan's old 250-row chunked paint is gone: one 50-row page is a single paint.

## Taiwan audit: formulas, prices, and the corporate-action trap (2026-11-02)
- **Formulas reproduce exactly** for all 1,084 names: market cap = price × shares, P/E = cap ÷ TTM
  net income, P/B = cap ÷ latest equity, ROE, operating/net margin, FCF = CFO + CFI, and the market
  medians/breadth/sector caps all reconcile. `npm run audit:taiwan` is the repeatable check.
- **Prices were the real bug.** The first build left 346 names on FinMind's raw close; Yahoo's raw
  close is not split-adjusted either. A 20:1 split (6949), a 1:20 reverse split (6467) and capital
  reductions appeared as −95% / +1,828% "returns" in the five-year strip. The build now:
  1. prefers Yahoo for every name (FinMind only as a fallback),
  2. starts each series at the exchange master's **listing date** (no grey-market/pre-listing data),
  3. sanitises a single-day move beyond Taiwan's ±10% limit: flatten it if it reverses within three
     sessions (bad print), otherwise back-adjust all earlier closes by the observed ratio (split,
     reverse split or capital reduction).
  After the rebuild: **0** single-day >25% anomalies and **0** weekly extremes outside the limit.
- **Filings cross-check against MOPS** (independent, as-reported): FY2025 revenue and
  parent-attributable net income match exactly for MediaTek, Delta, Formosa Plastics, China Steel and
  Wiwynn (and Delta's Q3 2026 revenue/net/equity match to the yuan). TSMC's vendor FY2025 net is
  1.18% below MOPS (stockanalysis adjustment); that is the one known source variance.
- **TWSE's own P/E and P/B** differ for 46/865 and 142/1,079 names by >15%: the exchange's ratios use
  its own reporting lag (our P/B is the latest quarter, TTM to 2026-09-30). Yield matches within
  0.2pp for every name.
- **Universe:** 1,084 priced common stocks. Five master names (1470, 1538, 1589, 5906, 6921) have no
  current trade and are absent rather than estimated; three new listings have no TTM statement yet.

## Hong Kong: every HKEX main-board company (2026-11-02)
- **Universe**: the HKEX **daily quotation report** (`d{YYMMDD}e.htm`, one plain-text page per session,
  keyless). 7,002 quoted lines, of which **~2,030 are main-board company lines** after dropping
  structured products (5-digit codes, `#`/`@` names), GEM (8000–8999), RMB counters, ETFs, REITs,
  bonds and suspended lines. The report carries no security-type column, so ETFs whose names do not say
  ETF (ISHARES A50 and friends) are removed by the statement fetch: an ETF has no company financials
  page, so it has no share count and never enters the dataset. Companies dropped this way are counted
  and named in `audit.dropped`, never silently ignored.
- **Why not the exchange's Excel list**: `ListOfSecurities.xlsx` is a 17 MB Power-Query *template* with
  zero data rows; the real list is fetched by Excel at open time. The daily report is the only complete
  keyless file the exchange publishes.
- **Sources**: HKEX report for the universe and the session tape; **Yahoo** (`query5` via `https.get` —
  undici's fingerprint is rejected) for five years of daily closes and the **Hang Seng Index**;
  **stockanalysis.com (HKG)** for statements, the diluted share count, the dividend per share, the
  English name/description and the GICS sector/industry; **open.er-api.com** for USD/HKD and USD/CNY.
- **Two currencies**: the listing is HKD, but a mainland or international issuer reports in **CNY or
  USD** (Alibaba CNY, HSBC USD). Every ratio is computed in the statement currency — the HKD market cap
  is converted at the build's rate — because a HKD cap over a CNY profit is not a P/E. The company page
  says which currency it used; `reportCurrency` rides in the list payload. With no FX snapshot a foreign
  reporter gets blanks, not a wrong number.
- **Shares**: `Shares Outstanding (Diluted)` (falling back to basic) from the income statement, which is
  already fetched — one request serves revenue, profit, EPS, dividend and the share count. The share
  count is a filing number; market cap is `price × diluted shares`, labelled as such.
- **Dividend yield**: dividend per share from the filing, converted into HKD, over the HKD price. There
  is no exchange-published per-stock yield table (TWSE has one), so this is the only honest source.
- **Build**: `npm run build:hongkong` — build → fetch English names/descriptions/sectors for every
  company → rebuild from cache. `--limit=30` is the smoke test; `--codes=0700,9988` builds named
  companies; `--skip-prices` / `--skip-fin` reuse the disk caches. Caches live in
  `data/cache/{hkex,hongkong-sa,hongkong-profiles}` and the build is resumable.
- **Output**: `data/hongkong.json` (records + reports + annual/period history),
  `data/hongkong-series/{00..79}.json` (daily last ~400 sessions + weekly 5y, keyed by code, bucketed
  by the **first two** digits — 2,000 companies over ten buckets would make one chart parse tens of
  megabytes), `data/hongkong-list.json` (the compact `/api/hongkong` payload),
  `data/hongkong-profiles.json`, `data/hongkong-themes.json`.
- **Server**: `/api/hongkong`, `/api/hongkong/company/{code}`, `/api/hongkong/chart?code=&range=`. The UI
  adds a fifth region button (`HONG KONG`) with MARKET / SCREENER / THEMES, a company page, the home
  screener tab, search (`hk:0700`), peers and compare. Hong Kong is in the cross-market peer index and
  in the currency list (`HKD`), because the ECB does publish a HKD reference rate.
- **Cross-listings**: stockanalysis serves no HKG statements for ~95 companies — the mainland H-shares
  (Ping An, CM Bank, CATL, Midea, WuXi AppTec, CMOC, CITIC Bank…) and HSBC. Their statements live on
  another listing of the same company: `scripts/resolve-hongkong-crosslist.mjs` searches by company
  name, keeps only a strong name match, and **fetches the candidate page to prove it carries
  statements** before writing `data/hongkong-crosslist.json` (HSBC → LON:HSBA; most H-shares → their
  SHA/SHE A-share, with the US OTC ADR as the fallback when the mainland pages are rate-limited). The
  build then fetches that listing's pages, records `statementsFrom`, and keeps the market cap at
  **HK price × total shares** — the exchange's own convention. A wrong match cannot leak numbers: every
  page is validated before it is parsed.
- **Limits**: no exchange P/E/P/B feed, so the market medians are computed from the covered set and the
  audit reports **coverage**, not a cross-check (an optional `--sample=N` compares a sample against
  stockanalysis's own overview). HKEX reports half-yearly for most issuers, so the period table is
  half-year/annual, not four quarters. Prices are HKD; a 5-year P/E band for a CNY reporter converts at
  the current rate (documented approximation). No free guidance feed, so no forward P/E.
- **Tests**: `tests/hongkong-derive.test.js` (HKD vs CNY ratios, missing FX, loss/negative-equity
  guards, bands) and `tests/hongkong-data.test.js` (cap = price × shares, ratio bounds, market totals,
  sector partition, index ordering, FX snapshot, list projection).
- **Built (2026-11-03, after the cross-list pass):** 1,805 companies · 1,802 descriptions · 0
  throttled · 255 listed lines without a statement page. HSI 23,525.97. P/B and ROE now use common
  equity (the shared engine change above), so Tencent's P/B is 2.69 rather than 2.89.

## Australia: every ASX-listed company (2026-11-02)
- **Universe**: the ASX **listed-companies CSV** (`asx.com.au/asx/research/ASXListedCompanies.csv`,
  keyless, UTF-8 with a BOM, two preamble lines). It carries the exchange short name, the
  three-character code and a GICS **industry group** (27 values). 93 rows are ETFs, listed investment
  companies or securitisation trusts and are filtered out by name and counted; the rest are companies.
- **Why Yahoo for prices**: ASX publishes no free all-stock daily close file. `{CODE}.AX` over
  `https.get` (undici is rejected) gives five years of split-adjusted daily closes; `^AXJO` is the
  S&P/ASX 200.
- **Sources**: ASX CSV for the universe/sector; **Yahoo** for prices and the index;
  **stockanalysis.com (ASX)** for annual statements, the rolling TTM view (`?p=trailing`), the diluted
  share count, the dividend per share, and the English name/description/GICS sector;
  **open.er-api.com** for one USD table (the AUD cross and every report-currency cross).
- **Two currencies, again**: the listing is AUD, but **BHP and RIO report in USD** (a few in EUR/GBP).
  Every ratio is computed in the statement currency with the AUD cap converted at the build's rate.
  The shared engine is **`scripts/derive-listing.mjs`** (`{ companies, fx, baseCurrency }`);
  `derive-hongkong.mjs` is now a thin wrapper, so there is one ratio engine, not two.
  A company with no FX rate for its report currency gets blanks, never a wrong number.
- **FX direction (fixed for both markets)**: `fx.rates` is the er-api USD table (units of X per USD).
  The **cap** needs *report currency per listing currency* = `rates[report] / rates[listing]`; the
  **dividend per share** needs the inverse. The first Hong Kong cut multiplied the cap by the inverse
  (HKD × HKD/CNY), which overstated a CNY reporter's P/E by ~20%. Both the derivation and the audit
  now use the two crosses explicitly (`perBase` / `perReport` in `derive-listing.mjs`), and the Hong
  Kong tests/audit were corrected with it.
- **TTM, not last FY**: the ASX statement tables have **no TTM column**. The vendor serves the rolling
  twelve months on the `?p=trailing` view (newest column first), so the build fetches the annual pages
  for the five-year record and the trailing income/balance pages for the current TTM and current equity.
  The company page's period table is therefore **TRAILING 12 MONTHS** (honest), not "reported periods":
  the vendor has no half-year actual table for this market. `peBasis` says `FY` when a company has no
  trailing page.
- **Sector rule**: the CSV's GICS industry group wins. `Not Applic` (300 rows) and `Class Pend` (20)
  are not sectors: the profile's GICS sector resolves them, then `Other`. `audit.notApplicSectors`,
  `audit.classPending` and `audit.resolvedFromProfile` count what happened; the raw group stays on the
  record as `gicsIndustryGroup`.
- **Build**: `npm run build:australia` — build → fetch English names/descriptions/profiles → rebuild
  from cache. `--limit=30` is the smoke test; `--codes=BHP,CBA,PLS` builds named companies;
  `--skip-prices` / `--skip-fin` reuse the disk caches; `--prices-only` warms Yahoo without touching
  the statement source (useful when stockanalysis is throttled). Caches:
  `data/cache/{asx,asx/yahoo,asx/profiles,australia-sa}`.
- **Output**: `data/australia.json`, `data/australia-series/{A..Z,0..9}.json` (one-character buckets,
  daily last ~400 sessions + weekly 5y), `data/australia-list.json`, `data/australia-profiles.json`,
  `data/australia-themes.json` (curated; the build filters tickers that do not exist).
- **Server**: `/api/australia`, `/api/australia/company/{code}`, `/api/australia/chart?code=&range=`.
  The UI adds a sixth region button (`AUSTRALIA`) with MARKET / SCREENER / THEMES, a company page,
  the home screener tab, search (`au:BHP`), peers and compare. `AUD` was already in `FX_CONV`.
- **Limits**: no exchange per-stock P/E/P/B (so the audit reports coverage, not a cross-check); no free
  guidance feed (no forward P/E); the market aggregates are computed from the covered set. Returns are
  AUD; a foreign reporter's five-year P/E band converts at the current rate (documented approximation).
- **Tests**: `tests/asx.test.js` (CSV/preamble/quoting, three-character codes, "Not Applic"/"Class
  Pend" fallback, fund-line filter, URL builders), `tests/australia-derive.test.js` (AUD vs USD vs EUR
  reporter, missing FX, loss/negative equity, bands, share of the HK engine) and
  `tests/australia-data.test.js` (cap = price × shares, ratio bounds, totals, sector partition, index,
  FX, list projection, audit counters). Plus the `au` entries in `filters.test.js` and three
  `/api/australia` tests (one asserts BHP is valued in USD).
- **Built (2026-11-03):** 1,664 companies · 549 P/E · 1,664 descriptions · 26 sectors resolved from
  the profile · 116 foreign reporters (USD 92, NZD 6, PGK 4, EUR 4, CAD 3, SGD 3, GBP 3, MYR 1) ·
  ASX 200 8,886.8 · **0 throttled** · 271 listed lines without a statement page (25 debt/treasury,
  50 foreign/NZ CDIs, 196 other — mostly operating small caps the vendor does not cover, and LICs not
  caught by the name filter) · 93 ETFs/funds/trusts filtered out by name (125 including the 27
  additional fund/LIC patterns). Total cap A$3.28T. `npm run audit:australia` is the repeatable check.
  The excluded lines are listed in `audit.noStatements`, not silently dropped.
- **Cross-listed lines**: RIO, RMD and AMC have no stockanalysis ASX financials page; they are CDIs or
  the Australian leg of a dual-listed group. The build reads the same company's primary US listing
  (`stocks/rio`, `stocks/rmd`, `stocks/amcr`) and scales the global diluted share count by the CDI
  ratio — RMD 10:1, AMC 1:1, RIO 1:1 — so market cap = ASX price × (filing shares × ratio). The
  company page says "NYSE statements" and the audit lists the mapping. The ratios reproduce and the
  P/E matches the vendor's own ASX page (RIO 13.8 vs 13.65, RMD 21.24 vs 21.20, AMC 20.27 vs 20.16).
- **Common equity, not total equity**: P/B and ROE divide by `Total Common Equity` (excluding
  non-controlling interests), because the market cap is the ordinary shareholders' claim. BHP's
  minority is ~10% of book but ~25% of earnings, so total equity understated its ROE (17.5% → 19.3%).
  The five-year record keeps total equity in `q` and adds common equity in `ec`; the page's ROE
  column uses `ec`. Hong Kong uses the same shared engine and was rebuilt the same way.
- **Fiscal-year P/E bands**: each historical P/E pairs the EPS with the price at that fiscal year end
  (`r.px` from the daily series), not the calendar year end. A June-year company no longer compares a
  December price with a June EPS.
- **Coverage note**: 33% of the market has a P/E. That is the market, not a bug: ASX has hundreds of
  pre-revenue explorers and loss-making small caps, and a loss-maker correctly has no P/E. 383
  companies have no vendor trailing table, so their ratios use the last fiscal year and `peBasis`
  says `FY`; the rest are TTM. P/B and ROE are populated for 92% of the covered set. The optional
  `--sample=N` audit now compares P/E against the vendor's own statistics page: 26/26 of the top 30
  (cross-listed lines skipped — they have two prices) are within 15%, and P/B/ROE differences are
  exactly the total-vs-common equity definition.

## Charts: one byte-range read per company, every market (2026-11-03)
- **The cost**: a single company chart parsed the market's whole history — 28 MB for Korea, up to
  7 MB for a Taiwan/Australia bucket, and (for Japan) the same 3 MB file again on every request.
  On the free instance the first chart of a market took seconds, and every deploy started cold.
- **The store**: `scripts/build-chart-store.mjs` writes `data/charts/<market>.ndjson` (one company
  per line, `{ k, p: [[dateIndex, close], ...] }`) plus `.idx.json` (`dates` once per market and a
  `code → [byteOffset, byteLength]` table). The server opens the file, reads only that line and
  parses a few KB. Aliases share one line: Tokyo `7203`/`72030`, Korea `005930`/`00126380`.
  Markets: `us jp kr tw hk au`; the six stores are committed like `korea-list.json`.
- **Fallback**: a missing store, or a code not in it (a new listing before the next build), falls
  back to the old reader. A stalled artifact degrades speed, never the chart.
- **Build**: each market build calls the store builder at the end, and the daily/weekly/Taiwan CI
  jobs `git add data/charts`, so a refresh cannot leave the store behind.
- **Frontend**: `coLong(ref)` now fetches ONE long series per company (deduplicated in flight) and
  `coSlice` cuts every window from it. A range click is a redraw, not a request; it was two requests
  per page open and one per range click. `coFitRange` steps down for a recent listing instead of
  drawing an empty frame.
- **Measured (local, cold process)**: every market chart 2–7 ms; USA/Japan/Korea/Taiwan/Hong
  Kong/Australia all serve one request on open and zero on a range click (headless Chrome check).
- **Tests**: `tests/charts.test.js` covers the pure merge/slice/expand logic and asserts the store
  exists and holds a known code in every market; `npm test` stays at 300.


## Free-tier memory: HK/AU company pages (2026-11-03)
- **Symptom**: browsing many Hong Kong or Australia companies gave 502s on the company chart and
  peers endpoints, and the page looked broken. The free Render instance has **512 MB**.
- **Cause**: (1) the warm loop warmed every COT series, all nine segment reads and the event pool,
  holding steady RSS at ~420 MB; (2) a company page parsed the whole 9 MB HK / 8 MB AU dataset to
  return one record (+50 MB each, and again on each process). Together they crossed 512 MB.
- **Fix**: the build writes one small JSON per company (`data/hongkong-companies`,
  `data/australia-companies`); `/api/{hongkong,australia}/company/{code}` reads that file (~2 ms,
  ~0 MB). The warm loop defaults to the light set (base feeds, brief, macro board, screener, Korea
  list); `WARM=full` restores positioning, the nine reads and the event pool. Korea's 28 MB statement
  file is no longer parsed at boot. Series bucket caches are capped at two per market.
- **Verified live** (build `3181e7a`): six HK/AU company pages opened in headless Chrome — all charts
  and 6 peers each, **0 failed requests, 0 console errors**; `/health` uptime did not reset.
- If more headroom is needed, the next levers are: `WARM=off` (cold feeds, ~200 MB), or moving the
  per-segment reads out of `cached()` so they can be reclaimed.

## Audit: Korea FY-basis P/E (2026-11-03)
- `audit:all` reported 8 Korea P/E failures (062040, 281820, 439260, 001500, 003610, …). Those
  companies have no four dated quarters (`peBasis: 'FY'`), so the headline P/E is cap ÷ last annual
  profit. The audit was recomputing from four undated/interim rows. It now uses the annual profit when
  `peBasis === 'FY'`; `audit:all` exits 0 with 0 failures (42 known warnings across US/JP/KR).

## Australia: trailing net profit, cash-flow ratios, and what a financial actually has (2026-11-03)
- **`netIncomeTTM` on every ASX company.** The shared `derive-listing.mjs` publishes the exact profit
  the P/E uses as `netIncomeTTM` + `netIncomeTTMAsOf`; when the vendor has no trailing page the latest
  fiscal year is used and `ttmFromFY: true` says so (only AMC today — a CDI whose statements come from
  the NYSE listing). It rides in `australia-list.json`, so a screen can read it without opening the
  company. Hong Kong gets the same fields at its next rebuild.
- **The page has the same statement block as Hong Kong and Japan**, not just a ratio strip:
  `REVENUE`, `OPERATING PROFIT`, `EPS`, `FREE CASH FLOW`, `TOTAL ASSETS`, `LIABILITIES`,
  `SHAREHOLDERS' EQUITY` and `OPERATING CASH FLOW`, all on the same period as the numbers above.
  The `NET PROFIT · TTM` tile (the US page's `NET INCOME · TTM`) sits beside net margin, in the
  statement currency (`A$10.9B` for CBA, `USD 9.8B` for BHP).
- **Cash-flow ratios, labelled by their own period.** `fcfMargin` (FCF ÷ revenue, capped at ±100%),
  `cashConversion` (FCF ÷ positive profit, capped at ±5×) and `fcfBasis` join the existing `fcf` and
  `fcfYield`. Income and cash can come from different vendor pages, so the FCF tiles say `FY2026` when
  the cash line is annual even though the profit is trailing (BHP). The screener gains an `FCF YLD`
  column, matching the US table.
- **Financials publish only the ratios that exist — the US/Japan rule.** All 129 financial-sector
  companies have `fcf`, `fcfYield`, `fcfMargin`, `cashConversion` withheld (a bank's cash flow is loans
  and deposits; an insurer's investing flow is the investment portfolio) and `naRatios` records it.
  Bank-like companies (`isBankLike()` in `scripts/asx.mjs`: `Banks`, `Financial Conglomerates`,
  `Consumer Finance`, `Mortgage Finance`, or a `Capital Markets`/`Credit Services` line with no
  operating-profit line) also lose `opMargin`. CBA's −A$88B "free cash flow" is no longer computed as a
  signal. **Insurers keep their operating margin** (QBE/SUN report one) but not free cash flow.
  The page omits those tiles, drops the OP PROFIT column from a bank's five-year/period tables (net
  profit and net margin replace it), and prints the reason.
- **Rebuild**: `node scripts/build-australia.mjs --skip-prices --skip-fin` re-derives from the committed
  statements (seconds). 1,664/1,664 companies carry `netIncomeTTM` (1,663 trailing, 1 flagged FY);
  129 financial-sector, 18 bank-like. `npm run audit:australia` passes: 0 formula mismatches, 0
  financials carrying an FCF ratio, 0 banks carrying an operating margin.
- **Verified headless**: CBA (bank) shows revenue/profit/EPS/assets but no op-profit or FCF line; BHP
  (USD reporter) shows all 12 ratio tiles and the full statement block with `FREE CASH FLOW · FY2026`;
  SUN (insurer) keeps the operating margin and loses FCF; the screener renders `FCF YLD`; **0 console
  errors**.
- **Tests**: `tests/asx.test.js` (bank vs insurer vs fee-based financial), `australia-derive.test.js`
  (`netIncomeTTM`, `fcfBasis`, `fcfMargin`, `cashConversion`, FY fallback), `australia-data.test.js`
  (every company's TTM profit is dated; financials carry no FCF ratio; banks carry no operating margin;
  a non-financial keeps its FCF ratios). Australia's own tests pass. The concurrent Hong Kong work in
  the same working tree still has two HK data assertions red (a stale 509% margin and an HSBC display
  name); this change does not touch those files.

## Charts: the S&P 500 from disk, and every company chart starts sooner (2026-11-03)
- **The S&P 500 chart was the only one still fetched live.** `/api/company-chart?ticker=^GSPC` missed
  the chart store (no key) and fell through to Yahoo on every 600 s cache expiry and every cold start —
  seconds on the free instance, and the single slowest chart on the site. `build-us-charts.mjs` now
  writes `^GSPC` (10y daily, compacted to daily ~400 sessions + weekly older) into the same committed
  `us-charts.json`, so the store serves it like a company. Measured locally: **357 ms → 3–6 ms**,
  21.6 KB instead of 73.7 KB, no upstream call. The daily CI refreshes it; a failed fetch keeps the
  committed series (`INDEX_SYMBOLS` is exempt from the company-pruning guard).
- **Company charts start while the filing loads.** Every company page awaited its detail record before
  it asked for prices — two sequential round trips. The page now calls `prefetchCoLong(ref)` at entry
  for US/JP/KR/TW/HK/AU; `coLong`/`jget` de-dupe the later in-flight call, so it is one request that
  overlaps the detail fetch. The US market render also prefetches the S&P 500 before it builds the
  sector table, rather than after the DOM is ready.
- **Chart responses are cacheable for ten minutes.** `sendChartJSON` sends
  `max-age=600, stale-while-revalidate=600` with the same ETag; the series only change on a build.
  Returning to a company no longer revalidates after 30 s. Applied to all six chart endpoints.
- **Verified headless**: S&P 500 one request, 3 ms, 5 KB transferred; AAPL 4 ms; BHP (Australia) 3 ms;
  all charts render, **0 console errors**.
- **Tests**: `tests/charts.test.js` asserts `^GSPC` is in the US store with > 100 points.

## Hong Kong/Australia audit: names, coverage, and the numbers (2026-11-03)
- **The HKEX 11-03 report was incomplete, not a smaller market.** The page had 7,305 quoted
  lines and omitted 147 live companies (Wing Tai Properties, Lee & Man Chemical, Bank of Guizhou,
  and 144 others) that the 11-02 report carried. `build-hongkong.mjs --daily=YYYY-MM-DD` now actually
  pins the report instead of only changing the label; the shipped Hong Kong build is the complete
  **2026-11-02** session. Prices are 11-02, the Hang Seng index is 11-03, and the market header says
  both.
- **Presentation markup was hiding quotations.** The 11-03 page wraps some lines as
  `</font></pre><pre><font size='1'>* 1810 XIAOMI-W ...`; `parseQuotations` matched only lines that
  began with whitespace, so Xiaomi and 155 other companies disappeared. The parser now strips tags
  before matching. `tests/hkex.test.js` pins the markup case.
- **Cross-list matches were wrong for three large issuers.** 1186 (China Railway Construction) was
  matched to China Construction Bank's OTC ADR; 1055 and 0670 (China Southern/Eastern Air) were
  matched to a publishing group and an engineering company. Their names, descriptions and statement
  sets are now taken from the correct A-share listings (`SHA:601186`, `SHA:600029`, `SHA:600115`).
  `audit:hongkong` now fails when a cross-list source name contradicts the exchange's own short name
  on "AIR" or "BANK".
- **Built (2026-11-03):** **1,908 companies** (up from 1,805) · 1,072 P/E · **1,908 descriptions** (all published rows have one) · 156 listed lines without a statement page, counted in `audit.dropped`
  · 0 throttled · HSI 83/84 held (the missing member is Link REIT, a trust the universe excludes) ·
  total cap HK$65.34T · median P/E 10.33 · P/B 0.74 · ROE 2.9% · yield 5.0%.
- **Small incomplete rows are no longer published.** Seven HK shells with no profile page at all
  (Dickson Concept, Dynamic Hold, Seven Elements, Realway Capital, FE Hotels, Walnut Capital,
  CH Castson 81 — all under HK$2.3B) are excluded and counted as `audit.incompleteSmall`; every one of
  the 1,908 published HK rows now has a description, sector and industry. The four chartless HK lines
  are large, fully filed companies (OmniVision, Anker, Joyson, Fibocom) whose H-share history has not
  accumulated in Yahoo yet, so they stay.
- **Names and summaries.** The profile extractor now strips the other listing's tag
  ("HSBC Holdings (LON:HSBA)" → "HSBC Holdings", "Ping An … (PNGAY)" → the company name) and uses the
  legal first clause when the title is truncated ("PetroChina Company" → "PetroChina Company
  Limited"; "smic" → "Semiconductor Manufacturing International Corporation"). The summary cutter
  stops on a sentence instead of a segment-list semicolon; **0 of 2,052 HK and 0 of 1,671 AU
  summaries end on `;`** (396 and 230 did before). The exchange short name is trimmed of trailing
  full stops ("ETHK LABS INC.").
- **Profile traps found by cross-checking the name against the paragraph.** GDI Property Group's
  stockanalysis page had the right title and the wrong body (Gaming and Leisure Properties, a US
  casino REIT); it now carries the Australian REIT description and `REIT - Office` industry. Three
  renamed issuers (HK.AI Capital, Harbour Digital Asset Capital, Navigator Global Investments) still
  described themselves by their former legal names; those paragraphs were updated to the current
  name without touching the numbers.
- **Numbers that are not a valuation are withheld.** A P/E below 0.5× (a debt-restructuring write-back
  gave Shimao 0.02×) and an operating/net margin beyond ±500% (pre-revenue explorers and
  associate-income holdcos printed up to 197,941%) are now blank rather than published. HK P/E
  coverage is 1,072/1,908; the audit still reproduces every published ratio from its inputs with 0
  mismatches.
- **Australia:** 1,664 companies · 539 P/E after the same guard · **1,664/1,664 descriptions** · 271
  listed lines without a statement page (25 debt/treasury, 50 foreign/NZ CDIs, 196 uncovered small
  caps) · 0 throttled · 116 foreign reporters · total cap A$3.28T. Every exchange short name is free
  of its trailing full stop (82 before). The curated themes were corrected: ALD (Ampol, energy) was
  in the miners list and is now LTR (Liontown); ALK (Alkane, gold) was in consumer and is now SUL
  (Super Retail); the consumer and tech notes now name the companies actually in the list.
- **Search:** multi-word queries now match across the profile name, ticker and exchange short name —
  "shk properties" finds `hk:0016`, "china railway construction" finds `hk:1186`. The index only
  rebuilds when the server restarts, so a data refresh needs a restart (production deploys do).
- **UI:** the market header states the HKEX session, the price session and the index date separately;
  Australia does the same with ISO dates. P/E tiles and screener notes say whether the number is TTM
  or the last fiscal year instead of claiming TTM for the 313 HK / 383 AU companies that fall back.
  "HK$ HKD" / "A$ AUD" in the subtitle became "prices in HKD/AUD".
- **Tests:** `npm test` at **319** (new: markup-wrapped quotation, profile name/summary helpers,
  multi-word search, name/description invariants, margin/P/E guards). `npm run audit:hongkong` and
  `audit:australia` both pass all hard invariants; `audit:all` remains 0 failures. Four newly listed
  HK lines (OmniVision 0501, Anker 0668, Joyson 0699, Fibocom 0638) have no Yahoo history yet, so
  they have a company page and price but no chart — the store is honest rather than inventing a line.

## Australia and Hong Kong now refresh daily (2026-11-04)
- **The gap.** Only US/Japan/Korea (`companies-daily`), Taiwan (`taiwan-daily`) and US filings
  (`filings-watch`) were scheduled. Hong Kong and Australia had **no cron at all**: their prices,
  statements and chart stores only moved when someone ran `npm run build:hongkong` /
  `build:australia` by hand, and both were already a session or two behind. Nothing watched them
  either — `check-freshness` only knew about the other four markets, so they could drift for weeks
  without an issue being opened.
- **New `.github/workflows/australia-daily.yml`** — `10 10 * * 1-5` (20:10–21:10 Sydney), after the
  16:00 close *and* after the ASX regenerates its listed-companies CSV. Runs
  `npm run refresh:australia` (build → fetch the profiles still missing → rebuild from cache), then
  `audit-market-refresh au`, `audit:australia`, and commits `data/australia*.json`,
  `australia-series/`, `australia-companies/` and `data/charts`.
- **New `.github/workflows/hongkong-daily.yml`** — `10 12 * * 1-5` (20:10 HKT), after HKEX posts the
  daily quotation report. The HSI list step is **non-fatal** (it reads a public wiki table; a hiccup
  there must not block a price refresh). Then `npm run refresh:hongkong`,
  `audit-market-refresh hk`, `audit:hongkong`, and commits `data/hongkong*.json`,
  `hongkong-series/`, `hongkong-companies/`, `data/hongkong-hsi.json` and `data/charts`.
- **`--fresh-report` is new on `build-hongkong.mjs`.** Plain `--fresh` refetches *every* statement page
  (a cold crawl). The scheduled job wants a fresh exchange report with the statement and price caches
  intact, so the new flag passes `{ fresh: true }` to `latestDaily` and nothing else.
- **New guard `scripts/audit-market-refresh.mjs au|hk`** — the `audit-taiwan-refresh` idea, generalised.
  The build writes before the job commits, so a rate-limited run would publish a smaller market that
  still looked current. It compares the new file with `HEAD` and refuses to publish when companies fall
  below 97% (AU) or 98% (HK), when priced names or 6M/1Y history collapse, when P/E coverage drops
  15%, when `audit.throttled > 0`, when the latest price session moves backwards, when total cap falls
  30%, or when the HKEX session goes backwards. Exit 1 means nothing was staged.
- **New filings.** There is still no HKEX/ASX announcement watcher (EDGAR has one; these two do not), so
  the statement cache TTL is what drives it: the current-period page is refetched daily (`TTL_Q`) and
  the annual record every 7 days (`TTL_FIN`). A half-year result reaches the ratios within a day and
  the five-year record within a week. A filing feed is the next step if same-day is required.
- **Freshness.** `check-freshness` now watches both files at **84h**, not 36h: these jobs skip the
  weekend, so a Friday build read on Monday afternoon is already 72h old, and a holiday Monday pushes
  it later. 84h catches a failed Tuesday run without crying wolf every Monday.
- **Caches.** `data/cache/{asx,australia-sa}` and `data/cache/{hkex,hongkong-sa,hongkong-profiles}`,
  keyed by run id with a prefix restore — the same pattern Taiwan uses. A cache miss is survivable by
  design: a cold HK run is ~9,500 statement pages and a cold AU run ~6,600, both well inside the
  240-minute timeout. It is slower, not broken.
- **Runtime.** Warm, the daily statement cost is only the expired tail (annual pages at 1/7 of the
  market, current-period pages daily) plus every Yahoo series: roughly 30–60 minutes per market.
- **Verified locally:** `audit-market-refresh` passes on both current files and fails as intended on a
  simulated throttled build (1,200 companies, no 6M history, 12 throttled); `npm test` 322 green; both
  workflow files parse and their crons read back correctly; the newest HKEX report (2026-11-03, 2,062
  main-board companies) resolves through `--fresh-report`. **Not pushed yet**, so CI has not run them.

## Load: the first search no longer parses Japan, lists cache, peers overlap the chart (2026-11-04)
- **The first search or peer lookup parsed `japan.json` (5.5 MB).** `searchIndex()` and `peerIndex()`
  read the source to get names, sectors and caps — even on a US company page — and that synchronous
  build (~48 ms and ~50 MB of objects locally, several times that on the free instance) ran on the
  event loop in front of the company chart request. `data/japan-list.json` (682 KB, the same
  `projectJp` payload `/api/japan` returns, written by `build-japan.mjs` **after** descriptions and
  themes attach) is now the source for `/api/japan`, search and peers; a missing or stale artifact
  falls back to the old projection. First peer lookup **48 → 26 ms**; `/api/japan` **43 → 19 ms**
  cold, 7 ms warm. US caps for the peer buckets now convert JPY by `fx.rate` instead of carrying a
  second `marketCapUsd` field.
- **Market lists cache for five minutes.** `sendListJSON` (`max-age=300, stale-while-revalidate=300`,
  same ETag) serves `/api/companies`, `/api/japan`, `/api/korea`, `/api/taiwan`, `/api/hongkong`,
  `/api/australia`, `/api/search` and `/api/peers`. They revalidated after 30 s, which on a phone is a
  round trip for a 700 KB payload that changes once a day.
- **The compressed-body cache no longer flushes wholesale.** Browsing company charts used to push it
  past 60 entries and `clear()` it, throwing away the pre-encoded Hong Kong/Australia lists; it now
  evicts the oldest quarter at 240.
- **The peer strip starts with the chart.** Each company page prefetches `/api/peers` at entry, right
  after the chart series, so filing detail / prices / peers overlap instead of running in sequence
  (the peer index used to build while the chart waited).
- **Verified headless**: AAPL page chart 5 ms, peers 27 ms, 6 peers rendered, 0 console errors.
  `npm test` 322/322. Cold RSS after a US-only peer lookup +44 MB (the HK/AU lists and the index),
  which those pages need anyway; cold start on the free instance is still infrastructure.

## Company data accuracy: FCF, yield, current shares, staleness (2026-11-04)
- **FCF is now CFO − capex.** The shared engine (`scripts/derive-listing.mjs`) used `CFO + CFI`, which
  charged acquisitions and purchases of investments as if they were maintenance capex. The vendor's
  own `Free Cash Flow` row is exactly CFO − capex on **2,006/2,006 Hong Kong** and **1,354/1,354
  Australian** cached pages, so it is now the first source; the line items are the fallback and
  CFO + CFI is the last resort. Tencent 97.8B → **168.3B HKD**; BHP 9.77B → **11.52B**; XRO −3.39B →
  **+0.92B** (a sign flip). `fcfYield`, `fcfMargin` and `cashConversion` inherit the fix, and the
  company-page FCF tile now prints `c.fcf` instead of recomputing CFO + CFI client-side.
- **Dividend yield uses the latest annual DPS.** The vendor's trailing column is not a trailing-twelve-
  month dividend for every issuer: NAB printed **3.40** against a **1.70** annual, doubling the yield
  to **8.31%** versus the vendor's **4.15%**. `dividendYieldBasis` says `FY`/`TTM`; the audit checks
  the annual basis, not the old trailing figure against itself.
- **Market cap uses current shares.** `scripts/fetch-listing-shares.mjs` reads the vendor statistics
  page's current count into `data/{market}-shares.json`; the build sets `sharesCurrent`, the derive uses
  it for cap and keeps the diluted filing count for EPS. The 30-name audit sample had 8 ASX names >5%
  off current (ECT **+55%**, KAL **+43%**, RGT **+35%**); the old cap was stale. Cross-listed CDIs keep
  the filing count because the ASX price is per CDI. `sharesBasis` says `current (vendor)` or the CDI
  note.
- **Stale statements are excluded.** 450 days catches the Hong Kong 2014 shell (2476 VGT) and the nine
  delinquent June-2025 ASX names; `audit.stale`/`staleCodes` list them. September year-ends stay,
  because their next report is not due yet.
- **The Hong Kong audit cross-check works again.** It read `/financials/` looking for a `>PE Ratio</td>`
  table that no longer exists, so it compared **0/0**. It now reads `/statistics/` and compares P/E,
  P/B, ROE, yield and current shares; the Australia sample gains yield and share-count checks.
- **Tests**: derive tests for vendor-FCF precedence, annual DPS, current-share cap and cross-listing
  notes; data tests for vendor FCF, annual yield, current-share cap and the 450-day rule.
- **Growth metrics, same engine as the US/Japan.** `src/growth.js` now feeds the HK/AU shared engine and
  the Korea derive: revenue CAGR, EPS CAGR (split-adjusted from the average share count), `cagrYears`,
  `cagrNA`/`epsCagrNA`, `epsChange` when an end is a loss, and `marginDelta`. The HK/AU company pages
  show REVENUE CAGR / EPS GROWTH / NET MARGIN CHANGE; the HK/AU/Korea screeners gained a REV CAGR
  column. `data/{market}-list.json` projects the fields. BHP −2.5% revenue / −25% EPS over 4y; Tencent
  7.6% / 1.1%; Samsung 4.5% / 3.4%.
- **Rebuild (2026-11-04, final)**: Australia **1,650** companies (9 stale + 3 no-price + 3
  no-share-source excluded) · 537 P/E · A$3.25T · median P/E 15.97 / P/B 1.54 / ROE −9.4% / yield
  4.23%. Hong Kong **1,930** companies (4 no-share-source excluded; 0 stale) · 1,102 P/E · HK$64.88T ·
  median P/E 10.36 / P/B 0.75 / ROE 3.0% / yield 5.2%. Current share counts **1,650/1,650 AU** and
  **1,930/1,930 HK** (27 HK from the SEC cover). `npm test` **376/376**; `audit:australia`,
  `audit:hongkong`, `audit-market-refresh` and `audit-markets` pass.
- **Vendor yields.** The statistics page already carries the vendor's own yield, converted at the
  payment-date FX. `fetch-listing-shares.mjs` now stores it; `dividendYieldBasis: 'vendor'` marks it,
  and the filed annual DPS is the fallback. BHP 4.33% → **4.86%**, Tencent 1.43% → **1.33%**, 1184
  9.28% → **6.04%**; the AU/HK sample yield differences are now **0**.
- **Total-equity reconciliation.** `pbTotal`, `roeTotal`, `roeFY` and `roePriorFY` are published beside
  the common-equity `pb`/`roe`. The audit compares the vendor on total equity and treats a match to the
  prior fiscal year as a period difference, so the old “common vs total equity” warnings are gone
  (except BHP's vendor figure above).
- **Cross-listing current shares.** HK lines with no HKG statistics page fall back to their A-share /
  LON / OTC page; AU CDIs use the US page × the CDI ratio (RIO 1:1, RMD 10:1, AMC 1:1). `sharesBasis`
  labels the source, e.g. `current (us:RMD) × 10` or `current (sha:601318)`.
- **SEC cover shares for ADRs.** `scripts/fetch-sec-shares.mjs` + `data/hk-adr-map.json`: for a Hong
  Kong secondary/ADR listing whose HKG statistics page says `n/a`, read the latest 20-F/10-K/10-Q cover
  (Class A+B summed; `Indicate the number...` or `based on X ordinary shares`), and validate with the
  US market cap so an ADS count is not mistaken for ordinary. **27 counts stored** — BABA 18.58B,
  JD 2.732B, LU 1.733B (fixes a 10× understatement), GDS 1.603B, XPEV 1.910B, BIDU 2.722B, QFIN/NOAH,
  etc. The four without a defensible count are **excluded from the market**: BeOne/Zai Lab (the 10-Q
  cover is not the primary document), Hesai (the SEC cover is ADS), CFMEE (no SEC filing).
  `build:hongkong` / `refresh:hongkong` run `shares:sec` automatically, so the counts refresh with
  each 20-F/10-Q.
- **Korea TTM sanity.** A four-quarter window more than 2.5× the annual net income (or twice its
  revenue) is treated as cumulative/misfiled and the fiscal year is used instead, flagged
  `ttmSuspicious`. Samsung's P/E moves 8.55 → **28.52** and ROE 34.5% → **10.4%**; 170 companies were
  corrected. `scripts/rederive-korea.mjs` also rewrites `korea-list.json` and the detail files, and
  recomputes the market aggregates.

## US, Japan, Korea: the same failure classes (2026-11-04)
- **US book equity is refreshed from the latest 10-Q/10-K instant.** `scripts/refresh-us-equity.mjs`
  reads the committed SEC company-facts cache (no new requests), matches parent equity (subtracting
  minority interest), and updates `equity`/`equityEnd`/`equityForm`; `derive-companies.mjs` then
  recomputes P/B and ROE. **435 values updated**; companies whose equity is >180 days behind the TTM
  profit fell from **413 to 49** (the 49 have no newer XBRL instant in the cache). MSFT/AMZN/GOOGL/META
  now use 2026-06/09 book value instead of FY2025.
- **US growth now uses the shared split-aware `growthRates`.** Per-year shares are implied by
  `netIncome ÷ EPS`; a split is restated, and two guards withhold the EPS CAGR when the series cannot
  be reconciled to today's share count (`EPS/share-count series is inconsistent`) or when EPS growth
  is >30pp away from net-income growth. NVDA's **131.7%** (built on a 2022 row implying 57.4B shares
  against 24.5B today) is now blank; JNJ/NFLX 48.5%/113.8% false positives are blank too.
- **Korea uses the newest quarterly balance sheet for P/B and ROE.** `deriveKorea` picks the latest
  report with positive equity (q1/h1/q3), not the last annual. Samsung: FY2025 equity ₩436T → H1 2026
  ₩579T, **P/B 2.95 → 2.23, ROE 10.4% → 7.8%**. `equityAsOf` is on the record and in the tooltip.
- **Korea excludes 21 stale reporters.** Companies whose newest report is >450 days old (some 2021/22)
  are out of the market (746 → **725**) and listed in `audit.staleCodes`. `build-korea` and
  `rederive-korea` both enforce it; `naverCap` is refreshed from the Naver feed before re-deriving.
- **FCF naming.** Japan already labelled the page **CASH AFTER INVESTING**; Korea now does too, with
  **CASH YIELD** instead of “FCF YIELD” and a `fcfBasis: 'CFO+CFI'` on both. The US FCF remains
  standard **CFO − capex**.
- **Verified**: `npm test` **382/382**; `audit-calculations` 0 mismatches; `audit-markets` **0
  failures** (Korea P/B now compares to the latest equity; Naver caps refreshed); `audit-deep` has one
  residual PG equity-vs-series note (2%, a restatement-period difference, not a formula failure).

## India: the NIFTY 500 (2026-11-05)
- **Universe**: the NIFTY 500 constituent CSV from niftyindices.com — company name, NSE industry, symbol,
  trading series, ISIN. 501 rows, 3 of them REIT/InvIT units (series `RR`) and excluded by the same
  ordinary-line rule that keeps an ETF out of the ASX set; **498 companies**. No sector free-text to
  resolve, unlike Australia: the NSE industry (20 macro sectors) is the sector.
- **Sources**: niftyindices CSV for the universe; **Yahoo** (`{SYMBOL}.NS`, `^NSEI` for the NIFTY 50) for
  five years of split-adjusted closes; **stockanalysis.com (NSE)** for statements with a TTM column, the
  diluted share count, the dividend per share and the profile; **open.er-api.com** for USD/INR.
- **Two symbol traps.** NSE symbols carry `&` and `-` (`M&M`, `BAJAJ-AUTO`, `J&KBANK`). stockanalysis
  spells both as `_` in the slug (`M_M`), Yahoo wants the raw symbol percent-encoded (`M%26M.NS`). A naive
  `encodeURIComponent` on the slug is a 404 on exactly the names an analyst types.
- **A field-name collision worth remembering.** The CSV's trading series is called `Series`; assigning it
  to `c.series` made every company look like it had a two-point price history ("498 symbols with a
  history · 12 priced") and crashed the returns loop on `"EQ"`. It is stored as `seriesCode`.
- **Two USD reporters.** Infosys and HCL Tech serve **USD** statements on their NSE page (the ADR/IFRS
  filing), so their ratios are computed in USD with the rupee cap converted — the same rule as BHP/RIO.
  The audit and the data test convert the cap before checking a ratio, or a correct P/E of 14.7 reads as
  1,390 (USD/INR ≈ 94.8).
- **Bank rule, by GICS industry.** The NSE macro sector "Financial Services" holds banks, NBFCs, housing
  finance, insurers, AMCs, brokers and the exchanges. `isBankLike` reads the profile's GICS industry:
  26 regional banks + 24 credit services + 9 mortgage finance + 2 conglomerates are bank-like (no
  operating margin, no free cash flow); 11 insurers and the AMCs keep their margin and lose FCF, exactly
  as the US/Japan/HK/AU pages do. **59 bank-like / 96 financials.**
- **A trailing column that is not trailing.** Three names (Bajaj Holdings, MMTC, Vedanta Oil & Gas) report
  a TTM profit or operating profit more than 3× revenue — the vendor spliced two periods for a fresh
  demerger / a holdco / a trader. Every ratio on that column is fiction (VOGL's P/B was 0.00), so they are
  excluded and named in `audit.brokenCodes`, never published.
- **Build**: `npm run build:india` — build → fetch profiles → rebuild from cache. `--limit=30` is the smoke
  test; `--codes=RELIANCE,TCS` builds named companies; `--skip-prices` / `--skip-fin` reuse the caches;
  `--prices-only` warms Yahoo. Caches: `data/cache/nse/{yahoo,profiles}` and `data/cache/india-sa`.
- **Output**: `data/india.json`, `data/india-series/{A..Z,0..9}.json` (one-character buckets), `data/india-
  list.json`, `data/india-companies/`, `data/india-profiles.json`, `data/india-brands.json`,
  `data/india-themes.json` (12 curated lists).
- **Server**: `/api/india`, `/api/india/company/{code}`, `/api/india/chart?code=&range=`. The UI adds a
  seventh region button (`INDIA`) with MARKET / SCREENER / THEMES, the home screener row, a company page,
  search (`in:M&M`), peers and compare. `INR` is in the FX table.
- **Built (2026-11-05):** **494 companies** · 473 P/E · 489 P/B · 491 ROE · 494 descriptions · 20 sectors ·
  59 bank-like / 96 financials · 2 USD reporters · 0 throttled · 3 excluded for an inconsistent trailing
  column · total cap ₹412.8T · median P/E 33.1 · P/B 4.33 · ROE 13.9% · NIFTY 50 23,961.
  `npm run audit:india` passes all hard invariants (cap = price × shares, every ratio reproduces from its
  own inputs, no bank with an operating margin, no financial with FCF, totals tie, sector partition covers
  the market).
- **Tests**: `tests/nse.test.js` (BOM/quotes, ordinary-line filter, `&`/`-` slugs, Yahoo encoding, bank vs
  insurer) and `tests/india-data.test.js` (cap, ratio reproduction with the USD cross, bank rules, totals,
  index, list projection). `npm test` at 415.
- **Current share counts.** The filing's diluted count is a period weighted average; a split or a
  placement leaves the cap stale (Lodha's was 49% too high, GMR Airports' 36%). `fetch-listing-shares.mjs
  india` writes `data/india-shares.json`: 352 companies get the vendor's current count, 142 (the vendor
  prints "n/a") get `vendor market cap ÷ price`, and every cap now matches the vendor's headline within
  10%. Shriram Finance is the one name where the vendor's page contradicts itself after a 5:1 split —
  its cap implies ~2.3B shares, its P/E implies ~3.8B; we follow the cap and the audit reports the P/E
  difference rather than hiding it.
- **Schedule**: `.github/workflows/india-daily.yml`, 10:40 UTC Mon–Fri (16:10 IST), with the statement
  cache, `merge-history in`, `merge-series in`, the collapse guard and `audit:india` before the commit.
  `check-freshness` watches `india.json` at 84h.

## Indonesia: the IDX (2026-11-07)

- **The exchange blocks us.** `idx.co.id` answers a Cloudflare **403 "Sorry, you have been blocked"** on
  every path — the JSON APIs (`/primary/...`), the static PDFs and the HTML pages — from both this Mac and
  the cloud, and headless Chrome gets the same page because it is an IP/WAF rule, not a JS challenge. So
  the universe is read from the same keyless vendor as the statements: **stockanalysis.com's Indonesia
  exchange list** (`/list/indonesia-stock-exchange/`, 500 rows per page).
- **Universe**: **915 rows → 912 companies**. Three are not companies and are named/excluded rather than
  fetched: `XSPI` and `XCIS` (listed REITs) and `XBGS` (a gold equity fund). `data/indonesia-universe.json`
  is the committed snapshot the build falls back to if the vendor is briefly throttled; the daily job
  re-reads the live list so new listings flow in. IDX codes are exactly four characters, so no padding or
  symbol traps.
- **Sources**: the vendor list for the universe; **Yahoo** (`{TICKER}.JK`, `^JKSE` for the IDX Composite)
  for five years of daily closes; **stockanalysis.com (IDX)** for annual/quarterly statements with a TTM
  column, the diluted share count, the dividend per share, the GICS sector/industry and the profile;
  **open.er-api.com** for USD/IDR.
- **Sectors**: the exchange list has no industry column, so the eleven **GICS sectors come from the vendor
  profile** (`sectorSource: 'profile-gics-sector'`). A failed profile keeps "Other" and is counted, never
  guessed.
- **Banks vs insurers**: `Financials` is the sector; the industry splits lenders from insurers. Banks,
  multi-finance and securities houses are `bankLike` (no operating margin, no FCF); insurers keep the
  margin and lose FCF — the same rule as US/JP/HK/AU/IN.
- **Report currency**: default IDR, but a few issuers report in USD. The build records `reportCurrency` and
  `derive-listing` converts the rupiah cap before dividing by a dollar profit; the audit repeats the cross.
- **A trailing column that is not trailing**: the same guard as India — an operating profit above its own
  revenue is two periods spliced together, so the company is excluded and named in `audit.brokenCodes`.
- **Dividend yield**: the vendor statistics page (already fetched for the share count) supplies the
  primary yield, with the income statement's Dividend Per Share as the fallback and `dividendYieldBasis`
  labelling which. Coverage is **442/810** (441 from the vendor page). Banks often print no DPS row, so
  BBNI (11.0%), BYAN (3.36%) and TPIA (0.46%) were blank before this; they are now populated without a
  currency guess. A blank tile now says "No dividend declared or published by the vendor" rather than
  implying a missing number.
- **High Shareholding Concentration (HSC)**: `data/indonesia-hsc.json` pins IDX's official **22 October
  2026 list of 82 companies** (sourced from Kontan/IDX; idx.co.id's own page is a Cloudflare challenge
  here). Since 2 November 2026 HSC stocks are also excluded from the IHSG, not just LQ45/IDX30/IDX80.
  The build attaches `c.hsc {asOf, source, rank}`, the list projection carries it, the market view shows a
  warning, the screener has an **HSC FLAGGED** preset and a badge, and the company page shows a banner.
  The audit reports `hscTotal / hscPruned / hscMissing` and warns when the snapshot is more than **120 days**
  old — IDX reviews quarterly, so replace the file on the next review. **Do not use the vendor's Float as
  a proxy**: it does not reproduce the official list (BREN reads 87% vs the official 97%).
- **Stale statements**: seven companies (BEBS, ZBRA, TELE, IPPE, SOUL, ALTO, TOPS) shipped a statement
  older than 450 days and are excluded by the build (`audit.stale`), the same rule Hong Kong and Australia
  use; the audit fails if one reappears. The published market is therefore **905 companies** before the reviewed prune (see below).
- **Build**: `npm run build:indonesia` — build → fetch profiles → rebuild from cache. `--limit=30` is the
  smoke test; `--codes=BBCA,TLKM` builds named companies; `--skip-prices` / `--skip-fin` reuse the caches;
  `--prices-only` warms Yahoo. Caches: `data/cache/idx/{yahoo,profiles}` and `data/cache/indonesia-sa`.
- **Output**: `data/indonesia.json`, `data/indonesia-series/{A..Z,0..9}.json` (one-character buckets),
  `data/indonesia-list.json`, `data/indonesia-companies/`, `data/indonesia-profiles.json`,
  `data/indonesia-brands.json`, `data/indonesia-themes.json` (10 curated lists), `data/indonesia-universe.json`.
- **Server**: `/api/indonesia`, `/api/indonesia/company/{code}`, `/api/indonesia/chart?code=&range=`. The
  UI adds an eighth region button (`INDONESIA`) with MARKET / SCREENER / THEMES, the home screener row, a
  company page, search (`id:BBCA`), peers and compare. Market accent `#b03a48`.
- **Curated prune (2026-11-07, two rounds)**: `data/indonesia-prune.json` removes **95** small, data-unclear
  lines. Round 1: 45 with negative equity, an extreme P/E, no TTM, a 402-day TTM or the SAGE share-count
  gap. Round 2: 35 unclean nano-caps (< Rp 100B; loss-making, frozen or thin), 8 shell-like lines
  (revenue under Rp 10B and a loss, Rp 100–250B) and 7 frozen prices (≥90% unchanged in 250 sessions,
  Rp 100B–1T). WSBP (Waskita Beton Precast) and CMPP (AirAsia Indonesia) were on the review list and
  deliberately kept. The build excludes the codes, `audit.pruned`/`prunedCodes` records them, and the
  audit fails if one re-enters the market without review. Published market: **810 companies**; total cap
  Rp 8,605T. The prune is reversible: delete a code from the file and rebuild. The six large frozen
  names (SUPR, MKNT, FASW, PLIN, WIKA, SMCB) are deliberately kept — they need a 'no recent trading'
  warning, not removal.
- **Trading quality (2026-11-07)**: the build flags a frozen price (>=90% unchanged over 250 sessions;
  **6**: SUPR, MKNT, FASW, PLIN, WIKA, SMCB), a short history (<100 sessions; **6**: JECX, RANS, BACH,
  EMMI, JELI, PRDL), a TTM older than 365 days (**2**: BHAT, SFAN) and thin turnover (< Rp 100M/day;
  **144**). Frozen names get no 1D/6M/YTD return (null, not a fake 0%), a red market warning, a company
  banner and a **NO RECENT TRADING** preset; thin names get a **THIN TRADING** preset and a banner. The
  build also stores the 30-session average traded value from Yahoo volume.
- **Prune review**: `npm run review:indonesia:prune` re-reads the 95 pruned codes and re-tests the reason
  each was removed. A data-quality reason that no longer holds is reported as a reinstatement candidate;
  size/liquidity removals stay a policy decision. Run it quarterly with the HSC refresh.
- **Statement basis**: the vendor does not label consolidated vs standalone, so the company page says the
  ratios use the one statement set it serves. This is a documented limitation, not a hidden assumption.
- **Deep audit**: `npm run audit:indonesia:deep` re-runs the ratio engine on the stored inputs and compares
  **every** published field (29,215 engine comparisons), then independently recomputes cap, P/E, P/B, ROE,
  growth, dividend yield, returns, the index, market aggregates, the list projection and the HSC/stale/theme
  counters — ~40k checks. It is wired into `indonesia-daily.yml` after the standard audit, so engine drift
  is caught on the next run rather than by inspection.
- **Audit**: `npm run audit:indonesia` checks cap = price × shares, every ratio against its own inputs
  (with the USD cross), no bank with an operating margin, no financial with FCF, totals tie, the sector
  partition covers the market, the index is dated/ordered, and — new for this market — the vendor's own
  headline cap is compared with ours (`audit.vendorCap`, a stale share count is reported, not hidden).
- **Cross-check**: Google Finance serves IDX statements and agrees with the vendor on BBCA's TTM net
  income to 0.02% (59.35T vs 59.36T); use it for a spot-check, not a bulk source.
- **Schedule**: `.github/workflows/indonesia-daily.yml`, 09:40 UTC Mon–Fri (16:40 WIB, after the IDX
  close), with the statement cache, `merge-history id`, `merge-series id`, the collapse guard
  (`audit-market-refresh.mjs id`) and `audit:indonesia` before the commit. `check-freshness` watches
  `indonesia.json` at 84h.
- **Yahoo from this Mac is 429.** The first full build must run in GitHub Actions (a different egress);
  the local IP is rate-limited to `Too Many Requests` on every chart/download endpoint. The workflow
  caches statements, so a warm run is minutes and a cold run is a couple of hours.
- **No forward P/E, no free guidance feed**; the five-year record is the fiscal year and the trailing
  column is labelled TTM or FY on the company page.

## US companies: S&P 500 → S&P 1500 (2026-11-07)

The US COMPANIES tab was the narrowest of the eight markets — 503 S&P 500 securities while Japan
covers 1,547 TSE Prime names, Korea all KOSPI, Taiwan all TWSE, Hong Kong the main board, the ASX
1,650 and the IDX 912. The broad dataset already existed: `build-companies-frames.mjs` writes
five-year financials for **8,328 SEC filers**, so the S&P 500 was a *filter*, not a rebuild.

- **Universe**: S&P 1500, membership from **SPTM** (SPDR Portfolio S&P 1500 Composite) holdings — one
  State Street file with the composite float-adjusted weights, so there is no SPY+MDY+SPSM
  concatenation problem. **1,506 securities / 1,500 companies, 0 absent.**
- **Six extra securities are second share classes** (GOOG, FOX, NWS, UA, CENTA, RUSHB), cloned from
  the sibling's filings with their own Nasdaq price/cap, marked `shareClass` and excluded from totals.
- **New scripts**: `us-universe.mjs` (shared SPTM parser, SEC ticker map, no-filing reason),
  `filter-us-universe.mjs` (replaces `filter-sp500.mjs`) and `complete-us-universe.mjs` (replaces
  `add-share-classes.mjs`). The old filenames are thin aliases, so an existing command still works.
- **The weekly CI now restores the frames build.** It used to run only `filter-sp500.mjs` against the
  committed 500-row file, so swapping the holdings source alone would have found nothing new. The job
  now runs `build-companies-frames` → `filter-us-universe` → `fill-sic` → Nasdaq → `complete` →
  weights → the existing fundamentals/description/valuation passes.
- **Same bar for every new name**: ticker, CIK, sector, price and market cap on every row (the
  universe audit is **0 issues**); SIC for peers and bank detection; a 10-K description or a Nasdaq
  profile; the same calculation, reconciliation, arbitration and deep audits. Weights sum to
  **99.729%** (the equity portion of SPTM; cash and the futures overlay are not constituents).
- **Dual-class coverage**: the frames build picks one class per CIK, so the filter now lets a row
  follow its CIK onto the index ticker (UA/UAA, BRK-A/BRK-B) instead of dropping five years of
  filings; `complete` clones the remaining classes. This is why GOOG/FOX/NWS are not "missing".
- **Four index members have no SEC XBRL** and are published as labelled `noFilings` rows, never
  guessed: **OZK** and **PFBC** file their annual report with the FDIC under the bank exemption
  (EDGAR has no 10-K), **VYLR** has a Form 10 but no 10-K yet, **MSGR** has quarterly reports only.
  Each company page states the reason; the screener badges them `NO FILINGS`.
- **Parser gotchas fixed**: SPTM's cash/money-market rows carry no ticker; the futures overlay
  (`ESZ6`) has a negative weight; Pathward Financial's ticker is literally `CASH` (cash is never
  filtered by ticker text); a restructured issuer can appear twice (NAVI) and is de-duplicated.
- **Audit threshold**: the cap-vs-weight check moved from 10× to 50× because float-adjusted small
  caps legitimately diverge further (Skydance 21×, Sphere 25×); 50× still catches a broken row.
- **Verification**: `npm test` **483/483** · `audit-universe` **0 issues** · `audit-calculations` **0 mismatches,
  0 out-of-range** · `audit-deep` **0 coherence issues** · `audit-markets` US **0 failures** (39 float /
  second-class cap-vs-shares warnings) · descriptions **1,506/1,506**, 0 flagged. Reconciliation of the
  1,004 new names: **925 match · 42 close · 13 diverge · 5 period-mismatch · 11 no Nasdaq data · 6
  immaterial · 2 definition**. Verification: **1,469 verified · 9 disputed · 4 definition · 24 unchecked**.
  Coverage: price/cap/sector/market cap **1,506/1,506**, revenue **1,495**, net income **1,481**, TTM
  **1,485**, equity **1,503**, 4+ quarters **1,497**, 5-year P/E history **1,365**, chart series **1,502**,
  `^SP1500` chart present.
- **Known source gaps, disclosed not guessed**: MTH and APA do not tag an annual revenue line in the
  facts feed (their quarterly revenue is present); CNK's latest `Assets` tag stops in 2022; SKT has no
  10-K net-income tag (revenue is filled from lease income); PNFP's 2025 reorganisation gives it a
  one-row five-year table while the headline and quarters are correct. The freshness warnings for
  GEF/HUBG/SKYD are their latest 10-Ks on file (FY2024; GEF's latest EDGAR 10-K is 2024-12-23), not
  rebuilt-stale data. BF-B/IBOC/TCBI carry a derived cap because Nasdaq's summary did not price them.

## Company charts: 10Y is only offered where it exists (2026-11-07)

The US company page has ten years of committed prices. The other markets hold about five, so
their 10Y chip was a no-op: `coFitRange` saw five years of dates, fell back to 5Y and re-drew the same
line while the chip stayed unlit. The chip is gone from every non-US company page — Japan, Korea,
Taiwan, Hong Kong, Australia, India, Indonesia and Brazil; the US keeps it.

- Those non-US range rows now stop at **1M / 3M / 6M / YTD / 1Y / 5Y**, matching the return strip
  that already used `WINDOWS_5Y`.
- A stored `10y` selection from an older visit is read as **5Y** by `coStoredRange`, so a returning
  reader lands on the longest window the archive actually covers instead of a chart that never changes.
- The market-index charts were already data-aware (`coWindowsFor` drops 10Y when the span is short), so
  only the company pages needed the change. `app.js?v=300`.



## Brazil: B3, one class per issuer (2026-11-07)

- **Universe**: the vendor's B3 exchange list (1,228 rows) → **788 BDRs** (codes ending 31–39) and **26
  FII/funds** excluded by type → 414 class lines → **311 issuer groups**. The build selects the class with
  a statement page (PETR4 yes, PETR3 404; SANB11 yes, SANB4/3 404), largest class first. **303 domestic
  companies** after 4 stale statements and 4 without a defensible share count. Published domestic cap
  **R$ 4.8T**; **11 LatAm BDRs** are added separately below (314 listed).
- **Company cap, class price**: the vendor's cap is the **company total**, repeated on every class line.
  The selected class keeps that cap; the price is the class price; classes are never summed. The audit
  checks `marketCap = vendorCap`, not `price × class shares`. The company page says which class it is.
- **Statements**: stockanalysis.com BVMF pages; TTM/annual/quarterly, current shares, vendor yield, GICS
  sector/profile. USD/BRL from open.er-api; Ibovespa (`^BVSP`) and `.SA` prices from Yahoo.
- **Trading quality**: frozen price (>=90% unchanged in 250 sessions), short history (<100 sessions), TTM
  older than 365 days and thin turnover (< R$1M/day) are flagged with the same warnings/presets as
  Indonesia. No HSC equivalent.
- **Reports/currency**: most issuers report in BRL; the report currency is stored and the ratios are
  computed in it. The vendor does not label consolidated vs standalone; the page says so.
- **Build**: `npm run build:brazil` — build → profiles → shares → rebuild → profiles → rebuild from cache.
  `--limit=N` / `--codes=PETR4,VALE3` are the smoke tests; caches in `data/cache/b3`.
- **Output**: `data/brazil.json`, `data/brazil-series/{A..Z,0..9}.json`, `data/brazil-list.json`,
  `data/brazil-companies/`, `data/brazil-profiles.json`, `data/brazil-brands.json`,
  `data/brazil-themes.json` (12 curated lists), `data/brazil-universe.json`.
- **Server/UI**: `/api/brazil`, `/api/brazil/company/{code}`, `/api/brazil/chart?code=&range=`; a ninth
  region button (`BRAZIL`) with MARKET / SCREENER / THEMES, company page, search (`br:PETR4`), peers,
  compare and the home screener row. Accent `#2e9e5b`.
- **Audit**: `npm run audit:brazil` (hard invariants; sample cross-check) and
  `npm run audit:brazil:deep` (engine fields, cap/ratios, four-quarter TTM, growth, dividends, returns,
  flags, aggregates, list projection). The deep audit reports the vendor's TTM-vs-quarter differences
  (restatements/YTD) as notes, not failures.
- **Schedule**: `.github/workflows/brazil-daily.yml`, 21:40 UTC Mon–Fri (18:40 BRT), with the statement
  cache, `merge-history br`, `merge-series br`, the collapse guard, both audits and the commit.


## Brazil BDR lens: 11 curated LatAm/Brazil receipts (2026-11-08)

- **Why a separate lens**: the B3 list has 788 BDRs; the user wanted the significant **LatAm/Brazil-linked**
  names (Nubank, XP, Inter, MercadoLibre, StoneCo, PagSeguro, VTEX, Globant, JBS N.V., Aura, Brazil
  Potash, Eve), **not** the US mega-caps, which already live in the US section. They are not domestic B3
  operating companies, and their global company caps would swamp the domestic totals, so they are
  appended as their own panel and excluded from `market.totalCap`, sector medians, breadth and the
  domestic quality counts.
- **Allowlist**: `data/brazil-bdrs.json` — 12 LatAm/Brazil-linked entries, with `code`, `underlying`,
  `exchange` (`stocks` or `tsx`), `ticker`, `group`, a pinned `vendorCap` fallback and a note. 11 build;
  **AURA33** is dropped because the TSX filing is older than 450 days (the policy is applied, not waived).
  There are no global mega-caps in this lens: Apple, Microsoft, etc. stay in the US section.
- **Sources**: the B3 list row gives the **global company cap in BRL** and the B3 name; the **underlying
  US/TSX listing** (`stockanalysis.com/stocks/<ticker>/` or `/quote/tsx/<ticker>/`) gives the statements,
  GICS profile, current shares and dividend yield; the BDR's own `.SA` Yahoo series gives the BDR price
  and returns. The B3 BDR quote page is a stub (profile/statements 404), so it is not used for data.
- **Numbers**: cap = B3 company-total cap, not the BDR tranche; price = BDR line; P/E, P/B, ROE and yield
  are company-level in the underlying report currency (USD/BRL/TWD) and converted at the build's FX.
  No per-BDR EPS or P/E band: the BDR ratio would make `BDR price ÷ global EPS` meaningless. The company
  page says which class/line it is and that the band is omitted.
- **Build**: `scripts/build-brazil-bdrs.mjs` → `data/brazil-bdr-data.json`, the BDR series and the BDR
  profile entries; `scripts/merge-brazil-bdrs.mjs` appends them to the domestic `brazil.json`, updates
  `market`/`audit`, rebuilds the themes against the merged codes, writes the BDR detail files, merges
  the series buckets and runs the chart store + brand attach. `npm run refresh:brazil` ends with both;
  `npm run build:brazil:bdrs` is the manual pass.
- **Market fields**: `market.companies` stays the domestic count; `market.listed` = domestic + BDRs;
  `market.bdrs`; `market.bdrCap` (global, for the panel only); `market.bdrGroups`; `market.bdrPe/Pb/Roe/
  Yield`; `market.bdrReportCurrencies`. `audit.companies` is the total, with `domesticCompanies`,
  `bdrCompanies`, `includedBdrs`, `excludedBdrs` (777) and the BDR flag counts.
- **UI**: a **SIGNIFICANT LATAM BDRs** panel on MARKET (LatAm/Brazil names only, global cap, P/E, YTD,
  BDR price); `BDR` tags on the screener/themes/home rows; a `TYPE` filter (All/Domestic/BDRs); the
  `SIGNIFICANT LATAM BDRs` preset; the `bdrs` theme; a BDR banner and global-cap/global-EPS labels on
  the company page. The universe note names the included BDR count and the dropped Aura, and says the
  US mega-caps remain in the US section.
- **Audits/tests**: the standard audit excludes BDRs from the domestic cap/sector partition, checks the
  allowlist, each BDR's global cap, report currency, class, no band and the underlying; the deep audit
  checks the engine fields, P/E/P/B/ROE, four-quarter TTM, returns, flags, market/BDR aggregates, list
  and themes. The Brazil data test covers the 303/29/332 split, the allowlist, the BDR currencies and
  the separate totals; the API test covers `ROXO34` and the list's BDR fields.


## DATA & METHODOLOGY covers the five newer markets (2026-11-08)

- The on-site **DATA & METHODOLOGY** (`src/lib.js` `METHODOLOGY`, served at `/api/market.methodology`)
  now documents **Hong Kong, Australia, India, Indonesia, Brazil and South Africa** alongside US/Japan/Korea/Taiwan:
  universe, fundamentals, prices/FX, valuation history, descriptions and limits.
- The source table adds **stockanalysis.com** (statements, profiles, current shares, yield) and
  **Exchange files** (HKEX, ASX, NIFTY 500, IDX, B3); Yahoo now explicitly covers company prices too.
- The limits spell out the five markets' scope: HKEX main board only (GEM excluded; HKD/CNY/USD
  statements), ASX with CDIs and USD reporters, NIFTY 500 with the April–March fiscal year, IDX with
  the reviewed 95-name prune and the 82-name HSC list, and B3 with one class per issuer plus the
  LatAm-only 11-BDR lens (US mega-caps stay in the US section; 777 other BDRs/FIIs excluded).
- `tests/lib.test.js` now asserts every one of the ten company markets appears in both the company
  data and the limits.


## All-markets audit + automatic updates (2026-11-08)

- **`npm run audit:all`** now runs the whole set, not just the US: US calculations/deep/universe/
  freshness/deals/invariants/reconcile/arbitrate/themes, the US/JP/KR cross-market check,
  Taiwan, Hong Kong, Australia, India, Indonesia (standard + deep), Brazil (standard + deep), South Africa
  (standard + deep), the refresh-collapse guards and `check-freshness`. It writes `data/audit-all-markets.json` and exits
  non-zero on any failure. `check-snapshot` stays a separate manual baseline refresh: a new filing
  legitimately moves it, which is why the daily companies job deliberately keeps it off the hard gate.
- **`scripts/audit-all-markets.mjs`** is the wrapper; the individual scripts stay the source of truth.
- **Auto updates**: `companies-daily` refreshes US/JP/KR; `taiwan-daily`, `hongkong-daily`,
  `australia-daily`, `india-daily`, `indonesia-daily`, `brazil-daily` and `south-africa-daily` refresh the
  other seven.
  **`markets-audit-daily.yml`** runs Tue–Sat 22:30 UTC, after the US/JP/KR and Brazil refreshes, and
  commits the combined audit report.
- `tests/workflows.test.js` asserts the scheduled all-markets audit exists and that the wrapper names
  every market, including the Indonesia, Brazil and South Africa deep audits.

## US MARKET cohorts, tiers and broader themes (2026-11-08)

- **Tiers**: `attach-us-tiers.mjs` reads the SPY (500), MDY (400) and SPSM (600) holdings and tags every
  company with `spTier` — **503 / 400 / 603** across 1,506 securities. The composite membership is still
  SPTM; the three fund lists are authoritative for the size cohorts.
- **MARKET cohorts**: the US MARKET view switches between **S&P 1500 / 500 / 400 / 600**. Each cohort
  recomputes market cap, medians, breadth, the sector table and the index P/E from its own constituents,
  and draws the matching index chart — `^SP1500` (SPTM proxy, scaled), `^GSPC`, `^SP400`, `^SP600`. The
  company page badge names the company's own index. The selector is remembered per browser.
- **Themes**: the US themes are industry rules plus curated names against the 1500, with tested anchors:
  **AI 87 · Defence 34 · Nuclear & Power 70 · Software 46 · Healthcare 150 · Financials 233 ·
  Energy 49 · REITs 107.** The mid and small caps join through the industry rules; the curated lists
  remain the sector representatives.
- **Auto-update**: the weekly rebuild runs frames → filter → complete → **tiers** → weights, then the
  fundamentals, `fill-us-revenue`, `build-capital-metrics`, restatements, and **four index charts**; the
  daily reattaches themes and rebuilds the four charts. Both jobs use the fetch timeout. The daily
  cross-market audit is `continue-on-error` because the dedicated markets-audit-daily job owns that
  gate; a known non-US source issue must not stop the US price commit.

## All-markets audit + automatic updates (2026-11-08)

- **`npm run audit:all`** now runs the whole set, not just the US: US calculations/deep/universe/
  freshness/deals/invariants/reconcile/arbitrate/themes, the US/JP/KR cross-market check,
  Taiwan, Hong Kong, Australia, India, Indonesia (standard + deep), Brazil (standard + deep), South Africa
  (standard + deep), the refresh-collapse guards and `check-freshness`. It writes `data/audit-all-markets.json` and exits
  non-zero on any failure. `check-snapshot` stays a separate manual baseline refresh: a new filing
  legitimately moves it, which is why the daily companies job deliberately keeps it off the hard gate.
- **`scripts/audit-all-markets.mjs`** is the wrapper; the individual scripts stay the source of truth.
- **Auto updates**: `companies-daily` refreshes US/JP/KR; `taiwan-daily`, `hongkong-daily`,
  `australia-daily`, `india-daily`, `indonesia-daily`, `brazil-daily` and `south-africa-daily` refresh the
  other seven.
  **`markets-audit-daily.yml`** runs Tue–Sat 22:30 UTC, after the US/JP/KR and Brazil refreshes, and
  commits the combined audit report.
- `tests/workflows.test.js` asserts the scheduled all-markets audit exists and that the wrapper names
  every market, including the Indonesia, Brazil and South Africa deep audits.

## US MARKET cohorts, tiers and broader themes (2026-11-08)

- **Tiers**: `attach-us-tiers.mjs` reads the SPY (500), MDY (400) and SPSM (600) holdings and tags every
  company with `spTier` — **503 / 400 / 603** across 1,506 securities. The composite membership is still
  SPTM; the three fund lists are authoritative for the size cohorts.
- **MARKET cohorts**: the US MARKET view switches between **S&P 1500 / 500 / 400 / 600**. Each cohort
  recomputes market cap, medians, breadth, the sector table and the index P/E from its own constituents,
  and draws the matching index chart — `^SP1500` (SPTM proxy, scaled), `^GSPC`, `^SP400`, `^SP600`. The
  company page badge names the company's own index. The selector is remembered per browser.
- **Themes**: the US themes are industry rules plus curated names against the 1500, with tested anchors:
  **AI 87 · Defence 34 · Nuclear & Power 70 · Software 46 · Healthcare 150 · Financials 233 ·
  Energy 49 · REITs 107.** The mid and small caps join through the industry rules; the curated lists
  remain the sector representatives.
- **Auto-update**: the weekly rebuild runs frames → filter → complete → **tiers** → weights, then the
  fundamentals, `fill-us-revenue`, `build-capital-metrics`, restatements, and **four index charts**; the
  daily reattaches themes and rebuilds the four charts. Both jobs use the fetch timeout. The daily
  cross-market audit is `continue-on-error` because the dedicated markets-audit-daily job owns that
  gate; a known non-US source issue must not stop the US price commit.

## US descriptions: stockanalysis.com profiles (2026-11-08)

The US COMPANIES descriptions now use the same **stockanalysis.com company-page profile** extractor as
Japan, Korea, India, Taiwan, Hong Kong, Australia and Indonesia — not the 10-K Item 1 legal text and not
Nasdaq's short marketing blurb. `fetch-us-descriptions.mjs` prefers stockanalysis, with Nasdaq/10-K as
the fallback; `attach-us-descriptions.mjs` puts the committed `data/us-profiles.json` back after a
rebuild.

Backfilled **1,189 of 1,506** from stockanalysis; **317** remain on the Nasdaq fallback (stockanalysis
has no page for them yet, or the page was still throttled) and are upgraded by the daily
`--only-missing --limit=25` and weekly `--only-missing --limit=200` jobs. `data/us-profiles.json` is now
committed by both jobs, so a CI rebuild cannot lose the profiles (the Korea lesson). The description gate
no longer treats a legitimate mention of "charitable organizations" as a foundation page, and
accent-folded names (Schrödinger) satisfy the name check. ICHR's stockanalysis page is missing, so it
keeps the 10-K text.


## South Africa: the JSE (2026-11-08)

- **Universe**: the vendor's Johannesburg exchange list (**258 lines**) → **244 after 14 named
  exclusions** → **226 built** = **204 JSE-primary** + **22 foreign-secondary**. Twenty-four JSE lines
  are foreign-domiciled and mapped to a primary listing (CFR, PRX, ANH, ANG, BTI, GLN, SRE, SHC, PHP,
  HMN, SRI, SCD, N91, BYI, CNP, GTC, GCT, APH, AII, PAN, SDL, ORN, MCZ, EPS); 22 build, because AII and
  SCD have no trustworthy JSE price. Statements and profiles come from the primary listing, the price is
  the JSE line and the cap is the **global company total**, all in rand. They are **inside the market
  totals**, not a separate rail.
- **Exclusions** (named, never estimated): **BHG** (BHP) and **S32** (South32) belong to the Australia
  market; **INP** is Investec’s duplicate (INL kept); **AGL**, **MNP** and **QLT** have no free
  statement page; **SOLBE1/FTB/EMN/RTO/AON/BRN/NY1** are duplicate share classes of an issuer already
  built; **FDETNQ** is a FirstRand Bank note, not an operating company. That leaves 13 lines with no
  free statement page, 3 stale statements and 2 without a trustworthy JSE price — all named in the audit.
- **Prices**: the exchange list quotes the JSE in **cents** (NPN prints 75,725.0 = R757.25), but Yahoo is
  not consistent: most `.JO` lines print cents, several thin lines already print rand, and a foreign
  secondary may print another instrument's unit. Every series is therefore scaled so its last close
  equals the exchange-list price in rand; a ratio outside the rand/cents conventions is rejected and the
  line is named as no-price (SCD was rejected this way). The JSE All Share is `^J203.JO`.
  Yahoo supplies up to **five years** for most JSE lines, but caps some heavily traded names at about
  **500 sessions**; each company chart falls back to the longest window that line actually covers, and
  the fiscal-year table still spans five years.
- **Caps**: the vendor list cap is the **company total in rand** and is the authority; the audit checks
  `marketCap = vendorCap` and the company page never re-derives the cap from price × shares. The statistics
  page’s current count is published for per-share displays (the balance sheet is the fallback).
- **Statements**: stockanalysis.com JSE pages for the primary companies and the primary exchange for the
  foreign-secondary lines. TTM/annual/half-year, current shares, vendor dividend yield, GICS profile, report
  currency (ZAR/USD/EUR/GBP) carried into the ratios. The JSE reports half-yearly and the page labels
  the table REPORTED HALF-YEARS. Where the vendor serves no trailing column — Richemont is the obvious
  case — the build first sums the latest two half-year filings. The sum must reconcile with the fiscal
  year when the period ends coincide. If the half-year table lags (TEX) or does not reconcile (WBO),
  the build reads stockanalysis's separate `?p=trailing` view, which carries one rolling twelve-month
  column per period end. That lifts the market to **225 of 226 lines on TTM**; only OAO (no trailing
  data, no P/E) keeps the labelled fiscal year. USD/ZAR from open.er-api.
- **Shared parser fix**: stockanalysis.com changed its statement-table markup in November 2026 (no
  `id` attributes; the period row is a `date-row` and the label sits in a `font-medium` div).
  `parseSaTable` now supports both layouts, so a fresh build no longer reads every page as empty.
- **Trading quality**: frozen price (>=90% unchanged in 250 sessions), short history (<100 sessions), TTM
  older than 365 days and thin turnover (< R1M/day) are flagged; returns are withheld on frozen lines.
- **Build**: `npm run build:southafrica` — build → profiles → rebuild from cache. `--limit=N` /
  `--codes=NPN,FSR` are the smoke tests; caches in `data/cache/jse` and `data/cache/southafrica-sa`.
- **Output**: `data/southafrica.json`, `data/southafrica-series/{A..Z,0..9}.json`,
  `data/southafrica-list.json`, `data/southafrica-companies/`, `data/southafrica-profiles.json`,
  `data/southafrica-brands.json`, `data/southafrica-themes.json` (9 curated lists),
  `data/southafrica-universe.json`.
- **Server/UI**: `/api/southafrica`, `/api/southafrica/company/{code}`,
  `/api/southafrica/chart?code=&range=`; a tenth region button (**SOUTH AFRICA**) with MARKET / SCREENER /
  THEMES, a company page, search (`za:NPN`), peers, compare and the home screener row. Accent gold
  `#c9a227`. The MARKET view carries a **FOREIGN-SECONDARY LISTINGS** panel naming each primary exchange.
- **Audits/tests**: `npm run audit:southafrica` (hard invariants, caps, ratio reproduction, secondary
  sources, aggregates, list projection) and `npm run audit:southafrica:deep` (engine fields, caps,
  ratios, TTM from the vendor column, two half-years or the vendor trailing view, flags, list).
  `tests/southafrica-data.test.js` covers the 258/244/226 split, computed half-year TTM, vendor
  trailing TTM, the named exclusions and secondary map, caps, ratios and list fields; `filters`,
  `workflows` and `lib` tests include South Africa.
- **Schedule**: `.github/workflows/south-africa-daily.yml`, 15:40 UTC Mon–Fri (17:40 SAST), with the
  statement cache, `merge-history za`, `merge-series za`, the collapse guard, both audits and the commit.
- **Not used**: the official JSE market-data API is licensed (no free key); the keyless vendor path is
  the delivery route.

## JSE charts: 5Y and short Yahoo histories (2026-11-08)

- **Symptom**: Richemont's 5Y button jumped back to 1Y, and other JSE lines had only about two
  years of chart. Yahoo's `.JO` cache was keyed only by symbol, so a 2-year fetch poisoned every
  later 5-year run; the series was then truncated to 400 daily points by design.
- **Fix**: the Yahoo cache key now carries the requested range (`CFR.JO-5y.json`). A 5-year rebuild
  gives NPN/FSR and most JSE lines the full five years. Seventeen lines still start later (Richemont
  starts 2023-04); the company page now has a **MAX** window, and a 5Y click on a short series opens
  MAX with a note naming the first available date instead of falling back to 1Y.
- **Guard**: `tests/app-ui.test.js` covers `coWindow(..., 'max')` and the ZA MAX chip.
- **Cache**: `oil-desk-v12`, `app.js?v=309`.

## Brazil tab loaded the South Africa feed (2026-11-08)

- **Symptom**: opening BRAZIL painted SOUTH AFRICA, the market header said **0 BDRs**, and clicking
  any company produced an error. `loadBrazil()` was fetching `/api/southafrica`, so the B3 screen held
  the 226 JSE lines; the subsequent `/api/brazil/company/{code}` call then asked for a JSE code and
  returned 404. The BDR count was 0 because the JSE feed has no `market.bdrs`.
- **Fix**: `loadBrazil()` now fetches `/api/brazil`; the B3 header reads **303 domestic + 11 BDRs** and
  the BDR panel is populated.
- **Guard**: `tests/app-ui.test.js` pins every market loader (`loadJapan` … `loadSouthAfrica`) to its
  own endpoint and asserts Brazil never reads `/api/southafrica`.
- **Cache**: `oil-desk-v10`, `app.js?v=307`.

## Mobile COMPANIES navigation: scrolling row, active market in view (2026-11-08)

- **Symptom**: on a phone, India, Indonesia, Brazil and South Africa sometimes looked missing from
  COMPANIES. They were present in the DOM, but `.co-region` is a one-row horizontal scroller, so the
  four newest markets can sit off-screen until the reader swipes.
- **Decision**: the horizontal scroll is the preferred interaction, so it stays. The fix is to
  **scroll the active market into view** when COMPANIES renders (`scrollActiveIntoView`), plus
  `scroll-snap` for cleaner swipes. A saved India/Indonesia/Brazil/South Africa selection can no longer
  open with its pill off-screen. The home market switch keeps its scrolling row too.
- **Cache**: the service worker's cache moved to `oil-desk-v9`, and registration uses
  `updateViaCache: 'none'`, so a deploy cannot leave the old nine-market shell behind. Asset versions
  are bumped (`app.js?v=306`, `style.css?v=131`).
- **Guard**: `tests/app-ui.test.js` asserts all ten `data-region` buttons exist, that the row keeps
  `overflow-x: auto`, and that `scrollActiveIntoView` is wired.

## Load speed: the first paint, the boot gate and the layout (2026-11-09)

Measured with headless Chrome against the live site (cache disabled; mobile = 390×844, 4× CPU,
1.6 Mbps / 150 ms; desktop = warm instance). Before → after:

| | mobile first visit | mobile repeat visit | desktop |
|---|---|---|---|
| FCP | 1.30 s → **0.84–1.06 s** | **0.24 s** | 1.22 s → **0.50–0.69 s** |
| Boot overlay gone | 4.36 s → **1.3–2.1 s** | **0.30 s** | — |
| LCP | 1.55 s → **1.0–1.9 s** | **0.31 s** | 1.36 s → **0.75–0.92 s** |
| CLS | 1.16 → **0.06** | **0** | 0.40 → **0.03** |
| First-screen bytes | 2.09 MB → **1.3 MB** | **63 KB** | 1.18 MB → **0.60 MB** |
| Main-thread long tasks | 414 ms → **328 ms** | — | — |

- **The search indexes are intent-loaded.** `/api/search-quick` (0.8 MB brotli) and `/api/market-index`
  were fetched 0.5 s into every visit even when nobody searched — two thirds of the first load. They
  now start on hover/focus/Cmd-K of the search box (`gsWarmSearch`); until they land, the debounced
  `/api/global-search` answers keystrokes, so search is never blocked.
- **Chart.js and app.js are deferred** (`index.html`), with app.js preloaded `fetchpriority=high`.
  Chart.js is 200 KB and was parser-blocking in `<head>`; nothing inline needs `Chart` before app.js
  runs, and the document order is preserved. The first-screen API calls (`market`, `markets`,
  `history`, `regime`, `brief`) are preloaded `as=fetch` with the HTML — the app's later `getJSON`
  reuses the cached response (one request per URL, verified) so the data round-trip overlaps the
  script download instead of following it. Boot 4.4 s → 1.3 s on a throttled phone.
- **The brief and the regime board start with the prices**, not after them; neither reads the price
  table. The brief is HOME's LCP on a returning visit.
- **HOME reserves the space its panels will fill.** The panels are fixed shapes (ten market tiles,
  three ideas, a month calendar, the tape), but each arrived later and pushed the page down. Reserving
  their heights took CLS 1.16 → 0.06. On phones the desktop reservations were the wrong shape (the
  new mobile layout uses one-row swipe strips), so the strip heights are reserved instead — one row,
  not five — with no empty space around the real content.
- **Warm prefetch stands down on 3G/save-data**: ten market lists (~1 MB) are not worth stealing from
  the first screen on a metered link; the tab still loads a market on click.
- **Repeat visits** are served by the immutable (`max-age=31536000, immutable`, brotli) versioned
  assets and the service worker: 41 resources, 63 KB, FCP 0.24 s, CLS 0.
- **Tests**: 537 pass. Headless smoke: all four tabs, commodity chart 6M/1Y/5Y, global board,
  AU/HK company chart 1Y/5Y, global search (quick index loads on click, not at boot), zero console
  errors and zero HTTP ≥ 400.

### Follow-up: the MACRO click and the background warm (2026-11-09, later)

- **The first MACRO open was animating five charts at once.** `baseOptions` carried a 200 ms Chart.js
  animation, so opening the tab ran five overlapping animations: **736 ms of long tasks** at 4× CPU in
  five 100–240 ms blocks. Charts now draw their final frame immediately (`animation: false`), and the
  same open is **57–86 ms** with zero long tasks on a second visit. Country, range and chart-tab
  changes are immediate too.
- **The background warm was competing with the reading window.** 2.5 s after load the client fetched
  and parsed all ten market lists (~1 MB). It now warms only US and the last-used region; the other
  eight start when COMPANIES is opened or hovered. API bytes in the first 12 s: **~1.3 MB → 264 KB**;
  first 18 s transfer **2.1 MB (original) → 466 KB**.
- **Below-the-fold HOME panels render on approach.** The screener, risk matrix, headline board, market
  board and idea cards were laid out and painted while the reader was on the brief. They now use the
  existing `whenNear` observer (400 px of lead), keeping their loaders and loading states. First-load
  long tasks on the throttled phone dropped to ~130–220 ms (three 60–85 ms tasks at 4× CPU, i.e.
  ~20 ms each on a normal CPU); jumpnav anchors and fast scrolls still populate every panel.
- **Interaction check (4× CPU, production):** HOME scroll 60 fps (p95 17 ms), HOME sort/jumpnav 0 long
  tasks, MACRO country/range changes 0 long tasks, MACRO tab reveal ≤54 ms, HOME market tile ≤81 ms.
  Desktop: 0 long tasks on every one of those interactions.
- **Production (warm, mobile 4×/1.6 Mbps):** FCP 1.15–1.20 s, boot 2.1 s, LCP 1.86 s, CLS 0.081,
  466 KB. Desktop: FCP 0.55–0.67 s, LCP 0.68–0.83 s, CLS 0.060, 466 KB. Repeat visit: FCP 0.42 s,
  LCP 0.50 s, boot 0.49 s, CLS 0, 0 KB transferred (service-worker + immutable cache).
- **Tests:** 537 pass. AU/HK company charts 1Y/5Y verified again on production after the changes.

## Matrix audit: no fractional quarters, repaired Q4s, split fiscal years (2026-11-10)

The quarterly matrix was drawing several classes of visibly wrong rows. The fixes are structural,
not one-off patches for the named companies:

- **A Q4 tagged with the annual total** (DINO, NiSource, AZZ) printed a quarter 3–4× a normal one.
  The matrix now detects `Q4 ≈ annual` with Q1–Q3 present, rebuilds Q4 as `annual − Q1−Q3`, and
  reports the repair. `build-quarters.mjs` also drops the impossible 90-day row before it derives
  Q4 from the cumulative FY − 9M, so the next rebuild does not recreate it.
- **Fractional quarters** (FedEx Q2.67, MRZ Q0.33) came from dividing an off-grid month by three.
  Quarter numbers are now computed from the month after the fiscal year end with inclusive
  quarter-end buckets; a 52/53-week period that closes on the 1st–7th stays in the quarter it
  belongs to. Every grouped quarter is an integer in 1..n.
- **An irregular four-period window** moved Cardinal Health's June year-end to September because the
  feed skipped two quarters and four entries spanning 15 months still summed near the annual. Window
  matching now requires the expected 9-month (quarterly) or 6-month (half-year) span.
- **Fiscal-year changes** (Japan 2871/4331) merged the old and new FY2026 Q1 and lost one. When two
  fiscal-year ends share a calendar year, the matrix keys and labels them by month (`2026 · Mar`,
  `2026 · Dec`) instead of one numeric year.
- **Mixed-frequency feeds** (Hong Kong 0522) were read as half-year because the older gaps outvoted
  the recent quarterly tail. `coMatrixDetectN` uses the last three gaps and only calls a feed annual
  when every gap is annual-sized.
- **Annual-only feeds** no longer print a fake half-year matrix; they return no model and the page
  says the quarterly split is unavailable.
- **Duplicate/collision/outlier notes:** 52/53-week duplicates (later filing wins), two periods on
  one quarter, three-times-median quarters, repaired annual quarters, unreconciled annual records
  and blank cells are stated in the matrix note instead of being silent.

System: `npm run audit:matrix` / `scripts/audit-matrix.mjs` runs the real model over all 12,700+
company pages and fails on future periods, fractional/out-of-range quarters, reversed cells and
hard collisions; warnings cover calendar fallbacks, duplicates, outliers, unreconciled annuals and
annual-only feeds. `tests/matrix.test.js` adds named regressions for Apple/Cardinal Health/Pepsi/
DINO/Japan-2871 and an all-region integer/order check.

Known remaining, separate from the matrix code: 52/53-week duplicate period ends (the later filing is
shown with a note), five US companies that fall back to calendar columns because their annual revenue
definition differs from the quarterly feed, and the odd one-off quarter that the outlier note calls out.

### 2024 history backfilled and the refresh pipeline made permanent (2026-11-10)

- **Every stockanalysis builder keeps 20 periods, not 8.** India, Indonesia, Taiwan, Brazil, Australia,
  Hong Kong and South Africa now hold the 2024 quarters the vendor pages already carried. A
  `--quarter-cache-days=N` flag lets a repair run reuse the warm pages; the daily default stays 1 day.
- **Korea fetches three years of interims**, so 2024 Q1/H1/Q3 are present (2024 Q4 is the annual report).
  Korea went from **0 to 1,396** companies with 2024 quarters; India 737/744, Indonesia 802/810,
  Taiwan 1,084/1,084, Brazil 311/314, South Africa 225/225.
- **India defaults to the NIFTY Total Market.** A bare `build-india.mjs` used to silently rebuild the
  NIFTY 500 (744 → 494 companies); the default is now `--universe=total`.
- **`merge-market-refresh.mjs` carries the last good company, detail page and chart series** when a
  partial source (HKEX staged report, throttled Yahoo crawl) omits a code. The market cannot shrink,
  and the fresh data for the codes that did arrive still publishes. Wired into all six market
  workflows before the audit.
- **A refresh that cannot publish is deferred, not failed.** The gate restores `data/` from HEAD,
  prints a warning and exits 0; the next run retries. A red run no longer appears for a source-wide
  holiday/publication lag.
- **Render runs native Node** (no Docker build, no `npx esbuild` network fetch, no server boot inside
  the image) and deploys only when GitHub checks pass (`autoDeployTrigger: checksPass`). One-time
  workspace setting still recommended: **Overlapping Deploy Policy → Wait**.
- Verified: `npm test` **575 pass**; matrix audit **0 critical** over 12,735 matrices.

## Japan: who is buying, the exchange calendar, and the dividend ladder (2026-11-10)

J-Quants Light had more than prices and summaries. The Japan section now uses three of the
untapped datasets, all verified against the live key:

- **TSE Prime investor-type flows** (`/v2/equities/investor-types`, weekly): a **WHO IS BUYING** panel
  on the market view with 4-week net foreign / individual / investment-trust / brokerage /
  proprietary flows, a 13-week foreign-flow strip and a plain-English read. The endpoint is
  **section-level, not per issue**, so the company page shows the same figure as *market context*
  and says so; there is no fake stock-level flow.
- **Trading calendar** (`/v2/markets/calendar`): next session, half-days and the next weekday
  holiday in the Japan header. Weekends are filtered out of "next holiday"; after the 15:00 JST
  close the next session rolls forward.
- **Dividend ladder** from the cached `fins/summary`: interim, year-end, FY total, current forecast,
  next-year forecast and payout, on the company page. `Div1Q/2Q/3Q/DivFY`, `FDiv...` and `NxFDiv...`
  are now mapped in `derive-japan` as well.

`scripts/build-japan-flows.mjs` fetches the two Light endpoints, enriches the cached dividend
ladder, and rewrites `data/japan-list.json`; `npm run build:japan` and the daily Japan step run it
(non-fatal — a missing flow panel never discards the price rebuild). Tests cover the helpers, the
list projection and the workflow wiring.

Higher-tier J-Quants endpoints (`/fins/dividend`, `/fins/details`, margin/short, EDINET, derivatives,
minute/tick) return **403 on this Light plan** and are deliberately not shown as empty panels.
The bulk API is available but is a backend download optimisation, not a Japan-section control.

## TTM was two different numbers (2026-11-11)

The profile tile and the matrix TTM could disagree because they read different sources. The matrix's
top TTM used the last four quarter columns for Korea / India / Indonesia / Brazil / South Africa,
while the profile tile read `reports.ttm` (the vendor's trailing column); on Indonesia they differed
for the same quarter-end. Fixed structurally:

- `coMatrixTopTtm` now uses the **same `reports.ttm` figure as the profile tile** for those markets;
  the matrix no longer creates a second TTM.
- The matrix's cumulative-quarter heuristic checks the vendor TTM before rewriting a quarter:
  CSRA's genuine Q3 2026 jump (raw four-quarter sum = vendor TTM) was being turned into a 42.8B
  "cumulative" quarter; it stays 174.4B.
- The matrix TTM row now carries its as-of date, so a vendor TTM and a quarter table cannot silently
  refer to different periods.
- A cross-market test asserts matrix TTM == profile tile for every company; when the visible quarters
  do not sum to the vendor's trailing figure, the matrix note says so rather than showing a second
  official-looking number. `npm test` passes.

## Underlying data quality: stale feeds and tag mismatches (2026-11-11)

The formulas are not the issue; the feeds are. A new audit separates the two and a Japan build bug
that hid insurer quarters is fixed:

- `npm run audit:quality` / `scripts/audit-data-quality.mjs` writes `data/data-quality.json` and reports
  per market: **stale** (latest period >450 days old while the quote is current), **gap** (missing
  period in the latest window), **annual** (fiscal-year quarters vs the annual record), **tag**
  (quarterly revenue implausibly small/large against annual) and **ttm** (the tile vs the visible
  quarters). The daily companies workflow runs it non-fatally and commits the report.
- The matrix already labels stale periods, partial years and annual-vs-feed differences; the audit is
  the machine-readable version for the next repair.
- **Japan:** `buildQuarters` required a quarterly sales line, so insurers/banks that publish profit but
  leave sales blank were dropped and their pages sat years behind (Lifenet 7157, Sompo 8630). It now
  emits a period when sales **or** operating profit **or** net profit exists; the cache-only rebuild
  then restores those quarters. Test added.
- Current audit snapshot: stale companies **US 0 · Japan 4 · Korea 2 · Taiwan 0 · Hong Kong 0 ·
  Australia 4 · India 0 · Indonesia 1 · Brazil 0 · South Africa 1**; 1,124 company-level notes in total.
  The larger counts are tag/annual/TTM definition differences (banks, insurers, REITs, half-year
  filers); they are labelled, not hidden.
- Remaining repair path: targeted refresh of the few stale codes (some are suspended/delisted and the
  source has nothing newer), and tag arbitration for US restatements. The audit lists the exact codes
  in `data/data-quality.json`.

## Per-company freshness ledger and repair queue (2026-11-11)

`npm run ledger:refresh` writes `data/refresh-ledger.json` and `data/refresh-queue.json` and the
all-markets daily job commits them. For every covered company it records the published period, the
newest source period where a source adapter exists (J-Quants for Japan, DART for Korea), the quote
age, and a status:

- **fresh** — published period is current
- **repair** — source has a newer period; queued for the next targeted rebuild
- **stale** — no source comparison is available and the published period is >450 days old
- **inactive** — no recent quote (suspended/delisted), so stale would be misleading
- **unknown** — no statement period

`/health` now returns a `freshness` block with the totals and per-market counts. Current snapshot:
10,490 companies, 10,462 fresh, 1 repair, 10 stale, 1 inactive, 16 unknown. The Japan queue was
repaired after fixing duplicate same-date filings (a blank vendor row was winning over the real row).
