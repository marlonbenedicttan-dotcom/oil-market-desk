// Pure, dependency-free helpers shared by the server and the test suite.

export const sgn = (x, dp = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(dp));

export function businessDaysSince(d) {
  if (!d) return null;
  let n = 0;
  const cur = new Date(d + 'T00:00:00Z');
  const now = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  while (cur < now) { cur.setUTCDate(cur.getUTCDate() + 1); const wd = cur.getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
  return n;
}

export const inBox = (lat, lon, box) => { const [[a, b], [c, d]] = box; return lat >= Math.min(a, c) && lat <= Math.max(a, c) && lon >= Math.min(b, d) && lon <= Math.max(b, d); };

export function haversineNm(a1, o1, a2, o2) {
  const R = 3440.065, r = (d) => (d * Math.PI) / 180;
  const dφ = r(a2 - a1), dλ = r(o2 - o1);
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function isoWeek(d) {
  const date = new Date(d + 'T00:00:00Z');
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  return 1 + Math.round((date - firstThu) / (7 * 864e5));
}

export function monthly(map) {
  const out = {};
  for (const d of Object.keys(map).sort()) out[d.slice(0, 7)] = map[d];
  return out;
}

export function pctOver(arr, n) {
  const idx = [];
  arr.forEach((v, i) => { if (v != null) idx.push(i); });
  if (!idx.length) return null;
  const lastIdx = idx[idx.length - 1];
  const last = arr[lastIdx];
  const target = lastIdx - n;
  let baseIdx = idx[0];
  for (const i of idx) { if (i <= target) baseIdx = i; }
  const base = arr[baseIdx];
  return base ? ((last - base) / base) * 100 : null;
}

export const percentile = (arr, v) => { const xs = arr.filter((x) => x != null); return xs.length ? (xs.filter((x) => x <= v).length / xs.length) * 100 : null; };

export function realizedVol(arr, win = 30) {
  const xs = arr.filter((x) => x != null);
  if (xs.length < win + 1) return null;
  const r = [];
  for (let i = xs.length - win; i < xs.length; i++) r.push(Math.log(xs[i] / xs[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const varp = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(varp) * Math.sqrt(252) * 100;
}

// Log changes of a dated series sampled on a fixed list of dates (nulls preserved).
// Used to put two instruments on a comparable footing before correlating them.
export function logReturns(series, dates) {
  const arr = dates.map((d) => (series[d] != null ? series[d] : null));
  const r = [];
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i], b = arr[i - 1];
    r.push(a != null && b != null && b !== 0 ? Math.log(a / b) : null);
  }
  return r;
}

// Pearson correlation of two equal-length series (pairs with a null on either side
// are skipped). Rounded to 2 dp; null when there are too few overlapping points.
export function pearson(x, y) {
  const pairs = [];
  for (let i = 0; i < x.length; i++) if (x[i] != null && y[i] != null) pairs.push([x[i], y[i]]);
  const n = pairs.length;
  if (n < 10) return null;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [a, b] of pairs) { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; }
  return sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(2) : null;
}

// Back-adjust a stitched front-month series so contract rolls don't create jumps.
// rollGaps: Map<index, gap> where a roll occurs *entering* that index (gap = old - new).
export function backAdjust(values, rollGaps) {
  const out = values.slice();
  let acc = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = values[i] == null ? null : values[i] + acc;
    if (rollGaps.has(i)) acc += rollGaps.get(i);
  }
  return out;
}

// % change of the latest value vs the value nearest each horizon back — 1 day,
// 1 week, 1 month, year-to-date and 1 year. dates must be ascending ISO yyyy-mm-dd
// and parallel to values; nulls are skipped. A horizon with no earlier point, or a
// zero base, → null (never faked). Rounded to 2 dp. Lets every price show its move
// over all the usual windows at once, not just today.
export function horizonDeltas(dates, values) {
  const at = [];
  for (let i = 0; i < dates.length; i++) if (values[i] != null) at.push(i);
  const flat = { d1: null, w1: null, m1: null, ytd: null, y1: null };
  if (at.length < 2) return flat;
  const lastI = at[at.length - 1];
  const last = values[lastI];
  const lastDate = dates[lastI];
  // The latest observation on or before a target date (the base for that window).
  const baseBefore = (iso) => { let bi = null; for (const i of at) { if (i === lastI) break; if (dates[i] <= iso) bi = i; } return bi; };
  const back = (days) => { const t = new Date(lastDate + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - days); return t.toISOString().slice(0, 10); };
  const pct = (i) => { const b = i == null ? null : values[i]; return b ? +(((last - b) / b) * 100).toFixed(2) : null; };
  return {
    d1: pct(at[at.length - 2]),
    w1: pct(baseBefore(back(7))),
    m1: pct(baseBefore(back(30))),
    ytd: pct(baseBefore(lastDate.slice(0, 4) + '-01-01')),
    y1: pct(baseBefore(back(365))),
  };
}

export function computeCracks(m) {
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const w = by.wti, rb = by.rbob, ho = by.ulsd, jet = by.jet, G = 42;
  const out = {};
  if (rb && w && rb.paper != null && w.paper != null) out.gasoline = rb.paper * G - w.paper;
  if (ho && w && ho.paper != null && w.paper != null) out.diesel = ho.paper * G - w.paper;
  if (rb && ho && w && rb.paper != null && ho.paper != null && w.paper != null) out.c321 = ((2 * rb.paper + ho.paper) * G) / 3 - w.paper;
  if (rb && w && rb.physical != null && w.physical != null) out.gasolinePhys = rb.physical * G - w.physical;
  if (ho && w && ho.physical != null && w.physical != null) out.dieselPhys = ho.physical * G - w.physical;
  if (jet && w && jet.physical != null && w.physical != null) out.jetPhys = jet.physical * G - w.physical;
  return out;
}

// ---------------------------------------------------------------------------
// Physical-tightness scoring (roadmap item 2). Each maps one physical signal to
// 0-100 where 50 = neutral and >50 = tight; null when the input is missing, so a
// caller can simply skip that component. Never invents a number.
// ---------------------------------------------------------------------------
// Curve: this month vs next, as a % of price. Backwardation (positive) = tight,
// contango (negative) = comfortable. tanh keeps it bounded for any commodity scale.
export function curveTightness(m1m2, price) {
  if (m1m2 == null || !price) return null;
  return Math.round(50 + 50 * Math.tanh(((m1m2 / price) * 100) / 2));
}
// Inventories vs the 5-year same-week norm: a bigger-than-usual draw (negative
// surprise) = tight. Scaled by the same-week seasonal range so units don't matter.
export function inventoryTightness(surprise, seasonalMin, seasonalMax) {
  if (surprise == null) return null;
  const halfRange = Math.max(Math.abs(seasonalMin ?? 0), Math.abs(seasonalMax ?? 0), 1);
  return Math.round(50 - 50 * Math.tanh((surprise / halfRange) / 1.5));
}
// Weighted average of components ({ key, label, weight, score }); re-normalises over
// whatever is present, and returns score null when nothing is available.
export function weightedScore(parts) {
  const use = (parts || []).filter((p) => p && p.score != null && p.weight > 0);
  if (!use.length) return { score: null, label: '—', parts: [] };
  const w = use.reduce((a, p) => a + p.weight, 0);
  const score = Math.round(use.reduce((a, p) => a + p.weight * p.score, 0) / w);
  const label = score >= 70 ? 'TIGHT' : score >= 58 ? 'LEANING TIGHT' : score >= 42 ? 'BALANCED' : score >= 30 ? 'LEANING LOOSE' : 'LOOSE';
  return { score, label, parts: use.map((p) => ({ key: p.key, label: p.label, score: p.score })) };
}
