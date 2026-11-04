---
title: Oil Market Desk
emoji: 🛢️
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Marlon's Watchtower 🗼

**🔴 Live:** https://oil-market-desk.onrender.com

A free, self-hosted **commodities + companies + macro desk**. Four tabs — **HOME · COMMODITIES · MACRO · COMPANIES** — and every number is followed by a plain-English read: price vs its own history, supply & demand, valuation vs its own history, and the trusted news behind the biggest moves.

The whole thing is one Node process with **no runtime dependencies**: Node's built-in HTTP server and `fetch`. Requires Node 22+.

## The four tabs

### HOME — the board
- **Daily brief** — the day's read in prose, with the news that explains it.
- **Regime board** — where the market is in its cycle, in one line per segment.
- **Screener** — every instrument, sortable, with the moves that matter.
- **Risk** — how far each market is from its 1-year high, whether its volatility is normal for it, and what moves together or hedges.
- **Calendar** — FOMC (live from the Fed), FRED releases (optional key), and TradingView's global economic calendar, high-impact first.
- **Watchlist + headlines** — your names, the tape, and the wires.

### COMMODITIES — one segment at a time
Nine segments: **crude · refined products · natural gas · precious metals · industrial metals · grains & oilseeds · softs · livestock · dairy**. A single segment picker drives the tab.

- **Read** — "is this segment tight?" with an evidence badge (real fundamentals vs *curve only*).
- **Charts** — 1M · 3M · 6M · YTD · 1Y · 5Y · 10Y, hover for the window's % change, click to anchor and measure.
- **Curve** — prices for months ahead, per segment (palm oil is front-month only).
- **Basis** — paper vs physical, sign-coloured, for the energy benchmarks.
- **Seasonality, crush, steel margin** — where the segment has a real one.
- **Positioning** — CFTC COT per segment, with a divergence read.
- **Options, crack spreads, supply** — refined products; US stockpiles and gas storage for energy.
- **Transmission** — what a move here does to other segments and regions.
- **News on the charts** — the biggest moves, each tied to the story behind it.

### MACRO — country by country
- **Eight regions**: Americas · Europe · Japan · China · India · Asia-Pacific · Middle East · Africa, with a country picker.
- **Policy rate** history and **bond yields**, with the events marked.
- **Inflation, growth, benchmark index** per country.
- **20 FX pairs** where every pair charts over time.
- **Commodity ↔ currency links** — does AUD still track copper, does CAD still track oil?
- **Catalysts** — the releases and meetings that can move the next week.
- **Copper/gold** growth proxy and US–Japan spread panels.

### COMPANIES — profiles & financials
Six markets, same UI:

| Market | Universe | Financials |
|---|---|---|
| 🇺🇸 United States | S&P 500 — **503 securities / 500 companies** (SPY holdings) | SEC XBRL, latest annual 10-K |
| 🇯🇵 Japan | TSE Prime — **1,547 companies** with a market cap | JPX / J-Quants, JPY |
| 🇰🇷 Korea | KOSPI — **725 companies** | DART, KRW |
| 🇹🇼 Taiwan | TWSE — **1,084 listed companies** | TWSE master + stockanalysis, TWD |
| 🇭🇰 Hong Kong | HKEX main board — **1,930 companies** with a statement page | HKEX tape + stockanalysis, HKD/CNY/USD |
| 🇦🇺 Australia | ASX — **1,650 companies** with a current share count | ASX CSV + stockanalysis, AUD/USD |

- Search, filter, compare, and chart any company.
- **Valuation vs its own history** — P/E, P/B, EV/EBITDA percentiles over five years, plus sector aggregates.
- **Themes** — the names behind a story, across all markets.
- Financials are **filed values, not estimates**. Market cap uses the **current shares outstanding** (vendor statistics page; SEC 20-F/10-K/10-Q cover for ADRs; US listing × CDI ratio for ASX CDIs; filing count as the last fallback) so post-period placements and buybacks are reflected; FCF is **operating cash flow − capex**; dividend yield uses the **vendor's payment-date yield**, falling back to the latest annual DPS. Statements older than 450 days are excluded and listed in the audit. Every ratio is recomputed from its own inputs and the audit cross-checks a sample against the vendor's statistics page.
- **Book equity is on the newest balance-sheet instant** — the latest 10-Q/10-K in the US, the latest quarterly report in Korea — so P/B and ROE do not divide a TTM profit by year-old equity. US EPS growth is split-aware and withheld when the EPS/share series cannot be reconciled; Japan/Korea cash flow is labelled **CASH AFTER INVESTING (CFO+CFI)** because those summaries do not break out capex.
- **Growth, on the same rules as the US**: revenue CAGR, split-adjusted EPS growth, and the net-margin change over the five fiscal years on file. Hong Kong, Australia and Korea show them on the company page and in the screener; a loss at either end is shown as the EPS move instead of a misleading percentage.

## Data sources (all free)

| Data | Source | Notes |
|---|---|---|
| Paper (futures) | Yahoo Finance — `CL=F`, `BZ=F`, `NG=F`, … | no key |
| Physical (spot) | FRED / EIA — `DCOILWTICO`, `DCOILBRENTEU`, … | no key, ~1 day lag |
| Stockpiles, propane, jet | EIA | `EIA_API_KEY` (free) |
| Positioning | CFTC public reporting | no key |
| Macro | FRED, the Fed, TradingView calendar | `FRED_API_KEY` optional |
| US company financials | SEC XBRL | SEC asks for a contact UA |
| Japan | JPX / J-Quants | `JQUANTS_API_KEY` (free) |
| Korea | DART / Naver | `DART_API_KEY` (free) |
| Taiwan | TWSE OpenAPI + stockanalysis.com | no key |
| Hong Kong | HKEX daily quotation report + stockanalysis.com | no key |
| Australia | ASX listed-companies CSV + stockanalysis.com + Yahoo | no key |
| News | tier-1 wires via Google News RSS | headlines + links only |

**Benchmarks** — WTI (Cushing), Brent, RBOB, ULSD/heating oil, jet fuel (spot only), propane (spot only), natural gas (Henry Hub), plus the Brent − WTI spread (paper & physical). Adding a benchmark is one row in the `BENCHMARKS` table in `server.js`.

## Run it

```sh
npm start
# → http://localhost:4173
```

Copy `.env.example` to `.env` for the optional keys. Nothing is required to boot — the paid-ish feeds simply stay dark.

```sh
npm test          # 200+ tests: pure helpers, data invariants, API smoke, front-end regressions
npm run audit:all # cross-checks every published ratio against its inputs
```

## Alerts, digest & subscriptions

The server runs an alert engine (every 5 min) and a daily digest (`DIGEST_HOUR`, default 07:00 local). Delivery:

| Channel | Enable with | Notes |
|---|---|---|
| Desktop notification | on by default (macOS) | `NOTIFY=off` on a server |
| Webhook | `WEBHOOK_URL` | POSTs `{subject, text}` to Slack/Discord |
| Email — Resend | `RESEND_API_KEY` + `DIGEST_TO` | quickest; free tier sends from `onboarding@resend.dev` to your own address |
| Email — SMTP | `SMTP_USER`, `SMTP_PASS`, `DIGEST_TO` | needs `npm i nodemailer` |
| Log file | always | `digest.log` |

**Email sign-up** (`/api/subscribe` → `/api/confirm` → `/api/unsubscribe`) is a double opt-in. A Resend key without a verified domain only delivers to the account owner, so the UI reports that honestly instead of accepting a stranger's address and failing. Public email sign-up therefore needs either SMTP or a verified Resend domain.

**Durable state.** Subscribers, alert rules and cooldowns live in `.state.json`. Render's free tier wipes the filesystem on redeploy *and* on every sleep/wake, so set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (free Upstash, plain REST — still zero dependencies) or those lists will not survive. `/api/notify` reports `subscribers.durable` so you can see which mode you are in.

Server-side alert rules (`/api/rules`) are site-wide, so they require the optional login: set **both** `AUTH_USER` and `AUTH_PASS`.

## Deploy it

The app is a long-running Node process — use a container host (Render, Railway, Fly.io), not a serverless platform.

**Render (easiest):** push to GitHub → **New → Blueprint** → pick the repo (it reads `render.yaml`) → add `EIA_API_KEY` (and any other secrets) in the dashboard.

**Docker (any host):**
```sh
docker build -t watchtower .
docker run -p 4173 -e EIA_API_KEY=... watchtower
```

**Keep the free instance awake.** Render sleeps after ~15 minutes idle and a cold start takes 20–30s, which reads as "broken". Two free keepalives are wired:

- `.github/workflows/keepalive.yml` — pings `/health` every five minutes from Actions.
- `workers/keepalive/` — a Cloudflare Worker cron doing the same (`cd workers/keepalive && npx wrangler deploy`).

Self-hosted assets mean a repeat visit downloads only what changed: `app.js`, `style.css` and Chart.js are immutable for a year behind `?v=`.

## Caveats

- Futures are the front-month **continuous** series (not roll-adjusted); the **curve** is the roll-free structure signal.
- Spot assessments publish with a **lag** and are a different instrument from the futures — read the on-screen DATA QUALITY flags.
- Dubai, WTI Midland and Mars need a paid feed (Kpler, Vortexa, Nasdaq Data Link).
- **No free real-vs-futures basis or inventories for metals and agriculture** — deliberately not shown rather than faked.
- Japan publishes JPX's trailing ROE beside the fiscal-year profit without a `roeBasis` label; 41 Korean FY-basis P/Es are young listings/REITs without four quarters. Both are flagged in the data.
- Macro is honest about coverage: free non-US CPI/GDP feeds are stale, so stale numbers are not published as current.
- Not investment advice.

## Layout

```
server.js          the whole backend (HTTP + feeds + ratios + alerts)
src/lib.js         pure helpers (unit-tested)
public/            app.js, style.css, index.html, self-hosted Chart.js, icons
scripts/           one-shot builders and audits (companies, Japan, Korea, …)
data/              published snapshots the server serves
tests/             200+ tests (node --test)
workers/keepalive/ Cloudflare Worker cron (optional)
```

## License

MIT
