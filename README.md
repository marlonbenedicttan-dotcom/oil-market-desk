---
title: Oil Market Desk
emoji: 🛢️
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Oil Basis 🛢️

**🔴 Live demo:** https://oil-market-desk.onrender.com

A **two-tab** dashboard — **COMMODITIES** and **MACRO** — that puts **paper** (futures) and **physical** (spot/cash) prices side by side across energy benchmarks, computes the **basis**, tracks **live tanker traffic**, and gives each commodity **segment** its own adaptive read: what happened, what's next, and trade ideas.

| Benchmark | Paper (futures) | Physical (spot) |
|---|---|---|
| WTI (Cushing) | `CL=F` | EIA `DCOILWTICO` |
| Brent | `BZ=F` | EIA `DCOILBRENTEU` |
| RBOB Gasoline | `RB=F` | Gulf Coast `DGASUSGULF` |
| ULSD / Heating Oil | `HO=F` | NY Harbor `DHOILNYH` |
| Jet Fuel (spot only) | — | USGC `EER_EPJK_PF4_RGC_DPG` (EIA key) |
| Propane (spot only) | — | Mt Belvieu `EER_EPLLPA_PF4_Y44MB_DPG` (EIA key) |
| Natural Gas | `NG=F` | Henry Hub `DHHNGSP` |

Plus the **Brent − WTI** spread (paper & physical) and a live tanker map.

Adding a benchmark = one row in the `BENCHMARKS` table in `server.js`.

> **Note on extra crude grades:** Dubai, WTI Midland and Mars are **not** available from free daily spot sources — EIA's public daily table carries only WTI Cushing and Brent for crude. Those grades need a paid feed (Kpler, Vortexa, Nasdaq Data Link, etc.).

## Features

The UI is **two tabs**: **COMMODITIES** and **MACRO**. Everything commodity-related lives in COMMODITIES; the macro side (rates, inflation/growth, currencies) in MACRO. A **global segment picker** sits on top — pick a segment and the whole tab follows it.

- **Segments** — seven: **Crude oil** · **Refined products** · **Natural gas** · **Precious metals** · **Industrial metals** · **Grains** · **Softs**. Each bundles its related instruments (e.g. Crude = WTI + Brent; Refined = gasoline, diesel, jet, propane).
- **Adaptive Big Picture** — the overview is not crude-only. Choosing a segment re-renders the panes: the Bottom Line becomes that segment's read with three actionable blocks — **WHAT HAPPENED** (data-driven), **WHAT'S NEXT** (catalysts) and **TRADE IDEAS — who benefits / who's in trouble** (sectors + example tickers). "Is oil tight?" becomes **"Is this segment tight/stretched?"**.
- **Charts** — click any commodity, gap or currency to chart it over **1M · 3M · 6M · YTD · 1Y · 5Y · 10Y**. Hover a point for its **% change** on the window; click to drop an anchor and measure between two. Every tile carries a 6-month sparkline.
- **Curves for every segment** — the **prices-for-months-ahead** term structure has a picker, so you can see any segment's curve, not just crude.
- **Positioning for every segment** — CFTC hedge-fund positioning (net, percentile, open-interest change) via a verified COT map covering all seven segments.
- **Ships & satellites for crude** — a live tanker map (free AIS, filtered to tankers) plus satellite radar passes and gas-flare detection, all oil-only.
- **Fuels & stocks for refined** — gasoline/diesel/3-2-1 crack spreads and a sector stock watchlist under the Refined segment.
- **Supply** — US oil stockpiles and gas storage under the energy segments.
- **Basis** — paper vs physical for energy benchmarks, sign-colored (energy-only — there is no free real-vs-futures basis for metals/ags).
- **Insights & alerts** — a plain-English panel plus threshold flags (with desktop notifications); both follow the selected segment.
- **Cross-asset logic** — a coded transmission engine turns real moves into knock-on reads across segments *and* regions (oil↑ → inflation → rates↑ → precious-metals headwind; oil↑ → squeezes oil-importing Asia/Europe). Triggers are data; the chains are a labelled framework.
- **In the news & regional macro** — every segment and each of the four macro regions (**US · Europe · Japan · Asia-Pacific**) carries a tier-1 wire headline strip (headlines + links only) and a region read. Only genuinely current data is shown (US and euro-area are current; Japan/APAC show headlines + currencies rather than stale numbers).
- **Global macro** — US & ECB rates, US inflation/growth, a **14-pair currencies board** (majors, EM & commodity currencies) where **every currency charts over time**, live **commodity↔currency link** checks (does AUD still track copper? does CAD still track oil?), and a copper/gold growth proxy.

## What "basis" means

- **Paper price** = the front-month **futures** contract.
- **Physical price** = the **spot / cash** assessment for physical delivery.
- **Basis** = `physical − paper`. Positive means physical crude is trading *above* the futures — a sign of tightness in the physical market.

## Data sources (all free)

| Data | Source | Notes |
|---|---|---|
| Paper (futures) | Yahoo Finance — `CL=F` (WTI), `BZ=F` (Brent) | no key |
| Physical (spot) | FRED / EIA — `DCOILWTICO`, `DCOILBRENTEU` | no key, ~1 day lag |
| Tanker traffic | [aisstream.io](https://aisstream.io) | **free API key required** |

## Run it

```sh
npm start
# → http://localhost:4173
```

**No dependencies** — uses Node's built-in HTTP server, `fetch`, and `WebSocket`. Requires Node 22+.

### Enable live tanker tracking

1. Get a free key at <https://aisstream.io>.
2. Start with the key:

```sh
AISSTREAM_KEY=your_key_here npm start
```

Optionally override the watched regions (JSON array of `[[lat,lon],[lat,lon]]` boxes):

```sh
AIS_BOXES='[[[18,-98],[31,-80]]]' AISSTREAM_KEY=... npm start
```

## Alerts & daily digest

The server runs an alert engine (checks every 5 min) and a daily digest (default **07:00** local). Delivery channels:

| Channel | Enable with | Notes |
|---|---|---|
| Desktop notification | on by default (macOS) | `NOTIFY=off` to disable |
| Webhook | `WEBHOOK_URL=https://hooks.slack.com/...` | POSTs `{subject, text}` |
| Email | `SMTP_USER`, `SMTP_PASS`, `DIGEST_TO` | needs `npm i nodemailer` |
| Log file | always | written to `digest.log` |

Options: `DIGEST_HOUR` (default 7), `ALERT_COOLDOWN_H` (default 12).

View the latest digest any time at `http://localhost:4173/api/digest`.

### Email the digest via Gmail

1. Turn on 2-Step Verification, then create an **App Password** at <https://myaccount.google.com/apppasswords>.
2. Add to `.env`:
   ```sh
   SMTP_USER=you@gmail.com
   SMTP_PASS=your_16_char_app_password
   DIGEST_TO=you@gmail.com
   ```
3. `npm i nodemailer` and restart.

## Caveats

- The futures series is the front-month **continuous** (not roll-adjusted); the **curve** (M1−M2 / M1−M6) is the roll-free structure signal.
- Spot assessments publish with a **lag** and are a *different instrument* than the futures — read the on-screen **DATA QUALITY** flags.
- Tanker positions are a live sample of AIS reports in the watched regions, not a complete global fleet picture.
- Dubai / WTI Midland / Mars require a paid feed.
- **No free real-vs-futures basis or inventories for metals/agriculture** — those need LME/USDA feeds, so they're deliberately not shown. **Ships & satellites are oil-only.**
- **Palm oil** is free but **front-month only**, so it has no month-by-month curve.
- **Macro is deliberately US-centric**: free non-US CPI/GDP feeds are stale, so only US data is shown rather than faking it. The currencies board and the commodity↔currency link correlations are live.
- Not investment advice.

## Deploy it online

The app is a **long-running Node process** (live WebSocket to the ship feed + scheduled alerts), so it needs a **container host** — Render, Railway, or Fly.io. Serverless platforms (Vercel/Netlify) won't work.

**Render (easiest):**
1. Push this repo to GitHub (command below).
2. On [render.com](https://render.com) → **New → Blueprint** → pick the repo (it reads `render.yaml`).
3. Add the secret env vars **`AISSTREAM_KEY`** and **`EIA_API_KEY`** in the dashboard.
4. Deploy — you get a public URL.

**Docker (any host):**
```sh
docker build -t oil-market-desk .
docker run -p 4173:4173 -e AISSTREAM_KEY=... -e EIA_API_KEY=... oil-market-desk
```

Notes for hosting:
- **Desktop notifications are macOS-only** and turn themselves off on a server — use `WEBHOOK_URL` (Slack/Discord) or email for alerts there.
- State files (`.state.json`, `.reroute.json`, `.flares.json`) are small and rebuild on restart if the disk is ephemeral.
- Secrets come from environment variables — never commit `.env` (it's git-ignored).

### Push to GitHub
```sh
gh repo create oil-market-desk --private --source=. --push
```

## Development

```sh
npm test        # unit tests + API smoke tests (Node's built-in runner)
```

The server keeps all logic in `server.js` and pure helpers in `src/lib.js` (unit-tested).

## Security

- Secrets come from environment variables (`.env` locally, dashboard env vars when hosted).
- To protect a **public** deployment, set **`AUTH_USER`** and **`AUTH_PASS`** — the app then requires a browser login prompt.
- A GitHub Actions workflow (`.github/workflows/test.yml`) runs the tests on every push — commit it with a push token that has `workflow` scope to enable CI.

## License

MIT
