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
- Current instruments (20): WTI, Brent, RBOB, ULSD, Jet, Propane, NatGas, Gold, Silver, Copper, Platinum, Palladium, Corn, Wheat, Soybeans, Sugar, Coffee, Cocoa, Cotton, **Palm Oil** (Yahoo `CPO=F`, front-month only — no curve).

### `MARKETS` — the segment layer (Big-Picture unit) — **7 segments**
```
crude       Crude oil          WTI + Brent
refined     Refined products   RBOB + ULSD + Jet + Propane   (all fuels merged)
gas         Natural gas        NatGas
precious    Precious metals    Gold + Silver + Platinum + Palladium
industrial  Industrial metals  Copper
grains      Grains             Corn + Wheat + Soybeans
softs       Softs              Sugar + Coffee + Cocoa + Cotton + Palm Oil
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

**HOME tab (default landing):** **📰 LIVE HEADLINES** (`/api/headlines`, tier-1 wire) → **☀️ DAILY BRIEF** (`/api/brief`: headline + what happened / what's on today) → **📌 WATCHLIST** — pinned instruments from any segment in one board (each tile shows price + 1D/1W/1M/YTD/1Y + a source/as-of badge; ★ toggles) → **⚠ ALERTS** — the server alert engine (`/api/alerts`: basis extremes, data checks, idle ships) merged with the client threshold engine, severity-sorted → **🔎 SEGMENTS AT A GLANCE** — the 7-segment board (click to open).

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
/api/markets               the 7 segments (registry + component meta)
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
/api/alerts /api/digest /api/brief /api/export.csv /api/seasonal?id= /api/products /health
```

## Data sources (all free)
| Need | Source | Key? |
|---|---|---|
| Futures, FX, indices | Yahoo Finance chart API | no |
| US + euro-area macro (rates, CPI, HICP) | FRED CSV (`fredgraph.csv`) | no |
| Annual fundamentals per country (GDP growth, debt/GDP, CPI, unemployment) | **World Bank** API | no |
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
6. **Country gaps:** Singapore has **no policy rate** (MAS runs S$NEER FX policy — benchmark is SORA, not wired); Taiwan/Vietnam have no free index and no BIS policy rate; Philippines index isn't free.
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
Agreed order (impact-weighted):
1. ~~**Deltas + freshness everywhere** — every number shows chg vs 1d/1w/1m/YTD/1y, plus a source + as-of badge.~~ **DONE (2026-10-12)** — pure `horizonDeltas` in `src/lib.js`; `/api/history` carries per-instrument deltas, `/api/market` rows carry source + as-of, `/api/country` + `/api/region-quotes` carry deltas; instrument tiles, segment snapshot, top ticker, country cards and the region currency board all show a 1D/1W/1M/YTD/1Y strip + a source/as-of badge. Deltas come from a 2-year daily window (a plain 1y range leaves the 1Y move null). The macro marquee tape stays 1D; structure data (inventories/curve/COT) keeps its existing as-of labels.
2. ~~**Fundamental "stretch" score** — rebuild the score from curve + basis + inventories-vs-seasonal (not just price range/vol), or rename it "price stretch".~~ **DONE (2026-10-12)** — split into two honest scores: **price stretch** (price range + vol, renamed) and **physical tightness** (curve + real-vs-futures basis + stocks-vs-seasonal, re-weighted over whatever exists; pure helpers `curveTightness`/`inventoryTightness`/`weightedScore` in `src/lib.js`). Precious metals are excluded from the curve input (their curve is rates/carry, not tightness) so they show "no free data" rather than a fake number. Metals/ags are curve-only; the panel notes what's missing.
3. ~~**Watchlist + Alerts home screen** — pin instruments, one board, alerts firing.~~ **DONE (2026-10-12)** — new **HOME** tab (default landing): a cross-segment **watchlist** board (pinned instruments, reusing the deltas + freshness tiles), an **alerts** board merging the server engine (`/api/alerts` — basis extremes, data checks, idle ships; previously never fetched by the UI) with the client threshold engine, severity-sorted, plus the 7-segment board (revived the dead `renderMarketState`). Thresholds still edited in COMMODITIES → MORE DETAIL.
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

## Recent work log (this build)
Commodity Desk rebranded from the oil-only "Oil Basis"; merged COMMODITIES+PRICE TRENDS; ranges 1M–10Y with hover %; currencies chartable; Phase 3 global macro (rates, FX, commodity↔currency links, copper/gold). Then: `MARKETS` (7 segments), adaptive Big Picture (what happened / what's next / trade ideas), `/api/marketread`, CFTC positioning generalized then **removed from the UI**, `/api/termstructure`, palm oil, actionable trade ideas with ETFs + EM names, cross-asset transmission engine, 2-tab IA (ships/satellites under Crude; fuels/stocks under Refined; supply under energy), hero headlines board, fundamentals event-scanner, context-aware tickers, macro regions → countries with World Bank fundamentals + BIS policy rates + CPI charts + index-vs-currency chart, region-scoped currencies, country-specific commodity linkages, instant country switching (cache + prefetch), Bloomberg-style country cards. Then **roadmap item 1 — deltas + freshness**: every price now shows 1D/1W/1M/YTD/1Y + a source/as-of badge. Then **roadmap item 2 — two stretch scores**: the old price-only "stretch" is now "price stretch", joined by a fundamentals-based "physical tightness" (curve + basis + stocks-vs-seasonal). Then **roadmap item 3 — HOME tab**: cross-segment watchlist + a merged alerts board (server + thresholds) + the 7-segment board, as the default landing. Then **roadmap item 4 — on-screen daily brief**: `/api/brief` + a HOME DAILY BRIEF panel (what happened / what's on today). Then **roadmap item 5 — compare / spread**: a COMPARE panel overlaying any two series (indexed or difference) + chartable FRED rates. Then **roadmap item 6 — seasonality**: a 5-yr seasonal grade + forward bias for gas/grains/softs. Then **roadmap item 7 — curve carry**: numeric roll yield ($/unit/month + %/yr) and a calendar-spread ladder in the curve panel. Then **roadmap item 8 — one read**: merged WHAT IT MEANS + KEY TAKEAWAYS + READING THE NUMBERS into a single THE READ panel (+ detail fold), and moved the live headlines board off the top of every page into HOME. See the roadmap entries above. 53 tests.
