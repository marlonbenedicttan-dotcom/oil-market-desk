# HANDOFF — Marlon's Watchtower (brief for the next agent)

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

## Recent work log (this build)
Commodity Desk rebranded from the oil-only "Oil Basis"; merged COMMODITIES+PRICE TRENDS; ranges 1M–10Y with hover %; currencies chartable; Phase 3 global macro (rates, FX, commodity↔currency links, copper/gold). Then: `MARKETS` (7 segments), adaptive Big Picture (what happened / what's next / trade ideas), `/api/marketread`, CFTC positioning generalized then **removed from the UI**, `/api/termstructure`, palm oil, actionable trade ideas with ETFs + EM names, cross-asset transmission engine, 2-tab IA (ships/satellites under Crude; fuels/stocks under Refined; supply under energy), hero headlines board, fundamentals event-scanner, context-aware tickers, macro regions → countries with World Bank fundamentals + BIS policy rates + CPI charts + index-vs-currency chart, region-scoped currencies, country-specific commodity linkages, instant country switching (cache + prefetch), Bloomberg-style country cards. Then **roadmap item 1 — deltas + freshness**: every price now shows 1D/1W/1M/YTD/1Y + a source/as-of badge. Then **roadmap item 2 — two stretch scores**: the old price-only "stretch" is now "price stretch", joined by a fundamentals-based "physical tightness" (curve + basis + stocks-vs-seasonal). Then **roadmap item 3 — HOME tab**: cross-segment watchlist + a merged alerts board (server + thresholds) + the 8-segment board, as the default landing. Then **roadmap item 4 — on-screen daily brief**: `/api/brief` + a HOME DAILY BRIEF panel (what happened / what's on today). Then **roadmap item 5 — compare / spread**: a COMPARE panel overlaying any two series (indexed or difference) + chartable FRED rates. Then **roadmap item 6 — seasonality**: a 5-yr seasonal grade + forward bias for gas/grains/softs. Then **roadmap item 7 — curve carry**: numeric roll yield ($/unit/month + %/yr) and a calendar-spread ladder in the curve panel. Then **roadmap item 8 — one read**: merged WHAT IT MEANS + KEY TAKEAWAYS + READING THE NUMBERS into a single THE READ panel (+ detail fold), and moved the live headlines board off the top of every page into HOME. See the roadmap entries above. 53 tests. Then **industrial metals + livestock (2026-10-12)**: removed **nickel** (no free daily source; the ETC proxy `NICK.L` correlated only 0.71 with real nickel and moved in opposite months — misleading) and replaced it with **Aluminium** (`ALI=F`, COMEX, $/t, with contract months), and added a new **Livestock** segment (`LE=F` live cattle, `HE=F` lean hogs, `GF=F` feeder cattle — protein/food inflation). `MARKETS` is now **8 segments** / **24 benchmarks**; `getMarket` notes, `MARKET_CONTENT`, `NEWS_QUERIES`, `SCAN_QUERIES` and the Indonesia commodity link all updated; the aluminium curve resolves. 59 tests. Then **signed price scoring (2026-10-12)**: the price "stretch" was rebuilt as a **signed** −100…+100 read (rich ↔ cheap) because the old symmetric score labelled a market at 2-yr lows as "stretched" (lean hogs: −23% y/y, 0th percentile → wrongly 78/STRETCHED; now −83/VERY CHEAP). Every input is a percentile of the market's own history (2y/10y range position + self-normalised 3-mo/1-yr moves), so scores are comparable across commodities; volatility moved out to its own line. `src/lib.js` gains `signedPosition`/`signedMove`/`stretchLabel`; the READ panel now reads "IS X RICH, CHEAP OR TIGHT?" with plain-word labels; `app.js?v=40`. 59 tests. Then **Dairy segment (2026-10-12)**: new **Dairy** segment (group `Dairy`) covering the full CME complex — Class III Milk (`DC=F`), Butter (`CB=F`), Nonfat Dry Milk (`GNF=F`), Cheddar Cheese (`CSC=F`), Dry Whey (`DY=F`). All are live daily on Yahoo with contract months (so each has a real curve) and current CFTC COT series (`MILK, Class III`, `BUTTER (CASH SETTLED)`, `CHEESE (CASH-SETTLED)`, `NON FAT DRY MILK`, `DRY WHEY`); no free spot/inventories, so physical tightness stays `null` (labelled). `MARKETS` is now **9 segments** / **29 benchmarks**; added `MARKET_CONTENT.dairy`, `NEWS_QUERIES.dairy`, `SCAN_QUERIES.dairy`, `CURVE_SPEC` CME entries and the dairy COT names. No client change needed (picker/board are generic). 59 tests. Then **soybean complex + crush (2026-10-12)**: added **Soybean Meal** (`ZM=F`, $/ton) and **Soybean Oil** (`ZL=F`, ¢/lb) to the (now renamed) **Grains & oilseeds** segment — both have live daily prices, real contract-month curves and current CFTC COT (`SOYBEAN MEAL`/`SOYBEAN OIL`). New pure helper `computeCrush` (board crush = meal×48/2000 + oil×11/100 − beans/100 $/bu, plus the **oil share**), served by a new **`/api/crush`** (current + 1-yr percentile + 6-mo history). A **SOYBEAN CRUSH** panel on COMMODITIES (grains) shows the margin, the oil share, the three legs and a twin-axis history chart; `app.js?v=41`. 61 tests. Then **supply & demand score (2026-10-12)**: the tightness read became **SUPPLY & DEMAND** — the futures curve now feeds *every* commodity (energy adds spot basis + weekly US stocks; ags/dairy/livestock add USDA stocks-to-use when present), with an **evidence badge** (`real data` vs `curve only`) and plain labels UNDERSUPPLIED · TIGHT · BALANCED · WELL SUPPLIED · OVERSUPPLIED (pure `sdLabel`). Curve-only reads carry a class caveat (metals: financing cost; crops/livestock: seasonal); livestock curves enabled (`LE`/`HE`/`GF`, CME); precious metals stay honestly blank. `app.js?v=42`. 62 tests. Then **USDA supply/demand (2026-10-12)**: added `scripts/fetch-usda.mjs` → `data/usda.json` (keyless USDA PSD bulk CSVs; **US stocks-to-use** = ending stocks ÷ (domestic consumption + exports), by market year, 30-yr history) and wired it into the S&D score as a **real-fundamental leg** for corn / wheat / soybeans / soymeal / soyoil / butter / cheese / NFDM / beef / pork — those now read `physical` (real data + curve), not curve-only. Refreshed weekly by `scripts/snapshot-and-push.sh` (Render can't be relied on to fetch+parse the big CSVs); the read shows the stocks-to-use row + year. `app.js?v=43`. 62 tests. Then **news tilt (2026-10-12)**: the FUNDAMENTALS panel now shows a **qualitative news tilt** (bullish vs bearish tagged shocks) — deliberately **NOT scored** into supply & demand, since headlines are keyword-tagged prompts, not data. `app.js?v=44`. Then **chart kit (2026-10-12, Phase 1 — standardize)**: every chart now comes from **one kit** in `public/app.js` — `baseOptions({dp,unit,percentAxis,yTitle,y1Title,legend,log})` (shared grid/axes/legend + a unified tooltip: value + % change over the window, plus "vs ●" on the main chart when an anchor is set), `mountChart(id,data,opts,plugins)` (a `charts` registry so re-renders update in place — no leaks, no 0-height canvases), a **`CT` role palette** (c1 futures / c2 real / c3 / c4 / accent) replacing ~12 ad-hoc hexes, one empty state, and unified heights via `.chart-wrap` / `.lg` / `.sm`. All 12 charts migrated; `chartOpts()` removed; **no new controls** (deliberately, to stay intuitive). `app.js?v=45`, `style.css?v=23`. 62 tests. **Planned next: Phase 2 — interactivity** (crosshair already exists; add drag-to-zoom + reset, legend series-toggles, and **event annotations** — EIA/WASDE/OPEC/news markers on the time axis — plus a forward-curve overlay and log/rebase). **Phase 3 — UX**: consolidate chart panels into PRICE / STRUCTURE / MACRO groups, persist per-panel prefs, mobile + a11y, PNG/CSV export. Then **chart event annotations (2026-10-12, Phase 2 · part 1)**: dated news shocks are drawn as faint vertical markers on the PRICE chart and listed under it (click → the source headline), built from `/api/fundamentals` (client-cached 5 min). `/api/fundamentals` now also carries `ageDays` (fixing a latent "NaNmo ago" bug in the panel). Deliberately **no zoom controls** — the 1M–10Y range selector *is* the zoom, and Chart.js legend clicks already toggle series for free — to stay uncluttered. `app.js?v=46`. 62 tests. Still open for Phase 2/3: drag-zoom, forward-curve overlay, log/rebase, panel consolidation, per-panel prefs, PNG/CSV export. Then **forward-curve overlay (2026-10-12, Phase 2 · part 2)**: a dashed line on the PRICE chart extends the **futures months** (from `/api/termstructure`, client-cached 5 min, up to 6 contracts) to the right of the last price — so the price chart now visually links to the "prices for months ahead" panel ("where the futures say it goes"). Segment benchmarks only; skipped when there is no curve (e.g. palm oil). `app.js?v=47`. 62 tests. Then **UX pass (2026-10-12, Phase 3)**: the app now **remembers your view** across visits (localStorage — `tab`, `segment`, chart `range`, compare `{a,b,range,view}`, `macroRegion`/`macroCountry`) and restores it on load, with **no new UI**. Accessibility: `aria-label`s on the key selectors + a `:focus-visible` outline for keyboard users. Mobile: control rows wrap. **Panel consolidation (PRICE/STRUCTURE/MACRO grouping) was deliberately deferred** — folding panels would hide content and fight the "answer-first" layout; revisit only if wanted. `app.js?v=48`. 62 tests. Then **move-explaining markers (2026-10-12)**: replaced the "every news date" markers (which read as green clutter) with **big-move markers** — the client detects the chart's largest swings (top ~4, well above the market's typical daily move) and the server looks up the news published in a tight window around each move (`/api/movewho`, Google News `after:`/`before:`, **tier-1 sources only** — Reuters / Bloomberg / FT / AP / CNBC), picking the closest, direction-consistent story. Only moves we can actually explain get a marker; the chips below link to the source (e.g. corn +4.6% → *"Corn Surges as USDA Makes Bigger-Than-Expected Cut to US Yield"*, Bloomberg). GDELT was trialled for a historical archive but is hard rate-limited (429) — Google News date operators proved reliable instead. `app.js?v=50`. 63 tests. Then **marker hover + headline chips (2026-10-12)**: hovering a move marker pops a tooltip with the **headline + source** (the client hit-tests the plugin-drawn marker x-position via `options.onHover`), and the chips under the chart now show the **headline text** instead of the generic "Market news" kind. `app.js?v=51`. Then **macro charts get the same treatment + missing indexes fixed (2026-10-12)**: the move-marker/hover pipeline is now **shared** (`attachMarkers`, a body-level hover tooltip positioned by the mouse) and applied to the macro **INDEX vs CURRENCY** chart and the **BOND YIELDS** chart (chips under each; hover → headline). `/api/movewho` now accepts **macro region/country ids** too (it resolves the news topic from `NEWS_QUERIES`, which already covered regions + countries). **Missing stock indexes fixed:** Thailand (`^SET.BK` is broken on Yahoo) → `THD`; Philippines → `EPHE`; Vietnam → `VNM` — trusted US-listed ETF proxies, labelled "ETF proxy". Bond-yield sources unchanged (no better free source, as agreed). `app.js?v=52`. 63 tests. Then **macro markers on every line + the Euro area (2026-10-12)**: the client now detects big moves across **every line on a chart** — so the macro chart's **currency** is annotated too, not just the index. Broadened the Euro-area news query (`ea`, 1/5 → 5/5 matched). Verified all **18 tracked countries**: index + currency big moves matched to tier-1 news (5/5 for every country). `app.js?v=53`. Then **marker coverage + stale-news fixes (2026-10-12)**: (1) **5Y/10Y charts had no markers** — those labels are `YYYY-MM` and the server's date filter rejected them; it now accepts month labels (news window ±15 days) → verified 5Y 3/3, 10Y 5/5 (incl. 2018/2020/2021 moves). (2) Clicking a commodity in the **component strip now also switches the PRICE chart** to that commodity, so its markers apply (before, the strip changed only the READ). (3) Added a per-chart **race guard** in `attachMarkers` (`$mseq`) so an in-flight news lookup can't land after a segment/country/metric switch — this was the "stale headlines" bug. `app.js?v=54`. 63 tests. Then **race guards + client cache (2026-10-12)**: every commodity loader (`loadMarketRead` / `loadNews` / `loadFundamentals` / `loadSeasonal` / `loadCrush` / `renderCurveForSegment` / `loadCurveHistory`) now captures the selection (`segKey()`) and **drops its result if the user switched away while it was in flight** — this fixes "I clicked oil but it still shows corn". `renderChart` got the same guard (metric/range/segment). Added **`jget(url, ttl)`**, a per-session memo cache, for the per-segment endpoints (read / news / fundamentals / curve / termstructure / curvehistory / movewho) so **re-visiting a segment is instant** and switching fires far fewer round-trips. `app.js?v=55`. 63 tests. Then **READ fixes — wrong segment + slow load (2026-10-12)**: (1) `selectMarket` never synced the segment picker and `renderSnapshot` read the picker instead of `currentMarket`, so switching via the HOME board / watchlist showed the **previous** segment's snapshot — now the picker is synced and `renderSnapshot` uses `currentMarket`. (2) Cold `/api/marketread` was **5–8s**, dominated by `curveFor` firing **14 sequential** Yahoo calls; the **front 6 are now fetched in parallel** (cold READ **8.2s → 1.4s**). (3) Attribution split to **`/api/marketwhy`** (lazily filled into `#read-attr`) + an instant **skeleton** showing the segment's price/6m while the verdict loads. (4) `cached()` now **de-dupes in-flight** requests (concurrent callers share one job). (5) A background **warm loop** precomputes every segment's READ every 8 min → **all segments ~0.7ms after warm-up**. `app.js?v=56`. 63 tests. Then **event-news hover, done properly (2026-10-12)**: replaced the floating `#chart-tip` card (screen-anchored → **stuck on scroll**, and needed 7px pixel-hunting) with the **news inside the normal Chart.js tooltip** — an invisible `$news` dataset with a point at each big move, whose tooltip line reads `📰 <headline> — <source> (+x%)`. Chart.js draws it on the canvas, so it **scrolls with the chart and hides properly**; the legend filters the synthetic dataset out. Coverage: **every commodity segment** (price chart) plus macro **index/currency, bond yields, US–JP 10-yr and central-bank-rate** (all countries). Hardened `detectBigMoves` for **stepped rate series** (a policy change counts even when most months are flat) — verified US Fed cuts → Reuters, BoE hikes → CNBC, RBI → Reuters. Removed the dead `#chart-tip` element + CSS. `app.js?v=57`. 63 tests. Then **event-news coverage + forgiving hover (2026-10-12)**: each event now covers a **±2–3 column hit band** (was a single column → needed pixel accuracy) and the tooltip line carries the event's **date** (`📰 08-12 · headline — source (+x%)`). Extended the markers to the **segment's own charts** — **cracking-margin history** (refined), **curve-over-time** (the segment), **crush** (grains) — and to the price chart's **gap/spread** metrics (news id derived from the metric). Net coverage: a segment shows news on its **price chart, curve-over-time and margins/crush**; macro shows it on **index/currency, bond yields, US–JP and central-bank rate**. (Compare and CPI stay unannotated: arbitrary overlays / annual.) `app.js?v=58`. 63 tests. Then **the marker plugin was only on the main chart (2026-10-12)**: `eventsPlugin` (which draws the dots/lines) was passed only in the *price* chart's `mountChart`, so the macro and segment charts had no visible markers — the tooltip news existed but nothing showed WHERE to hover, so they looked empty. Fixed by **`Chart.register(eventsPlugin)`** (global — it no-ops on charts with no events) and dropping it from the price chart's per-chart plugins. Every annotated chart now draws its markers. `app.js?v=59`. 63 tests. Then **rate changes shown in pp/bp, not % (2026-10-13)**: for **rate/yield charts** a *relative* change is meaningless — a policy rate near zero made it explode (Japan's tooltip read ≈ −1000%). Rate charts (policy rate, bond yields, US–JP) now format the change as **basis points / percentage points** (`+20 bp`, `−25 bp`, `+1.50 pp`) in both the tooltip and the move chips, and their move detector uses the **absolute** change (a 5 bp move is 5 bp, not ±100%). Added `chgText`/`moveText`; threaded a `mode` ('pct'|'abs') through `attachMarkers`→`chartMoveMarkers`→`detectBigMoves`; `winPct` removed. `app.js?v=60`. 63 tests. Then **news relevance gate (2026-10-13)**: news was matched on tier-1 + date + direction only, so a **US–Japan yield move could show a UK or China story** (the query terms are broad — e.g. "interest rates"). Added **`NEWS_MUST`** — a per-id (segment / region / country) list of patterns a headline must match to be attached — applied in **`getMoveWho`, `getFundamentals`, `getNews` and `getAttribution`**, on top of the tier-1 + date + direction match. Some patterns are case-sensitive on purpose (`/\bUS\b/` so the pronoun "us" doesn't match). Verified: a US move now shows **Fed** stories, Japan shows **BoJ**, crude shows **oil**, grains shows **corn**, precious shows **gold**; the panels stay populated (thin-but-on-topic where tier-1 coverage is genuinely sparse). 63 tests. Then **news context + precision (2026-10-13)**: an attached story must now (1) **name the specific instrument** on the chart (`NEWS_FOCUS` — a cocoa chart prefers cocoa over sugar; the API returns `match: instrument|segment`), (2) **agree with the move's direction** — a new `newsDir` reads the headline's own up/down words ("surges / soars / rallies" vs "plunges / slides / falls") and a story that contradicts the move is **dropped**, and (3) be **ranked by topical relevance** (`mustScoreFor` weighs *where* the topic sits in the headline — subject vs passing mention). `/api/movewho` takes a `focus` param. Verified: corn **up → "Corn Surges…"** and corn **down → "Corn Plunges…"** (both tagged `instrument`), and a bullish story is not attached to a fall. `app.js?v=61`. 63 tests. Then **professional price wording (2026-10-13)**: the signed price score's labels changed from RICH/CHEAP to **AT A BIG PREMIUM · AT A PREMIUM · AT A SLIGHT PREMIUM · IN LINE WITH HISTORY · AT A SLIGHT DISCOUNT · AT A DISCOUNT · AT A BIG DISCOUNT** (`stretchLabel`), the READ title now asks "IS X AT A PREMIUM, A DISCOUNT, OR TIGHT?", and the prose reads "trades **at a premium** versus its own history" (the middle label reads "is in line with history", so it never says "in line with history vs its own history"). Supply & Demand labels left as-is per the call. `app.js?v=62`. 63 tests. Then **fast first load + boot beacon (2026-10-13)**: the boot awaited one long chain (~8s cold) in which the heaviest requests (**flares 3.1s, sar 2.8s**) were *below the fold*. Split `loadExtra` into **`loadExtraCore`** (inventories / equities / chokepoints / analytics / flows / products) and **`loadExtraSlow`** (flares + sar → ships/satellite; macrodash + correlations + events → MACRO); the boot now renders the core then fires the slow half **after first paint** (and on demand when the MACRO tab opens). Also always `selectMarket(...)` at boot so a **first visit** loads the read (it was skipped when there was no saved segment). Added a **static boot beacon** — a sweeping-light watchtower with signal rings + a live status line ("loading history… → prices → reading the market…") — painted on the first byte, faded when the read is up (with 6s/9s safety nets) and disabled under `prefers-reduced-motion`. `app.js?v=63`. 63 tests. Then **kill the 47s curve-history stall (2026-10-13)**: `getCurveHistory` (25 contract-months of history, each ~1.7s + a 200ms sleep) was the single slowest request at **47s cold**, and it fired on every segment switch even though it sits below the fold. It is now **lazy** — fetched only when `#curvehist-block` scrolls into view (IntersectionObserver, 300px margin) — and **trimmed to 16 months / 120ms sleep** (~30s, cached 6h). The **boot beacon now waits for the segment's core**: the read **+ the price chart + the news** (`markReady`), not just the read — so the sub-second panel fill-in happens behind it. `app.js?v=64`. 63 tests. Then **radar boot beacon (2026-10-13)**: the loading screen became a **radar scope** — concentric range rings, a crosshair, an **eased sweep** (a conic-gradient arm on a `cubic-bezier` rotation), the **♜ core**, and **six contact blips that light for real load steps** (`bootStep` + `markReady`) — genuine progress, not a decorative spinner. Static markup (paints on the first byte), fades when the segment's core is up, and `prefers-reduced-motion` stops the motion. `app.js?v=65`. 63 tests. Then **concise welcome (2026-10-13)**: the onboarding intro was rewritten to a one-line lead + three short bullets (HOME / COMMODITIES / MACRO) — no segment enumeration, no wordiness. `style.css?v=24`. Then **mobile pass (2026-10-13)**: added `viewport-fit=cover` + a dark `theme-color`; a ≤640px block now **stacks panel headers** (`.ph`), bumps **tap targets to ≥36–44px** (tabs, ghost buttons, stars, selects), adds **safe-area insets** (notched phones), **`overflow-wrap`**, and **horizontal-scroll wrappers** for the tables (`.tbl` / `#analogue` / `.glossary`), and shortens the ticker; a ≤480px block compacts further. `style.css?v=25`.
- Then **fit-the-phone width (2026-10-13)**: the page could be forced wider than the screen by any single wide child — grid items default to `min-width:auto`, so "too big / won't fit". Added `min-width: 0` to the layout containers and their children, `max-width: 100%` on canvas/img/svg/table/pre, and `flex-wrap` on the mobile top bar, so the whole app now fits the portrait width. `style.css?v=26`. Then **fix the `/api/history` 500 (2026-10-13)**: it was the one route with **no `.catch`**, and `getHistory` fetched every Yahoo/FRED/EIA series with **no per-symbol guard** — so a single flaky upstream call rejected the whole `Promise.all` and the outer handler returned **500** (surfacing as "error /api/history -> HTTP 500"). Now each benchmark is fetched in its own try/catch, the route has a `.catch` returning a valid empty shape, and the client `loadHistory` **retries once then degrades to empty** rather than showing the error banner. `app.js?v=66`. 63 tests. Then **final sweep — hardening + tidy (2026-10-13)**: `/api/market` + `/api/analytics` now `.catch` to a safe shape (no bare 500s); the client's `loadMarket`/`loadTankers` keep their **last-good** payload and `refreshLive` no longer pops the error banner on a transient; the **glossary** was rewritten to cover all commodities + macro (it was oil-only); the **README** refreshed (three tabs, nine segments, the two scores, news-on-charts, positioning marked not-surfaced); **five dead functions removed** (`renderContext` / `renderBottomLine` / `renderTightness` / `renderRegime` / `renderKPIs`) + `kpiTile`; annotated charts now say *"No big move with a trusted-news match on this chart right now."* when empty. `app.js?v=67`. 63 tests. Then **tidy the mobile top bar + ticker (2026-10-13)**: the ≤640 block had **duplicate/conflicting top-bar rules** (from two earlier passes), so the header looked messy — rewritten to a clean **two-line layout** (wordmark on its own line, controls below). The ticker now moves **visibly** on phones (`animation-duration: 45s`), **touch pauses** it, and under `prefers-reduced-motion` it becomes **swipe-scrollable** rather than frozen. `style.css?v=27`. Then **fix the mobile ticker + de-crowd the header (2026-10-13)**: the ticker *froze on iOS* because the pause-on-hover rule (`:hover`) **latches after a touch and never releases** — made worse by a `:active` pause I had added. The hover-pause is now scoped to `@media (hover: hover)` and the `:active` pause is gone, so the 45s marquee runs on phones. The crowded header (clock · updated · CSV · DAILY BRIEF · ↻ · ?) is de-cluttered: **CSV + DAILY BRIEF now live in the footer on phones** (`.desk-only` / `.mobile-only`), leaving a tidy single-line header. `style.css?v=28`.
