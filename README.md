# Oil Basis 🛢️

A dashboard that puts **paper** (futures) and **physical** (spot/cash) crude oil prices side by side, computes the **basis**, and tracks **live tanker traffic**.

```
WTI:   paper (futures)   physical (spot)   basis
Brent: paper (futures)   physical (spot)   basis
Brent − WTI spread (paper & physical)
+ a live tanker map
```

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

Optionally override the watched regions (a JSON array of `[[lat,lon],[lat,lon]]` boxes):

```sh
AIS_BOXES='[[[18,-98],[31,-80]]]' AISSTREAM_KEY=... npm start
```

Default regions: US Gulf, North Sea/Rotterdam, Malacca/Singapore, Persian Gulf.

## Caveats

- The futures contract **rolls** on expiry, which can visibly jump the basis.
- Spot assessments publish with a **lag** and refer to specific delivery points, so the basis is indicative, not a tradable cash-futures quote.
- Tanker positions are a live sample of AIS reports in the watched regions, not a complete global fleet picture.

## License

MIT
