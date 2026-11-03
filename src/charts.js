// Chart series helpers — shared by the build step that writes the chart store and by the server that
// reads one company out of it.
//
// The old chart endpoints parsed a whole market's price history (up to 28 MB for Korea, 5 MB for a
// Taiwan/Australia bucket) to answer one 8 KB request. On the free instance that was a multi-second
// parse for the first chart of a market. The store keeps the same points but indexed by byte offset,
// so a request reads only its own company's line (a few KB).
//
// A stored line is `{ k: "2330", p: [[dateIndex, close], ...] }`; the date table lives once in the
// market index. Dates are indices rather than repeated strings because every company in a market
// shares almost all of them.

const DAY = 864e5;

// Convert the columnar shape the Japan build writes ({ dates, series }) into plain points.
export function pointsFromColumns(dates, values) {
  const out = [];
  for (let i = 0; i < (dates || []).length; i++) {
    const c = values ? values[i] : null;
    if (dates[i] && c != null && Number.isFinite(+c)) out.push({ d: dates[i], c: +c });
  }
  return out;
}

// Daily closes for the recent window, weekly closes for the older part. A series that only has one
// of the two is returned as-is. Duplicate dates are resolved in favour of the daily point.
export function combineSeries(daily, weekly) {
  const d = (daily || []).filter((p) => p && p.d && p.c != null && Number.isFinite(+p.c));
  const first = d.length ? d[0].d : null;
  const older = (weekly || []).filter((p) => p && p.d && p.c != null && Number.isFinite(+p.c) && (!first || p.d < first));
  if (!older.length) return d.map((p) => ({ d: p.d, c: +p.c }));
  const byDate = new Map();
  for (const p of older) byDate.set(p.d, { d: p.d, c: +p.c });
  for (const p of d) byDate.set(p.d, { d: p.d, c: +p.c });
  return [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

// The first date a window needs, measured back from the series' own last date (never "today"): a
// market closed for a holiday still shows its latest close as the right-hand edge.
export function rangeStart(lastDate, range) {
  const last = String(lastDate || '');
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const t = Date.parse(last);
  switch (String(range || '1y')) {
    case '1m': case '1mo': return iso(t - 31 * DAY);
    case '3m': case '3mo': return iso(t - 92 * DAY);
    case '6m': case '6mo': return iso(t - 190 * DAY);
    case 'ytd': return `${last.slice(0, 4)}-01-01`;
    case '1y': case '1yr': return iso(t - 366 * DAY);
    case '5y': case '5yr': return iso(t - 1826 * DAY);
    case '10y': case '10yr': return iso(t - 3653 * DAY);
    default: return '1900-01-01';
  }
}

// Slice parallel dates/closes arrays to a window. Always returns arrays of the same length.
export function sliceRange(dates, closes, range) {
  const d = dates || [];
  const c = closes || [];
  if (d.length < 2) return { dates: [], closes: [] };
  const from = rangeStart(d[d.length - 1], range);
  const outD = [], outC = [];
  for (let i = 0; i < d.length; i++) {
    if (d[i] >= from && c[i] != null) { outD.push(d[i]); outC.push(c[i]); }
  }
  return { dates: outD, closes: outC };
}

// Expand one stored line against the market's shared date table.
export function seriesFromLine(line, dateTable) {
  const p = (line && line.p) || [];
  const dates = [], closes = [];
  for (const pair of p) {
    const d = dateTable[pair[0]];
    if (d && pair[1] != null) { dates.push(d); closes.push(pair[1]); }
  }
  return { dates, closes };
}
