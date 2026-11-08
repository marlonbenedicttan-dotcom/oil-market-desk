// The risk board's instruments. One definition for the server, the seed builder and the tests.
// FRED fallbacks are exact same-definition series: SP500 = S&P 500, VIXCLS = VIX, DGS10 = 10y.
export const RISK_SERIES = [
  { key: 'wti', label: 'WTI crude', short: 'WTI', sym: 'CL=F' },
  { key: 'gold', label: 'Gold', short: 'Gold', sym: 'GC=F' },
  { key: 'copper', label: 'Copper', short: 'Copper', sym: 'HG=F' },
  { key: 'spx', label: 'S&P 500', short: 'S&P', sym: '^GSPC', fallbackFred: 'SP500' },
  { key: 'dxy', label: 'Dollar (DXY)', short: 'Dollar', sym: 'DX-Y.NYB' },
  { key: 'us10y', label: 'US 10y', short: 'US 10y', fred: 'DGS10', altSym: '^TNX', rate: true, level: true },
  { key: 'vix', label: 'VIX', short: 'VIX', sym: '^VIX', fallbackFred: 'VIXCLS', level: true },
];

// A correlation matrix is only as good as the series behind it. If a refresh comes back empty, keep
// the previous map for that instrument rather than letting a blank column erase every pair involving
// it. Five points is the minimum needed to compute a return at all.
export function keepLastSeries(fresh, previous) {
  const n = fresh && fresh.map ? Object.keys(fresh.map).length : 0;
  if (n >= 5) return { map: fresh.map, source: fresh.source, stale: false };
  if (previous && previous.map && Object.keys(previous.map).length >= 5) return { ...previous, stale: true };
  return null;
}

export function latestDate(map) {
  const dates = Object.keys(map || {});
  return dates.length ? dates.sort()[dates.length - 1] : '';
}
