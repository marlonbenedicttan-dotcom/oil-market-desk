// Oil Basis — paper vs physical spreads across energy benchmarks + live tankers.
// Zero runtime dependencies: Node's built-in HTTP, fetch and WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sgn, businessDaysSince, inBox, haversineNm, isoWeek, monthly, pctOver, percentile, realizedVol, computeCracks, backAdjust, pearson, logReturns } from './src/lib.js';

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
  { id: 'platinum', label: 'Platinum',  group: 'Metals', unit: '$/oz', dp: 2, paper: 'PL=F', physical: null },
  { id: 'palladium',label: 'Palladium', group: 'Metals', unit: '$/oz', dp: 2, paper: 'PA=F', physical: null },
  // ---- Agriculture (futures only) ----
  { id: 'corn',    label: 'Corn',     group: 'Agriculture', unit: '¢/bu', dp: 1, paper: 'ZC=F', physical: null },
  { id: 'wheat',   label: 'Wheat',    group: 'Agriculture', unit: '¢/bu', dp: 1, paper: 'ZW=F', physical: null },
  { id: 'soybean', label: 'Soybeans', group: 'Agriculture', unit: '¢/bu', dp: 1, paper: 'ZS=F', physical: null },
  { id: 'sugar',   label: 'Sugar',    group: 'Agriculture', unit: '¢/lb', dp: 2, paper: 'SB=F', physical: null },
  { id: 'coffee',  label: 'Coffee',   group: 'Agriculture', unit: '¢/lb', dp: 2, paper: 'KC=F', physical: null },
  { id: 'cocoa',   label: 'Cocoa',    group: 'Agriculture', unit: '$/t',  dp: 0, paper: 'CC=F', physical: null },
  { id: 'cotton',  label: 'Cotton',   group: 'Agriculture', unit: '¢/lb', dp: 2, paper: 'CT=F', physical: null },
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

const spotSeries = (b, days) => (!b.physical ? Promise.resolve({}) : b.source === 'eia' ? eiaSeries(b.physical, days) : fredSeries(b.physical, days));

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

const paperFor = (b) => (b.paper ? cached('p:' + b.paper, 180_000, () => yahooSeries(b.paper, '5d', '1d')) : Promise.resolve({ price: null }));
const physFor = (b) => (b.physical ? cached('f:' + b.physical, 3_600_000, () => spotSeries(b, 14)) : Promise.resolve({}));
const hPaperFor = (b) => (b.paper ? cached('hp:' + b.paper, 3_600_000, () => yahooSeries(b.paper, '6mo', '1d')) : Promise.resolve({ series: {} }));
const hPhysFor = (b) => (b.physical ? cached('hf:' + b.physical, 3_600_000, () => spotSeries(b, 220)) : Promise.resolve({}));

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
    benchmarks: rows,
    spreads,
    quality: { flags, curveAvailable: Boolean(curves) },
    notes: [
      'Futures = live. Real barrels = an official assessment that LAGS and comes from a different source — read the data checks.',
      'Propane & jet fuel have no futures — real-barrel price only.',
      'A positive gap means real barrels cost more than futures (a tight market).',
      'The futures line is the current month only (not spliced); "prices for months ahead" is the cleanest read.',
      'Dubai / WTI Midland / Mars need a paid data source.',
    ],
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function getHistory() {
  const list = BENCHMARKS;
  const maps = {};
  await Promise.all(list.map(async (b) => {
    const p = await hPaperFor(b);
    const f = await hPhysFor(b);
    maps[b.id] = { paper: p.series, physical: f };
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

  return { dates, series, basis, spreads };
}

// ---------------------------------------------------------------------------
// Long-term (multi-year) history, bucketed by month, with % performance
// ---------------------------------------------------------------------------
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

// Daily ranges: 6m / ytd / 1y — for the chart's range selector.
async function getRange(b, range) {
  const daysMap = { '1m': 30, '3m': 92, '6m': 183, '1y': 366, ytd: Math.ceil((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 864e5) };
  const days = daysMap[range] || 183;
  const yRange = range === 'ytd' ? 'ytd' : range === '1y' ? '1y' : range === '3m' ? '3mo' : '6mo';
  const paperMap = b.paper ? (await cached(`rngp:${b.paper}:${range}`, 3600e3, () => yahooSeries(b.paper, yRange, '1d'))).series : {};
  const physMap = await cached(`rngf:${b.physical}:${range}`, 3600e3, () => spotSeries(b, days + 5));
  const dates = [...new Set([...Object.keys(paperMap), ...Object.keys(physMap)])].sort();
  const at = (o, d) => (o[d] != null ? o[d] : null);
  const series = { paper: dates.map((d) => at(paperMap, d)), physical: dates.map((d) => at(physMap, d)) };
  const pct = (arr) => { const f = arr.find((x) => x != null); const l = [...arr].reverse().find((x) => x != null); return f && l ? ((l - f) / f) * 100 : null; };
  return { id: b.id, label: b.label, unit: b.unit, dp: b.dp, range, dates, series, summary: { paper: pct(series.paper), physical: pct(series.physical) } };
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
        gas = { period: last.period, value: last.value, wow, seasonal: seasonal != null ? Math.round(seasonal) : null, surprise: seasonal != null && wow != null ? Math.round(wow - seasonal) : null };
      }
    } catch {}
    return { items, gas, fetched: new Date().toISOString() };
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
      oi: Number(r.open_interest_all) || 0,
    })).reverse();
    if (!rows.length) return { error: 'no data' };
    const latest = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const nets = rows.map((r) => r.net);
    return {
      label: 'WTI spec net (non-comm)', unit: 'contracts',
      latest, wow: prev ? latest.net - prev.net : null,
      pct: (nets.filter((n) => n <= latest.net).length / nets.length) * 100,
      oi: latest.oi, oiChange: prev ? latest.oi - prev.oi : null,
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

const CURVE_MONTHS = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
async function getCurveHistory(root) {
  return cached('curvehist:' + root, 6 * 3600e3, async () => {
    const now = new Date();
    const list = [];
    for (let k = -18; k <= 6; k++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      list.push({ mk, symbol: `${root}${CURVE_MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}.NYM` });
    }
    const series = {};
    for (const c of list) {
      series[c.mk] = await contractSeries(c.symbol);
      await sleep(200);
    }
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
    for (const c of list) {
      series[c.mk] = await contractSeries(c.symbol);
      await sleep(200);
    }
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
    const map = b.paper ? (await cached('hp:' + b.paper, 12 * 3600e3, () => yahooSeries(b.paper, years + 'y', '1d'))).series : await spotSeries(b, years * 366);
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
    return { low, high, median };
  });
}

// ---------------------------------------------------------------------------
// Macro dashboard (rates, inflation, growth, FX) — the start of the expansion
// ---------------------------------------------------------------------------
const FX_SYMS = [
  { id: 'dxy', label: 'US dollar (DXY)', sym: 'DX-Y.NYB' },
  { id: 'eurusd', label: 'EUR / USD', sym: 'EURUSD=X' },
  { id: 'usdjpy', label: 'USD / JPY', sym: 'USDJPY=X' },
  { id: 'gbpusd', label: 'GBP / USD', sym: 'GBPUSD=X' },
  { id: 'usdcny', label: 'USD / CNY', sym: 'USDCNY=X' },
  { id: 'audusd', label: 'AUD / USD · mining', sym: 'AUDUSD=X' },
  { id: 'usdcad', label: 'USD / CAD · oil', sym: 'USDCAD=X' },
  { id: 'usdnok', label: 'USD / NOK · oil', sym: 'USDNOK=X' },
  { id: 'usdbrl', label: 'USD / BRL · agri', sym: 'USDBRL=X' },
  { id: 'usdzar', label: 'USD / ZAR · gold', sym: 'USDZAR=X' },
  { id: 'usdmxn', label: 'USD / MXN · oil', sym: 'USDMXN=X' },
  { id: 'usdinr', label: 'USD / INR', sym: 'USDINR=X' },
  { id: 'usdchf', label: 'USD / CHF', sym: 'USDCHF=X' },
  { id: 'nzdusd', label: 'NZD / USD', sym: 'NZDUSD=X' },
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
    const [dgs2, dgs10, ff, cpi, gdp, unrate, ecb] = await Promise.all([
      fredSeries('DGS2', 40), fredSeries('DGS10', 40), fredSeries('FEDFUNDS', 400),
      fredSeries('CPIAUCSL', 800), fredSeries('A191RL1Q225SBEA', 1400), fredSeries('UNRATE', 400), fredSeries('ECBDFR', 400),
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
    return {
      rates: {
        us2y: r2?.value ?? null, us10y: r10?.value ?? null,
        spread: r10 && r2 ? +(r10.value - r2.value).toFixed(2) : null,
        fedfunds: ffr?.value ?? null, ecb: ecbLast?.value ?? null,
        rateGap: ffr?.value != null && ecbLast?.value != null ? +(ffr.value - ecbLast.value).toFixed(2) : null,
        asOf: r10?.date ?? null,
      },
      inflation: { cpiYoY: cpiLast != null && cpiPrevYr != null ? +(((cpiLast / cpiPrevYr) - 1) * 100).toFixed(1) : null, asOf: cpiDates[cpiDates.length - 1] ?? null },
      growth: { gdpQoQ: g?.value ?? null, unemployment: u?.value ?? null, asOf: g?.date ?? null },
      growthProxy,
      fx,
      links,
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
    for (const b of BENCHMARKS.filter((x) => x.physical)) {
      const paperMap = (await cached(`a2p:${b.paper || b.id}`, 6 * 3600e3, () => (b.paper ? yahooSeries(b.paper, '2y', '1d') : Promise.resolve({ series: {} })))).series;
      const physMap = await cached(`a2f:${b.physical}`, 6 * 3600e3, () => spotSeries(b, 740));
      twoYear[b.id] = { paperMap, physMap };
    }
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
const alertSeen = new Map();
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const state = loadState();
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} };
let lastDigestDate = state.lastDigestDate || null;
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
      state.lastDigestDate = today; saveState();
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
  // Health check (no auth) for uptime monitors.
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) })); }
  // Optional basic auth — set AUTH_USER + AUTH_PASS to protect a public deployment.
  if (process.env.AUTH_USER && process.env.AUTH_PASS) {
    const hdr = req.headers.authorization || '';
    const ok = hdr.startsWith('Basic ') && Buffer.from(hdr.slice(6), 'base64').toString('utf8') === `${process.env.AUTH_USER}:${process.env.AUTH_PASS}`;
    if (!ok) { res.writeHead(401, { 'www-authenticate': 'Basic realm="oil-market-desk"' }); return res.end('Authentication required'); }
  }
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
    if (url.pathname === '/api/range') {
      const b = BENCHMARKS.find((x) => x.id === url.searchParams.get('id'));
      if (!b) return sendJSON(res, 404, { error: 'unknown benchmark' });
      return sendJSON(res, 200, await getRange(b, url.searchParams.get('range') || 'ytd'));
    }
    if (url.pathname === '/api/seasonal') {
      const b = BENCHMARKS.find((x) => x.id === url.searchParams.get('id'));
      if (!b) return sendJSON(res, 404, { error: 'unknown benchmark' });
      return sendJSON(res, 200, await getSeasonal(b).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/reroute') return sendJSON(res, 200, { series: rerouteSeries, current: rerouteSeries[rerouteSeries.length - 1] || null });
    if (url.pathname === '/api/inventories') return sendJSON(res, 200, await getInventories());
    if (url.pathname === '/api/positioning') return sendJSON(res, 200, await getPositioning());
    if (url.pathname === '/api/equities') return sendJSON(res, 200, await getEquities());
    if (url.pathname === '/api/macro') return sendJSON(res, 200, await getMacro());
    if (url.pathname === '/api/macrodash') return sendJSON(res, 200, await getMacroDash().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/correlations') return sendJSON(res, 200, await getCorrelations().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/events') return sendJSON(res, 200, getEvents());
    if (url.pathname === '/api/chokepoints') return sendJSON(res, 200, getChokepoints());
    if (url.pathname === '/api/curve') return sendJSON(res, 200, await getCurves());
    if (url.pathname === '/api/curvehistory') return sendJSON(res, 200, await getCurveHistory(url.searchParams.get('root') || 'CL').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/continuous') return sendJSON(res, 200, await getContinuous(url.searchParams.get('root') || 'CL').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/tightness') return sendJSON(res, 200, await getTightness().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/flows') return sendJSON(res, 200, await getFlows());
    if (url.pathname === '/api/products') return sendJSON(res, 200, await getProducts().catch((e) => ({ error: String(e.message) })));
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
  setInterval(() => { state.tankerMMSI = [...tankerMMSI]; saveState(); }, 60_000);
  setTimeout(() => { state.tankerMMSI = [...tankerMMSI]; saveState(); snapshotReroute(); }, 90_000);
  setInterval(snapshotReroute, 5 * 60_000);
});
