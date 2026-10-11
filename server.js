// Oil Basis — paper vs physical spreads across energy benchmarks + live tankers.
// Zero runtime dependencies: Node's built-in HTTP, fetch and WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const UA = { 'User-Agent': 'Mozilla/5.0 (oil-basis)' };

// ---------------------------------------------------------------------------
// Benchmark registry
//   paper    = futures    -> Yahoo Finance symbol
//   physical = spot/cash  -> FRED / EIA series id
// Add a row to add a benchmark (both feeds must exist for free).
// ---------------------------------------------------------------------------
const BENCHMARKS = [
  { id: 'wti',    label: 'WTI (Cushing)',   group: 'Crude',   unit: '$/bbl',   dp: 2, paper: 'CL=F', physical: 'DCOILWTICO', source: 'fred' },
  { id: 'brent',  label: 'Brent',           group: 'Crude',   unit: '$/bbl',   dp: 2, paper: 'BZ=F', physical: 'DCOILBRENTEU', source: 'fred' },
  { id: 'rbob',   label: 'RBOB Gasoline',   group: 'Refined', unit: '$/gal',   dp: 3, paper: 'RB=F', physical: 'DGASUSGULF', source: 'fred' },
  { id: 'ulsd',   label: 'ULSD / Heating',  group: 'Refined', unit: '$/gal',   dp: 3, paper: 'HO=F', physical: 'DHOILNYH', source: 'fred' },
  { id: 'jet',    label: 'Jet Fuel (USGC)', group: 'Refined', unit: '$/gal',   dp: 3, paper: null,   physical: 'EER_EPJK_PF4_RGC_DPG', source: 'eia' },
  { id: 'propane',label: 'Propane (Mt Belvieu)', group: 'Refined', unit: '$/gal', dp: 3, paper: null, physical: 'EER_EPLLPA_PF4_Y44MB_DPG', source: 'eia' },
  { id: 'natgas', label: 'Natural Gas',     group: 'Gas',     unit: '$/MMBtu', dp: 2, paper: 'NG=F', physical: 'DHHNGSP', source: 'fred' },
];

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
  return { symbol, price: r.meta.regularMarketPrice, series };
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

const spotSeries = (b, days) => (b.source === 'eia' ? eiaSeries(b.physical, days) : fredSeries(b.physical, days));

const lastEntry = (obj) => {
  const dates = Object.keys(obj).sort();
  const d = dates[dates.length - 1];
  return { date: d || null, value: d ? obj[d] : null };
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

const paperFor = (b) => (b.paper ? cached('p:' + b.paper, 45_000, () => yahooSeries(b.paper, '5d', '1d')) : Promise.resolve({ price: null }));
const physFor = (b) => cached('f:' + b.physical, 3_600_000, () => spotSeries(b, 14));
const hPaperFor = (b) => (b.paper ? cached('hp:' + b.paper, 3_600_000, () => yahooSeries(b.paper, '6mo', '1d')) : Promise.resolve({ series: {} }));
const hPhysFor = (b) => cached('hf:' + b.physical, 3_600_000, () => spotSeries(b, 220));

// ---------------------------------------------------------------------------
// Market snapshot
// ---------------------------------------------------------------------------
const sgn = (x, dp = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(dp));
function businessDaysSince(d) {
  if (!d) return null;
  let n = 0;
  const cur = new Date(d + 'T00:00:00Z');
  const now = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  while (cur < now) { cur.setUTCDate(cur.getUTCDate() + 1); const wd = cur.getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
  return n;
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
    return {
      id: b.id, label: b.label, group: b.group, unit: b.unit, dp: b.dp,
      paper, physical, physicalDate: last,
      basis: paper != null && physical != null ? physical - paper : null,
      spotLagDays: businessDaysSince(last),
      spotJumpPct: physical != null && prevPhys ? ((physical - prevPhys) / prevPhys) * 100 : null,
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
  if (lagged.length) flags.push({ level: 'watch', text: `All physical spot series are ~${Math.max(...lagged.map((r) => r.spotLagDays))} business days stale (as of ${lagged[0].physicalDate}) while futures are live — the cash–futures basis may be distorted.` });
  for (const r of rows) {
    if (r.spotJumpPct != null && Math.abs(r.spotJumpPct) >= 8) flags.push({ level: 'watch', text: `${r.label}: spot swung ${sgn(r.spotJumpPct, 1)}% in a single day — verify the print.` });
  }
  for (const id of ['wti', 'brent']) {
    const r = by[id]; const c = curves?.[id];
    if (r && c && c.m1m2 != null && r.basis != null) {
      const ratio = Math.abs(r.basis) / (Math.abs(c.m1m2) || 1);
      if (ratio > 3) flags.push({ level: 'watch', text: `${r.label}: cash–futures basis ${sgn(r.basis)} is ~${ratio.toFixed(0)}× the curve slope (M1−M2 ${sgn(c.m1m2)}) — likely an instrument/timing mismatch, NOT corroborated by the curve.` });
    }
  }
  return {
    updated: new Date().toISOString(),
    benchmarks: rows,
    spreads,
    quality: { flags, curveAvailable: Boolean(curves) },
    notes: [
      'Paper = front-month futures (live). Physical = spot/cash assessment (EIA), which LAGS and is a different instrument — read the basis with the data-quality flags.',
      'Propane & jet fuel are spot-only — no free exchange futures.',
      'Basis = physical − paper. Positive = physical premium (backwardation pressure).',
      'The futures series is the front-month continuous (not roll-adjusted); the CURVE (M1−M2 / M1−M6) is the roll-free structure signal.',
      'Dubai / WTI Midland / Mars require a paid feed.',
    ],
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function getHistory() {
  const maps = {};
  await Promise.all(BENCHMARKS.map(async (b) => {
    const [p, f] = await Promise.all([hPaperFor(b), hPhysFor(b)]);
    maps[b.id] = { paper: p.series, physical: f };
  }));

  const allDates = new Set();
  for (const b of BENCHMARKS) {
    Object.keys(maps[b.id].paper).forEach((d) => allDates.add(d));
    Object.keys(maps[b.id].physical).forEach((d) => allDates.add(d));
  }
  const dates = [...allDates].sort().slice(-120);
  const at = (o, d) => (o[d] != null ? o[d] : null);

  const series = {};
  const basis = {};
  for (const b of BENCHMARKS) {
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

  return { dates, series, basis, spreads };
}

// ---------------------------------------------------------------------------
// Long-term (multi-year) history, bucketed by month, with % performance
// ---------------------------------------------------------------------------
function monthly(map) {
  const out = {};
  for (const d of Object.keys(map).sort()) out[d.slice(0, 7)] = map[d];
  return out;
}

function pctOver(arr, n) {
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

async function getLongterm(b, years = 10) {
  const interval = years >= 3 ? '1mo' : '1wk';
  const paperMap = b.paper
    ? (await cached(`ltp:${b.paper}:${years}`, 6 * 3600e3, () => yahooSeries(b.paper, `${years}y`, interval))).series
    : {};
  const physRaw = await cached(`ltf:${b.physical}:${years}`, 6 * 3600e3, () => spotSeries(b, years * 366 + 30));
  const p = monthly(paperMap);
  const f = monthly(physRaw);
  const months = [...new Set([...Object.keys(p), ...Object.keys(f)])].sort();
  const at = (o, m) => (o[m] != null ? o[m] : null);
  const series = { paper: months.map((m) => at(p, m)), physical: months.map((m) => at(f, m)) };
  const summ = (arr) => ({ total: pctOver(arr, arr.length), last5y: pctOver(arr, 60), last1y: pctOver(arr, 12) });
  return {
    id: b.id, label: b.label, unit: b.unit, dp: b.dp, years, months, series,
    summary: { paper: summ(series.paper), physical: summ(series.physical) },
  };
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
function isoWeek(d) {
  const date = new Date(d + 'T00:00:00Z');
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  return 1 + Math.round((date - firstThu) / (7 * 864e5));
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
      const sameWeek = wows.filter((w) => isoWeek(w.period) === targetWk);
      const seasonal = sameWeek.length >= 3 ? sameWeek.reduce((a, b) => a + b.wow, 0) / sameWeek.length : null;
      const wow = prev ? last.value - prev.value : null;
      items.push({
        key: k, label: INV_SERIES[k].label, period: last.period, value: last.value,
        wow, chg4: wk4 ? last.value - wk4.value : null,
        seasonal: seasonal != null ? Math.round(seasonal) : null,
        surprise: seasonal != null && wow != null ? Math.round(wow - seasonal) : null,
        years: sameWeek.length,
      });
    }
    return { items, fetched: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------------------
// CFTC positioning (WTI managed money / non-commercial net)
// ---------------------------------------------------------------------------
async function getPositioning() {
  return cached('positioning', 6 * 3600e3, async () => {
    const where = "contract_market_name='CRUDE OIL, LIGHT SWEET-WTI'";
    const url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$limit=220&$order=report_date_as_yyyy_mm_dd%20DESC&$where=${encodeURIComponent(where)}`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error('cftc ' + res.status);
    const rows = (await res.json()).map((r) => ({
      date: (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
      net: (Number(r.noncomm_positions_long_all) || 0) - (Number(r.noncomm_positions_short_all) || 0),
    })).reverse();
    if (!rows.length) return { error: 'no data' };
    const latest = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const nets = rows.map((r) => r.net);
    return {
      label: 'WTI spec net (non-comm)', unit: 'contracts',
      latest, wow: prev ? latest.net - prev.net : null,
      pct: (nets.filter((n) => n <= latest.net).length / nets.length) * 100,
      history: rows.slice(-156),
    };
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
const inBox = (lat, lon, box) => { const [[a, b], [c, d]] = box; return lat >= Math.min(a, c) && lat <= Math.max(a, c) && lon >= Math.min(b, d) && lon <= Math.max(b, d); };
function getChokepoints() {
  const list = [...tankers.values()];
  return { chokepoints: CHOKEPOINTS.map((c) => ({ name: c.name, count: list.filter((v) => v.lat != null && inBox(v.lat, v.lon, c.box)).length })) };
}

// ---------------------------------------------------------------------------
// Analytics: percentile context + realised volatility + freight arb
// ---------------------------------------------------------------------------
const percentile = (arr, v) => { const xs = arr.filter((x) => x != null); return xs.length ? (xs.filter((x) => x <= v).length / xs.length) * 100 : null; };
function realizedVol(arr, win = 30) {
  const xs = arr.filter((x) => x != null);
  if (xs.length < win + 1) return null;
  const r = [];
  for (let i = xs.length - win; i < xs.length; i++) r.push(Math.log(xs[i] / xs[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const varp = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(varp) * Math.sqrt(252) * 100;
}
const FREIGHT_DEFAULT = 2.0; // $/bbl USGC -> NW Europe estimate
async function getAnalytics(freight = FREIGHT_DEFAULT) {
  return cached('analytics:' + freight, 6 * 3600e3, async () => {
    const twoYear = {};
    for (const b of BENCHMARKS) {
      const paperMap = (await cached(`a2p:${b.paper || b.id}`, 6 * 3600e3, () => (b.paper ? yahooSeries(b.paper, '2y', '1d') : Promise.resolve({ series: {} })))).series;
      const physMap = await cached(`a2f:${b.physical}`, 6 * 3600e3, () => spotSeries(b, 740));
      twoYear[b.id] = { paperMap, physMap };
    }
    const benchmarks = {};
    for (const b of BENCHMARKS) {
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
async function curveFor(root) {
  const now = new Date();
  const out = [];
  for (let k = 0; k < 14; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    const symbol = `${root}${MONTH_CODE[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}.NYM`;
    try {
      const q = await cached('cur:' + symbol, 300_000, () => yahooSeries(symbol, '5d', '1d'));
      if (q.price != null) out.push({ label: symbol.slice(root.length, root.length + 3), price: q.price });
    } catch {}
  }
  return out;
}
async function getCurves() {
  return cached('curves', 120_000, async () => {
    const build = (c) => {
      if (c.length < 2) return { contracts: c };
      return {
        contracts: c,
        m1m2: c[0].price - c[1].price,
        m1m6: c.length > 5 ? c[0].price - c[5].price : null,
        m1m12: c.length > 11 ? c[0].price - c[11].price : null,
        shape: c[0].price >= c[1].price ? 'Backwardation' : 'Contango',
        rollYieldAnn: c[1].price ? Math.log(c[0].price / c[1].price) * 12 * 100 : null,
      };
    };
    const [wti, brent] = await Promise.all([curveFor('CL'), curveFor('BZ')]);
    return { wti: build(wti), brent: build(brent) };
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
  [[12, 32], [30, 44]],     // Red Sea / Suez
  [[5, -84], [11, -76]],    // Panama Canal
  [[53, 8], [59, 14]],      // Danish Straits
  [[39, 26], [43, 31]],     // Turkish Straits
];

function startAIS() {
  const key = process.env.AISSTREAM_KEY;
  if (!key) { ais.error = 'No AISSTREAM_KEY set — add one (free) to enable live tankers.'; return; }
  ais.enabled = true;
  ais.startedAt ||= new Date().toISOString();
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
const alertSeen = new Map();
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const savedState = loadState();
let lastDigestDate = savedState.lastDigestDate || null;
let lastDigest = '';

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

async function sendEmail(subject, text) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.DIGEST_TO) return false;
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; } catch { console.log('[mail] nodemailer not installed — run: npm i nodemailer'); return false; }
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465), secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({ from: process.env.SMTP_USER, to: process.env.DIGEST_TO, subject, text });
  return true;
}

async function deliver(kind, subject, text) {
  console.log(`[notify:${kind}] ${subject}`);
  try { fs.appendFileSync(DIGEST_LOG, `\n=== ${new Date().toISOString()} [${kind}] ${subject} ===\n${text}\n`); } catch {}
  if (process.platform === 'darwin' && process.env.NOTIFY !== 'off') {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(text.slice(0, 200))} with title ${JSON.stringify(subject)}`], () => {});
  }
  if (process.env.WEBHOOK_URL) {
    fetch(process.env.WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject, text }) }).catch(() => {});
  }
  await sendEmail(subject, text).catch((e) => console.error('[mail]', e.message));
}

async function buildDigest() {
  const m = await getMarket();
  const [c, inv, pos] = await Promise.all([getCurves().catch(() => null), getInventories().catch(() => null), getPositioning().catch(() => null)]);
  const L = [`OIL BASIS — daily digest (${new Date().toISOString()})`, ''];
  L.push('BENCHMARKS  paper | physical | basis | spot-lag(bd)');
  for (const b of m.benchmarks) L.push(`  ${b.label.padEnd(20)} ${(b.paper ?? '—').toString().padStart(9)} | ${(b.physical ?? '—').toString().padStart(9)} | ${(b.basis == null ? '—' : sgn(b.basis)).padStart(8)} | ${b.spotLagDays ?? '—'}`);
  if (c?.wti) L.push('', `CURVE  WTI ${c.wti.shape} (M1−M2 ${sgn(c.wti.m1m2)}, M1−M6 ${sgn(c.wti.m1m6)})  |  Brent ${c.brent.shape} (M1−M2 ${sgn(c.brent.m1m2)})`);
  if (pos?.latest) L.push('', `POSITIONING  ${pos.label}: ${pos.latest.net.toLocaleString()} (${pos.pct.toFixed(0)}th pct), WoW ${pos.wow >= 0 ? '+' : ''}${pos.wow.toLocaleString()}`);
  if (inv?.items) { L.push('', 'INVENTORIES (Mbbl, WoW):'); inv.items.forEach((i) => L.push(`  ${i.label.padEnd(16)} ${i.value.toLocaleString().padStart(10)}  (${i.wow >= 0 ? '+' : ''}${i.wow.toLocaleString()})`)); }
  const alerts = await computeServerAlerts();
  if (alerts.length) { L.push('', 'ALERTS:'); alerts.forEach((x) => L.push(`  [${x.level.toUpperCase()}] ${x.text}`)); }
  L.push('', 'Sources: FRED/EIA, Yahoo, aisstream.io, CFTC. Not investment advice.');
  return L.join('\n');
}

async function alertLoop() {
  try {
    const cooldown = Number(process.env.ALERT_COOLDOWN_H || 12) * 3600e3;
    const now = Date.now();
    for (const a of await computeServerAlerts()) {
      if (now - (alertSeen.get(a.key) || 0) > cooldown) { alertSeen.set(a.key, now); await deliver('alert', `Oil Basis · ${a.level.toUpperCase()}`, a.text); }
    }
  } catch (e) { console.error('[alerts]', e.message); }
}

async function maybeSendDigest() {
  try {
    const hr = Number(process.env.DIGEST_HOUR ?? 7);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() >= hr && lastDigestDate !== today) {
      lastDigestDate = today;
      try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lastDigestDate })); } catch {}
      lastDigest = await buildDigest();
      await deliver('digest', 'Oil Basis · daily digest', lastDigest);
    }
  } catch (e) { console.error('[digest]', e.message); }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const sendJSON = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/market') return sendJSON(res, 200, await getMarket());
    if (url.pathname === '/api/history') return sendJSON(res, 200, await getHistory());
    if (url.pathname === '/api/longterm') {
      const id = url.searchParams.get('id');
      const years = Math.min(15, Math.max(1, Number(url.searchParams.get('years')) || 10));
      const b = BENCHMARKS.find((x) => x.id === id);
      if (!b) return sendJSON(res, 404, { error: 'unknown benchmark' });
      return sendJSON(res, 200, await getLongterm(b, years));
    }
    if (url.pathname === '/api/inventories') return sendJSON(res, 200, await getInventories());
    if (url.pathname === '/api/positioning') return sendJSON(res, 200, await getPositioning());
    if (url.pathname === '/api/equities') return sendJSON(res, 200, await getEquities());
    if (url.pathname === '/api/chokepoints') return sendJSON(res, 200, getChokepoints());
    if (url.pathname === '/api/curve') return sendJSON(res, 200, await getCurves());
    if (url.pathname === '/api/analogue') return sendJSON(res, 200, await getAnalogue(url.searchParams.get('metric') || 'basis:brent', Math.min(15, Math.max(2, Number(url.searchParams.get('years')) || 10))));
    if (url.pathname === '/api/alerts') return sendJSON(res, 200, { current: await computeServerAlerts().catch(() => []) });
    if (url.pathname === '/api/digest') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(lastDigest || await buildDigest()); }
    if (url.pathname === '/api/analytics') return sendJSON(res, 200, await getAnalytics(Number(url.searchParams.get('freight')) || FREIGHT_DEFAULT));
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
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  🛢️  Oil Basis running at  http://localhost:${PORT}`);
  console.log(`     ${BENCHMARKS.length} benchmarks: ${BENCHMARKS.map((b) => b.label).join(', ')}`);
  console.log(`     tankers: ${process.env.AISSTREAM_KEY ? 'aisstream.io' : 'disabled (set AISSTREAM_KEY)'}`);
  console.log(`     alerts:  ${[process.env.WEBHOOK_URL && 'webhook', process.env.SMTP_USER && 'email', process.platform === 'darwin' && process.env.NOTIFY !== 'off' && 'desktop'].filter(Boolean).join(', ') || 'desktop'}`);
  console.log(`     digest:  ${process.env.DIGEST_HOUR ?? 7}:00 daily → ${process.env.DIGEST_TO || process.env.WEBHOOK_URL || 'desktop + digest.log'}\n`);
  startAIS();
  setTimeout(alertLoop, 12_000);
  setInterval(alertLoop, 5 * 60_000);
  setInterval(maybeSendDigest, 60_000);
});
