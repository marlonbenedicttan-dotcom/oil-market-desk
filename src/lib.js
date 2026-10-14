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

// The last present value of a series. Used to pick a price that cannot be a stale meta quote
// (Yahoo's `regularMarketPrice` is a Mar-2024 number for some legacy symbols, e.g. CPO=F).
export function lastNonNull(arr) {
  for (let i = (arr || []).length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

// Escape text that comes from outside the app (wire headlines) before embedding it in the
// server-built HTML prose (e.g. the READ's takeaways). Only the external fragment is escaped —
// the surrounding prose keeps its intentional <b> tags, which the client renders as HTML.
export function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

// Same windows, but as ABSOLUTE differences — for series where a % move is meaningless (a yield:
// 4.2% → 4.3% is not "+2%", it is +0.10pp). Returns percentage points, rounded to 2 dp.
export function horizonDeltasAbs(dates, values) {
  const at = [];
  for (let i = 0; i < dates.length; i++) if (values[i] != null) at.push(i);
  const flat = { d1: null, w1: null, m1: null, ytd: null, y1: null };
  if (at.length < 2) return flat;
  const lastI = at[at.length - 1];
  const last = values[lastI];
  const lastDate = dates[lastI];
  const baseBefore = (iso) => { let bi = null; for (const i of at) { if (i === lastI) break; if (dates[i] <= iso) bi = i; } return bi; };
  const back = (days) => { const t = new Date(lastDate + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - days); return t.toISOString().slice(0, 10); };
  const diff = (i) => (i == null || values[i] == null ? null : +((last - values[i]).toFixed(2)));
  return {
    d1: diff(at[at.length - 2]),
    w1: diff(baseBefore(back(7))),
    m1: diff(baseBefore(back(30))),
    ytd: diff(baseBefore(lastDate.slice(0, 4) + '-01-01')),
    y1: diff(baseBefore(back(365))),
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
// Plain-word label for a signed score. Premium on the way up, discount on the way down — the
// finance-native way to say "above/below its own history".
export function stretchLabel(s) {
  if (s == null) return '—';
  return s >= 80 ? 'AT A BIG PREMIUM' : s >= 50 ? 'AT A PREMIUM' : s >= 20 ? 'AT A SLIGHT PREMIUM'
    : s > -20 ? 'IN LINE WITH HISTORY' : s > -50 ? 'AT A SLIGHT DISCOUNT' : s > -80 ? 'AT A DISCOUNT' : 'AT A BIG DISCOUNT';
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

// ---------------------------------------------------------------------------
// Data provenance + method — the single source of truth for the on-site
// "Data & Methodology" section (served at /api/market.methodology). It's content, not
// logic, but it lives here so it can't drift between the server and the UI, and so a
// unit test can assert it stays complete.
// ---------------------------------------------------------------------------
export const METHODOLOGY = {
  sources: [
    { name: 'Yahoo Finance', covers: 'Futures, FX and equity indices', freshness: 'Live — may be delayed ~15 min' },
    { name: 'FRED / EIA', covers: 'Real-barrel spot prices, US inventories, gas storage', freshness: 'Spot lags days; EIA weekly (Wed)' },
    { name: 'CFTC', covers: 'Positioning (managed money, COT)', freshness: 'Weekly, Friday — lags ~3 days' },
    { name: 'BIS', covers: 'Central-bank policy rates', freshness: 'Monthly' },
    { name: 'World Bank / IMF', covers: 'GDP, debt, inflation (country fundamentals)', freshness: 'Annual — labelled by year' },
    { name: 'USDA', covers: 'Grain & dairy stocks-to-use balances', freshness: 'Monthly snapshot' },
    { name: 'Google News (tier-1 wire)', covers: 'Headlines and event tagging', freshness: 'Live — keyword + context matched' },
    { name: 'aisstream.io / NASA', covers: 'Ships, gas flares, radar satellite', freshness: 'Live / daily' },
  ],
  scores: [
    { name: 'Price vs its own history', range: '−100 … +100', read: 'Where today’s price sits in THIS market’s own history: + = rich (a premium), − = cheap (a discount), 0 = mid. Built from 2-year & 10-year range position plus self-normalised 3-month and 1-year moves — never compared across markets.' },
    { name: 'Supply & demand', range: '0 … 100', read: 'The physical balance from the curve, the real-vs-futures basis and stocks vs the seasonal norm. Above 50 = undersupplied, 50 = balanced, below 50 = oversupplied. Re-weighted over whatever data exists; missing inputs are shown, never faked.' },
  ],
  basis: 'Basis = real barrels (the official spot assessment) − futures. A positive gap means cash is above futures, i.e. a tight physical market. Spot LAGS and comes from a different source, so the gap can reflect timing as well as tightness — the data checks say when.',
  rules: [
    'Numbers are never invented: a missing input shows “—” or “no free data”, never a guess.',
    'Every figure carries its source and as-of date; delayed feeds are labelled.',
    'News is keyword- and context-matched and always links to the source — a prompt to investigate, not a verdict.',
    'For information only — not investment advice.',
  ],
};

// ---------------------------------------------------------------------------
// Options (Tier 2). Parse an OCC option symbol, e.g. USO261014C00123000 →
// { root:'USO', expiry:'2026-10-14', type:'call', strike:123 }.
// ---------------------------------------------------------------------------
export function parseOcc(sym) {
  const m = /^([A-Z0-9.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym || ''));
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strike] = m;
  return { root, expiry: `20${yy}-${mm}-${dd}`, type: cp === 'C' ? 'call' : 'put', strike: Number(strike) / 1000 };
}

// ---------------------------------------------------------------------------
// Currency-adjusted returns (Tier 2). Convert a USD return over a window into the same return in a
// chosen base currency. mode 'mul' = the pair is base-per-USD (e.g. USD/JPY, CNY-per-USD);
// 'div' = the pair is USD-per-base (e.g. EUR/USD). Inputs/returns are percentages.
// ---------------------------------------------------------------------------
export function fxAdjust(usdPct, fxPct, mode) {
  if (usdPct == null || fxPct == null) return null;
  const u = 1 + usdPct / 100, f = 1 + fxPct / 100;
  const r = mode === 'div' ? u / f : u * f;
  return +((r - 1) * 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Risk metrics (Tier 2). Max drawdown, a realised-vol term structure, and a
// correlation matrix over aligned log-returns.
// ---------------------------------------------------------------------------
// Largest peak-to-trough decline over the series, as a % (≤ 0). null if too short.
export function maxDrawdown(values) {
  const xs = (values || []).filter((v) => v != null);
  if (xs.length < 2) return null;
  let peak = xs[0], worst = 0;
  for (const v of xs) {
    if (v > peak) peak = v;
    if (peak > 0) { const dd = ((v - peak) / peak) * 100; if (dd < worst) worst = dd; }
  }
  return +worst.toFixed(1);
}
// Annualised realised vol across several look-backs — a term structure (rising = stress building).
export function realizedVolTerm(values, wins = [30, 60, 90]) {
  const out = {};
  for (const w of wins) out['w' + w] = realizedVol(values, w);
  return out;
}
// Pearson correlation matrix over aligned log-returns. seriesByKey: { key: { 'YYYY-MM-DD': value } }.
export function corrMatrix(seriesByKey, dates) {
  const keys = Object.keys(seriesByKey);
  const rets = {};
  for (const k of keys) rets[k] = logReturns(seriesByKey[k], dates);
  const m = {};
  for (const a of keys) { m[a] = {}; for (const b of keys) m[a][b] = a === b ? 1 : pearson(rets[a], rets[b]); }
  return m;
}
// --- Plain words for the risk panel (so the copy is tested, not ad-hoc) ------
export function drawdownWord(pct) {
  if (pct == null) return '—';
  const a = Math.abs(pct);
  return a >= 35 ? 'deep fall' : a >= 20 ? 'big fall' : a >= 10 ? 'moderate fall' : a >= 4 ? 'mild fall' : 'barely moved';
}
export function volWord(v) {
  if (v == null) return '—';
  return v >= 60 ? 'very jumpy' : v >= 35 ? 'jumpy' : v >= 18 ? 'normal' : 'calm';
}
export function volTrend(term) {
  if (!term || term.w30 == null || term.w90 == null) return null;
  const d = term.w30 - term.w90, eps = Math.max(2, term.w90 * 0.12);
  return d > eps ? 'rising' : d < -eps ? 'falling' : 'flat';
}
// One key's correlations with the rest, strongest first (for the default "what X moves with" view).
export function focusRows(matrix, key, keys) {
  const row = (matrix && matrix[key]) || {};
  return (keys || []).filter((k) => k.key !== key && row[k.key] != null).map((k) => ({ ...k, r: row[k.key] })).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}
// The strongest relationships in the whole matrix (off-diagonal), by |r|.
export function topPairs(matrix, keys, n = 3) {
  const out = [];
  for (let i = 0; i < (keys || []).length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = keys[i], b = keys[j];
    const v = matrix[a.key] ? matrix[a.key][b.key] : null;
    if (v != null) out.push({ a, b, r: v });
  }
  return out.sort((x, y) => Math.abs(y.r) - Math.abs(x.r)).slice(0, n);
}
// The most independent series — lowest average |r| against the others.
export function bestDiversifier(matrix, keys) {
  let best = null, bestAvg = Infinity;
  for (const a of keys || []) {
    const row = matrix[a.key] || {};
    let sum = 0, n = 0;
    for (const b of keys) { if (b.key === a.key) continue; const v = row[b.key]; if (v != null) { sum += Math.abs(v); n++; } }
    if (n) { const avg = sum / n; if (avg < bestAvg) { bestAvg = avg; best = a; } }
  }
  return best ? { key: best.key, label: best.label, avg: +bestAvg.toFixed(2) } : null;
}
// One plain-English paragraph summarising the risk board.
export function riskRead(metrics, pairs, div) {
  const list = (metrics || []).filter((m) => m.drawdown != null);
  if (list.length < 2) return '';
  const wildest = list.slice().sort((a, b) => a.drawdown - b.drawdown)[0];
  const jumpy = (metrics || []).filter((m) => m.vol && m.vol.w30 != null).sort((a, b) => b.vol.w30 - a.vol.w30)[0];
  const rising = (metrics || []).filter((m) => m.volTrend === 'rising').map((m) => m.label);
  const s = [`Wildest here: <b>${wildest.label}</b>, down ${Math.abs(wildest.drawdown).toFixed(0)}% peak-to-trough over the year.`];
  if (jumpy && jumpy.key !== wildest.key) s.push(`Jumpiest: <b>${jumpy.label}</b> (${Math.round(jumpy.vol.w30)}% vol).`);
  if (div) s.push(`Most independent: <b>${div.label}</b> (average link ${div.avg}).`);
  if (pairs && pairs.length) s.push(`Strongest link on the board: <b>${pairs[0].a.label} ↔ ${pairs[0].b.label}</b> (${pairs[0].r > 0 ? '+' : ''}${pairs[0].r.toFixed(2)}).`);
  if (rising.length) s.push(`Vol is building for ${rising.join(', ')}.`);
  return s.join(' ');
}
// CFTC positioning (managed money / non-commercial net) — turn a 0-100 percentile of the spec net
// into a plain read. High = crowded long (squeeze risk), low = washed-out / crowded short.
export function positioningFlag(pct) {
  if (pct == null || !Number.isFinite(pct)) return { label: '—', tone: 'mid' };
  if (pct >= 90) return { label: 'CROWDED LONG', tone: 'hot' };
  if (pct >= 70) return { label: 'STRETCHED LONG', tone: 'warm' };
  if (pct <= 10) return { label: 'CROWDED SHORT', tone: 'hot' };
  if (pct <= 30) return { label: 'WASHED-OUT', tone: 'cool' };
  return { label: 'NEUTRAL', tone: 'mid' };
}
export function positioningRead(pct) {
  if (pct == null || !Number.isFinite(pct)) return '';
  if (pct >= 90) return 'Speculative money is crowded long — a squeeze or a fast unwind is the risk if the trend stalls.';
  if (pct >= 70) return 'Specs are stretched long — much of the easy upside may already be priced in.';
  if (pct <= 10) return 'Speculative money is washed-out / crowded short — fuel for a violent short squeeze.';
  if (pct <= 30) return 'Specs are light — positioning is not a headwind right now.';
  return 'Positioning is mid-range — no crowding either way.';
}

// ---------------------------------------------------------------------------
// News context guard. Keyword matching alone attaches "NBA commissioner Adam Silver" to
// SILVER, "corn maze" to CORN, a "Coffee" surname to COFFEE, "Copper" (the TV series) to
// copper. A commodity keyword is dropped when it is used as a name, a sport or an everyday
// word and the headline carries no market framing. Pure + unit-tested.
// ---------------------------------------------------------------------------
// Topics that are never a commodity market. Stories about these are dropped unless the
// headline ALSO carries a hard market term (a unit or an exchange), which overrides.
export const NON_MARKET_CTX = /\b(nba|nfl|mlb|nhl|mls|ncaa|olympic[s]?|playoffs?|quarterback|touchdown|basketball|baseball|football|footballer|soccer|hockey|cricket|rugby|fifa|uefa|world cup|super bowl|wimbledon|grand slam|boxing|boxer|coach(?:es|ed)?|actors?|actress(?:es)?|movies?|film|sitcom|sequel|box office|broadway|singers?|rapper|pop star|album|concerts?|celebrity|awards?|oscars?|grammys?|emmys?|tonys?|netflix|hollywood|premiere|red carpet|draft|tournament|championship|league|match(?:es)?|player|signed with|traded to)\b/i;
// Hard, unambiguous market terms — a unit or an exchange. Their presence means "this is a
// market story", so they override the sports/entertainment block-list above.
export const STRONG_MARKET_CTX = /\b(futures?|spot price|bullion|commodit(?:y|ies)|cme|comex|lme|nymex|troy|ounces?|tonnes?|metric tons?|barrels?|bushels?|pounds?|per (?:ounce|tonne|ton|barrel|bushel|pound))\b/i;
// Macro/economy framing — what a country or region story is about (not just a mention of the
// country). Used for the MACRO domain, so a "US Open" or "Japan film" headline never attaches.
export const MACRO_CTX = /\b(econom(?:y|ic|ies|ist)|inflation|deflation|disinflation|cpi|ppi|wages?|salaries|interest rates?|rates?|central bank|the fed|federal reserve|ecb|boj|pboc|rbi|bank of england|bank of japan|bank of korea|bank indonesia|imf|world bank|gdp|growth|recession|slowdown|downturn|unemploy\w*|jobless|jobs?|payrolls?|labou?r market|fiscal|budget|deficit|surplus|debt|bonds?|yields?|treasur\w*|currenc\w*|forex|\bfx\b|exchange rate|devalu\w*|dollar|euro|yen|yuan|renminbi|sterling|pound|rupee|baht|ringgit|peso|dong|rupiah|trade|tariff|sanction\w*|embargo|export\w*|import\w*|stimulus|subsid\w*|reform|policy|downgrade|credit rating|sovereign|default|bailout|crisis|bank\w*|stocks?|shares?|equit\w*|markets?|index|indices|nikkei|dax|ftse|kospi|sensex|nifty|hang seng|taiex|straits times|asx|s&p|nasdaq|wall street|commodit\w*|energy|election\w*|parliament|referendum|government|coalition|coup|protest\w*|unrest|war|conflict|geopolit\w*|summit|manufactur\w*|pmi|retail sales|industrial production|housing|property|invest\w*|ipo|merger|acquisition)\b/i;
// A hard macro term (a central bank, inflation, GDP…) — overrides the sports/entertainment block.
export const STRONG_MACRO_CTX = /\b(inflation|deflation|central bank|the fed|federal reserve|ecb|boj|pboc|rbi|gdp|recession|interest rates?|unemploy\w*|payrolls?|imf|sovereign|downgrade|treasury|bond market|credit rating|stimulus|bailout|default|fiscal deficit|monetary policy)\b/i;
// Softer market framing: prices, moves and fundamental words. A commodity keyword needs at
// least this to be treated as on-topic.
export const MARKET_CTX = /\b(price[sd]?|pricing|ounce[s]?|troy|tonne[s]?|metric tons?|barrel[s]?|bushel[s]?|pound[s]?|per (?:ounce|tonne|ton|barrel|bushel|pound)|futures?|contract[s]?|spot|settle(?:s|d|ment)?|rally|rallies|rallied|surge[sd]?|soar(?:s|ed)?|jump(?:s|ed)?|climb(?:s|ed)?|slip(?:s|ped)?|fall(?:s|ing)?|fell|drop(?:s|ped)?|plunge[sd]?|tumble[sd]?|slide[s]?|slid|decline[sd]?|gain(?:s|ed)?|rise|rises|rising|rebound(?:s|ed)?|weaker|stronger|demand|supply|inventor(?:y|ies)|stockpile[s]?|output|production|export[s]?|import[s]?|tariff[s]?|sanction[s]?|mines?|mining|smelt(?:er|ers|ing)|refin(?:e|er|ing|ers|ery|eries)|harvest|crops?|opec|inflation|interest rates?|central bank|dollar|yuan|euro|yen|markets?|commodit(?:y|ies)|hedge[sd]?|traders?|investors?|record (?:high|low)|all-time|record|higher|lower|advance[sd]?|edges?|steady|flat|mixed|firmer|softer|holds?|retreats?|extends?|tops?|hits?)\b/i;
// A commodity word used as a surname: a capitalised first word (not an article/stopword)
// directly before it — "Adam Silver", "Ari Gold", "Sir Copper". Only a tiebreaker: it never
// overrides a hard market term.
// Commodity words that are also real surnames / brand names — "Adam Silver" / "Ari Gold" is a
// person, not the metal. The check is deliberately narrow: it only fires for these words, and
// never for a capitalised article, quantifier, headline adjective or a nationality ("Mexican").
const SURNAME_PRONE = 'gold|silver|copper|cotton|wheat|coffee|corn|sugar|palm|butter|cheese|milk|barrel|oil|gas';
const SURNAME_NAME = SURNAME_PRONE.replace(/(^|\|)([a-z])/g, (m, p, c) => p + c.toUpperCase());
const PROPER_NOUN_RE = new RegExp(
  '\\b(?:Mr\\.?|Ms\\.?|Mrs\\.?|Dr\\.?|Sir|'
  + '(?!(?:The|An|And|But|For|Nor|Yet|So|As|At|By|In|Of|On|To|Up|US|UK|EU|UN|IMF|Fed|New|Old|Big|Top|Best|Worst|Last|This|That|Its|Our|Your|His|Her|Their|Record|Rising|Falling|Higher|Lower|Strong|Weak|Global|World|Market|Markets|Price|Prices|Spot|Demand|Supply|Comex|LME)\\b)'
  + '(?![A-Z][a-z]*(?:an|ese|ish|ic)\\b)[A-Z][a-z]{2,})\\s+(?:' + SURNAME_NAME + ')\\b');
export const looksLikeProperNoun = (title) => PROPER_NOUN_RE.test(String(title || ''));
// Words that are ALSO common names or everyday words, so a bare mention proves nothing:
// Gold/Silver (surnames), Corn (maze/cob), Palm (Beach), Butter/Cheese/Milk (verbs & food),
// Hogs (Harley), Beef (a grudge), Gas/Oil/Crude, … Only these need explicit market framing.
// Unambiguous commodities ("cattle", "cocoa", "soybeans", "palladium") are on-topic on their own.
export const AMBIGUOUS_TERMS = /\b(gold|silver|copper|platinum|palladium|corn|sugar|coffee|palm|butter|cheese|milk|hogs?|beef|feeder|gas|oil|crude|barrel|grain)\b/i;
// The guard. `domain` = 'commodity' (default) or 'macro'. A commodity headline needs market
// framing only when it uses a homonym-prone word; a MACRO headline must be an economy/market
// story, not a mere mention of a country. Both drop sports/entertainment unless a hard term
// (a unit/exchange, or a central-bank/inflation term) proves otherwise.
export function newsContextOk(title, { domain = 'commodity', requireMarket = null, requireContext = null } = {}) {
  const t = String(title || '');
  const strong = STRONG_MARKET_CTX.test(t) || STRONG_MACRO_CTX.test(t);
  if (NON_MARKET_CTX.test(t) && !strong) return false;    // a sports/entertainment story
  if (domain === 'macro') {
    const need = requireContext == null ? true : requireContext;
    if (need && !MACRO_CTX.test(t)) return false;         // not an economy/market story
    return true;
  }
  if (looksLikeProperNoun(t) && !strong) return false;    // "Adam Silver" — a person, not the metal
  const need = requireMarket == null ? AMBIGUOUS_TERMS.test(t) : requireMarket;
  if (need && !MARKET_CTX.test(t)) return false;          // a homonym with no market framing
  return true;
}
