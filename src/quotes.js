// Live quote plumbing: the market -> Yahoo symbol map, a ref parser and a normaliser.
//
// Reference data (shares, earnings, the official close) comes from the committed files. A quote is a
// short-lived overlay fetched from Yahoo at request time, so the two never get confused: nothing here
// writes a file, and a failed quote leaves the committed close on screen.
//
// Refs are the same `market:code` form the chart layer uses (`us:AAPL`, `jp:7203`, `hk:0700`).

export const QUOTE_MARKETS = new Set(['us', 'jp', 'kr', 'tw', 'hk', 'au', 'in', 'id', 'br', 'za']);

// The index each market page leads with. Yahoo accepts all ten in one spark call (verified 2026-11-10).
export const INDEX_REF = {
  us: 'us:^GSPC',
  jp: 'jp:^N225',
  kr: 'kr:^KS11',
  tw: 'tw:^TWII',
  hk: 'hk:^HSI',
  au: 'au:^AXJO',
  in: 'in:^NSEI',
  id: 'id:^JKSE',
  br: 'br:^BVSP',
  za: 'za:^J203.JO',
};

const PAD4 = (code) => String(code).replace(/^0*/, '').padStart(4, '0');

// Yahoo's suffix per exchange. The build scripts already carry these rules; this is the runtime copy.
// KOSPI and TWSE are the only Korean/Taiwanese boards the datasets hold, so .KS and .TW are correct.
export function yahooSymbol(market, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  // Indices are already full Yahoo symbols (^GSPC, ^J203.JO) and pass through unchanged.
  if (c.startsWith('^')) return c;
  switch (market) {
    case 'us': return c.replace(/\./g, '-');          // BRK.B -> BRK-B
    case 'jp': return `${c}.T`;
    case 'kr': return `${c}.KS`;
    case 'tw': return `${c}.TW`;
    case 'hk': return `${PAD4(c)}.HK`;
    case 'au': return `${c}.AX`;
    case 'in': return `${c}.NS`;
    case 'id': return `${c}.JK`;
    case 'br': return `${c}.SA`;
    case 'za': return `${c}.JO`;
    default: return null;
  }
}

export function parseRef(ref) {
  const s = String(ref || '').trim();
  const at = s.indexOf(':');
  if (at < 1) return null;
  const market = s.slice(0, at).toLowerCase();
  const code = s.slice(at + 1).toUpperCase();
  if (!QUOTE_MARKETS.has(market)) return null;
  // A Yahoo suffix is appended by the server; the caller never supplies one. Dots are allowed for
  // US class shares, `^` for indices and `&` for NSE tickers such as M&M.
  if (!/^[A-Z0-9.^=&-]{1,24}$/.test(code)) return null;
  return { market, code, symbol: yahooSymbol(market, code) };
}

// Yahoo spark's meta is enough: last price, previous close, the quote time and the currency. The
// sparkline itself is ignored — the committed chart already carries history.
export function normalizeQuote(meta) {
  if (!meta) return null;
  // Some exchanges quote in minor units: the JSE returns ZAc (cents) while the dataset is in rand,
  // and London returns GBp (pence). Normalise to the major unit so a live quote and the committed
  // price are the same number.
  const rawCcy = String(meta.currency || '');
  const minor = /^(ZAc|ZAC|GBp|GBX)$/.test(rawCcy) ? 100 : 1;
  const currency = /^(ZAc|ZAC)$/.test(rawCcy) ? 'ZAR' : /^(GBp|GBX)$/.test(rawCcy) ? 'GBP' : (rawCcy || null);
  const price = Number(meta.regularMarketPrice) / minor;
  if (!(price > 0)) return null;
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose) / minor;
  const prevClose = prev > 0 ? prev : null;
  const chg1d = prevClose ? +(((price / prevClose) - 1) * 100).toFixed(2) : null;
  const time = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null;
  return {
    price,
    prevClose,
    chg1d,
    currency,
    time,
    source: 'yahoo',
  };
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
