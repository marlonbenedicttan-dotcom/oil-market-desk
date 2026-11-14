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
Ten markets, same UI:

| Market | Universe | Financials |
|---|---|---|
| 🇺🇸 United States | S&P 1500 — **1,506 securities / 1,500 companies** (SPTM holdings) | SEC XBRL, latest annual 10-K |
| 🇯🇵 Japan | TSE Prime — **1,547 companies** with a market cap | JPX / J-Quants, JPY |
| 🇰🇷 Korea | KOSPI — **725 companies** | DART, KRW |
| 🇹🇼 Taiwan | TWSE — **1,084 listed companies** | TWSE master + stockanalysis, TWD |
| 🇭🇰 Hong Kong | HKEX main board — **1,918 companies** with a statement page | HKEX tape + stockanalysis, HKD/CNY/USD |
| 🇦🇺 Australia | ASX — **1,652 companies** with a current share count | ASX CSV + stockanalysis, AUD/USD |
| 🇮🇳 India | NIFTY 500 — **494 companies** | niftyindices CSV + stockanalysis (NSE), INR |
| 🇮🇩 Indonesia | IDX — **810 companies** | stockanalysis IDX list + statements + vendor statistics (yield, float), IDR |
| 🇧🇷 Brazil | B3 — **314 listed: 303 domestic + 11 LatAm BDRs** | B3 list + statements, one class per issuer, plus the underlying US/TSX filings for the LatAm BDR lens; BRL |
| 🇿🇦 South Africa | JSE — **226 built: 204 primary + 22 foreign-secondary** (244-line universe) | JSE list + statements, ZAR; foreign-domiciled lines use their primary exchange’s filings and the global company cap |

- Search, filter, compare, and chart any company.
- **Global search** — one box over all ten markets (`/` or `⌘K`). Type a company, ticker, local code or brand; results are grouped by country and every result keeps that country's index chart in the pane. The empty state is a ten-country index board using the same official series as each MARKET view. Country tabs still switch and browse; they are no longer a prerequisite. US share classes are grouped by CIK and Brazil BDRs by underlying, so the result is the issuer with its listings as chips. The browser keeps a compact local copy of the index, so typing filters the full universe on the client and suggestions update without a round-trip; the server is the fallback for typos. The index is a committed build (`npm run search:build`) and is rebuilt daily at 23:10 UTC.
- **Market context on every company page** — a country index strip above the page (S&P 500/400/600 chosen by the company's US tier; TOPIX, KOSPI, TAIEX, Hang Seng, ASX 200, NIFTY 50, IDX Composite, Ibovespa or JSE All Share elsewhere), with 1Y/5Y and a **vs index** rebased toggle. The country MARKET views and their full index charts are unchanged.
- **Valuation vs its own history** — P/E, P/B, EV/EBITDA percentiles over five years, plus sector aggregates.
- **Themes** — the names behind a story, across all markets.
- **The US MARKET view reads the S&P 1500 or one of its size cohorts — S&P 500 · 400 · 600** — each with its own breadth, medians, sector table, index P/E and index chart (`^SP1500`, `^GSPC`, `^SP400`, `^SP600`). The company page badge names the company's own index.
- **US themes are rules, not typed lists** — AI, defence, nuclear & power, software, healthcare, financials, energy and REITs take their members from the industry of every S&P 1500 company, plus curated names, with tested anchors.
- **US company descriptions** use stockanalysis.com profiles — the same source as Japan, Korea and India — with the 10-K Item 1 text and Nasdaq as fallback; the fetched text is committed in `data/us-profiles.json`.
- Financials are **filed values, not estimates**. Market cap uses the **current shares outstanding** (vendor statistics page; SEC 20-F/10-K/10-Q cover for ADRs; US listing × CDI ratio for ASX CDIs; filing count as the last fallback) so post-period placements and buybacks are reflected; FCF is **operating cash flow − capex**; dividend yield uses the **vendor's payment-date yield**, falling back to the latest annual DPS. Statements older than 450 days are excluded and listed in the audit. Every ratio is recomputed from its own inputs and the audit cross-checks a sample against the vendor's statistics page.
- **South Africa is the JSE.** The vendor list carries **258 lines**. Fourteen are excluded by decision: **BHG** (BHP) and **S32** (South32) belong to the Australia market; **INP** duplicates **INL**; **AGL/MNP/QLT** have no free statement page; **SOLBE1/FTB/EMN/RTO/AON/BRN/NY1** are duplicate share classes of an issuer already built; and **FDETNQ** is a FirstRand Bank note, not an operating company. That leaves a **244-line universe**, of which **226 are built**: **204 JSE-primary** companies plus **22 foreign-domiciled secondary listings** whose statements and profiles come from the primary exchange while the price is the JSE line and the cap is the global company total. Thirteen lines have no free statement page, three have statements older than 450 days and two have no trustworthy JSE price; they are named in the audit rather than estimated. The exchange list quotes JSE prices in cents; Yahoo is not consistent across JSE lines, so each series is scaled to the exchange-list last price in rand. Yahoo supplies up to five years, but some heavily traded lines are capped at about 500 sessions; each page falls back to the longest window it actually covers. The **licensed JSE market-data API is not used** (no free key). The 22 foreign-secondary lines are inside the market totals, not a separate rail. Statements older than 450 days are excluded; frozen/short/stale/thin lines are flagged and returns withheld.
- **Brazil is one class per issuer.** The vendor covers one class per company (PETR4, not PETR3), and its market cap is the **company total** repeated on every class line — so the build keeps one class, the company cap and the class price, and never sums classes. The domestic **303** companies carry trading-quality warnings, the vendor dividend yield and the report-currency basis, exactly as Indonesia.
- **Brazil also has a curated LatAm BDR lens.** The B3 list carries **788 BDRs**; **12 significant LatAm/Brazil-linked names** are curated (**11 built**): Nubank, XP, Inter, MercadoLibre, StoneCo, PagSeguro, VTEX, Globant, JBS N.V., Brazil Potash and Eve; Aura is dropped for a stale statement. **The US mega-caps (Apple, Microsoft, etc.) are deliberately not duplicated — they remain in the US section.** The B3 BDR page is a stub, so the **underlying US/TSX statements, profile, current shares and dividend yield** drive the ratios. The cap is the **global company total** from the B3 list (BRL), the price is the **BDR line** (BRL), ratios are company-level in the underlying report currency (USD/BRL), and the BDRs are **excluded from the 303 domestic totals and sector medians**. They have no per-BDR P/E band. The other **777** BDRs and the FII/funds are still excluded by type.
- **Indonesia adds two supervisory reads.** Dividend yield prefers the vendor statistics page (the filing's Dividend Per Share row is often absent for banks), with the filed DPS as the fallback and the basis labelled. Companies on IDX's **High Shareholding Concentration (HSC)** list carry a warning on the company page, an HSC badge and an HSC FLAGGED preset in the screener, and a market-level note — concentrated ownership, thin free float, excluded from LQ45/IDX30/IDX80. The list is IDX's **22 October 2026 review of 82 names**, pinned and refreshed quarterly; HSC stocks are also excluded from the IHSG since 2 November 2026. A frozen price (no recent trading), a short history, a TTM older than 12 months and thin turnover are flagged with warnings and screener presets, and their returns are withheld rather than shown as 0%. A reviewed prune removes **95 small, data-unclear lines** in two rounds: 45 with negative equity, no usable P/E/ROE, no TTM, a stale TTM or an unresolved share count; then 35 unclean nano-caps, 8 shell-like lines (revenue under Rp 10B and a loss) and 7 frozen prices. WSBP (Waskita Beton Precast) and CMPP (AirAsia Indonesia) were reviewed and deliberately kept.
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
| India | niftyindices NIFTY 500 CSV + stockanalysis.com (NSE) + Yahoo | no key |
| Indonesia | stockanalysis.com IDX exchange list + statements/profiles + Yahoo | no key; idx.co.id blocks cloud IPs (403) |
| Brazil | stockanalysis.com B3 list + domestic statements/profiles + underlying US/TSX statements/profiles + Yahoo | no key; one class per issuer, curated LatAm BDR lens |
| South Africa | stockanalysis.com JSE list + statements/profiles + primary-exchange filings for foreign-domiciled lines + Yahoo | no key; JSE prices in cents, converted to rand; licensed JSE API not used |
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

## Security

The public site ships a strict CSP, HSTS, frame denial, COOP/CORP, per-IP API rate limiting, same-origin JSON checks on POST routes, constant-time basic-auth comparison, and an optional whole-site login. See `SECURITY.md` for reporting and `docs/security-hardening.md` for the account, GitHub, Render and Cloudflare checklist.

The repository is public. If code copying is the concern, make it private. The deployed frontend JavaScript is still downloadable by any visitor; the server source is not.

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
- `workers/keepalive/` — a Cloudflare Worker cron doing the same, **live** at https://watchtower-keepalive.marlonbenedicttan.workers.dev (every 5 minutes).

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

Proprietary. All rights reserved. See `LICENSE`.
