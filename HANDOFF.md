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
