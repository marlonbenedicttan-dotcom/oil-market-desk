# INVESTOR BACKLOG — instruction note for the next agent

Read `HANDOFF.md` first (architecture, registries, conventions, deploy). This note is the
**investor-value** backlog: what to add to make the desk actually useful to someone putting money
to work, in the order it should be done. Do them **one at a time: code + tests + deploy**.

---

## Why this list (the investor workflow)

An investor using this desk runs a loop:

**1) What's the regime? → 2) Where's the opportunity/extremity? → 3) Why? → 4) Alert me → 5) How do I size/express it?**

The app is already strong on **2–3** (segments, basis, curve + carry, seasonality, two honest
scores, transmission, daily brief). It is weak on **1 (regime), 4 (alerts), 5 (risk/expression)**.
Close those gaps and it goes from "nice dashboard" to "desk I check every morning".

## Already built — do NOT rebuild
- Deltas (1D/1W/1M/YTD/1Y) + source/as-of badges; a **signed** price-vs-history score (rich ↔ cheap) and physical-tightness scores.
- HOME (brief → watchlist → alerts → headlines → segments), on-screen daily brief (`/api/brief`).
- Compare/spread panel, seasonality grade, curve carry + calendar spreads, bond yields + US–JP spread.
- Cross-asset transmission (narrative), fundamentals scanner, ships/satellites, macro country cards.
- `scripts/fetch-macro.mjs` + `data/macro.json` snapshot pipeline (see "Snapshot pattern" below).

---

## TIER 1 — high value, mostly free or already half-built

### 1. Surface positioning (CFTC COT) — the biggest free win  ⭐ **DONE (2026-10-13)**
**Shipped:** a **📊 POSITIONING** panel on COMMODITIES (the segment's primary + an "also covered"
strip): managed-money net, **3-yr percentile**, WoW change, long/short split, open interest, a 3-yr
net sparkline, and a **CROWDED LONG / STRETCHED / WASHED-OUT / NEUTRAL** flag with a plain read.
`/api/positioning?segment=<seg>` bundles every COT-covered component in one call; the daily brief
adds a positioning line when crude is crowded. Pure `positioningFlag`/`positioningRead` in `src/lib.js`.
**Why:** crowding is where pain comes from. Price tells you *what*; positioning tells you *who*.
**Already built:** `getPositioning(id)` (server.js) and **`/api/positioning?id=`** are live but the
UI never calls them (it was deliberately removed earlier — reverse that decision). It returns
`{ label, unit:'contracts', latest:{date,net,...}, pct (3-yr percentile), wow (week change), ... }`.
Coverage = every `COT_NAMES` benchmark (wti, brent, rbob, ulsd, natgas, gold, silver, copper,
platinum, palladium, corn, wheat, soybean, sugar, coffee, cocoa, cotton, palm). Weekly (Fri), free.
**Do:** add a POSITIONING panel to COMMODITIES (segment's primary, or a component strip):
managed-money net, **3-yr percentile**, **WoW change**, long/short split, and a **"crowded" /
"washed-out"** flag (e.g. pctile ≥ 90 crowded, ≤ 10 washed-out). Add it to the daily brief and the
screener. Reuse the existing `renderKPIs`-style tile.
**Honesty:** label it "CFTC, weekly (as of <date>)"; it lags ~3 days.

### 2. Cross-asset "markets at a glance" board (the missing *regime* view)  ⭐ **DONE (2026-10-13)**
**Shipped:** a **🌐 MARKETS AT A GLANCE** board on HOME — DXY · VIX · US 10y · S&P 500 · gold ·
copper · WTI · Brent — each cell with its level, **1D/1W/1M/YTD/1Y strip**, and a source/as-of line,
served by `/api/regime` (Yahoo + FRED; the 10y shows **pp/bp**, not %, via `horizonDeltasAbs`).
**Why:** every session starts with risk-on/off. Today the only board is commodities.
**Do:** one compact board: **DXY, VIX, US 10y, S&P 500, gold, copper, WTI, Brent** — each with the
existing 1D/1W/1M/YTD/1Y strip + as-of badge. Put it on MACRO (or HOME, under the brief).
**Data:** already fetched — `/api/macrodash` (fx + corr), `/api/macro`, `/api/yields` (US 10y),
`/api/market` (gold/copper/WTI/Brent). No new source needed; just assemble.
**Honesty:** label VIX/indices as Yahoo (delayed).

### 3. Screener / leaderboard across all instruments  ⭐ **DONE (2026-10-13)**
**Shipped:** a **🔎 SCREENER** panel on HOME — all 31 instruments in one **sortable** table
(INSTRUMENT · LAST · 1D/1W/1M/YTD/1Y · STRETCH · TIGHT · BASIS% · CROWD), assembled server-side by
**`/api/screen`** (deltas + `/api/history`, the two scores + `/api/marketread`, basis percentiles +
`/api/analytics`, positioning + `getPositioning`). Click a header to sort, a row to open its chart.
**Why:** "where do I look today?" — the app answers this for one segment, not the universe.
**Do:** a sortable table ranking all ~20 benchmarks by: biggest **1D/1W mover**, most
**price-stretched**, most **physically tight**, most extreme **seasonal** position, highest
**basis percentile**, and (after #1) most **crowded**. Link each row to its chart.
**Data:** all present (`/api/history` deltas, `/api/marketread` per segment, `/api/analytics`,
`/api/seasonal`, `/api/positioning`). Consider a single `/api/screen` that assembles it server-side
so the logic is testable — pure scoring lives in `src/lib.js`.
**Why it matters:** this is the piece that makes the app "answer first" instead of "explore".

### 4. Custom alerts (user-set levels)  ⭐ **DONE (2026-10-13)**
**Shipped:** a **⚙ MY RULES** builder in the HOME alerts panel — pick a **metric** (any instrument
price, any real-vs-futures basis, or any currency), a **condition** (`is above` / `is below` /
`crosses`), a **level** and an optional note; rules persist in localStorage (`oilbasis.rules`),
evaluated on every refresh, and appear in the alerts board + fire a **browser notification**.
**Honesty:** a footnote says it is checked client-side while the tab is open.
**Why:** a desk lives on "tell me when X crosses Y". Today alerts are only 4 fixed thresholds.
**Already built:** the alert engine, `/api/alerts`, the browser `Notification` path, and a
threshold editor UI (localStorage `oilbasis.thresholds`) — but only for brent/wti/diesel/idlers.
**Do:** a general rule builder: `{ metric (any chartable id: bench | basis:<id> | fx:<id> |
rate:<id>), op (>, <, crosses), level, note }`, stored in localStorage, evaluated on each refresh
(the data is already in `history`/`data`). Fire a browser notification + a HOME alert entry.
**Honesty:** client-side = only while the tab is open; say so. Server-side (email/webhook) already
exists via `deliver()` if you want always-on.

### 5. Economic calendar (actual / forecast / previous)  ⭐ **DONE (2026-10-13)**
**Shipped:** a **📅 ECONOMIC CALENDAR** panel on HOME — dated upcoming releases with the source and a
day-count: EIA weekly, CME expiry, **FOMC rate decisions** (parsed from the Federal Reserve's own
keyless calendar page, with the published 2026 schedule as a fallback), USDA WASDE, OPEC+, and FRED's
release calendar when a free `FRED_API_KEY` is present. `/api/calendar`; the DAILY BRIEF reuses it.
**Honesty:** **no forecast is invented** — the panel says so ("dates only — no free consensus").
**Why:** "what's on today" used to list only EIA/expiry/OPEC.
**Do:** extend `getEvents()` (server.js) into a calendar. **FRED release calendar is free** (release
dates + values; consensus is the hard part — show "previous" and "released" and label forecasts as
unavailable rather than inventing them). US-focused is fine to start; the country cards can reuse it.
**Honesty:** never fabricate a consensus number.

---

## TIER 2 — valuable, more work

- ~~**Currency-adjusted returns** — a EUR/JPY investor wants local-currency P&L, not just USD. Add a
  base-currency toggle (reuse the `fx:` series in the compare engine).~~ **DONE (2026-10-13)** — a
  **base-currency selector** on the SCREENER (USD/EUR/GBP/JPY/CNY/CAD/AUD/CHF); the 1D–1Y columns
  become local-currency returns. `/api/fxadjusted?base=`; pure `fxAdjust` in `src/lib.js` (tested).
- ~~**Risk metrics** — max drawdown, realised-vol term structure, and a real **correlation matrix**
  (the transmission engine is narrative; `pearson` already exists in `src/lib.js`).~~ **DONE
  (2026-10-13)** — `⚠️ RISK & CORRELATION` on HOME: 1-yr max drawdown + a 30/60/90-day realised-vol
  term structure per key asset, and a colour-coded **correlation matrix** over ~1y of daily
  log-returns. `/api/risk`; pure `maxDrawdown`/`realizedVolTerm`/`corrMatrix` in `src/lib.js` (tested).
- **Options signals** — open interest, put/call, IV rank, skew. Yahoo options chains give partial
  data; this is a genuine investor signal but coverage is uneven — label it.
- **Positioning-vs-price divergence** — "price up while specs cut" is a classic tell (natural
  follow-on to #1).

## TIER 3 — likely out of scope / paid
- Portfolio & P&L (entry, size, exposure) — turns it into a PMS, a different product.
- Global S/D balance, OPEC spare capacity, fund flows, real-time LME/USDA — paid or not free.
- Non-COT positioning — many ags/softs have no free COT.

## Deprioritise
- **Roadmap #9 (single macro picker)** — cosmetic, low investor value. Do it last or drop it.

---

## Process & conventions (per item — copy HANDOFF.md)
- Zero-dependency Node ≥ 22. **Keep pure logic in `src/lib.js`** (unit-tested); the server and
  `public/app.js` stay thin. **Never fake a number** — label the source + as-of, show "—" / "n/a".
- `npm test` (`node --test`, ~54 tests) must stay green. Add a unit test for new pure helpers and an
  API-shape test for new endpoints. Run the suite before every push.
- **Bump `?v=`** on `style.css` / `app.js` in `public/index.html` after front-end changes.
- Deploy = **`git push` to `main`** → Render auto-deploys (~2–3 min). Verify live (poll for the new
  `app.js?v=`, then hit the endpoint). If you change the Dockerfile/image, **`COPY` any new top-level
  dir into the image** (a missing `COPY data ./data` silently broke the macro snapshot once).

## Snapshot pattern (for any source the deploy host can't reach)
The deploy host (Render) is blocked from some sources (verified: **imf.org → 403 WAF**). The fix is
to **fetch where you can and serve a committed snapshot**:
- Fetcher: `scripts/fetch-macro.mjs` (pulls IMF WEO → `data/macro.json`; completed years only).
- Fetcher: `scripts/fetch-usda.mjs` (pulls USDA PSD bulk CSVs → `data/usda.json`; US stocks-to-use, keyless).
- Runner: `scripts/snapshot-and-push.sh`, scheduled weekly by the launchd agent
  `~/Library/LaunchAgents/com.marlon.watchtower.macro.plist` (runs on the user's Mac, whose IP
  reaches the IMF). It fetches → commits → pushes → Render redeploys.
- Server reads `data/macro.json` at startup and prefers it (then FRED/OECD, then World Bank).
Use this pattern for any future blocked source — don't whack-a-mole per endpoint.

## Gotchas
- **GitHub Actions workflows can't be pushed with the current credentials** (no `workflow` scope).
  A ready `.github/workflows/macro-snapshot.yml` is left **untracked** locally; if you get a token
  with `workflow` scope you can move the snapshot runner to CI (no Mac dependency).
- Non-US bond yields have **no fresher free source** than the OECD (which FRED mirrors) — don't
  chase it; US is daily, others monthly (~1–2 mo lag) is the source's limit.
- Real-barrel spot prices **lag days**; World Bank annual data can be years old (debt/GDP is now
  fixed via the IMF snapshot).
- The user's OpenCode session **is** the environment — restarting OpenCode ends the conversation.

## Suggested order
1 → 2 → 3 → 4 → 5. After #1–3 the app answers "regime + opportunity" on load; #4–5 make it a desk
you rely on rather than visit.
