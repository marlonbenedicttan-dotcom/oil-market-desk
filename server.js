// Marlon's Watchtower — paper vs physical spreads across energy benchmarks + live tankers.
// Zero runtime dependencies: Node's built-in HTTP, fetch and WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { sendMail } from './src/smtp.js';
import { fileURLToPath } from 'node:url';
import { sgn, businessDaysSince, inBox, haversineNm, horizonDeltas, horizonDeltasAbs, isoWeek, monthly, pctOver, percentile, lastNonNull, escHtml, webhookPayload, realizedVol, computeCracks, computeCrush, backAdjust, pearson, logReturns, curveTightness, inventoryTightness, weightedScore, seasonalGrade, seasonalAhead, contractMonthsBetween, signedPosition, signedMove, stretchScore, sdLabel, attributeMoves, newsContextOk, METHODOLOGY, positioningFlag, positioningRead, maxDrawdown, realizedVolTerm, corrMatrix, fxAdjust, parseOcc, drawdownWord, volWord, volTrend, topPairs, bestDiversifier, riskRead } from './src/lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const UA = { 'User-Agent': 'Mozilla/5.0 (oil-basis)' };

// Annual macro snapshot (IMF WEO), refreshed by the scheduled scripts/fetch-macro.mjs job. The
// IMF API is blocked from this host, so we serve the committed snapshot instead. Read once at
// startup — it only changes on a commit, which redeploys us. Absent -> per-source fallback.
const MACRO_SNAPSHOT = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'macro.json'), 'utf8')); } catch { return null; } })();
const USDA_SNAPSHOT = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'usda.json'), 'utf8')); } catch { return null; } })();

// ---------------------------------------------------------------------------
// Benchmark registry
//   paper    = futures    -> Yahoo Finance symbol
//   physical = spot/cash  -> FRED / EIA series id
// Add a row to add a benchmark (both feeds must exist for free).
// ---------------------------------------------------------------------------
const BENCHMARKS = [
  // ---- Energy ----
  { id: 'wti',    label: 'WTI (Cushing)',   group: 'Crude',   unit: '$/bbl',   dp: 2, paper: 'CL=F', physical: 'DCOILWTICO', source: 'fred' },
  { id: 'brent',  label: 'Brent',           group: 'Crude',   unit: '$/bbl',   dp: 2, paper: 'BZ=F', physical: 'DCOILBRENTEU', source: 'fred' },
  { id: 'rbob',   label: 'RBOB Gasoline',   group: 'Refined', unit: '$/gal',   dp: 3, paper: 'RB=F', physical: 'DGASUSGULF', source: 'fred' },
  { id: 'ulsd',   label: 'ULSD / Heating',  group: 'Refined', unit: '$/gal',   dp: 3, paper: 'HO=F', physical: 'DHOILNYH', source: 'fred' },
  { id: 'jet',    label: 'Jet Fuel (USGC)', group: 'Refined', unit: '$/gal',   dp: 3, paper: null,   physical: 'EER_EPJK_PF4_RGC_DPG', source: 'eia' },
  { id: 'propane',label: 'Propane (Mt Belvieu)', group: 'Refined', unit: '$/gal', dp: 3, paper: null, physical: 'EER_EPLLPA_PF4_Y44MB_DPG', source: 'eia' },
  { id: 'natgas', label: 'Natural Gas',     group: 'Gas',     unit: '$/MMBtu', dp: 2, paper: 'NG=F', physical: 'DHHNGSP', source: 'fred' },
  // ---- Metals (futures only — no free spot) ----
  { id: 'gold',     label: 'Gold',      group: 'Metals', unit: '$/oz', dp: 2, paper: 'GC=F', physical: null },
  { id: 'silver',   label: 'Silver',    group: 'Metals', unit: '$/oz', dp: 3, paper: 'SI=F', physical: null },
  { id: 'copper',   label: 'Copper',    group: 'Metals', unit: '$/lb', dp: 4, paper: 'HG=F', physical: null },
  { id: 'aluminium',label: 'Aluminium', group: 'Metals', unit: '$/t',  dp: 0, paper: 'ALI=F', physical: null },
  { id: 'platinum', label: 'Platinum',  group: 'Metals', unit: '$/oz', dp: 2, paper: 'PL=F', physical: null },
  { id: 'palladium',label: 'Palladium', group: 'Metals', unit: '$/oz', dp: 2, paper: 'PA=F', physical: null },
  // ---- Agriculture (futures only) ----
  { id: 'corn',    label: 'Corn',     group: 'Agriculture', unit: '¢/bu', dp: 1, paper: 'ZC=F', physical: null },
  { id: 'wheat',   label: 'Wheat',    group: 'Agriculture', unit: '¢/bu', dp: 1, paper: 'ZW=F', physical: null },
  { id: 'soybean', label: 'Soybeans', group: 'Agriculture', unit: '¢/bu', dp: 1, paper: 'ZS=F', physical: null },
  { id: 'soymeal', label: 'Soybean Meal', group: 'Agriculture', unit: '$/ton', dp: 1, paper: 'ZM=F', physical: null },
  { id: 'soyoil',  label: 'Soybean Oil',  group: 'Agriculture', unit: '¢/lb', dp: 2, paper: 'ZL=F', physical: null },
  { id: 'sugar',   label: 'Sugar',    group: 'Agriculture', unit: '¢/lb', dp: 2, paper: 'SB=F', physical: null },
  { id: 'coffee',  label: 'Coffee',   group: 'Agriculture', unit: '¢/lb', dp: 2, paper: 'KC=F', physical: null },
  { id: 'cocoa',   label: 'Cocoa',    group: 'Agriculture', unit: '$/t',  dp: 0, paper: 'CC=F', physical: null },
  { id: 'cotton',  label: 'Cotton',   group: 'Agriculture', unit: '¢/lb', dp: 2, paper: 'CT=F', physical: null },
  { id: 'palm',    label: 'Palm Oil', group: 'Agriculture', unit: '$/t',  dp: 0, paper: 'CPO=F', physical: null },
  // ---- Livestock (futures only) ----
  { id: 'cattle',  label: 'Live Cattle',   group: 'Livestock', unit: '¢/lb', dp: 2, paper: 'LE=F', physical: null },
  { id: 'hogs',    label: 'Lean Hogs',     group: 'Livestock', unit: '¢/lb', dp: 2, paper: 'HE=F', physical: null },
  { id: 'feeder',  label: 'Feeder Cattle', group: 'Livestock', unit: '¢/lb', dp: 2, paper: 'GF=F', physical: null },
  // ---- Dairy (CME futures only — no free spot/inventories) ----
  { id: 'milk',   label: 'Class III Milk',  group: 'Dairy', unit: '$/cwt', dp: 2, paper: 'DC=F',  physical: null },
  { id: 'butter', label: 'Butter',          group: 'Dairy', unit: '¢/lb',  dp: 1, paper: 'CB=F',  physical: null },
  { id: 'nfdm',   label: 'Nonfat Dry Milk', group: 'Dairy', unit: '¢/lb',  dp: 1, paper: 'GNF=F', physical: null },
  { id: 'cheese', label: 'Cheddar Cheese',  group: 'Dairy', unit: '$/lb',  dp: 3, paper: 'CSC=F', physical: null },
  { id: 'whey',   label: 'Dry Whey',        group: 'Dairy', unit: '¢/lb',  dp: 1, paper: 'DY=F',  physical: null },
];

// ---------------------------------------------------------------------------
// Markets — the grouping the Big Picture is built around. Benchmarks are the
// data layer (one instrument each); a market bundles related benchmarks, e.g.
// WTI + Brent make one "Crude oil" market. The capability flags decide which
// panels apply (Phase C makes the panels adapt; Phase A only uses the grouping).
//   primary = instrument used for the headline price/number
// ---------------------------------------------------------------------------
const MARKETS = [
  { id: 'crude',      label: 'Crude oil',       group: 'Crude',   primary: 'wti',    components: ['wti', 'brent'],                             hasBasis: true,  hasInventories: true,  hasShips: true },
  { id: 'refined',    label: 'Refined products', group: 'Refined', primary: 'rbob',   components: ['rbob', 'ulsd', 'jet', 'propane'],           hasBasis: true,  hasInventories: true,  hasShips: true },
  { id: 'gas',        label: 'Natural gas',      group: 'Gas',     primary: 'natgas', components: ['natgas'],                                   hasBasis: true,  hasInventories: true,  hasShips: false },
  { id: 'precious',   label: 'Precious metals',   group: 'Metals',      primary: 'gold',   components: ['gold', 'silver', 'platinum', 'palladium'],  hasBasis: false, hasInventories: false, hasShips: false },
  { id: 'industrial', label: 'Industrial metals', group: 'Metals',      primary: 'copper', components: ['copper', 'aluminium'],              hasBasis: false, hasInventories: false, hasShips: false },
  { id: 'grains',     label: 'Grains & oilseeds',  group: 'Agriculture', primary: 'corn',   components: ['corn', 'wheat', 'soybean', 'soymeal', 'soyoil'], hasBasis: false, hasInventories: false, hasShips: false },
  { id: 'softs',      label: 'Softs',             group: 'Agriculture', primary: 'sugar',  components: ['sugar', 'coffee', 'cocoa', 'cotton', 'palm'], hasBasis: false, hasInventories: false, hasShips: false },
  { id: 'livestock',  label: 'Livestock',         group: 'Livestock',   primary: 'cattle', components: ['cattle', 'hogs', 'feeder'],                hasBasis: false, hasInventories: false, hasShips: false },
  { id: 'dairy',      label: 'Dairy',             group: 'Dairy',       primary: 'milk',   components: ['milk', 'butter', 'nfdm', 'cheese', 'whey'], hasBasis: false, hasInventories: false, hasShips: false },
];
function getMarkets() {
  return MARKETS.map((m) => ({
    ...m,
    components: m.components.map((id) => {
      const b = BENCHMARKS.find((x) => x.id === id);
      return { id, label: b?.label || id, unit: b?.unit || '', dp: b?.dp ?? 2, paper: b?.paper || null };
    }),
    hasCurve: m.components.some((id) => CURVE_SPEC[id]),
    hasCOT: true, // CFTC covers every one of these markets
  }));
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function yahooSeries(symbol, range = '6mo', interval = '1d') {
  const res = await fetch(`${YF}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, { headers: UA });
  if (!res.ok) throw new Error(`yahoo ${symbol} -> ${res.status}`);
  const r = (await res.json()).chart?.result?.[0];
  if (!r) throw new Error(`yahoo ${symbol} -> no result`);
  const ts = r.timestamp || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  const series = {};
  ts.forEach((t, i) => { if (close[i] != null) series[new Date(t * 1000).toISOString().slice(0, 10)] = close[i]; });
  // Prefer the newest close in the series: Yahoo's `regularMarketPrice` can be a STALE quote for
  // legacy/alt symbols — e.g. CPO=F (palm) reports a Mar-2024 price while its daily bars are current.
  const last = lastNonNull(close);
  return { symbol, price: last != null ? last : (r.meta.regularMarketPrice ?? null), series };
}

async function fredSeries(id, days = 220) {
  const cosd = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, { headers: UA });
  if (!res.ok) throw new Error(`fred ${id} -> ${res.status}`);
  const text = await res.text();
  const out = {};
  for (const line of text.trim().split('\n').slice(1)) {
    const [d, v] = line.split(',');
    if (v && v !== '.') out[d] = parseFloat(v);
  }
  return out;
}

// EIA v2 spot prices — needs a free EIA_API_KEY. Returns {} if the key is absent.
async function eiaSeries(id, days = 220) {
  const key = process.env.EIA_API_KEY;
  if (!key) return {};
  const p = new URLSearchParams();
  p.set('api_key', key);
  p.set('frequency', 'daily');
  p.append('data[0]', 'value');
  p.append('facets[series][]', id);
  p.set('start', new Date(Date.now() - days * 864e5).toISOString().slice(0, 10));
  p.append('sort[0][column]', 'period');
  p.append('sort[0][direction]', 'asc');
  p.set('length', '5000');
  const res = await fetch(`https://api.eia.gov/v2/petroleum/pri/spt/data/?${p}`, { headers: UA });
  if (!res.ok) throw new Error(`eia ${id} -> ${res.status}`);
  const json = await res.json();
  const out = {};
  for (const row of json.response?.data || []) out[row.period] = parseFloat(row.value);
  return out;
}

const spotSeries = (b, days) => (!b.physical ? Promise.resolve({}) : b.source === 'eia' ? eiaSeries(b.physical, days) : fredSeries(b.physical, days));

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const cache = new Map();
const inflight = new Map();   // in-flight de-dupe: concurrent callers of the same key share one job
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const fly = inflight.get(key);
  if (fly) return fly;                         // someone is already computing it — wait for theirs
  const p = (async () => { try { const v = await fn(); cache.set(key, { t: Date.now(), v }); return v; } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

const paperFor = (b) => (b.paper ? cached('p:' + b.paper, 180_000, () => yahooSeries(b.paper, '5d', '1d')) : Promise.resolve({ price: null }));
const physFor = (b) => (b.physical ? cached('f:' + b.physical, 3_600_000, () => spotSeries(b, 14)) : Promise.resolve({}));
const hPaperFor = (b) => (b.paper ? cached('hp:' + b.paper, 3_600_000, () => yahooSeries(b.paper, '2y', '1d')) : Promise.resolve({ series: {} }));
const hPhysFor = (b) => (b.physical ? cached('hf:' + b.physical, 3_600_000, () => spotSeries(b, 380)) : Promise.resolve({}));
// ~2 years of daily prices for the multi-horizon deltas: a plain '1y' range starts a
// day or two short of a full year, which would leave the 1-year move null.
const deltaSeries = (sym) => (sym ? cached('dl2y:' + sym, 3_600_000, () => yahooSeries(sym, '2y', '1d')) : Promise.resolve({ series: {} }));

// ---------------------------------------------------------------------------
// Market snapshot
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate-limit-friendly contract-month fetch: retries with backoff, only caches non-empty.
async function contractSeries(symbol) {
  const key = 'cur:' + symbol;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 6 * 3600e3) return hit.v;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await yahooSeries(symbol, '2y', '1d');
      if (r && Object.keys(r.series).length) { cache.set(key, { t: Date.now(), v: r.series }); return r.series; }
    } catch {}
    await sleep(600);
  }
  return {};
}

async function getMarket() {
  const rows = await Promise.all(BENCHMARKS.map(async (b) => {
    const [p, f] = await Promise.all([paperFor(b), physFor(b)]);
    const dates = Object.keys(f).sort();
    const last = dates[dates.length - 1] ?? null;
    const prev = dates[dates.length - 2] ?? null;
    const physical = last != null ? f[last] : null;
    const prevPhys = prev != null ? f[prev] : null;
    const paper = p.price ?? null;
    const pDates = Object.keys(p.series || {}).sort();
    return {
      id: b.id, label: b.label, group: b.group, unit: b.unit, dp: b.dp,
      paper, physical, physicalDate: last, curve: Boolean(CURVE_SPEC[b.id]), cot: Boolean(COT_NAMES[b.id]),
      basis: paper != null && physical != null ? physical - paper : null,
      spotLagDays: businessDaysSince(last),
      spotJumpPct: physical != null && prevPhys ? ((physical - prevPhys) / prevPhys) * 100 : null,
      // Freshness: where each number comes from and how current it is (futures are live;
      // real-barrel assessments lag). The UI shows these as a source + as-of badge.
      paperDate: pDates[pDates.length - 1] ?? null,
      paperSource: b.paper ? 'Yahoo Finance' : null,
      physicalSource: b.physical ? (b.source === 'eia' ? 'EIA' : 'FRED') : null,
    };
  }));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  const spreads = {};
  if (by.brent && by.wti) {
    spreads.brent_wti = {
      label: 'Brent − WTI', unit: '$/bbl', dp: 2,
      paper: by.brent.paper - by.wti.paper,
      physical: by.brent.physical - by.wti.physical,
    };
  }

  // Data-quality checks: staleness, suspicious prints, and curve corroboration.
  let curves = null; try { curves = await getCurves(); } catch {}
  const flags = [];
  const lagged = rows.filter((r) => r.spotLagDays != null && r.spotLagDays >= 3);
  if (lagged.length) flags.push({ level: 'watch', text: `Real-barrel prices are about ${Math.max(...lagged.map((r) => r.spotLagDays))} days old while futures are live, so the real-vs-futures gap can look off.` });
  for (const r of rows) {
    if (r.spotJumpPct != null && Math.abs(r.spotJumpPct) >= 8) flags.push({ level: 'watch', text: `${r.label}: a real-barrel price jumped ${sgn(r.spotJumpPct, 1)}% in one day — worth double-checking.` });
  }
  for (const id of ['wti', 'brent']) {
    const r = by[id]; const c = curves?.[id];
    if (r && c && c.m1m2 != null && r.basis != null) {
      const ratio = Math.abs(r.basis) / (Math.abs(c.m1m2) || 1);
      if (ratio > 3) flags.push({ level: 'watch', text: `${r.label}: the real-vs-futures gap (${sgn(r.basis)}) is far bigger than the month-to-month gap (${sgn(c.m1m2)}) — probably a timing mismatch, not a clean signal.` });
    }
  }
  return {
    updated: new Date().toISOString(),
    version: BUILD,
    benchmarks: rows,
    spreads,
    quality: { flags, curveAvailable: Boolean(curves) },
    methodology: METHODOLOGY,
    notes: [
      'Futures = live. Real barrels = an official assessment that LAGS and comes from a different source — read the data checks.',
      'Propane & jet fuel have no futures — real-barrel price only.',
      'A positive gap means real barrels cost more than futures (a tight market).',
      'The futures line is the current month only (not spliced); "prices for months ahead" is the cleanest read.',
      'Dubai / WTI Midland / Mars need a paid data source.',
      'Aluminium (COMEX ALI) and livestock (CME cattle/hogs) are Yahoo futures — live, no key. There is no free spot for either, so they are futures-only (no basis).',
    ],
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
// A dated price map → its move over every standard window (see horizonDeltas).
// null for an empty/short map so callers can just show "—".
function mapDeltas(map) {
  const dates = Object.keys(map || {}).sort();
  if (dates.length < 2) return null;
  return { asOf: dates[dates.length - 1], ...horizonDeltas(dates, dates.map((d) => map[d])) };
}
async function getHistory() {
  const list = BENCHMARKS;
  const maps = {};
  await Promise.all(list.map(async (b) => {
    let paper = {}, physical = {};
    try { paper = (await hPaperFor(b)).series || {}; } catch {}   // one flaky symbol must NOT 500 the whole endpoint
    try { physical = (await hPhysFor(b)) || {}; } catch {}
    maps[b.id] = { paper, physical };
  }));

  const allDates = new Set();
  for (const b of list) {
    Object.keys(maps[b.id].paper).forEach((d) => allDates.add(d));
    Object.keys(maps[b.id].physical).forEach((d) => allDates.add(d));
  }
  const dates = [...allDates].sort().slice(-120);
  const at = (o, d) => (o[d] != null ? o[d] : null);

  const series = {};
  const basis = {};
  for (const b of list) {
    const pm = maps[b.id].paper;
    const fm = maps[b.id].physical;
    series[b.id] = { paper: dates.map((d) => at(pm, d)), physical: dates.map((d) => at(fm, d)) };
    basis[b.id] = dates.map((d) => (at(fm, d) != null && at(pm, d) != null ? at(fm, d) - at(pm, d) : null));
  }

  const spreads = {};
  if (maps.brent && maps.wti) {
    spreads.brent_wti = {
      paper: dates.map((d) => (at(maps.brent.paper, d) != null && at(maps.wti.paper, d) != null ? at(maps.brent.paper, d) - at(maps.wti.paper, d) : null)),
      physical: dates.map((d) => (at(maps.brent.physical, d) != null && at(maps.wti.physical, d) != null ? at(maps.brent.physical, d) - at(maps.wti.physical, d) : null)),
    };
  }

  // Multi-horizon deltas, per instrument, from the FULL maps (the chart arrays are
  // trimmed to 120 points, too short to reach a year back).
  const deltas = {};
  for (const b of list) deltas[b.id] = { paper: mapDeltas(maps[b.id].paper), physical: mapDeltas(maps[b.id].physical) };

  return { dates, series, basis, spreads, deltas };
}

// ---------------------------------------------------------------------------
// Charting — one resolver for every chartable metric
//   <benchId> | basis:<benchId> | fx:<fxId>   (spreads are handled from /api/history)
// ---------------------------------------------------------------------------
function resolveMetric(id) {
  if (!id) return null;
  if (id.startsWith('fx:')) { const f = FX_SYMS.find((x) => x.id === id.slice(3)); return f ? { kind: 'fx', f } : null; }
  if (id.startsWith('basis:')) { const b = BENCHMARKS.find((x) => x.id === id.slice(6)); return b ? { kind: 'basis', b } : null; }
  if (id.startsWith('rate:')) { const r = RATES.find((x) => x.id === id.slice(5)); return r ? { kind: 'rate', r } : null; }
  const b = BENCHMARKS.find((x) => x.id === id);
  return b ? { kind: 'bench', b } : null;
}
// % change from the first to the last non-null value.
const rowPct = (arr) => { const f = arr.find((x) => x != null); const l = [...arr].reverse().find((x) => x != null); return f && l ? ((l - f) / f) * 100 : null; };

// Multi-year history, bucketed by month (or week for 1–2y), with % performance.
async function getLongterm(id, years = 10) {
  const m = resolveMetric(id);
  if (!m) return { error: 'unknown metric' };
  const interval = years >= 3 ? '1mo' : '1wk';
  const summ = (arr) => ({ total: pctOver(arr, arr.length), last5y: pctOver(arr, 60), last1y: pctOver(arr, 12) });

  if (m.kind === 'fx') {
    const f = m.f;
    const raw = (await cached(`ltq:${f.sym}:${years}`, 6 * 3600e3, () => yahooSeries(f.sym, `${years}y`, interval))).series;
    const p = monthly(raw);
    const months = Object.keys(p).sort();
    const paper = months.map((k) => p[k]);
    return { id, label: f.label, unit: '', dp: f.dp, kind: 'fx', years, months, series: { paper, physical: months.map(() => null) }, summary: { paper: summ(paper), physical: null } };
  }

  if (m.kind === 'rate') {
    const raw = await cached(`ltr:${m.r.fred}:${years}`, 6 * 3600e3, () => fredSeries(m.r.fred, years * 366 + 30));
    const p = monthly(raw);
    const months = Object.keys(p).sort();
    const paper = months.map((k) => p[k]);
    return { id, label: m.r.label, unit: '%', dp: m.r.dp, kind: 'rate', years, months, series: { paper, physical: months.map(() => null) }, summary: { paper: summ(paper), physical: null } };
  }

  const b = m.b;
  const paperMap = b.paper ? (await cached(`ltp:${b.paper}:${years}`, 6 * 3600e3, () => yahooSeries(b.paper, `${years}y`, interval))).series : {};
  const physRaw = await cached(`ltf:${b.physical}:${years}`, 6 * 3600e3, () => spotSeries(b, years * 366 + 30));
  const p = monthly(paperMap), f = monthly(physRaw);
  const months = [...new Set([...Object.keys(p), ...Object.keys(f)])].sort();
  const at = (o, mm) => (o[mm] != null ? o[mm] : null);
  const paper = months.map((mm) => at(p, mm));
  const physical = months.map((mm) => at(f, mm));
  if (m.kind === 'basis') {
    const gap = months.map((mm) => (at(f, mm) != null && at(p, mm) != null ? at(f, mm) - at(p, mm) : null));
    return { id, label: `${b.label} gap`, unit: b.unit, dp: b.dp, kind: 'basis', years, months, series: { paper: gap, physical: months.map(() => null) }, summary: { paper: summ(gap), physical: null } };
  }
  return { id, label: b.label, unit: b.unit, dp: b.dp, kind: 'bench', years, months, series: { paper, physical }, summary: { paper: summ(paper), physical: summ(physical) } };
}

// Daily ranges for the chart selector: 1m / 3m / 6m / ytd / 1y.
async function getRange(id, range) {
  const m = resolveMetric(id);
  if (!m) return { error: 'unknown metric' };
  const daysMap = { '1m': 30, '3m': 92, '6m': 183, '1y': 366, ytd: Math.ceil((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 864e5) };
  const days = daysMap[range] || 183;
  const yRange = range === 'ytd' ? 'ytd' : range === '1y' ? '1y' : range === '3m' ? '3mo' : range === '1m' ? '1mo' : '6mo';

  if (m.kind === 'fx') {
    const f = m.f;
    const map = (await cached(`rngq:${f.sym}:${range}`, 3600e3, () => yahooSeries(f.sym, yRange, '1d'))).series;
    const dates = Object.keys(map).sort();
    const paper = dates.map((d) => map[d]);
    return { id, label: f.label, unit: '', dp: f.dp, kind: 'fx', range, dates, series: { paper, physical: dates.map(() => null) }, summary: { paper: rowPct(paper), physical: null } };
  }

  if (m.kind === 'rate') {
    const map = await cached(`rngr:${m.r.fred}:${range}`, 6 * 3600e3, () => fredSeries(m.r.fred, days + 10));
    const dates = Object.keys(map).sort();
    const paper = dates.map((d) => map[d]);
    return { id, label: m.r.label, unit: '%', dp: m.r.dp, kind: 'rate', range, dates, series: { paper, physical: dates.map(() => null) }, summary: { paper: rowPct(paper), physical: null } };
  }

  const b = m.b;
  const paperMap = b.paper ? (await cached(`rngp:${b.paper}:${range}`, 3600e3, () => yahooSeries(b.paper, yRange, '1d'))).series : {};
  const physMap = await cached(`rngf:${b.physical}:${range}`, 3600e3, () => spotSeries(b, days + 5));
  const dates = [...new Set([...Object.keys(paperMap), ...Object.keys(physMap)])].sort();
  const at = (o, d) => (o[d] != null ? o[d] : null);
  const paper = dates.map((d) => at(paperMap, d));
  const physical = dates.map((d) => at(physMap, d));
  if (m.kind === 'basis') {
    const gap = dates.map((d) => (at(physMap, d) != null && at(paperMap, d) != null ? at(physMap, d) - at(paperMap, d) : null));
    return { id, label: `${b.label} gap`, unit: b.unit, dp: b.dp, kind: 'basis', range, dates, series: { paper: gap, physical: dates.map(() => null) }, summary: { paper: rowPct(gap), physical: null } };
  }
  return { id, label: b.label, unit: b.unit, dp: b.dp, kind: 'bench', range, dates, series: { paper, physical }, summary: { paper: rowPct(paper), physical: rowPct(physical) } };
}

// ---------------------------------------------------------------------------
// EIA weekly inventories (free key)
// ---------------------------------------------------------------------------
const INV_SERIES = {
  crude: { id: 'WCESTUS1', label: 'Crude (ex-SPR)' },
  cushing: { id: 'W_EPC0_SAX_YCUOK_MBBL', label: 'Cushing' },
  gasoline: { id: 'WGTSTUS1', label: 'Gasoline' },
  distillate: { id: 'WDISTUS1', label: 'Distillate' },
  spr: { id: 'WCSSTUS1', label: 'SPR' },
};
async function eiaStocks(id, weeks = 320) {
  const key = process.env.EIA_API_KEY;
  if (!key) return [];
  const p = new URLSearchParams();
  p.set('api_key', key); p.set('frequency', 'weekly');
  p.append('data[0]', 'value'); p.append('facets[series][]', id);
  p.set('start', new Date(Date.now() - weeks * 7 * 864e5).toISOString().slice(0, 10));
  p.append('sort[0][column]', 'period'); p.append('sort[0][direction]', 'asc'); p.set('length', '1000');
  const res = await fetch(`https://api.eia.gov/v2/petroleum/stoc/wstk/data/?${p}`, { headers: UA });
  if (!res.ok) throw new Error(`eia stocks ${id} -> ${res.status}`);
  return ((await res.json()).response?.data || []).map((r) => ({ period: r.period, value: parseFloat(r.value) }));
}
async function eiaWeekly(route, id, weeks = 320) {
  const key = process.env.EIA_API_KEY;
  if (!key) return [];
  const p = new URLSearchParams();
  p.set('api_key', key); p.set('frequency', 'weekly');
  p.append('data[0]', 'value'); p.append('facets[series][]', id);
  p.set('start', new Date(Date.now() - weeks * 7 * 864e5).toISOString().slice(0, 10));
  p.append('sort[0][column]', 'period'); p.append('sort[0][direction]', 'asc'); p.set('length', '1000');
  const res = await fetch(`https://api.eia.gov/v2/${route}/data/?${p}`, { headers: UA });
  if (!res.ok) throw new Error(`eia ${id} -> ${res.status}`);
  return ((await res.json()).response?.data || []).map((r) => ({ period: r.period, value: parseFloat(r.value) }));
}
async function getInventories() {
  return cached('inventories', 6 * 3600e3, async () => {
    const results = await Promise.all(Object.entries(INV_SERIES).map(async ([k, s]) => [k, await eiaStocks(s.id)]));
    const items = [];
    for (const [k, arr] of results) {
      if (arr.length < 10) continue;
      const last = arr[arr.length - 1];
      const prev = arr[arr.length - 2];
      const wk4 = arr[arr.length - 5];
      // WoW changes, then a same-week (ISO) 5-year seasonal average → surprise proxy for consensus.
      const wows = [];
      for (let i = 1; i < arr.length; i++) wows.push({ period: arr[i].period, wow: arr[i].value - arr[i - 1].value });
      const targetWk = isoWeek(last.period);
      const sameWeek = wows.filter((w) => isoWeek(w.period) === targetWk && w.period !== last.period);
      const seasonal = sameWeek.length >= 3 ? sameWeek.reduce((a, b) => a + b.wow, 0) / sameWeek.length : null;
      const sMin = sameWeek.length >= 3 ? Math.min(...sameWeek.map((w) => w.wow)) : null;
      const sMax = sameWeek.length >= 3 ? Math.max(...sameWeek.map((w) => w.wow)) : null;
      const wow = prev ? last.value - prev.value : null;
      items.push({
        key: k, label: INV_SERIES[k].label, period: last.period, value: last.value,
        wow, chg4: wk4 ? last.value - wk4.value : null,
        seasonal: seasonal != null ? Math.round(seasonal) : null,
        seasonalMin: sMin != null ? Math.round(sMin) : null,
        seasonalMax: sMax != null ? Math.round(sMax) : null,
        surprise: seasonal != null && wow != null ? Math.round(wow - seasonal) : null,
        years: sameWeek.length,
      });
    }
    let gas = null;
    try {
      const garr = await eiaWeekly('natural-gas/stor/wkly', 'NW2_EPG0_SWO_R48_BCF');
      if (garr.length > 5) {
        const last = garr[garr.length - 1], prev = garr[garr.length - 2];
        const wows = []; for (let i = 1; i < garr.length; i++) wows.push({ period: garr[i].period, wow: garr[i].value - garr[i - 1].value });
        const targetWk = isoWeek(last.period);
        const sameWeek = wows.filter((w) => isoWeek(w.period) === targetWk && w.period !== last.period);
        const seasonal = sameWeek.length >= 3 ? sameWeek.reduce((a, b) => a + b.wow, 0) / sameWeek.length : null;
        const wow = prev ? last.value - prev.value : null;
        gas = { period: last.period, value: last.value, wow, seasonal: seasonal != null ? Math.round(seasonal) : null, surprise: seasonal != null && wow != null ? Math.round(wow - seasonal) : null, seasonalMin: sameWeek.length >= 3 ? Math.round(Math.min(...sameWeek.map((w) => w.wow))) : null, seasonalMax: sameWeek.length >= 3 ? Math.round(Math.max(...sameWeek.map((w) => w.wow))) : null };
      }
    } catch {}
    return { items, gas, fetched: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------------------
// CFTC positioning (WTI managed money / non-commercial net)
// ---------------------------------------------------------------------------
// CFTC Commitments-of-Traders contract names per benchmark (free, no key).
const COT_NAMES = {
  wti: 'CRUDE OIL, LIGHT SWEET-WTI', brent: 'CRUDE OIL, BRENT',
  rbob: 'GASOLINE RBOB', ulsd: 'NY HARBOR ULSD', natgas: 'NATURAL GAS',
  gold: 'GOLD', silver: 'SILVER', copper: 'COPPER', platinum: 'PLATINUM', palladium: 'PALLADIUM',
  corn: 'CORN', wheat: 'WHEAT-SRW', soybean: 'SOYBEANS', soymeal: 'SOYBEAN MEAL', soyoil: 'SOYBEAN OIL',
  sugar: 'SUGAR NO. 11', coffee: 'COFFEE C', cocoa: 'COCOA', cotton: 'COTTON NO. 2',
  palm: 'MALAYSIAN PALM OIL CALENDAR SW',
  milk: 'MILK, Class III', butter: 'BUTTER (CASH SETTLED)', cheese: 'CHEESE (CASH-SETTLED)', nfdm: 'NON FAT DRY MILK', whey: 'DRY WHEY',
};
async function getPositioning(id = 'wti') {
  const name = COT_NAMES[id];
  const b = BENCHMARKS.find((x) => x.id === id);
  if (!name) return { error: 'no CFTC series for ' + id };
  return cached('positioning:' + id, 6 * 3600e3, async () => {
    const where = `contract_market_name='${name}'`;
    const url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$limit=220&$order=report_date_as_yyyy_mm_dd%20DESC&$where=${encodeURIComponent(where)}`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error('cftc ' + res.status);
    const rows = (await res.json()).map((r) => {
      const long = Number(r.noncomm_positions_long_all) || 0;
      const short = Number(r.noncomm_positions_short_all) || 0;
      return { date: (r.report_date_as_yyyy_mm_dd || '').slice(0, 10), net: long - short, long, short, oi: Number(r.open_interest_all) || 0 };
    }).reverse();
    if (!rows.length) return { error: 'no data' };
    const latest = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const nets = rows.map((r) => r.net);
    const pctOf = (arr) => (arr.length ? (arr.filter((n) => n <= latest.net).length / arr.length) * 100 : null);
    const pct3y = pctOf(nets.slice(-156));                  // the last 3 years of weekly reports
    return {
      id, label: `${b?.label || id} spec net (non-comm)`, unit: 'contracts',
      latest, wow: prev ? latest.net - prev.net : null,
      pct: pctOf(nets),                                     // full window (kept for the digest)
      pct3y, weeks: rows.length,
      flag: positioningFlag(pct3y), read: positioningRead(pct3y),
      oi: latest.oi, oiChange: prev ? latest.oi - prev.oi : null,
      history: rows.slice(-156),
    };
  });
}
// Positioning for every COT-covered component of a segment (one call; each series cached server-side).
async function getPositioningSegment(seg) {
  const m = MARKETS.find((x) => x.id === seg);
  if (!m) return { error: 'unknown segment' };
  const ids = m.components.filter((c) => COT_NAMES[c]);
  const items = (await Promise.all(ids.map((c) => getPositioning(c).catch(() => null))))
    .filter((p) => p && !p.error)
    .map((p) => ({ id: p.id, label: (BENCHMARKS.find((x) => x.id === p.id) || {}).label || p.id, ...p }));
  return { segment: seg, label: m.label, primary: m.primary, items };
}

// ---------------------------------------------------------------------------
// Cross-asset "regime" board — one glance at the backdrop that sets the day's tone.
// Everything comes from sources already wired (Yahoo + FRED); the 10y yield shows pp, not %.
// ---------------------------------------------------------------------------
const REGIME_BOARD = [
  { id: 'dxy', label: 'US dollar (DXY)', sym: 'DX-Y.NYB', source: 'Yahoo', unit: '', dp: 2 },
  { id: 'vix', label: 'VIX (volatility)', sym: '^VIX', source: 'Yahoo', unit: '', dp: 2 },
  { id: 'us10y', label: 'US 10y yield', fred: 'DGS10', source: 'FRED', unit: '%', dp: 2, rate: true },
  { id: 'spx', label: 'S&P 500', sym: '^GSPC', source: 'Yahoo', unit: '', dp: 0 },
  { id: 'gold', label: 'Gold', sym: 'GC=F', source: 'Yahoo', unit: '$/oz', dp: 2 },
  { id: 'copper', label: 'Copper', sym: 'HG=F', source: 'Yahoo', unit: '$/lb', dp: 3 },
  { id: 'wti', label: 'WTI crude', sym: 'CL=F', source: 'Yahoo', unit: '$/bbl', dp: 2 },
  { id: 'brent', label: 'Brent crude', sym: 'BZ=F', source: 'Yahoo', unit: '$/bbl', dp: 2 },
];
async function getRegime() {
  return cached('regime', 120e3, async () => {
    const rows = await Promise.all(REGIME_BOARD.map(async (s) => {
      const base = { id: s.id, label: s.label, source: s.source, unit: s.unit, dp: s.dp, rate: !!s.rate };
      try {
        const map = s.fred
          ? await cached('regime:' + s.id, 3600e3, () => fredSeries(s.fred, 40 * 366).catch(() => ({})))
          : (await cached('regime:' + s.id, 120e3, () => yahooSeries(s.sym, '2y', '1d'))).series || {};
        const dates = Object.keys(map).sort();
        const values = dates.map((d) => map[d]);
        const lastIdx = values.reduce((acc, v, i) => (v != null ? i : acc), -1);
        if (lastIdx < 0) return { ...base, price: null, deltas: null, asOf: null };
        return { ...base, price: +(+values[lastIdx]).toFixed(s.dp), asOf: dates[lastIdx], deltas: s.rate ? horizonDeltasAbs(dates, values) : horizonDeltas(dates, values) };
      } catch {
        return { ...base, price: null, deltas: null, asOf: null };
      }
    }));
    return { updated: new Date().toISOString(), rows };
  });
}

// ---------------------------------------------------------------------------
// Currency-adjusted returns (Tier 2). A EUR/JPY investor wants local-currency P&L, not just USD.
// We take each instrument's USD window return and fold in the base currency's own move over the
// same window. 'div' = the pair is USD-per-base (EUR/USD); 'mul' = base-per-USD (USD/JPY).
// ---------------------------------------------------------------------------
const FX_BASE = {
  USD: null,
  EUR: { sym: 'EURUSD=X', mode: 'div' }, GBP: { sym: 'GBPUSD=X', mode: 'div' }, AUD: { sym: 'AUDUSD=X', mode: 'div' },
  JPY: { sym: 'USDJPY=X', mode: 'mul' }, CNY: { sym: 'USDCNY=X', mode: 'mul' }, CAD: { sym: 'USDCAD=X', mode: 'mul' }, CHF: { sym: 'USDCHF=X', mode: 'mul' },
};
async function getFxAdjusted(base = 'USD') {
  const B = String(base || 'USD').toUpperCase();
  if (B !== 'USD' && !FX_BASE[B]) return { error: 'unsupported base', base: B };
  return cached('fxadj:' + B, 3600e3, async () => {
    const [m, h] = await Promise.all([getMarket(), getHistory().catch(() => null)]);
    let fxD = null;
    if (B !== 'USD') {
      try {
        const { series } = await cached('fxadjq:' + B, 3600e3, () => yahooSeries(FX_BASE[B].sym, '2y', '1d'));
        const dates = Object.keys(series).sort();
        fxD = horizonDeltas(dates, dates.map((d) => series[d]));
      } catch {}
    }
    const rows = m.benchmarks.map((b) => {
      const dd = h && h.deltas ? h.deltas[b.id] : null;
      const d = dd ? (b.paper != null ? dd.paper : dd.physical) : null;
      const adj = {};
      for (const k of ['d1', 'w1', 'm1', 'ytd', 'y1']) {
        adj[k] = (B === 'USD' || !fxD) ? (d ? d[k] : null) : fxAdjust(d ? d[k] : null, fxD[k], FX_BASE[B].mode);
      }
      return { id: b.id, label: b.label, deltas: adj };
    });
    return { base: B, updated: new Date().toISOString(), rows };
  });
}

// ---------------------------------------------------------------------------
// Options signals (Tier 2). Free, keyless CBOE **delayed** quotes for the ETF that tracks each
// commodity (USO crude, GLD gold, UNG gas, CORN wheat/corn …). We show OI-based and volume-based
// put/call, the ATM implied vol and a 25-delta skew. Coverage is uneven — no free proxy for some.
// ---------------------------------------------------------------------------
const OPT_PROXY = {
  wti: 'USO', brent: 'USO', rbob: 'UGA', ulsd: 'USO', natgas: 'UNG',
  gold: 'GLD', silver: 'SLV', platinum: 'PPLT', palladium: 'PALL', copper: 'CPER',
  corn: 'CORN', wheat: 'WEAT', soybean: 'SOYB', sugar: 'CANE', coffee: 'JO', cocoa: 'NIB',
};
async function getOptions(id = 'wti') {
  const sym = OPT_PROXY[id];
  if (!sym) return { error: 'no free options proxy for ' + id, id };
  return cached('opt:' + sym, 30 * 60e3, async () => {
    const res = await fetch(`https://cdn-api.cboe.com/api/global/delayed_quotes/options/${sym}.json`, { headers: UA });
    if (!res.ok) throw new Error('cboe ' + res.status);
    const j = await res.json();
    const d = j.data || {};
    const spot = d.current_price ?? null;
    const rows = (d.options || []).map((o) => {
      const p = parseOcc(o.option); if (!p) return null;
      return { ...p, iv: o.iv == null ? null : +o.iv, oi: +o.open_interest || 0, vol: +o.volume || 0, delta: o.delta == null ? null : +o.delta };
    }).filter(Boolean);
    if (!rows.length) return { error: 'no option rows', id };
    const calls = rows.filter((r) => r.type === 'call'), puts = rows.filter((r) => r.type === 'put');
    const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
    const cOi = sum(calls, 'oi'), pOi = sum(puts, 'oi'), cVol = sum(calls, 'vol'), pVol = sum(puts, 'vol');
    const expiries = [...new Set(rows.map((r) => r.expiry))].sort();
    const target = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const exp = expiries.find((e) => e >= target) || expiries[expiries.length - 1] || null;
    const inExp = rows.filter((r) => r.expiry === exp);
    const near = (spot != null && inExp.length) ? inExp.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0] : null;
    const atmStrike = near ? near.strike : null;
    const atmRows = inExp.filter((r) => r.strike === atmStrike && r.iv != null);
    const atmIv = atmRows.length ? +((atmRows.reduce((s, r) => s + r.iv, 0) / atmRows.length) * 100).toFixed(1) : null;
    const p25 = inExp.filter((r) => r.type === 'put' && r.delta != null && r.delta <= -0.08).sort((a, b) => Math.abs(a.delta + 0.25) - Math.abs(b.delta + 0.25))[0];
    const c25 = inExp.filter((r) => r.type === 'call' && r.delta != null && r.delta >= 0.08).sort((a, b) => Math.abs(a.delta - 0.25) - Math.abs(b.delta - 0.25))[0];
    const skew = (p25 && c25 && p25.iv != null && c25.iv != null) ? +(((p25.iv - c25.iv) * 100).toFixed(1)) : null;
    return {
      id, proxy: sym, asOf: String(j.timestamp || '').slice(0, 10), spot,
      expiry: exp, atmStrike, atmIv, skew,
      pcOi: cOi ? +(pOi / cOi).toFixed(2) : null,
      pcVol: cVol ? +(pVol / cVol).toFixed(2) : null,
      totalOi: cOi + pOi, totalVol: cVol + pVol, expiries: expiries.slice(0, 6),
    };
  });
}

// ---------------------------------------------------------------------------
// Risk & cross-asset correlation (Tier 2). Max drawdown + a realised-vol term structure per
// instrument, and a correlation matrix over ~1y of aligned daily log-returns.
// ---------------------------------------------------------------------------
const RISK_SERIES = [
  { key: 'wti', label: 'WTI crude', short: 'WTI', sym: 'CL=F' },
  { key: 'gold', label: 'Gold', short: 'Gold', sym: 'GC=F' },
  { key: 'copper', label: 'Copper', short: 'Copper', sym: 'HG=F' },
  { key: 'spx', label: 'S&P 500', short: 'S&P', sym: '^GSPC' },
  { key: 'dxy', label: 'Dollar (DXY)', short: 'Dollar', sym: 'DX-Y.NYB' },
  { key: 'us10y', label: 'US 10y', short: 'US 10y', fred: 'DGS10', rate: true },
  { key: 'vix', label: 'VIX', short: 'VIX', sym: '^VIX' },
];
async function getRisk() {
  return cached('risk', 3600e3, async () => {
    const maps = {};
    await Promise.all(RISK_SERIES.map(async (s) => {
      try {
        maps[s.key] = s.fred
          ? await cached('risk:' + s.key, 6 * 3600e3, () => fredSeries(s.fred, 400).catch(() => ({})))
          : ((await cached('risk:' + s.key, 3600e3, () => yahooSeries(s.sym, '1y', '1d'))).series) || {};
      } catch { maps[s.key] = {}; }
    }));
    const metrics = RISK_SERIES.map((s) => {
      const dates = Object.keys(maps[s.key]).sort();
      const vals = dates.map((d) => maps[s.key][d]);
      const dd = maxDrawdown(vals), vol = realizedVolTerm(vals);
      return { key: s.key, label: s.label, short: s.short, rate: !!s.rate, drawdown: dd, ddWord: drawdownWord(dd), vol, volWord: volWord(vol.w30), volTrend: volTrend(vol) };
    });
    const dates = [...new Set(RISK_SERIES.flatMap((s) => Object.keys(maps[s.key])))].sort();
    const keys = RISK_SERIES.map((s) => ({ key: s.key, label: s.label, short: s.short }));
    const matrix = corrMatrix(maps, dates);
    const pairs = topPairs(matrix, keys, 3);
    const div = bestDiversifier(matrix, keys);
    return { updated: new Date().toISOString(), metrics, keys, matrix, days: dates.length, pairs, div, read: riskRead(metrics, pairs, div) };
  });
}

// ---------------------------------------------------------------------------
// Screener — one row per instrument, ranked by "where do I look today?". Assembles the deltas,
// the two scores, the basis percentile, vol and (where CFTC covers it) positioning. Server-side
// so the logic is testable; the client only sorts + renders.
// ---------------------------------------------------------------------------
async function getScreen() {
  return cached('screen', 5 * 60e3, async () => {
    const [m, h, a, reads] = await Promise.all([
      getMarket(),
      getHistory().catch(() => null),
      getAnalytics().catch(() => null),
      Promise.all(MARKETS.map((mk) => getMarketRead(mk.id, null).catch(() => null))),
    ]);
    const readBySeg = {};
    MARKETS.forEach((mk, i) => { readBySeg[mk.id] = reads[i]; });
    const segByBench = {};
    for (const mk of MARKETS) for (const c of mk.components) segByBench[c] = mk.id;
    const segLabel = Object.fromEntries(MARKETS.map((mk) => [mk.id, mk.label]));
    const rows = await Promise.all(m.benchmarks.map(async (b) => {
      const dd = h && h.deltas ? h.deltas[b.id] : null;
      const d = dd ? (b.paper != null ? dd.paper : dd.physical) : null;
      const an = (a && a.benchmarks && a.benchmarks[b.id]) || {};
      const seg = segByBench[b.id] || null;
      const rd = readBySeg[seg] || {};
      const vd = rd.verdict || {};
      const pos = COT_NAMES[b.id] ? await getPositioning(b.id).catch(() => null) : null;
      return {
        id: b.id, label: b.label, group: b.group, seg, segLabel: segLabel[seg] || null, unit: b.unit, dp: b.dp,
        price: b.paper != null ? b.paper : b.physical,
        source: b.paperSource || b.physicalSource || null,
        asOf: b.paperDate || b.physicalDate || null,
        deltas: d,
        stretch: vd.priceStretch ? vd.priceStretch.score : null,
        tight: vd.supplyDemand ? vd.supplyDemand.score : null,
        basisPct: an.basisPct != null ? Math.round(an.basisPct) : null,
        vol30: an.vol30 != null ? +an.vol30.toFixed(1) : null,
        posPct: pos && pos.pct3y != null ? Math.round(pos.pct3y) : null,
        posFlag: pos && pos.flag ? pos.flag.label : null,
      };
    }));
    return { updated: new Date().toISOString(), segments: MARKETS.map((mk) => ({ id: mk.id, label: mk.label })), rows };
  });
}

// ---------------------------------------------------------------------------
// Sector watchlist (Yahoo quotes)
// ---------------------------------------------------------------------------
const SECTORS = [
  { name: 'Integrated majors', why: 'broad crude beta', tickers: ['XOM', 'CVX', 'SHEL', 'BP', 'TTE'] },
  { name: 'E&P (upstream)', why: 'levered to crude & backwardation', tickers: ['COP', 'EOG', 'OXY', 'FANG', 'DVN'] },
  { name: 'Refiners', why: 'driven by crack spreads', tickers: ['VLO', 'PSX', 'MPC', 'DINO'] },
  { name: 'Tankers / shipping', why: 'freight & floating storage', tickers: ['FRO', 'DHT', 'INSW', 'STNG', 'TNK'] },
  { name: 'Oil services', why: 'upstream capex cycle', tickers: ['SLB', 'HAL', 'BKR'] },
  { name: 'Airlines', why: 'jet fuel is a cost', tickers: ['DAL', 'UAL', 'AAL', 'LUV'] },
  { name: 'Macro / proxies', why: 'context', tickers: ['DX-Y.NYB', 'XLE', 'CL=F', 'BZ=F'] },
];
async function quote(sym) {
  try {
    const { price, series } = await cached('q:' + sym, 60_000, () => yahooSeries(sym, '5d', '1d'));
    const dates = Object.keys(series).sort();
    const last = dates.length ? series[dates[dates.length - 1]] : price;
    const prev = dates.length > 1 ? series[dates[dates.length - 2]] : price;
    return { symbol: sym, price: last ?? price ?? null, chg: last != null && prev != null ? last - prev : null, pct: last != null && prev ? ((last - prev) / prev) * 100 : null };
  } catch { return { symbol: sym, price: null, chg: null, pct: null }; }
}
async function getEquities() {
  return cached('equities', 60_000, async () => ({
    groups: await Promise.all(SECTORS.map(async (s) => ({ ...s, quotes: await Promise.all(s.tickers.map(quote)) }))),
  }));
}

const CURVE_MONTHS = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
async function getCurveHistory(root) {
  return cached('curvehist:' + root, 6 * 3600e3, async () => {
    const now = new Date();
    const list = [];
    for (let k = -12; k <= 4; k++) {                  // 16 contract months (was 25) — the biggest cost in a cold page
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      list.push({ mk, symbol: `${root}${CURVE_MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}.NYM` });
    }
    const series = {};
    // Fetch the contract months through a small worker pool — the sequential loop + sleep(120) took
    // ~28s cold (getContinuous already uses this pattern; it fetches more months in half the time).
    let qi = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (qi < list.length) {
        const c = list[qi++];
        try { series[c.mk] = await contractSeries(c.symbol); } catch { series[c.mk] = {}; }
      }
    }));
    const months = Object.keys(series).filter((m) => Object.keys(series[m]).length).sort();
    const allDates = [...new Set(months.flatMap((m) => Object.keys(series[m])))].sort().slice(-500);
    const dates = [], m1m2 = [];
    for (const d of allDates) {
      const dk = d.slice(0, 7);
      const future = months.filter((m) => m > dk && series[m][d] != null);
      if (future.length < 2) continue;
      dates.push(d);
      m1m2.push(+(series[future[0]][d] - series[future[1]][d]).toFixed(3));
    }
    return { root, dates, m1m2 };
  });
}

// Back-adjusted continuous front-month series (removes roll jumps).
async function getContinuous(root) {
  return cached('cont:' + root, 6 * 3600e3, async () => {
    const now = new Date();
    const list = [];
    for (let k = -24; k <= 2; k++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      list.push({ mk, symbol: `${root}${CURVE_MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}.NYM` });
    }
    const series = {};
    // Fetch the contract months through a small worker pool — sequential + sleep(200) was ~30s.
    let qi = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (qi < list.length) {
        const c = list[qi++];
        try { series[c.mk] = await contractSeries(c.symbol); } catch { series[c.mk] = {}; }
      }
    }));
    const months = Object.keys(series).filter((m) => Object.keys(series[m]).length).sort();
    const allDates = [...new Set(months.flatMap((m) => Object.keys(series[m])))].sort();
    const dates = [], raw = [], fronts = [];
    for (const d of allDates) {
      const dk = d.slice(0, 7);
      const future = months.filter((m) => m > dk && series[m][d] != null);
      if (!future.length) continue;
      dates.push(d); fronts.push(future[0]); raw.push(series[future[0]][d]);
    }
    const gaps = new Map();
    for (let i = 1; i < raw.length; i++) {
      if (fronts[i] !== fronts[i - 1]) {
        const a = series[fronts[i - 1]][dates[i]];
        const b = series[fronts[i]][dates[i]];
        if (a != null && b != null) gaps.set(i, b - a); // new − old
      }
    }
    const adj = backAdjust(raw, gaps);
    const out = {};
    dates.forEach((d, i) => { out[d] = adj[i]; });
    return { series: out };
  });
}

// ---------------------------------------------------------------------------
// Macro context (oil doesn't move alone)
// ---------------------------------------------------------------------------
const MACRO = [
  { id: 'dxy', label: 'US dollar', sym: 'DX-Y.NYB' },
  { id: 'tnx', label: '10-yr rate', sym: '^TNX' },
  { id: 'vix', label: 'VIX (fear)', sym: '^VIX' },
  { id: 'spx', label: 'S&P 500', sym: '^GSPC' },
  { id: 'gold', label: 'Gold', sym: 'GC=F' },
  { id: 'copper', label: 'Copper', sym: 'HG=F' },
];
async function getMacro() {
  return cached('macro', 120e3, async () => ({
    items: await Promise.all(MACRO.map(async (m) => {
      try {
        const { price, series } = await cached('q:' + m.sym, 120e3, () => yahooSeries(m.sym, '5d', '1d'));
        const dates = Object.keys(series).sort();
        const last = dates.length ? series[dates[dates.length - 1]] : price;
        const prev = dates.length > 1 ? series[dates[dates.length - 2]] : price;
        return { id: m.id, label: m.label, price: last ?? price ?? null, pct: last != null && prev ? ((last - prev) / prev) * 100 : null };
      } catch { return { id: m.id, label: m.label, price: null, pct: null }; }
    })),
  }));
}

// 5-year seasonal range by day-of-year (for the price chart band).
async function getSeasonal(b, years = 5) {
  return cached('season:' + b.id + ':' + years, 12 * 3600e3, async () => {
    const map = b.paper ? (await cached('season-src:' + b.paper, 12 * 3600e3, () => yahooSeries(b.paper, years + 'y', '1d'))).series : await spotSeries(b, years * 366);
    if (!map || !Object.keys(map).length) return { error: 'no data' };
    const byMD = {};
    for (const d of Object.keys(map)) { const md = d.slice(5); (byMD[md] ||= []).push(map[d]); }
    const mds = Object.keys(byMD).sort();
    const low = {}, high = {}, median = {};
    for (let i = 0; i < mds.length; i++) {
      const win = mds.slice(Math.max(0, i - 3), i + 4).flatMap((k) => byMD[k]).sort((a, c) => a - c);
      const md = mds[i];
      low[md] = win[0]; high[md] = win[win.length - 1]; median[md] = win[Math.floor(win.length / 2)];
    }
    // Grade for today: where the latest price sits in this day-of-year's 5-yr band,
    // plus the normal seasonal move over the next month.
    const dates = Object.keys(map).sort();
    const asOf = dates[dates.length - 1] || null;
    const price = asOf ? map[asOf] : null;
    const md = new Date().toISOString().slice(5, 10);
    const toMd = new Date(Date.now() + 30 * 864e5).toISOString().slice(5, 10);
    return { low, high, median, asOf, grade: seasonalGrade(low, high, median, price, md), ahead: seasonalAhead(median, md, toMd) };
  });
}

// ---------------------------------------------------------------------------
// Macro dashboard (rates, inflation, growth, FX) — the start of the expansion
// ---------------------------------------------------------------------------
const FX_SYMS = [
  { id: 'dxy', label: 'US dollar (DXY)', sym: 'DX-Y.NYB', dp: 2 },
  { id: 'eurusd', label: 'EUR / USD', sym: 'EURUSD=X', dp: 4 },
  { id: 'usdjpy', label: 'USD / JPY', sym: 'USDJPY=X', dp: 2 },
  { id: 'gbpusd', label: 'GBP / USD', sym: 'GBPUSD=X', dp: 4 },
  { id: 'usdcny', label: 'USD / CNY', sym: 'USDCNY=X', dp: 4 },
  { id: 'audusd', label: 'AUD / USD · mining', sym: 'AUDUSD=X', dp: 4 },
  { id: 'usdcad', label: 'USD / CAD · oil', sym: 'USDCAD=X', dp: 4 },
  { id: 'usdnok', label: 'USD / NOK · oil', sym: 'USDNOK=X', dp: 3 },
  { id: 'usdbrl', label: 'USD / BRL · agri', sym: 'USDBRL=X', dp: 3 },
  { id: 'usdzar', label: 'USD / ZAR · gold', sym: 'USDZAR=X', dp: 3 },
  { id: 'usdmxn', label: 'USD / MXN · oil', sym: 'USDMXN=X', dp: 3 },
  { id: 'usdinr', label: 'USD / INR', sym: 'USDINR=X', dp: 2 },
  { id: 'usdchf', label: 'USD / CHF', sym: 'USDCHF=X', dp: 4 },
  { id: 'nzdusd', label: 'NZD / USD', sym: 'NZDUSD=X', dp: 4 },
];
// Chartable rates (FRED, free, no key) — so you can overlay, e.g., gold vs the real yield.
const RATES = [
  { id: 'real10y', label: 'US 10-yr real yield', fred: 'DFII10', dp: 2 },
  { id: 'nom10y', label: 'US 10-yr yield', fred: 'DGS10', dp: 2 },
  { id: 'nom2y', label: 'US 2-yr yield', fred: 'DGS2', dp: 2 },
];

// Commodity ↔ currency links: does the currency still track its commodity?
// `expect` is the sign of the *normal* relationship for the QUOTED pair, e.g.
// USD/CAD up = loonie weaker = oil down → -1. We compute the 3-month daily-return
// correlation and let the UI judge whether the link is holding.
const FX_LINKS = [
  { id: 'aud', pair: 'AUD / USD · mining', sym: 'AUDUSD=X', commodity: 'Copper',    csym: 'HG=F', expect: 1 },
  { id: 'cad', pair: 'USD / CAD · oil',    sym: 'USDCAD=X', commodity: 'WTI crude', csym: 'CL=F', expect: -1 },
  { id: 'nok', pair: 'USD / NOK · oil',    sym: 'USDNOK=X', commodity: 'Brent crude', csym: 'BZ=F', expect: -1 },
  { id: 'brl', pair: 'USD / BRL · agri',   sym: 'USDBRL=X', commodity: 'Soybeans',  csym: 'ZS=F', expect: -1 },
  { id: 'zar', pair: 'USD / ZAR · gold',   sym: 'USDZAR=X', commodity: 'Gold',      csym: 'GC=F', expect: -1 },
  { id: 'mxn', pair: 'USD / MXN · oil',    sym: 'USDMXN=X', commodity: 'WTI crude', csym: 'CL=F', expect: -1 },
];

// Cached Yahoo daily series, keyed by range so different windows never collide.
const yc = (sym, range = '3mo') => cached(`yq:${range}:${sym}`, 3600e3, () => yahooSeries(sym, range, '1d'));

// 3-month daily-return correlation of two symbols (null on any fetch failure).
async function pairCorr(symA, symB, range = '3mo') {
  const [a, b] = await Promise.all([yc(symA, range), yc(symB, range)]);
  const dates = Object.keys(a.series).sort();
  return pearson(logReturns(a.series, dates), logReturns(b.series, dates));
}

// Trend of a ratio (A ÷ B) over the window — e.g. copper ÷ gold as a growth proxy.
async function ratioTrend(symA, symB, range = '6mo', back = 63) {
  const [a, b] = await Promise.all([yc(symA, range), yc(symB, range)]);
  const pts = [];
  for (const d of Object.keys(a.series).sort()) if (a.series[d] != null && b.series[d] != null) pts.push(a.series[d] / b.series[d]);
  if (pts.length < 2) return { ratio: null, chg: null };
  const ratio = pts[pts.length - 1];
  const base = pts[Math.max(0, pts.length - 1 - back)];
  return { ratio, chg: base ? ((ratio - base) / base) * 100 : null };
}

async function getMacroDash() {
  return cached('macrodash', 3 * 3600e3, async () => {
    const [dgs2, dgs10, ff, cpi, gdp, unrate, ecb, hicp] = await Promise.all([
      fredSeries('DGS2', 40), fredSeries('DGS10', 40), fredSeries('FEDFUNDS', 400),
      fredSeries('CPIAUCSL', 800), fredSeries('A191RL1Q225SBEA', 1400), fredSeries('UNRATE', 400), fredSeries('ECBDFR', 400),
      fredSeries('CP0000EZ19M086NEST', 800),
    ]);
    const last = (o) => { const d = Object.keys(o).sort(); return d.length ? { date: d[d.length - 1], value: o[d[d.length - 1]] } : null; };
    const cpiDates = Object.keys(cpi).sort();
    const cpiLast = cpiDates.length ? cpi[cpiDates[cpiDates.length - 1]] : null;
    const cpiPrevYr = cpiDates.length > 12 ? cpi[cpiDates[cpiDates.length - 13]] : null;
    const r2 = last(dgs2), r10 = last(dgs10), ffr = last(ff), g = last(gdp), u = last(unrate), ecbLast = last(ecb);
    const fx = await Promise.all(FX_SYMS.map(async (m) => {
      try {
        const { price, series } = await cached('q:' + m.sym, 120e3, () => yahooSeries(m.sym, '5d', '1d'));
        const d = Object.keys(series).sort();
        const a = series[d[d.length - 1]], b = series[d[d.length - 2]];
        return { id: m.id, label: m.label, price: a ?? price ?? null, pct: a != null && b ? ((a - b) / b) * 100 : null };
      } catch { return { id: m.id, label: m.label, price: null, pct: null }; }
    }));
    // Do commodity currencies still track their commodity? (3-month daily returns)
    const links = await Promise.all(FX_LINKS.map(async (l) => {
      let corr = null;
      try { corr = await pairCorr(l.sym, l.csym); } catch {}
      return { id: l.id, pair: l.pair, commodity: l.commodity, expect: l.expect, corr };
    }));
    // Copper ÷ gold — a classic free proxy for global growth appetite (up = risk-on).
    let growthProxy = { ratio: null, chg: null };
    try { growthProxy = await ratioTrend('HG=F', 'GC=F'); } catch {}
    // Euro-area HICP YoY (current on FRED; ~2-month lag).
    const hicpDates = Object.keys(hicp).sort();
    const hicpLast = hicpDates.length ? hicp[hicpDates[hicpDates.length - 1]] : null;
    const hicpPrev = hicpDates.length > 12 ? hicp[hicpDates[hicpDates.length - 13]] : null;
    const euroCpi = hicpLast != null && hicpPrev != null ? +(((hicpLast / hicpPrev) - 1) * 100).toFixed(1) : null;
    const usCpi = cpiLast != null && cpiPrevYr != null ? +(((cpiLast / cpiPrevYr) - 1) * 100).toFixed(1) : null;
    const spread2s10s = r10 && r2 ? +(r10.value - r2.value).toFixed(2) : null;
    // Only fields we can source ACCURATELY are filled; everything else stays null and is labelled.
    const regions = {
      us: { label: 'Americas', fields: [
        { k: 'Fed funds (policy)', v: ffr?.value ?? null, suf: '%', asOf: ffr?.date },
        { k: 'US CPI YoY', v: usCpi ?? null, suf: '%', asOf: cpiDates[cpiDates.length - 1] },
        { k: 'US GDP QoQ (annualised)', v: g?.value ?? null, suf: '%', asOf: g?.date },
        { k: 'Unemployment', v: u?.value ?? null, suf: '%', asOf: u?.date },
        { k: '2-year yield', v: r2?.value ?? null, suf: '%', asOf: r2?.date },
        { k: '10-year yield', v: r10?.value ?? null, suf: '%', asOf: r10?.date },
      ], note: '' },
      eu: { label: 'Europe', fields: [
        { k: 'ECB deposit rate', v: ecbLast?.value ?? null, suf: '%', asOf: ecbLast?.date },
        { k: 'Euro-area HICP YoY', v: euroCpi, suf: '%', asOf: hicpDates[hicpDates.length - 1] },
      ], note: 'Euro-area inflation & the ECB rate are current; euro unemployment on the free feed is years out of date, so it is not shown.' },
      jp: { label: 'Japan', fields: [
        { k: 'BoJ policy rate', v: null, suf: '%', asOf: null },
        { k: 'Japan CPI YoY', v: null, suf: '%', asOf: null },
      ], note: 'No current free source for Japan macro — the newest free CPI is from 2021, so we show headlines and the yen rather than stale numbers.' },
      apac: { label: 'Asia-Pacific', fields: [
        { k: 'Policy rate', v: null, suf: '%', asOf: null },
        { k: 'China CPI YoY', v: null, suf: '%', asOf: null },
      ], note: 'Free Asia macro is patchy and stale (China CPI/GDP lag by 1–3 years), so we show headlines and the region’s currencies rather than stale numbers.' },
    };
    return {
      rates: {
        us2y: r2?.value ?? null, us10y: r10?.value ?? null,
        spread: spread2s10s,
        fedfunds: ffr?.value ?? null, ecb: ecbLast?.value ?? null,
        rateGap: ffr?.value != null && ecbLast?.value != null ? +(ffr.value - ecbLast.value).toFixed(2) : null,
        asOf: r10?.date ?? null,
      },
      inflation: { cpiYoY: usCpi, asOf: cpiDates[cpiDates.length - 1] ?? null },
      growth: { gdpQoQ: g?.value ?? null, unemployment: u?.value ?? null, asOf: g?.date ?? null },
      growthProxy,
      fx,
      links,
      regions,
    };
  });
}

// Correlation of oil with the dollar, VIX and S&P (3-month daily returns).
async function getCorrelations() {
  return cached('corr', 3600e3, async () => {
    const syms = { oil: 'CL=F', dollar: 'DX-Y.NYB', vix: '^VIX', sp500: '^GSPC' };
    const series = {};
    for (const [k, s] of Object.entries(syms)) { try { series[k] = (await yc(s, '3mo')).series; } catch { series[k] = {}; } }
    const dates = Object.keys(series.oil).sort();
    const rr = {};
    for (const k of Object.keys(syms)) rr[k] = logReturns(series[k], dates);
    return { oilVsDollar: pearson(rr.oil, rr.dollar), oilVsVix: pearson(rr.oil, rr.vix), oilVsSp500: pearson(rr.oil, rr.sp500) };
  });
}

// Upcoming catalysts (recurring).
function getEvents() {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  // Next Wednesday = EIA weekly report (10:30 ET).
  const wed = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  wed.setUTCDate(wed.getUTCDate() + ((3 - wed.getUTCDay() + 7) % 7 || 7));
  // Next contract expiry (approx: ~20th of the current/next month).
  const exp = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + (now.getUTCDate() > 20 ? 1 : 0), 20));
  return [
    { name: 'US oil stockpiles (EIA)', date: iso(wed), note: "the week's biggest catalyst · 10:30am New York" },
    { name: 'WTI/Brent front-month expiry (approx.)', date: iso(exp), note: 'futures roll to the next month' },
    { name: 'OPEC+ monthly meeting', date: null, note: 'date varies — check the OPEC calendar' },
  ];
}
// FOMC meeting dates — parsed from the Federal Reserve's own (keyless) calendar page; the published
// 2026 schedule is the fallback if that page is unreachable. The DECISION is on the meeting's 2nd day.
const FOMC_FALLBACK = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];
async function fomcDates() {
  return cached('fomc', 24 * 3600e3, async () => {
    const html = await (await fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { headers: UA })).text();
    const MON = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
    const out = [];
    const year = new Date().getUTCFullYear();
    for (const y of [year, year + 1]) {
      const a = html.indexOf(`${y} FOMC Meetings`); if (a < 0) continue;
      const tail = html.slice(a + 20);
      const nx = tail.search(/\d{4} FOMC Meetings/);
      const seg = tail.slice(0, nx >= 0 ? nx : 20000).replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\u00a0/g, ' ');
      for (const m of seg.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})/g)) {
        out.push(new Date(Date.UTC(y, MON[m[1]] - 1, Number(m[3]))).toISOString().slice(0, 10));
      }
    }
    // One meeting per month — guards against a section slice catching a neighbouring year's row.
    const byMonth = new Map();
    for (const d of out.sort()) if (!byMonth.has(d.slice(0, 7))) byMonth.set(d.slice(0, 7), d);
    return [...byMonth.values()].sort();
  });
}
// Economic calendar — dated upcoming releases. Recurring ones are computed; FOMC comes from the
// Fed's page; with a free FRED_API_KEY we add FRED's release calendar. A consensus/forecast is
// NEVER invented — we show the date and the source only (see the "no forecast" note in the UI).
async function getCalendar() {
  return cached('calendar', 6 * 3600e3, async () => {
    const now = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const today = iso(now);
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + 150 * 864e5);
    const events = [];
    const push = (d, name, source, note) => { if (d >= start && d <= end) events.push({ date: iso(d), name, source, note }); };
    // EIA weekly oil stocks — every Wednesday.
    const wed = new Date(start); wed.setUTCDate(wed.getUTCDate() + ((3 - wed.getUTCDay() + 7) % 7));
    for (let d = new Date(wed); d <= end; d = new Date(d.getTime() + 7 * 864e5)) push(d, 'US oil stockpiles (EIA)', 'EIA', 'weekly · 10:30am New York');
    // Monthly: futures roll (~20th) and the USDA WASDE crop balance (~12th).
    for (let k = 0; k <= 5; k++) {
      push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 20)), 'WTI/Brent front-month expiry (approx.)', 'CME', 'futures roll to the next month');
      push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 12)), 'USDA WASDE report (approx.)', 'USDA', 'usual mid-month slot');
    }
    events.push({ date: null, name: 'OPEC+ monthly meeting', source: 'OPEC+', note: 'date varies — check the OPEC calendar' });
    // FOMC — the Fed's published dates (live if reachable, else the published fallback).
    let fomc = [];
    try { fomc = await fomcDates(); } catch {}
    const fomcLive = fomc.length > 0;
    if (!fomcLive) fomc = FOMC_FALLBACK;
    for (const d of fomc) if (d >= today) events.push({ date: d, name: 'FOMC rate decision', source: 'Federal Reserve', note: 'policy rate decision · 2:00pm New York' });
    // FRED release calendar (optional free key) — adds CPI, payrolls, GDP, PCE, retail sales…
    if (process.env.FRED_API_KEY) {
      try {
        const end = iso(new Date(Date.now() + 75 * 864e5));
        const url = `https://api.stlouisfed.org/fred/releases/dates?api_key=${process.env.FRED_API_KEY}&file_type=json&realtime_start=${today}&realtime_end=${end}&include_release_dates_with_no_data=true&limit=1000`;
        const j = await (await fetch(url, { headers: UA })).json();
        const want = /(consumer price index|employment situation|gross domestic product|personal income|producer price index|retail sales|industrial production|advance report)/i;
        for (const r of (j.release_dates || [])) if (want.test(r.release_name || '')) events.push({ date: r.date, name: r.release_name, source: 'FRED', note: 'scheduled release' });
      } catch {}
    }
    const upcoming = events.filter((e) => !e.date || e.date >= today)
      .sort((x, y) => (x.date || '9999-99-99').localeCompare(y.date || '9999-99-99')).slice(0, 120);
    return { updated: new Date().toISOString(), events: upcoming, fomc: fomcLive ? 'live' : 'fallback', fredKey: Boolean(process.env.FRED_API_KEY) };
  });
}

// ---------------------------------------------------------------------------
// Chokepoint tanker counts (live, from AIS)
// ---------------------------------------------------------------------------
const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', box: [[24, 54], [28, 58]] },
  { name: 'Strait of Malacca', box: [[1, 98], [6, 104]] },
  { name: 'Suez / Red Sea', box: [[12, 32], [30, 44]] },
  { name: 'Panama Canal', box: [[7, -82], [10, -78]] },
  { name: 'Danish Straits', box: [[54, 10], [58, 13]] },
  { name: 'Turkish Straits', box: [[40, 27], [42, 30]] },
];
const regionHits = {};
function recordHit(lat, lon) {
  if (lat == null || lon == null) return;
  const now = Date.now();
  for (const r of REGIONS) if (inBox(lat, lon, r.box)) (regionHits[r.name] ||= []).push(now);
}
function regionRates() {
  const now = Date.now(), win = 5 * 60_000;
  return REGIONS.map((r) => {
    const arr = (regionHits[r.name] || []).filter((t) => now - t < win);
    regionHits[r.name] = arr;
    return { name: r.name, perMin: +(arr.length / 5).toFixed(1) };
  });
}

// Reroute Index: accumulate Cape-vs-Suez activity over time (rerouting builds up).
const REROUTE_FILE = path.join(__dirname, '.reroute.json');
let rerouteSeries = [];
try { rerouteSeries = JSON.parse(fs.readFileSync(REROUTE_FILE, 'utf8')); } catch {}
function snapshotReroute() {
  const rates = regionRates();
  const get = (n) => rates.find((r) => r.name === n)?.perMin ?? 0;
  rerouteSeries.push({ t: Date.now(), cape: get('Cape of Good Hope'), suez: get('Red Sea / Suez'), malacca: get('Malacca / Singapore'), hormuz: get('Strait of Hormuz') });
  if (rerouteSeries.length > 500) rerouteSeries = rerouteSeries.slice(-500);
  try { fs.writeFileSync(REROUTE_FILE, JSON.stringify(rerouteSeries)); } catch {}
}

// AIS anomaly detection — vessels that "teleport" (spoofing) or vanish for hours (dark transit).
const ME_BOX = [[-5, 32], [30, 72]];
const prevPos = new Map();
const aisAnom = { spoof: 0, darkGap: 0 };
const inME = (lat, lon) => lat != null && lon != null && inBox(lat, lon, ME_BOX);
function recordAisAnomaly(meta) {
  const { MMSI: mmsi, latitude: lat, longitude: lon } = meta;
  if (lat == null || lon == null) return;
  const t = Date.now();
  const prev = prevPos.get(mmsi);
  if (prev && (inME(lat, lon) || inME(prev.lat, prev.lon))) {
    const dtH = (t - prev.t) / 3.6e6;
    const dnm = haversineNm(prev.lat, prev.lon, lat, lon);
    const kn = dtH > 0 ? dnm / dtH : 1e9;
    if (dtH < 24 && dnm > 20 && kn > 60) aisAnom.spoof++;      // faster than any ship → spoof/teleport
    else if (dtH > 0.5 && dnm > 50) aisAnom.darkGap++;         // disappeared for hours while crossing → dark transit
  }
  prevPos.set(mmsi, { lat, lon, t });
  if (prevPos.size > 20000) prevPos.delete(prevPos.keys().next().value);
}
function getChokepoints() {
  const list = [...tankers.values()];
  return { chokepoints: CHOKEPOINTS.map((c) => ({ name: c.name, count: list.filter((v) => v.lat != null && inBox(v.lat, v.lon, c.box)).length })) };
}

// ---------------------------------------------------------------------------
// Analytics: percentile context + realised volatility + freight arb
// ---------------------------------------------------------------------------
const FREIGHT_DEFAULT = 2.0; // $/bbl USGC -> NW Europe estimate
async function getAnalytics(freight = FREIGHT_DEFAULT) {
  return cached('analytics:' + freight, 6 * 3600e3, async () => {
    const twoYear = {};
    // Independent per-benchmark fetches — run them together rather than back-to-back.
    await Promise.all(BENCHMARKS.filter((x) => x.physical).map(async (b) => {
      const paperMap = (await cached(`a2p:${b.paper || b.id}`, 6 * 3600e3, () => (b.paper ? yahooSeries(b.paper, '2y', '1d') : Promise.resolve({ series: {} })))).series;
      const physMap = await cached(`a2f:${b.physical}`, 6 * 3600e3, () => spotSeries(b, 740));
      twoYear[b.id] = { paperMap, physMap };
    }));
    const benchmarks = {};
    for (const b of BENCHMARKS.filter((x) => x.physical)) {
      const { paperMap, physMap } = twoYear[b.id];
      const dates = [...new Set([...Object.keys(paperMap), ...Object.keys(physMap)])].sort();
      const basisArr = dates.map((d) => (paperMap[d] != null && physMap[d] != null ? physMap[d] - paperMap[d] : null));
      const current = [...basisArr].reverse().find((x) => x != null);
      benchmarks[b.id] = {
        basisPct: current != null ? percentile(basisArr, current) : null,
        vol30: realizedVol(dates.map((d) => (paperMap[d] != null ? paperMap[d] : null)), 30),
      };
    }
    const bm = (id) => twoYear[id]?.physMap || {};
    const spreadArr = (() => {
      const brent = bm('brent'), wti = bm('wti');
      const dates = [...new Set([...Object.keys(brent), ...Object.keys(wti)])].sort();
      return dates.map((d) => (brent[d] != null && wti[d] != null ? brent[d] - wti[d] : null));
    })();
    const currentSpread = [...spreadArr].reverse().find((x) => x != null);
    return {
      benchmarks,
      spread: { brentWtiPhysical: currentSpread, pct: currentSpread != null ? percentile(spreadArr, currentSpread) : null },
      arb: currentSpread != null ? { spread: currentSpread, freight, net: currentSpread - freight, open: currentSpread - freight > 0 } : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Term structure (futures curve from Yahoo contract-month symbols)
// ---------------------------------------------------------------------------
const MONTH_CODE = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
// Which commodities Yahoo serves as individual contract months, and the exchange
// suffix each root uses. (Palm oil has no free contract months — only the front.)
const CURVE_SPEC = {
  wti: { root: 'CL', exch: 'NYM' }, brent: { root: 'BZ', exch: 'NYM' },
  rbob: { root: 'RB', exch: 'NYM' }, ulsd: { root: 'HO', exch: 'NYM' }, natgas: { root: 'NG', exch: 'NYM' },
  gold: { root: 'GC', exch: 'CMX' }, silver: { root: 'SI', exch: 'CMX' }, copper: { root: 'HG', exch: 'CMX' },
  aluminium: { root: 'ALI', exch: 'CMX' },
  platinum: { root: 'PL', exch: 'CMX' }, palladium: { root: 'PA', exch: 'CMX' },
  corn: { root: 'ZC', exch: 'CBT' }, wheat: { root: 'ZW', exch: 'CBT' }, soybean: { root: 'ZS', exch: 'CBT' },
  soymeal: { root: 'ZM', exch: 'CBT' }, soyoil: { root: 'ZL', exch: 'CBT' },
  coffee: { root: 'KC', exch: 'NYB' }, sugar: { root: 'SB', exch: 'NYB' }, cocoa: { root: 'CC', exch: 'NYB' }, cotton: { root: 'CT', exch: 'NYB' },
  // CME dairy complex (all quoted as individual contract months on Yahoo)
  milk: { root: 'DC', exch: 'CME' }, butter: { root: 'CB', exch: 'CME' }, nfdm: { root: 'GNF', exch: 'CME' }, cheese: { root: 'CSC', exch: 'CME' }, whey: { root: 'DY', exch: 'CME' },
  // CME livestock
  cattle: { root: 'LE', exch: 'CME' }, hogs: { root: 'HE', exch: 'CME' }, feeder: { root: 'GF', exch: 'CME' },
};
async function curveFor(id) {
  const spec = CURVE_SPEC[id];
  if (!spec) return [];
  const now = new Date();
  // Front 6 contract months, fetched IN PARALLEL (was 14 sequential — the single biggest cost in
  // a cold /api/marketread). m1m12 was never used by the UI, so 6 is enough for m1m6 + calendar.
  const syms = Array.from({ length: 6 }, (_, k) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    return `${spec.root}${MONTH_CODE[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}.${spec.exch}`;
  });
  const quotes = await Promise.all(syms.map(async (symbol) => {
    try {
      const q = await cached('curveq:' + symbol, 900_000, () => yahooSeries(symbol, '5d', '1d'));
      return q.price != null ? { label: symbol.slice(spec.root.length, spec.root.length + 3), price: q.price } : null;
    } catch { return null; }
  }));
  return quotes.filter(Boolean);
}
function buildCurve(c) {
  if (c.length < 2) return { contracts: c, available: false };
  // Adjacent calendar spreads (this month − next, next − the one after, …).
  const calendar = [];
  for (let i = 0; i + 1 < c.length && i < 6; i++) {
    calendar.push({ from: c[i].label, to: c[i + 1].label, months: contractMonthsBetween(c[i].label, c[i + 1].label), value: c[i].price - c[i + 1].price });
  }
  return {
    available: true,
    contracts: c,
    m1m2: c[0].price - c[1].price,
    m1m6: c.length > 5 ? c[0].price - c[5].price : null,
    m1m12: c.length > 11 ? c[0].price - c[11].price : null,
    shape: c[0].price >= c[1].price ? 'Backwardation' : 'Contango',
    // Implied roll yield: a long rolled from the front into the next month. Positive
    // in backwardation (sell the dearer front, buy the cheaper next — you get paid).
    rollMonthly: c[0].price - c[1].price,
    rollMonthlyPct: c[0].price ? +(((c[0].price - c[1].price) / c[0].price) * 100).toFixed(2) : null,
    rollYieldAnn: c[1].price ? +(Math.log(c[0].price / c[1].price) * 12 * 100).toFixed(1) : null,
    calendar,
  };
}
// The curve for any one commodity (used by the "prices for months ahead" picker).
async function getCurveFor(id) {
  return cached('ts:' + id, 300_000, async () => {
    const b = BENCHMARKS.find((x) => x.id === id);
    const c = await curveFor(id);
    return { id, label: b?.label || id, unit: b?.unit || '', dp: b?.dp ?? 2, ...buildCurve(c) };
  });
}
async function getCurves() {
  return cached('curves', 120_000, async () => {
    const [wti, brent] = await Promise.all([curveFor('wti'), curveFor('brent')]);
    return { wti: { unit: '$/bbl', dp: 2, ...buildCurve(wti) }, brent: { unit: '$/bbl', dp: 2, ...buildCurve(brent) } };
  });
}

// ---------------------------------------------------------------------------
// Per-market read — the engine behind a commodity-aware Big Picture.
// Assembles price trend, range position, volatility, curve, CFTC positioning and
// macro links for the selected market, then writes a plain-English verdict.
// Data we do NOT have free (basis/inventories for metals & ags) is labelled, never faked.
// ---------------------------------------------------------------------------
const MARKET_CONTENT = {
  crude:      { tightQ: 'IS CRUDE TIGHT?', catalysts: ['OPEC+ monthly meeting', 'EIA weekly US oil stocks (Wed 10:30am New York)', 'refinery run rates & product cracks'], watch: ['Whether the real-vs-futures gap widens (physical tightness)', 'Ships avoiding the Red Sea and going around Africa'],
    sectorsUp: ['Oil & gas producers', 'Oil services & drilling', 'Refiners'], sectorsDown: ['Airlines', 'Trucking & logistics', 'Chemicals & plastics'],
    tickersUp: ['XOM', 'CVX', 'COP', 'SLB', 'XLE', 'OIH', 'PBR', 'SU'], tickersDown: ['DAL', 'UAL', 'AAL', 'FDX', 'JETS', 'LYB'],
    ideas: 'Backwardated, tight crude normally favours producers, oil services and refiners, and squeezes fuel-cost-heavy businesses — airlines, logistics and petrochemicals.' },
  refined:    { tightQ: 'ARE REFINED FUELS TIGHT?', catalysts: ['US summer driving season', 'heating-season demand', 'refinery outages & turnarounds', 'jet-fuel demand as travel recovers'], watch: ['Whether the diesel/gasoline cracks stay unusually wide', 'Refinery utilisation & unplanned outages'],
    sectorsUp: ['Refiners', 'Refined-product tankers'], sectorsDown: ['Airlines', 'Trucking & logistics', 'Consumers at the pump'],
    tickersUp: ['VLO', 'PSX', 'MPC', 'DINO', 'CRAK', '0386.HK'], tickersDown: ['DAL', 'UAL', 'FDX', 'UPS', 'JETS'],
    ideas: 'Wide cracks mean refiners earn more per barrel — good for refiners and product tankers, painful for airlines, truckers and drivers.' },
  gas:        { tightQ: 'IS NATURAL GAS TIGHT?', catalysts: ['weather (heating & cooling demand)', 'EIA gas storage (Thursday)', 'LNG export volumes'], watch: ['Storage vs the 5-year average', 'LNG feedgas demand'],
    sectorsUp: ['Gas producers', 'Gas pipelines & midstream'], sectorsDown: ['Utilities', 'Heavy industry & fertiliser'],
    tickersUp: ['EQT', 'AR', 'CTRA', 'WMB', 'UNG', 'FCG', '0883.HK'], tickersDown: ['XLU', 'CF'],
    ideas: 'Tight gas (low storage) lifts producers and midstream; it raises fuel and feedstock costs for utilities, industry and fertiliser makers.' },
  precious:   { tightQ: 'ARE PRECIOUS METALS STRETCHED?', catalysts: ['the Fed rate path & real yields', 'the US dollar', 'ETF flows & central-bank buying'], watch: ['Real yields — the main gold driver', 'The gold/silver ratio'],
    sectorsUp: ['Gold & silver miners', 'Royalty & streaming'], sectorsDown: ['No direct loser — a store of value, not an input'],
    tickersUp: ['NEM', 'AEM', 'GDX', 'GDXJ', 'WPM', 'GOLD', 'GFI', 'HMY'], tickersDown: ['SIG'],
    ideas: 'Precious metals are a store of value, not an input — a strong run usually means fear or falling real yields. Mainly helps miners; there is no direct corporate loser.' },
  industrial: { tightQ: 'ARE COPPER & ALUMINIUM TIGHT?', catalysts: ['China demand & stimulus', 'mine supply & strikes (Chile, Indonesia)', 'exchange warehouse stocks', 'energy & power costs (smelters)'], watch: ['China property & grid spending', 'LME/COMEX warehouse stocks & smelter curtailments'],
    sectorsUp: ['Copper & aluminium miners & smelters', 'Electrification, grid & battery suppliers'], sectorsDown: ['Aerospace, packaging & autos', 'Construction & machinery'],
    tickersUp: ['FCX', 'SCCO', 'RIO', 'BHP', 'VALE', 'AA', 'CENX', 'COPX', 'PICK', '3993.HK'], tickersDown: ['CAT', 'DE', 'PKB'],
    ideas: 'Copper and aluminium are the electrification, grid and packaging metals — tight supply helps miners and smelters and signals firm industrial demand; it raises costs for construction, aerospace, packaging, autos and machinery.' },
  grains:     { tightQ: 'ARE GRAINS TIGHT?', catalysts: ['USDA WASDE report (monthly)', 'crop weather (US, Brazil, Black Sea)', 'weekly export sales'], watch: ['US crop conditions & the WASDE print', 'Black-Sea export flows'],
    sectorsUp: ['Farm equipment & inputs', 'Grain traders & processors'], sectorsDown: ['Food makers', 'Livestock & protein (feed cost)', 'Ethanol'],
    tickersUp: ['DE', 'ADM', 'BG', 'CF', 'MOS', 'MOO', 'DBA', 'F34.SI'], tickersDown: ['TSN', 'KHC', 'MDLZ'],
    ideas: 'Tight grain is a farmer/producer win and a food-inflation problem — it lifts inputs and processors, and squeezes food makers and livestock feeders.' },
  softs:      { tightQ: 'ARE SOFTS TIGHT?', catalysts: ['harvest weather (Brazil, West Africa, SE Asia)', 'El Niño / La Niña', 'export & shipping'], watch: ['Brazil & West-African harvests', 'Weather anomalies (El Niño / La Niña)'],
    sectorsUp: ['Soft-commodity traders & processors', 'Sugar & coffee producers'], sectorsDown: ['Food & beverage makers', 'Chocolate & confectionery'],
    tickersUp: ['ADM', 'BG', 'JO', 'SGG', 'NIB', 'BAL', 'F34.SI'], tickersDown: ['SBUX', 'HSY', 'MDLZ'],
    ideas: 'Poor harvests lift softs (good for producers & traders) and raise input costs for food, beverage and confectionery companies.' },
  livestock:  { tightQ: 'ARE CATTLE & HOGS TIGHT?', catalysts: ['feed costs (corn/soy)', 'herd cycle & drought', 'export demand (China, Mexico)', 'disease (bird flu / swine fever)'], watch: ['USDA cattle-on-feed & hogs report', 'US beef/pork export demand & the herd rebuild'],
    sectorsUp: ['Protein producers & processors', 'Farm equipment & feed'], sectorsDown: ['Restaurants & food makers', 'Consumers'],
    tickersUp: ['TSN', 'JBS', 'PPC', 'SEB', 'ADM'], tickersDown: ['MCD', 'CMG', 'YUM'],
    ideas: 'Tight cattle & hog supply lifts protein producers, processors and feed/equipment names, and raises input costs for restaurants, food makers and consumers — a protein-inflation read.' },
  dairy:      { tightQ: 'IS DAIRY TIGHT?', catalysts: ['feed costs (corn, soy, alfalfa)', 'USDA milk production & the cow herd', 'Global Dairy Trade (GDT) auctions', 'export demand (China, Mexico, SE Asia)'], watch: ['The USDA milk-production report & cow numbers', 'Global Dairy Trade auction results'],
    sectorsUp: ['Dairy processors & co-ops', 'Farm equipment & feed'], sectorsDown: ['Food & beverage makers', 'Restaurants & consumers'],
    tickersUp: ['SAP.TO', 'BN.PA', 'GL9.IR', 'ADM', 'BG'], tickersDown: ['HSY', 'MDLZ', 'KHC', 'SBUX', 'CMG'],
    ideas: 'Tight milk (a small herd and firm exports) lifts dairy processors and feed suppliers, and raises input costs for food makers, restaurants and consumers: a food-inflation read. The tradeable complex is milk, cheese, butter and milk powder.' },
};
function rollingVolPctile(values, win = 30) {
  const r = [];
  for (let i = 1; i < values.length; i++) { const a = values[i], b = values[i - 1]; r.push(a != null && b != null && b !== 0 ? Math.log(a / b) : null); }
  const vols = [];
  for (let i = win; i <= r.length; i++) {
    const seg = r.slice(i - win, i).filter((x) => x != null);
    if (seg.length < win - 3) continue;
    const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    vols.push(Math.sqrt(seg.reduce((a, b) => a + (b - mean) ** 2, 0) / (seg.length - 1)) * Math.sqrt(252) * 100);
  }
  if (vols.length < 20) return null;
  const cur = vols[vols.length - 1];
  return (vols.filter((v) => v <= cur).length / vols.length) * 100;
}
// A one-line, class-appropriate caveat for a curve-only (market-implied) supply/demand read.
function curveCaveat(marketId) {
  const grp = MARKETS.find((m) => m.id === marketId)?.group;
  return grp === 'Metals'
    ? 'Curve-only, market-implied — and for metals the curve is mostly financing/storage cost, so read it as a hint rather than a stock count.'
    : 'Curve-only, market-implied — the futures curve alone; for crops & livestock the curve also carries the seasonal pattern, so read it as a hint.';
}
function marketVerdict(r) {
  // PRICE vs ITS OWN HISTORY (v3) — a SIGNED read (-100 = cheap/washed-out … +100 = rich):
  // where the price sits in its 2-yr and 10-yr range, plus how big its 3-mo and 1-yr moves are
  // versus its own usual moves. Deliberately separate from physical tightness below: a cheap
  // market can be tight, and a rich one well supplied.
  const ps = stretchScore(r.stretch || []);
  const score = ps.score;
  const label = ps.label;

  // SUPPLY & DEMAND — is the market undersupplied or oversupplied? Built from the best FREE
  // evidence available, and ALWAYS labelled with what it used and what is missing:
  //   • curve             the futures curve (near vs next): backwardation = tight. Free for
  //                       almost everything — but it is the market's OWN vote, not a stock count,
  //                       and for metals it is mostly financing/storage cost.
  //   • spot basis        real (spot) vs futures, where a free spot exists (energy).
  //   • stocks vs norm    weekly US inventories vs their seasonal norm (energy).
  //   • USDA stocks-to-use official supply/demand balance (grains/oilseeds/dairy/livestock) —
  //                       added when the monthly snapshot is present.
  // Weights favour real fundamentals over the (indirect) curve. A missing leg is left out and
  // named — never faked. `kind` = 'physical' when real fundamentals are present, else
  // 'market-implied' (curve only).
  const inv = r.inventory || [];
  const sd = [];
  const used = [];
  const missing = [];
  if (r.curve?.m1m2 != null && r.id !== 'precious') {
    sd.push({ key: 'curve', label: 'Futures curve (near vs next)', weight: 0.25, score: curveTightness(r.curve.m1m2 / (r.curve.months || 1), r.price) });
    used.push('the futures curve');
  } else if (r.id === 'precious') {
    missing.push('a curve read (rates-driven, not supply)');
  }
  if (r.basis?.pctile != null) { sd.push({ key: 'basis', label: 'Spot vs futures', weight: 0.3, score: Math.round(r.basis.pctile) }); used.push('spot vs futures'); }
  for (const it of inv) { sd.push({ key: 'inv:' + it.key, label: `${it.label} vs seasonal`, weight: 0.45 / inv.length, score: inventoryTightness(it.surprise, it.seasonalMin, it.seasonalMax) }); used.push(it.label + ' vs seasonal'); }
  if (r.usda?.stocksPct != null) { sd.push({ key: 'usda', label: `USDA stocks-to-use${r.usda.yearLabel ? ' ' + r.usda.yearLabel : ''}`, weight: 0.5, score: Math.round(100 - r.usda.stocksPct) }); used.push('USDA stocks-to-use'); }
  if (r.hasBasis && r.basis == null) missing.push('a free spot price');
  if (r.hasInventories && !inv.length) missing.push('stocks');
  const sds = weightedScore(sd);
  const hasReal = used.some((u) => u !== 'the futures curve');
  const supplyDemand = {
    score: sd.length ? sds.score : null,
    label: sd.length ? sdLabel(sds.score) : '—',
    parts: sds.parts,
    kind: !sd.length ? null : hasReal ? 'physical' : 'market-implied',
    used, missing,
  };
  supplyDemand.note = !sd.length
    ? (r.id === 'precious'
      ? 'Precious metals have no free spot or warehouse stocks, and their curve tracks rates rather than supply — so no supply/demand read is shown (never faked).'
      : 'No free curve, spot or stock data for this market, so no supply/demand read is shown (never faked).')
    : (hasReal
      ? `From ${used.join(' + ')}${missing.length ? ` · no free ${missing.join(' or ')}` : ''}.`
      : `${curveCaveat(r.id)} No free warehouse stocks or spot prices for this market.`);

  const bits = [];
  if (score != null) {
    const lbl = label.toLowerCase();
    const phrase = (score >= 20 || score <= -20) ? `trades <b>${lbl}</b> versus its own history` : `is <b>${lbl}</b>`;
    bits.push(`<b>${r.label}</b> ${phrase} (${score >= 0 ? '+' : ''}${score}/100)`);
  }
  const mv = [];
  if (r.perf.m3 != null) mv.push(`${r.perf.m3 >= 0 ? 'up' : 'down'} ${Math.abs(r.perf.m3).toFixed(0)}% in 3 months`);
  if (r.perf.y1 != null) mv.push(`${r.perf.y1 >= 0 ? 'up' : 'down'} ${Math.abs(r.perf.y1).toFixed(0)}% over a year`);
  if (mv.length) bits.push(mv.join(' and '));
  if (r.range.pos != null) bits.push(r.range.pos >= 70 ? 'near the top of its 2-year range' : r.range.pos <= 30 ? 'near the bottom of its 2-year range' : 'mid its 2-year range');
  if (r.vol.v30 != null) bits.push(`${(r.vol.pctile ?? 50) >= 70 ? 'unusually jumpy' : (r.vol.pctile ?? 50) <= 30 ? 'unusually calm' : 'normal volatility'}`);
  const meaning = bits.join(' · ') + '.';
  const curveNote = r.curve ? `Futures are in <b>${r.curve.shape.toLowerCase()}</b> — ${r.curve.m1m2 >= 0 ? 'buyers paying up for near-term supply' : 'near-term supply looks comfortable'}.` : '';
  const macroNote = r.macro?.usd != null ? `It tends to move ${r.macro.usd < 0 ? 'against' : 'with'} the US dollar (3-month correlation ${r.macro.usd}).` : '';
  const c = MARKET_CONTENT[r.id] || {};
  return {
    score, label, priceStretch: { score, label, parts: ps.parts }, supplyDemand, meaning, notes: [curveNote, macroNote].filter(Boolean),
    tightQ: c.tightQ || `IS ${r.label.toUpperCase()} STRETCHED?`, watch: c.watch || [], catalysts: c.catalysts || [],
    sectorsUp: c.sectorsUp || [], sectorsDown: c.sectorsDown || [], tickersUp: c.tickersUp || [], tickersDown: c.tickersDown || [], ideas: c.ideas || '',
  };
}
async function getMarketRead(id, componentId) {
  const m = MARKETS.find((x) => x.id === id);
  if (!m) return { error: 'unknown market' };
  // A segment can bundle several instruments — let the caller pick which one to read
  // (e.g. sugar vs coffee vs palm within Softs); default to the segment's headline.
  const sel = m.components.includes(componentId) ? componentId : m.primary;
  return cached('mread:' + id + ':' + sel, 600_000, async () => {
    const primary = BENCHMARKS.find((b) => b.id === sel);
    let priceMap = {};
    try { priceMap = primary.paper ? (await yc(primary.paper, '2y')).series : await cached('mrf:' + primary.physical, 3600e3, () => spotSeries(primary, 740)); } catch {}
    const values = Object.keys(priceMap).sort().map((d) => priceMap[d]);
    // Long monthly history for a multi-year range percentile + the 1-yr move's own
    // distribution, so "stretched" isn't limited to the 2-year window.
    let longVals = [];
    if (primary.paper) { try { const lmap = (await cached('mrlt:' + primary.paper, 6 * 3600e3, () => yahooSeries(primary.paper, '10y', '1mo'))).series; longVals = Object.keys(lmap).sort().map((d) => lmap[d]); } catch {} }
    const last = [...values].reverse().find((v) => v != null) ?? null;
    let prev = null; for (let i = values.length - 2; i >= 0; i--) if (values[i] != null) { prev = values[i]; break; }
    const dayPct = last != null && prev ? ((last - prev) / prev) * 100 : null;
    const vol30 = realizedVol(values, 30);
    let curve = null;
    if (CURVE_SPEC[sel]) { try { const c = await getCurveFor(sel); if (c.available) curve = { shape: c.shape, m1m2: c.m1m2, m1m6: c.m1m6, months: (c.calendar && c.calendar[0] && c.calendar[0].months) || 1 }; } catch {} }
    const sym = primary.paper || primary.physical;
    const macro = {};
    await Promise.all(Object.entries({ usd: 'DX-Y.NYB', vix: '^VIX', spx: '^GSPC' }).map(async ([k, s]) => {
      try { macro[k] = await pairCorr(sym, s); } catch { macro[k] = null; }
    }));
    let basis = null;
    try {
      const row = (await getMarket()).benchmarks.find((b) => b.id === sel);
      const an = (await getAnalytics()).benchmarks?.[sel];
      if (row?.basis != null) basis = { value: row.basis, pctile: an?.basisPct ?? null };
    } catch {}
    // Stocks vs their seasonal norm — the segment's own inventory series (energy only).
    let inventory = null;
    if (m.hasInventories) {
      try {
        const inv = await getInventories();
        const pick = [];
        if (id === 'gas') { if (inv.gas?.surprise != null) pick.push({ key: 'gas', label: 'US gas storage', ...inv.gas }); }
        else if (id === 'refined') { for (const k of ['gasoline', 'distillate']) { const it = inv.items.find((x) => x.key === k); if (it) pick.push(it); } }
        else { const it = inv.items.find((x) => x.key === 'crude'); if (it) pick.push(it); }
        inventory = pick.length ? pick : null;
      } catch {}
    }
    // USDA PSD supply/demand — the official US balance (stocks-to-use), where we have it.
    // Monthly, from the committed snapshot (scripts/fetch-usda.mjs). Percentile is within its
    // own 30-year history, so it is comparable across crops.
    let usda = null;
    try {
      const u = USDA_SNAPSHOT?.commodities?.[sel];
      if (u?.history?.length) {
        const pct = percentile(u.history.map((h) => h.stocksToUse), u.stocksToUse);
        if (pct != null) usda = { label: u.label, marketYear: u.marketYear, yearLabel: u.yearLabel, stocksToUse: u.stocksToUse, stocksPct: pct };
      }
    } catch {}
    const volPctile = rollingVolPctile(values, 30);
    const read = {
      id, label: primary.label, segment: m.label, group: m.group, primary: sel, unit: primary.unit, dp: primary.dp,
      hasBasis: m.hasBasis, hasInventories: m.hasInventories, hasShips: m.hasShips,
      price: last, dayPct,
      perf: { m1: pctOver(values, 21), m3: pctOver(values, 63), m6: pctOver(values, 126), y1: pctOver(values, 252) },
      range: { pos: last != null ? percentile(values, last) : null },
      vol: { v30: vol30, pctile: volPctile },
      curve, macro, basis, inventory, usda,
    };
    // Price vs its own history (v3), SIGNED: + = rich/stretched up, − = cheap/washed-out.
    // Position (where the price sits) carries most of the weight; momentum (how fast it got
    // there) the rest. Volatility is NOT here (not directional, and it double-counts a big
    // move) — it shows as its own line. Each part is a percentile of this market's own history,
    // so the blend is comparable across commodities.
    read.stretch = [
      { key: 'pos2y', label: '2-yr range', weight: 0.36, score: signedPosition(values) },
      { key: 'pos10y', label: '10-yr range', weight: 0.29, score: signedPosition(longVals) },
      // Moves come from the SAME daily series as `perf` below, so the score and the prose agree
      // (the 10-yr monthly series carries a duplicate trailing bar and would disagree).
      { key: 'mv3m', label: '3-mo move', weight: 0.18, score: signedMove(values, 63) },
      { key: 'mv1y', label: '1-yr move', weight: 0.17, score: signedMove(values, 252) },
    ];
    // (The past-year "news drivers" block is served separately by /api/marketwhy, so the core
    // READ returns fast and the client fills that block in afterwards.)
    const takes = [];
    if (read.perf.y1 != null) takes.push(`${read.label} is <b>${read.perf.y1 >= 0 ? 'up' : 'down'} ${Math.abs(read.perf.y1).toFixed(0)}%</b> over the last year${read.perf.m6 != null ? ` (6m ${read.perf.m6 >= 0 ? '+' : ''}${read.perf.m6.toFixed(0)}%)` : ''}.`);
    if (read.range.pos != null) takes.push(`It sits at <b>${read.range.pos.toFixed(0)}/100</b> of its 2-year range — ${read.range.pos >= 70 ? 'near the top' : read.range.pos <= 30 ? 'near the bottom' : 'mid-range'}.`);
    if (read.curve) takes.push(`Futures are in <b>${read.curve.shape.toLowerCase()}</b> — ${read.curve.m1m2 >= 0 ? 'near-term supply is tight (price-positive)' : 'near-term supply looks comfortable'}.`);
    if (read.basis) takes.push(`Real barrels trade <b>${read.basis.value >= 0 ? '+' : ''}${read.basis.value.toFixed(read.dp)}</b> vs futures.`);
    try { const f = await getFundamentals(id, sel); for (const e of (f.items || []).slice(0, 3)) takes.push(`<b>${e.kind}</b> ${e.ageDays <= 14 ? 'recently' : Math.max(1, Math.round(e.ageDays / 30)) + ' months ago'}: ${escHtml(e.title)} — ${e.effect === 'down' ? 'pressure on price' : 'price-positive'}.`); } catch {}
    read.takeaways = takes;
    read.verdict = marketVerdict(read);
    return read;
  });
}
// The READ's slow extra — the past-year news drivers — split out so the core read is fast.
async function getMarketWhy(id, componentId) {
  const m = MARKETS.find((x) => x.id === id);
  if (!m) return { error: 'unknown market' };
  const sel = m.components.includes(componentId) ? componentId : m.primary;
  return cached('mwhy:' + id + ':' + sel, 3600e3, async () => ({ attribution: await getAttribution(id, sel).catch(() => null) }));
}

// ---------------------------------------------------------------------------
// Per-segment headlines. Tier-1 wire only, via Google News RSS — free, no key.
// We surface the HEADLINE + SOURCE + LINK only (never the article text), with
// attribution, and send the reader to the publisher. Cached 45 min.
// ---------------------------------------------------------------------------
const NEWS_QUERIES = {
  // commodity segments
  crude: 'crude oil OR OPEC OR "oil prices"',
  refined: 'gasoline OR diesel OR "jet fuel" OR "refining margins"',
  gas: '"natural gas" OR LNG OR "gas prices"',
  precious: 'gold OR silver OR platinum OR palladium',
  industrial: 'copper OR "base metals" OR aluminium',
  grains: 'wheat OR corn OR soybeans OR WASDE',
  softs: 'sugar OR coffee OR cocoa OR cotton OR "palm oil"',
  livestock: 'cattle OR hogs OR "beef prices" OR "pork prices"',
  dairy: 'milk OR cheese OR butter OR "dairy prices" OR "milk powder"',
  // macro regions
  us: 'US economy OR "Federal Reserve" OR US inflation OR "interest rates"',
  eu: '"euro area" OR ECB OR "eurozone economy" OR European inflation',
  jp: 'Japan economy OR "Bank of Japan" OR yen OR Japan inflation',
  apac: 'China economy OR PBOC OR "China stimulus" OR Asia markets',
  // macro-country news
  ea: '(euro area OR eurozone OR ECB) (inflation OR economy OR rates OR GDP OR growth)',
  de: 'Germany economy OR German inflation OR DAX',
  uk: 'UK economy OR "Bank of England" OR UK inflation',
  fr: 'France economy OR French inflation OR CAC',
  cn: 'China economy OR PBOC OR China stimulus',
  hk: 'Hong Kong economy OR Hong Kong markets',
  in: 'India economy OR RBI OR Indian inflation',
  kr: 'South Korea economy OR "Bank of Korea" OR KOSPI',
  au: 'Australia economy OR RBA OR Australian inflation',
  tw: 'Taiwan economy OR TSMC OR Taiwan markets',
  sg: 'Singapore economy OR MAS OR Singapore markets',
  id: 'Indonesia economy OR Bank Indonesia OR rupiah',
  th: 'Thailand economy OR "Bank of Thailand" OR baht',
  my: 'Malaysia economy OR "Bank Negara Malaysia" OR ringgit',
  ph: 'Philippines economy OR Bangko Sentral OR peso',
  vn: 'Vietnam economy OR "State Bank of Vietnam" OR dong',
};
// A story must NAME the thing it explains — so a US-yield move never shows a UK story and a
// copper move never shows a corn one. Applied ON TOP of the tier-1 + date + direction match.
// Some patterns are case-SENSITIVE on purpose (e.g. /\bUS\b/ so the pronoun "us" doesn't match).
const NEWS_MUST = {
  // commodity segments
  crude: [/\b(crude|oil|opec|brent|wti|barrel|petroleum)\b/i],
  refined: [/\b(gasoline|diesel|jet fuel|refin(er|ing|ers)|distillate|heating oil|crack)\b/i],
  gas: [/\b(natural gas|lng|henry hub|gas (storage|prices?|demand|supply))\b/i],
  precious: [/\b(gold|silver|platinum|palladium|bullion|precious metal)\b/i],
  industrial: [/\b(copper|aluminium|aluminum|base metal|smelter|lme)\b/i],
  grains: [/\b(wheat|corn|maize|soybean|soy\b|grain|wasde|harvest|crop|agricultur)\b/i],
  softs: [/\b(sugar|coffee|cocoa|cotton|palm oil)\b/i],
  livestock: [/\b(cattle|hogs?|beef|pork|feeder)\b/i],
  dairy: [/\b(milk|dairy|cheese|butter|whey)\b/i],
  // macro regions
  us: [/\bFed\b/i, /\bFederal Reserve\b/i, /\bU\.S\./, /\bUS\b/, /\bAmerica\b/i, /\bUnited States\b/i, /\bTreasury\b/i, /\bWall Street\b/i, /\bS&P\b/i, /\bNasdaq\b/i, /\bDXY\b/i, /\bdollar index\b/i],
  eu: [/\beuro(zone|-area|\s?area)?\b/i, /\bECB\b/i, /\bEurope(an)?\b/i],
  jp: [/\bJapan(ese)?\b/i, /\bBoJ\b/i, /\bBank of Japan\b/i, /\byen\b/i, /\bNikkei\b/i, /\bJGB\b/i],
  cn: [/\bChina\b/i, /\bChinese\b/i, /\bPBOC\b/i, /\byuan\b/i, /\brenminbi\b/i, /\bShanghai\b/i, /\bBeijing\b/i, /\bHong Kong\b/i, /\bHang Seng\b/i],
  in: [/\bIndia(n)?\b/i, /\bRBI\b/i, /\brupee\b/i, /\bNifty\b/i, /\bSensex\b/i],
  apac: [/\bAsia(n)?\b/i, /\bSingapore\b/i, /\bIndonesia\b/i, /\bThailand\b/i, /\bMalaysia\b/i, /\bPhilippines\b/i, /\bVietnam\b/i, /\bKorea\b/i, /\bAustralia\b/i, /\bTaiwan\b/i, /\bASEAN\b/i],
  // macro countries
  ea: [/\beuro(zone|-area|\s?area)?\b/i, /\bECB\b/i, /\bEurope(an)?\b/i],
  de: [/\bGerman(y)?\b/i, /\bDAX\b/i, /\bBundesbank\b/i, /\bBund\b/i, /\bBerlin\b/i],
  uk: [/\bUK\b/, /\bBritain\b/i, /\bBritish\b/i, /\bBoE\b/i, /\bBank of England\b/i, /\bsterling\b/i, /\bFTSE\b/i, /\bgilt\b/i, /\bLondon\b/i, /\bGBP\b/],
  fr: [/\bFrance\b/i, /\bFrench\b/i, /\bCAC\b/i, /\bParis\b/i],
  hk: [/\bHong Kong\b/i, /\bHang Seng\b/i, /\bHKMA\b/i, /\bHKD\b/i],
  kr: [/\bKorea(n)?\b/i, /\bBoK\b/i, /\bBank of Korea\b/i, /\bKOSPI\b/i],
  au: [/\bAustralia(n)?\b/i, /\bRBA\b/i, /\bASX\b/i, /\bAussie\b/i],
  tw: [/\bTaiwan(ese)?\b/i, /\bTAIEX\b/i, /\bTSMC\b/i],
  sg: [/\bSingapore(an)?\b/i, /\bMAS\b/, /\bSORA\b/i, /\bStraits Times\b/i],
  id: [/\bIndonesia(n)?\b/i, /\brupiah\b/i, /\bJakarta\b/i],
  th: [/\bThailand\b/i, /\bThai\b/i, /\bbaht\b/i, /\bBangkok\b/i],
  my: [/\bMalaysia(n)?\b/i, /\bringgit\b/i, /\bKuala Lumpur\b/i, /\bKLCI\b/i],
  ph: [/\bPhilippines\b/i, /\bPhilippine\b/i, /\bManila\b/i, /\bPSEi\b/i],
  vn: [/\bVietnam(ese)?\b/i, /\bdong\b/i, /\bHanoi\b/i],
};
function mustScoreFor(specs, title) {
  if (!specs) return 0;
  const t = String(title || '');
  let best = 0;
  for (const re of specs) {
    const m = t.match(re);
    if (!m) continue;
    const pos = (m.index || 0) / Math.max(1, t.length);   // 0 = very start (the subject of the headline)
    const s = pos <= 0.34 ? 4 : pos <= 0.67 ? 2 : 1;      // subject / mid-sentence / passing mention
    if (s > best) best = s;
  }
  return best;
}
const mustScore = (id, title) => mustScoreFor(NEWS_MUST[id], title);
// Keyword presence alone is not enough: "NBA commissioner Adam Silver" contains "silver", and
// "US Open champion" contains "US". EVERY news path runs through this one guard, and the headline
// must be about the right DOMAIN — a commodity market for a commodity, an economy/market story for
// a country/region — not merely contain the keyword.
const COMMODITY_NEWS_IDS = new Set([...MARKETS.map((m) => m.id), ...BENCHMARKS.map((b) => b.id)]);
const newsGuardOk = (id, title) => newsContextOk(title, { domain: COMMODITY_NEWS_IDS.has(id) ? 'commodity' : 'macro' });
const titleMatches = (id, title) => { const s = NEWS_MUST[id]; return (!s || mustScore(id, title) > 0) && newsGuardOk(id, title); };
// Sharper still: the SPECIFIC instrument on the chart (a cocoa chart should not get a sugar story).
const NEWS_FOCUS = {
  wti: [/\b(wti|west texas|crude)\b/i], brent: [/\bbrent\b/i], rbob: [/\b(gasoline|rbob)\b/i], ulsd: [/\b(diesel|heating oil|distillate)\b/i],
  jet: [/\bjet fuel\b/i], propane: [/\bpropane\b/i], natgas: [/\b(natural gas|lng)\b/i],
  gold: [/\bgold\b/i], silver: [/\bsilver\b/i], platinum: [/\bplatinum\b/i], palladium: [/\bpalladium\b/i],
  copper: [/\bcopper\b/i], aluminium: [/\b(aluminium|aluminum)\b/i],
  corn: [/\b(corn|maize)\b/i], wheat: [/\bwheat\b/i], soybean: [/\b(soybean|soy)\b/i], soymeal: [/\b(soy ?meal|meal)\b/i], soyoil: [/\b(soy ?oil|soybean oil|vegetable oil)\b/i],
  sugar: [/\bsugar\b/i], coffee: [/\bcoffee\b/i], cocoa: [/\bcocoa\b/i], cotton: [/\bcotton\b/i], palm: [/\bpalm\b/i],
  cattle: [/\b(cattle|beef)\b/i], hogs: [/\b(hog|pork)\b/i], feeder: [/\b(feeder|cattle|calves)\b/i],
  milk: [/\bmilk\b/i], butter: [/\bbutter\b/i], nfdm: [/\b(nonfat|milk powder|nfdm)\b/i], cheese: [/\bcheese\b/i], whey: [/\bwhey\b/i],
};
// The headline's OWN price direction — an up move wants "surges / soars / rallies", a down move
// "plunges / slides / falls". If a headline says the opposite of the move, it is the wrong story.
const DIR_UP = /\b(surge[sd]?|soar(s|ed)?|rall(y|ies|ied)|jump(s|ed)?|climb(s|ed)?|spike[sd]?|gain(s|ed)?|rise|rises|rising|rebound(s|ed)?|boost(s|ed)?|strengthen(s|ed)?|advance[sd]?|record high|higher)\b/i;
const DIR_DOWN = /\b(plunge[sd]?|slide[s]?|slid|falls?|falling|fell|tumble[sd]?|drops?|dropped|slump(s|ed)?|sink(s|ing)?|sank|decline[sd]?|sell-?off|crash(es|ed)?|record low|retreat(s|ed)?|weaken(s|ed)?|ease[sd]?|slips?|slipped|dips?|dipped|lower)\b/i;
function newsDir(title) {
  const t = String(title || '');
  const u = DIR_UP.test(t), d = DIR_DOWN.test(t);
  return (u && !d) ? 'up' : (d && !u) ? 'down' : null;   // both present = ambiguous
}
const NEWS_REGION_LABELS = { us: 'Americas', eu: 'Europe', jp: 'Japan', apac: 'Asia-Pacific' };
const newsLabel = (id) => MARKETS.find((x) => x.id === id)?.label || NEWS_REGION_LABELS[id] || id;
const NEWS_TIER1 = '(site:reuters.com OR site:bloomberg.com OR site:ft.com OR site:apnews.com OR site:cnbc.com)';
const decodeEnt = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
async function getNews(id, componentId) {
  const terms = NEWS_QUERIES[id];
  if (!terms) return { id, error: 'unknown segment' };
  // Scope to the chosen instrument (Softs + sugar → sugar headlines, not cotton/cocoa).
  const m = MARKETS.find((x) => x.id === id);
  const sel = m && m.components.includes(componentId) ? componentId : null;
  const b = sel ? BENCHMARKS.find((x) => x.id === sel) : null;
  const onTopic = b
    ? (i) => mustScoreFor(NEWS_FOCUS[sel] || [], i.title) > 0 && newsContextOk(i.title)
    : (i) => titleMatches(id, i.title);
  return cached('news:' + id + (sel ? ':' + sel : ''), 45 * 60e3, async () => {
    // Query the chosen instrument directly (Google News returns ~100 per query), then keep only
    // headlines that actually name it and pass the market-context guard.
    const q = b ? `${b.label.replace(/\s*\(.*\)/, '')} ${NEWS_TIER1}` : `(${terms}) ${NEWS_TIER1}`;
    let kept = (await fetchGoogleNews(q, sel ? 40 : 10)).filter(onTopic);
    if (sel && !kept.length) {   // a sparse day → widen to the whole segment's feed, still filtered
      try { kept = (await fetchGoogleNews(`(${terms}) ${NEWS_TIER1}`, 40)).filter(onTopic); } catch {}
    }
    return { id, label: b ? b.label : newsLabel(id), component: sel || null, items: kept.slice(0, 10) };
  });
}

// ---------------------------------------------------------------------------
// Macro countries — per-region country lists (currency + equity index, both LIVE
// from Yahoo). Official macro is only attached where it is genuinely current.
// ---------------------------------------------------------------------------
// iso3 = World Bank code (annual fundamentals). oil = net crude position (factual).
const MACRO_COUNTRIES = {
  us: [{ id: 'us', label: 'United States', iso3: 'USA', oil: 'exporter', fx: 'DX-Y.NYB', fxLabel: 'US dollar (DXY)', index: '^GSPC', indexLabel: 'S&P 500' }],
  eu: [
    { id: 'ea', label: 'Euro area', iso3: 'EMU', oil: 'importer', fx: 'EURUSD=X', fxLabel: 'EUR / USD', index: '^STOXX50E', indexLabel: 'Euro Stoxx 50' },
    { id: 'de', label: 'Germany', iso3: 'DEU', oil: 'importer', fx: 'EURUSD=X', fxLabel: 'EUR / USD', index: '^GDAXI', indexLabel: 'DAX' },
    { id: 'uk', label: 'United Kingdom', iso3: 'GBR', oil: 'importer', fx: 'GBPUSD=X', fxLabel: 'GBP / USD', index: '^FTSE', indexLabel: 'FTSE 100' },
    { id: 'fr', label: 'France', iso3: 'FRA', oil: 'importer', fx: 'EURUSD=X', fxLabel: 'EUR / USD', index: '^FCHI', indexLabel: 'CAC 40' },
  ],
  jp: [{ id: 'jp', label: 'Japan', iso3: 'JPN', oil: 'importer', fx: 'USDJPY=X', fxLabel: 'USD / JPY', index: '^N225', indexLabel: 'Nikkei 225' }],
  in: [{ id: 'in', label: 'India', iso3: 'IND', oil: 'importer', fx: 'USDINR=X', fxLabel: 'USD / INR', index: '^NSEI', indexLabel: 'Nifty 50' }],
  cn: [
    { id: 'cn', label: 'China', iso3: 'CHN', oil: 'importer', fx: 'USDCNY=X', fxLabel: 'USD / CNY', index: '000001.SS', indexLabel: 'Shanghai Composite' },
    { id: 'hk', label: 'Hong Kong', iso3: 'HKG', oil: 'importer', fx: 'USDHKD=X', fxLabel: 'USD / HKD', index: '^HSI', indexLabel: 'Hang Seng' },
  ],
  apac: [
    { id: 'sg', label: 'Singapore', iso3: 'SGP', oil: 'importer', fx: 'USDSGD=X', fxLabel: 'USD / SGD', index: '^STI', indexLabel: 'Straits Times' },
    { id: 'id', label: 'Indonesia', iso3: 'IDN', oil: 'importer', fx: 'USDIDR=X', fxLabel: 'USD / IDR', index: '^JKSE', indexLabel: 'IDX Composite' },
    { id: 'th', label: 'Thailand', iso3: 'THA', oil: 'importer', fx: 'USDTHB=X', fxLabel: 'USD / THB', index: 'THD', indexLabel: 'Thailand (THD ETF proxy)' },
    { id: 'my', label: 'Malaysia', iso3: 'MYS', oil: 'exporter', fx: 'USDMYR=X', fxLabel: 'USD / MYR', index: '^KLSE', indexLabel: 'KLCI' },
    { id: 'ph', label: 'Philippines', iso3: 'PHL', oil: 'importer', fx: 'USDPHP=X', fxLabel: 'USD / PHP', index: 'EPHE', indexLabel: 'Philippines (EPHE ETF proxy)' },
    { id: 'vn', label: 'Vietnam', iso3: 'VNM', oil: 'importer', fx: 'USDVND=X', fxLabel: 'USD / VND', index: 'VNM', indexLabel: 'Vietnam (VNM ETF proxy)' },
    { id: 'kr', label: 'South Korea', iso3: 'KOR', oil: 'importer', fx: 'USDKRW=X', fxLabel: 'USD / KRW', index: '^KS11', indexLabel: 'KOSPI' },
    { id: 'au', label: 'Australia', iso3: 'AUS', oil: 'importer', fx: 'AUDUSD=X', fxLabel: 'AUD / USD', index: '^AXJO', indexLabel: 'ASX 200' },
    { id: 'tw', label: 'Taiwan', iso3: 'TWN', oil: 'importer', fx: 'USDTWD=X', fxLabel: 'USD / TWD', index: '^TWII', indexLabel: 'TAIEX' },
  ],
};
const ALL_COUNTRIES = Object.fromEntries(Object.entries(MACRO_COUNTRIES).flatMap(([region, list]) => list.map((c) => [c.id, { ...c, region }])));
const COUNTRY_MACRO_REGION = { us: 'us', ea: 'eu' }; // where free official macro is actually current

// Country-scoped upcoming catalysts — real dated releases from TradingView's public economic
// calendar (the same JSON its own calendar page uses; it 403s without an Origin header). Only
// high/medium-importance releases are kept, so the list stays short and relevant to the country.
const TV_COUNTRY = { us: 'US', ea: 'EU', de: 'DE', fr: 'FR', uk: 'GB', jp: 'JP', in: 'IN', cn: 'CN', hk: 'HK', sg: 'SG', id: 'ID', th: 'TH', my: 'MY', ph: 'PH', vn: 'VN', kr: 'KR', au: 'AU', tw: 'TW' };
const TV_HEADERS = { ...UA, Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/economic-calendar/', Accept: 'application/json' };
const etParts = (iso) => {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }).format(d).replace(/\s/g, '').toLowerCase();
  return { date, time: `${time} ET` };
};
const tvCalendar = (cc) => cached('tvcal:' + cc, 3 * 3600e3, async () => {
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 42 * 864e5).toISOString();
  const r = await fetch(`https://economic-calendar.tradingview.com/events?from=${from}&to=${to}&countries=${cc}`, { headers: TV_HEADERS });
  if (!r.ok) throw new Error(`tradingview ${cc} -> ${r.status}`);
  const j = await r.json();
  // Keep the notable releases; if a country only has low-impact ones (HK, VN, TW…), show those
  // rather than an empty list so the panel still reflects the country. Holidays are not catalysts.
  const all = (j.result || []).filter((e) => e.date && !/\b(holiday|festival)\b/i.test(e.title || ''));
  const strong = all.filter((e) => e.importance >= 0);
  return (strong.length ? strong : all).map((e) => ({ ...etParts(e.date), name: e.title, importance: e.importance }));
});
async function getCatalysts(country) {
  const id = ALL_COUNTRIES[country] ? country : 'us';
  const label = (ALL_COUNTRIES[id] || {}).label || id.toUpperCase();
  let events = [], source = 'TradingView';
  try { events = (await tvCalendar(TV_COUNTRY[id])).slice(0, 12); } catch { events = []; }
  if (!events.length && id === 'us') { // offline fallback: the app's own recurring US releases
    try { events = ((await getCalendar()).events || []).filter((e) => e.date).map((e) => ({ date: e.date, time: '', name: e.name })).slice(0, 12); source = 'built-in'; } catch {}
  }
  return { updated: new Date().toISOString(), country: id, label, source, events };
}
// World Bank annual fundamentals (free, no key). Annual data — always labelled by year.
async function wbSeries(iso3, ind) {
  if (!iso3) return [];
  return cached(`wb:${iso3}:${ind}`, 24 * 3600e3, async () => {
    try {
      const j = await (await fetch(`https://api.worldbank.org/v2/country/${iso3}/indicator/${ind}?format=json&per_page=60&date=2000:2026`, { headers: UA })).json();
      return (j[1] || []).filter((r) => r.value != null).sort((a, b) => +a.date - +b.date).map((r) => ({ year: +r.date, value: +(+r.value).toFixed(2) }));
    } catch { return []; }
  });
}
const wbLatest = async (iso3, ind) => { const s = await wbSeries(iso3, ind); return s.length ? s[s.length - 1] : null; };
// Debt/GDP: the IMF's own API (imf.org) is blocked from the deploy host (403 WAF — verified),
// so use FRED's mirror of the OECD general-government-gross-debt series (GGGDTA<ISO2>A188N):
// free, reachable, and current (2023–24). The lagged World Bank series is the fallback.
const FRED_ISO2 = { USA: 'US', JPN: 'JP', DEU: 'DE', FRA: 'FR', GBR: 'GB', CHN: 'CN', IND: 'IN', IDN: 'ID', KOR: 'KR', AUS: 'AU', TWN: 'TW' };
async function fredDebt(iso3) {
  const cc = FRED_ISO2[iso3];
  if (!cc) return null;
  const map = await cached('fdebt:' + cc, 24 * 3600e3, () => fredSeries('GGGDTA' + cc + 'A188N', 40 * 366).catch(() => ({})));
  const dates = Object.keys(map).sort();
  const last = [...dates].reverse().find((d) => map[d] != null);
  return last ? { year: +last.slice(0, 4), value: +(+map[last]).toFixed(2) } : null;
}
// Index + currency series for one country (for the macro chart). Distinct cache key.
async function getCountrySeries(id, range = '1y') {
  const c = ALL_COUNTRIES[id];
  if (!c) return { error: 'unknown country' };
  return cached(`cs:${id}:${range}`, 3600e3, async () => {
    const cfg = { '1m': ['1mo', '1d'], '3m': ['3mo', '1d'], '6m': ['6mo', '1d'], ytd: ['ytd', '1d'], '1y': ['1y', '1d'], '5y': ['5y', '1mo'] }[range] || ['1y', '1d'];
    let idxMap = {}, fxMap = {};
    try { fxMap = (await cached(`csr:${cfg[0]}:${c.fx}`, 3600e3, () => yahooSeries(c.fx, cfg[0], cfg[1]))).series; } catch {}
    if (c.index) { try { idxMap = (await cached(`csr:${cfg[0]}:${c.index}`, 3600e3, () => yahooSeries(c.index, cfg[0], cfg[1]))).series; } catch {} }
    const dates = [...new Set([...Object.keys(idxMap), ...Object.keys(fxMap)])].sort();
    const at = (o, d) => (o[d] != null ? o[d] : null);
    return { id, label: c.label, range, dates, index: dates.map((d) => at(idxMap, d)), fx: dates.map((d) => at(fxMap, d)), indexLabel: c.index ? c.indexLabel : null, fxLabel: c.fxLabel };
  });
}

// Every macro ticker (all regions) — so the macro tape is never sparse.
async function getMacroTickers() {
  return cached('macrotickers', 120e3, async () => {
    const q = async (sym) => { try { const { price, series } = await cached('q:' + sym, 120e3, () => yahooSeries(sym, '5d', '1d')); const d = Object.keys(series).sort(); const a = series[d[d.length - 1]], b = series[d[d.length - 2]]; return { price: a ?? price ?? null, pct: a != null && b ? ((a - b) / b) * 100 : null }; } catch { return { price: null, pct: null }; } };
    const items = (await Promise.all(Object.values(ALL_COUNTRIES).map(async (c) => {
      const arr = [{ id: c.id, label: c.fxLabel.replace(/\s*·.*/, ''), ...(await q(c.fx)) }];
      if (c.index) arr.push({ id: c.id, label: c.indexLabel, ...(await q(c.index)) });
      return arr;
    }))).flat();
    return { items };
  });
}
// Tickers for ONE region — every country's currency + equity index (region tape).
async function getRegionTickers(region) {
  const list = MACRO_COUNTRIES[region] || [];
  return cached('rq:' + region, 120e3, async () => {
    const q = async (sym) => { try { const { price, series } = await cached('q:' + sym, 120e3, () => yahooSeries(sym, '5d', '1d')); const d = Object.keys(series).sort(); const a = series[d[d.length - 1]], b = series[d[d.length - 2]]; return { price: a ?? price ?? null, pct: a != null && b ? ((a - b) / b) * 100 : null }; } catch { return { price: null, pct: null }; } };
    // Multi-horizon moves from the same 2-year series the country panel uses.
    const dl = (sym) => deltaSeries(sym).then((r) => mapDeltas(r.series)).catch(() => null);
    const items = (await Promise.all(list.map(async (c) => {
      const arr = [{ id: c.id, label: c.fxLabel.replace(/\s*·.*/, ''), kind: 'fx', ...(await q(c.fx)), deltas: await dl(c.fx) }];
      if (c.index) arr.push({ id: c.id, label: c.indexLabel, kind: 'index', ...(await q(c.index)), deltas: await dl(c.index) });
      return arr;
    }))).flat();
    return { region, items };
  });
}
// BIS central-bank policy rates (free). Area codes: euro area = XM; DE/FR use XM.
const BIS_AREA = { us: 'US', ea: 'XM', de: 'XM', fr: 'XM', uk: 'GB', jp: 'JP', cn: 'CN', hk: 'HK', id: 'ID', th: 'TH', my: 'MY', ph: 'PH', in: 'IN', kr: 'KR', au: 'AU' };
// Government bond yields (FRED). US is daily (2-yr & 10-yr Treasury); the rest are the
// OECD monthly series (3-month interbank + 10-yr), which lag by a month or two.
const BOND_YIELDS = {
  us: { freq: 'daily', short: { id: 'DGS2', label: '2-yr' }, long: { id: 'DGS10', label: '10-yr' } },
  jp: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01JPM156N', label: '3-mo' }, long: { id: 'IRLTLT01JPM156N', label: '10-yr' } },
  de: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01DEM156N', label: '3-mo' }, long: { id: 'IRLTLT01DEM156N', label: '10-yr' } },
  fr: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01FRM156N', label: '3-mo' }, long: { id: 'IRLTLT01FRM156N', label: '10-yr' } },
  uk: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01GBM156N', label: '3-mo' }, long: { id: 'IRLTLT01GBM156N', label: '10-yr' } },
  ea: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01EZM156N', label: '3-mo' }, long: { id: 'IRLTLT01EZM156N', label: '10-yr' } },
  kr: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01KRM156N', label: '3-mo' }, long: { id: 'IRLTLT01KRM156N', label: '10-yr' } },
  au: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01AUM156N', label: '3-mo' }, long: { id: 'IRLTLT01AUM156N', label: '10-yr' } },
  cn: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01CNM156N', label: '3-mo' }, long: null },
  id: { freq: 'monthly · OECD, lagged', short: { id: 'IR3TIB01IDM156N', label: '3-mo' }, long: null },
};
// Which commodities each country's currency actually tracks (for the linkage panel).
const COUNTRY_COMMODITY_LINKS = {
  us: [['WTI crude', 'CL=F'], ['Copper', 'HG=F']],
  ea: [['Brent crude', 'BZ=F']], de: [['Brent crude', 'BZ=F'], ['Copper', 'HG=F']], fr: [['Brent crude', 'BZ=F']],
  uk: [['Brent crude', 'BZ=F']],
  jp: [['WTI crude', 'CL=F'], ['Copper', 'HG=F']],
  cn: [['Copper', 'HG=F'], ['Brent crude', 'BZ=F']], hk: [['Brent crude', 'BZ=F']],
  sg: [['Brent crude', 'BZ=F']],
  id: [['Palm oil', 'CPO=F'], ['Aluminium', 'ALI=F'], ['Copper', 'HG=F'], ['Brent crude', 'BZ=F']],
  th: [['Sugar', 'SB=F'], ['Brent crude', 'BZ=F']],
  my: [['Palm oil', 'CPO=F'], ['Brent crude', 'BZ=F']],
  ph: [['Sugar', 'SB=F'], ['Brent crude', 'BZ=F']],
  vn: [['Coffee', 'KC=F'], ['Brent crude', 'BZ=F']],
  in: [['WTI crude', 'CL=F'], ['Gold', 'GC=F']],
  kr: [['WTI crude', 'CL=F'], ['Copper', 'HG=F']],
  au: [['Copper', 'HG=F'], ['Gold', 'GC=F']],
  tw: [['Copper', 'HG=F'], ['WTI crude', 'CL=F']],
};
// Where there is no policy rate, say why (accurately).
const POLICY_NOTE = {
  sg: 'Singapore has no central-bank policy interest rate: the MAS runs monetary policy by managing the S$ exchange rate (the S$NEER), not a rate. Its market benchmark is SORA (Singapore Overnight Rate Average).',
  tw: 'Taiwan’s policy rate (CBC discount rate) is not on the free BIS policy-rate feed.',
  vn: 'Vietnam’s policy rate (SBV refinancing rate) is not on the free BIS policy-rate feed.',
  ph: 'The BIS series currently carries no value for the Philippines policy rate.',
};
async function getPolicyRate(area) {
  if (!area) return null;
  return cached('bis:' + area, 6 * 3600e3, async () => {
    try {
      const url = `https://stats.bis.org/api/v1/data/BIS,WS_CBPOL,1.0/D.${area}/all?lastNObservations=1350`;
      const r = await fetch(url, { headers: { ...UA, Accept: 'application/vnd.sdmx.data+csv;version=1.0.0' } });
      if (!r.ok) return null;
      const lines = (await r.text()).trim().split('\n');
      const head = lines[0].split(',');
      const iT = head.indexOf('TIME_PERIOD'), iV = head.indexOf('OBS_VALUE');
      if (iT < 0 || iV < 0) return null;
      const hist = [];
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(',');
        const v = parseFloat(c[iV]);
        if (isFinite(v)) hist.push({ date: c[iT], value: v });
      }
      if (!hist.length) return null;
      hist.sort((a, b) => (a.date < b.date ? -1 : 1));
      return { area, latest: hist[hist.length - 1], history: hist };
    } catch { return null; }
  });
}
// Government bond yields for one country (short + long + term spread). FRED, cached 6h.
async function getBondYields(id) {
  const cfg = BOND_YIELDS[id];
  const label = ALL_COUNTRIES[id]?.label || id;
  if (!cfg) return { id, label, error: 'no free bond-yield data', freq: null, short: null, long: null, spread: null };
  return cached('yields:' + id, 6 * 3600e3, async () => {
    const days = 5 * 366 + 30;
    const get = async (spec) => {
      if (!spec) return null;
      const map = await fredSeries(spec.id, days).catch(() => ({}));
      const dates = Object.keys(map).sort();
      if (!dates.length) return null;
      const last = [...dates].reverse().find((d) => map[d] != null) || null;
      return { label: spec.label, dates, values: dates.map((d) => map[d]), latest: last ? map[last] : null, date: last };
    };
    const [s, l] = await Promise.all([get(cfg.short), get(cfg.long)]);
    const spread = s?.latest != null && l?.latest != null ? +(l.latest - s.latest).toFixed(2) : null;
    return { id, label, freq: cfg.freq, short: s, long: l, spread, asOf: (l?.date || s?.date || null) };
  });
}
async function getCountry(id) {
  const c = ALL_COUNTRIES[id];
  if (!c) return { error: 'unknown country' };
  return cached('country:' + id, 15 * 60e3, async () => {
    const quote = async (sym) => { try { const { price, series } = await cached('q:' + sym, 120e3, () => yahooSeries(sym, '5d', '1d')); const d = Object.keys(series).sort(); const a = series[d[d.length - 1]], b = series[d[d.length - 2]]; return { price: a ?? price ?? null, pct: a != null && b ? ((a - b) / b) * 100 : null }; } catch { return { price: null, pct: null }; } };
    const rk = COUNTRY_MACRO_REGION[id];
    // Everything independent runs CONCURRENTLY — the whole panel in one round trip.
    const [fx, idx, wbGdp, wbDebt, wbCpi, wbUnemp, cs, mn, oilLink, macroMd, policy, links, fxDlMap, idxDlMap, fredDebtToGdp] = await Promise.all([
      quote(c.fx),
      c.index ? quote(c.index) : Promise.resolve({ price: null, pct: null }),
      wbSeries(c.iso3, 'NY.GDP.MKTP.KD.ZG'),
      wbLatest(c.iso3, 'GC.DOD.TOTL.GD.ZS'),
      wbSeries(c.iso3, 'FP.CPI.TOTL.ZG'),
      wbLatest(c.iso3, 'SL.UEM.TOTL.ZS'),
      getCountrySeries(id, '1y').catch(() => ({})),
      getMacroNews(id).catch(() => ({ items: [] })),
      pairCorr(c.fx, 'CL=F').catch(() => null),
      rk ? getMacroDash().catch(() => null) : Promise.resolve(null),
      getPolicyRate(BIS_AREA[id]).catch(() => null),
      (() => Promise.all((COUNTRY_COMMODITY_LINKS[id] || []).map(async ([commodity, csym]) => ({ commodity, corr: await pairCorr(c.fx, csym).catch(() => null) }))).catch(() => []))(),
      deltaSeries(c.fx).then((r) => r.series).catch(() => ({})),
      c.index ? deltaSeries(c.index).then((r) => r.series).catch(() => ({})) : Promise.resolve({}),
      fredDebt(c.iso3),
    ]);
    const chg = (arr) => { const f = (arr || []).find((v) => v != null); const l = [...(arr || [])].reverse().find((v) => v != null); return f && l ? ((l - f) / f) * 100 : null; };
    // Annual macro: IMF WEO snapshot (comprehensive, current) -> FRED/OECD debt -> World Bank.
    const snap = (MACRO_SNAPSHOT && MACRO_SNAPSHOT.countries && MACRO_SNAPSHOT.countries[id]) || null;
    const gdpGrowth = snap?.gdpGrowth?.length ? snap.gdpGrowth : wbGdp.slice(-6);
    const debtToGdp = snap?.debtToGdp || fredDebtToGdp || wbDebt;
    const cpi = snap?.cpi?.length ? snap.cpi : wbCpi.slice(-25);
    const inflation = snap?.inflation || (cpi.length ? cpi[cpi.length - 1] : null);
    const unemployment = snap?.unemployment || wbUnemp;
    const perf = { index: chg(cs.index), fx: chg(cs.fx) };
    // Every price in the country card gets the same multi-horizon moves + a source/as-of.
    const fxDeltas = mapDeltas(fxDlMap);
    const idxDeltas = mapDeltas(idxDlMap);
    const asOf = (Object.keys(fxDlMap || {}).sort().slice(-1)[0]) || (cs.dates || []).slice(-1)[0] || null;
    const macro = macroMd ? (macroMd.regions?.[rk] || null) : null;
    const takes = [];
    if (policy) takes.push(`Central bank policy rate <b>${policy.latest.value}%</b> (as of ${policy.latest.date}).`);
    else if (POLICY_NOTE[id]) takes.push(POLICY_NOTE[id]);
    if (perf.index != null && c.index) takes.push(`${c.indexLabel} <b>${perf.index >= 0 ? '+' : ''}${perf.index.toFixed(0)}%</b> over the last year.`);
    if (perf.fx != null) takes.push(`${c.fxLabel} <b>${perf.fx >= 0 ? '+' : ''}${perf.fx.toFixed(0)}%</b> over the last year${perf.fx >= 0 ? ' (a higher USD-pair = weaker local currency)' : ''}.`);
    if (inflation || unemployment) takes.push(`Inflation <b>${inflation ? inflation.value + '% (' + inflation.year + ')' : 'n/a'}</b> · unemployment <b>${unemployment ? unemployment.value + '% (' + unemployment.year + ')' : 'n/a'}</b>.`);
    if (debtToGdp && debtToGdp.year >= 2018) takes.push(`Government debt is <b>${debtToGdp.value}% of GDP</b> (${debtToGdp.year}).`);
    if (oilLink != null) takes.push(`${c.label} is a net oil ${c.oil}; its currency's 3-month correlation vs Brent is <b>${oilLink}</b>.`);
    try { const mn = await getMacroNews(id); for (const it of (mn.items || []).slice(0, 2)) takes.push(`<b>${it.kind}</b>: ${escHtml(it.title)}.`); } catch {}
    return {
      id, label: c.label, region: c.region, iso3: c.iso3, oil: c.oil,
      fx: { label: c.fxLabel, sym: c.fx, ...fx, deltas: fxDeltas, asOf, source: 'Yahoo Finance' },
      index: { label: c.indexLabel, sym: c.index, ...idx, deltas: idxDeltas, asOf, source: 'Yahoo Finance' },
      macro, oilLink, perf, takeaways: takes, policy, policyNote: POLICY_NOTE[id] || null, links,
      cpi,   // annual CPI inflation % (IMF WEO, World Bank fallback)
      fund: { gdpGrowth: gdpGrowth.slice(-6), debtToGdp, inflation, unemployment, source: snap ? 'IMF WEO (annual snapshot)' : (fredDebtToGdp ? 'Debt/GDP: FRED (OECD) · others World Bank (annual)' : 'World Bank (annual)') },
    };
  });
}

// ---------------------------------------------------------------------------
// Fundamental news scanner — an algorithm that reads the headlines and tags the
// ones that matter on supply/demand (weather, strikes, export bans, outages,
// geopolitics…), then states the usual implication. A signal to investigate,
// not a certainty — every item links to its source.
// ---------------------------------------------------------------------------
async function fetchGoogleNews(q, limit = 12) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('news ' + res.status);
  const xml = await res.text();
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const it = m[1];
    const rawTitle = decodeEnt((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const link = decodeEnt((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const source = decodeEnt((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
    const title = source && rawTitle.endsWith(' - ' + source) ? rawTitle.slice(0, -(source.length + 3)) : rawTitle;
    const d = pub ? new Date(pub) : null;
    if (title && link) items.push({ title, source, url: link, date: d && !isNaN(d) ? d.toISOString() : null });
  }
  return items;
}
const EVENT_RULES = [
  { re: /\b(hurricane|typhoon|cyclone|tornado|severe storm)\b/i, kind: 'Severe weather', effect: 'up', weight: 3, chain: 'Storms can wreck crops, ports and refineries — a supply risk, usually price-positive, and a hit to downstream users.' },
  { re: /\b(drought|heatwave|heat wave|dry spell|water short)\b/i, kind: 'Drought', effect: 'up', weight: 3, chain: 'Drought cuts yields and output — tighter supply, price-positive; hurts processors and consumers.' },
  { re: /\b(frost|freeze|freezing)\b/i, kind: 'Frost / freeze', effect: 'up', weight: 3, chain: 'Frost damages crops (coffee, citrus, sugar) — supply risk, price-positive.' },
  { re: /\b(el ni[ñn]o|la ni[ñn]a)\b/i, kind: 'El Niño / La Niña', effect: 'up', weight: 3, chain: 'El Niño/La Niña shifts rainfall — a classic risk to palm oil, sugar, coffee, cocoa and grains; supply risk.' },
  // Geopolitics / chokepoints BEFORE "strike" — else a military "drone strike" is mis-tagged as a labour strike.
  { re: /\b(war|conflict|attack|drone|missile|escalat|tension)\b/i, kind: 'Geopolitics', effect: 'up', weight: 3, chain: 'Conflict lifts supply/freight risk (and safe-haven demand for gold) — usually price-positive for energy and metals.' },
  { re: /\b(hormuz|red sea|suez|bab el|chokepoint|strait of hormuz)\b/i, kind: 'Shipping / chokepoint', effect: 'up', weight: 3, chain: 'A chokepoint or shipping disruption lifts freight and supply risk — price-positive for oil, products and gas.' },
  { re: /\b(opec\+?[^.]{0,40}(cut|reduce|hold|extend)|production cut|output cut|supply cut)\b/i, kind: 'OPEC+ supply policy', effect: 'up', weight: 2, chain: 'OPEC+ output cuts tighten supply — price-positive for crude and products.' },
  { re: /\b(walkout|labou?r (action|dispute|unrest)|workers?'? strike|strike action|mine strike|port strike|protest)\b/i, kind: 'Strike / labour', effect: 'up', weight: 3, chain: 'Strikes at mines, ports or refineries cut supply — price-positive.' },
  { re: /\b(sanction|embargo|export (ban|curb|levy|tax|quota)|blockade|ban on exports)\b/i, kind: 'Export curbs / sanctions', effect: 'up', weight: 3, chain: 'Export restrictions tighten supply (e.g. palm-oil levies, grain bans, metal sanctions) — price-positive.' },
  { re: /\b(force majeure|outage|curtail(ed|ment)?|closure|halt(ed|s)?|suspend(ed|s)?)\b/i, kind: 'Supply outage', effect: 'up', weight: 2, chain: 'An outage or shutdown removes supply — price-positive for the commodity.' },
  { re: /\b(fire|explosion|blast|leak at)\b/i, kind: 'Plant / refinery incident', effect: 'up', weight: 2, chain: 'Fires or explosions at plants/refineries cut supply and widen crack spreads.' },
  // Metals/gold often move on money, not barrels — rates, the dollar, ETF/safe-haven flows.
  { re: /\b(fed|federal reserve|rate (cut|hike|rise|hold)|interest rate|treasury yield|safe haven|etf|central bank|gold buying|dollar (weak|firm|strength|slide))\b/i, kind: 'Rates / dollar', effect: 'watch', weight: 2, chain: 'Metals trade off interest rates and the dollar — cuts and a softer dollar are supportive, hikes and a firm dollar a headwind.' },
  { re: /\b(record (crop|harvest|output|production)|bumper|surplus|glut|oversupply|abundant)\b/i, kind: 'Ample supply', effect: 'down', weight: 2, chain: 'Record output or surplus adds supply — price-negative, pressures producers.' },
  { re: /\b(demand (slowdown|slump|weak|fall)|recession|slowdown|weaker demand)\b/i, kind: 'Weak demand', effect: 'down', weight: 2, chain: 'Weak demand softens prices — bearish for the commodity.' },
  { re: /\b(disease|blight|rust|avian|bird flu|swine fever|pest)\b/i, kind: 'Crop disease', effect: 'up', weight: 2, chain: 'Disease hits crops or herds — reduces supply, price-positive.' },
  { re: /\b(inventor(y|ies) (build|rise|jump)|stocks? (build|rise|jump)|build in (crude|stocks))\b/i, kind: 'Inventory build', effect: 'down', weight: 2, chain: 'Rising inventories signal ample supply — price-negative.' },
];
const SCAN_QUERIES = {
  crude: '(oil OR refinery OR "oil field" OR OPEC OR "crude oil") (hurricane OR outage OR sanctions OR "force majeure" OR attack OR strike OR hormuz OR "red sea" OR tanker OR "supply cut")',
  refined: '(refinery OR diesel OR gasoline OR "jet fuel") (outage OR fire OR hurricane OR strike OR "force majeure")',
  gas: '("natural gas" OR LNG) (outage OR hurricane OR freeze OR pipeline OR strike)',
  precious: '(gold OR silver OR "gold mine" OR platinum) (strike OR sanctions OR shutdown OR "central bank")',
  industrial: '(copper OR "copper mine" OR aluminium) (strike OR outage OR sanctions OR shutdown OR "export ban")',
  grains: '(wheat OR corn OR soybeans OR grain) (drought OR flood OR frost OR "export ban" OR harvest OR strike)',
  softs: '(sugar OR coffee OR cocoa OR cotton OR "palm oil") (hurricane OR drought OR "El Nino" OR flood OR frost OR disease OR "export ban" OR harvest)',
  livestock: '(cattle OR hogs OR beef OR pork) (drought OR disease OR "bird flu" OR "swine fever" OR "export ban" OR strike OR recall OR herd)',
  dairy: '(milk OR dairy OR cheese OR butter) (drought OR disease OR "bird flu" OR "export ban" OR strike OR recall OR cull OR feed)',
};
// Supply/demand event terms for a per-instrument fundamentals scan.
const FUND_EVENTS = '(drought OR flood OR frost OR hurricane OR "export ban" OR sanctions OR strike OR outage OR disease OR harvest OR "El Nino" OR shortage OR surplus OR recall OR "force majeure" OR mine OR smelter OR freeze OR pipeline)';
async function getFundamentals(id, componentId) {
  const m = MARKETS.find((x) => x.id === id);
  const base = SCAN_QUERIES[id];
  if (!m || !base) return { id, error: 'unknown segment', items: [] };
  // Scope to the CHOSEN instrument when one is picked — so Softs + sugar never surfaces a cotton
  // (or cocoa) event. No component → scan the whole segment, as before.
  const sel = m.components.includes(componentId) ? componentId : null;
  const b = sel ? BENCHMARKS.find((x) => x.id === sel) : null;
  return cached('fund:' + id + (sel ? ':' + sel : ''), 45 * 60e3, async () => {
    const term = b ? b.label.replace(/\s*\(.*\)/, '') : null;
    const now = Date.now();
    const hits = [];
    const collect = (list) => {
      for (const it of list) {
        const onTopic = sel
          ? (mustScoreFor(NEWS_FOCUS[sel] || [], it.title) > 0 && newsContextOk(it.title))   // names the instrument + market context
          : titleMatches(id, it.title);
        if (!onTopic) continue;
        for (const r of EVENT_RULES) { if (r.re.test(it.title)) { hits.push({ ...it, kind: r.kind, effect: r.effect, chain: r.chain, ageDays: it.date ? Math.max(0, Math.round((now - Date.parse(it.date)) / 864e5)) : null }); break; } }
      }
    };
    const items = await fetchGoogleNews(term ? `${term} ${FUND_EVENTS}` : base, sel ? 40 : 16);
    let scanned = items.length;
    collect(items);
    if (sel && !hits.length) { try { const more = await fetchGoogleNews(base, 40); scanned += more.length; collect(more); } catch {} }
    return { id, label: b ? b.label : newsLabel(id), component: sel || null, items: sel ? hits.slice(0, 10) : hits, scanned };
  });
}
// Trusted-source news for explaining a chart move — tier-1 outlets ONLY (no blogs). The client
// finds the biggest moves in the plotted series and sends their dates; here we look up the news
// published in a tight window around each move (Google News honours after:/before:), and pick the
// best story (closest day, preferring one whose direction matches the move).
async function getMoveWho(id, reqs, focusId) {
  const base = NEWS_QUERIES[id];        // covers commodity segments AND macro regions/countries
  if (!base) return { results: [] };
  const focusSpecs = (focusId && NEWS_FOCUS[focusId]) || null;
  const sh = (day, off) => new Date(Date.parse(day) + off * 864e5).toISOString().slice(0, 10);
  const plans = (reqs || []).slice(0, 6).map((r) => {
    const d = r.date;
    const monthly = /^\d{4}-\d{2}$/.test(d);
    if (!monthly && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const day = monthly ? d + '-15' : d;                 // 5Y/10Y charts use YYYY-MM labels
    const win = monthly ? 15 : 3;                        // a monthly bar's news can be any day that month
    return { r, d, day, after: sh(day, -win), before: sh(day, win + 1) };
  }).filter(Boolean);
  // Each day needs its own Google News query. They are independent, so fetch them together — the
  // old sequential loop did up to 6 back-to-back round-trips (~9s on a cold chart).
  const hits = await Promise.all(plans.map((p) => cached(`movewho:${id}:${p.d}`, 6 * 3600e3, async () => {
    let items = [];
    try { items = await fetchGoogleNews(`(${base}) after:${p.after} before:${p.before} ${NEWS_TIER1}`, 20); } catch {}
    const ev = [];
    for (const it of items) {
      if (!TIER1_RE.test(it.source || '')) continue;
      let kind = null, effect = 'watch', weight = 1;
      for (const rule of EVENT_RULES) { if (rule.re.test(it.title)) { kind = rule.kind; effect = rule.effect; weight = rule.weight; break; } }
      ev.push({ date: it.date, title: it.title, source: it.source, url: it.url, kind: kind || 'Market news', effect, weight });
    }
    return ev;
  })));
  const out = [];
  plans.forEach(({ r, d, day }, i) => {
    const hit = hits[i];
    // Pick the most ON-TOPIC story that AGREES with the move's direction.
    const want = r.dir === 'up' ? 'up' : 'down';
    let best = null, bs = -Infinity, bestFocus = false;
    for (const e of hit) {
      const et = Date.parse(String(e.date).slice(0, 10));
      if (isNaN(et)) continue;
      const rel = mustScore(id, e.title);
      if (rel === 0) continue;                              // must name the segment / market
      if (!newsGuardOk(id, e.title)) continue;              // ...and be a market story, not "Adam Silver" (NBA)
      const td = newsDir(e.title);
      let dirBonus;
      if (td) { if (td !== want) continue; dirBonus = 3; }  // headline says the opposite → wrong story
      else { if (e.effect !== 'watch' && e.effect !== want) continue; dirBonus = e.effect === want ? 2 : 0.5; }
      const frel = focusSpecs ? mustScoreFor(focusSpecs, e.title) : 0;
      const days = Math.abs(et - Date.parse(day)) / 864e5;
      const score = rel * 1.2 + frel * 2.0 + dirBonus + (e.kind ? 0.3 : 0) - days * 0.25;
      if (score > bs) { bs = score; best = e; bestFocus = frel > 0; }
    }
    out.push({ date: d, dir: r.dir, news: best ? { kind: best.kind, title: best.title, source: best.source, url: best.url, match: bestFocus ? 'instrument' : 'segment' } : null });
  });
  return { id, label: newsLabel(id), results: out };
}

// ---------------------------------------------------------------------------
// Attribution — explain the PAST YEAR's move with cited, trusted news. Pulls a year of
// coverage for the segment, tags it with the event rules, ranks trusted sources, and picks
// the kinds consistent with the direction of the move. A heuristic, clearly labelled.
// ---------------------------------------------------------------------------
const ATTR_EVENTS = '(drought OR flood OR frost OR hurricane OR "export ban" OR sanctions OR strike OR outage OR disease OR harvest OR "El Nino" OR shortage OR surplus OR demand OR "central bank" OR Fed OR rates OR ETF OR "safe haven" OR mine OR supply)';
async function getAttribution(id, componentId) {
  const m = MARKETS.find((x) => x.id === id);
  if (!m) return { id, error: 'unknown segment' };
  const sel = m.components.includes(componentId) ? componentId : m.primary;
  const primary = BENCHMARKS.find((b) => b.id === sel);
  return cached('attr:' + id + ':' + sel, 3600e3, async () => {
    let values = [];
    try { const pm = primary.paper ? (await yc(primary.paper, '2y')).series : {}; values = Object.keys(pm).sort().map((d) => pm[d]); } catch {}
    const moves = { y1: pctOver(values, 252), m6: pctOver(values, 126), m1: pctOver(values, 21) };
    // Tuned segment query for the headline instrument; a commodity-specific one otherwise.
    const term = primary.label.replace(/\s*\(.*\)/, '');
    const q = sel === m.primary ? (SCAN_QUERIES[id] || NEWS_QUERIES[id] || term) : `"${term}" ${ATTR_EVENTS}`;
    let items = [];
    try { items = await fetchGoogleNews(q + ' when:1y', 60); } catch {}
    const events = [];
    for (const it of items) {
      if (!titleMatches(id, it.title)) continue;   // on-topic only
      for (const r of EVENT_RULES) {
        if (r.re.test(it.title)) { events.push({ kind: r.kind, effect: r.effect, weight: r.weight, date: it.date, source: it.source, title: it.title, url: it.url, tier1: TIER1_RE.test(it.source || '') }); break; }
      }
    }
    const attr = attributeMoves(moves, events);
    return { id, label: primary.label, y1: moves.y1, m6: moves.m6, m1: moves.m1, ...attr, scanned: items.length, tagged: events.length };
  });
}

// ---------------------------------------------------------------------------
// Live "important headlines" — tier-1 wire, ranked by event materiality + recency.
// ---------------------------------------------------------------------------
const HEADLINE_QUERY = '(oil OR "natural gas" OR gold OR copper OR wheat OR corn OR soybeans OR sugar OR coffee OR cocoa OR "palm oil") (OPEC OR sanctions OR hurricane OR drought OR "export ban" OR strike OR outage OR "record output" OR glut OR tariff OR attack) (site:reuters.com OR site:bloomberg.com OR site:ft.com OR site:apnews.com OR site:cnbc.com)';
const TIER1_RE = /reuters|bloomberg|financial times|ft\.com|ap news|associated press|cnbc|wsj|wall street journal/i;
async function getHeadlines() {
  return cached('headlines', 20 * 60e3, async () => {
    // The hero board is commodity-focused; still drop any sports/entertainment or name collision.
    const items = (await fetchGoogleNews(HEADLINE_QUERY, 30).catch(() => [])).filter((it) => newsContextOk(it.title, { requireMarket: false }));
    const now = Date.now();
    for (const it of items) {
      let kind = 'Markets', effect = 'watch', weight = 1;
      for (const r of EVENT_RULES) { if (r.re.test(it.title)) { kind = r.kind; effect = r.effect; weight = r.weight; break; } }
      it.kind = kind; it.effect = effect;
      const age = it.date ? (now - new Date(it.date)) / 864e5 : 999;
      it.ageDays = Math.round(age);
      it.score = weight * 10 + (TIER1_RE.test(it.source || '') ? 6 : 0) + Math.max(0, 12 - age / 20) + (age <= 3 ? 10 : 0);
    }
    items.sort((a, b) => b.score - a.score);
    return { items: items.slice(0, 6), generated: new Date().toISOString() };
  });
}

// Macro news — importance-ranked (policy, sovereign risk, politics, geopolitics).
const MACRO_EVENT_RULES = [
  { re: /\b(rate (hike|cut|rise|reduction)|hikes?|cuts? (rates|interest)|central bank|federal reserve|the fed|ecb|boj|pboc|rbi|bank of england|bank of japan|bank indonesia|bank of korea|rba)\b/i, kind: 'Central bank', weight: 3 },
  { re: /\b(inflation (surge|jump|spike|hot|accelerat|eases|cools)|deflation|disinflation|price pressures)\b/i, kind: 'Inflation', weight: 3 },
  { re: /\b(recession|gdp (falls|contracts|beats|misses|slows)|growth (slows|accelerates|beats)|downturn|slowdown)\b/i, kind: 'Growth', weight: 3 },
  { re: /\b(election|votes?|referendum|coalition|parliament)\b/i, kind: 'Politics', weight: 2 },
  { re: /\b(protest|unrest|riot|coup|martial law|crackdown|strike|violence)\b/i, kind: 'Unrest', weight: 3 },
  { re: /\b(sanction|tariff|trade war|embargo|export (ban|curb)|import (ban|curb)|capital controls?|devalu)\b/i, kind: 'Trade / FX', weight: 3 },
  { re: /\b(default|downgrade|imf|bailout|debt (crisis|ceiling|sustainab)|bond (selloff|yields|market))\b/i, kind: 'Sovereign risk', weight: 3 },
  { re: /\b(stimulus|bailout|intervention|rescue|quantitative|subsid)\b/i, kind: 'Policy support', weight: 2 },
  { re: /\b(war|conflict|attack|invasion|missile|escalat|tension)\b/i, kind: 'Geopolitics', weight: 3 },
];
async function getMacroNews(id) {
  const terms = NEWS_QUERIES[id];
  if (!terms) return { id, error: 'unknown region', items: [] };
  return cached('mnews:' + id, 40 * 60e3, async () => {
    // Drop anything that is not actually an economy/market story — e.g. a sports or film headline
    // that merely names the country (the MACRO domain guard).
    const items = (await fetchGoogleNews(`(${terms}) (rate OR inflation OR economy OR election OR sanctions OR protest OR IMF OR stimulus OR tariff OR downgrade)`, 30).catch(() => [])).filter((it) => newsContextOk(it.title, { domain: 'macro' }));
    const now = Date.now();
    for (const it of items) {
      let kind = 'Economy', weight = 1;
      for (const r of MACRO_EVENT_RULES) { if (r.re.test(it.title)) { kind = r.kind; weight = r.weight; break; } }
      it.kind = kind;
      const age = it.date ? (now - new Date(it.date)) / 864e5 : 999;
      it.ageDays = Math.round(age);
      it.score = weight * 10 + (TIER1_RE.test(it.source || '') ? 6 : 0) + Math.max(0, 12 - age / 20) + (age <= 3 ? 10 : 0);
    }
    items.sort((a, b) => b.score - a.score);
    return { id, label: newsLabel(id), items: items.slice(0, 6) };
  });
}

// ---------------------------------------------------------------------------
// Cross-asset transmission. Data-driven triggers (real %, pp moves) feeding a
// coded rule set that reasons ACROSS segments and regions — e.g. oil↑ → inflation
// expectations↑ → rates↑ → precious-metals headwind; oil↑ → oil-importing regions
// squeezed. The triggers are data; the chains are an explicit framework, not a forecast.
// ---------------------------------------------------------------------------
const pctChg = (series, days) => {
  const d = Object.keys(series).sort();
  const vals = d.map((k) => series[k]);
  const last = [...vals].reverse().find((v) => v != null);
  const base = vals[Math.max(0, vals.length - 1 - days)];
  return last != null && base ? ((last - base) / base) * 100 : null;
};
async function dirPct(sym, days) { try { return pctChg((await yc(sym, '3mo')).series, days); } catch { return null; } }
async function getTransmission() {
  return cached('transmission', 30 * 60e3, async () => {
    const [oil1m, oil3m, dxy1m, gold1m, copper1m, corn1m, curves, md, dgs10] = await Promise.all([
      dirPct('CL=F', 21), dirPct('CL=F', 63), dirPct('DX-Y.NYB', 21), dirPct('GC=F', 21), dirPct('HG=F', 21), dirPct('ZC=F', 21),
      getCurves().catch(() => null), getMacroDash().catch(() => null), fredSeries('DGS10', 60).catch(() => ({})),
    ]);
    const d10 = Object.keys(dgs10).sort().map((k) => dgs10[k]);
    const r10 = d10.length ? d10[d10.length - 1] : null;
    const r10prev = d10.length > 21 ? d10[d10.length - 22] : null;
    const rateChg = r10 != null && r10prev != null ? +(r10 - r10prev).toFixed(2) : null; // pp over ~1 month
    const tight = curves?.brent?.shape === 'Backwardation';
    const ideas = [];
    const add = (o) => ideas.push(o);

    if (oil1m != null && oil1m > 3) {
      add({ id: 'oil-inflation-rates', trigger: `Oil ${oil1m >= 0 ? '+' : ''}${oil1m.toFixed(1)}% in a month${tight ? ' with the curve in backwardation (tight)' : ''}`,
        chain: 'Higher oil lifts <b>inflation expectations</b> → central banks stay hawkish and bond <b>yields rise</b> → higher <b>real yields</b> are a headwind for precious metals, while the dollar firms. Energy costs squeeze users.',
        benefits: ['Energy producers & services', 'Banks (steeper curve)'], hurt: ['Precious metals (via real yields)', 'Rate-sensitive growth & property', 'Airlines, trucking, chemicals'],
        up: ['XOM', 'CVX', 'COP', 'SLB'], down: ['NEM', 'GDX', 'AAL', 'DAL'], segments: ['crude', 'refined', 'precious', 'industrial'], regions: ['us', 'eu', 'jp', 'apac'] });
      add({ id: 'oil-importers', trigger: `Oil ${oil1m >= 0 ? '+' : ''}${oil1m.toFixed(1)}% in a month`,
        chain: 'Oil is priced in dollars and imported by most of Europe & Asia — a rising oil bill widens their <b>trade deficit</b>, pressures their <b>currencies</b> and squeezes consumer spending, while exporters gain.',
        benefits: ['Oil exporters (Norway, Canada, Brazil, Gulf, US shale)'], hurt: ['Big oil importers: Japan, euro area, India, Korea, China'],
        up: ['SU', 'PBR', 'CNQ'], down: [], segments: ['crude'], regions: ['eu', 'jp', 'apac'] });
    }
    if (oil1m != null && oil1m < -3) {
      add({ id: 'oil-deflation-rates', trigger: `Oil ${oil1m.toFixed(1)}% in a month`,
        chain: 'Falling oil cools <b>inflation expectations</b> → room for lower rates → a tailwind for <b>precious metals</b> and rate-sensitive assets, and relief for fuel users; energy producers lose out.',
        benefits: ['Airlines, trucking, chemicals', 'Precious metals (if yields fall)'], hurt: ['Energy producers & services'],
        up: ['DAL', 'UAL', 'GDX'], down: ['XOM', 'COP', 'SLB'], segments: ['crude', 'refined', 'precious'], regions: ['us', 'eu', 'jp', 'apac'] });
    }
    if (dxy1m != null && Math.abs(dxy1m) > 1.5) {
      const up = dxy1m > 0;
      add({ id: 'dollar', trigger: `US dollar ${up ? '+' : ''}${dxy1m.toFixed(1)}% in a month`,
        chain: up ? 'A firmer dollar makes dollar-priced commodities <b>more expensive</b> for the rest of the world, a broad headwind, and tightens global financial conditions, pressing emerging markets.'
          : 'A softer dollar makes dollar-priced commodities <b>cheaper</b> for the world, a broad tailwind, and eases global financial conditions, supporting emerging markets.',
        benefits: up ? ['US importers', 'dollar-funded carry'] : ['Commodities broadly', 'Emerging-market assets'], hurt: up ? ['Commodities', 'EM currencies & assets'] : ['US import prices (inflation risk)'],
        up: up ? [] : ['GLD', 'EEM', 'FCX'], down: up ? ['GLD', 'EEM', 'FCX'] : [], segments: ['precious', 'industrial', 'grains', 'softs', 'crude'], regions: ['us'] });
    }
    if (rateChg != null && Math.abs(rateChg) >= 0.15) {
      const up = rateChg > 0;
      add({ id: 'rates', trigger: `US 10-year yield ${up ? '+' : ''}${rateChg.toFixed(2)}pp in a month`,
        chain: up ? 'Rising long yields lift <b>real rates</b> (a direct headwind for precious metals), support the dollar, and pressure long-duration growth and property.' : 'Falling long yields cut <b>real rates</b> (supportive for precious metals), soften the dollar, and help long-duration growth.',
        benefits: up ? ['Banks', 'Value / energy'] : ['Precious metals', 'Long-duration growth', 'Property'], hurt: up ? ['Precious metals', 'Growth & property'] : ['Banks'],
        up: up ? ['XLF'] : ['GDX', 'NEM'], down: up ? ['GDX', 'NEM'] : ['XLF'], segments: ['precious', 'industrial'], regions: ['us'] });
    }
    if (gold1m != null && gold1m > 3 && rateChg != null && rateChg > 0.1) {
      add({ id: 'gold-vs-yields', trigger: `Gold +${gold1m.toFixed(1)}% while 10-year yields also rose ${rateChg.toFixed(2)}pp`,
        chain: 'Gold rising <b>despite</b> higher yields is unusual — it points to <b>demand-driven buying</b> (central banks, safe-haven/geopolitical), not the usual rates channel. Often a bigger, more persistent move.',
        benefits: ['Gold & silver miners', 'Royalty/streamers'], hurt: ['—'], up: ['NEM', 'AEM', 'GDX', 'WPM'], down: [], segments: ['precious'], regions: ['us', 'apac'] });
    }
    if (copper1m != null && copper1m > 5) {
      add({ id: 'copper-growth', trigger: `Copper +${copper1m.toFixed(1)}% in a month`,
        chain: 'Copper is the <b>growth barometer</b> — a sharp rise signals firm industrial demand / stimulus, lifting cyclicals and rate expectations, and (via electrification) supporting grid & EV supply chains.',
        benefits: ['Copper miners', 'Electrification & grid suppliers'], hurt: ['Cost-pressured construction & autos'],
        up: ['FCX', 'SCCO', 'RIO', 'BHP'], down: [], segments: ['industrial', 'precious'], regions: ['apac'] });
    }
    if (corn1m != null && corn1m > 4) {
      add({ id: 'food-inflation', trigger: `Grains +${corn1m.toFixed(1)}% in a month`,
        chain: 'Higher grains feed <b>food inflation</b> (a regressive squeeze on consumers, especially in emerging Asia) while helping farmers, inputs and grain traders.',
        benefits: ['Farm inputs & equipment', 'Grain traders & processors'], hurt: ['Food makers', 'Livestock (feed cost)', 'EM consumers'],
        up: ['DE', 'ADM', 'BG', 'CF'], down: ['TSN', 'KHC'], segments: ['grains', 'softs'], regions: ['apac', 'eu'] });
    }
    return { ideas, signals: { oil1m, oil3m, dxy1m, gold1m, copper1m, corn1m, rateChg, brentShape: curves?.brent?.shape ?? null }, us10y: r10, generated: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------------------
// Analogue / expected-move engine
// ---------------------------------------------------------------------------
async function metricDaily(metric, years) {
  if (metric.startsWith('basis:')) {
    const b = BENCHMARKS.find((x) => x.id === metric.slice(6));
    if (!b || !b.paper) return null;
    const pm = (await cached(`anp:${b.paper}:${years}`, 12 * 3600e3, () => yahooSeries(b.paper, `${years}y`, '1d'))).series;
    const fm = await cached(`anf:${b.physical}:${years}`, 12 * 3600e3, () => spotSeries(b, years * 366));
    const dates = Object.keys(pm).filter((d) => fm[d] != null).sort();
    return { dates, values: dates.map((d) => fm[d] - pm[d]) };
  }
  if (metric === 'spread:brent_wti') {
    const wti = BENCHMARKS.find((x) => x.id === 'wti'), brent = BENCHMARKS.find((x) => x.id === 'brent');
    const wf = await cached(`anf:${wti.physical}:${years}`, 12 * 3600e3, () => spotSeries(wti, years * 366));
    const bf = await cached(`anf:${brent.physical}:${years}`, 12 * 3600e3, () => spotSeries(brent, years * 366));
    const dates = Object.keys(wf).filter((d) => bf[d] != null).sort();
    return { dates, values: dates.map((d) => bf[d] - wf[d]) };
  }
  return null;
}
function summarizeFwd(h, fwds) {
  if (!fwds.length) return { h, n: 0 };
  const s = [...fwds].sort((a, b) => a - b);
  const down = fwds.filter((x) => x < 0).length;
  return {
    h, n: fwds.length,
    median: s[Math.floor(s.length / 2)], mean: fwds.reduce((a, b) => a + b, 0) / fwds.length,
    q25: s[Math.floor(s.length * 0.25)], q75: s[Math.floor(s.length * 0.75)],
    pctDown: (down / fwds.length) * 100, pctUp: ((fwds.length - down) / fwds.length) * 100,
  };
}
async function getAnalogue(metric, years = 10) {
  return cached(`an:${metric}:${years}`, 12 * 3600e3, async () => {
    const series = await metricDaily(metric, years);
    if (!series || series.values.length < 80) return { error: 'insufficient data', metric };
    const { values } = series;
    const cur = values[values.length - 1];
    const sorted = [...values].sort((a, b) => a - b);
    const pctOf = (v) => (sorted.filter((x) => x <= v).length / values.length) * 100;
    const curPct = pctOf(cur);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length);
    const z = sd ? (cur - avg) / sd : 0;
    const analog = [];
    for (let i = 0; i < values.length; i++) if (Math.abs(pctOf(values[i]) - curPct) <= 10) analog.push(i);
    const horizons = [5, 20, 60].map((h) => summarizeFwd(h, analog.filter((i) => i + h < values.length).map((i) => values[i + h] - values[i])));
    const baseline = [5, 20, 60].map((h) => { const f = []; for (let i = 0; i + h < values.length; i++) f.push(values[i + h] - values[i]); return summarizeFwd(h, f); });
    return { metric, years, current: cur, pct: curPct, z, n: values.length, analogN: analog.length, horizons, baseline };
  });
}

// ---------------------------------------------------------------------------
// Physical tightness, mid-east flows, products
// ---------------------------------------------------------------------------
async function getTightness() {
  return cached('tightness', 600_000, async () => {
    const [m, c, inv] = await Promise.all([getMarket(), getCurves().catch(() => null), getInventories().catch(() => null)]);
    const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
    const cracks = computeCracks(m);
    const ev = [];
    const push = (label, value, direction, note) => ev.push({ label, value, direction, note });
    if (c?.brent) push('Oil pricier now than next month', sgn(c.brent.m1m2), c.brent.m1m2 > 0 ? 'TIGHT' : 'LOOSE', c.brent.m1m2 > 0 ? 'buyers paying up for near-term barrels' : 'near-term barrels are cheap');
    if (c?.wti) push('WTI pricier now than next month', sgn(c.wti.m1m2), c.wti.m1m2 > 0 ? 'TIGHT' : 'LOOSE', c.wti.m1m2 > 0 ? 'tight' : 'well supplied');
    if (by.brent?.basis != null) push('Real Brent costs more than futures', sgn(by.brent.basis), by.brent.basis > 0 ? 'TIGHT' : 'LOOSE', by.brent.basis > 0 ? 'real barrels are scarce' : 'real barrels are easy to get');
    if (cracks.diesel != null) push('Diesel refining profit', sgn(cracks.diesel), cracks.diesel > 15 ? 'TIGHT' : 'NEUTRAL', cracks.diesel > 15 ? 'refiners hungry for crude' : 'normal');
    if (inv?.items) { const cr = inv.items.find((i) => i.key === 'crude'); if (cr?.surprise != null) push('US crude vs normal', sgn(cr.surprise), cr.surprise < 0 ? 'TIGHT' : 'LOOSE', cr.surprise < 0 ? 'bigger drop than usual' : 'built up vs usual'); }
    const idle = [...tankers.values()].filter((v) => (v.sog ?? 0) < 1).length;
    if (ais.enabled) push('Oil ships sitting still', String(idle), idle >= 15 ? 'TIGHT' : 'NEUTRAL', idle >= 15 ? 'possible floating storage' : 'normal');
    const flows = await getFlows().catch(() => null);
    if (flows) {
      const gulfDark = flows.dark.some((n) => /Persian|Hormuz|Oman|Arabian|Red Sea/.test(n));
      push('Gulf ships', gulfDark ? 'GONE QUIET' : 'visible', gulfDark ? 'TIGHT' : 'NEUTRAL', gulfDark ? 'trackers switched off → real flows hidden' : 'visible on trackers');
    }
    const tight = ev.filter((e) => e.direction === 'TIGHT').length;
    const loose = ev.filter((e) => e.direction === 'LOOSE').length;
    const verdict = tight > loose
      ? `OIL IS TIGHT — ${tight} of ${ev.length} independent checks agree.`
      : loose > tight ? `OIL IS WELL SUPPLIED — ${loose} of ${ev.length} checks say plenty.`
        : `MIXED — ${tight} say tight, ${loose} say loose.`;
    return { evidence: ev, tight, loose, verdict };
  });
}

const REGIONS = [
  { name: 'Persian Gulf', box: [[24, 48], [30, 57]], me: true },
  { name: 'Strait of Hormuz', box: [[24, 54], [28, 58]], me: true },
  { name: 'Gulf of Oman', box: [[22, 56], [26, 62]], me: true },
  { name: 'Arabian Sea', box: [[8, 55], [22, 72]], me: true },
  { name: 'Red Sea / Suez', box: [[12, 32], [30, 44]], me: true, route: true },
  { name: 'Malacca / Singapore', box: [[-5, 95], [10, 110]], route: true },
  { name: 'Cape of Good Hope', box: [[-40, 10], [-28, 30]], route: true },
  { name: 'US Gulf', box: [[18, -98], [31, -80]], route: true },
];
const FLOW_REGIONS = REGIONS.filter((r) => r.me);
const ROUTE_REGIONS = REGIONS.filter((r) => r.route);
async function getFlows() {
  const list = [...tankers.values()];
  const regions = FLOW_REGIONS.map((r) => ({ name: r.name, count: list.filter((v) => v.lat != null && inBox(v.lat, v.lon, r.box)).length }));
  const exitBox = (v) => inBox(v.lat, v.lon, [[22, 56], [26, 62]]) || inBox(v.lat, v.lon, [[8, 55], [22, 72]]);
  const exit = list.filter((v) => v.lat != null && exitBox(v));
  let east = 0, west = 0;
  for (const v of exit) { if (v.cog == null) continue; if (v.cog >= 0 && v.cog < 180) east++; else west++; }
  const moving = exit.filter((v) => (v.sog ?? 0) >= 1).length;
  const allRates = regionRates();
  const rateOf = (name) => allRates.find((x) => x.name === name)?.perMin ?? 0;
  const rates = allRates.filter((r) => FLOW_REGIONS.some((f) => f.name === r.name));
  const routes = ROUTE_REGIONS.map((r) => ({ name: r.name, count: list.filter((v) => v.lat != null && inBox(v.lat, v.lon, r.box)).length, perMin: rateOf(r.name) }));
  const dark = rates.filter((r) => r.perMin === 0).map((r) => r.name);
  const suez = rateOf('Red Sea / Suez'), cape = rateOf('Cape of Good Hope');
  let diversion = null;
  if (suez === 0 && cape > 0) diversion = 'Red Sea/Suez is dark while the Cape is active → tankers appear to be routing AROUND Africa (dodging the Red Sea).';
  else if (suez > 0 && cape === 0) diversion = 'Red Sea/Suez active, Cape quiet — normal routing.';
  else if (suez === 0 && cape === 0) diversion = 'Both Suez and Cape dark — too little AIS to infer routing.';

  // Market-implied Gulf stress: ships go dark, but prices price the lost barrels.
  let marketStress = null;
  try {
    const [m, c] = await Promise.all([getMarket(), getCurves()]);
    const cracks = computeCracks(m);
    const sig = [
      { label: 'Oil pricier now than 6 months ahead', value: c?.brent?.m1m6, hot: (c?.brent?.m1m6 ?? 0) > 5 },
      { label: 'Diesel refining profit', value: cracks.diesel, hot: (cracks.diesel ?? 0) > 20 },
      { label: 'Brent vs WTI (real)', value: m.spreads?.brent_wti?.physical, hot: (m.spreads?.brent_wti?.physical ?? 0) > 5 },
    ];
    const n = sig.filter((s) => s.hot).length;
    marketStress = { signals: sig, score: n, verdict: n >= 2 ? `Prices are pricing in a serious Gulf supply problem (${n}/3).` : `Prices suggest only mild Gulf stress (${n}/3).` };
  } catch {}

  return { regions, exit: { total: exit.length, eastbound: east, westbound: west, moving, idle: exit.length - moving }, rates, routes, diversion, dark, anomalies: aisAnom, marketStress, enabled: ais.enabled };
}

async function getProducts() {
  return cached('products', 3 * 3600e3, async () => {
    const m = await getMarket();
    const cracks = computeCracks(m);
    const G = 42;
    const [wp, rp, hp] = await Promise.all([
      cached('a2p:CL=F', 6 * 3600e3, () => yahooSeries('CL=F', '2y', '1d')).then((r) => r.series),
      cached('a2p:RB=F', 6 * 3600e3, () => yahooSeries('RB=F', '2y', '1d')).then((r) => r.series),
      cached('a2p:HO=F', 6 * 3600e3, () => yahooSeries('HO=F', '2y', '1d')).then((r) => r.series),
    ]);
    const dates = Object.keys(wp).sort();
    const series = { gasoline: [], diesel: [], c321: [] };
    for (const d of dates) {
      if (wp[d] == null) continue;
      series.gasoline.push(rp[d] != null ? rp[d] * G - wp[d] : null);
      series.diesel.push(hp[d] != null ? hp[d] * G - wp[d] : null);
      series.c321.push(rp[d] != null && hp[d] != null ? ((2 * rp[d] + hp[d]) * G) / 3 - wp[d] : null);
    }
    const last = (arr) => [...arr].reverse().find((x) => x != null);
    const pct = (arr, v) => { const xs = arr.filter((x) => x != null); return xs.length && v != null ? (xs.filter((x) => x <= v).length / xs.length) * 100 : null; };
    return {
      items: [
        { key: 'jet', label: 'Jet fuel', crack: cracks.jetPhys, pct: null, note: 'jet spot ×42 − WTI spot' },
        { key: 'diesel', label: 'Diesel (ULSD)', crack: cracks.diesel, pct: pct(series.diesel, last(series.diesel)), note: 'futures crack' },
        { key: 'gasoline', label: 'Gasoline (RBOB)', crack: cracks.gasoline, pct: pct(series.gasoline, last(series.gasoline)), note: 'futures crack' },
        { key: 'c321', label: '3-2-1 composite', crack: cracks.c321, pct: pct(series.c321, last(series.c321)), note: 'refining margin' },
      ],
      physical: { gasoline: cracks.gasolinePhys, diesel: cracks.dieselPhys, jet: cracks.jetPhys },
      history: { dates: dates.slice(-180), gasoline: series.gasoline.slice(-180), diesel: series.diesel.slice(-180), c321: series.c321.slice(-180) },
    };
  });
}

// Soybean crush — the processor's margin (meal + oil − beans, $/bu) and the oil share, with a
// 2-year history so today's crush can be ranked against its own past. Futures-only (no free spot).
async function getCrush() {
  return cached('crush', 3 * 3600e3, async () => {
    const m = await getMarket();
    const now = computeCrush(m);
    const ser = (sym) => cached('a2p:' + sym, 6 * 3600e3, () => yahooSeries(sym, '2y', '1d')).then((r) => r.series);
    const [zm, zl, zs] = await Promise.all([ser('ZM=F'), ser('ZL=F'), ser('ZS=F')]);
    const dates = Object.keys(zm).sort();
    const hd = [], crush = [], oilShare = [];
    for (const d of dates) {
      if (zm[d] == null || zl[d] == null || zs[d] == null) continue;
      const mv = zm[d] * 0.024, ov = zl[d] * 0.11;
      hd.push(d); crush.push(mv + ov - zs[d] / 100); oilShare.push((ov / (ov + mv)) * 100);
    }
    const pct = (a, v) => { const xs = a.filter((x) => x != null); return xs.length && v != null ? (xs.filter((x) => x <= v).length / xs.length) * 100 : null; };
    const cur = now.crush ?? [...crush].reverse().find((x) => x != null) ?? null;
    const curOil = now.oilShare ?? [...oilShare].reverse().find((x) => x != null) ?? null;
    return {
      label: 'Soybean crush',
      crush: cur, pct: pct(crush, cur),
      oilShare: curOil, oilSharePct: pct(oilShare, curOil),
      legs: { mealValue: now.mealValue ?? null, oilValue: now.oilValue ?? null, beanCost: now.beanCost ?? null },
      history: { dates: hd.slice(-180), crush: crush.slice(-180), oilShare: oilShare.slice(-180) },
    };
  });
}

// ---------------------------------------------------------------------------
// Satellite (AIS-independent): NASA FIRMS gas flares + Sentinel-1 radar passes
// ---------------------------------------------------------------------------
const FLARE_FILE = path.join(__dirname, '.flares.json');
const GULF_FLARE_REGIONS = [
  { name: 'Saudi Arabia', box: [[24, 48], [28, 52]] },
  { name: 'Kuwait', box: [[28.5, 46.5], [30, 48.5]] },
  { name: 'Iraq (Basra)', box: [[29, 46], [31, 49]] },
  { name: 'UAE', box: [[23, 51], [26, 56]] },
  { name: 'Qatar', box: [[24.4, 50.6], [26, 51.8]] },
  { name: 'Iran', box: [[28, 48], [32, 52]] },
];
async function getFlares() {
  return cached('flares', 3 * 3600e3, async () => {
    const res = await fetch('https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv', { headers: UA });
    if (!res.ok) throw new Error('firms ' + res.status);
    const lines = (await res.text()).trim().split('\n');
    const h = lines[0].split(',');
    const iLat = h.indexOf('latitude'), iLon = h.indexOf('longitude');
    const byRegion = {};
    let total = 0;
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const lat = +c[iLat], lon = +c[iLon];
      if (!inBox(lat, lon, [[23, 46], [33, 58]])) continue;
      total++;
      for (const r of GULF_FLARE_REGIONS) if (inBox(lat, lon, r.box)) { byRegion[r.name] = (byRegion[r.name] || 0) + 1; break; }
    }
    const today = new Date().toISOString().slice(0, 10);
    let trend = [];
    try { trend = JSON.parse(fs.readFileSync(FLARE_FILE, 'utf8')); } catch {}
    const ex = trend.find((t) => t.date === today);
    if (ex) ex.count = total; else trend.push({ date: today, count: total });
    trend = trend.slice(-7);
    try { fs.writeFileSync(FLARE_FILE, JSON.stringify(trend)); } catch {}
    return { total, byRegion, trend, updated: new Date().toISOString() };
  });
}

async function getSAR() {
  return cached('sar', 3600e3, async () => {
    const bbox = "POLYGON((54 24,58 24,58 28,54 28,54 24))";
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const enc = (s) => s.replace(/ /g, '%20');
    const filter = enc(`Collection/Name eq 'SENTINEL-1' and ContentDate/Start gt ${since} and OData.CSC.Intersects(area=geography'SRID=4326;${bbox}')`);
    const url = `https://catalogue.dataspace.copernicus.eu/odata/v1/Products?$filter=${filter}&$top=6&$orderby=${enc('ContentDate/Start desc')}&$count=true`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error('cdse ' + res.status);
    const j = await res.json();
    const items = (j.value || []).map((p) => ({ name: p.Name, time: p.ContentDate?.Start, platform: (p.Name || '').slice(0, 3) }));
    // Latest radar image (public AWS bucket, keyless)
    let image = null;
    try {
      const es = await fetch('https://earth-search.aws.element84.com/v1/search', {
        method: 'POST', headers: { ...UA, 'content-type': 'application/json' },
        body: JSON.stringify({ collections: ['sentinel-1-grd'], bbox: [54, 24, 58, 28], limit: 1 }),
      });
      const href = (await es.json()).features?.[0]?.assets?.thumbnail?.href;
      if (href) image = href.replace('s3://sentinel-s1-l1c/', 'https://sentinel-s1-l1c.s3.amazonaws.com/');
    } catch {}
    return { passes: j['@odata.count'] ?? items.length, latest: items[0] || null, recent: items.slice(0, 6), image };
  });
}

let sarImageCache = { t: 0, buf: null, type: null };
async function getSarImage() {
  if (sarImageCache.buf && Date.now() - sarImageCache.t < 3 * 3600e3) return sarImageCache;
  const sar = await getSAR();
  if (!sar.image) return null;
  const res = await fetch(sar.image, { headers: UA });
  if (!res.ok) return null;
  sarImageCache = { t: Date.now(), buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/png' };
  return sarImageCache;
}

// ---------------------------------------------------------------------------
// Live tanker tracking via aisstream.io (free key required)
// ---------------------------------------------------------------------------
const tankers = new Map();
const tankerMMSI = new Set();
const ais = { enabled: false, connected: false, messages: 0, startedAt: null, lastMessage: null, error: null };
const DEFAULT_BOXES = [
  [[18, -98], [31, -80]],   // US Gulf of Mexico
  [[48, -8], [62, 4]],      // North Sea / Rotterdam
  [[-5, 95], [10, 110]],    // Malacca / Singapore
  [[22, 46], [31, 62]],     // Persian Gulf / Hormuz
  [[22, 56], [26, 62]],     // Gulf of Oman
  [[8, 55], [22, 72]],      // Arabian Sea
  [[12, 32], [30, 44]],     // Red Sea / Suez
  [[5, -84], [11, -76]],    // Panama Canal
  [[39, 26], [43, 31]],     // Turkish Straits
  [[-40, 10], [-28, 30]],   // Cape of Good Hope
];

function startAIS() {
  const key = process.env.AISSTREAM_KEY;
  if (!key) { ais.error = 'No AISSTREAM_KEY set — add one (free) to enable live tankers.'; return; }
  ais.enabled = true;
  ais.startedAt ||= new Date().toISOString();
  for (const m of state.tankerMMSI || []) tankerMMSI.add(m); // remember tankers across restarts
  const boxes = process.env.AIS_BOXES ? JSON.parse(process.env.AIS_BOXES) : DEFAULT_BOXES;

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.addEventListener('open', () => {
    ais.connected = true; ais.error = null;
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: boxes, FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }));
    console.log('[ais] connected, subscribed to', boxes.length, 'regions');
  });
  ws.addEventListener('message', async (ev) => {
    let msg;
    try {
      let text = ev.data;
      if (typeof text !== 'string') text = text instanceof Blob ? await text.text() : Buffer.from(text).toString('utf8');
      msg = JSON.parse(text);
    } catch { return; }
    const meta = msg.MetaData || {};
    ais.messages += 1; ais.lastMessage = new Date().toISOString();
    if (msg.MessageType === 'ShipStaticData') {
      const t = msg.Message?.ShipStaticData?.Type;
      if (typeof t === 'number' && t >= 80 && t <= 89) tankerMMSI.add(meta.MMSI);
    } else if (msg.MessageType === 'PositionReport') {
      recordHit(meta.latitude, meta.longitude);
      recordAisAnomaly(meta);
      if (!tankerMMSI.has(meta.MMSI)) return;
      const p = msg.Message?.PositionReport || {};
      tankers.set(meta.MMSI, { mmsi: meta.MMSI, name: (meta.ShipName || '').trim(), lat: meta.latitude, lon: meta.longitude, sog: p.Sog, cog: p.Cog, ts: meta.time_utc });
      if (tankers.size > 6000) tankers.delete(tankers.keys().next().value);
    }
  });
  ws.addEventListener('close', () => { ais.connected = false; console.log('[ais] closed, reconnecting in 5s'); setTimeout(startAIS, 5000); });
  ws.addEventListener('error', (e) => { ais.error = String(e.message || e); });
}

// ---------------------------------------------------------------------------
// Server-side alerts + daily digest (notifications, webhook, email)
// ---------------------------------------------------------------------------
const DIGEST_LOG = path.join(__dirname, 'digest.log');
const STATE_FILE = path.join(__dirname, '.state.json');
const alertSeen = new Map();                 // alert key -> last-notified ms (persisted below)
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const state = loadState();
// Restore the cooldowns so a restart/redeploy doesn't re-fire every alert.
for (const [k, v] of Object.entries(state.alertSeen || {})) alertSeen.set(k, v);
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} };
let lastDigestDate = state.lastDigestDate || null;
let lastDigest = '';
let lastTestAt = 0;

async function computeServerAlerts() {
  const m = await getMarket();
  const a = await getAnalytics().catch(() => null);
  const out = [];
  for (const b of m.benchmarks) {
    const an = a?.benchmarks?.[b.id];
    if (an?.basisPct == null || b.basis == null) continue;
    if (an.basisPct >= 95) out.push({ key: `basis_hi_${b.id}`, level: 'high', text: `${b.label} basis at the ${an.basisPct.toFixed(0)}th percentile — physical dislocation.` });
    else if (an.basisPct <= 5) out.push({ key: `basis_lo_${b.id}`, level: 'med', text: `${b.label} basis at the ${an.basisPct.toFixed(0)}th percentile — unusually weak.` });
  }
  for (const f of m.quality?.flags || []) out.push({ key: 'dq_' + f.text.slice(0, 40), level: 'watch', text: f.text });
  const list = [...tankers.values()];
  const idlers = list.filter((v) => (v.sog ?? 0) < 1).length;
  if (ais.enabled && idlers >= 15) out.push({ key: 'idlers_15', level: 'med', text: `${idlers} tankers sitting idle — possible floating-storage build.` });
  return out;
}

// Delivery outcomes, so the UI can say whether email actually works (and why not).
const notifyStatus = { lastAt: null, lastKind: null, lastOk: null, lastError: null, digestAt: null, digestDate: null };
const mailConfigured = () => Boolean(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.DIGEST_TO);

async function sendEmail(subject, text) {
  if (!mailConfigured()) return notifyStatus.lastError = 'not configured (need SMTP_USER, SMTP_PASS, DIGEST_TO)';
  const port = Number(process.env.SMTP_PORT || 465);
  await sendMail({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== 'false' : port === 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: process.env.DIGEST_TO,
    subject,
    text,
  });
  return true;
}

async function deliver(kind, subject, text) {
  console.log(`[notify:${kind}] ${subject}`);
  notifyStatus.lastAt = new Date().toISOString(); notifyStatus.lastKind = kind;
  try { fs.appendFileSync(DIGEST_LOG, `\n=== ${new Date().toISOString()} [${kind}] ${subject} ===\n${text}\n`); } catch {}
  if (process.platform === 'darwin' && process.env.NOTIFY !== 'off') {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(text.slice(0, 200))} with title ${JSON.stringify(subject)}`], () => {});
  }
  if (process.env.WEBHOOK_URL) {
    const p = webhookPayload(process.env.WEBHOOK_URL, subject, text, process.env.TELEGRAM_CHAT_ID);
    if (/api\.telegram\.org\/bot/i.test(process.env.WEBHOOK_URL) && !process.env.TELEGRAM_CHAT_ID) console.warn('[webhook] TELEGRAM_CHAT_ID is not set — Telegram will reject this');
    fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: p.raw != null ? { 'content-type': 'text/plain; charset=utf-8', ...(p.headers || {}) } : { 'content-type': 'application/json', ...(p.headers || {}) },
      body: p.raw != null ? p.raw : JSON.stringify(p.json),
    }).catch(() => {});
  }
  if (!mailConfigured()) { notifyStatus.lastOk = null; notifyStatus.lastError = 'not configured (need SMTP_USER, SMTP_PASS, DIGEST_TO)'; }
  else {
    try { await sendEmail(subject, text); notifyStatus.lastOk = true; notifyStatus.lastError = null; }
    catch (e) { notifyStatus.lastOk = false; notifyStatus.lastError = e.message; console.error('[mail]', e.message); }
  }
}

async function buildDigest() {
  const m = await getMarket();
  const [c, inv, pos] = await Promise.all([getCurves().catch(() => null), getInventories().catch(() => null), getPositioning().catch(() => null)]);
  const L = [`MARLON'S WATCHTOWER — daily digest (${new Date().toISOString()})`, ''];
  L.push('PRICES  futures | real | gap | age(days)');
  for (const b of m.benchmarks) L.push(`  ${b.label.padEnd(20)} ${(b.paper ?? '—').toString().padStart(9)} | ${(b.physical ?? '—').toString().padStart(9)} | ${(b.basis == null ? '—' : sgn(b.basis)).padStart(8)} | ${b.spotLagDays ?? '—'}`);
  if (c?.wti) L.push('', `PRICES FOR MONTHS AHEAD  WTI ${c.wti.shape} (this-vs-next ${sgn(c.wti.m1m2)}, vs 6mo ${sgn(c.wti.m1m6)})  |  Brent ${c.brent.shape} (this-vs-next ${sgn(c.brent.m1m2)})`);
  if (pos?.latest) L.push('', `HEDGE-FUND BETS  ${pos.label}: ${pos.latest.net.toLocaleString()} (${pos.pct.toFixed(0)}/100 extreme), change this week ${pos.wow >= 0 ? '+' : ''}${pos.wow.toLocaleString()}`);
  if (inv?.items) { L.push('', 'US STOCKPILES (million barrels, this week):'); inv.items.forEach((i) => L.push(`  ${i.label.padEnd(16)} ${i.value.toLocaleString().padStart(10)}  (${i.wow >= 0 ? '+' : ''}${i.wow.toLocaleString()})`)); }
  const alerts = await computeServerAlerts();
  if (alerts.length) { L.push('', 'ALERTS:'); alerts.forEach((x) => L.push(`  [${x.level.toUpperCase()}] ${x.text}`)); }
  L.push('', 'Sources: FRED/EIA, Yahoo, aisstream.io, CFTC. Not investment advice.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// On-screen daily brief — a 60-second "what happened / what's on today" as JSON.
// The raw text digest above stays for email/log; this is what the HOME tab renders.
// ---------------------------------------------------------------------------
async function buildBrief() {
  return cached('brief', 300_000, async () => {
    const [m, h, inv, curves, alerts, pos] = await Promise.all([
      getMarket(),
      getHistory().catch(() => null),
      getInventories().catch(() => null),
      getCurves().catch(() => null),
      computeServerAlerts().catch(() => []),
      getPositioning('wti').catch(() => null),
    ]);
    // Biggest 1-day moves across every instrument's headline series.
    const movers = [];
    for (const b of m.benchmarks) {
      const dd = h?.deltas?.[b.id];
      const d = b.paper != null ? dd?.paper : dd?.physical;
      if (d?.d1 != null) movers.push({ id: b.id, label: b.label, group: b.group, dp: b.dp, d1: d.d1, m1: d.m1 ?? null, y1: d.y1 ?? null });
    }
    movers.sort((a, b) => Math.abs(b.d1) - Math.abs(a.d1));

    const happened = [];
    for (const mv of movers.slice(0, 3)) happened.push({ kind: 'move', id: mv.id, text: `${mv.label} is ${mv.d1 >= 0 ? 'up' : 'down'} <b>${Math.abs(mv.d1).toFixed(1)}%</b> today${mv.y1 != null ? ` — ${Math.abs(mv.y1).toFixed(0)}% ${mv.y1 >= 0 ? 'higher' : 'lower'} over a year` : ''}.` });
    if (curves?.wti) happened.push({ kind: 'curve', id: 'wti', text: `WTI is in <b>${curves.wti.shape.toLowerCase()}</b> — this month ${curves.wti.m1m2 >= 0 ? 'above' : 'below'} next by <b>${sgn(curves.wti.m1m2)}</b>.` });
    const crude = inv?.items?.find((i) => i.key === 'crude');
    if (crude?.surprise != null) happened.push({ kind: 'stocks', id: 'wti', text: `US crude stocks ${crude.wow >= 0 ? 'built' : 'drew'} vs last week — <b>${Math.abs(crude.surprise).toLocaleString()}k bbl ${crude.surprise < 0 ? 'more drawn than usual (bullish)' : 'more built than usual (bearish)'}</b>.` });
    if (pos?.pct3y != null && (pos.pct3y >= 90 || pos.pct3y <= 10)) happened.push({ kind: 'positioning', id: 'wti', text: `Hedge funds are <b>${pos.pct3y >= 90 ? 'crowded long' : 'crowded short'}</b> crude (${pos.pct3y.toFixed(0)}th pctile, CFTC ${pos.latest.date}) — ${pos.pct3y >= 90 ? 'unwind risk' : 'squeeze fuel'}.` });

    const cal = await getCalendar().catch(() => null);
    const next = ((cal && cal.events) || getEvents()).slice(0, 4).map((e) => ({ name: e.name, date: e.date, note: e.note }));
    const hi = alerts.find((a) => a.level === 'high');
    const mv = movers[0];
    const headline = (mv ? `Biggest move: ${mv.label} ${mv.d1 >= 0 ? 'up' : 'down'} ${Math.abs(mv.d1).toFixed(1)}%` : 'Quiet session so far')
      + (hi ? ` · ${hi.text.replace(/\.$/, '')}` : '') + '.';
    return {
      updated: new Date().toISOString(), headline, happened, next,
      alerts: alerts.map((a) => ({ level: a.level, text: a.text })),
      movers: movers.slice(0, 6),
    };
  });
}

// ---------------------------------------------------------------------------
// User alert rules, evaluated server-side so they fire when the app is closed.
// Metrics mirror the client exactly: bench:<id> (price), basis:<id> (real − futures), fx:<id>.
// The endpoints are protected by the optional AUTH_USER/AUTH_PASS login (see /api/rules).
// ---------------------------------------------------------------------------
const RULES_MAX = 20;
async function serverRuleValue(metric) {
  const [kind, id] = String(metric).split(':');
  if (kind === 'bench' || kind === 'basis') {
    const b = (await getMarket()).benchmarks.find((x) => x.id === id);
    if (!b) return null;
    return kind === 'bench' ? (b.paper != null ? b.paper : b.physical) : b.basis;
  }
  if (kind === 'fx') {
    const spec = FX_SYMS.find((x) => x.id === id);
    if (!spec) return null;
    const { price, series } = await cached('q:' + spec.sym, 120e3, () => yahooSeries(spec.sym, '5d', '1d'));
    const dates = Object.keys(series).sort();
    const last = dates.length ? series[dates[dates.length - 1]] : price;
    return last != null ? last : price ?? null;
  }
  return null;
}
async function serverRuleLabel(metric) {
  const [kind, id] = String(metric).split(':');
  if (kind === 'fx') { const f = FX_SYMS.find((x) => x.id === id); return f ? f.label : id; }
  const b = (await getMarket()).benchmarks.find((x) => x.id === id);
  const name = b ? b.label : id;
  return kind === 'basis' ? `${name} gap` : `${name} price`;
}
function validRule(r) {
  if (!r || typeof r !== 'object') return null;
  const op = ['>', '<', 'crosses'].includes(r.op) ? r.op : '>';
  const level = Number(r.level);
  const metric = String(r.metric || '');
  if (!/^(bench|basis|fx):[a-z0-9]+$/.test(metric) || !Number.isFinite(level)) return null;
  return { id: String(r.id || 'r' + Math.random().toString(36).slice(2, 9)).slice(0, 24), metric, op, level, note: String(r.note || '').slice(0, 80), on: r.on !== false };
}
async function evaluateRules() {
  const list = (Array.isArray(state.rules) ? state.rules : []).map(validRule).filter(Boolean);
  const out = [];
  if (!list.length) return out;
  const cooldown = Number(process.env.ALERT_COOLDOWN_H || 12) * 3600e3;
  const now = Date.now();
  state.rulePrev = state.rulePrev || {};
  for (const r of list) {
    const v = await serverRuleValue(r.metric).catch(() => null);
    if (v == null) continue;
    const prev = state.rulePrev[r.id];
    let hit = false;
    if (r.op === '>') hit = v > r.level;
    else if (r.op === '<') hit = v < r.level;
    else hit = prev != null && ((prev < r.level && v >= r.level) || (prev > r.level && v <= r.level));
    state.rulePrev[r.id] = v;
    if (!hit) continue;
    const key = `rule:${r.id}:${r.level}`;
    if (now - (alertSeen.get(key) || 0) < cooldown) continue;
    alertSeen.set(key, now); state.alertSeen = Object.fromEntries(alertSeen);
    const label = await serverRuleLabel(r.metric).catch(() => r.metric);
    out.push({ key, level: 'med', text: `${label} ${r.op === '>' ? 'is above' : r.op === '<' ? 'is below' : 'crossed'} ${r.level}${r.note ? ` — ${r.note}` : ''} (now ${Number(v).toFixed(2)}).` });
  }
  saveState();
  return out;
}

// ---------------------------------------------------------------------------
// Public alert subscriptions — "anyone may receive the alerts".
// Safety rails, in order of importance:
//   1. DOUBLE OPT-IN. Nothing is ever sent to a destination that hasn't confirmed by clicking a link we
//      deliver to that destination — so nobody can sign up somebody else, and your mail account can't be
//      used as an open relay.
//   2. HOST ALLOWLIST. A subscriber supplies a *webhook URL*, which we then POST to — so it must be a
//      known chat host or it's an SSRF lever into the deployment's own network.
//   3. RATE LIMITS + CAP. Per-IP signup limits, a global subscriber cap, and a per-subscriber daily
//      message cap, so a noisy market can't spam somebody's phone on our bill.
//   4. UNSUBSCRIBE in every message (and one click from there).
// Storage is .state.json, which the free tier resets on redeploy/sleep — subscribers may need to
// re-subscribe after a deploy (the UI says so).
// ---------------------------------------------------------------------------
const SUB_CAP = 200;                    // total stored subscriptions (pending + active)
const SUB_PER_IP_PER_HOUR = 5;
const SUB_DAILY_MAX = 20;               // messages to one subscriber per day
const WEBHOOK_ALLOW = [/(^|\.)ntfy\.sh$/i, /^api\.telegram\.org$/i, /(^|\.)discord(app)?\.com$/i, /(^|\.)slack\.com$/i];
const subHits = new Map();              // ip -> [ms]
const isEmail = (v) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(String(v || ''));
function allowedWebhook(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && WEBHOOK_ALLOW.some((rx) => rx.test(x.hostname)); }
  catch { return false; }
}
const maskTarget = (t) => (t.includes('@') ? t.replace(/^(.).*(@.*)$/, '$1***$2') : String(t).replace(/\/([^/]{4})[^/]*$/, '/$1…'));
const subs = () => (Array.isArray(state.subs) ? state.subs : []);
const saveSubs = (a) => { state.subs = a.slice(-SUB_CAP); saveState(); };
const baseUrl = (req) => process.env.RENDER_EXTERNAL_URL || (req && req.headers.host ? `https://${req.headers.host}` : 'https://oil-market-desk.onrender.com');

// One message to one subscriber, in whatever shape their channel wants, with an unsubscribe link.
async function sendToSubscriber(s2, subject, text, req, { footer = true } = {}) {
  const unsub = `${baseUrl(req)}/api/unsubscribe?t=${s2.token}`;
  const body = footer ? `${text}\n\n—\nStop these: ${unsub}` : text;
  if (s2.kind === 'email') { await sendEmail(subject, body); return true; }
  const p = webhookPayload(s2.target, subject, body, process.env.TELEGRAM_CHAT_ID);
  const r = await fetch(s2.target, {
    method: 'POST',
    headers: p.raw != null ? { 'content-type': 'text/plain; charset=utf-8', ...(p.headers || {}) } : { 'content-type': 'application/json', ...(p.headers || {}) },
    body: p.raw != null ? p.raw : JSON.stringify(p.json),
  });
  if (!r.ok) throw new Error(`channel ${r.status}`);
  return true;
}

async function alertLoop() {
  try {
    const cooldown = Number(process.env.ALERT_COOLDOWN_H || 12) * 3600e3;
    const now = Date.now();
    const fresh = [];
    for (const a of await computeServerAlerts()) {
      if (now - (alertSeen.get(a.key) || 0) > cooldown) { alertSeen.set(a.key, now); state.alertSeen = Object.fromEntries(alertSeen); saveState(); fresh.push(a); await deliver('alert', `Marlon's Watchtower · ${a.level.toUpperCase()}`, a.text); }
    }
    // …and the reader's own rules, so they still fire when the tab is closed.
    for (const a of await evaluateRules()) { fresh.push(a); await deliver('alert', `Marlon's Watchtower · ${a.level.toUpperCase()}`, a.text); }
    if (fresh.length) await fanOut(fresh);
  } catch (e) { console.error('[alerts]', e.message); }
}

// The same stream, pushed to every confirmed subscriber (capped per day per person).
async function fanOut(alerts) {
  const list = subs().filter((x) => x.active);
  if (!list.length) return;
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const s2 of list) {
    if (s2.sentDate !== today) { s2.sentDate = today; s2.sent = 0; changed = true; }
    for (const a of alerts) {
      if ((s2.sent || 0) >= SUB_DAILY_MAX) break;
      try { await sendToSubscriber(s2, `Marlon's Watchtower · ${a.level.toUpperCase()}`, a.text); s2.sent = (s2.sent || 0) + 1; changed = true; }
      catch (e) { console.warn('[sub]', maskTarget(s2.target), e.message); }
    }
  }
  if (changed) saveSubs(list);
}

async function maybeSendDigest() {
  try {
    const hr = Number(process.env.DIGEST_HOUR ?? 7);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() >= hr && lastDigestDate !== today) {
      lastDigestDate = today;
      state.lastDigestDate = today; saveState();
      lastDigest = await buildDigest();
      await deliver('digest', "Marlon's Watchtower · daily digest", lastDigest);
      notifyStatus.digestAt = new Date().toISOString(); notifyStatus.digestDate = today;
    }
  } catch (e) { console.error('[digest]', e.message); }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// Build stamp — Render sets RENDER_GIT_COMMIT on every deploy, so "am I on the new build?" is answerable.
const BUILD = (process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || '').slice(0, 7) || 'dev';
// On-the-fly compression with the built-in zlib (no deps). Static files are compressed once per
// file+mtime and cached in memory; JSON is compressed per request when it is worth it.
const zcache = new Map();
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.webmanifest']);
const pickEncoding = (ae) => (/\bbr\b/.test(ae || '') ? 'br' : /\bgzip\b/.test(ae || '') ? 'gzip' : null);
const encodeBuf = (raw, enc) => (enc === 'br'
  ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
  : zlib.gzipSync(raw, { level: 6 }));
const sendJSON = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  const enc = body.length > 1024 ? pickEncoding(res.req && res.req.headers['accept-encoding']) : null;
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (enc) { headers['content-encoding'] = enc; headers.vary = 'Accept-Encoding'; res.writeHead(code, headers); return res.end(encodeBuf(body, enc)); }
  res.writeHead(code, headers);
  res.end(body);
};

// Security headers on every response. The CSP is report-only, so it can never break the app —
// it just watches for drift (a new inline script, CDN, or tile host).
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy-Report-Only': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://server.arcgisonline.com https://tile.openstreetmap.org; connect-src 'self'; font-src 'self' data:; worker-src 'self'; frame-ancestors 'self'",
};
const sendHtml = (res, code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(html); };
// A tiny standalone page for the confirm / unsubscribe links (no JS, no assets).
const htmlPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)} — Marlon's Watchtower</title>
<style>body{margin:0;background:#05070a;color:#c9d4df;font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.b{max-width:560px;background:#0c0f13;border:1px solid #1e2530;padding:22px 24px}h1{font-size:12px;letter-spacing:3px;color:#ff9e00;margin:0 0 14px}
a{color:#ff9e00}b{color:#fff}p{margin:0 0 10px}</style></head>
<body><div class="b"><h1>MARLON'S WATCHTOWER</h1>${body}</div></body></html>`;

// Read a small JSON body (the rules POST is the only route that carries one).
const readJsonBody = (req, limit = 20000) => new Promise((resolve) => {
  let raw = '', n = 0;
  req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); resolve(null); return; } raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw || 'null')); } catch { resolve(null); } });
  req.on('error', () => resolve(null));
});
const server = http.createServer(async (req, res) => {
  for (const k in SECURITY_HEADERS) res.setHeader(k, SECURITY_HEADERS[k]);
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Health check (no auth) for uptime monitors.
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), version: BUILD })); }
  // Optional basic auth — set AUTH_USER + AUTH_PASS to protect a public deployment.
  // The subscription surface stays PUBLIC by design: visitors have no login, and the confirm /
  // unsubscribe links are clicked from a mail client. Those routes protect themselves with a
  // per-destination double opt-in, a host allowlist and per-IP rate limits instead.
  const PUBLIC_PATHS = new Set(['/api/subscribe', '/api/confirm', '/api/unsubscribe']);
  if (process.env.AUTH_USER && process.env.AUTH_PASS && !PUBLIC_PATHS.has(url.pathname)) {
    const hdr = req.headers.authorization || '';
    const ok = hdr.startsWith('Basic ') && Buffer.from(hdr.slice(6), 'base64').toString('utf8') === `${process.env.AUTH_USER}:${process.env.AUTH_PASS}`;
    if (!ok) { res.writeHead(401, { 'www-authenticate': 'Basic realm="oil-market-desk"' }); return res.end('Authentication required'); }
  }
  try {
    // Read-only service — every route is a GET, except the deliberate "send me a test email" POST.
    const notifyTest = req.method === 'POST' && url.pathname === '/api/notify/test';
    const rulesPost = req.method === 'POST' && url.pathname === '/api/rules';
    const subPost = req.method === 'POST' && url.pathname === '/api/subscribe';
    if (req.method !== 'GET' && req.method !== 'HEAD' && !notifyTest && !rulesPost && !subPost) {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
      return res.end('method not allowed');
    }
    if (url.pathname === '/api/market') return sendJSON(res, 200, await getMarket().catch((e) => { console.error('[market]', e.message); return { updated: new Date().toISOString(), benchmarks: [], spreads: {}, quality: { flags: [], curveAvailable: false }, notes: [] }; }));
    if (url.pathname === '/api/history') return sendJSON(res, 200, await getHistory().catch((e) => { console.error('[history]', e.message); return { dates: [], series: {}, basis: {}, spreads: {}, deltas: {} }; }));
    if (url.pathname === '/api/fx') return sendJSON(res, 200, FX_SYMS.map((f) => ({ id: f.id, label: f.label, dp: f.dp })));
    if (url.pathname === '/api/rates') return sendJSON(res, 200, RATES.map((r) => ({ id: r.id, label: r.label, dp: r.dp })));
    if (url.pathname === '/api/markets') return sendJSON(res, 200, getMarkets());
    if (url.pathname === '/api/marketread') {
      const id = url.searchParams.get('id');
      if (!MARKETS.some((x) => x.id === id)) return sendJSON(res, 404, { error: 'unknown market' });
      return sendJSON(res, 200, await getMarketRead(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/marketwhy') {
      const id = url.searchParams.get('id');
      if (!MARKETS.some((x) => x.id === id)) return sendJSON(res, 404, { error: 'unknown market' });
      return sendJSON(res, 200, await getMarketWhy(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/attribution') {
      const id = url.searchParams.get('id');
      if (!MARKETS.some((x) => x.id === id)) return sendJSON(res, 404, { error: 'unknown segment' });
      return sendJSON(res, 200, await getAttribution(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/news') {
      const id = url.searchParams.get('id');
      if (!NEWS_QUERIES[id]) return sendJSON(res, 404, { error: 'unknown segment' });
      return sendJSON(res, 200, await getNews(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message), id, items: [] })));
    }
    if (url.pathname === '/api/transmission') return sendJSON(res, 200, await getTransmission().catch((e) => ({ error: String(e.message), ideas: [] })));
    if (url.pathname === '/api/headlines') return sendJSON(res, 200, await getHeadlines().catch((e) => ({ error: String(e.message), items: [] })));
    if (url.pathname === '/api/macro-news') {
      const id = url.searchParams.get('id');
      if (!NEWS_QUERIES[id]) return sendJSON(res, 404, { error: 'unknown region' });
      return sendJSON(res, 200, await getMacroNews(id).catch((e) => ({ error: String(e.message), items: [] })));
    }
    if (url.pathname === '/api/countries') return sendJSON(res, 200, MACRO_COUNTRIES);
    if (url.pathname === '/api/catalysts') {
      const c = url.searchParams.get('country') || 'us';
      return sendJSON(res, 200, await getCatalysts(c).catch((e) => ({ error: String(e.message), events: [] })));
    }
    if (url.pathname === '/api/macro-tickers') return sendJSON(res, 200, await getMacroTickers().catch((e) => ({ error: String(e.message), items: [] })));
    if (url.pathname === '/api/region-quotes') {
      const id = url.searchParams.get('id');
      if (!MACRO_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown region' });
      return sendJSON(res, 200, await getRegionTickers(id).catch((e) => ({ error: String(e.message), items: [] })));
    }
    if (url.pathname === '/api/yields') {
      const id = url.searchParams.get('id');
      if (!ALL_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown country' });
      return sendJSON(res, 200, await getBondYields(id).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/country-series') {
      const id = url.searchParams.get('id');
      if (!ALL_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown country' });
      return sendJSON(res, 200, await getCountrySeries(id, url.searchParams.get('range') || '1y').catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/country') {
      const id = url.searchParams.get('id');
      if (!ALL_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown country' });
      return sendJSON(res, 200, await getCountry(id).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/fundamentals') {
      const id = url.searchParams.get('id');
      if (!SCAN_QUERIES[id]) return sendJSON(res, 404, { error: 'unknown segment' });
      return sendJSON(res, 200, await getFundamentals(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message), items: [] })));
    }
    if (url.pathname === '/api/movewho') {
      const id = url.searchParams.get('id');
      if (!NEWS_QUERIES[id]) return sendJSON(res, 404, { error: 'unknown segment' });
      const reqs = (url.searchParams.get('dates') || '').split(',').map((s) => { const [date, dir] = s.split(':'); return { date, dir: dir === '1' ? 'up' : 'down' }; }).filter((r) => /^\d{4}-\d{2}(-\d{2})?$/.test(r.date));
      return sendJSON(res, 200, await getMoveWho(id, reqs, url.searchParams.get('focus')).catch((e) => ({ error: String(e.message), results: [] })));
    }
    if (url.pathname === '/api/longterm') {
      const id = url.searchParams.get('id');
      const years = Math.min(15, Math.max(1, Number(url.searchParams.get('years')) || 10));
      if (!resolveMetric(id)) return sendJSON(res, 404, { error: 'unknown metric' });
      return sendJSON(res, 200, await getLongterm(id, years).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/range') {
      const id = url.searchParams.get('id');
      if (!resolveMetric(id)) return sendJSON(res, 404, { error: 'unknown metric' });
      return sendJSON(res, 200, await getRange(id, url.searchParams.get('range') || 'ytd').catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/seasonal') {
      const b = BENCHMARKS.find((x) => x.id === url.searchParams.get('id'));
      if (!b) return sendJSON(res, 404, { error: 'unknown benchmark' });
      return sendJSON(res, 200, await getSeasonal(b).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/reroute') return sendJSON(res, 200, { series: rerouteSeries, current: rerouteSeries[rerouteSeries.length - 1] || null });
    if (url.pathname === '/api/inventories') return sendJSON(res, 200, await getInventories());
    if (url.pathname === '/api/regime') return sendJSON(res, 200, await getRegime().catch((e) => ({ error: String(e.message), rows: [] })));
    if (url.pathname === '/api/screen') return sendJSON(res, 200, await getScreen().catch((e) => ({ error: String(e.message), rows: [] })));
    if (url.pathname === '/api/risk') return sendJSON(res, 200, await getRisk().catch((e) => ({ error: String(e.message), metrics: [], matrix: {} })));
    if (url.pathname === '/api/fxadjusted') return sendJSON(res, 200, await getFxAdjusted(url.searchParams.get('base') || 'USD').catch((e) => ({ error: String(e.message), rows: [] })));
    if (url.pathname === '/api/options') return sendJSON(res, 200, await getOptions(url.searchParams.get('id') || 'wti').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/positioning') {
      const seg = url.searchParams.get('segment');
      const p = seg ? getPositioningSegment(seg) : getPositioning(url.searchParams.get('id') || 'wti');
      return sendJSON(res, 200, await p.catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/equities') return sendJSON(res, 200, await getEquities());
    if (url.pathname === '/api/macro') return sendJSON(res, 200, await getMacro());
    if (url.pathname === '/api/macrodash') return sendJSON(res, 200, await getMacroDash().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/correlations') return sendJSON(res, 200, await getCorrelations().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/events') return sendJSON(res, 200, getEvents());
    if (url.pathname === '/api/calendar') return sendJSON(res, 200, await getCalendar().catch((e) => ({ error: String(e.message), events: [] })));
    if (url.pathname === '/api/chokepoints') return sendJSON(res, 200, getChokepoints());
    if (url.pathname === '/api/curve') return sendJSON(res, 200, await getCurves());
    if (url.pathname === '/api/termstructure') {
      const id = url.searchParams.get('id');
      if (!BENCHMARKS.some((x) => x.id === id)) return sendJSON(res, 404, { error: 'unknown benchmark' });
      return sendJSON(res, 200, await getCurveFor(id).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/curvehistory') return sendJSON(res, 200, await getCurveHistory(url.searchParams.get('root') || 'CL').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/continuous') return sendJSON(res, 200, await getContinuous(url.searchParams.get('root') || 'CL').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/tightness') return sendJSON(res, 200, await getTightness().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/flows') return sendJSON(res, 200, await getFlows());
    if (url.pathname === '/api/products') return sendJSON(res, 200, await getProducts().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/crush') return sendJSON(res, 200, await getCrush().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/flares') return sendJSON(res, 200, await getFlares().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/sar') return sendJSON(res, 200, await getSAR().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/sar/image') {
      const img = await getSarImage().catch(() => null);
      if (!img) { res.writeHead(404).end('no image'); return; }
      res.writeHead(200, { 'content-type': img.type, 'cache-control': 'no-cache' });
      return res.end(img.buf);
    }
    if (url.pathname === '/api/analogue') return sendJSON(res, 200, await getAnalogue(url.searchParams.get('metric') || 'basis:brent', Math.min(15, Math.max(2, Number(url.searchParams.get('years')) || 10))));
    if (url.pathname === '/api/alerts') return sendJSON(res, 200, { current: await computeServerAlerts().catch(() => []) });
    if (url.pathname === '/api/digest') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(lastDigest || await buildDigest()); }
    if (url.pathname === '/api/rules') {
      // Server-side rules are site-wide (there is no per-user model), so they are only writable — and
      // only readable — when the deployment has a login. Reaching here means the auth check above passed.
      if (!process.env.AUTH_USER || !process.env.AUTH_PASS) {
        return sendJSON(res, 401, { error: 'server rules need the login enabled — set AUTH_USER and AUTH_PASS' });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const raw = Array.isArray(body) ? body : (body && Array.isArray(body.rules) ? body.rules : null);
        if (!raw) return sendJSON(res, 400, { error: 'expected a JSON array of rules' });
        const rules = raw.slice(0, RULES_MAX).map(validRule).filter(Boolean);
        state.rules = rules; saveState();
        return sendJSON(res, 200, { ok: true, count: rules.length });
      }
      return sendJSON(res, 200, { rules: Array.isArray(state.rules) ? state.rules : [], authRequired: true });
    }
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const b = await readJsonBody(req);
      const target = String((b && b.target) || '').trim().slice(0, 300);
      const kind = isEmail(target) ? 'email' : (allowedWebhook(target) ? 'webhook' : null);
      if (!kind) return sendJSON(res, 400, { error: 'Enter an email address, or a https chat-webhook URL from ntfy.sh, api.telegram.org, discord.com or slack.com.' });
      if (kind === 'email' && !mailConfigured()) return sendJSON(res, 503, { error: 'This deployment has no email set up yet — use a chat webhook instead (an ntfy.sh topic is the easiest).' });
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
      const now = Date.now();
      const hits = (subHits.get(ip) || []).filter((t) => now - t < 3600e3);
      if (hits.length >= SUB_PER_IP_PER_HOUR) return sendJSON(res, 429, { error: 'Too many sign-ups from this network — please try again later.' });
      const list = subs();
      const existing = list.find((x) => x.target === target);
      if (existing && existing.active) return sendJSON(res, 200, { ok: true, already: true, message: 'That destination is already subscribed.' });
      if (!existing && list.length >= SUB_CAP) return sendJSON(res, 503, { error: 'The subscriber limit for this free deployment has been reached.' });
      hits.push(now); subHits.set(ip, hits);
      const rec = existing || { id: 's' + crypto.randomBytes(4).toString('hex'), target, kind, token: crypto.randomBytes(18).toString('base64url'), active: false, createdAt: new Date().toISOString(), sent: 0, sentDate: null };
      try {
        await sendToSubscriber(rec, "Marlon's Watchtower · confirm your alerts",
          `You (or someone using this address) asked for commodity alerts from Marlon's Watchtower.\n\nConfirm: ${baseUrl(req)}/api/confirm?t=${rec.token}`, req, { footer: false });
      } catch (e) {
        return sendJSON(res, 502, { error: `Couldn’t reach that destination (${String(e.message).slice(0, 60)}). Check the address and try again.` });
      }
      saveSubs([...list.filter((x) => x.target !== target), rec]);
      return sendJSON(res, 200, { ok: true, pending: true, kind, to: maskTarget(target) });
    }
    if (url.pathname === '/api/confirm' || url.pathname === '/api/unsubscribe') {
      const t = url.searchParams.get('t') || '';
      const list = subs();
      const rec = list.find((x) => x.token === t);
      if (!rec) return sendHtml(res, 404, htmlPage('Link expired', '<p>That link is no longer valid — subscribe again from the dashboard.</p>'));
      if (url.pathname === '/api/confirm') {
        rec.active = true; rec.confirmedAt = new Date().toISOString();
        saveSubs(list);
        return sendHtml(res, 200, htmlPage('You’re subscribed', `<p>Alerts will arrive at <b>${escHtml(maskTarget(rec.target))}</b> whenever the market moves.</p><p><a href="${baseUrl(req)}">Back to the dashboard</a> · <a href="${baseUrl(req)}/api/unsubscribe?t=${rec.token}">Unsubscribe</a></p>`));
      }
      saveSubs(list.filter((x) => x.token !== t));
      return sendHtml(res, 200, htmlPage('Unsubscribed', `<p>Done — no more alerts will be sent to <b>${escHtml(maskTarget(rec.target))}</b>.</p><p><a href="${baseUrl(req)}">Back to the dashboard</a></p>`));
    }
    if (url.pathname === '/api/notify') {
      const mask = (a) => (a && a.includes('@') ? a.replace(/^(.).*(@.*)$/, '$1***$2') : a || null);
      return sendJSON(res, 200, {
        email: { configured: mailConfigured(), to: mask(process.env.DIGEST_TO), host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465) },
        webhook: Boolean(process.env.WEBHOOK_URL),
        desktop: process.platform === 'darwin' && process.env.NOTIFY !== 'off',
        digest: { hour: Number(process.env.DIGEST_HOUR ?? 7), lastDate: notifyStatus.digestDate || state.lastDigestDate || null, lastAt: notifyStatus.digestAt },
        last: { at: notifyStatus.lastAt, kind: notifyStatus.lastKind, ok: notifyStatus.lastOk, error: notifyStatus.lastError },
        alerts: { muted: alertSeen.size },
        serverRules: { enabled: Boolean(process.env.AUTH_USER && process.env.AUTH_PASS), count: Array.isArray(state.rules) ? state.rules.length : 0 },
        subscribers: { active: subs().filter((x) => x.active).length, pending: subs().filter((x) => !x.active).length, cap: SUB_CAP },
      });
    }
    if (url.pathname === '/api/notify/test' && req.method === 'POST') {
      // One test per minute — this endpoint is reachable without auth on a default deployment.
      const since = Date.now() - (lastTestAt || 0);
      if (since < 60_000) return sendJSON(res, 429, { error: `slow down — try again in ${Math.ceil((60_000 - since) / 1000)}s` });
      lastTestAt = Date.now();
      const body = `This is a test from Marlon's Watchtower.\n\nIf you're reading it, alert + digest delivery works.\nChannels: ${[mailConfigured() && 'email', process.env.WEBHOOK_URL && 'webhook', process.platform === 'darwin' && process.env.NOTIFY !== 'off' && 'desktop'].filter(Boolean).join(', ') || 'none configured'}.`;
      await deliver('test', "Marlon's Watchtower · test message", body);
      return sendJSON(res, 200, { ok: notifyStatus.lastOk, error: notifyStatus.lastError, channels: { email: mailConfigured(), webhook: Boolean(process.env.WEBHOOK_URL) } });
    }
    if (url.pathname === '/api/brief') return sendJSON(res, 200, await buildBrief().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/analytics') return sendJSON(res, 200, await getAnalytics(Number(url.searchParams.get('freight')) || FREIGHT_DEFAULT).catch((e) => { console.error('[analytics]', e.message); return { benchmarks: {} }; }));
    if (url.pathname === '/api/export.csv') {
      const [m, a] = await Promise.all([getMarket(), getAnalytics()]);
      const rows = [['benchmark', 'unit', 'paper', 'physical', 'physical_date', 'basis', 'basis_pctile_2y', 'vol30_ann_pct']];
      for (const b of m.benchmarks) {
        const an = a.benchmarks[b.id] || {};
        rows.push([b.label, b.unit, b.paper ?? '', b.physical ?? '', b.physicalDate ?? '', b.basis ?? '', an.basisPct != null ? an.basisPct.toFixed(1) : '', an.vol30 != null ? an.vol30.toFixed(1) : '']);
      }
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="oil-basis.csv"' });
      return res.end(rows.map((r) => r.join(',')).join('\n'));
    }
    if (url.pathname === '/api/tankers') {
      const list = [...tankers.values()];
      return sendJSON(res, 200, { status: ais, count: list.length, tankers: list.slice(0, 2000) });
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    let st = null;
    try { st = fs.statSync(full); } catch {}
    if (!full.startsWith(PUBLIC) || !st || st.isDirectory()) {
      const nf = path.join(PUBLIC, '404.html');
      res.writeHead(404, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
      if (fs.existsSync(nf)) return fs.createReadStream(nf).pipe(res);
      return res.end('not found');
    }
    const ext = path.extname(full);
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' };
    const enc = st.size > 1024 && COMPRESSIBLE.has(ext) ? pickEncoding(req.headers['accept-encoding']) : null;
    if (enc) {
      const key = full + ':' + st.mtimeMs + ':' + enc;
      let buf = zcache.get(key);
      if (!buf) { buf = encodeBuf(fs.readFileSync(full), enc); if (zcache.size > 80) zcache.clear(); zcache.set(key, buf); }
      headers['content-encoding'] = enc; headers.vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      return res.end(buf);
    }
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  🛢️  Marlon's Watchtower running at  http://localhost:${PORT}`);
  console.log(`     ${BENCHMARKS.length} benchmarks: ${BENCHMARKS.map((b) => b.label).join(', ')}`);
  console.log(`     tankers: ${process.env.AISSTREAM_KEY ? 'aisstream.io' : 'disabled (set AISSTREAM_KEY)'}`);
  console.log(`     alerts:  ${[process.env.WEBHOOK_URL && 'webhook', process.env.SMTP_USER && 'email', process.platform === 'darwin' && process.env.NOTIFY !== 'off' && 'desktop'].filter(Boolean).join(', ') || 'desktop'}`);
  console.log(`     digest:  ${process.env.DIGEST_HOUR ?? 7}:00 daily → ${process.env.DIGEST_TO || process.env.WEBHOOK_URL || 'desktop + digest.log'}\n`);
  startAIS();
  setTimeout(alertLoop, 12_000);
  setInterval(alertLoop, 5 * 60_000);
  setInterval(maybeSendDigest, 60_000);
  setInterval(() => { state.tankerMMSI = [...tankerMMSI]; saveState(); }, 60_000);
  setTimeout(() => { state.tankerMMSI = [...tankerMMSI]; saveState(); snapshotReroute(); }, 90_000);
  setInterval(snapshotReroute, 5 * 60_000);
  // Warm every segment's READ + curve in the background so switching segments is instant for the
  // user (a cold read is ~1.5s; warm it is ~1ms). Started after the first paint settles, gently
  // staggered; `cached()` de-dupes so a user request during warm-up just shares the work.
  // Warm the boot-critical caches early so a visitor right after a deploy still loads fast:
  // base feeds → CFTC positioning (parallel) → boards → the 9 segment reads → the screener.
  const warmCaches = async () => {
    try { await Promise.all([getMarket(), getHistory(), getAnalytics()]); } catch {}
    try { await Promise.all(BENCHMARKS.filter((b) => COT_NAMES[b.id]).map((b) => getPositioning(b.id).catch(() => {}))); } catch {}
    try { await Promise.all([getRegime(), getCalendar()]); } catch {}
    for (const m of MARKETS) { try { await getMarketRead(m.id, null); } catch {} await new Promise((r) => setTimeout(r, 300)); }
    try { await getScreen(); } catch {}
  };
  setTimeout(() => warmCaches().catch(() => {}), 800);
  setInterval(() => warmCaches().catch(() => {}), 8 * 60_000);
  // FIRMS active-fire CSV (~25s) and the SAR image are slow upstreams that are only needed deep in
  // COMMODITIES. Warm them well after boot so they never compete with the first paint — and so the
  // first reader to open SHIPS & SATELLITES doesn't wait 25s.
  const warmSlow = async () => { try { await getFlares(); } catch {} try { await getSAR(); } catch {} };
  // WARM=off (the test suite) skips the background warmers: they fetch 25s third-party feeds and would
  // compete with whatever the caller is actually measuring.
  if (process.env.WARM !== 'off') {
    setTimeout(() => warmSlow().catch(() => {}), 90_000);
    setInterval(() => warmSlow().catch(() => {}), 3 * 3600e3);
  }
});
