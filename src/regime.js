import { horizonDeltas, horizonDeltasAbs } from './lib.js';

// The cross-asset board. One definition for the server, the daily seed builder and the tests.
// `fallbackFred` is an exact same-definition series (VIXCLS = VIX, SP500 = S&P 500) used when Yahoo
// is unavailable; the source label changes so the reader can see which feed answered.
export const REGIME_BOARD = [
  { id: 'dxy', label: 'US dollar (DXY)', sym: 'DX-Y.NYB', source: 'Yahoo', unit: '', dp: 2 },
  { id: 'vix', label: 'VIX (volatility)', sym: '^VIX', fallbackFred: 'VIXCLS', source: 'Yahoo', unit: '', dp: 2 },
  { id: 'us10y', label: 'US 10y yield', fred: 'DGS10', altSym: '^TNX', source: 'FRED', unit: '%', dp: 2, rate: true },
  { id: 'spx', label: 'S&P 500', sym: '^GSPC', fallbackFred: 'SP500', source: 'Yahoo', unit: '', dp: 0 },
  { id: 'gold', label: 'Gold', sym: 'GC=F', source: 'Yahoo', unit: '$/oz', dp: 2 },
  { id: 'copper', label: 'Copper', sym: 'HG=F', source: 'Yahoo', unit: '$/lb', dp: 3 },
  { id: 'wti', label: 'WTI crude', sym: 'CL=F', source: 'Yahoo', unit: '$/bbl', dp: 2 },
  { id: 'brent', label: 'Brent crude', sym: 'BZ=F', source: 'Yahoo', unit: '$/bbl', dp: 2 },
];

// A backdrop row is a computed value, not a live quote: if a refresh fails, the last good row is still
// the most useful thing to show (with its own as-of date and a "last good" label). Never let a null
// refresh overwrite a row that already had a price.
export function keepLastGood(fresh, previous) {
  if (fresh && fresh.price != null) return { ...fresh, stale: false };
  if (previous && previous.price != null) return { ...previous, stale: true };
  return null;
}

// Turn a date→close map into the row the board renders. A series with fewer than five points is not
// enough to compute the 1W/1M/YTD/1Y windows, so it is treated as "no fresh data", not as a row.
export function buildRegimeRow(spec, map, source) {
  const dates = Object.keys(map || {}).sort();
  const values = dates.map((d) => map[d]);
  const lastIdx = values.reduce((acc, v, i) => (v != null ? i : acc), -1);
  if (dates.length < 5 || lastIdx < 0) return null;
  return {
    id: spec.id,
    source,
    price: +(+values[lastIdx]).toFixed(spec.dp),
    asOf: dates[lastIdx],
    deltas: spec.rate ? horizonDeltasAbs(dates, values) : horizonDeltas(dates, values),
  };
}
