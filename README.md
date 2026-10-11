# Oil Basis 🛢️

A dashboard that puts **paper** (futures) and **physical** (spot/cash) prices side by side across energy benchmarks, computes the **basis**, and tracks **live tanker traffic**.

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

- **Basis** — paper vs physical per benchmark, sign-colored.
- **Performance** — day % change on every card, plus a **10-year history** view (click any benchmark card, or use the 6M/10Y toggle).
- **Crack spreads** — gasoline, diesel and 3-2-1 refining margins ($/bbl), from product × 42 − crude.
- **Insights** — a plain-English panel reading the numbers for prices *and* shipping.
- **Alerts** — flags when a basis, spread or crack breaks a threshold (with desktop notifications).
- **Live tanker map** — free AIS positions, filtered to tankers (types 80–89).

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
- Not investment advice.

## License

MIT
