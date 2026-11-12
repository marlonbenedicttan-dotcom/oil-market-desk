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

// One WEBHOOK_URL, several chat services — they each want a different POST shape, so detect by host:
//   Slack     {"text": "..."}                      (also the generic default)
//   Discord   {"content": "..."}
//   Telegram  {"chat_id", "text"}                  (needs TELEGRAM_CHAT_ID)
//   ntfy.sh   plain-text body + a Title header     (no account needed, works on any network)
//   anything else gets {"subject", "text"} — point it at your own endpoint if you like.
export function webhookPayload(url, subject, text, chatId) {
  const u = String(url || '');
  const full = `${subject}\n\n${text}`;
  if (/discord(app)?\.com\/api\/webhooks/i.test(u)) return { json: { content: full.slice(0, 1900) } };
  if (/api\.telegram\.org\/bot/i.test(u)) return { json: { chat_id: chatId, text: full.slice(0, 4000), disable_web_page_preview: true } };
  if (/ntfy/i.test(u)) return { raw: text, headers: { Title: subject } };
  if (/slack\.com\/services/i.test(u)) return { json: { text: full } };
  return { json: { subject, text } };
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

// Steel margin: hot-rolled coil minus the iron ore needed to make a tonne of steel.
// HRC is quoted per SHORT ton and iron ore per METRIC tonne, and a tonne of crude steel takes about
// 1.6 t of ore — so the coil price is converted to $/t before the ore cost is subtracted. This is a
// GROSS spread: coking coal, energy, scrap and conversion costs are not in it. `ratio` is the
// coil:ore multiple (the ore-to-steel ratio analysts quote alongside the spread).
export function computeSteel(m) {
  const by = Object.fromEntries((m.benchmarks || []).map((b) => [b.id, b]));
  const hrc = by.steel?.paper, ore = by.ironore?.paper;
  if (hrc == null || ore == null) return {};
  const coilPerT = hrc / 0.90718474;   // 1 short ton = 0.90718474 t
  const orePerT = ore * 1.6;
  return { margin: coilPerT - orePerT, coilPerT, orePerT, ratio: ore ? coilPerT / ore : null };
}

// ---------------------------------------------------------------------------
// Relative value — one curated spread's own 1-year history. The spread spec
// (which legs, what unit, why it matters) lives with the segment registry in
// server.js; the maths is here so it can be unit-tested. `legs` is
// { id: { 'YYYY-MM-DD': price } } for the futures legs.
// ---------------------------------------------------------------------------
export function relValueAt(spec, vals) {
  let v = null;
  if (spec.kind === 'diff') {
    v = vals[spec.a] * (spec.af ?? 1) - vals[spec.b] * (spec.bf ?? 1);
  } else if (spec.kind === 'ratio') {
    const den = vals[spec.b] * (spec.bf ?? 1);
    v = den ? (vals[spec.a] * (spec.af ?? 1)) / den : null;
  } else if (spec.kind === 'margin') {
    // Build the same shape computeCracks/computeCrush/computeSteel already take, so the strip and
    // the dedicated panels cannot drift apart.
    const m = { benchmarks: Object.entries(vals).map(([id, paper]) => ({ id, paper })) };
    if (spec.calc === 'c321') v = computeCracks(m).c321 ?? null;
    else if (spec.calc === 'crush') v = computeCrush(m).crush ?? null;
    else if (spec.calc === 'steel') v = computeSteel(m).margin ?? null;
  }
  if (v == null || !Number.isFinite(v)) return null;
  return spec.scale ? v * spec.scale : v;
}

export function buildRelValueRow(spec, legs = {}) {
  const ids = spec.legs || [spec.a, spec.b].filter(Boolean);
  const dates = [...new Set(ids.flatMap((id) => Object.keys(legs[id] || {})))].sort();
  const history = [], outDates = [];
  for (const d of dates) {
    const vals = {};
    let ok = true;
    for (const id of ids) {
      const v = legs[id] && legs[id][d];
      if (v == null) { ok = false; break; }
      vals[id] = v;
    }
    if (!ok) continue;
    const v = relValueAt(spec, vals);
    if (v == null) continue;
    history.push(v);
    outDates.push(d);
  }
  const last = history.length ? history[history.length - 1] : null;
  const pct = history.length >= (spec.minObs ?? 60) && last != null ? percentile(history, last) : null;
  return {
    id: spec.id, label: spec.label, unit: spec.unit || '', dp: spec.dp ?? 2,
    signed: spec.kind !== 'ratio', why: spec.why || '',
    last, pct, obs: history.length, asOf: outDates[outDates.length - 1] || null, history,
  };
}

export function relValueZone(pct) {
  if (pct == null) return null;
  if (pct >= 90) return 'near the top of its 1-year range';
  if (pct >= 65) return 'above its 1-year median';
  if (pct > 35) return 'around its 1-year median';
  if (pct > 10) return 'below its 1-year median';
  return 'near the bottom of its 1-year range';
}

export function ordinal(n) {
  if (n == null) return '—';
  const i = Math.round(n);
  const mod100 = i % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[i % 10] || 'th');
  return i + suffix;
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

// Weekly inventory levels with the same-week band from the PRIOR `years` years: for each row, the
// min / average / max of the same ISO week one to five years earlier. These are LEVELS (stocks), not
// week-on-week changes, so the chart can show "where is the tank versus its usual seasonal range?".
// Fewer than three prior observations leaves the band null rather than inventing a range.
export function inventoryBands(rows, weeks = 156, years = 5) {
  const xs = (rows || []).filter((r) => r && r.period && r.value != null && Number.isFinite(r.value));
  const out = xs.map((r) => {
    const y = Number(r.period.slice(0, 4));
    const wk = isoWeek(r.period);
    const prior = xs.filter((q) => {
      const qy = Number(q.period.slice(0, 4));
      return qy < y && qy >= y - years && isoWeek(q.period) === wk;
    }).map((q) => q.value);
    const n = prior.length;
    return {
      period: r.period, value: r.value, n,
      min: n >= 3 ? Math.min(...prior) : null,
      avg: n >= 3 ? prior.reduce((a, b) => a + b, 0) / n : null,
      max: n >= 3 ? Math.max(...prior) : null,
    };
  });
  return out.slice(-weeks);
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
    { name: 'Yahoo Finance', covers: 'Futures, FX, equity indices and company prices', freshness: 'Live — may be delayed ~15 min' },
    { name: 'FRED / EIA', covers: 'Real-barrel spot prices, US inventories, gas storage', freshness: 'Spot lags days; EIA weekly (Wed)' },
    { name: 'CFTC', covers: 'Positioning (managed money, COT)', freshness: 'Weekly, Friday — lags ~3 days' },
    { name: 'BIS', covers: 'Central-bank policy rates', freshness: 'Monthly' },
    { name: 'World Bank / IMF', covers: 'GDP, debt, inflation (country fundamentals)', freshness: 'Annual — labelled by year' },
    { name: 'USDA', covers: 'Grain & dairy stocks-to-use balances', freshness: 'Monthly snapshot' },
    { name: 'Google News (tier-1 wire)', covers: 'Headlines and event tagging', freshness: 'Live — keyword + context matched' },
    { name: 'stockanalysis.com', covers: 'Company statements, profiles, current shares and dividend yield', freshness: 'Cached; refreshed daily' },
    { name: 'Exchange files', covers: 'Universe and official closes: HKEX, ASX, NIFTY 500, IDX, B3, JSE', freshness: 'Daily / vendor-pinned' },
  ],
  companies: [
    { name: 'Universe — US', basis: 'S&P 1500 · large, mid and small cap', note: 'Membership from the SPDR Portfolio S&P 1500 Composite (SPTM) holdings file. Second share classes are listed but excluded from totals so nothing is double-counted; an index member with no sourceable SEC row is disclosed in the universe audit, never invented.' },
    { name: 'Universe — Japan', basis: 'TSE Prime · 1,546 companies', note: 'Every Prime issue with a market cap, from the JPX master file. Standard and Growth are not covered. A preferred share class is carried in the data but never counted as a company.' },
    { name: 'Universe — Korea', basis: 'KOSPI · 745 companies', note: 'Every KOSPI issue that files with DART and has a share count. KOSDAQ is not covered, so companies such as YG Entertainment, SM and JYP are correctly absent.' },
    { name: 'Universe — Taiwan', basis: 'TWSE · 1,089 listed common stocks', note: 'Every four-digit TWSE common stock with issued shares and a price; TDRs, ETFs, warrants and preferred lines are excluded. TAIEX is the exchange’s own cap-weighted index.' },
    { name: 'Universe — Hong Kong', basis: 'HKEX main board · 1,918 companies with a statement page', note: 'Every main-board company with a stockanalysis statement page and a share count. GEM and the junior boards are not covered. The official close comes from the HKEX daily quotation report; the statement currency (HKD, CNY or USD) is carried into the ratios.' },
    { name: 'Universe — Australia', basis: 'ASX · 1,652 companies with a current share count', note: 'Every ASX-listed company with a statement page and a share count, from the ASX listed-companies CSV. CDIs use the US listing’s ordinary count × the CDI ratio; funds, debt and non-ordinary lines are excluded.' },
    { name: 'Universe — India', basis: 'NIFTY 500 · 494 companies', note: 'The NIFTY 500 constituent list from niftyindices.com, with the NSE symbol and NSE industry. India’s fiscal year is April–March, so every period label follows the filing, not the calendar.' },
    { name: 'Universe — Indonesia', basis: 'IDX · 810 companies', note: 'The IDX list from stockanalysis.com (idx.co.id blocks cloud IPs), after a reviewed 95-name prune for negative equity, missing data, stale/frozen prices and shell-like nano-caps; WSBP and CMPP were reviewed and kept. The 383-name HSC list (11 November 2026, new methodology) is pinned separately.' },
    { name: 'Universe — Brazil', basis: 'B3 · 314 listed: 303 domestic + 11 LatAm BDRs', note: 'One class per issuer (PETR4, not PETR3) from the stockanalysis B3 list. BDRs (31–39) and FII/funds are filtered by type; a curated 12-name LatAm/Brazil-linked BDR lens is shown separately (11 built; Aura dropped for a stale statement). The 18 US mega-caps, the other 777 BDRs and the FII/funds are excluded; 4 stale statements, 4 without a defensible share count and 3 without a covered statement page are named in the audit.' },
    { name: 'Universe — South Africa', basis: 'JSE · 226 built: 204 primary + 22 foreign-secondary (244-line universe)', note: 'The Johannesburg exchange list from stockanalysis.com, after 14 named exclusions: BHG/S32 belong to the Australia market, INP duplicates INL, AGL/MNP/QLT have no free statement page, seven lines are duplicate share classes of an issuer already built, and one is a bank note. The 22 foreign-domiciled lines built are secondary listings: their statements come from the primary exchange, the price is the JSE line and the cap is the global company total. Thirteen lines have no free statement page, three are stale and two have no trustworthy JSE price; they are named in the audit. The licensed JSE market-data API is not used.' },
    { name: 'US fundamentals', basis: 'SEC XBRL, as filed', note: 'GAAP as reported. TTM earnings from four quarters with Q4 rebuilt as FY − three quarters, guarded against outliers.' },
    { name: 'US quarters', basis: 'Full XBRL index, resolved per period', note: 'One companyfacts document per company, then each quarter is taken from the highest-priority tag that has it, or differenced from year-to-date figures (Q2 = H1 − Q1). Operating income falls back to revenue − costs; banks report net interest plus non-interest income instead of a revenue line. Coverage is reported by the quarterly audit rather than assumed here.' },
    { name: 'US prices and caps', basis: 'Nasdaq', note: 'Last sale, daily change and market cap from Nasdaq’s own quote. Every filing figure is cross-checked against Nasdaq’s financial tables within 5%; where they disagree, both values are shown.' },
    { name: 'Japan fundamentals', basis: 'J-Quants (JPX)', note: 'Financial summaries, daily prices, and the exchange’s own TTM P/E, P/B, ROE and forward P/E. Market cap excludes treasury shares and is split-adjusted.' },
    { name: 'Korea fundamentals', basis: 'DART (Financial Supervisory Service)', note: 'Annual and quarterly statements as filed. Korean companies report cumulatively, so quarters are the differences and the annual report is Q4. Market cap is price × shares, with the share count taken from net income ÷ basic EPS where both exist — issued shares overstate after buybacks.' },
    { name: 'Korea prices and FX', basis: 'Naver Finance · ECB', note: 'Daily closes from Naver; the USD conversion uses ECB reference rates. Sectors come from each company’s KSIC industry code, folded into 30 comparable buckets.' },
    { name: 'Taiwan fundamentals', basis: 'stockanalysis.com (company filings) · TWSE', note: 'Annual and quarterly income, balance sheet and cash flow, in millions TWD, with a TTM column. Prices, issued shares and the official P/E / P/B / dividend yield come from TWSE; the build audits its own ratios against the exchange’s. Sectors are the TWSE industry codes.' },
    { name: 'Hong Kong fundamentals', basis: 'stockanalysis.com (HKG) · HKEX close', note: 'Annual and quarterly English statements, diluted shares and DPS, in the report currency (HKD, CNY or USD). The HKD market cap is never divided by a CNY/USD profit; the statement currency is carried into the ratios. Current shares and the vendor dividend yield come from the statistics page; statements older than 450 days are excluded.' },
    { name: 'Australia fundamentals', basis: 'stockanalysis.com (ASX) · CDI-aware shares', note: 'Annual and half-year statements in AUD, USD, EUR or GBP, with the report currency carried into the ratios. CDIs use the US listing’s ordinary count × the CDI ratio for capitalisation; BHP and RIO report in USD and are labelled. Statements older than 450 days are excluded.' },
    { name: 'India fundamentals', basis: 'stockanalysis.com (NSE) · TTM or FY', note: 'English statements with a TTM column, diluted shares, DPS and GICS profile, in INR or the report currency. The TTM column is used where the vendor serves one; otherwise the last fiscal year is labelled. India’s April–March fiscal year is never assumed to be December.' },
    { name: 'Indonesia fundamentals', basis: 'stockanalysis.com (IDX) · vendor statistics', note: 'English statements with a TTM column, diluted shares, DPS, GICS profile, and the vendor’s current shares, dividend yield and float. The yield prefers the statistics page (banks often omit the DPS row). Statements older than 450 days are excluded; frozen/short/stale/thin lines are flagged and returns withheld.' },
    { name: 'Brazil fundamentals', basis: 'stockanalysis.com (BVMF) · company cap + class price', note: 'Annual and quarterly statements, TTM, current shares, dividend yield and GICS profile, in BRL or USD. The vendor’s market cap is the company total repeated on every class line; the selected class keeps that cap while the price is the class line, and classes are never summed. The LatAm BDRs use the underlying US/TSX statements and company-total cap in BRL; they are excluded from the 303 domestic totals and have no per-BDR P/E band. Statements older than 450 days are excluded; frozen/short/stale/thin lines are flagged.' },
    { name: 'South Africa fundamentals', basis: 'stockanalysis.com (JSE / primary exchange) · company cap', note: 'Annual and half-year statements, TTM, current shares, dividend yield and GICS profile, in ZAR or the report currency (USD, EUR, GBP). Where the vendor serves no trailing column, the build sums the latest two half-year filings and reconciles the result with the fiscal year when the period ends coincide; if that table lags or does not reconcile, it reads the vendor’s separate rolling view. Only an issuer with no trailing data at all keeps the labelled fiscal year. The vendor’s JSE list cap is the company total in rand and is the authority; the line price is quoted in rand (Yahoo also quotes the JSE in cents, divided once at build). The foreign-secondary lines read the primary exchange for statements and the JSE line for price. Statements older than 450 days are excluded; frozen/short/stale/thin lines are flagged and returns withheld.' },
    { name: 'South Africa prices and FX', basis: 'Yahoo · open.er-api', note: 'Up to five years of {CODE}.JO closes and volume and the JSE All Share (^J203.JO). The Yahoo cache is keyed by range, so a short fetch cannot poison a five-year build. Lines whose history starts later (Richemont starts in 2023) use the MAX window and name the first available date. USD/ZAR and the report-currency crosses come from open.er-api. Returns are in ZAR.' },
    { name: 'South Africa valuation history', basis: 'Yahoo + stockanalysis, up to 5 years', note: 'Year-end price against that year’s diluted EPS, giving the “cheap vs itself” percentile. Only the distribution is stored. The window follows each line’s available Yahoo history (up to five years; some large lines have about two), and the audit reports the band size.' },
    { name: 'Taiwan prices and FX', basis: 'TWSE · Yahoo · open.er-api', note: 'Five years of daily closes from Yahoo (the TWSE daily archive blocks historical dates), TAIEX from TWSE’s monthly market report, and USD/TWD from open.er-api (the ECB does not publish TWD). Returns are shown in TWD.' },
    { name: 'Hong Kong prices and FX', basis: 'Yahoo · HKEX · open.er-api', note: 'The HKEX daily quotation report supplies the official close and previous close; Yahoo supplies five years of daily closes and the Hang Seng. USD/HKD and USD/CNY come from open.er-api. Returns are in HKD.' },
    { name: 'Australia prices and FX', basis: 'Yahoo · open.er-api', note: 'Five years of {CODE}.AX closes and the S&P/ASX 200 (^AXJO); the USD table from open.er-api gives the AUD and report-currency crosses. Returns are in AUD.' },
    { name: 'India prices and FX', basis: 'Yahoo · open.er-api', note: 'Five years of {SYMBOL}.NS closes and the NIFTY 50 (^NSEI); USD/INR and the report-currency crosses come from open.er-api. Returns are in INR.' },
    { name: 'Indonesia prices and FX', basis: 'Yahoo · open.er-api', note: 'Five years of {TICKER}.JK closes and the IDX Composite (^JKSE); USD/IDR and the report-currency crosses come from open.er-api. Returns are in IDR.' },
    { name: 'Brazil prices and FX', basis: 'Yahoo · open.er-api', note: 'Five years of {CODE}.SA closes and volume and the Ibovespa (^BVSP); USD/BRL comes from open.er-api. Returns are in BRL; BDR returns use the BDR line price.' },
    { name: 'Japan valuation history', basis: 'J-Quants, 5 years daily', note: 'Used for the percentile bands; only the distribution is stored, not 1,200 rows per company.' },
    { name: 'Korea valuation history', basis: 'DART + Naver, 5 years', note: 'Year-end price against that year’s earnings, giving the “cheap vs itself” percentile. Only the distribution is stored.' },
    { name: 'Taiwan valuation history', basis: 'stockanalysis.com + Yahoo, 5 years', note: 'Year-end price against that year’s diluted EPS, giving the “cheap vs itself” percentile. Only the distribution is stored.' },
    { name: 'Hong Kong valuation history', basis: 'Yahoo + stockanalysis, 5 years', note: 'Year-end price against that year’s diluted EPS, giving the “cheap vs itself” percentile. Only the distribution is stored, not 1,200 rows per company.' },
    { name: 'Australia valuation history', basis: 'Yahoo + stockanalysis, 5 years', note: 'Year-end price against that year’s diluted EPS, giving the “cheap vs itself” percentile. Only the distribution is stored.' },
    { name: 'India valuation history', basis: 'Yahoo + stockanalysis, 5 years', note: 'Year-end price against that fiscal year’s diluted EPS, giving the “cheap vs itself” percentile. Only the distribution is stored.' },
    { name: 'Indonesia valuation history', basis: 'Yahoo + stockanalysis, 5 years', note: 'Year-end price against that year’s diluted EPS, giving the “cheap vs itself” percentile. Only the distribution is stored.' },
    { name: 'Brazil valuation history', basis: 'Yahoo + stockanalysis, 5 years', note: 'Year-end price against that year’s diluted EPS for the domestic companies, giving the “cheap vs itself” percentile. Only the distribution is stored; BDRs have no per-BDR band.' },
    { name: 'Company descriptions', basis: 'Written profiles, then filing', note: 'US: stockanalysis.com company profiles for the S&P 1500, with the 10-K Item 1 Business section and Nasdaq’s own company profile as the fallback where the page has no usable paragraph. Japan: 556 written here, 987 fetched from stockanalysis.com, 4 generated. Korea: 737 fetched, 8 REIT lines written here. Taiwan: fetched from stockanalysis.com (TPE pages). Hong Kong, Australia, India, Indonesia, Brazil and South Africa: fetched from stockanalysis.com; Brazil’s BDRs and South Africa’s foreign-secondary lines use the underlying company’s profile. Each page says which it is.' },
    { name: 'Themes', basis: 'Rule + curated list', note: 'A theme is an industry rule plus curated additions minus exclusions, so new listings join automatically. Anchors are tested on every audit.' },
  ],
  limits: [
    'US coverage is the S&P 1500 (large, mid and small cap); Japan is TSE Prime only; Korea is KOSPI only. Taiwan is TWSE-listed common stock only. None of them covers the junior boards.',
    'Korea publishes no company guidance, so there is no forward P/E there — the trailing figure is the only one shown.',
    'Taiwan publishes no free structured guidance either, so there is no forward P/E there. Its statements are aggregated from filings by stockanalysis.com rather than parsed from MOPS directly; TWSE’s own P/E, P/B and yield are the cross-check.',
    'Korea is missing about 80 small companies whose statements DART does not return in the standard table (mostly insurers and non-December fiscal years). They are absent rather than estimated.',
    'Japan has no ownership or activist data — that needs EDINET large-shareholding filings, which this feed does not carry.',
    'US earnings dates are estimated from each company’s own filing cadence, never presented as announced.',
    'No cash-rich screen for the US: “cash” means cash and equivalents, and Treasury bills are not tagged in SEC XBRL (Berkshire is the obvious case). Better absent than wrong.',
    'Japan P/E and ROE are the exchange’s TTM figures; the statement block below them is fiscal-year, and each is labelled.',
    'Hong Kong is HKEX main board only; GEM and the junior boards are not covered. Some issuers report in CNY or USD, so the ratios are computed in the statement currency and the page says so.',
    'Australia is ASX-listed only; CDIs use the US ordinary count × the CDI ratio, and BHP/RIO report in USD. No free structured guidance, so there is no forward P/E.',
    'India is the NIFTY 500 only; the NSE is the price source. The fiscal year is April–March and the TTM column is used where the vendor serves one; otherwise the last fiscal year is labelled.',
    'Indonesia is IDX only; the reviewed 95-name prune and the 383-name HSC list are disclosed. Statements older than 450 days are excluded; frozen/short/stale/thin lines are flagged and returns withheld.',
    'Brazil is B3 only; one class per issuer, and the 11 LatAm BDRs are a separate lens excluded from the 303 domestic totals. The 18 US mega-caps stay in the US section; the other 777 BDRs and FII/funds are excluded. BDRs have no per-BDR P/E band. Statements older than 450 days are excluded; frozen/short/stale/thin lines are flagged.',
    'South Africa is the JSE only; the 22 foreign-secondary lines are included in the market totals with their global company caps, not shown as a separate rail. The licensed JSE API is not used, and the keyless vendor price is calibrated to the exchange-list price in rand (Yahoo’s JSE unit varies by line). Statements older than 450 days are excluded; frozen/short/stale/thin lines are flagged and returns withheld.',
    'Hong Kong, Australia, India, Indonesia, Brazil and South Africa publish no free structured guidance, so there is no forward P/E there.',
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
// How far below its 1-year high the series sits *now* (≤ 0, 0 = at the high). This is the
// decision-relevant number; maxDrawdown above is the worst it ever got over the same year.
export function drawdownNow(values) {
  const xs = (values || []).filter((v) => v != null);
  if (xs.length < 2) return null;
  const peak = Math.max(...xs);
  if (!(peak > 0)) return null;
  return +(((xs[xs.length - 1] - peak) / peak) * 100).toFixed(1);
}
// Annualised realised vol across several look-backs — a term structure (rising = stress building).
export function realizedVolTerm(values, wins = [30, 60, 90]) {
  const out = {};
  for (const w of wins) out['w' + w] = realizedVol(values, w);
  return out;
}
// Where today's 30-day vol sits inside *this instrument's own* year (0-100). A global threshold
// cannot answer "is this normal for gold?"; this can. null when there is not enough history.
export function volPercentile(values, win = 30) {
  const xs = (values || []).filter((v) => v != null);
  if (xs.length < win + 30) return null;
  const hist = [];
  for (let i = win + 1; i <= xs.length; i++) {
    const v = realizedVol(xs.slice(0, i), win);
    if (v != null) hist.push(v);
  }
  if (hist.length < 20) return null;
  const latest = hist[hist.length - 1];
  return Math.round((hist.filter((v) => v <= latest).length / hist.length) * 100);
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
// Turn a percentile-vs-its-own-year into a word. This is the "is it normal for this thing?" answer,
// which a fixed vol threshold cannot give.
export function volVsOwnWord(pct) {
  if (pct == null) return '—';
  return pct >= 85 ? 'unusually jumpy' : pct >= 60 ? 'jumpier than usual' : pct >= 40 ? 'typical' : pct >= 15 ? 'calmer than usual' : 'unusually calm';
}
// Strength and direction of a correlation in words, never a colour alone.
export function corrWord(r) {
  if (r == null) return '—';
  const a = Math.abs(r);
  return a >= 0.7 ? 'strong' : a >= 0.5 ? 'clear' : a >= 0.3 ? 'moderate' : 'loose';
}
// Did a pair get closer or further apart between the 1-year and 3-month windows?
export function corrShift(r1, r3) {
  if (r1 == null || r3 == null) return null;
  if (r1 * r3 < 0 && Math.abs(r1) >= 0.3 && Math.abs(r3) >= 0.3) return { word: 'flipped', tone: 'warn' };
  const d = Math.abs(r3) - Math.abs(r1);
  if (d >= 0.2) return { word: 'stronger', tone: 'warn' };
  if (d <= -0.2) return { word: 'weaker', tone: 'cool' };
  return { word: 'steady', tone: 'flat' };
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
// Split every pair into the three decisions the panel asks about: doubles up (same direction),
// hedges (opposite), and loose (no dependable link). `cut` is the |r| considered dependable.
export function pairGroups(matrix, keys, cut = 0.5) {
  const all = topPairs(matrix, keys, Infinity);
  return {
    together: all.filter((p) => p.r >= cut).sort((a, b) => b.r - a.r),
    opposite: all.filter((p) => p.r <= -cut).sort((a, b) => a.r - b.r),
    loose: all.filter((p) => Math.abs(p.r) < cut).sort((a, b) => Math.abs(b.r) - Math.abs(a.r)),
  };
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
// The two-sentence risk headline. Deliberately risk-only: correlation has its own section, and the
// old copy called VIX "the wildest fall" — a level move dressed up as a loss.
export function riskRead(metrics) {
  const list = (metrics || []).filter((m) => m.drawdownNow != null || m.drawdown != null);
  if (list.length < 2) return '';
  const held = list.filter((m) => !m.level);
  const deep = (held.length ? held : list).slice().sort((a, b) => (a.drawdownNow ?? a.drawdown ?? 0) - (b.drawdownNow ?? b.drawdown ?? 0))[0];
  const jumpy = (metrics || []).filter((m) => m.vol && m.vol.w30 != null).sort((a, b) => b.vol.w30 - a.vol.w30)[0];
  const heldJumpy = (metrics || []).filter((m) => !m.level && m.vol && m.vol.w30 != null).sort((a, b) => b.vol.w30 - a.vol.w30)[0];
  const rising = (metrics || []).filter((m) => m.volTrend === 'rising').map((m) => m.label);
  const deeper = deep && deep.drawdown != null && deep.drawdownNow != null && Math.abs(deep.drawdown) >= Math.abs(deep.drawdownNow) + 3;
  const s = [];
  if (deep && deep.drawdownNow != null) {
    s.push(deep.drawdownNow < 0
      ? `<b>${deep.label}</b> is ${Math.abs(deep.drawdownNow).toFixed(0)}% below its 1-year high${deeper ? ` (worst fall ${Math.abs(deep.drawdown).toFixed(0)}%)` : ''}.`
      : `<b>${deep.label}</b> is closest to its 1-year high.`);
  } else if (deep) {
    s.push(`<b>${deep.label}</b>'s worst fall this year was ${Math.abs(deep.drawdown).toFixed(0)}%.`);
  }
  if (jumpy && heldJumpy && jumpy.level && jumpy.key !== heldJumpy.key) {
    s.push(`<b>${heldJumpy.label}</b> is the jumpiest to own (${Math.round(heldJumpy.vol.w30)}%); <b>${jumpy.label}</b> is more volatile still (${Math.round(jumpy.vol.w30)}%), but that is a level move, not a loss.`);
  } else if (jumpy) {
    s.push(jumpy.level
      ? `<b>${jumpy.label}</b> is the most volatile series (${Math.round(jumpy.vol.w30)}%), but that is a level move, not a loss.`
      : `<b>${jumpy.label}</b> is the jumpiest (${Math.round(jumpy.vol.w30)}% annualised).`);
  }
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
// Align a daily price map (date -> close) to weekly COT rows: each report gets the last close on or
// before its report date. Null before the price history starts — never filled forward from the future.
export function alignPriceToRows(priceByDate, rows) {
  const dates = Object.keys(priceByDate || {}).sort();
  let i = 0, last = null;
  return (rows || []).map((r) => {
    while (i < dates.length && dates[i] <= r.date) { last = priceByDate[dates[i]]; i++; }
    return { ...r, price: last };
  });
}

// Positioning-vs-price divergence: the classic tell is price rising while speculators are cutting
// (fading the move), or price falling while they are adding (buying the dip). Net positioning is
// measured as a share of open interest so contracts of different size are comparable, and both legs
// have to be material (price >=3%, net >=1 point of OI) before it is called a divergence.
export function positioningDivergence(priceByDate, rows, lookbackWeeks = 13) {
  const flat = { tone: 'flat', read: '' };
  if (!rows || rows.length < lookbackWeeks + 2) return flat;
  const dates = Object.keys(priceByDate || {}).sort();
  if (!dates.length) return flat;
  const atOrBefore = (d) => { let best = null; for (const x of dates) { if (x <= d) best = x; else break; } return best ? priceByDate[best] : null; };
  const last = rows[rows.length - 1], then = rows[rows.length - 1 - lookbackWeeks];
  const p1 = atOrBefore(last.date), p0 = atOrBefore(then.date);
  if (p0 == null || p1 == null || !p0) return flat;
  const netPct = (r) => (r && r.oi ? (r.net / r.oi) * 100 : null);
  const n0 = netPct(then), n1 = netPct(last);
  if (n0 == null || n1 == null) return flat;
  const pricePct = ((p1 - p0) / p0) * 100;
  const netPctChg = n1 - n0;
  const w = lookbackWeeks, fmt = (v) => Math.abs(v).toFixed(1);
  if (pricePct >= 3 && netPctChg <= -1) {
    return { tone: 'bear', pricePct, netPctChg, weeks: w,
      read: `Price is up ${fmt(pricePct)}% over ${w} weeks while speculators <b>cut</b> their net position by ${fmt(netPctChg)} points of open interest — they are fading the move, not driving it.` };
  }
  if (pricePct <= -3 && netPctChg >= 1) {
    return { tone: 'bull', pricePct, netPctChg, weeks: w,
      read: `Price is down ${fmt(pricePct)}% over ${w} weeks while speculators <b>added</b> ${fmt(netPctChg)} points of open interest — they are buying into weakness.` };
  }
  if (Math.abs(pricePct) < 3 && Math.abs(netPctChg) < 1) {
    return { tone: 'flat', pricePct, netPctChg, weeks: w, read: `Little movement in either price or positioning over ${w} weeks.` };
  }
  return { tone: 'aligned', pricePct, netPctChg, weeks: w,
    read: `Price and positioning moved together over ${w} weeks (price ${pricePct >= 0 ? '+' : '−'}${fmt(pricePct)}%, net position ${netPctChg >= 0 ? '+' : '−'}${fmt(netPctChg)} points) — no divergence.` };
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

// ---------------------------------------------------------------------------
// Contract expiries. The brief used to assume "the 20th" for every market, which is right for WTI and
// wrong for almost everything else. These are the exchange's own rules, applied to a reference date:
//   CL  WTI       3 business days before the 25th of the month before delivery
//   BZ  Brent     last business day of the 2nd month before delivery
//   RB/HO         last business day of the month before delivery
//   NG           3 business days before the 1st of the delivery month
//   GC/SI/HG/PL/PA  3rd last business day of the delivery month
//   grains (ZC/ZW/ZS/ZM/ZL/ZR)  business day before the 15th of the month before delivery
//   softs / livestock / dairy   last business day of the month before delivery
// Weekends only — exchange holidays shift a date by a day or two, which is why the roll window is
// 0-2 days rather than an exact match.
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const prevBiz = (d) => { const x = new Date(d.getTime()); do { x.setUTCDate(x.getUTCDate() - 1); } while (isWeekend(x)); return x; };
const minusBiz = (d, n) => { let x = new Date(d.getTime()); for (let i = 0; i < n; i++) x = prevBiz(x); return x; };
const lastBiz = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return isWeekend(d) ? prevBiz(d) : d; };
const EXPIRY_RULES = {
  CL: { back: 1, at: (y, m) => minusBiz(new Date(Date.UTC(y, m, 25)), 3) },
  BZ: { back: 2, at: (y, m) => lastBiz(y, m) },
  RB: { back: 1, at: (y, m) => lastBiz(y, m) },
  HO: { back: 1, at: (y, m) => lastBiz(y, m) },
  NG: { back: 0, at: (y, m) => minusBiz(new Date(Date.UTC(y, m, 1)), 3) },
  GC: { back: 0, at: (y, m) => minusBiz(lastBiz(y, m), 2) },
  SI: { back: 0, at: (y, m) => minusBiz(lastBiz(y, m), 2) },
  HG: { back: 0, at: (y, m) => minusBiz(lastBiz(y, m), 2) },
  PL: { back: 0, at: (y, m) => minusBiz(lastBiz(y, m), 2) },
  PA: { back: 0, at: (y, m) => minusBiz(lastBiz(y, m), 2) },
  ALI: { back: 0, at: (y, m) => minusBiz(lastBiz(y, m), 2) },
  ZC: { back: 1, at: (y, m) => prevBiz(new Date(Date.UTC(y, m, 15))) },
  ZW: { back: 1, at: (y, m) => prevBiz(new Date(Date.UTC(y, m, 15))) },
  ZS: { back: 1, at: (y, m) => prevBiz(new Date(Date.UTC(y, m, 15))) },
  ZM: { back: 1, at: (y, m) => prevBiz(new Date(Date.UTC(y, m, 15))) },
  ZL: { back: 1, at: (y, m) => prevBiz(new Date(Date.UTC(y, m, 15))) },
  ZR: { back: 1, at: (y, m) => prevBiz(new Date(Date.UTC(y, m, 15))) },
  KC: { back: 1, at: (y, m) => lastBiz(y, m) },
  SB: { back: 1, at: (y, m) => lastBiz(y, m) },
  CC: { back: 1, at: (y, m) => lastBiz(y, m) },
  CT: { back: 1, at: (y, m) => lastBiz(y, m) },
  OJ: { back: 1, at: (y, m) => lastBiz(y, m) },
  LE: { back: 1, at: (y, m) => lastBiz(y, m) },
  HE: { back: 1, at: (y, m) => lastBiz(y, m) },
  GF: { back: 1, at: (y, m) => lastBiz(y, m) },
  DC: { back: 1, at: (y, m) => lastBiz(y, m) },
  CB: { back: 1, at: (y, m) => lastBiz(y, m) },
  GNF: { back: 1, at: (y, m) => lastBiz(y, m) },
  CSC: { back: 1, at: (y, m) => lastBiz(y, m) },
  DY: { back: 1, at: (y, m) => lastBiz(y, m) },
};
/** The expiry (YYYY-MM-DD) of the contract that is front month on `refIso`, or null if unknown. */
export function frontExpiry(root, refIso) {
  const rule = EXPIRY_RULES[root];
  if (!rule || !/^\d{4}-\d{2}-\d{2}$/.test(String(refIso))) return null;
  const ref = new Date(refIso + 'T00:00:00Z');
  for (let k = 0; k < 14; k++) {
    const base = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + k, 1));
    const y = base.getUTCFullYear();
    const deliv = base.getUTCMonth();
    const em = deliv - rule.back;                       // expiry month, relative to delivery
    const ey = y + Math.floor(em / 12);
    const mm = ((em % 12) + 12) % 12;
    const exp = rule.at(ey, mm);
    if (exp && exp.getTime() >= ref.getTime()) return exp.toISOString().slice(0, 10);   // still the front month ON expiry day
  }
  return null;
}

// ── Trailing-twelve-month reconciliation ──────────────────────────────────────────────────────────
// The headline TTM profit and the quarterly table are filled from two different caches. When one
// refreshed and the other did not, the page showed a trailing figure the quarters below it did not add
// up to — 110 US companies were more than 10% apart, and 140 kept a fiscal year while four newer
// quarters sat beside it. The quarters win when they are the newer window: they are contiguous and
// they are what the reader can add up. The fiscal year still wins when the quarter table is the stale
// side, which is recorded as `ttmQuarterGap` instead of being hidden.
const TTM_DAY = 86400000;

// ── Desk priority ─────────────────────────────────────────────────────────────────────────────────
// A daily brief is an editorial product, not a volatility ranking. Thin markets have a tiny daily σ,
// so a quote refresh in milk or cheddar scores 10-20× "a normal day" and outranks a 2% move in Brent.
// The score still orders the rows; the priority band decides which rows are allowed on the page.
//   1 = may lead the brief
//   2 = may appear
//   3 = only with a confirmed event (the event engine supplies that); never on a price move alone
// `flat` is the empirical backstop: a series that prints unchanged on a quarter of its days is thin,
// whatever the hand list says.
export const PRIORITY = {
  1: ['wti', 'brent', 'natgas', 'gold', 'copper', 'us', 'cn', 'jp', 'ea', 'in'],
  2: [
    'rbob', 'ulsd', 'jet', 'propane',
    'silver', 'aluminium', 'ironore', 'steel', 'platinum', 'palladium',
    'corn', 'wheat', 'soybean', 'soymeal', 'soyoil', 'sugar', 'coffee', 'cocoa', 'cotton', 'palm',
    'ae', 'ar', 'au', 'br', 'de', 'fr', 'hk', 'id', 'ke', 'kr', 'mx', 'my', 'ng', 'ph', 'qa',
    'sa', 'sg', 'th', 'tw', 'uk', 've', 'vn', 'za',
  ],
  3: ['milk', 'butter', 'nfdm', 'cheese', 'whey', 'cattle', 'hogs', 'feeder', 'rice', 'orange'],
};
const PRIORITY_SET = { 1: new Set(PRIORITY[1]), 3: new Set(PRIORITY[3]) };

export function priorityOf(item) {
  const x = typeof item === 'string' ? { id: item } : (item || {});
  if (x.flat != null && x.flat >= 25) return 3;          // stepped / thinly traded, regardless of list
  if (PRIORITY_SET[1].has(x.id)) return 1;
  if (PRIORITY_SET[3].has(x.id)) return 3;
  return 2;                                              // unknown = may appear, never assumed core
}

/**
 * Pick a brief's rows by priority band first, score second.
 * slots = how many rows each band may contribute; tier 3 defaults to zero because a price move alone
 * is not a reason. The event engine can pass { 3: 1 } once it can prove a confirmed story.
 */
export function rankByPriority(items, { max = 6, slots = { 1: 4, 2: 2, 3: 0 }, perGroup = 2 } = {}) {
  const byTier = { 1: [], 2: [], 3: [] };
  for (const x of items || []) {
    if (!x) continue;
    const tier = x.tier ?? priorityOf(x);
    if (!byTier[tier]) continue;
    byTier[tier].push({ ...x, tier });
  }
  const byScore = (a, b) => (b.score ?? 0) - (a.score ?? 0) || Math.abs(b.d1 ?? 0) - Math.abs(a.d1 ?? 0);
  for (const t of [1, 2, 3]) byTier[t].sort(byScore);

  const out = [], seen = new Set(), per = {};
  for (const t of [1, 2, 3]) {
    const cap = Math.min(slots[t] ?? 0, max - out.length);
    let taken = 0;
    for (const x of byTier[t]) {
      if (taken >= cap) break;
      if (seen.has(x.id)) continue;                       // one row per instrument / country
      const g = x.groupKey || (x.kind === 'bench' ? 'g:' + (x.group || '') : 'c:' + x.id);
      if ((per[g] || 0) >= perGroup) continue;            // a single complex cannot fill the page
      seen.add(x.id);
      per[g] = (per[g] || 0) + 1;
      out.push(x);
      taken++;
    }
  }
  return out;
}

/** Four consecutive quarters, each ~91 days after the last (52/53-week calendars allowed). */
// ── Event importance ─────────────────────────────────────────────────────────────────────────────
// The brief used to start from price moves and then look for a story that agreed with them. That is
// backwards: an index review, a sanction or an M&A announcement can matter far more than the day's
// biggest percentage, and a thin market can print a huge number for no reason. These helpers start
// from the wire, decide importance, and use the tape only as evidence.

export const EVENT_CATEGORIES = [
  { id: 'market-access', label: 'Market access', weight: 8,
    re: /\b(msci|ftse russell|reclassif\w*|index (review|inclusion|exclusion)|market access|capital controls?|trading halt|short-selling ban|emerging market status|frontier market)\b/i,
    mechanism: 'An index review or access change alters which passive funds must hold the market, so flows move at the review date.' },
  { id: 'sanctions', label: 'Sanctions / export curbs', weight: 9,
    re: /\b(sanctions?|embargo|export (ban|curb|quota|levy)|import ban|blockade|tariffs?)\b/i,
    mechanism: 'Sanctions or export curbs remove supply and reroute trade; the affected commodity and its substitutes reprice.' },
  { id: 'opec', label: 'OPEC+ / supply policy', weight: 9,
    re: /\b(opec\+?|production (cut|quota|policy)|output (cut|quota)|supply cut)\b/i,
    mechanism: 'OPEC+ output policy sets the physical supply floor; crude and product cracks follow.' },
  { id: 'data', label: 'Macro data', weight: 6,
    re: /\b(inflation|cpi|ppi|gdp|payrolls|jobs report|unemployment|pmi|retail sales|industrial production|econom\w* (shrank|grew|contracted|expanded|slowed))\b/i,
    mechanism: 'The print shifts rate expectations, which transmit to the currency, bonds and rate-sensitive equities.' },
  { id: 'geopolitics', label: 'Geopolitics', weight: 10,
    re: /\b(war|conflict|attack|missile|drone|invasion|escalat\w*|hormuz|red sea|suez|chokepoint|strait)\b/i,
    mechanism: 'Conflict raises supply and freight risk; energy and gold usually price it first.' },
  { id: 'sovereign', label: 'Sovereign risk', weight: 8,
    re: /\b(downgrade|default|imf|bailout|debt (crisis|ceiling)|credit rating|sovereign)\b/i,
    mechanism: 'A downgrade or default raises the country\'s funding cost and pressures its currency and banks.' },
  { id: 'central-bank', label: 'Central bank', weight: 8,
    re: /\b(fed|federal reserve|ecb|boj|pboc|rbi|bank of (england|japan|korea|indonesia)|central bank|rate (cut|hike|hold|decision))\b/i,
    mechanism: 'Policy rates set the discount rate and the currency; equities, bonds and gold all reprice.' },
  { id: 'supply', label: 'Supply shock', weight: 7,
    re: /\b(hurricane|typhoon|drought|frost|freeze|flood|outage|force majeure|strike|fire|explosion|disease|bird flu|swine fever|blight|mine (closure|halt)|refinery (fire|outage))\b/i,
    mechanism: 'A supply outage or crop loss tightens the physical market; the front of the curve moves first.' },
  { id: 'politics', label: 'Politics / unrest', weight: 6,
    re: /\b(election (result|results|win|won|victory|runoff|vote|uncertainty|jitters|fears|risk)|wins? (the )?election|referendum|coup|martial law|crackdown|protest\w* (strike|blockade|violence)|unrest)\b/i,
    mechanism: 'Elections and unrest change policy risk, which shows up in the currency and sovereign spreads.' },
  { id: 'policy', label: 'Policy support', weight: 7,
    re: /\b(stimulus|bailout|intervention|rescue|subsid\w*|support(ing)? (the )?(stock )?market|market support)\b/i,
    mechanism: 'Policy support changes the earnings and risk outlook; equities and the currency reprice together.' },
  { id: 'markets', label: 'Markets', weight: 5,
    re: /\b(stocks?|shares?|equit(y|ies)|index|indices|selloff|sell-off|rout|rally|wall street)\b/i,
    mechanism: 'A broad move is usually a rates or risk event; check the driver before treating it as sector-specific.' },
  { id: 'regulation', label: 'Regulation', weight: 5,
    re: /\b(antitrust|regulator|probe|investigation|fine|capital requirement|short-selling)\b/i,
    mechanism: 'Rules change who can trade and at what cost, so liquidity and the affected names reprice.' },
  { id: 'company', label: 'Company', weight: 4,
    re: /\b(ipo|earnings|profit warning|guidance|ceo|layoffs)\b/i,
    mechanism: 'A single-name event moves that company, not the whole market.' },
];

const SOURCE_TIERS = [
  [/bloomberg|financial times|ft\.com/i, 4],
  [/reuters|wall street journal|wsj|associated press|ap news/i, 3],
  [/cnbc/i, 2],
];

export function sourceTier(source) {
  const s = String(source || '');
  for (const [re, n] of SOURCE_TIERS) if (re.test(s)) return n;
  return 0;
}

export function escapeRe(s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First matching category wins, so the most specific rule must sit first in EVENT_CATEGORIES. */
export function classifyEvent(title) {
  const t = String(title || '');
  for (const c of EVENT_CATEGORIES) {
    const m = c.re.exec(t);
    if (m) return { id: c.id, label: c.label, weight: c.weight, mechanism: c.mechanism, topic: String(m[1] || m[0]).toLowerCase() };
  }
  return null;
}

const CAUSE_MARKER = /\s+(as|after|amid|because|following|due to|over|on fears?|on concerns?|on hopes?|on reports?|on speculation)\s+/i;
// A causal clause reads like a cause: it has a verb or a known event noun. "as nuclear weapons state"
// does not, so it stays part of the fact rather than being presented as a reason.
const CAUSE_VERB = /\b(flags?|flagged|reviews?|reviewed|warns?|warned|cuts?|cut|raises?|raised|holds?|held|bans?|banned|approves?|approved|rejects?|rejected|extends?|extended|imposes?|imposed|eases?|eased|tightens?|tightened|plans?|planned|agrees?|agreed|signals?|signalled|reports?|reported|says?|said|announces?|announced|launches?|launched|halts?|halted|resumes?|resumed|suspends?|suspended|intensif\w*|grows?|grew|rises?|rose|falls?|fell|drops?|dropped|jumps?|jumped|surges?|surged|plunges?|plunged|slumps?|slumped|accelerat\w*|slows?|slowed|beats?|misses?|unveils?|sets?|keeps?|kept|delays?|ends?|ended|starts?|seeks?|sought|bids?|buys?|bought|sells?|sold|offers?|strikes?|attacks?|seizes?|seized|closes?|closed|reopens?|reopened|reclassif\w*|downgrades?|upgrades?|defaults?|votes?|voted|elects?|protest\w*|invades?|withdraws?|exits?)\b/i;
const CAUSE_TAIL = /\b(fears?|concerns?|hopes?|news|data|report|review|decision|ban|tariff|sanction|downgrade|upgrade|strike|attack|outage|fire|drought|flood|export|import|policy|vote|election|protest|war|conflict|rate|inflation|gdp|jobs|payrolls|earnings|guidance|forecast|outlook|speculation|profit|bid|offer|deal|merger|acquisition)\b/i;

/**
 * Split a headline into the event and its stated cause: "Stocks sink as MSCI flags a review" →
 * { what: 'Stocks sink', why: 'MSCI flags a review' }. This is extraction, not invention — if the
 * wire does not state a cause, `why` is only the category mechanism, never a made-up link.
 */
export function splitCause(title) {
  const t = String(title || '').trim().replace(/\s+/g, ' ');
  const m = CAUSE_MARKER.exec(t);
  if (!m) return { what: t, why: null };
  const before = t.slice(0, m.index).trim();
  const after = t.slice(m.index + m[0].length).trim();
  if (before.length < 8 || after.length < 8) return { what: t, why: null };
  if (!CAUSE_VERB.test(after) && !CAUSE_TAIL.test(after)) return { what: t, why: null };
  return { what: before.replace(/[.;,]+$/, ''), why: after.replace(/[.;,]+$/, '') };
}

/** Match a headline against {id,label,kind,patterns[]} entries. String patterns are word-bounded. */
export function matchEntities(title, catalog = []) {
  const t = String(title || '');
  const out = [];
  for (const e of catalog || []) {
    for (const p of e.patterns || []) {
      const re = p instanceof RegExp ? p : new RegExp(`\\b${escapeRe(p)}\\b`, 'i');
      const at = t.search(re);
      if (at >= 0) { out.push({ ...e, at }); break; }
    }
  }
  return out;
}

function primaryEntity(hits, cls) {
  if (!hits.length) return null;
  const sorted = hits.slice().sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const countries = sorted.filter((h) => h.kind === 'country');
  const benches = sorted.filter((h) => h.kind === 'bench');
  if (['opec', 'supply'].includes(cls.id) && benches.length) return benches[0];
  if (['market-access', 'central-bank', 'data', 'politics', 'sovereign', 'markets', 'regulation'].includes(cls.id) && countries.length) return countries[0];
  return sorted[0];
}

const ANALYSIS_RE = /\b(what would|what if|explainer|analysis|opinion|commentary|column|podcast|newsletter|briefing|live updates?|markets wrap|stocks to watch|things to know|week ahead|day ahead|long read|interview|windfall|scores? \$|here'?s why|explained|guide|preview|would (shift|reshape|affect|change|impact|drive|push|help|hurt)|fall short of|is likely to|are likely to)\b|^when\b/i;

/**
 * Turn raw wire items into one event per (category, primary entity, day). Corroboration is counted
 * from distinct sources, and the headline kept is the most informative tier-1 one — preferably a
 * headline that states its own cause.
 */
export function clusterEvents(items, { catalog = [], now = Date.now(), refDate = null } = {}) {
  // refDate is the session the brief describes (the latest market close), not necessarily today:
  // a Sunday brief about Friday's close must still see Friday's news.
  const refMs = refDate ? Date.parse(`${refDate}T23:59:59Z`) : now;
  const nextDay = refDate ? new Date(Date.parse(`${refDate}T00:00:00Z`) + 864e5).toISOString().slice(0, 10) : null;
  const clusters = new Map();
  for (const it of items || []) {
    if (!it || !it.title) continue;
    if (ANALYSIS_RE.test(it.title)) continue;                // features and explainers are not the day's news
    const dayKey = String(it.date || '').slice(0, 10);
    if (nextDay && dayKey && dayKey > nextDay) continue;      // a later story cannot explain an older session
    const ageDays = it.date ? Math.max(0, Math.round((refMs - Date.parse(it.date)) / 864e5)) : 0;
    if (ageDays > 1) continue;                               // the session and the day after — not an archive
    const cls = it.category ? { id: it.category, label: it.categoryLabel || it.category, weight: it.weight || 5, mechanism: it.mechanism || null } : classifyEvent(it.title);
    if (!cls) continue;
    const hits = it.entities || matchEntities(it.title, catalog);
    const primary = primaryEntity(hits, cls);
    if (!primary && cls.weight < 9) continue;                 // only the heaviest global stories stand alone
    const day = dayKey || new Date(refMs).toISOString().slice(0, 10);
    const key = [cls.id, primary ? primary.id : 'global', day].join('|');
    let c = clusters.get(key);
    if (!c) {
      c = { key, category: cls.id, label: cls.label, weight: cls.weight, mechanism: cls.mechanism,
        topic: cls.topic || null,
        primary: primary ? { id: primary.id, label: primary.label, kind: primary.kind } : null,
        entities: hits.map((h) => ({ id: h.id, label: h.label, kind: h.kind })),
        items: [], sources: new Set(), date: day, ageDays };
      clusters.set(key, c);
    }
    c.items.push(it);
    if (it.source) c.sources.add(it.source);
  }
  const out = [];
  for (const c of clusters.values()) {
    const rank = (it) => sourceTier(it.source) * 10 + (splitCause(it.title).why ? 3 : 0) + (/\d/.test(it.title) ? 1 : 0);
    const best = c.items.slice().sort((a, b) => rank(b) - rank(a))[0];
    const { what, why } = splitCause(best.title);
    out.push({ ...c, sources: [...c.sources], source: best.source || null, url: best.url || null,
      at: best.date || null,
      what, why, whySource: why ? 'wire' : (c.mechanism ? 'rule' : null),
      corroboration: c.sources.size, titles: c.items.slice(0, 3).map((x) => x.title) });
    delete out[out.length - 1].items;
  }
  return out;
}

/**
 * Importance is category first, evidence second. Market confirmation adds points but never gates:
 * an MSCI consultation announced before the selling starts is exactly what a brief should catch.
 */
export function scoreEvents(clusters, { marketCtx = {}, seen = new Set(), watchlist = [] } = {}) {
  return (clusters || []).map((c) => {
    const market = (c.entities || [])
      .flatMap((e) => { const v = marketCtx[e.id]; return Array.isArray(v) ? v : v ? [v] : []; })
      .filter((m) => m && m.d1 != null)
      .sort((a, b) => Math.abs(b.d1) - Math.abs(a.d1))
      .slice(0, 3);
    const confirmed = market.some((m) => Math.abs(m.d1) >= (m.kind === 'index' ? 1.5 : m.kind === 'fx' ? 0.75 : 1));
    let score = c.weight * 10;
    score += sourceTier(c.source);
    score += Math.min(3, Math.max(0, (c.corroboration || 1) - 1));
    if (c.why) score += 2;                                    // a stated reason beats a generic rule
    if (confirmed) score += 4;
    score += c.primary ? (c.primary.kind === 'country' ? 1 : 0) : 3;
    const isNew = !seen.has(c.key);
    score += isNew ? 3 : 1;
    if (watchlist.includes(c.primary?.id)) score += 2;
    if (c.ageDays > 2) score -= (c.ageDays - 2) * 2;
    return { ...c, score: +score.toFixed(2), market, confirmed, novelty: isNew ? 'new' : 'developing' };
  }).sort((a, b) => b.score - a.score || a.ageDays - b.ageDays);
}

/** Diversity after ranking: a war cannot fill the page, and one country gets one story. */
export function selectEvents(scored, { max = 5, perCategory = 2 } = {}) {
  const out = [], cats = {}, ents = new Set();
  for (const e of scored || []) {
    if (out.length >= max) break;
    if ((cats[e.category] || 0) >= perCategory) continue;
    const pk = e.primary ? e.primary.id : 'global';
    if (ents.has(pk)) continue;
    // The dairy/livestock guard: a specialist market needs a confirmed event or a second wire, not
    // just a big quote move.
    if (e.primary && e.primary.kind === 'bench' && priorityOf(e.primary.id) === 3
      && !(e.corroboration >= 2 || e.confirmed)) continue;
    cats[e.category] = (cats[e.category] || 0) + 1;
    ents.add(pk);
    out.push(e);
  }
  return out;
}

const EXPOSURE_TAGS = [
  ['tech', /\b(tech|technology|AI|chips?|semiconductors?|Nasdaq|software|internet)\b/i],
  ['metals', /\b(gold|silver|copper|metals?|mining|platinum|aluminium|aluminum|iron ore|steel)\b/i],
  ['oil', /\b(oil|crude|OPEC|refiners?|diesel|gasoline|LNG|natural gas)\b/i],
  ['ags', /\b(wheat|corn|soybeans?|sugar|coffee|cocoa|cotton|palm|rice|cattle|cattle|hogs?|milk|butter|cheese)\b/i],
];

export function textTags(text) {
  const t = String(text || '');
  return EXPOSURE_TAGS.filter(([, re]) => re.test(t)).map(([tag]) => tag);
}

/**
 * Give every row a reason. The row's own wire story wins; then a regional peer story; then a global
 * theme that matches the market's exposure (tech, metals, oil, ags); then a peer row that already has
 * a verified reason. The last step is labelled GLOBAL/COMMODITY in the UI, so a shared driver is never
 * passed off as a country-specific cause.
 */
export function explainRows(rows, clusters, { exposures = {}, groups = {}, directionOf = () => null, seed = [] } = {}) {
  const tagsOf = (r) => exposures[r.id] || (r.kind === 'bench' ? textTags(r.group || '') : []);
  // The hero is not in `rows`, but its reason is often the best shared driver (gold for a metals
  // exporter, the US tech story for Asia). Include it, and prefer the largest verified peer move.
  const withWhy = [...(rows || []), ...seed]
    .filter((r) => r && r.why && r.why.title)
    .sort((a, b) => Math.abs(b.d1 ?? 0) - Math.abs(a.d1 ?? 0));
  const scoreOf = (c) => c.score ?? (c.weight || 0) * 10;
  const best = (pred) => (clusters || []).filter(pred).sort((a, b) => scoreOf(b) - scoreOf(a))[0] || null;
  const textOf = (c) => [c.what, c.why, ...(c.titles || [])].filter(Boolean).join(' ');
  const MARKET_WORDS = {
    index: /\b(stocks?|shares?|equit(y|ies)|index|indices|bourse|selloff|sell-off|rout|rally|wall street|market)\b/i,
    fx: /\b(currenc\w*|forex|\bfx\b|dollar|euro|yen|yuan|won|rand|rupiah|rupee|peso|riyal|exchange rate|central bank|intervention|reserves|rate (cut|hike|hold))\b/i,
    bench: /\b(price[sd]?|futures?|spot|supply|demand|output|production|inventor(y|ies)|stocks?|export[s]?|import[s]?|sanction[sd]?|tariff[s]?|mine[s]?|refin\w*|harvest|crop[s]?|opec|drought|strike|outage)\b/i,
  };
  const relevant = (c, r, want) => {
    const t = textOf(c);
    // The story must be about the right market: a Tokyo inflation print is not an equity-market fall,
    // and an Indian rupee story is not a Korean index driver.
    if (!(MARKET_WORDS[r.kind === 'bench' ? 'bench' : r.kind === 'fx' ? 'fx' : 'index']).test(t)) return false;
    const d = directionOf(t);
    return d == null || d === want;
  };
  return (rows || []).map((r) => {
    if (!r || r.why || r.kind === 'deal' || r.d1 == null) return r;
    const want = r.d1 >= 0 ? 'up' : 'down';
    const tags = tagsOf(r);
    const group = groups[r.id] || null;
    let c = best((e) => e.primary && e.primary.id === r.id && relevant(e, r, want));
    let scope = 'direct';
    // A peer row that already carries a verified reason is the safest shared driver: the US tech story
    // for Japan/Korea, the gold story for a metals exporter.
    if (!c && tags.length) {
      const p = withWhy.find((x) => tagsOf(x).some((t) => tags.includes(t))
        && (() => { const d = directionOf([x.why.title, x.why.source].join(' ')); return d == null || d === want; })());
      if (p) return { ...r, why: { ...p.why, scope: tags.includes('metals') ? 'commodity' : 'global', via: p.label } };
    }
    if (!c && tags.length) {
      c = best((e) => relevant(e, r, want) && textTags(textOf(e)).some((t) => tags.includes(t)));
      scope = 'global';
    }
    if (!c && group) { c = best((e) => e.primary && groups[e.primary.id] === group && relevant(e, r, want)); scope = 'regional'; }
    if (c) return { ...r, why: { title: (c.titles && c.titles[0]) || c.what, source: c.source, url: c.url, scope, via: c.label } };
    return r;
  });
}

export function quartersContiguous(q) {
  if (!Array.isArray(q) || q.length < 2) return true;
  // 52/53-week retailers have a 16-week fiscal Q4 (Costco: Q3 May → Q4 Aug is ~112 days); the first
  // three gaps stay at 12 weeks. Allow that one wider final gap without accepting a missing quarter
  // elsewhere.
  return q.every((x, i) => i === 0
    || (() => {
      const d = (Date.parse(x.end) - Date.parse(q[i - 1].end)) / TTM_DAY;
      return d >= 80 && d <= (i === q.length - 1 ? 125 : 100);
    })());
}

/** Reconcile `netIncomeTTM` with the last four quarters in place. Returns what changed. */
export function reconcileTtm(rows) {
  const stat = { adopted: 0, held: 0, gaps: 0, unresolved: 0, changes: [] };
  for (const c of rows || []) {
    const q = (c.quarters || []).slice(-4);
    const complete = q.length === 4 && q.every((x) => x.netIncome != null) && quartersContiguous(q);
    if (!complete) {
      c.ttmFromQuarters = false;
      c.ttmQuarterGap = false;
      if (c.netIncomeTTM != null && !(c.quarters || []).length) stat.unresolved++;
      continue;
    }
    const sum = q.reduce((a, x) => a + x.netIncome, 0);
    const lastEnd = q[3].end;
    const asOf = c.netIncomeTTMAsOf || null;
    const diff = c.netIncomeTTM == null ? Infinity : Math.abs(sum - c.netIncomeTTM) / Math.abs(c.netIncomeTTM || 1);
    const quartersNewer = !asOf || lastEnd > asOf;
    const samePeriod = asOf && lastEnd === asOf;

    if (quartersNewer || (samePeriod && diff > 0.02)) {
      if (c.netIncomeTTM !== sum || asOf !== lastEnd) {
        stat.changes.push([c.ticker, c.netIncomeTTM, asOf, sum, lastEnd]);
        c.netIncomeTTM = sum;
        c.netIncomeTTMAsOf = lastEnd;
        stat.adopted++;
      }
      c.ttmFromFY = false;
      c.ttmRejected = null;
      c.ttmFromQuarters = true;
      c.ttmQuarterGap = false;
    } else if (asOf && lastEnd < asOf) {
      c.ttmFromQuarters = false;
      c.ttmQuarterGap = true;
      stat.gaps++;
    } else {
      c.ttmFromQuarters = false;
      c.ttmQuarterGap = false;
      // The annual fallback and the four complete quarters agree. Adopt the quarter table anyway so
      // the page stops calling a fully reconstructed TTM a fiscal-year fallback (Costco after Q4).
      if (complete && samePeriod && diff <= 0.02) {
        c.netIncomeTTM = sum;
        c.netIncomeTTMAsOf = lastEnd;
        c.ttmFromFY = false;
        c.ttmRejected = null;
        c.ttmFromQuarters = true;
      }
      stat.held++;
    }
  }
  return stat;
}

// Keep every filing period the platform has ever published.
//
// A market build rebuilds its period table from the vendor page, and that page is a rolling window —
// five fiscal years today, still five next year. A year that scrolls off the page would vanish from the
// company page, so the record could never grow past five years. The fix is to restore only the periods
// that are OLDER than the window the vendor still covers. Anything inside the window is the new build's
// answer: a corrected parse (China Eastern's dates were "2022-01-01" before the cross-list fix) must win,
// and a restatement replaces the old figure.
export function mergePeriods(prev, next, key) {
  const list = Array.isArray(next) ? next : [];
  const before = Array.isArray(prev) ? prev : [];
  const dateOf = (r) => {
    const v = r && r[key];
    if (typeof v === 'string') return v;
    // The US fiscal-year table keys on a numeric `fy` (2025), not a date string.
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
  };
  const fresh = list.filter((r) => dateOf(r));
  if (!fresh.length) return before;
  const oldest = fresh.reduce((m, r) => (dateOf(r) < m ? dateOf(r) : m), dateOf(fresh[0]));
  const by = new Map();
  for (const r of before) {
    const d = dateOf(r);
    if (d && d < oldest) by.set(d, r);
  }
  for (const r of fresh) by.set(dateOf(r), r);
  // The fresh table sets the direction; the build always writes ascending, but a descending table must
  // not be flipped by the merge.
  const first = dateOf(fresh[0]);
  const last = dateOf(fresh[fresh.length - 1]);
  const asc = first <= last;
  return [...by.entries()]
    .sort((a, b) => (asc ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0])))
    .map(([, r]) => r);
}

// Merge a price series so the stored history keeps growing instead of sliding.
//
// Every market build downloads a fixed window (five years, ten for the US) and replaces the stored
// series, so the chart would still show five years in 2036. Keep the points that are OLDER than the
// window the source still covers and let the fresh download win everywhere inside it.
//
// A split rewrites every past price on the source, so a naive append would leave a cliff at the seam.
// The overlap is compared first: if the fresh prices are a consistent fraction of the stored ones
// (a split, or its reverse), the older points are scaled by that factor before they are kept.
export function mergeSeriesPoints(prev, next) {
  const p = (prev || []).filter((x) => x && x.d && x.c > 0);
  const n = (next || []).filter((x) => x && x.d && x.c > 0);
  if (!n.length) return p;
  if (!p.length) return n;
  const oldest = n[0].d;
  const was = new Map(p.map((x) => [x.d, x.c]));
  const ratios = [];
  for (const x of n) {
    const before = was.get(x.d);
    if (before > 0) ratios.push(x.c / before);
  }
  let factor = 1;
  if (ratios.length >= 5) {
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    if (Math.abs(median - 1) > 0.02) {
      // A split is a clean ratio; snap to one when the median is within 2% of it, otherwise trust the
      // measured factor (a currency redenomination is not a clean split).
      const clean = [0.01, 0.02, 0.05, 0.1, 1 / 8, 0.2, 0.25, 1 / 3, 0.5, 2, 3, 4, 5, 8, 10, 20, 100];
      factor = clean.find((c) => Math.abs(median - c) / c < 0.02) || median;
    }
  }
  const out = new Map();
  for (const x of p) {
    if (x.d < oldest) out.set(x.d, { d: x.d, c: +(x.c * factor).toFixed(6) });
  }
  for (const x of n) out.set(x.d, { d: x.d, c: x.c });
  return [...out.values()].sort((a, b) => a.d.localeCompare(b.d));
}
