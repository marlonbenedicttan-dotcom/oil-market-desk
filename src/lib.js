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

// ---------------------------------------------------------------------------
// Seasonality (roadmap item 6). low/high/median are MM-DD-keyed maps from a 5-year
// day-of-year band. Never invents a grade when the inputs are missing.
// ---------------------------------------------------------------------------
// Where the current price sits within the seasonal range for this day-of-year.
export function seasonalGrade(low, high, median, price, md) {
  const lo = low?.[md], hi = high?.[md], med = median?.[md] ?? null;
  if (lo == null || hi == null || price == null || hi <= lo) return null;
  const pos = ((price - lo) / (hi - lo)) * 100;
  const label = pos >= 80 ? 'WELL ABOVE SEASONAL' : pos >= 60 ? 'ABOVE SEASONAL' : pos >= 40 ? 'IN LINE' : pos >= 20 ? 'BELOW SEASONAL' : 'WELL BELOW SEASONAL';
  return { pos: Math.round(pos), label, low: lo, high: hi, median: med, vsMedian: med ? +(((price - med) / med) * 100).toFixed(1) : null };
}
// The normal seasonal move (the 5-year median path) between two day-of-year keys, as %.
export function seasonalAhead(median, fromMd, toMd) {
  const a = median?.[fromMd], b = median?.[toMd];
  return a && b ? +(((b - a) / a) * 100).toFixed(1) : null;
}

// Months between two futures contract labels like 'Z26' (month code + 2-digit year).
// Used to annualise an implied roll yield correctly when the listed months skip.
export function contractMonthsBetween(a, b) {
  const MC = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
  if (!a || !b) return null;
  const idx = (l) => (MC[l[0]] ?? 0) + (2000 + Number(l.slice(1))) * 12;
  const ia = idx(a), ib = idx(b);
  return ia && ib ? Math.abs(ib - ia) : null;
}

// --- Price vs its own history (v3) -------------------------------------------
// One SIGNED read, -100..+100:  + = rich / stretched up,  - = cheap / washed out,  0 = middle.
// Why signed: v2 combined |distance from the middle| with |size of move| and then labelled the
// result with up-words ("STRETCHED"/"EXTREME"), so a market that had CRASHED to 2-year lows
// scored as "stretched" — wrong. Direction now carries through.
// Why comparable: every input is a percentile of THIS market's OWN history, so a +70 means the
// same thing for hogs as for gold. Volatility is deliberately NOT an input — it has no
// direction and would just double-count a big move (it is shown as its own line).
//
// Where the latest value sits in its own distribution: -100 = at its lows, +100 = at its highs.
export function signedPosition(values) {
  const xs = (values || []).filter((v) => v != null);
  if (xs.length < 20) return null;
  const p = percentile(xs, xs[xs.length - 1]);
  return p == null ? null : Math.round((p - 50) * 2);
}
// The latest `window`-step move as a fraction of how big this market's OWN moves of that length
// usually get (its 90th percentile), SIGNED: a rise is positive, a fall is negative. A typical
// move → a small number; a move as big as its biggest usual ones → ±100. Self-normalised, so a
// 5% move in gold and a 5% move in hogs are judged against their own volatility, not each other.
export function signedMove(values, window) {
  const xs = (values || []).filter((v) => v != null);
  if (xs.length < window + 12) return null;
  const moves = [];
  for (let i = window; i < xs.length; i++) { const b = xs[i - window]; if (b) moves.push((xs[i] - b) / b); }
  if (moves.length < 12) return null;
  const cur = moves[moves.length - 1];
  const size = moves.map((m) => Math.abs(m)).sort((a, b) => a - b);
  const p90 = size[Math.min(size.length - 1, Math.floor(size.length * 0.9))];
  if (!p90) return null;
  return Math.round(Math.max(-1, Math.min(1, cur / p90)) * 100);
}
// Plain-word label for a signed score. Symmetric: rich on the way up, cheap on the way down.
export function stretchLabel(s) {
  if (s == null) return '—';
  return s >= 80 ? 'VERY RICH' : s >= 50 ? 'RICH' : s >= 20 ? 'LEANING RICH'
    : s > -20 ? 'ABOUT AVERAGE' : s > -50 ? 'LEANING CHEAP' : s > -80 ? 'CHEAP' : 'VERY CHEAP';
}
// Plain-word label for the supply/demand (tightness) score, 0-100 where 50 = balanced.
// Reads as a physical-balance verdict: undersupplied on the way up, oversupplied on the way down.
export function sdLabel(s) {
  if (s == null) return '—';
  return s >= 70 ? 'UNDERSUPPLIED' : s >= 58 ? 'TIGHT' : s >= 42 ? 'BALANCED' : s >= 30 ? 'WELL SUPPLIED' : 'OVERSUPPLIED';
}
// Blend signed parts ({ key, label, weight, score -100..+100 }) into one headline. A plain
// weighted mean, re-normalised over whatever is present — predictable, and no single input can
// hijack the score the way the old max-blend let the (spurious) range read do.
export function stretchScore(parts) {
  const use = (parts || []).filter((p) => p && p.score != null && p.weight > 0);
  if (!use.length) return { score: null, label: '—', parts: [] };
  const w = use.reduce((a, p) => a + p.weight, 0);
  const score = Math.round(use.reduce((a, p) => a + p.weight * p.score, 0) / w);
  return { score, label: stretchLabel(score), parts: use.map((p) => ({ key: p.key, label: p.label, score: p.score })) };
}

// Attribute a price move to news. moves = { y1, m6, m1 } (percent). events = tagged news
// [{ kind, effect:'up'|'down'|'watch', weight, date, source, title, url, tier1 }]. Picks the
// event KINDS most consistent with the direction of the move (a year UP is explained by
// bullish news, a year DOWN by bearish news) and returns the top few, each with a
// representative headline. A heuristic — a prompt to investigate, not a verdict.
export function attributeMoves(moves, events) {
  const list = events || [];
  const mv = moves || {};
  const dir = mv.y1 != null && Math.abs(mv.y1) >= 5 ? Math.sign(mv.y1) : mv.m6 != null ? Math.sign(mv.m6) : 0;
  const want = dir > 0 ? 'up' : dir < 0 ? 'down' : null;
  const groups = {};
  for (const e of list) {
    if (!e || !e.kind) continue;
    const g = groups[e.kind] || (groups[e.kind] = { kind: e.kind, count: 0, good: 0, weight: 0, sample: null, _rank: -1 });
    g.count += 1;
    const aligned = want == null || e.effect === want || (e.effect !== 'up' && e.effect !== 'down');
    if (aligned) {
      g.good += 1; g.weight += (e.weight || 1) * (e.tier1 ? 1.3 : 1);
      const rank = (e.tier1 ? 2 : 0) + (e.weight || 1);
      if (rank > g._rank) { g._rank = rank; g.sample = { title: e.title, source: e.source, url: e.url, date: e.date }; }
    }
  }
  const all = Object.values(groups);
  // A kind only counts as a driver if the MAJORITY of its headlines support the direction —
  // so a fall isn't "explained" by bullish news. If nothing qualifies, flag the divergence.
  const drivers = all.filter((g) => g.good > 0 && g.good / g.count >= 0.5)
    .sort((a, b) => b.weight - a.weight).slice(0, 3)
    .map((g) => ({ kind: g.kind, count: g.count, weight: +g.weight.toFixed(1), sample: g.sample }));
  return { direction: dir > 0 ? 'up' : dir < 0 ? 'down' : null, drivers, divergence: drivers.length === 0 && all.length > 0 };
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

// Soybean "board crush" (per bushel) — a processor's gross margin turning beans into meal + oil.
// 1 bushel of soybeans crushes to ≈48 lb of meal and ≈11 lb of oil. CME quotes meal (ZM) in
// $/short ton, oil (ZL) in ¢/lb, and CBOT quotes beans (ZS) in ¢/bushel, so:
//   crush = meal×48/2000 + oil×11/100 − beans/100    ($/bushel; positive = processors profitable)
// `oilShare` is the share of the product value that is oil (high = oil-led, low = meal-led).
export function computeCrush(m) {
  const by = Object.fromEntries((m.benchmarks || []).map((b) => [b.id, b]));
  const meal = by.soymeal?.paper, oil = by.soyoil?.paper, bean = by.soybean?.paper;
  if (meal == null || oil == null || bean == null) return {};
  const mealValue = meal * 0.024;
  const oilValue = oil * 0.11;
  const beanCost = bean / 100;
  return { crush: mealValue + oilValue - beanCost, mealValue, oilValue, beanCost, oilShare: (oilValue / (oilValue + mealValue)) * 100 };
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
