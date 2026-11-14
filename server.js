// Marlon's Watchtower — paper vs physical spreads across energy benchmarks.
// Zero runtime dependencies: Node's built-in HTTP, fetch and WebSocket.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { sendMail } from './src/smtp.js';
import { fileURLToPath } from 'node:url';
import { projectUs, projectJp, japanList, koreaList, taiwanList, hongkongList, australiaList, indiaList, indonesiaList, brazilList, southafricaList, US_LIST_FIELDS } from './src/project.js';
import { sliceRange, seriesFromLine } from './src/charts.js';
import { searchEntries, prepareEntries } from './src/search.js';
import { parseRef, yahooSymbol, normalizeQuote, chunk } from './src/quotes.js';
import { growthRates, fromJapanHistory } from './src/growth.js';
import { REGIME_BOARD, keepLastGood, buildRegimeRow } from './src/regime.js';
import { RISK_SERIES, keepLastSeries, latestDate } from './src/risk.js';
import { sgn, businessDaysSince, horizonDeltas, horizonDeltasAbs, isoWeek, monthly, pctOver, percentile, lastNonNull, escHtml, webhookPayload, realizedVol, computeCracks, computeCrush, computeSteel, buildRelValueRow, relValueZone, ordinal, alignPriceToRows, inventoryBands, backAdjust, pearson, logReturns, frontExpiry, curveTightness, inventoryTightness, weightedScore, seasonalGrade, seasonalAhead, contractMonthsBetween, signedPosition, signedMove, stretchScore, sdLabel, attributeMoves, newsContextOk, METHODOLOGY, positioningFlag, positioningRead, positioningDivergence, maxDrawdown, drawdownNow, realizedVolTerm, volPercentile, volVsOwnWord, corrMatrix, fxAdjust, parseOcc, drawdownWord, volWord, volTrend, corrShift, pairGroups, topPairs, bestDiversifier, riskRead, priorityOf, rankByPriority, clusterEvents, scoreEvents, selectEvents, explainRows } from './src/lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const UA = { 'User-Agent': 'Mozilla/5.0 (oil-basis)' };

// Annual macro snapshot (IMF WEO), refreshed by the scheduled scripts/fetch-macro.mjs job. The
// IMF API is blocked from this host, so we serve the committed snapshot instead. Read once at
// startup — it only changes on a commit, which redeploys us. Absent -> per-source fallback.
const MACRO_SNAPSHOT = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'macro.json'), 'utf8')); } catch { return null; } })();
const USDA_SNAPSHOT = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'usda.json'), 'utf8')); } catch { return null; } })();
// Per-company freshness ledger, written by the scheduled ledger job. Absent until the first run.
const REFRESH_LEDGER = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'refresh-ledger.json'), 'utf8')); } catch { return null; } })();

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
  { id: 'jet',    label: 'Jet Fuel (USGC)', group: 'Refined', unit: '$/gal',   dp: 3, paper: null,   physical: 'EER_EPJK_PF4_RGC_DPG', source: 'eia', fredFallback: 'DJFUELUSGULF' },
  { id: 'propane',label: 'Propane (Mt Belvieu)', group: 'Refined', unit: '$/gal', dp: 3, paper: null, physical: 'EER_EPLLPA_PF4_Y44MB_DPG', source: 'eia', fredFallback: 'DPROPANEMBTX' },
  { id: 'natgas', label: 'Natural Gas',     group: 'Gas',     unit: '$/MMBtu', dp: 2, paper: 'NG=F', physical: 'DHHNGSP', source: 'fred' },
  // ---- Metals (futures only — no free spot) ----
  { id: 'gold',     label: 'Gold',      group: 'Metals', unit: '$/oz', dp: 2, paper: 'GC=F', physical: null },
  { id: 'silver',   label: 'Silver',    group: 'Metals', unit: '$/oz', dp: 3, paper: 'SI=F', physical: null },
  { id: 'copper',   label: 'Copper',    group: 'Metals', unit: '$/lb', dp: 4, paper: 'HG=F', physical: null },
  { id: 'aluminium',label: 'Aluminium', group: 'Metals', unit: '$/t',  dp: 0, paper: 'ALI=F', physical: null },
  // The steel chain: ore is the China-demand bellwether, HRC is the industrial cycle itself, and the
  // two together give a steel margin (ore -> hot-rolled coil) the way cracks and crush do for oil/soy.
  { id: 'ironore',  label: 'Iron ore 62% Fe', group: 'Metals', unit: '$/t',  dp: 2, paper: 'TIO=F', physical: null },
  { id: 'steel',    label: 'Steel (HRC)',     group: 'Metals', unit: '$/st', dp: 0, paper: 'HRC=F', physical: null },
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
  { id: 'rice',    label: 'Rough rice',   group: 'Agriculture', unit: '$/cwt', dp: 2, paper: 'ZR=F', physical: null },
  { id: 'orange',  label: 'Orange juice', group: 'Agriculture', unit: '¢/lb',  dp: 2, paper: 'OJ=F', physical: null },
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
  { id: 'crude',      label: 'Crude oil',       group: 'Crude',   primary: 'wti',    components: ['wti', 'brent'],                             hasBasis: true,  hasInventories: true },
  { id: 'refined',    label: 'Refined products', group: 'Refined', primary: 'rbob',   components: ['rbob', 'ulsd', 'jet', 'propane'],           hasBasis: true,  hasInventories: true },
  { id: 'gas',        label: 'Natural gas',      group: 'Gas',     primary: 'natgas', components: ['natgas'],                                   hasBasis: true,  hasInventories: true },
  { id: 'precious',   label: 'Precious metals',   group: 'Metals',      primary: 'gold',   components: ['gold', 'silver', 'platinum', 'palladium'],  hasBasis: false, hasInventories: false },
  { id: 'industrial', label: 'Industrial metals', group: 'Metals',      primary: 'copper', components: ['copper', 'aluminium', 'ironore', 'steel'],              hasBasis: false, hasInventories: false },
  { id: 'grains',     label: 'Grains & oilseeds',  group: 'Agriculture', primary: 'corn',   components: ['corn', 'wheat', 'soybean', 'soymeal', 'soyoil', 'rice'], hasBasis: false, hasInventories: false },
  { id: 'softs',      label: 'Softs',             group: 'Agriculture', primary: 'sugar',  components: ['sugar', 'coffee', 'cocoa', 'cotton', 'palm', 'orange'], hasBasis: false, hasInventories: false },
  { id: 'livestock',  label: 'Livestock',         group: 'Livestock',   primary: 'cattle', components: ['cattle', 'hogs', 'feeder'],                hasBasis: false, hasInventories: false },
  { id: 'dairy',      label: 'Dairy',             group: 'Dairy',       primary: 'milk',   components: ['milk', 'butter', 'nfdm', 'cheese', 'whey'], hasBasis: false, hasInventories: false },
];
// ---------------------------------------------------------------------------
// Relative value — the 1-3 spreads per segment that have a real economic link
// (a processing margin, a substitution pair, a feed/currency cost, or a
// growth-vs-safety ratio). Each is ranked against its own 1-year history, never
// against another segment. The maths is in src/lib.js; this table is curation.
// ---------------------------------------------------------------------------
const REL_VALUE = {
  crude: [
    { id: 'brent_wti', label: 'Brent − WTI', kind: 'diff', a: 'brent', b: 'wti', legs: ['brent', 'wti'], unit: '$/bbl', dp: 2, why: 'A wide gap usually means tight non-US crude or heavy US supply; it pays for export logistics.' },
  ],
  refined: [
    { id: 'c321', label: '3-2-1 crack', kind: 'margin', calc: 'c321', legs: ['rbob', 'ulsd', 'wti'], unit: '$/bbl', dp: 2, why: 'The refining margin: wide means products are tight or crude is cheap.' },
    { id: 'diesel_gas', label: 'Diesel − gasoline', kind: 'diff', a: 'ulsd', b: 'rbob', scale: 42, legs: ['ulsd', 'rbob'], unit: '$/bbl', dp: 2, why: 'Winter heating and freight demand widen it; summer gasoline narrows it.' },
  ],
  gas: [
    { id: 'gas_oil', label: 'Gas ÷ oil (energy-equivalent)', kind: 'ratio', a: 'natgas', b: 'wti', af: 5.8, legs: ['natgas', 'wti'], unit: '×', dp: 2, why: 'Gas priced against oil on an energy basis; low means gas is cheap for power and industry.' },
  ],
  precious: [
    { id: 'gold_silver', label: 'Gold ÷ silver', kind: 'ratio', a: 'gold', b: 'silver', legs: ['gold', 'silver'], unit: '×', dp: 1, why: 'A high ratio means silver is cheap versus gold; extremes often mark risk-off.' },
    { id: 'plat_gold', label: 'Platinum ÷ gold', kind: 'ratio', a: 'platinum', b: 'gold', legs: ['platinum', 'gold'], unit: '×', dp: 2, why: 'Platinum below gold is unusual; it usually reflects weak auto demand or gold’s monetary premium.' },
  ],
  industrial: [
    { id: 'copper_gold', label: 'Copper ÷ gold (×1,000)', kind: 'ratio', a: 'copper', b: 'gold', legs: ['copper', 'gold'], unit: '×', dp: 2, scale: 1000, why: 'Copper measures growth, gold measures safety; a falling ratio is a risk-off tell.' },
    { id: 'steel_margin', label: 'Steel margin', kind: 'margin', calc: 'steel', legs: ['steel', 'ironore'], unit: '$/t', dp: 0, why: 'Hot-rolled coil minus the ore needed: a gross mill margin before coking coal and energy.' },
  ],
  grains: [
    { id: 'crush', label: 'Soybean crush', kind: 'margin', calc: 'crush', legs: ['soymeal', 'soyoil', 'soybean'], unit: '$/bu', dp: 2, why: 'The processor margin; high means strong meal/oil demand or cheap beans.' },
    { id: 'soy_corn', label: 'Soybean ÷ corn', kind: 'ratio', a: 'soybean', b: 'corn', legs: ['soybean', 'corn'], unit: '×', dp: 2, why: 'The acreage fight: a high ratio pulls acres toward soybeans next season.' },
  ],
  softs: [
    { id: 'palm_soyoil', label: 'Palm − soyoil', kind: 'diff', a: 'palm', b: 'soyoil', bf: 22.0462, legs: ['palm', 'soyoil'], unit: '$/t', dp: 0, why: 'Vegetable-oil substitution; palm at a discount pulls demand its way.' },
  ],
  livestock: [
    { id: 'cattle_feeder', label: 'Live − feeder', kind: 'diff', a: 'cattle', b: 'feeder', legs: ['cattle', 'feeder'], unit: '¢/lb', dp: 2, why: 'The price gap between finished cattle and feeders; a wider gap (less negative) favours feedlots.' },
    { id: 'cattle_hogs', label: 'Cattle ÷ hogs', kind: 'ratio', a: 'cattle', b: 'hogs', legs: ['cattle', 'hogs'], unit: '×', dp: 2, why: 'Protein substitution: extremes shift retail and food-service demand between beef and pork.' },
  ],
  dairy: [
    { id: 'milk_cheese', label: 'Class III ÷ cheese', kind: 'ratio', a: 'milk', b: 'cheese', legs: ['milk', 'cheese'], unit: '×', dp: 1, why: 'The Class III pricing relationship; a move away from its usual multiple is the signal.' },
    { id: 'butter_nfdm', label: 'Butter − NFDM', kind: 'diff', a: 'butter', b: 'nfdm', legs: ['butter', 'nfdm'], unit: '¢/lb', dp: 1, why: 'Cream and product mix: a wide gap favours butter production over powder.' },
  ],
};

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
// `YF_BASE` is a diagnostics/test override: point it at an unreachable host to exercise the
// last-good and FRED fallbacks without waiting for a real Yahoo block.
const YF = process.env.YF_BASE || 'https://query1.finance.yahoo.com/v8/finance/chart/';

// Yahoo 429s and 5xx bursts are transient, and a single one used to leave a whole market read
// without a price series. One short retry costs nothing and turns most of those into a normal read.
async function yahooFetch(url) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) return res;
      last = new Error(`yahoo -> ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  throw last;
}
async function yahooSeries(symbol, range = '6mo', interval = '1d') {
  const res = await yahooFetch(`${YF}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
  if (!res.ok) throw new Error(`yahoo ${symbol} -> ${res.status}`);
  const r = (await res.json()).chart?.result?.[0];
  if (!r) throw new Error(`yahoo ${symbol} -> no result`);
  const ts = r.timestamp || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  const series = {};
  ts.forEach((t, i) => { if (close[i] != null) series[new Date(t * 1000).toISOString().slice(0, 10)] = close[i]; });
  // TODAY'S BAR IS USUALLY NULL UNTIL THE SESSION SETTLES, so "the latest close" is yesterday and every
  // 1-day number silently compares two old closes (KOSPI printed +1.8% while it was actually −3.7%).
  // If Yahoo's own quote is fresh — not the stale legacy quotes noted below — put it on its date.
  const meta = r.meta || {};
  if (meta.regularMarketPrice != null && meta.regularMarketTime) {
    const liveDay = new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);
    const lastKey = Object.keys(series).sort().pop();
    // Only FILL a missing day, never overwrite a real bar, and never accept a future date — that is
    // what keeps a stale legacy quote (CPO=F reported a Mar-2024 price) from poisoning the series.
    if ((!lastKey || lastKey < liveDay) && liveDay <= new Date().toISOString().slice(0, 10)) series[liveDay] = meta.regularMarketPrice;
  }
  // Prefer the newest point in the series: Yahoo's `regularMarketPrice` can be a STALE quote for
  // legacy/alt symbols — e.g. CPO=F (palm) reports a Mar-2024 price while its daily bars are current.
  const lastKey = Object.keys(series).sort().pop();
  return { symbol, price: lastKey ? series[lastKey] : (meta.regularMarketPrice ?? null), series };
}

// ---------------------------------------------------------------------------
// Live equity quotes
// ---------------------------------------------------------------------------
// The committed close is the base; this is an overlay. Yahoo's spark endpoint takes up to 20 symbols
// and returns each one's last price, previous close, quote time and currency — enough to move price,
// the 1D change and every price-derived ratio without touching the daily files. Only the symbols on
// screen are fetched, so a page costs three calls, not fifteen hundred.
const LIVE_QUOTE_TTL_OPEN = 10_000;
const LIVE_QUOTE_TTL_CLOSED = 5 * 60_000;
const liveQuotes = new Map();                 // ref -> { v, t }
let liveQuoteCooldown = 0;

function httpsJson(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...UA, Accept: 'application/json' }, timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`yahoo -> ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('yahoo timeout')));
    req.on('error', reject);
  });
}

async function fetchSparkQuotes(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=1d&interval=5m`;
  const j = await httpsJson(url);
  const out = {};
  for (const row of (j && j.spark && j.spark.result) || []) {
    const meta = row.response && row.response[0] && row.response[0].meta;
    const q = normalizeQuote(meta);
    if (q) out[String(row.symbol).toUpperCase()] = q;
  }
  return out;
}

async function getLiveQuotes(refs) {
  const out = {};
  // A 429 means we are the problem: serve the last good quote and stop calling Yahoo for a minute.
  if (Date.now() < liveQuoteCooldown) {
    for (const ref of refs) { const hit = liveQuotes.get(ref); if (hit) out[ref] = hit.v; }
    return out;
  }
  const want = new Map();                     // Yahoo symbol -> refs
  for (const ref of refs) {
    const parsed = parseRef(ref);
    if (!parsed || !parsed.symbol) continue;
    const hit = liveQuotes.get(ref);
    const fresh = hit && hit.v && hit.v.time && Date.now() - Date.parse(hit.v.time) < 10 * 60e3;
    if (hit && Date.now() - hit.t < (fresh ? LIVE_QUOTE_TTL_OPEN : LIVE_QUOTE_TTL_CLOSED)) {
      out[ref] = hit.v;
      continue;
    }
    if (!want.has(parsed.symbol)) want.set(parsed.symbol, []);
    want.get(parsed.symbol).push(ref);
  }
  const batches = chunk([...want.keys()], 20);
  const fetched = await Promise.allSettled(batches.map((batch) => fetchSparkQuotes(batch)));
  fetched.forEach((result, i) => {
    if (result.status === 'rejected' && /429|5\d\d/.test(String(result.reason && result.reason.message || ''))) {
      liveQuoteCooldown = Date.now() + 60_000;
    }
    const batch = batches[i];
    const quotes = result.status === 'fulfilled' ? result.value : {};
    for (const symbol of batch) {
      const q = quotes[symbol];
      for (const ref of want.get(symbol) || []) {
        if (q) { liveQuotes.set(ref, { v: q, t: Date.now() }); out[ref] = q; }
        else { const old = liveQuotes.get(ref); if (old) out[ref] = old.v; }
      }
    }
  });
  if (liveQuotes.size > 6000) {
    const cut = Date.now() - 30 * 60e3;
    for (const [k, v] of liveQuotes) if (v.t < cut) liveQuotes.delete(k);
  }
  return out;
}

const fredWarned = new Set();
async function fredSeries(id, days = 220, { quiet = false } = {}) {
  const cosd = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  // FRED is a best-effort feed: it 403s under load and answers HTTP 200 with a "Site Maintenance"
  // page during outages. A dead series must degrade to "no spot data" (the futures price still works),
  // never reject — one rejection used to empty the whole market/screener response.
  try {
    const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!/^(DATE|observation_date),/i.test(text.trimStart().slice(0, 40))) throw new Error('maintenance page, not CSV');
    const out = {};
    for (const line of text.trim().split('\n').slice(1)) {
      const [d, v] = line.split(',');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !v || v === '.') continue;
      const n = parseFloat(v);
      if (Number.isFinite(n)) out[d] = n;
    }
    if (Object.keys(out).length < 5) throw new Error('too few observations');
    return out;
  } catch (e) {
    if (!quiet && !fredWarned.has(id)) { fredWarned.add(id); console.warn(`[fred] ${id}: ${e.message} — continuing without it`); }
    return {};
  }
}

// The US Treasury publishes the same daily curve FRED mirrors, and keeps answering when FRED does
// not. Used as the fallback for US yields (DGS2/DGS10/... -> "2 Yr"/"10 Yr" columns).
const TREASURY_COL = { DGS1MO: '1 Mo', DGS3MO: '3 Mo', DGS6MO: '6 Mo', DGS1: '1 Yr', DGS2: '2 Yr', DGS3: '3 Yr', DGS5: '5 Yr', DGS7: '7 Yr', DGS10: '10 Yr', DGS20: '20 Yr', DGS30: '30 Yr' };
async function treasurySeries(fredId, years = 2) {
  const col = TREASURY_COL[fredId];
  if (!col) return {};
  return cached('tres:' + fredId, 6 * 3600e3, async () => {
    const out = {};
    const nowY = new Date().getUTCFullYear();
    for (let y = nowY - years + 1; y <= nowY; y++) {
      try {
        const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`;
        const res = await fetch(url, { headers: UA });
        if (!res.ok) continue;
        const lines = (await res.text()).trim().split('\n');
        const head = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
        const idx = head.indexOf(col);
        if (idx < 0) continue;
        for (const line of lines.slice(1)) {
          const cells = line.split(',');
          const d = cells[0] && cells[0].trim();
          const v = parseFloat(cells[idx]);
          if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(d || '') || !Number.isFinite(v)) continue;
          const [m, dd, yy] = d.split('/');
          out[`${yy}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`] = v;
        }
      } catch {}
    }
    return out;
  });
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

// Spot series: FRED directly, or EIA (needs a free key) with the FRED mirror of the same series as the
// fallback — so the two spot-only energy instruments are never blank just because no key was set.
const spotSeries = (b, days) => (!b.physical
  ? Promise.resolve({})
  : b.source === 'eia'
    ? eiaSeries(b.physical, days).then((s) => (Object.keys(s).length ? s : (b.fredFallback ? fredSeries(b.fredFallback, days) : {})))
    : fredSeries(b.physical, days).catch(() => ({})));   // FRED can 403/return maintenance: the paper
// price is what matters, the physical spot is only the basis. Never let one dead feed take the app down.

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

// Like cached(), but a result the caller calls empty is served WITHOUT being stored — a rate-limited
// burst must not occupy the six-hour slot with a blank chart.
// Stale-while-revalidate: once a value exists, a reader never waits for the refresh. Past its TTL it
// is served immediately and refreshed in the background; only the very first computation blocks.
async function cachedSWR(key, ttlMs, fn, staleMs = 6 * 3600e3) {
  const hit = cache.get(key);
  if (hit) {
    const age = Date.now() - hit.t;
    if (age < ttlMs) return hit.v;
    if (age < staleMs) {
      if (!inflight.has(key)) {
        const p = (async () => { try { const v = await fn(); cache.set(key, { t: Date.now(), v }); return v; } catch { return hit.v; } finally { inflight.delete(key); } })();
        inflight.set(key, p);
      }
      return hit.v;
    }
  }
  return cached(key, ttlMs, fn);
}

async function cachedUnlessEmpty(key, ttlMs, fn, isEmpty) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const fly = inflight.get(key);
  if (fly) return fly;
  const p = (async () => { try { const v = await fn(); if (!isEmpty(v)) cache.set(key, { t: Date.now(), v }); return v; } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

// A nice-to-have feed must never hold a page: give it a budget and let it finish in the background.
// The value still lands in `cached()`, so the next read has it; this read just doesn't wait.
const within = (p, ms) => Promise.race([
  p.catch(() => null),
  new Promise((r) => setTimeout(() => r(null), ms)),
]);

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
  // One fetch per contract month even when two panels ask at the same moment: the curve-history and
  // the continuous series overlap, and duplicate bursts are what get the whole app rate-limited.
  const fly = inflight.get(key);
  if (fly) return fly;
  const p = (async () => {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await yahooSeries(symbol, '2y', '1d');
        if (r && Object.keys(r.series).length) { cache.set(key, { t: Date.now(), v: r.series }); return r.series; }
        return {};                                     // listed but not trading yet — a fact, not a failure
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/-> 404\b/.test(msg)) return {};           // no such month: retrying can never help
        // 429 means we are the problem: back off further, and don't hammer it with the same cadence.
        await sleep(/-> 429\b/.test(msg) ? 700 * (a + 1) : 600);
      }
    }
    return {};
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

const getMarket = () => cachedSWR('market', 60_000, buildMarket, 10 * 60_000);
async function buildMarket() {
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
const getHistory = () => cachedSWR('history', 120_000, buildHistory, 30 * 60_000);
async function buildHistory() {
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
  // Futures and the real (physical) series are independent feeds — fetch them together.
  const [paperRes, physRaw] = await Promise.all([
    b.paper ? cached(`ltp:${b.paper}:${years}`, 6 * 3600e3, () => yahooSeries(b.paper, `${years}y`, interval)) : Promise.resolve(null),
    cached(`ltf:${b.physical}:${years}`, 6 * 3600e3, () => spotSeries(b, years * 366 + 30)),
  ]);
  const paperMap = (paperRes && paperRes.series) || {};
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
  // Futures and the real (physical) series are independent feeds — fetch them together.
  const [paperRes, physMap] = await Promise.all([
    b.paper ? cached(`rngp:${b.paper}:${range}`, 3600e3, () => yahooSeries(b.paper, yRange, '1d')) : Promise.resolve(null),
    cached(`rngf:${b.physical}:${range}`, 3600e3, () => spotSeries(b, days + 5)),
  ]);
  const paperMap = (paperRes && paperRes.series) || {};
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
// Relative value — assemble the curated spreads for one segment from the same
// 1-year futures series the charts use. Every row is ranked against its own
// history; a missing leg leaves the row blank rather than inventing a number.
// ---------------------------------------------------------------------------
const relDownsample = (arr, n = 60) => (arr.length <= n ? arr
  : Array.from({ length: n }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (n - 1))]));

async function getRelValue(segment) {
  const spec = REL_VALUE[segment];
  const mk = MARKETS.find((m) => m.id === segment);
  const base = { segment, label: mk?.label || segment, asOf: null, rows: [] };
  if (!spec) return base;
  return cachedSWR('relvalue:' + segment, 10 * 60e3, async () => {
    const ids = [...new Set(spec.flatMap((r) => r.legs || [r.a, r.b].filter(Boolean)))];
    const legs = {};
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await getRange(id, '1y');
        const map = {};
        (r.dates || []).forEach((d, i) => { const v = r.series?.paper?.[i]; if (v != null) map[d] = v; });
        legs[id] = map;
      } catch { legs[id] = {}; }
    }));
    const rows = spec.map((r) => buildRelValueRow(r, legs)).filter((r) => r.obs > 0);
    // "Most extreme" is the row furthest from the median of its own range. It is a label, not a
    // recommendation; the registry order stays fixed so the panel does not jump around day to day.
    const max = rows.reduce((m, r) => (r.pct != null && (m == null || Math.abs(r.pct - 50) > Math.abs(m.pct - 50)) ? r : m), null);
    for (const r of rows) {
      r.zone = relValueZone(r.pct);
      r.extreme = rows.length > 1 && r === max && r.pct != null;
      r.pctLabel = r.pct == null ? null : (r.pct < 1 ? '<1st pctile' : `${ordinal(r.pct)} pctile`);
      r.pct = r.pct == null ? null : +r.pct.toFixed(1);
      r.last = r.last == null ? null : +r.last.toFixed(r.dp);
      r.spark = relDownsample(r.history).map((v) => +v.toFixed(4));
      delete r.history;
    }
    const asOf = rows.map((r) => r.asOf).filter(Boolean).sort().at(-1) || null;
    return { ...base, asOf, rows };
  });
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
        unit: 'kbbl',
        history: inventoryBands(arr, 156, 5),
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
        gas = { period: last.period, value: last.value, wow, seasonal: seasonal != null ? Math.round(seasonal) : null, surprise: seasonal != null && wow != null ? Math.round(wow - seasonal) : null, seasonalMin: sameWeek.length >= 3 ? Math.round(Math.min(...sameWeek.map((w) => w.wow))) : null, seasonalMax: sameWeek.length >= 3 ? Math.round(Math.max(...sameWeek.map((w) => w.wow))) : null, unit: 'BCF', history: inventoryBands(garr, 156, 5) };
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
  wti: 'CRUDE OIL, LIGHT SWEET-WTI', brent: 'BRENT LAST DAY',
  // "NATURAL GAS" is the legacy 1995-99 name; the current NYMEX series is HENRY HUB.
  rbob: 'GASOLINE RBOB', ulsd: 'NY HARBOR ULSD', natgas: 'HENRY HUB',
  gold: 'GOLD', silver: 'SILVER', copper: 'COPPER- #1', platinum: 'PLATINUM', palladium: 'PALLADIUM',
  steel: 'STEEL-HRC',   // iron ore is not a CFTC contract
  corn: 'CORN', wheat: 'WHEAT-SRW', soybean: 'SOYBEANS', soymeal: 'SOYBEAN MEAL', soyoil: 'SOYBEAN OIL',
  sugar: 'SUGAR NO. 11', coffee: 'COFFEE C', cocoa: 'COCOA', cotton: 'COTTON NO. 2',
  orange: 'FRZN CONCENTRATED ORANGE JUICE', rice: 'ROUGH RICE',
  // Palm is not mapped: its only CFTC series stopped in 2019, so the panel shows no positioning
  // rather than a seven-year-old "crowded" flag.
  milk: 'MILK, Class III', butter: 'BUTTER (CASH SETTLED)', cheese: 'CHEESE (CASH-SETTLED)', nfdm: 'NON FAT DRY MILK', whey: 'DRY WHEY',
  // The livestock segment had no COT mapping at all, so its positioning panel always read "no series".
  cattle: 'LIVE CATTLE', hogs: 'LEAN HOGS', feeder: 'FEEDER CATTLE',
};
async function getPositioning(id = 'wti') {
  const name = COT_NAMES[id];
  const b = BENCHMARKS.find((x) => x.id === id);
  if (!name) return { error: 'no CFTC series for ' + id };
  // A result whose price series failed must not occupy the six-hour slot with a net-only chart; let
  // the next call retry the price fetch.
  return cachedUnlessEmpty('positioning:' + id, 6 * 3600e3, async () => {
    const where = `contract_market_name='${name}'`;
    // Only the four columns this panel reads. Asking Socrata for the full row made it build a ~1MB
    // document (and take 15-20s); the narrow select is ~35KB and answers in ~2s.
    const select = 'report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,open_interest_all';
    const url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$limit=220&$order=report_date_as_yyyy_mm_dd%20DESC&$select=${encodeURIComponent(select)}&$where=${encodeURIComponent(where)}`;
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
    // One 2-year futures series serves both the divergence read and the chart. It used to be fetched
    // only for the divergence and then thrown away. Do not cache an empty map: a transient Yahoo miss
    // would otherwise hide the price line for six hours.
    let px = {};
    if (b && b.paper) {
      try {
        // A private key: `a2p:` is also used elsewhere in this file to cache the whole
        // {price, series} object, and reading that as a date map left natgas/Brent with no price.
        px = await cachedUnlessEmpty('pospx:' + b.paper, 6 * 3600e3,
          () => yahooSeries(b.paper, '2y', '1d').then((r) => r.series).catch(() => ({})),
          (v) => !v || !Object.keys(v).length);
      } catch {}
    }
    // Yahoo can rate-limit a cold 2-year request (natgas did). The 6-month series behind the price
    // chart is already cached, so use it rather than publish a net-only chart with no price line.
    if (!Object.keys(px).length) {
      try {
        const hist = await getHistory();
        const s = hist?.series?.[id];
        const vals = s && (s.paper || s.physical);
        if (vals) {
          const map = {};
          (hist.dates || []).forEach((d, i) => { if (vals[i] != null) map[d] = vals[i]; });
          px = map;
        }
      } catch {}
    }
    const divergence = b && b.paper && Object.keys(px).length ? positioningDivergence(px, rows) : null;
    const history = alignPriceToRows(px, rows).slice(-104);
    return {
      id, label: `${b?.label || id} spec net (non-comm)`, unit: 'contracts',
      latest, wow: prev ? latest.net - prev.net : null,
      pct: pctOf(nets),                                     // full window (kept for the digest)
      pct3y, weeks: rows.length,
      flag: positioningFlag(pct3y), read: positioningRead(pct3y),
      divergence,
      oi: latest.oi, oiChange: prev ? latest.oi - prev.oi : null,
      priceLabel: b?.label || id, priceUnit: b?.unit || '', priceDp: b?.dp ?? 2,
      history,
    };
  }, (v) => !v || !!v.error || (Array.isArray(v.history) && v.history.length > 0 && !v.history.some((r) => r.price != null)));
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
// The board used to cache whatever one refresh produced — including blank rows after a Yahoo 429 —
// for the whole TTL. Keep the last good row per instrument instead. The runtime cache survives a
// restart of this process; the committed seed covers a deploy that lands while Yahoo is unavailable.
const REGIME_SEED_FILE = path.join(__dirname, 'data', 'regime-seed.json');
const REGIME_CACHE_FILE = path.join(__dirname, '.regime-cache.json');
const REGIME_KEEP_MS = 14 * 864e5;
function readRegimeRows(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !Array.isArray(j.rows)) return [];
    if (!j.updated || Date.now() - Date.parse(j.updated) > REGIME_KEEP_MS) return [];
    return j.rows.filter((r) => r && r.id && r.price != null);
  } catch { return []; }
}
const REGIME_LAST = new Map();
for (const r of [...readRegimeRows(REGIME_CACHE_FILE), ...readRegimeRows(REGIME_SEED_FILE)]) {
  const prev = REGIME_LAST.get(r.id);
  if (!prev || String(r.asOf || '') >= String(prev.asOf || '')) REGIME_LAST.set(r.id, r);
}
let regimeCacheAt = 0;
function saveRegimeCache() {
  const now = Date.now();
  if (now - regimeCacheAt < 15 * 60e3) return;   // a backdrop does not need a write every refresh
  regimeCacheAt = now;
  try {
    const body = JSON.stringify({ updated: new Date(now).toISOString(), rows: [...REGIME_LAST.values()] });
    fs.writeFileSync(`${REGIME_CACHE_FILE}.tmp`, body);
    fs.renameSync(`${REGIME_CACHE_FILE}.tmp`, REGIME_CACHE_FILE);
  } catch { /* a read-only filesystem is not a reason to fail the board */ }
}
async function regimeSeries(s) {
  if (s.fred) {
    let map = {};
    try { map = await cached('regime:' + s.id, 3600e3, () => fredSeries(s.fred, 40 * 366).catch(() => ({}))); } catch {}
    let source = s.source;
    if (Object.keys(map).length < 5 && s.altSym) {          // FRED is down / rate-limited
      try {
        map = (await cached('regime:alt:' + s.id, 900e3, () => yahooSeries(s.altSym, '2y', '1d'))).series || {};
        source = 'Yahoo';
        // ^TNX has been quoted as yield x10 in the past; normalise anything implausible.
        if (Object.values(map).some((v) => v > 20)) map = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v / 10]));
      } catch { map = {}; }
    }
    return { map, source };
  }
  let map = {};
  try { map = (await cached('regime:' + s.id, 900e3, () => yahooSeries(s.sym, '2y', '1d'))).series || {}; } catch {}
  let source = s.source;
  // VIX and the S&P are published by FRED under the same definition, so a Yahoo block still leaves
  // the two headline risk tiles populated instead of showing a dash.
  if (Object.keys(map).length < 5 && s.fallbackFred) {
    try {
      map = await cached('regime:fb:' + s.id, 3600e3, () => fredSeries(s.fallbackFred, 2 * 366).catch(() => ({})));
      if (Object.keys(map).length >= 5) source = 'FRED';
    } catch { map = {}; }
  }
  return { map, source };
}
async function getRegime() {
  return cachedSWR('regime', 900e3, async () => {
    let freshCount = 0;
    const rows = await Promise.all(REGIME_BOARD.map(async (s) => {
      const base = { id: s.id, label: s.label, source: s.source, unit: s.unit, dp: s.dp, rate: !!s.rate };
      let fresh = null;
      try {
        const { map, source } = await regimeSeries(s);
        const row = buildRegimeRow(s, map, source);
        if (row) {
          fresh = row;
          REGIME_LAST.set(s.id, fresh);
          freshCount++;
        }
      } catch { /* keep the last good row below */ }
      const row = keepLastGood(fresh, REGIME_LAST.get(s.id));
      if (!row) return { ...base, price: null, deltas: null, asOf: null };
      return {
        ...base, price: row.price, deltas: row.deltas, asOf: row.asOf,
        source: row.stale ? `${row.source} (last good)` : row.source,
        stale: !!row.stale,
      };
    }));
    if (freshCount) saveRegimeCache();
    return { updated: new Date().toISOString(), rows };
  });
}

// ---------------------------------------------------------------------------
// M&A — a deal STORE, not a feed. Four discovery channels (announcement, rumour, completion,
// termination) merge into one entity per deal, so a deal announced in February and closed in October
// is the same row with a lifecycle, not two unrelated headlines.
// ---------------------------------------------------------------------------
const COMPANIES_FILE = path.join(__dirname, 'data', 'companies.json');
const COMPANIES = (() => { try { return JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8')); } catch { return { companies: [] }; } })();
// Committed daily/weekly closes for every US ticker — the company chart reads this, never Yahoo.
// Committed daily/weekly closes for every US ticker — the fallback when the chart store is absent.
// Loaded on the first request that actually needs it, not at boot: the store answers every normal
// chart, and parsing 8.7 MB on startup was pure memory on the free instance.
let US_CHARTS = null;
function usCharts() {
  if (US_CHARTS) return US_CHARTS;
  try { US_CHARTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'us-charts.json'), 'utf8')).series || {}; }
  catch { US_CHARTS = {}; }
  return US_CHARTS;
}

// ---------------------------------------------------------------------------
// Global company search — one compact index over every company market.
// Built by scripts/build-search-index.mjs and committed; loaded lazily because it is ~6.7 MB.
// ---------------------------------------------------------------------------
let GLOBAL_SEARCH_INDEX = null;
function globalSearchIndex() {
  if (GLOBAL_SEARCH_INDEX) return GLOBAL_SEARCH_INDEX;
  try {
    GLOBAL_SEARCH_INDEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'search-index.json'), 'utf8'));
    prepareEntries(GLOBAL_SEARCH_INDEX.entries || []);
  } catch { GLOBAL_SEARCH_INDEX = { entries: [], markets: {} }; }
  return GLOBAL_SEARCH_INDEX;
}
let GLOBAL_MARKET_INDEX = null;
function globalMarketIndex() {
  if (GLOBAL_MARKET_INDEX) return GLOBAL_MARKET_INDEX;
  try { GLOBAL_MARKET_INDEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'market-index.json'), 'utf8')); }
  catch { GLOBAL_MARKET_INDEX = { markets: {} }; }
  return GLOBAL_MARKET_INDEX;
}
// The browser's local-first copy: smaller, pre-normalised, no aliases/listings except where they are
// needed to display a result. Served once and cached by the browser; keystrokes never touch it again.
let GLOBAL_SEARCH_QUICK = null;
function globalSearchQuick() {
  if (GLOBAL_SEARCH_QUICK) return GLOBAL_SEARCH_QUICK;
  try { GLOBAL_SEARCH_QUICK = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'search-quick.json'), 'utf8')); }
  catch { GLOBAL_SEARCH_QUICK = { markets: {}, entries: [] }; }
  return GLOBAL_SEARCH_QUICK;
}
const GLOBAL_SEARCH_CACHE = new Map();

// The global screener's row set: one compact line per issuer, projected from the search index that is
// already in memory. The global board uses it for the market/sector totals and the screener.
let GLOBAL_ROWS_CACHE = { at: 0, rows: null };
// A company's reported EPS is not always on the vendor's TTM row. The build usually
// resolves epsTTM from net income / shares, but the company pages read reports.ttm.eps
// and history[].eps. Fill every representation once, at the API boundary, so all ten
// markets show the same EPS and the same basis note.
function normalizeCompanyEps(c) {
  if (!c || typeof c !== 'object') return c;
  const r = (c.reports = c.reports || {});
  const ttm = (r.ttm = r.ttm || {});
  const annual = Array.isArray(r.annual) ? r.annual : (r.annual = []);
  const history = Array.isArray(c.history) ? c.history : (c.history = []);
  const shares = c.sharesCurrent || c.shares || (r.latest && r.latest.shares) || null;
  const ttmNi = ttm.netIncome != null ? ttm.netIncome : (c.netIncomeTTM != null ? c.netIncomeTTM : null);
  const annualOf = (end) => annual.find((a) => String(a.end || '').slice(0, 10) === String(end || '').slice(0, 10));
  let ttmEps = null;
  let ttmBasis = null;
  if (ttm.eps != null) { ttmEps = Number(ttm.eps); ttmBasis = c.perShareBasis || 'reported TTM'; }
  else if (c.epsTTM != null) { ttmEps = Number(c.epsTTM); ttmBasis = c.epsTTMBasis || 'TTM'; }
  else if (ttmNi != null && shares > 0) { ttmEps = ttmNi / shares; ttmBasis = 'net income ÷ shares (TTM)'; }
  for (const a of annual) {
    if (a.eps == null && a.netIncome != null && a.shares > 0) a.eps = a.netIncome / a.shares;
  }
  for (const h of history) {
    if (h.eps == null) {
      const a = annualOf(h.y);
      if (a && a.eps != null) h.eps = a.eps;
      else if (h.n != null && h.shares > 0) h.eps = h.n / h.shares;
    }
  }
  const lastAnnual = annual.length ? annual[annual.length - 1] : null;
  const lastHistory = history.length ? history[history.length - 1] : null;
  const annualEps = lastAnnual && lastAnnual.eps != null ? lastAnnual.eps : (lastHistory && lastHistory.eps != null ? lastHistory.eps : null);
  if (ttmEps != null) {
    ttm.eps = ttmEps;
    c.epsTTM = ttmEps;
    if (c.epsTTMBasis == null) c.epsTTMBasis = ttmBasis;
    if (/net income/i.test(String(ttmBasis)) && c.perShareBasis == null) c.perShareBasis = ttmBasis;
  }
  if (c.eps == null && annualEps != null) c.eps = annualEps;
  if (c.epsCagr == null && c.epsChange == null && annual.length >= 2) {
    const pts = annual.filter((a) => a.eps != null);
    if (pts.length >= 2) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      const years = pts.length - 1;
      if (first.eps > 0 && last.eps > 0) {
        c.epsCagr = (Math.pow(last.eps / first.eps, 1 / years) - 1) * 100;
        c.cagrYears = c.cagrYears || years;
        if (c.epsSplitAdjusted == null) c.epsSplitAdjusted = false;
      } else {
        c.epsChange = { from: first.eps, to: last.eps, fromFy: String(first.end || '').slice(0, 4), toFy: String(last.end || '').slice(0, 4) };
      }
    }
  }
  if (c.pe == null && ttmNi > 0 && c.marketCap != null && c.currency && c.reportCurrency && c.currency === c.reportCurrency) {
    c.pe = c.marketCap / ttmNi;
    c.peBasis = 'TTM';
  }
  return c;
}

// The GLOBAL screener must not expose each exchange's native sector vocabulary: "Automobiles" is a
// Taiwan label, "Transportation Equipment" is Japan's, "Vehicles & Parts" is Korea's, and Hong Kong /
// Indonesia / Brazil / South Africa only carry the coarse GICS sector. That made a sector filter look
// like it was missing every other market. Fold the native label and the industry into one global
// vocabulary so a reader can screen automobiles across all ten markets.
const GLOBAL_SECTOR_LABELS = {
  autos: 'Automobiles',
  banks: 'Banks',
  insurance: 'Insurance',
  capital: 'Capital markets',
  tech: 'Technology',
  semis: 'Semiconductors',
  pharma: 'Pharmaceuticals & biotech',
  medtech: 'Healthcare equipment',
  consumer: 'Consumer',
  retail: 'Retail',
  industrials: 'Industrials',
  materials: 'Materials',
  energy: 'Energy',
  utilities: 'Utilities',
  realestate: 'Real estate',
  telecom: 'Telecom',
  media: 'Media',
};
function globalSectorOf(e) {
  const industry = String(e.industry || '').toLowerCase();
  const sector = String(e.sector || '').toLowerCase();
  const hay = `${industry} ${sector}`;
  // A US filer has a four-digit SIC, which is more precise than its industry string (Trane is tagged
  // "Auto Parts:O.E.M." but is HVAC). Use the SIC before the keyword rules.
  if (e.market === 'us' && e.sic) {
    const b = usBucket(e);
    if (b === 'autos') return 'Automobiles';
    if (b) return GLOBAL_SECTOR_LABELS[b] || e.sector || 'Other';
  }
  // Specific industries first: the coarse GICS sector alone cannot separate an automaker from a
  // general consumer company, or a bank from an insurer.
  if (/auto manufacturing|auto parts|automotive|auto & truck dealership|auto dealer|auto & home supply|automobile|motor vehicle|vehicle manufacturing|dealership|tyre|tire manufacturing|vehicles & parts|transportation equipment/.test(hay)) return 'Automobiles';
  if (/bank|savings|credit union|thrift/.test(industry)) return 'Banks';
  if (/insurance|insurer|reinsurance|property & casualty|life insurance/.test(industry)) return 'Insurance';
  if (/semiconductor|chip|integrated circuit|memory/.test(industry)) return 'Semiconductors';
  if (/pharma|drug|biotech|biologic|therapeutic/.test(industry)) return 'Pharmaceuticals & biotech';
  const bucket = e.market === 'us' ? usBucket(e) : (PEER_BUCKET[e.market] || {})[e.sector];
  const label = GLOBAL_SECTOR_LABELS[bucket];
  if (label) return label;
  // Native labels the bucket maps do not cover (Japan's Fishery/Agriculture, Taiwan's Electrical
  // Cable, …). Fold them into the nearest global sector rather than showing a one-market label.
  if (/construction|engineering|machinery|electrical cable|industrial|transport|logistics|shipbuilding|precision/.test(hay)) return 'Industrials';
  if (/fishery|agricultur|forest|paper|material|chemical|steel|metal|mining|cement|glass/.test(hay)) return 'Materials';
  if (/food|beverage|retail|consumer|textile|apparel|leisure|hotel|restaurant|education/.test(hay)) return 'Consumer';
  if (/media|telecom|communication/.test(hay)) return 'Media';
  if (/real estate|property|reit/.test(hay)) return 'Real estate';
  if (/health|medical|pharma|biotech|drug/.test(hay)) return 'Healthcare';
  if (/technology|semiconductor|electronic|software|computer|internet/.test(hay)) return 'Technology';
  if (/bank|financial|insurance/.test(hay)) return 'Banks';
  return e.sector || 'Other';
}

function globalRows() {
  if (GLOBAL_ROWS_CACHE.rows && Date.now() - GLOBAL_ROWS_CACHE.at < 5 * 60e3) return GLOBAL_ROWS_CACHE.rows;
  const rows = [];
  for (const e of (globalSearchIndex().entries || [])) {
    if (e.securityType === 'BDR') continue;
    rows.push({
      m: e.market, id: e.id, t: e.ticker || e.code, n: e.nameEn || e.name || e.ticker,
      s: globalSectorOf(e), native: e.sector || null, cap: e.capUsd || 0,
      pe: e.pe == null ? null : e.pe, roe: e.roe == null ? null : e.roe, ytd: e.ytd == null ? null : e.ytd,
    });
  }
  GLOBAL_ROWS_CACHE = { at: Date.now(), rows };
  return rows;
}

// ---------------------------------------------------------------------------
// Chart store — one byte-range read per chart, instead of parsing a whole market.
//
// A single company chart used to parse the market's entire history: 28 MB for Korea, up to 7 MB for
// a Taiwan/Australia bucket. On the free instance the first chart of a market could take seconds,
// and every deploy started cold. `scripts/build-chart-store.mjs` writes one line per company plus a
// byte-offset index; a request now reads only that line (a few KB). If the store is absent or a code
// is not in it, the old readers below still answer the request.
// ---------------------------------------------------------------------------
const CHART_DIR = path.join(__dirname, 'data', 'charts');
const CHART_INDEX_CACHE = new Map();   // market -> index (or null)
const CHART_LINE_CACHE = new Map();    // "market:KEY" -> { dates, closes }
const CHART_CACHE_MAX = 160;

// The source's own build stamp, read from a small prefix. A data build that rewrote the series but
// not the store leaves these two out of step; serving the store then would publish an old chart, so
// the request falls back to the (slower) live reader instead. Same first file the builder stamps.
function filePrefixStamp(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
    return m ? m[1] : null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
const CHART_SOURCES = {
  us: () => path.join(__dirname, 'data', 'us-charts.json'),
  jp: () => path.join(__dirname, 'data', 'japan-series.json'),
  kr: () => path.join(__dirname, 'data', 'korea.json'),
  tw: () => {
    const dir = path.join(__dirname, 'data', 'taiwan-series');
    try { const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; }
  },
  hk: () => {
    const dir = path.join(__dirname, 'data', 'hongkong-series');
    try { const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; }
  },
  au: () => {
    const dir = path.join(__dirname, 'data', 'australia-series');
    try { const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; }
  },
  in: () => {
    const dir = path.join(__dirname, 'data', 'india-series');
    try { const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; }
  },
  id: () => {
    const dir = path.join(__dirname, 'data', 'indonesia-series');
    try { const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; }
  },
  br: () => {
    const dir = path.join(__dirname, 'data', 'brazil-series');
    try { const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; }
  },
  za: () => {
    const dir = path.join(__dirname, 'data', 'southafrica-series');
    try { const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()[0]; return f ? path.join(dir, f) : null; } catch { return null; }
  },
};
function chartSourceStamp(market) {
  const file = CHART_SOURCES[market] ? CHART_SOURCES[market]() : null;
  return file ? filePrefixStamp(file) : null;
}

function chartIndex(market) {
  if (CHART_INDEX_CACHE.has(market)) return CHART_INDEX_CACHE.get(market);
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(CHART_DIR, `${market}.idx.json`), 'utf8'));
    if (!idx || !idx.keys || !Array.isArray(idx.dates)) throw new Error('bad index');
    // Older indexes predate the stamp; accept them rather than losing the fast path on upgrade.
    if (idx.source) {
      const src = chartSourceStamp(market);
      if (src && src !== idx.source) throw new Error('chart store is behind its source');
    }
    CHART_INDEX_CACHE.set(market, idx);
    return idx;
  } catch {
    CHART_INDEX_CACHE.set(market, null);
    return null;
  }
}

function readStoredSeries(market, code) {
  const idx = chartIndex(market);
  if (!idx) return null;
  const key = String(code || '').trim().toUpperCase();
  const span = idx.keys[key];
  if (!span) return null;
  const cacheKey = `${market}:${key}`;
  const hit = CHART_LINE_CACHE.get(cacheKey);
  if (hit) return hit;
  let fd;
  try {
    fd = fs.openSync(path.join(CHART_DIR, `${market}.ndjson`), 'r');
    const buf = Buffer.alloc(span[1]);
    const n = fs.readSync(fd, buf, 0, span[1], span[0]);
    const line = JSON.parse(buf.toString('utf8', 0, n));
    const series = seriesFromLine(line, idx.dates);
    if (series.dates.length < 2) return null;
    if (CHART_LINE_CACHE.size >= CHART_CACHE_MAX) CHART_LINE_CACHE.delete(CHART_LINE_CACHE.keys().next().value);
    CHART_LINE_CACHE.set(cacheKey, series);
    return series;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// The stored series sliced to the requested window, or null when the store cannot answer.
function storeChart(market, code, range) {
  const series = readStoredSeries(market, code);
  if (!series) return null;
  const sliced = sliceRange(series.dates, series.closes, range);
  return sliced.dates.length > 1 ? sliced : null;
}

const KOREA_FILE = path.join(__dirname, 'data', 'korea.json');
let KR_CACHE = { mtime: 0, data: null };
function readKorea() {
  try {
    const st = fs.statSync(KOREA_FILE);
    if (KR_CACHE.data && KR_CACHE.mtime === st.mtimeMs) return KR_CACHE.data;
    KR_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(KOREA_FILE, 'utf8')) };
    return KR_CACHE.data;
  } catch { return { companies: [] }; }
}

// The list endpoint needs 241 KB of fields out of a 28 MB file (the rest is five years of daily closes
// per company). Parsing the full file just to project it cost ~200 ms and ~200 MB of heap, which is
// what made the KOREA tab slow and heavy. `data/korea-list.json` is the same payload written at build
// time, so the list is read from a small file. If it is missing or does not match the current
// korea.json, fall back to the full projection — correctness first, speed when the artifact is current.
const KOREA_LIST_FILE = path.join(__dirname, 'data', 'korea-list.json');
let KR_SRC_STAMP = { mtime: 0, updated: null };
function koreaSourceUpdated() {
  try {
    const st = fs.statSync(KOREA_FILE);
    if (KR_SRC_STAMP.mtime === st.mtimeMs) return KR_SRC_STAMP.updated;
    // The build stamp is the first field in korea.json, so 256 bytes answer "is the artifact current?"
    // without parsing 28 MB. File mtimes are deliberately NOT used: a fresh checkout can give the two
    // files the same or reversed mtimes, which would send every visitor back to the full parse.
    const fd = fs.openSync(KOREA_FILE, 'r');
    let updated = null;
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      updated = m ? m[1] : null;
    } finally { fs.closeSync(fd); }
    KR_SRC_STAMP = { mtime: st.mtimeMs, updated };
    return updated;
  } catch { return null; }
}
let KR_LIST_CACHE = { key: null, data: null };
function readKoreaList() {
  try {
    const srcUpdated = koreaSourceUpdated();
    const key = `${srcUpdated}:${fs.statSync(KOREA_LIST_FILE).mtimeMs}`;
    if (KR_LIST_CACHE.data && KR_LIST_CACHE.key === key) return KR_LIST_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(KOREA_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) {
      KR_LIST_CACHE = { key, data: artifact };
      return artifact;
    }
  } catch { /* no artifact yet */ }
  return koreaList(readKorea());
}

const TAIWAN_FILE = path.join(__dirname, 'data', 'taiwan.json');
let TW_CACHE = { mtime: 0, data: null };
function readTaiwan() {
  try {
    const st = fs.statSync(TAIWAN_FILE);
    if (TW_CACHE.data && TW_CACHE.mtime === st.mtimeMs) return TW_CACHE.data;
    TW_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(TAIWAN_FILE, 'utf8')) };
    return TW_CACHE.data;
  } catch { return { companies: [] }; }
}
const TAIWAN_LIST_FILE = path.join(__dirname, 'data', 'taiwan-list.json');
let TWL_CACHE = { key: null, data: null };
function taiwanSourceUpdated() {
  try {
    const st = fs.statSync(TAIWAN_FILE);
    const fd = fs.openSync(TAIWAN_FILE, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function readTaiwanList() {
  try {
    const srcUpdated = taiwanSourceUpdated();
    const key = `${srcUpdated}:${fs.statSync(TAIWAN_LIST_FILE).mtimeMs}`;
    if (TWL_CACHE.data && TWL_CACHE.key === key) return TWL_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(TAIWAN_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) { TWL_CACHE = { key, data: artifact }; return artifact; }
  } catch { /* no artifact yet */ }
  return taiwanList(readTaiwan());
}
const TAIWAN_SERIES_DIR = path.join(__dirname, 'data', 'taiwan-series');
const TW_SERIES_CACHE = new Map();   // one 2 MB bucket, not the whole 23 MB market, per chart
function readTaiwanSeries(code) {
  const b = String(code || '')[0];
  if (!/^[0-9]$/.test(b)) return { daily: {}, weekly: {} };
  const f = path.join(TAIWAN_SERIES_DIR, `${b}.json`);
  try {
    const st = fs.statSync(f);
    const hit = TW_SERIES_CACHE.get(b);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (TW_SERIES_CACHE.size >= 2) TW_SERIES_CACHE.delete(TW_SERIES_CACHE.keys().next().value);
    TW_SERIES_CACHE.set(b, { mtime: st.mtimeMs, data });
    return data;
  } catch { return { daily: {}, weekly: {} }; }
}

const HONGKONG_FILE = path.join(__dirname, 'data', 'hongkong.json');
let HKG_CACHE = { mtime: 0, data: null };
function readHongKong() {
  try {
    const st = fs.statSync(HONGKONG_FILE);
    if (HKG_CACHE.data && HKG_CACHE.mtime === st.mtimeMs) return HKG_CACHE.data;
    HKG_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(HONGKONG_FILE, 'utf8')) };
    return HKG_CACHE.data;
  } catch { return { companies: [] }; }
}
const HONGKONG_LIST_FILE = path.join(__dirname, 'data', 'hongkong-list.json');
let HKGL_CACHE = { key: null, data: null };
function hongkongSourceUpdated() {
  try {
    const fd = fs.openSync(HONGKONG_FILE, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function readHongKongList() {
  try {
    const srcUpdated = hongkongSourceUpdated();
    const key = `${srcUpdated}:${fs.statSync(HONGKONG_LIST_FILE).mtimeMs}`;
    if (HKGL_CACHE.data && HKGL_CACHE.key === key) return HKGL_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(HONGKONG_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) { HKGL_CACHE = { key, data: artifact }; return artifact; }
  } catch { /* no artifact yet */ }
  return hongkongList(readHongKong());
}
const HONGKONG_SERIES_DIR = path.join(__dirname, 'data', 'hongkong-series');const HKG_SERIES_CACHE = new Map();   // one bucket per chart, not the whole market
function readHongKongSeries(code) {
  const b = String(code || '').slice(0, 2);
  if (!/^\d{2}$/.test(b)) return { daily: {}, weekly: {} };
  const f = path.join(HONGKONG_SERIES_DIR, `${b}.json`);
  try {
    const st = fs.statSync(f);
    const hit = HKG_SERIES_CACHE.get(b);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (HKG_SERIES_CACHE.size >= 2) HKG_SERIES_CACHE.delete(HKG_SERIES_CACHE.keys().next().value);
    HKG_SERIES_CACHE.set(b, { mtime: st.mtimeMs, data });
    return data;
  } catch { return { daily: {}, weekly: {} }; }
}

const AUSTRALIA_FILE = path.join(__dirname, 'data', 'australia.json');
let AU_CACHE = { mtime: 0, data: null };
function readAustralia() {
  try {
    const st = fs.statSync(AUSTRALIA_FILE);
    if (AU_CACHE.data && AU_CACHE.mtime === st.mtimeMs) return AU_CACHE.data;
    AU_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(AUSTRALIA_FILE, 'utf8')) };
    return AU_CACHE.data;
  } catch { return { companies: [] }; }
}
const AUSTRALIA_LIST_FILE = path.join(__dirname, 'data', 'australia-list.json');
let AUL_CACHE = { key: null, data: null };
function australiaSourceUpdated() {
  try {
    const fd = fs.openSync(AUSTRALIA_FILE, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function readAustraliaList() {
  try {
    const srcUpdated = australiaSourceUpdated();
    const key = `${srcUpdated}:${fs.statSync(AUSTRALIA_LIST_FILE).mtimeMs}`;
    if (AUL_CACHE.data && AUL_CACHE.key === key) return AUL_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(AUSTRALIA_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) { AUL_CACHE = { key, data: artifact }; return artifact; }
  } catch { /* no artifact yet */ }
  return australiaList(readAustralia());
}
// The company page reads one small file. Parsing the whole 8 MB dataset for one record held ~50 MB of
// JS objects on the free instance, which (with the chart buckets and the warm caches) caused OOM 502s.
const AUSTRALIA_DETAIL_DIR = path.join(__dirname, 'data', 'australia-companies');
function readAustraliaCompany(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(c)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(AUSTRALIA_DETAIL_DIR, `${c}.json`), 'utf8')); }
  catch { return null; }
}
const HONGKONG_DETAIL_DIR = path.join(__dirname, 'data', 'hongkong-companies');
function readHongKongCompany(code) {
  const c = String(code || '').trim();
  if (!/^\d{4}$/.test(c)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(HONGKONG_DETAIL_DIR, `${c}.json`), 'utf8')); }
  catch { return null; }
}

// Japan, Korea and Taiwan keep their companies in one big file, and the company page only needs one
// record. Parsing japan.json (5 MB), korea.json (28 MB — 24 MB of it is daily closes the detail page
// never draws) or taiwan.json (5 MB) on every open is what put "Reading the filing…" in front of the
// page on the free instance. scripts/build-company-details.mjs writes one small file per company; the
// `_stamp.json` beside them carries the source's own `updated` field, so a market rebuild that did not
// regenerate these files falls back to the old reader instead of serving stale numbers.
const JAPAN_DETAIL_DIR = path.join(__dirname, 'data', 'japan-companies');
const KOREA_DETAIL_DIR = path.join(__dirname, 'data', 'korea-companies');
const TAIWAN_DETAIL_DIR = path.join(__dirname, 'data', 'taiwan-companies');
const DETAIL_STAMP_CACHE = new Map();   // dir -> { key, ok }
function detailDirCurrent(dir, sourceUpdated) {
  if (!sourceUpdated) return false;
  try {
    const st = fs.statSync(path.join(dir, '_stamp.json'));
    const key = `${st.mtimeMs}:${sourceUpdated}`;
    const hit = DETAIL_STAMP_CACHE.get(dir);
    if (hit && hit.key === key) return hit.ok;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '_stamp.json'), 'utf8'));
    const ok = !!meta && meta.updated === sourceUpdated;
    DETAIL_STAMP_CACHE.set(dir, { key, ok });
    return ok;
  } catch { return false; }
}
function readDetailCompany(dir, code, sourceUpdated) {
  if (!detailDirCurrent(dir, sourceUpdated)) return null;
  const k = String(code || '').trim();
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(k)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${k}.json`), 'utf8')); }
  catch { return null; }
}
function readJapanCompany(code) { return readDetailCompany(JAPAN_DETAIL_DIR, code, filePrefixStamp(path.join(__dirname, 'data', 'japan.json'))); }
// A detail file built before the growth fields existed still serves them: the five fiscal years are
// already in the record, so the same rules the US page uses can be applied on read. Once the next
// Japan build bakes them in, this is a no-op.
function withJapanGrowth(c) {
  if (!c || Object.prototype.hasOwnProperty.call(c, 'revenueCagr')) return c;
  return { ...c, ...growthRates(fromJapanHistory(c.history)) };
}
function readKoreaCompany(code) { return readDetailCompany(KOREA_DETAIL_DIR, code, koreaSourceUpdated()); }
function readTaiwanCompany(code) { return readDetailCompany(TAIWAN_DETAIL_DIR, code, taiwanSourceUpdated()); }
const AUSTRALIA_SERIES_DIR = path.join(__dirname, 'data', 'australia-series');
const AUS_SERIES_CACHE = new Map();   // one letter bucket per chart, not the whole market
function readAustraliaSeries(code) {
  const b = String(code || '').slice(0, 1).toUpperCase();
  if (!/^[A-Z0-9]$/.test(b)) return { daily: {}, weekly: {} };
  const f = path.join(AUSTRALIA_SERIES_DIR, `${b}.json`);
  try {
    const st = fs.statSync(f);
    const hit = AUS_SERIES_CACHE.get(b);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (AUS_SERIES_CACHE.size >= 2) AUS_SERIES_CACHE.delete(AUS_SERIES_CACHE.keys().next().value);
    AUS_SERIES_CACHE.set(b, { mtime: st.mtimeMs, data });
    return data;
  } catch { return { daily: {}, weekly: {} }; }
}


const INDIA_FILE = path.join(__dirname, 'data', 'india.json');
let IN_CACHE = { mtime: 0, data: null };
function readIndia() {
  try {
    const st = fs.statSync(INDIA_FILE);
    if (IN_CACHE.data && IN_CACHE.mtime === st.mtimeMs) return IN_CACHE.data;
    IN_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(INDIA_FILE, 'utf8')) };
    return IN_CACHE.data;
  } catch { return { companies: [] }; }
}
const INDIA_LIST_FILE = path.join(__dirname, 'data', 'india-list.json');
let INL_CACHE = { key: null, data: null };
function indiaSourceUpdated() {
  try {
    const fd = fs.openSync(INDIA_FILE, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function readIndiaList() {
  try {
    const srcUpdated = indiaSourceUpdated();
    const key = `${srcUpdated}:${fs.statSync(INDIA_LIST_FILE).mtimeMs}`;
    if (INL_CACHE.data && INL_CACHE.key === key) return INL_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(INDIA_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) { INL_CACHE = { key, data: artifact }; return artifact; }
  } catch { /* no artifact yet */ }
  return indiaList(readIndia());
}
// One small file per company, the same reason Australia and Hong Kong have one: parsing the whole
// market to return one record costs the free instance ~50 MB.
const INDIA_DETAIL_DIR = path.join(__dirname, 'data', 'india-companies');
function readIndiaCompany(code) {
  // NSE symbols are upper case and may carry '&' or '-', which are file-name safe but must be exact.
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9&-]{1,20}$/.test(c)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(INDIA_DETAIL_DIR, `${c}.json`), 'utf8')); }
  catch { return null; }
}
const INDIA_SERIES_DIR = path.join(__dirname, 'data', 'india-series');
const IND_SERIES_CACHE = new Map();   // one letter bucket per chart, not the whole market
function readIndiaSeries(code) {
  const b = String(code || '').slice(0, 1).toUpperCase();
  if (!/^[A-Z0-9]$/.test(b)) return { daily: {}, weekly: {} };
  const f = path.join(INDIA_SERIES_DIR, `${b}.json`);
  try {
    const st = fs.statSync(f);
    const hit = IND_SERIES_CACHE.get(b);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (IND_SERIES_CACHE.size >= 2) IND_SERIES_CACHE.delete(IND_SERIES_CACHE.keys().next().value);
    IND_SERIES_CACHE.set(b, { mtime: st.mtimeMs, data });
    return data;
  } catch { return { daily: {}, weekly: {} }; }
}

const INDONESIA_FILE = path.join(__dirname, 'data', 'indonesia.json');
let IDN_CACHE = { mtime: 0, data: null };
function readIndonesia() {
  try {
    const st = fs.statSync(INDONESIA_FILE);
    if (IDN_CACHE.data && IDN_CACHE.mtime === st.mtimeMs) return IDN_CACHE.data;
    IDN_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(INDONESIA_FILE, 'utf8')) };
    return IDN_CACHE.data;
  } catch { return { companies: [] }; }
}
const INDONESIA_LIST_FILE = path.join(__dirname, 'data', 'indonesia-list.json');
let IDNL_CACHE = { key: null, data: null };
function indonesiaSourceUpdated() {
  try {
    const fd = fs.openSync(INDONESIA_FILE, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function readIndonesiaList() {
  try {
    const srcUpdated = indonesiaSourceUpdated();
    const key = `${srcUpdated}:${fs.statSync(INDONESIA_LIST_FILE).mtimeMs}`;
    if (IDNL_CACHE.data && IDNL_CACHE.key === key) return IDNL_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(INDONESIA_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) { IDNL_CACHE = { key, data: artifact }; return artifact; }
  } catch { /* no artifact yet */ }
  return indonesiaList(readIndonesia());
}
// One small file per company, the same reason Australia, Hong Kong and India have one: parsing the whole
// market to return one record costs the free instance ~50 MB.
const INDONESIA_DETAIL_DIR = path.join(__dirname, 'data', 'indonesia-companies');
function readIndonesiaCompany(code) {
  // IDX symbols are four upper-case letters/digits, and the file name is the ticker itself.
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(c)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(INDONESIA_DETAIL_DIR, `${c}.json`), 'utf8')); }
  catch { return null; }
}
const INDONESIA_SERIES_DIR = path.join(__dirname, 'data', 'indonesia-series');
const IDN_SERIES_CACHE = new Map();   // one letter bucket per chart, not the whole market
function readIndonesiaSeries(code) {
  const b = String(code || '').slice(0, 1).toUpperCase();
  if (!/^[A-Z0-9]$/.test(b)) return { daily: {}, weekly: {} };
  const f = path.join(INDONESIA_SERIES_DIR, `${b}.json`);
  try {
    const st = fs.statSync(f);
    const hit = IDN_SERIES_CACHE.get(b);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (IDN_SERIES_CACHE.size >= 2) IDN_SERIES_CACHE.delete(IDN_SERIES_CACHE.keys().next().value);
    IDN_SERIES_CACHE.set(b, { mtime: st.mtimeMs, data });
    return data;
  } catch { return { daily: {}, weekly: {} }; }
}

const BRAZIL_FILE = path.join(__dirname, 'data', 'brazil.json');
let BRZ_CACHE = { mtime: 0, data: null };
function readBrazil() {
  try {
    const st = fs.statSync(BRAZIL_FILE);
    if (BRZ_CACHE.data && BRZ_CACHE.mtime === st.mtimeMs) return BRZ_CACHE.data;
    BRZ_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(BRAZIL_FILE, 'utf8')) };
    return BRZ_CACHE.data;
  } catch { return { companies: [] }; }
}
const BRAZIL_LIST_FILE = path.join(__dirname, 'data', 'brazil-list.json');
let BRZL_CACHE = { key: null, data: null };
function brazilSourceUpdated() {
  try {
    const fd = fs.openSync(BRAZIL_FILE, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function readBrazilList() {
  try {
    const srcUpdated = brazilSourceUpdated();
    const key = `${srcUpdated}:${fs.statSync(BRAZIL_LIST_FILE).mtimeMs}`;
    if (BRZL_CACHE.data && BRZL_CACHE.key === key) return BRZL_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(BRAZIL_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) { BRZL_CACHE = { key, data: artifact }; return artifact; }
  } catch { /* no artifact yet */ }
  return brazilList(readBrazil());
}
const BRAZIL_DETAIL_DIR = path.join(__dirname, 'data', 'brazil-companies');
function readBrazilCompany(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,7}$/.test(c)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(BRAZIL_DETAIL_DIR, `${c}.json`), 'utf8')); }
  catch { return null; }
}
const BRAZIL_SERIES_DIR = path.join(__dirname, 'data', 'brazil-series');
const BRZ_SERIES_CACHE = new Map();
function readBrazilSeries(code) {
  const b = String(code || '').slice(0, 1).toUpperCase();
  if (!/^[A-Z0-9]$/.test(b)) return { daily: {}, weekly: {} };
  const f = path.join(BRAZIL_SERIES_DIR, `${b}.json`);
  try {
    const st = fs.statSync(f);
    const hit = BRZ_SERIES_CACHE.get(b);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (BRZ_SERIES_CACHE.size >= 2) BRZ_SERIES_CACHE.delete(BRZ_SERIES_CACHE.keys().next().value);
    BRZ_SERIES_CACHE.set(b, { mtime: st.mtimeMs, data });
    return data;
  } catch { return { daily: {}, weekly: {} }; }
}

const SOUTHAFRICA_FILE = path.join(__dirname, 'data', 'southafrica.json');
let ZA_CACHE = { mtime: 0, data: null };
function readSouthAfrica() {
  try {
    const st = fs.statSync(SOUTHAFRICA_FILE);
    if (ZA_CACHE.data && ZA_CACHE.mtime === st.mtimeMs) return ZA_CACHE.data;
    ZA_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(SOUTHAFRICA_FILE, 'utf8')) };
    return ZA_CACHE.data;
  } catch { return { companies: [] }; }
}
const SOUTHAFRICA_LIST_FILE = path.join(__dirname, 'data', 'southafrica-list.json');
let ZAL_CACHE = { key: null, data: null };
function southafricaSourceUpdated() {
  try {
    const fd = fs.openSync(SOUTHAFRICA_FILE, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function readSouthAfricaList() {
  try {
    const srcUpdated = southafricaSourceUpdated();
    const key = `${srcUpdated}:${fs.statSync(SOUTHAFRICA_LIST_FILE).mtimeMs}`;
    if (ZAL_CACHE.data && ZAL_CACHE.key === key) return ZAL_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(SOUTHAFRICA_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) { ZAL_CACHE = { key, data: artifact }; return artifact; }
  } catch { /* no artifact yet */ }
  return southafricaList(readSouthAfrica());
}
const SOUTHAFRICA_DETAIL_DIR = path.join(__dirname, 'data', 'southafrica-companies');
function readSouthAfricaCompany(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(c)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(SOUTHAFRICA_DETAIL_DIR, `${c}.json`), 'utf8')); }
  catch { return null; }
}
const SOUTHAFRICA_SERIES_DIR = path.join(__dirname, 'data', 'southafrica-series');
const ZA_SERIES_CACHE = new Map();
function readSouthAfricaSeries(code) {
  const b = String(code || '').slice(0, 1).toUpperCase();
  if (!/^[A-Z0-9]$/.test(b)) return { daily: {}, weekly: {} };
  const f = path.join(SOUTHAFRICA_SERIES_DIR, `${b}.json`);
  try {
    const st = fs.statSync(f);
    const hit = ZA_SERIES_CACHE.get(b);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (ZA_SERIES_CACHE.size >= 2) ZA_SERIES_CACHE.delete(ZA_SERIES_CACHE.keys().next().value);
    ZA_SERIES_CACHE.set(b, { mtime: st.mtimeMs, data });
    return data;
  } catch { return { daily: {}, weekly: {} }; }
}

const JAPAN_FILE = path.join(__dirname, 'data', 'japan.json');
let JP_CACHE = { mtime: 0, data: null };
function readJapan() {
  try {
    const st = fs.statSync(JAPAN_FILE);
    if (JP_CACHE.data && JP_CACHE.mtime === st.mtimeMs) return JP_CACHE.data;
    JP_CACHE = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(JAPAN_FILE, 'utf8')) };
    return JP_CACHE.data;
  } catch { return { companies: [] }; }
}

// The projected list artifact. /api/japan, the search index and the peer index all need only the list
// fields; parsing the 5.5 MB source for them cost ~40 ms and ~50 MB of objects, and the first search
// or peer lookup paid it even on a US page — which put that work on the event loop in front of the
// company chart. If the artifact is missing or older than its source, fall back to the projection.
const JAPAN_LIST_FILE = path.join(__dirname, 'data', 'japan-list.json');
let JAPAN_LIST_CACHE = { key: null, data: null };
function readJapanList() {
  try {
    const srcUpdated = filePrefixStamp(JAPAN_FILE);
    const key = `${srcUpdated}:${fs.statSync(JAPAN_LIST_FILE).mtimeMs}`;
    if (JAPAN_LIST_CACHE.data && JAPAN_LIST_CACHE.key === key) return JAPAN_LIST_CACHE.data;
    const artifact = JSON.parse(fs.readFileSync(JAPAN_LIST_FILE, 'utf8'));
    if (artifact.updated && artifact.updated === srcUpdated) { JAPAN_LIST_CACHE = { key, data: artifact }; return artifact; }
  } catch { /* no artifact yet */ }
  return japanList(readJapan());
}

// The HOME summary: ten market tiles and three idea counts, without shipping ten company lists to the
// browser. Index levels come from data/market-index.json; breadth and medians come from each market's
// committed list artifact (US from companies.json). Cached for five minutes; the inputs change daily.
let HOME_CACHE = { at: 0, data: null };
function homeSummary() {
  if (HOME_CACHE.data && Date.now() - HOME_CACHE.at < 5 * 60e3) return HOME_CACHE.data;
  const median = (xs) => {
    const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
  };
  const mi = globalMarketIndex();
  const lists = {
    jp: readJapanList(), kr: readKoreaList(), tw: readTaiwanList(), hk: readHongKongList(),
    au: readAustraliaList(), in: readIndiaList(), id: readIndonesiaList(), br: readBrazilList(), za: readSouthAfricaList(),
  };
  const us = COMPANIES.companies || [];
  const usAdv = us.filter((c) => (c.chg1d || 0) > 0).length;
  const usDec = us.filter((c) => (c.chg1d || 0) < 0).length;
  const usPe = median(us.map((c) => (c.pe > 0 && c.pe < 500 ? c.pe : null)));
  // Global totals and the sector split, from the same row set the screener uses.
  const grow = globalRows();
  const capByMarket = {};
  let totalCapUsd = 0;
  for (const r of grow) { capByMarket[r.m] = (capByMarket[r.m] || 0) + r.cap; totalCapUsd += r.cap; }
  const medianPe = median(grow.map((r) => (r.pe > 0 && r.pe < 500 ? r.pe : null)));
  const sectorCap = {};
  for (const r of grow) sectorCap[r.s] = (sectorCap[r.s] || 0) + r.cap;
  const sectors = Object.entries(sectorCap).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, cap]) => ({ name, cap }));
  const out = [];
  const add = (id, label, idx, count, adv, dec, pe) => {
    if (!idx) return;
    out.push({
      id, label,
      index: idx.label, level: idx.level,
      chg1d: idx.pct1d ?? idx.chg1d ?? null,
      chgYtd: idx.pctYtd ?? idx.chgYtd ?? null,
      count, adv, dec, pe,
      capUsd: capByMarket[id] || 0,
    });
  };
  const usg = mi.markets && mi.markets.us;
  add('us', 'United States', usg && usg.indices && usg.indices[usg.default], us.length, usAdv, usDec, usPe);
  for (const [id, label] of [['jp', 'Japan'], ['kr', 'Korea'], ['tw', 'Taiwan'], ['hk', 'Hong Kong'], ['au', 'Australia'], ['in', 'India'], ['id', 'Indonesia'], ['br', 'Brazil'], ['za', 'South Africa']]) {
    const list = lists[id];
    const g = mi.markets && mi.markets[id];
    const idx = g && g.indices && g.indices[g.default];
    const m = (list && list.market) || {};
    add(id, label, idx, m.companies ?? (list && list.companies ? list.companies.length : 0), m.advancing ?? null, m.declining ?? null, m.medianPe ?? null);
  }
  // The same rules used on the company pages: a P/E percentile is the valuation signal; quality is
  // high ROE without a premium multiple. Counted across every market, one share class per company.
  let cheap = 0, quality = 0, total = 0;
  const scan = (rows) => {
    for (const c of rows || []) {
      if (c.shareClass === true) continue;
      total++;
      const p = c.bands && c.bands.pe ? c.bands.pe.percentile : (c.peHistory ? c.peHistory.percentile : null);
      if (p != null && p <= 20 && c.pe > 0) cheap++;
      if (c.roe >= 15 && c.pe > 0 && c.pe <= 20) quality++;
    }
  };
  scan(us);
  for (const l of Object.values(lists)) scan(l.companies);
  // Global top companies by USD market cap, one class per issuer. Used on the global board.
  const allRows = [];
  const collect = (rows, market, rate) => {
    for (const c of rows || []) {
      if (c.shareClass === true || c.bdr || !(c.marketCap > 0)) continue;
      allRows.push({
        market, ticker: c.ticker || c.code, name: c.nameEn || c.name,
        capUsd: market === 'us' ? c.marketCap : c.marketCap / (rate || 1),
        pe: c.pe ?? null, chgYtd: c.chgYtd ?? null, sector: c.sector || c.industry || null,
      });
    }
  };
  collect(us, 'us', 1);
  for (const [id, list] of Object.entries(lists)) collect(list.companies, id, list.fx && list.fx.rate);
  allRows.sort((a, b) => b.capUsd - a.capUsd);
  const top = allRows.slice(0, 12);
  let filings = 0;
  try { filings = (JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'filings-changed.json'), 'utf8')).tickers || []).length; } catch { /* none */ }
  const pricesAsOf = Object.values(mi.markets || {})
    .map((g) => g && g.indices && g.indices[g.default] && g.indices[g.default].date)
    .filter(Boolean).sort().pop() || mi.updated || null;
  const data = {
    updated: new Date().toISOString(),
    pricesAsOf,
    companies: total,
    markets: out,
    totalCapUsd,
    medianPe,
    sectors,
    adv: out.reduce((a, m) => a + (m.adv || 0), 0),
    dec: out.reduce((a, m) => a + (m.dec || 0), 0),
    best: out.slice().sort((a, b) => (b.chgYtd ?? -1e9) - (a.chgYtd ?? -1e9))[0] || null,
    worst: out.slice().sort((a, b) => (a.chgYtd ?? 1e9) - (b.chgYtd ?? 1e9))[0] || null,
    top,
    ideas: { cheap, quality, filings },
  };
  HOME_CACHE = { at: Date.now(), data };
  return data;
}

// A global theme is the union of the same idea across the ten local theme registers. The local files
// name the same concept differently (us:ai, kr:semis, tw:ai-hardware, …); the map is deliberately
// explicit so a rename in one market does not silently lose its members from the global lens.
const GLOBAL_THEME_DEFS = [
  {
    id: 'ai', label: 'AI & SEMICONDUCTORS',
    maps: { us: 'ai', jp: 'ai', kr: 'semis', tw: 'semis', hk: 'semis' },
    extras: {
      us: ['NVDA', 'AVGO', 'AMD', 'MU', 'AMAT', 'LRCX', 'KLAC'],
      tw: ['2330', '2454', '2317', '3711'],
      kr: ['005930', '000660'],
      jp: ['8035', '6857', '6146'],
      hk: ['0981', '1347'],
    },
  },
  { id: 'defence', label: 'DEFENCE', maps: { us: 'defence', jp: 'defence', kr: 'defence', in: 'psu-capex' } },
  { id: 'energy', label: 'ENERGY & POWER', maps: { us: 'energy-us', hk: 'energy', au: 'energy', in: 'energy', id: 'coal', br: 'oil', za: 'energy' } },
  { id: 'banks', label: 'BANKS & FINANCIALS', maps: { us: 'financials', jp: 'banks-jp', kr: 'banks', tw: 'financials', hk: 'banks', au: 'banks', in: 'banks', id: 'banks', br: 'banks', za: 'banks' } },
  { id: 'mining', label: 'METALS & MINING', maps: { au: 'materials', br: 'mining', za: 'mining', id: 'nickel' } },
];
let GLOBAL_THEME_CACHE = { at: 0, data: null };
function globalThemes() {
  if (GLOBAL_THEME_CACHE.data && Date.now() - GLOBAL_THEME_CACHE.at < 5 * 60e3) return GLOBAL_THEME_CACHE.data;
  const lists = {
    us: { companies: COMPANIES.companies || [], fx: { rate: 1 } },
    jp: readJapanList(), kr: readKoreaList(), tw: readTaiwanList(), hk: readHongKongList(),
    au: readAustraliaList(), in: readIndiaList(), id: readIndonesiaList(), br: readBrazilList(), za: readSouthAfricaList(),
  };
  const THEME_FILE = {
    us: 'us', jp: 'japan', kr: 'korea', tw: 'taiwan', hk: 'hongkong',
    au: 'australia', in: 'india', id: 'indonesia', br: 'brazil', za: 'southafrica',
  };
  const themeFiles = {};
  for (const id of Object.keys(lists)) {
    try { themeFiles[id] = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', `${THEME_FILE[id]}-themes.json`), 'utf8')).themes || []; }
    catch { themeFiles[id] = []; }
  }
  const lookup = {};
  for (const [id, l] of Object.entries(lists)) {
    lookup[id] = new Map();
    for (const c of l.companies || []) {
      if (c.shareClass === true || c.bdr) continue;
      // Some markets file the listed code and the DART/JPX code separately (Japan: 7203 vs 72030).
      // A local theme may use either, so index both.
      if (c.ticker) lookup[id].set(String(c.ticker), c);
      if (c.code) lookup[id].set(String(c.code), c);
    }
  }
  const themes = GLOBAL_THEME_DEFS.map((def) => {
    const seen = new Set();
    const members = [];
    for (const [market, themeId] of Object.entries(def.maps || {})) {
      const local = (themeFiles[market] || []).find((t) => t.id === themeId);
      const codes = [...((local && (local.codes || local.tickers)) || []), ...((def.extras && def.extras[market]) || [])];
      const fx = (lists[market].fx && lists[market].fx.rate) || 1;
      for (const code of codes) {
        const key = String(code);
        const c = lookup[market].get(key);
        if (!c) continue;
        const id = `${market}:${c.ticker || c.code}`;
        if (seen.has(id)) continue;
        seen.add(id);
        members.push({
          market, ticker: c.ticker || c.code, name: c.nameEn || c.name,
          id: c.cik || c.code || c.ticker,
          capUsd: market === 'us' ? c.marketCap : c.marketCap / fx,
          pe: c.pe ?? null, chgYtd: c.chgYtd ?? null, sector: c.sector || c.industry || null,
        });
      }
    }
    members.sort((a, b) => (b.capUsd || 0) - (a.capUsd || 0));
    // Keep the theme genuinely global: every mapped market gets a seat before the remaining slots go
    // to the largest names. Otherwise the US mega-caps crowd out Japan, Hong Kong and the smaller
    // markets and a "global" theme reads like a US screen.
    const byMarket = {};
    for (const m of members) (byMarket[m.market] = byMarket[m.market] || []).push(m);
    const seat = Object.keys(byMarket).length <= 6 ? 2 : 1;
    const chosen = [];
    const chosenIds = new Set();
    for (const [market, list] of Object.entries(byMarket)) {
      for (const m of list.slice(0, seat)) { chosen.push(m); chosenIds.add(`${m.market}:${m.ticker}`); }
    }
    for (const m of members) {
      if (chosen.length >= 12) break;
      const id = `${m.market}:${m.ticker}`;
      if (!chosenIds.has(id)) { chosen.push(m); chosenIds.add(id); }
    }
    const topMembers = chosen.slice(0, 12).sort((a, b) => (b.capUsd || 0) - (a.capUsd || 0));
    const capByMarket = {};
    for (const m of topMembers) capByMarket[m.market] = (capByMarket[m.market] || 0) + (m.capUsd || 0);
    const topTotal = topMembers.reduce((a, m) => a + (m.capUsd || 0), 0);
    const totalCap = members.reduce((a, m) => a + (m.capUsd || 0), 0);
    const mix = Object.entries(capByMarket).map(([market, cap]) => ({ market, pct: topTotal ? +(cap / topTotal * 100).toFixed(0) : 0 })).sort((a, b) => b.pct - a.pct);
    return {
      id: def.id, label: def.label,
      count: members.length,
      markets: [...new Set(members.map((m) => m.market))].length,
      totalCap,
      mix,
      members: topMembers,
    };
  });
  const data = { updated: new Date().toISOString(), themes };
  GLOBAL_THEME_CACHE = { at: Date.now(), data };
  return data;
}

const DEAL_ARCHIVE = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ma.json'), 'utf8')); } catch { return { deals: [], coverage: {} }; } })();
const DEAL_STORE_FILE = path.join(__dirname, 'data', 'deals-store.json');
import { DEAL_SECTOR_RULES, dealSector, DEAL_SITES, DEAL_RUMOUR, DEAL_CLOSED, DEAL_ENDED, eventStatus,
  STATUS_RANK, CHANNELS, nameKey, parseDealTitle, validName, mergeEvent, inferStatus, dealType } from './src/deals.js';
let STORE = (() => { try { const j = JSON.parse(fs.readFileSync(DEAL_STORE_FILE, 'utf8')); return Array.isArray(j.deals) ? j : { deals: [] }; } catch { return { deals: [] }; } })();

function seedFromArchive() {
  for (const a of (DEAL_ARCHIVE.deals || [])) {
    const key = `${nameKey(a.target)}|${nameKey(a.acquirer)}`;
    // A wire entity for the same target may already exist. The filing does not create a second row —
    // it upgrades that one to verified and fills in the value, advisers and rationale.
    const existing = STORE.deals.find((d) => d.key === key || nameKey(d.target) === nameKey(a.target));
    if (existing) {
      existing.verified = true;
      existing.value = a.value || existing.value;
      existing.rationale = a.rationale || existing.rationale;
      if ((a.advisers || []).length) existing.advisers = a.advisers;
      existing.closed = a.closed || existing.closed;
      existing.url = a.url || existing.url;
      existing.source = a.source || existing.source;
      if (!existing.acquirer) existing.acquirer = a.acquirer;
      if (a.closed) existing.status = 'closed';
      if (!existing.events.some((e) => e.url === a.url)) {
        existing.events.unshift({ date: a.date, status: 'announced', title: `${a.acquirer} to acquire ${a.target}`, source: a.source || 'filing', url: a.url || null });
      }
      continue;
    }
    STORE.deals.push({
      key, acquirer: a.acquirer, target: a.target, sector: a.sector || dealSector(`${a.acquirer} ${a.target}`),
      value: a.value || null, status: a.closed ? 'closed' : 'announced', verified: true,
      date: a.date, lastSeen: a.closed || a.date, closed: a.closed || null,
      rationale: a.rationale || null, advisers: a.advisers || [], url: a.url || null, source: a.source || 'filing',
      events: [
        { date: a.date, status: 'announced', title: `${a.acquirer} to acquire ${a.target}`, source: a.source || 'filing', url: a.url || null },
        ...(a.closed ? [{ date: a.closed, status: 'closed', title: `${a.acquirer} completes the acquisition of ${a.target}`, source: a.source || 'filing', url: a.url || null }] : []),
      ],
    });
  }
}

let dealsSeeded = false;
function ensureSeeded() {
  if (dealsSeeded) return;
  dealsSeeded = true;
  seedFromArchive();
  try {   // the wire log collected before the store existed
    const log = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'deals-log.json'), 'utf8'));
    for (const w of (log.deals || [])) {
      if (!w.title) continue;
      attachEvent({ date: w.date, status: w.status || eventStatus(w.title), title: w.title, source: w.source, url: w.url, acquirer: w.acquirer, target: w.target, value: w.value, sector: w.sector || dealSector(w.title) });
    }
  } catch {}
}

const attachEvent = (ev) => mergeEvent(STORE, ev);

async function refreshDeals() {
  ensureSeeded();                       // the brief can reach the store before /api/deals ever does
  return cached('dealstore', 600e3, async () => {
    // The channels are independent searches — run them together instead of one round-trip after
    // another (this is on the brief's critical path). The attach order stays the same.
    const batches = await Promise.all(CHANNELS.map((ch) =>
      fetchGoogleNews(`${ch.q} ${DEAL_SITES}`, 60).catch(() => []).then((items) => ({ ch, items }))));
    for (const { ch, items } of batches) {
      for (const it of items) {
        const t = String(it.title || '');
        if (!it.source || !TIER1_RE.test(it.source)) continue;
        if (!/\b(acquire|acquisition|merger|takeover|to buy|buys|stake in|deal)\b/i.test(t)) continue;
        if (/\b(fighter jets?|military|weapons?|missiles?|pentagon|nato|arms deal|defence ministry|defense department)\b/i.test(t)) continue;
        if (/\b(lawyers?|law firm|hires?|appoints?|names? (?:a )?new)\b/i.test(t)) continue;
        if (/\b(upgraded to buy|downgraded|price target|rating|overweight|outperform|analyst|trial|lawsuit|antitrust case)\b/i.test(t)) continue;
        if (/\b(fortune|billionaire|wealth|pegs|cost estimate|would cost|supply (?:deal|agreement)|to 20\d\d)\b/i.test(t)) continue;
        if (ch.needValue && !/\$\s?[\d.]+\s?(?:billion|million)/i.test(t)) continue;
        const p = parseDealTitle(t);
        if (!p.acquirer && !p.value && !p.target) continue;
        attachEvent({ date: it.date ? it.date.slice(0, 10) : new Date().toISOString().slice(0, 10), status: eventStatus(t), title: t, source: it.source, url: it.url, ...p, sector: dealSector(t) });
      }
    }
    STORE.deals.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    STORE.updated = new Date().toISOString();
    try { fs.writeFileSync(DEAL_STORE_FILE, JSON.stringify(STORE)); } catch {}
    return STORE;
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
// One search box for three markets. A reader types "jpmorgan", not "us:JPM" — so the compare box asks
// this endpoint and gets back refs it can chart, with the market spelled out.
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let SEARCH_INDEX = null;
function searchIndex() {
  if (SEARCH_INDEX) return SEARCH_INDEX;
  const rows = [];
  const add = (market, ticker, name, extra = [], cap = 0) => {
    if (!ticker || !name) return;
    rows.push({
      ref: `${market}:${ticker}`, market, ticker, name, cap,
      n: norm(name), t: norm(ticker), first: norm(String(name).split(/\s+/)[0]),
      extra: extra.filter(Boolean).map(norm),
    });
  };
  for (const c of (COMPANIES.companies || [])) {
    if (c.shareClass || !c.ticker) continue;
    add('us', c.ticker, c.name, [c.industry, ...(c.brands || [])], c.marketCap || 0);
  }
  const jp = readJapanList();
  const jpRate = (jp.fx && jp.fx.rate) || 1;
  for (const c of (jp.companies || [])) {
    if (c.shareClass) continue;
    add('jp', c.ticker, c.name, [c.nameJa, ...(c.brands || [])], Math.round((c.marketCap || 0) / jpRate));
  }
  // The list artifact carries the fields search needs (name, English name, brands, cap). Reading it
  // instead of the 28 MB source keeps the first search from parsing every company's price history.
  const kr = readKoreaList();
  const krRate = (kr.fx && kr.fx.rate) || 1;
  for (const c of (kr.companies || [])) {
    add('kr', c.ticker, c.nameEn || c.name, [c.name, ...(c.brands || [])], Math.round((c.marketCap || 0) / krRate));
  }
  const tw = readTaiwanList();
  const twRate = (tw.fx && tw.fx.rate) || 1;
  for (const c of (tw.companies || [])) {
    add('tw', c.ticker, c.nameEn || c.name, [c.name, ...(c.brands || [])], Math.round((c.marketCap || 0) / twRate));
  }
  // Hong Kong's names are English on the exchange tape, so the search covers the exchange short name
  // ("TENCENT") and the profile name ("Tencent Holdings") both.
  const hk = readHongKongList();
  const hkRate = (hk.fx && hk.fx.rate) || 1;
  for (const c of (hk.companies || [])) {
    // HKEX prints codes unpadded ("700"), the market data uses four digits ("0700"); accepting both is
    // the difference between "700" finding Tencent and finding nothing.
    add('hk', c.ticker, c.nameEn || c.name, [c.name, String(Number(c.ticker)), c.sector, ...(c.brands || [])], Math.round((c.marketCap || 0) / hkRate));
  }
  // Australia's list is English like Hong Kong's. The CSV name ("BHP GROUP LIMITED") and the profile
  // name ("BHP Group") both have to find it, so both are indexed.
  const au = readAustraliaList();
  const auRate = (au.fx && au.fx.rate) || 1;
  for (const c of (au.companies || [])) {
    add('au', c.ticker, c.nameEn || c.name, [c.name, c.sector, ...(c.brands || [])], Math.round((c.marketCap || 0) / auRate));
  }
  // India's symbols carry '&' and '-' ("M&M", "BAJAJ-AUTO"), so the symbol itself is indexed as typed.
  const indS = readIndiaList();
  const inRateS = (indS.fx && indS.fx.rate) || 1;
  for (const c of (indS.companies || [])) {
    add('in', c.ticker, c.nameEn || c.name, [c.name, c.sector, ...(c.brands || [])], Math.round((c.marketCap || 0) / inRateS));
  }
  // IDX symbols are four characters with no punctuation. The profile name ("Bank Central Asia") and the
  // exchange name ("PT Bank Central Asia Tbk") both have to find the line, so both are indexed.
  const indnS = readIndonesiaList();
  const idRateS = (indnS.fx && indnS.fx.rate) || 1;
  for (const c of (indnS.companies || [])) {
    add('id', c.ticker, c.nameEn || c.name, [c.name, c.sector, ...(c.brands || [])], Math.round((c.marketCap || 0) / idRateS));
  }
  const brS = readBrazilList();
  const brRateS = (brS.fx && brS.fx.rate) || 1;
  for (const c of (brS.companies || [])) {
    // BDRs are a secondary lens. Keep them searchable, but rank them below the primary listing so
    // 'Apple' / 'JPMorgan' still resolves to the US line; the BDR appears just after it.
    const cap = Math.round((c.marketCap || 0) / brRateS);
    add('br', c.ticker, c.nameEn || c.name, [c.name, c.nameEn, c.sector, c.shareClass, c.bdrNote, c.bdrUnderlying, ...(c.brands || [])], c.bdr ? Math.round(cap / 1000) : cap);
  }
  const zaS = readSouthAfricaList();
  const zaRateS = (zaS.fx && zaS.fx.rate) || 1;
  for (const c of (zaS.companies || [])) {
    // The six foreign-secondary lines are the same companies as their primary exchange listings, so
    // they rank below a primary line in search; the JSE line remains directly searchable by code.
    const cap = Math.round((c.marketCap || 0) / zaRateS);
    add('za', c.ticker, c.nameEn || c.name, [c.name, c.nameEn, c.sector, c.secondarySource, ...(c.brands || [])], c.foreignSecondary ? Math.round(cap / 1000) : cap);
  }
  SEARCH_INDEX = rows;
  return rows;
}

function searchCompanies(q, limit = 8) {
  const raw = String(q || '').trim();
  if (raw.length < 2) return { query: raw, results: [] };
  const nq = norm(raw);
  if (!nq) return { query: raw, results: [] };
  // A reader types words, not one blob: "shk properties" must find Sun Hung Kai Properties, whose
  // index row is the profile name plus the exchange's short name ("SHK PPT"). Requiring every word
  // to appear somewhere in the row (name, ticker or alias) is what makes that work without making
  // "a" match the whole market.
  const words = raw.toLowerCase().split(/[^a-z0-9]+/).map(norm).filter((w) => w.length > 1);
  const scored = [];
  // The row strings are already normalised (no spaces), so the old `split(/\s+/)` branch could never
  // match and the `hay` array was allocated for every row even when an exact/prefix check hit. Building
  // it only for a multi-word query removes two allocations per row from a 10k-row scan — the free
  // instance was spending ~0.5 s on that scan alone.
  for (const r of searchIndex()) {
    let score = 0;
    if (r.t === nq) score = 100;
    else if (r.n === nq) score = 96;
    else if (r.first === nq) score = 92;
    else if (r.n.startsWith(nq)) score = 85;
    else if (r.t.startsWith(nq)) score = 80;
    else if (words.length > 1 && words.every((w) => r.n.includes(w) || r.t.includes(w) || r.extra.some((x) => x.includes(w)))) score = 74;
    else if (r.extra.length && r.extra.some((x) => x === nq)) score = 65;
    else if (r.extra.length && r.extra.some((x) => x.startsWith(nq))) score = 55;
    else if (r.n.includes(nq)) score = 45;
    else if (r.extra.length && r.extra.some((x) => x.includes(nq))) score = 35;
    if (score) scored.push({ ...r, score });
  }
  // Ties go to the bigger company: a search for Samsung should open Samsung Electronics, not Samsung Card.
  scored.sort((a, b) => b.score - a.score || b.cap - a.cap || a.name.length - b.name.length);
  return {
    query: raw,
    results: scored.slice(0, limit).map(({ ref, market, ticker, name }) => ({ ref, market, ticker, name })),
  };
}

// ---------------------------------------------------------------------------
// Cross-market peers. Same broad industry, nearest size, different market — the comparison a reader
// actually wants when a Japanese automaker is on screen and GM is the obvious check. The bucket map is
// deliberately coarse: TSE's 33 sectors and Korea's 29 KSIC divisions are folded into the eleven US
// buckets, because a false precision ("this is a Toyota peer") is worse than a coarse one.
// ---------------------------------------------------------------------------
const PEER_BUCKET = {
  jp: { 'Electric Appliances': 'tech', 'Information & Communication': 'tech', 'Precision Instruments': 'tech',
    Banks: 'banks', Insurance: 'insurance', 'Securities & Commodity Futures': 'capital', 'Other Financials': 'capital',
    Pharmaceutical: 'pharma',
    Foods: 'consumer', 'Retail Trade': 'retail', 'Wholesale Trade': 'retail', 'Textiles & Apparels': 'consumer',
    'Other Products': 'consumer', Services: 'consumer',
    'Transportation Equipment': 'autos',
    Machinery: 'industrials', Construction: 'industrials', 'Metal Products': 'industrials', 'Rubber Products': 'industrials',
    'Land Transportation': 'industrials', 'Marine Transportation': 'industrials', 'Air Transportation': 'industrials',
    'Warehousing & Transport': 'industrials',
    Chemicals: 'materials', 'Iron & Steel': 'materials', 'Nonferrous Metals': 'materials', 'Glass & Ceramics': 'materials',
    'Pulp & Paper': 'materials',
    'Oil & Coal Products': 'energy', Mining: 'energy',
    'Electric Power & Gas': 'utilities', 'Real Estate': 'realestate' },
  kr: { Electronics: 'tech', 'Electrical Equipment': 'tech', 'Media & Telecom': 'tech',
    'Finance & Insurance': 'banks',
    'Pharma & Biotech': 'pharma',
    'Food & Beverage': 'consumer', 'Trade & Retail': 'retail', 'Hotels & Leisure': 'consumer',
    'Arts & Sport': 'consumer', Education: 'consumer', 'Furniture & Other Mfg': 'consumer', 'Textiles & Apparel': 'consumer',
    'Vehicles & Parts': 'autos',
    'Business Services': 'industrials', Machinery: 'industrials', Construction: 'industrials',
    'Shipbuilding & Transport Equip': 'industrials', 'Metal Products': 'industrials', 'Rubber & Plastics': 'industrials',
    'Transport & Logistics': 'industrials',
    Chemicals: 'materials', 'Steel & Metals': 'materials', 'Glass & Ceramics': 'materials',
    'Paper & Printing': 'materials', 'Wood & Paper': 'materials',
    'Oil & Gas': 'energy', Utilities: 'utilities', 'Real Estate': 'realestate' },
  // Hong Kong's sectors are stockanalysis's GICS names, not an exchange code, so the map is one step
  // shorter — and deliberately coarse: every financial is a "bank" for peer purposes.
  // These are the sector labels stockanalysis actually serves for HKG: Financials, Consumer
  // Discretionary, Consumer Staples — not the GICS names this map first guessed at, which silently
  // produced zero cross-market peers for every Hong Kong company.
  hk: { Technology: 'tech', 'Communication Services': 'telecom', Financials: 'banks',
    Healthcare: 'pharma', 'Consumer Discretionary': 'consumer', 'Consumer Staples': 'consumer',
    Industrials: 'industrials', Materials: 'materials', Energy: 'energy',
    Utilities: 'utilities', 'Real Estate': 'realestate', Other: 'industrials' },
  tw: { Semiconductors: 'tech', 'Computers & Peripherals': 'tech', Optoelectronics: 'tech',
    Communications: 'tech', 'Electronic Components': 'tech', 'Electronics Distribution': 'tech',
    'Information Services': 'tech', 'Other Electronics': 'tech', Electronics: 'tech', 'Digital & Cloud': 'tech',
    Financials: 'banks', 'Biotech & Medical': 'pharma', 'Agricultural Biotech': 'pharma',
    'Food & Beverage': 'consumer', 'Travel & Leisure': 'consumer', 'Sports & Leisure': 'consumer',
    'Household Goods': 'consumer', 'Culture & Creative': 'consumer', Textiles: 'consumer',
    'Trade & Retail': 'retail', Automobiles: 'autos',
    'Electric Machinery': 'industrials', Construction: 'industrials', 'Shipping & Transport': 'industrials',
    Conglomerates: 'industrials', Other: 'industrials',
    Chemicals: 'materials', Plastics: 'materials', 'Steel & Metals': 'materials', Cement: 'materials',
    'Glass & Ceramics': 'materials', 'Paper & Packaging': 'materials', Rubber: 'materials',
    'Oil, Gas & Power': 'energy', 'Green Energy': 'utilities' },
  // Australia's sectors are the ASX's GICS industry groups (27 of them), one step finer than the
  // eleven GICS sectors Hong Kong uses. The map folds them into the same coarse peer buckets.
  au: { Materials: 'materials', Energy: 'energy', Banks: 'banks', Insurance: 'insurance',
    'Diversified Financials': 'capital', 'Financial Services': 'capital',
    'Capital Goods': 'industrials', 'Commercial & Professional Services': 'industrials',
    Transportation: 'industrials',
    'Consumer Durables & Apparel': 'consumer', 'Consumer Services': 'consumer',
    'Consumer Staples Distribution & Retail': 'retail',
    'Consumer Discretionary Distribution & Retail': 'retail', 'Food, Beverage & Tobacco': 'consumer',
    'Household & Personal Products': 'consumer', Retailing: 'retail',
    'Health Care Equipment & Services': 'pharma',
    'Pharmaceuticals, Biotechnology & Life Sciences': 'pharma',
    'Media & Entertainment': 'media', 'Telecommunication Services': 'telecom',
    'Software & Services': 'tech', 'Technology Hardware & Equipment': 'tech',
    'Semiconductors & Semiconductor Equipment': 'semis',
    'Real Estate Management & Development': 'realestate',
    'Equity Real Estate Investment Trusts (REITs)': 'realestate',
    Utilities: 'utilities', 'Automobiles & Components': 'autos', Other: 'industrials',
    // The ~230 rows the CSV leaves unclassified take their sector from the profile, which is a GICS
    // sector (11 names) rather than an industry group. Map those too, or those companies get no peers.
    Financials: 'banks', 'Financial Services': 'banks',
    'Information Technology': 'tech', 'Communication Services': 'telecom',
    'Consumer Discretionary': 'consumer', 'Consumer Staples': 'consumer', 'Health Care': 'pharma',
    Industrials: 'industrials', 'Real Estate': 'realestate' },
  // India's sectors are the NSE macro industries (20 of them), which sit between a GICS sector and an
  // industry group. Financial Services deliberately maps to 'banks' for peers: a lender, an insurer and
  // an AMC are not peers in a ratio table, but they are the same neighbourhood for a comparison.
  in: { 'Information Technology': 'tech', Telecommunication: 'telecom', 'Media Entertainment & Publication': 'telecom',
    'Financial Services': 'banks', Healthcare: 'pharma',
    'Fast Moving Consumer Goods': 'consumer', 'Consumer Durables': 'consumer', 'Consumer Services': 'consumer',
    Textiles: 'consumer', 'Automobile and Auto Components': 'autos',
    'Capital Goods': 'industrials', Construction: 'industrials', Services: 'industrials', Diversified: 'industrials',
    Chemicals: 'materials', 'Metals & Mining': 'materials', 'Construction Materials': 'materials',
    'Oil Gas & Consumable Fuels': 'energy', Power: 'utilities', Realty: 'realestate' },
  // Indonesia's sectors are the eleven GICS sectors from the vendor profile (the exchange list has no
  // industry column). Financials maps to 'banks' for peers: a lender, an insurer and a securities house
  // are not peers in a ratio table, but they are the same neighbourhood for a comparison.
  id: { Energy: 'energy', Materials: 'materials', Industrials: 'industrials',
    'Consumer Discretionary': 'consumer', 'Consumer Staples': 'consumer', 'Health Care': 'pharma',
    Financials: 'banks', 'Information Technology': 'tech', 'Communication Services': 'telecom',
    Utilities: 'utilities', 'Real Estate': 'realestate' },
  br: { Energy: 'energy', Materials: 'materials', Industrials: 'industrials',
    'Consumer Discretionary': 'consumer', 'Consumer Staples': 'consumer', 'Health Care': 'pharma',
    Financials: 'banks', 'Information Technology': 'tech', 'Communication Services': 'telecom',
    Utilities: 'utilities', 'Real Estate': 'realestate' },
  za: { Energy: 'energy', Materials: 'materials', Industrials: 'industrials',
    'Consumer Discretionary': 'consumer', 'Consumer Staples': 'consumer', 'Health Care': 'pharma',
    Financials: 'banks', 'Information Technology': 'tech', 'Communication Services': 'telecom',
    Utilities: 'utilities', 'Real Estate': 'realestate' },
};

// The US has a four-digit SIC for every filer, so the bucket comes from the code rather than the
// eleven coarse sectors — "Healthcare" would otherwise put a drugmaker next to a health insurer.
function usBucket(c) {
  const sic = Number(c.sic);
  if (Number.isFinite(sic)) {
    if (sic >= 2830 && sic <= 2836) return 'pharma';
    if (sic >= 3841 && sic <= 3851) return 'medtech';
    if (sic === 3826 || sic === 3827 || sic === 3829) return 'medtech';
    if (sic >= 3670 && sic <= 3679) return 'semis';
    if (sic >= 7370 && sic <= 7379) return 'tech';
    if (sic >= 3570 && sic <= 3579) return 'tech';
    if (sic >= 6000 && sic <= 6199) return 'banks';
    if (sic >= 6300 && sic <= 6411) return 'insurance';
    if ((sic >= 6200 && sic <= 6299) || (sic >= 6700 && sic <= 6799)) return 'capital';
    if (sic >= 3711 && sic <= 3716) return 'autos';
    if ((sic >= 5500 && sic <= 5599) || sic === 5013 || sic === 3751) return 'autos';
    if (sic >= 1300 && sic <= 1389) return 'energy';
    if (sic >= 2900 && sic <= 2999) return 'energy';
    if (sic >= 2800 && sic <= 2899) return 'materials';
    if (sic >= 3300 && sic <= 3399) return 'materials';
    if (sic >= 1000 && sic <= 1099) return 'materials';
    if (sic >= 3500 && sic <= 3599) return 'industrials';
    if (sic >= 4900 && sic <= 4999) return 'utilities';
    if (sic >= 4813 && sic <= 4899) return 'telecom';
    if (sic >= 5200 && sic <= 5999) return 'retail';
    if (sic >= 2000 && sic <= 2199) return 'consumer';
    if (sic >= 7800 && sic <= 7999) return 'media';
    if (sic >= 6500 && sic <= 6599) return 'realestate';
  }
  return { Technology: 'tech', Financials: 'capital', Healthcare: 'medtech', Consumer: 'consumer',
    Industrials: 'industrials', Materials: 'materials', Mining: 'materials', Energy: 'energy',
    'Real estate': 'realestate', Telecom: 'telecom', Utilities: 'utilities' }[c.sector] || null;
}

let PEER_INDEX = null;
function peerIndex() {
  if (PEER_INDEX) return PEER_INDEX;
  const rows = [];
  const push = (market, ref, name, sector, capUsd, bucketOverride) => {
    const bucket = bucketOverride !== undefined ? bucketOverride : (PEER_BUCKET[market] || {})[sector];
    if (!bucket || !(capUsd > 0)) return;
    rows.push({ market, ref, name, sector, bucket, cap: capUsd });
  };
  for (const c of (COMPANIES.companies || [])) {
    if (c.shareClass || !c.ticker || !c.marketCap) continue;
    push('us', `us:${c.ticker}`, c.name, c.sector, c.marketCap, usBucket(c));
  }
  // The ref uses the trading ticker, not the internal code: that is what the chart endpoints and the
  // COMPARE box already understand (jp:7203, kr:005930).
  const jp = readJapanList();
  const jpRate = (jp.fx && jp.fx.rate) || 1;
  for (const c of (jp.companies || [])) push('jp', `jp:${c.ticker}`, c.name, c.sector, Math.round((c.marketCap || 0) / jpRate));
  const kr = readKoreaList();
  const krRate = (kr.fx && kr.fx.rate) || 1;
  for (const c of (kr.companies || [])) push('kr', `kr:${c.ticker}`, c.nameEn || c.name, c.sector, Math.round((c.marketCap || 0) / krRate));
  const tw = readTaiwanList();
  const twRate = (tw.fx && tw.fx.rate) || 1;
  for (const c of (tw.companies || [])) push('tw', `tw:${c.ticker}`, c.nameEn || c.name, c.sector, Math.round((c.marketCap || 0) / twRate));
  const hk = readHongKongList();
  const hkRate = (hk.fx && hk.fx.rate) || 1;
  for (const c of (hk.companies || [])) push('hk', `hk:${c.ticker}`, c.nameEn || c.name, c.sector, Math.round((c.marketCap || 0) / hkRate));
  const au = readAustraliaList();
  const auRate = (au.fx && au.fx.rate) || 1;
  for (const c of (au.companies || [])) push('au', `au:${c.ticker}`, c.nameEn || c.name, c.sector, Math.round((c.marketCap || 0) / auRate));
  const indP = readIndiaList();
  const inRateP = (indP.fx && indP.fx.rate) || 1;
  for (const c of (indP.companies || [])) push('in', `in:${c.ticker}`, c.nameEn || c.name, c.sector, Math.round((c.marketCap || 0) / inRateP));
  const indnP = readIndonesiaList();
  const idRateP = (indnP.fx && indnP.fx.rate) || 1;
  for (const c of (indnP.companies || [])) push('id', `id:${c.ticker}`, c.nameEn || c.name, c.sector, Math.round((c.marketCap || 0) / idRateP));
  const brP = readBrazilList();
  const brRateP = (brP.fx && brP.fx.rate) || 1;
  for (const c of (brP.companies || [])) push('br', `br:${c.ticker}`, c.nameEn || c.name, c.sector, Math.round((c.marketCap || 0) / brRateP));
  const zaP = readSouthAfricaList();
  const zaRateP = (zaP.fx && zaP.fx.rate) || 1;
  for (const c of (zaP.companies || [])) push('za', `za:${c.ticker}`, c.nameEn || c.name, c.sector, Math.round((c.marketCap || 0) / zaRateP));
  PEER_INDEX = rows;
  return rows;
}

function getPeers(ref, n = 6) {
  const raw = String(ref || '').trim();
  const [market, code] = raw.includes(':') ? raw.split(':') : ['us', raw];
  const rows = peerIndex();
  const me = rows.find((r) => r.market === market && r.ref === `${market}:${code}`);
  if (!me) return { error: 'unknown company', ref: raw, peers: [] };
  const others = rows
    .filter((r) => r.bucket === me.bucket && r.market !== me.market)
    .map((r) => ({ ...r, dist: Math.abs(Math.log(r.cap / me.cap)) }))
    .sort((a, b) => a.dist - b.dist);
  // At least one peer from each other market when the bucket allows it, then fill by size.
  const picked = [];
  const taken = new Set();
  for (const mkt of ['us', 'jp', 'kr', 'tw', 'hk', 'au', 'in', 'id', 'br', 'za']) {
    if (mkt === me.market) continue;
    const first = others.find((r) => r.market === mkt);
    if (first) { picked.push(first); taken.add(first.ref); }
  }
  for (const r of others) {
    if (picked.length >= n) break;
    if (taken.has(r.ref)) continue;
    picked.push(r); taken.add(r.ref);
  }
  return {
    ref: me.ref, bucket: me.bucket, market: me.market,
    peers: picked.slice(0, n).map((r) => ({
      ref: r.ref, market: r.market, name: r.name, sector: r.sector,
      cap: r.cap, ratio: +(r.cap / me.cap).toFixed(2),
    })),
  };
}

// ---------------------------------------------------------------------------
// Currency moves for the company screener. A Tokyo listing returns yen; a dollar investor gets that
// return *plus* the yen's own move. These are the moves of each currency against the chosen base over
// the same windows the table shows (1D, 6M, YTD), from ECB reference rates via Frankfurter.
// ---------------------------------------------------------------------------
const FX_CONV = ['USD', 'JPY', 'KRW', 'EUR', 'GBP', 'CNY', 'CAD', 'AUD', 'CHF', 'HKD'];
async function getFxWindows(base = 'USD') {
  const B = String(base || 'USD').toUpperCase();
  if (!FX_CONV.includes(B)) return { error: 'unsupported base', base: B };
  return cached('fxwin:' + B, 6 * 3600e3, async () => {
    const want = FX_CONV.filter((c) => c !== B);
    const empty = { base: B, windows: { d1: {}, m6: {}, ytd: {} }, asOf: null };
    if (!want.length) return empty;
    const day = 86400e3;
    const now = Date.now();
    const start = `${new Date(now).getUTCFullYear() - 1}-12-01`;
    const res = await fetch(`https://api.frankfurter.dev/v1/${start}..?base=${B}&symbols=${want.join(',')}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('frankfurter ' + res.status);
    const j = await res.json();
    const rates = j && j.rates ? j.rates : {};
    const dates = Object.keys(rates).sort();
    if (dates.length < 2) return empty;
    const last = dates[dates.length - 1];
    const lastT = Date.parse(last);
    const at = (iso) => { let best = null; for (const d of dates) { if (d > iso) break; best = d; } return best; };
    const ytdBase = at(`${new Date(lastT).getUTCFullYear()}-01-01`);
    const sixBase = at(new Date(lastT - 182 * day).toISOString().slice(0, 10));
    const move = (from, c) => {
      const a = rates[last] && rates[last][c], b = from && rates[from] && rates[from][c];
      return a && b ? +(((a / b) - 1) * 100).toFixed(2) : null;
    };
    const prev = dates[dates.length - 2];
    const win = { d1: {}, m6: {}, ytd: {} };
    for (const c of want) {
      win.d1[c] = move(prev, c);
      win.m6[c] = move(sixBase, c);
      win.ytd[c] = move(ytdBase, c);
    }
    return { base: B, asOf: last, windows: win, source: 'ECB reference rates (Frankfurter)' };
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
// Risk & cross-asset correlation (Tier 2). Current distance from the 1-year high, worst fall,
// a realised-vol term structure normalised against its own history, and 1-year + 3-month
// correlation matrices over aligned daily log-returns.
// ---------------------------------------------------------------------------
// The risk board used to cache a whole payload with blank series for an hour after one Yahoo 429.
// Keep the last good map per instrument (memory + a runtime cache) and fall back to a committed seed;
// the correlation matrix is then computed from complete, real series instead of blank columns.
const RISK_SEED_FILE = path.join(__dirname, 'data', 'risk-seed.json');
const RISK_CACHE_FILE = path.join(__dirname, '.risk-cache.json');
const RISK_KEEP_MS = 14 * 864e5;
function readRiskMaps(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !j.series) return {};
    if (!j.updated || Date.now() - Date.parse(j.updated) > RISK_KEEP_MS) return {};
    return j.series;
  } catch { return {}; }
}
const RISK_MAPS = new Map();
for (const source of [readRiskMaps(RISK_CACHE_FILE), readRiskMaps(RISK_SEED_FILE)]) {
  for (const [key, v] of Object.entries(source)) {
    if (!v || !v.map) continue;
    const prev = RISK_MAPS.get(key);
    if (!prev || latestDate(v.map) >= latestDate(prev.map)) RISK_MAPS.set(key, v);
  }
}
let riskCacheAt = 0;
function saveRiskCache() {
  const now = Date.now();
  if (now - riskCacheAt < 15 * 60e3) return;
  riskCacheAt = now;
  try {
    const body = JSON.stringify({ updated: new Date(now).toISOString(), series: Object.fromEntries(RISK_MAPS) });
    fs.writeFileSync(`${RISK_CACHE_FILE}.tmp`, body);
    fs.renameSync(`${RISK_CACHE_FILE}.tmp`, RISK_CACHE_FILE);
  } catch { /* read-only filesystem is fine */ }
}
async function riskSeries(s) {
  if (s.fred) {
    try {
      let map = await cached('risk:' + s.key, 6 * 3600e3, () => fredSeries(s.fred, 400));
      if (Object.keys(map).length >= 5) return { map, source: 'FRED' };
    } catch {}
    if (s.altSym) {
      try {
        let map = (await cached('risk:alt:' + s.key, 3600e3, () => yahooSeries(s.altSym, '1y', '1d'))).series || {};
        if (Object.values(map).some((v) => v > 20)) map = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v / 10]));
        if (Object.keys(map).length >= 5) return { map, source: 'Yahoo' };
      } catch {}
    }
    return null;
  }
  try {
    const map = (await cached('risk:' + s.key, 3600e3, () => yahooSeries(s.sym, '1y', '1d'))).series || {};
    if (Object.keys(map).length >= 5) return { map, source: 'Yahoo' };
  } catch {}
  if (s.fallbackFred) {
    try {
      const map = await cached('risk:fb:' + s.key, 6 * 3600e3, () => fredSeries(s.fallbackFred, 400));
      if (Object.keys(map).length >= 5) return { map, source: 'FRED' };
    } catch {}
  }
  return null;
}
async function getRisk() {
  return cachedSWR('risk', 3600e3, async () => {
    const maps = {};
    let freshCount = 0;
    await Promise.all(RISK_SERIES.map(async (s) => {
      let merged = null;
      try { merged = keepLastSeries(await riskSeries(s), RISK_MAPS.get(s.key)); } catch {}
      if (merged && !merged.stale) freshCount++;
      if (merged) RISK_MAPS.set(s.key, merged);
      maps[s.key] = merged ? merged.map : {};
    }));
    if (freshCount) saveRiskCache();
    const metrics = RISK_SERIES.map((s) => {
      const dates = Object.keys(maps[s.key]).sort();
      const vals = dates.map((d) => maps[s.key][d]);
      const dd = maxDrawdown(vals), now = drawdownNow(vals), vol = realizedVolTerm(vals);
      const vp = volPercentile(vals);
      return {
        key: s.key, label: s.label, short: s.short, rate: !!s.rate, level: !!s.level,
        drawdown: dd, drawdownNow: now, ddWord: drawdownWord(dd),
        vol, volWord: volWord(vol.w30), volTrend: volTrend(vol),
        volPct: vp, volVsOwn: volVsOwnWord(vp),
      };
    });
    const dates = [...new Set(RISK_SERIES.flatMap((s) => Object.keys(maps[s.key])))].sort();
    const keys = RISK_SERIES.map((s) => ({ key: s.key, label: s.label, short: s.short }));
    const matrix = corrMatrix(maps, dates);
    // ~63 trading days = the "lately" window the heading used to claim without showing.
    const recent = dates.slice(-Math.min(64, dates.length));
    const matrix3m = corrMatrix(maps, recent);
    const pairs = topPairs(matrix, keys, 3);
    const pairs3m = topPairs(matrix3m, keys, 3);
    const div = bestDiversifier(matrix, keys);
    const div3m = bestDiversifier(matrix3m, keys);
    const groups3m = pairGroups(matrix3m, keys, 0.4);
    for (const p of [...groups3m.together, ...groups3m.opposite]) {
      p.r1 = (matrix[p.a.key] || {})[p.b.key] ?? null;
      p.shift = corrShift(p.r1, p.r);
    }
    return {
      updated: new Date().toISOString(), metrics, keys, matrix, matrix3m,
      days: dates.length, days3m: recent.length, pairs, pairs3m, div, div3m, groups3m,
      read: riskRead(metrics),
    };
  });
}

// ---------------------------------------------------------------------------
// Screener — one row per instrument, ranked by "where do I look today?". Assembles the deltas,
// the two scores, the basis percentile, vol and (where CFTC covers it) positioning. Server-side
// so the logic is testable; the client only sorts + renders.
// ---------------------------------------------------------------------------
// Per-instrument scorecard for one segment. Each component gets its OWN read (not the segment's
// headline read), so WTI and Brent can differ, and a missing feed leaves that chip blank.
async function getSegmentScore(segment) {
  const mk = MARKETS.find((m) => m.id === segment);
  if (!mk) return { segment, label: segment, asOf: null, rows: [] };
  return cachedSWR('segscore:' + segment, 5 * 60e3, async () => {
    const [m, h, pos, reads] = await Promise.all([
      getMarket(),
      getHistory().catch(() => null),
      getPositioningSegment(segment).catch(() => null),
      Promise.all(mk.components.map((id) => getMarketRead(segment, id).catch(() => null))),
    ]);
    const posById = Object.fromEntries(((pos && pos.items) || []).map((p) => [p.id, p]));
    const rows = mk.components.map((id, i) => {
      const b = (m.benchmarks || []).find((x) => x.id === id) || {};
      const rd = reads[i] || {};
      const vd = rd.verdict || {};
      const dd = h && h.deltas ? h.deltas[id] : null;
      const d = dd ? (b.paper != null ? dd.paper : dd.physical) : null;
      const p = posById[id] || null;
      return {
        id, label: b.label || id, unit: b.unit || '', dp: b.dp ?? 2,
        price: b.paper != null ? b.paper : b.physical,
        source: b.paperSource || b.physicalSource || null,
        asOf: b.paperDate || b.physicalDate || null,
        deltas: d || {},
        stretch: vd.priceStretch && vd.priceStretch.score != null ? vd.priceStretch.score : null,
        stretchLabel: vd.priceStretch ? vd.priceStretch.label : null,
        tight: vd.supplyDemand && vd.supplyDemand.score != null ? vd.supplyDemand.score : null,
        tightLabel: vd.supplyDemand ? vd.supplyDemand.label : null,
        // Precious-metal curves are rates/financing, not supply, so no CURVE chip there (the same
        // reason their supply & demand read is deliberately blank).
        curve: segment !== 'precious' && rd.curve && rd.curve.shape ? rd.curve.shape : null,
        basisPct: rd.basis && rd.basis.pctile != null ? Math.round(rd.basis.pctile) : null,
        posPct: p && p.pct3y != null ? Math.round(p.pct3y) : null,
        posFlag: p && p.flag ? p.flag.label : null,
      };
    });
    const asOf = rows.map((r) => r.asOf).filter(Boolean).sort().at(-1) || null;
    return { segment, label: mk.label, asOf, rows };
  });
}

async function getScreen() {
  return cachedSWR('screen', 5 * 60e3, async () => {
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
  return cachedUnlessEmpty('curvehist:' + root, 6 * 3600e3, async () => {
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
  }, (v) => !v.dates.length);
}

// Back-adjusted continuous front-month series (removes roll jumps).
async function getContinuous(root) {
  return cachedUnlessEmpty('cont:' + root, 6 * 3600e3, async () => {
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
  }, (v) => !v.series || !Object.keys(v.series).length);
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
  // Gulf + Africa. The three Gulf pairs are USD-pegged: the peg is stored on the currency so every
  // path that publishes a quote can drop the meaningless % move (see noMoveIfPegged below).
  { id: 'usdsar', label: 'USD / SAR · pegged', sym: 'USDSAR=X', dp: 4, peg: 3.75 },
  { id: 'usdaed', label: 'USD / AED · pegged', sym: 'USDAED=X', dp: 4, peg: 3.6725 },
  { id: 'usdqar', label: 'USD / QAR · pegged', sym: 'USDQAR=X', dp: 4, peg: 3.64 },
  { id: 'usdngn', label: 'USD / NGN', sym: 'USDNGN=X', dp: 2 },
  { id: 'usdkes', label: 'USD / KES', sym: 'USDKES=X', dp: 2 },
  { id: 'usdves', label: 'USD / VES', sym: 'USDVES=X', dp: 2 },
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

// A pegged currency's % move is noise, not data: the upstream daily series carries bad ticks (USDSAR
// reads 3.6397 for days, then jumps to the true 3.7526) and a peg is a constant by definition. Every
// publish path pushes quotes through here so a pegged pair reports its LEVEL and no moves.
const noMoveIfPegged = (c, quote) => (c && c.peg ? { ...quote, pct: null } : quote);

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
  return cachedSWR('macrodash', 3 * 3600e3, async () => {
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
    const fx = await Promise.all(FX_SYMS.map(async (m) => {   // m.peg = a USD-pegged pair: level only
      try {
        const { price, series } = await cached('q:' + m.sym, 120e3, () => yahooSeries(m.sym, '5d', '1d'));
        const d = Object.keys(series).sort();
        const a = series[d[d.length - 1]], b = series[d[d.length - 2]];
        return { id: m.id, label: m.label, price: a ?? price ?? null, pct: m.peg ? null : (a != null && b ? ((a - b) / b) * 100 : null) };
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
  // Next contract expiry — the WTI rule (3 business days before the 25th of the prior month).
  const expIso = frontExpiry('CL', iso(now)) || iso(now);
  const exp = new Date(expIso + 'T00:00:00Z');
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
// Every macro country's upcoming releases, in ONE TradingView request (the feed accepts a country
// list). High-impact only, plus — for a country with no high-impact release inside the window — its
// next medium one, so no country is silently absent. Forecast (consensus) and previous come free.
const tvWorld = (days = 45) => cached('tvworld', 3 * 3600e3, async () => {
  const codes = [...new Set(Object.values(TV_COUNTRY))];
  const from = new Date().toISOString();
  const to = new Date(Date.now() + days * 864e5).toISOString();
  const r = await fetch(`https://economic-calendar.tradingview.com/events?from=${from}&to=${to}&countries=${encodeURIComponent(codes.join(','))}`, { headers: TV_HEADERS });
  if (!r.ok) throw new Error('tradingview world -> ' + r.status);
  const j = await r.json();
  const nameOf = Object.fromEntries(Object.entries(TV_COUNTRY).map(([id, cc]) => [cc, (ALL_COUNTRIES[id] || {}).label || cc]));
  const clean = (v) => (v == null || v === '' ? null : String(v));
  const all = (j.result || []).filter((e) => e.date && e.indicator !== 'Holidays').map((e) => ({
    ...etParts(e.date), name: e.title, cc: e.country, country: nameOf[e.country] || e.country,
    importance: e.importance, forecast: clean(e.forecast), previous: clean(e.previous), actual: clean(e.actual),
  }));
  // Per country: high-impact releases; if a country has none in the window, its medium ones; if it only
  // publishes low-impact data (Kenya's GDP is flagged low), its next couple — so no country is silent.
  all.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const byCc = {};
  for (const e of all) (byCc[e.cc] = byCc[e.cc] || []).push(e);
  const pick = [];
  for (const list of Object.values(byCc)) {
    const high = list.filter((x) => x.importance >= 1);
    if (high.length) { pick.push(...high); continue; }
    const med = list.filter((x) => x.importance === 0);
    if (med.length) { pick.push(...med); continue; }
    pick.push(...list.slice(0, 2));   // low-impact-only country: its next couple of releases
  }
  return pick.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
});

async function getCalendar() {
  return cachedSWR('calendar', 6 * 3600e3, async () => {
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
      // The recurring calendar used to post this on the 20th of every month. Use the real WTI rule.
      const expIso = frontExpiry('CL', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)).toISOString().slice(0, 10));
      if (expIso) push(new Date(expIso + 'T00:00:00Z'), 'WTI front-month expiry', 'CME', 'futures roll to the next month');
      push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 12)), 'USDA WASDE report (approx.)', 'USDA', 'usual mid-month slot');
    }
    events.push({ date: null, name: 'OPEC+ monthly meeting', source: 'OPEC+', note: 'date varies — check the OPEC calendar' });
    // The three live sources (Fed, FRED, TradingView) are independent feeds. Ask for all of them at
    // once: a cold calendar used to pay for them one after another, which is most of its load time.
    const fredEnd = iso(new Date(Date.now() + 75 * 864e5));
    const fredWant = /(consumer price index|employment situation|gross domestic product|personal income|producer price index|retail sales|industrial production|advance report)/i;
    const fredReleases = !process.env.FRED_API_KEY ? Promise.resolve([]) : (async () => {
      const url = `https://api.stlouisfed.org/fred/releases/dates?api_key=${process.env.FRED_API_KEY}&file_type=json&realtime_start=${today}&realtime_end=${fredEnd}&include_release_dates_with_no_data=true&limit=1000`;
      const j = await (await fetch(url, { headers: UA })).json();
      return (j.release_dates || []).filter((r) => fredWant.test(r.release_name || ''));
    })().catch(() => []);
    const [fedDates, tvEvents, fredDates] = await Promise.all([
      fomcDates().catch(() => []),
      tvWorld().catch(() => []),
      fredReleases,
    ]);
    // FOMC — the Fed's published dates (live if reachable, else the published fallback).
    const fomcLive = fedDates.length > 0;
    const fomc = fomcLive ? fedDates : FOMC_FALLBACK;
    for (const d of fomc) if (d >= today) events.push({ date: d, name: 'FOMC rate decision', source: 'Federal Reserve', note: 'policy rate decision · 2:00pm New York' });
    // FRED release calendar (optional free key) — adds CPI, payrolls, GDP, PCE, retail sales…
    for (const r of fredDates) events.push({ date: r.date, name: r.release_name, source: 'FRED', note: 'scheduled release' });
    // Upcoming releases from every macro country, high-impact first (see tvWorld).
    for (const e of tvEvents) {
      events.push({ date: e.date, name: e.name, source: e.country ? `TradingView · ${e.country}` : 'TradingView',
        time: e.time || null,
        note: [e.forecast != null ? `consensus ${e.forecast}` : '', e.previous != null ? `prior ${e.previous}` : ''].filter(Boolean).join(' · '),
        cc: e.cc, country: e.country, importance: e.importance });
    }
    const upcoming = events.filter((e) => !e.date || e.date >= today)
      .sort((x, y) => (x.date || '9999-99-99').localeCompare(y.date || '9999-99-99')).slice(0, 220);
    return { updated: new Date().toISOString(), events: upcoming, fomc: fomcLive ? 'live' : 'fallback', fredKey: Boolean(process.env.FRED_API_KEY) };
  });
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
  soymeal: { root: 'ZM', exch: 'CBT' }, soyoil: { root: 'ZL', exch: 'CBT' }, rice: { root: 'ZR', exch: 'CBT' },
  coffee: { root: 'KC', exch: 'NYB' }, sugar: { root: 'SB', exch: 'NYB' }, cocoa: { root: 'CC', exch: 'NYB' }, cotton: { root: 'CT', exch: 'NYB' },
  orange: { root: 'OJ', exch: 'NYB' },
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
  return cachedSWR('curves', 120_000, async () => {
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
  industrial: { tightQ: 'ARE COPPER, ALUMINIUM & STEEL TIGHT?', catalysts: ['China demand & stimulus', 'mine supply & strikes (Chile, Indonesia)', 'iron ore & steel (China property)', 'exchange warehouse stocks', 'energy & power costs (smelters)'], watch: ['China property & grid spending', 'the steel margin (iron ore → HRC)', 'LME/COMEX warehouse stocks & smelter curtailments'],
    sectorsUp: ['Copper, aluminium & steel producers', 'Electrification, grid & battery suppliers'], sectorsDown: ['Aerospace, packaging & autos', 'Construction & machinery'],
    tickersUp: ['FCX', 'SCCO', 'RIO', 'BHP', 'VALE', 'AA', 'CENX', 'NUE', 'STLD', 'COPX', 'PICK'], tickersDown: ['CAT', 'DE', 'PKB'],
    ideas: 'Copper and aluminium are the electrification and packaging metals; iron ore and steel are the construction and machinery cycle. Tight supply helps miners, smelters and mills and signals firm industrial demand, while raising costs for autos, construction, packaging and machinery.' },
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
    const sym = primary.paper || primary.physical;
    // Every block below is an independent feed, so they all run TOGETHER. They used to be awaited
    // one after another (price → long history → curve → correlations → basis → stocks → fundamentals):
    // seven round-trips for one read, and the screener builds nine of them.
    const [priceMap, longVals, curve, macro, basis, inventory, fund] = await Promise.all([
      (async () => {
        try { return primary.paper ? (await yc(primary.paper, '2y')).series : await cached('mrf:' + primary.physical, 3600e3, () => spotSeries(primary, 740)); } catch { return {}; }
      })(),
      (async () => {
        // Long monthly history for a multi-year range percentile + the 1-yr move's own distribution,
        // so "stretched" isn't limited to the 2-year window.
        if (!primary.paper) return [];
        try { const lmap = (await cached('mrlt:' + primary.paper, 6 * 3600e3, () => yahooSeries(primary.paper, '10y', '1mo'))).series; return Object.keys(lmap).sort().map((d) => lmap[d]); } catch { return []; }
      })(),
      (async () => {
        if (!CURVE_SPEC[sel]) return null;
        try { const c = await getCurveFor(sel); return c.available ? { shape: c.shape, m1m2: c.m1m2, m1m6: c.m1m6, months: (c.calendar && c.calendar[0] && c.calendar[0].months) || 1 } : null; } catch { return null; }
      })(),
      (async () => {
        const pairs = [['usd', 'DX-Y.NYB'], ['vix', '^VIX'], ['spx', '^GSPC']];
        const vals = await Promise.all(pairs.map(([, s]) => pairCorr(sym, s).catch(() => null)));
        return Object.fromEntries(pairs.map(([k], i) => [k, vals[i]]));
      })(),
      (async () => {
        try {
          const row = (await getMarket()).benchmarks.find((b) => b.id === sel);
          const an = (await getAnalytics()).benchmarks?.[sel];
          return row?.basis != null ? { value: row.basis, pctile: an?.basisPct ?? null } : null;
        } catch { return null; }
      })(),
      (async () => {
        // Stocks vs their seasonal norm — the segment's own inventory series (energy only).
        if (!m.hasInventories) return null;
        try {
          const inv = await getInventories();
          const pick = [];
          if (id === 'gas') { if (inv.gas?.surprise != null) pick.push({ key: 'gas', label: 'US gas storage', ...inv.gas }); }
          else if (id === 'refined') { for (const k of ['gasoline', 'distillate']) { const it = inv.items.find((x) => x.key === k); if (it) pick.push(it); } }
          else { const it = inv.items.find((x) => x.key === 'crude'); if (it) pick.push(it); }
          return pick.length ? pick : null;
        } catch { return null; }
      })(),
      getFundamentals(id, sel).catch(() => null),
    ]);
    const values = Object.keys(priceMap).sort().map((d) => priceMap[d]);
    const last = [...values].reverse().find((v) => v != null) ?? null;
    let prev = null; for (let i = values.length - 2; i >= 0; i--) if (values[i] != null) { prev = values[i]; break; }
    const dayPct = last != null && prev ? ((last - prev) / prev) * 100 : null;
    const vol30 = realizedVol(values, 30);
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
      hasBasis: m.hasBasis, hasInventories: m.hasInventories,
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
    try { const f = fund || await getFundamentals(id, sel); for (const e of ((f && f.items) || []).slice(0, 3)) takes.push(`<b>${e.kind}</b> ${e.ageDays <= 14 ? 'recently' : Math.max(1, Math.round(e.ageDays / 30)) + ' months ago'}: ${escHtml(e.title)} — ${e.effect === 'down' ? 'pressure on price' : 'price-positive'}.`); } catch {}
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
  mx: 'Mexico economy OR Banxico OR Pemex OR peso',
  ar: 'Argentina economy OR Milei OR BCRA OR Buenos Aires',
  br: 'Brazil economy OR BCB OR Ibovespa OR Selic',
  ve: 'Venezuela economy OR PDVSA OR Caracas OR bolivar',
  me: 'Gulf economy OR Saudi Aramco OR OPEC OR Qatar LNG',
  af: 'Africa economy OR African markets OR Sub-Saharan Africa',
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
  // No outer brackets: getMacroNews already wraps the terms in (...), and a second pair makes
  // Google treat the whole thing as one phrase (verified: 100 results -> 1).
  sa: 'Saudi Arabia OR Riyadh OR Aramco OR SAMA',
  ae: '"United Arab Emirates" OR UAE OR Dubai OR "Abu Dhabi"',
  qa: 'Qatar OR Doha OR QatarEnergy',
  za: '"South Africa" OR rand OR SARB',
  ng: 'Nigeria OR naira OR Dangote OR Lagos',
  ke: 'Kenya OR Nairobi OR Kenyan',
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
  mx: [/\bMexico\b/i, /\bMexican\b/i, /\bBanxico\b/i, /\bPemex\b/i, /\bCDMX\b/],
  ar: [/\bArgentina\b/i, /\bArgentine\b/i, /\bMilei\b/i, /\bBCRA\b/, /\bBuenos Aires\b/i],
  br: [/\bBrazil(ian)?\b/i, /\bIbovespa\b/i, /\bBCB\b/, /\bSelic\b/i, /\bBras[ií]lia\b/i],
  ve: [/\bVenezuela(n)?\b/i, /\bPDVSA\b/, /\bCaracas\b/i, /\bbol[ií]var(es)?\b/i],
  me: [/\bGulf\b/i, /\bMiddle East\b/i, /\bSaudi\b/i, /\bEmirat/i, /\bUAE\b/, /\bQatar\b/i, /\bKuwait\b/i, /\bBahrain\b/i, /\bOman\b/i, /\bMENA\b/i],
  af: [/\bAfrica(n)?\b/i, /\bNigeri/i, /\bKenya/i, /\bSouth Africa/i, /\bGhana\b/i, /\bEthiopia\b/i, /\bTanzania\b/i, /\bUganda\b/i, /\bZambia\b/i],
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
  sa: [/\bSaudi\b/i, /\bRiyadh\b/i, /\bAramco\b/i, /\bSAMA\b/, /\bTadawul\b/i],
  ae: [/\bUAE\b/, /\bEmirat/i, /\bDubai\b/i, /\bAbu Dhabi\b/i, /\bADNOC\b/i],
  qa: [/\bQatar\b/i, /\bDoha\b/i, /\bQatarEnergy\b/i, /\bRas Laffan\b/i],
  za: [/\bSouth Africa/i, /\bSARB\b/, /\bJohannesburg\b/i, /\bJSE\b/],
  ng: [/\bNigeri/i, /\bnaira\b/i, /\bDangote\b/i, /\bLagos\b/i],
  ke: [/\bKenya/i, /\bNairobi\b/i, /\bCentral Bank of Kenya\b/i],
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
  ironore: [/\biron ore\b/i], steel: [/\b(steel|hot[- ]?rolled|hrc|rebar)\b/i],
  orange: [/\b(orange juice|citrus|oranges?)\b/i], rice: [/\brice\b/i],
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
const NEWS_REGION_LABELS = { us: 'Americas', eu: 'Europe', jp: 'Japan', apac: 'Asia-Pacific', me: 'Middle East', af: 'Africa' };
const newsLabel = (id) => MARKETS.find((x) => x.id === id)?.label || ALL_COUNTRIES[id]?.label || NEWS_REGION_LABELS[id] || id;
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
  // A rate-limited burst must not occupy the 45-minute slot with an empty answer (the event pool
  // fans out over every segment at boot), so empty results are served but not stored.
  return cachedUnlessEmpty('news:' + id + (sel ? ':' + sel : ''), 45 * 60e3, async () => {
    // Query the chosen instrument directly (Google News returns ~100 per query), then keep only
    // headlines that actually name it and pass the market-context guard.
    const q = b ? `${b.label.replace(/\s*\(.*\)/, '')} ${NEWS_TIER1}` : `(${terms}) ${NEWS_TIER1}`;
    let kept = (await fetchGoogleNews(q, sel ? 40 : 10)).filter(onTopic);
    if (sel && !kept.length) {   // a sparse day → widen to the whole segment's feed, still filtered
      try { kept = (await fetchGoogleNews(`(${terms}) ${NEWS_TIER1}`, 40)).filter(onTopic); } catch {}
    }
    return { id, label: b ? b.label : newsLabel(id), component: sel || null, items: kept.slice(0, 10) };
  }, (v) => !(v.items && v.items.length));
}

// ---------------------------------------------------------------------------
// Macro countries — per-region country lists (currency + equity index, both LIVE
// from Yahoo). Official macro is only attached where it is genuinely current.
// ---------------------------------------------------------------------------
// iso3 = World Bank code (annual fundamentals). oil = net crude position (factual).
const MACRO_COUNTRIES = {
  us: [
    { id: 'us', label: 'United States', iso3: 'USA', oil: 'exporter', fx: 'DX-Y.NYB', fxLabel: 'US dollar (DXY)', index: '^GSPC', indexLabel: 'S&P 500' },
    { id: 'mx', label: 'Mexico', iso3: 'MEX', oil: 'exporter', fx: 'USDMXN=X', fxLabel: 'USD / MXN', index: '^MXX', indexLabel: 'S&P/BMV IPC' },
    { id: 'br', label: 'Brazil', iso3: 'BRA', oil: 'exporter', fx: 'USDBRL=X', fxLabel: 'USD / BRL', index: '^BVSP', indexLabel: 'Ibovespa' },
    { id: 'ar', label: 'Argentina', iso3: 'ARG', oil: 'exporter', fx: 'USDARS=X', fxLabel: 'USD / ARS', index: '^MERV', indexLabel: 'MERVAL' },
    // Venezuela has no free equity index (^IBC and VEMTF are gone; "VZLA" is Vizsla Silver, a Canadian
    // miner) and no BIS policy rate or TradingView calendar — so the card says so and shows FX + macro.
    { id: 've', label: 'Venezuela', iso3: 'VEN', oil: 'exporter', fx: 'USDVES=X', fxLabel: 'USD / VES', index: null, indexLabel: null },
  ],
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
  // Gulf: none of these currencies float (all three are USD-pegged), so the equity line is where the
  // oil/gas story shows up. No Yahoo index exists for Tadawul/DFM/QSE — the US-listed iShares MSCI
  // country ETFs are the live proxy, labelled as such (same pattern as THD/EPHE/VNM).
  me: [
    { id: 'sa', label: 'Saudi Arabia', iso3: 'SAU', oil: 'exporter', fx: 'USDSAR=X', fxLabel: 'USD / SAR', index: 'KSA', indexLabel: 'Saudi Arabia (KSA ETF proxy)', peg: 3.75 },
    { id: 'ae', label: 'United Arab Emirates', iso3: 'ARE', oil: 'exporter', fx: 'USDAED=X', fxLabel: 'USD / AED', index: 'UAE', indexLabel: 'UAE (UAE ETF proxy)', peg: 3.6725 },
    { id: 'qa', label: 'Qatar', iso3: 'QAT', oil: 'exporter', fx: 'USDQAR=X', fxLabel: 'USD / QAR', index: 'QAT', indexLabel: 'Qatar (QAT ETF proxy)', peg: 3.64 },
  ],
  // Africa. South Africa has a real free equity proxy (EZA); Nigeria and Kenya have none — no index
  // on Yahoo (^NGX/^NSE20 are empty), no surviving US-listed ETF (Global X Nigeria's NGE is gone, and
  // the symbol "KEN" is Kenon Holdings, an Israeli company — NOT Kenya), and no Yahoo Lagos/Nairobi
  // listings. So those two ship FX + macro + news only, with the index line honestly declared missing.
  af: [
    { id: 'za', label: 'South Africa', iso3: 'ZAF', oil: 'importer', fx: 'USDZAR=X', fxLabel: 'USD / ZAR', index: 'EZA', indexLabel: 'South Africa (EZA ETF proxy)' },
    { id: 'ng', label: 'Nigeria', iso3: 'NGA', oil: 'exporter', fx: 'USDNGN=X', fxLabel: 'USD / NGN', index: null, indexLabel: null },
    { id: 'ke', label: 'Kenya', iso3: 'KEN', oil: 'importer', fx: 'USDKES=X', fxLabel: 'USD / KES', index: null, indexLabel: null },
  ],
};
const ALL_COUNTRIES = Object.fromEntries(Object.entries(MACRO_COUNTRIES).flatMap(([region, list]) => list.map((c) => [c.id, { ...c, region }])));
const COUNTRY_MACRO_REGION = { us: 'us', ea: 'eu' }; // where free official macro is actually current

// Country-scoped upcoming catalysts — real dated releases from TradingView's public economic
// calendar (the same JSON its own calendar page uses; it 403s without an Origin header). Only
// high/medium-importance releases are kept, so the list stays short and relevant to the country.
const TV_COUNTRY = { us: 'US', ea: 'EU', de: 'DE', fr: 'FR', uk: 'GB', jp: 'JP', in: 'IN', cn: 'CN', hk: 'HK', sg: 'SG', id: 'ID', th: 'TH', my: 'MY', ph: 'PH', vn: 'VN', kr: 'KR', au: 'AU', tw: 'TW',
  sa: 'SA', ae: 'AE', qa: 'QA', za: 'ZA', ng: 'NG', ke: 'KE',
  br: 'BR', ve: 'VE', mx: 'MX', ar: 'AR' };
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
  const all = (j.result || []).filter((e) => e.date && e.indicator !== 'Holidays' && !/\b(holiday|festival)\b/i.test(e.title || ''));
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
// What a country's index is measured against: idx:<country> (its index), fx:<currency id>, bench:<commodity>.
function resolveVs(spec) {
  const [kind, id] = String(spec || '').split(':');
  if (kind === 'idx') { const c = ALL_COUNTRIES[id]; return c && c.index ? { spec, sym: c.index, label: c.indexLabel || c.label } : null; }
  if (kind === 'fx') { const f = FX_SYMS.find((x) => x.id === id); return f ? { spec, sym: f.sym, label: f.label.replace(/\s*·.*/, '') } : null; }
  if (kind === 'bench') { const b = BENCHMARKS.find((x) => x.id === id); return b && b.paper ? { spec, sym: b.paper, label: b.label } : null; }
  return null;
}
const COUNTRY_RANGE_DAYS = { '1m': 31, '3m': 92, '6m': 183, ytd: null, '1y': 366 };
function rangeStart(range) {
  if (range === 'ytd') return `${new Date().getUTCFullYear()}-01-01`;
  const days = COUNTRY_RANGE_DAYS[range];
  return days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : null;
}
async function getCountrySeries(id, range = '1y', vs = null) {
  const c = ALL_COUNTRIES[id];
  if (!c) return { error: 'unknown country' };
  // Default: vs the S&P 500 — or, for the US itself, vs the euro area.
  const want = resolveVs(vs) || resolveVs(c.id === 'us' ? 'idx:ea' : 'idx:us');
  return cached(`cs:${id}:${range}:${want ? want.spec : '-'}`, 3600e3, async () => {
    // Ranges up to a year are sliced out of the SAME 2-year daily series the country card already
    // needs for its multi-horizon moves (deltaSeries). That removes a separate 1y request per symbol
    // (fx, index and the comparison series), which is what made a cold region feel slow. Only 5y
    // still needs its own monthly request.
    const long = range === '5y';
    const mapFor = (sym) => (long
      ? cached(`csr:5y:${sym}`, 3600e3, () => yahooSeries(sym, '5y', '1mo')).then((r) => r.series).catch(() => ({}))
      : deltaSeries(sym).then((r) => r.series).catch(() => ({})));
    const [fxMap, idxMap, vsMap] = await Promise.all([
      mapFor(c.fx),
      c.index ? mapFor(c.index) : Promise.resolve({}),
      want ? mapFor(want.sym) : Promise.resolve({}),
    ]);
    const allDates = [...new Set([...Object.keys(idxMap), ...Object.keys(fxMap), ...Object.keys(vsMap)])].sort();
    const start = long ? null : rangeStart(range);
    const dates = start ? allDates.filter((d) => d >= start) : allDates;
    const at = (o, d) => (o[d] != null ? o[d] : null);
    // For a pegged currency the FX line is a constant (plus upstream bad ticks), so it is left out of
    // the chart entirely — the equity line is where the oil/gas signal actually shows up.
    return { id, label: c.label, range, dates,
      index: dates.map((d) => at(idxMap, d)),
      fx: c.peg ? [] : dates.map((d) => at(fxMap, d)),
      vs: want ? dates.map((d) => at(vsMap, d)) : [],
      vsSpec: want ? want.spec : null, vsLabel: want ? want.label : null,
      indexLabel: c.index ? c.indexLabel : null, fxLabel: c.fxLabel, peg: c.peg || null };
  });
}

// Every macro ticker (all regions) — so the macro tape is never sparse.
async function getMacroTickers() {
  return cached('macrotickers', 120e3, async () => {
    const q = async (sym) => { try { const { price, series } = await cached('q:' + sym, 120e3, () => yahooSeries(sym, '5d', '1d')); const d = Object.keys(series).sort(); const a = series[d[d.length - 1]], b = series[d[d.length - 2]]; return { price: a ?? price ?? null, pct: a != null && b ? ((a - b) / b) * 100 : null }; } catch { return { price: null, pct: null }; } };
    const items = (await Promise.all(Object.values(ALL_COUNTRIES).map(async (c) => {
      const arr = [{ id: c.id, label: c.fxLabel.replace(/\s*·.*/, ''), ...noMoveIfPegged(c, await q(c.fx)) }];
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
      const arr = [{ id: c.id, label: c.fxLabel.replace(/\s*·.*/, ''), kind: 'fx', ...noMoveIfPegged(c, await q(c.fx)), deltas: c.peg ? {} : await dl(c.fx) }];
      if (c.index) arr.push({ id: c.id, label: c.indexLabel, kind: 'index', ...(await q(c.index)), deltas: await dl(c.index) });
      return arr;
    }))).flat();
    return { region, items };
  });
}
// BIS central-bank policy rates (free). Area codes: euro area = XM; DE/FR use XM.
const BIS_AREA = { us: 'US', ea: 'XM', de: 'XM', fr: 'XM', uk: 'GB', jp: 'JP', cn: 'CN', hk: 'HK', id: 'ID', th: 'TH', my: 'MY', ph: 'PH', in: 'IN', kr: 'KR', au: 'AU',
  sa: 'SA', za: 'ZA', br: 'BR', mx: 'MX' };   // verified: BIS carries SA, ZA, BR, MX; not AE, QA, NG, KE or VE
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
  // No entries for sa/ae/qa on purpose: a pegged currency does not correlate with anything, so the
  // card would print noise. The peg itself is the fact, and the card says so instead.
  // Brazil floats, so its correlations are real signal: ag exports + crude.
  mx: [['WTI crude', 'CL=F'], ['Silver', 'SI=F']],
  ar: [['Soybeans', 'ZS=F'], ['Wheat', 'ZW=F'], ['Corn', 'ZC=F'], ['Live Cattle', 'LE=F']],
  br: [['Soybeans', 'ZS=F'], ['Sugar', 'SB=F'], ['Coffee', 'KC=F'], ['Brent crude', 'BZ=F']],
  ve: [['Brent crude', 'BZ=F']],
  za: [['Gold', 'GC=F'], ['Platinum', 'PL=F']],
  ng: [['Brent crude', 'BZ=F']],
  ke: [['Coffee', 'KC=F']],
};
// Where there is no policy rate, say why (accurately).
const POLICY_NOTE = {
  sg: 'Singapore has no central-bank policy interest rate: the MAS runs monetary policy by managing the S$ exchange rate (the S$NEER), not a rate. Its market benchmark is SORA (Singapore Overnight Rate Average).',
  tw: 'Taiwan’s policy rate (CBC discount rate) is not on the free BIS policy-rate feed.',
  vn: 'Vietnam’s policy rate (SBV refinancing rate) is not on the free BIS policy-rate feed.',
  ph: 'The BIS series currently carries no value for the Philippines policy rate.',
  ae: 'The dirham is pegged to the US dollar (3.6725) and the CBUAE base rate is set to track the Fed, so it is not in the BIS policy-rate feed.',
  qa: 'The riyal is pegged to the US dollar (3.64) and QCB rates track the Fed, so they are not in the BIS policy-rate feed.',
  ng: 'The Central Bank of Nigeria\u2019s policy rate (MPR) is not on the free BIS policy-rate feed.',
  ke: 'The Central Bank of Kenya\u2019s policy rate is not on the free BIS policy-rate feed.',
  ar: 'The BIS Argentina series stops in July 2025, and the BCRA rate moves often — rather than show a 15-month-old level as if it were current, we leave it out.',
  ve: 'Venezuela has no BIS policy rate. Note the currency: the rate shown is the official BCV reference \u2014 a parallel market rate exists and has traded far weaker, so treat the level as indicative.',
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
// TradingView's scanner publishes sovereign 2y/10y yields for every market in BOND_YIELDS. FRED's OECD
// series is monthly and lagged even when it is up; this keeps the panel daily and alive when FRED is not.
const TV_YIELD = { jp: 'JP', de: 'DE', fr: 'FR', uk: 'GB', ea: 'EU', kr: 'KR', au: 'AU', cn: 'CN', id: 'ID', mx: 'MX', br: 'BR', in: 'IN', za: 'ZA', ca: 'CA', ch: 'CH', it: 'IT', es: 'ES', tr: 'TR' };
async function tvYields() {
  return cached('tvyields', 900e3, async () => {
    const codes = [...new Set(Object.values(TV_YIELD))];
    const tickers = codes.flatMap((c) => [`TVC:${c}10Y`, `TVC:${c}02Y`]);
    const res = await fetch('https://scanner.tradingview.com/global/scan', {
      method: 'POST',
      headers: { ...TV_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: { tickers, query: { types: [] } }, columns: ['close'] }),
    });
    if (!res.ok) throw new Error('tradingview ' + res.status);
    const by = {};
    for (const r of (await res.json()).data || []) {
      const m = /^TVC:([A-Z]{2})(\d{2})Y$/.exec(String(r.s || ''));
      const v = r.d && r.d[0];
      if (!m || v == null || !Number.isFinite(+v)) continue;
      (by[m[1]] = by[m[1]] || {})[m[2]] = +v;
    }
    return by;
  });
}
async function getBondYields(id) {
  const cfg = BOND_YIELDS[id];
  const label = ALL_COUNTRIES[id]?.label || id;
  if (!cfg) return { id, label, error: 'no free bond-yield data', freq: null, short: null, long: null, spread: null };
  return cached('yields:' + id, 6 * 3600e3, async () => {
    const days = 5 * 366 + 30;
    const get = async (spec) => {
      if (!spec) return null;
      let map = await fredSeries(spec.id, days);
      if (Object.keys(map).length < 5) map = await treasurySeries(spec.id).catch(() => ({}));
      const dates = Object.keys(map).sort();
      if (!dates.length) return null;
      const last = [...dates].reverse().find((d) => map[d] != null) || null;
      return { label: spec.label, dates, values: dates.map((d) => map[d]), latest: last ? map[last] : null, date: last };
    };
    let [short, long] = await Promise.all([get(cfg.short), get(cfg.long)]);
    let freq = cfg.freq;
    let note = null;
    if (!short || !long) {
      // Second source: TradingView's own 2y/10y quotes. Tenors differ from FRED's 3-month, and the
      // labels say so rather than pretending it is the same series.
      const tv = await tvYields().catch(() => null);
      const code = TV_YIELD[id];
      const row = (tenor, ten) => {
        const v = tv && code && tv[code] ? tv[code][tenor] : null;
        if (v == null) return null;
        const d = new Date().toISOString().slice(0, 10);
        return { label: ten, dates: [d], values: [v], latest: v, date: d };
      };
      if (!short) short = row('02', '2-yr');
      if (!long) long = row('10', '10-yr');
      if (short || long) { freq = 'daily · TradingView (2y / 10y)'; note = 'FRED unavailable — showing the live 2y/10y quote'; }
    }
    const spread = short?.latest != null && long?.latest != null ? +(long.latest - short.latest).toFixed(2) : null;
    if (!short && !long) note = 'yield feed unavailable right now';
    return { id, label, freq, short, long, spread, note, asOf: (long?.date || short?.date || null) };
  });
}
async function getCountry(id) {
  const c = ALL_COUNTRIES[id];
  if (!c) return { error: 'unknown country' };
  return cachedSWR('country:' + id, 15 * 60e3, async () => {
    const quote = async (sym) => { try { const { price, series } = await cached('q:' + sym, 120e3, () => yahooSeries(sym, '5d', '1d')); const d = Object.keys(series).sort(); const a = series[d[d.length - 1]], b = series[d[d.length - 2]]; return { price: a ?? price ?? null, pct: a != null && b ? ((a - b) / b) * 100 : null }; } catch { return { price: null, pct: null }; } };
    const rk = COUNTRY_MACRO_REGION[id];
    // Annual macro: the IMF snapshot is committed weekly and already covers every country. Only ask
    // the (slow, rate-limited) World Bank / FRED for a field the snapshot does not have — the old code
    // fetched all four World Bank series on every country, even when all four were sitting in macro.json.
    const snap = (MACRO_SNAPSHOT && MACRO_SNAPSHOT.countries && MACRO_SNAPSHOT.countries[id]) || null;
    const needGdp = !snap?.gdpGrowth?.length;
    const needCpi = !snap?.cpi?.length;
    const needDebt = !snap?.debtToGdp;
    // Unemployment keeps the "newer vintage wins" rule: only skip the World Bank when the snapshot is
    // already at the latest completed year.
    const needUnemp = !snap?.unemployment || snap.unemployment.year < (MACRO_SNAPSHOT?.maxYear || 0);
    // Everything independent runs CONCURRENTLY — the whole panel in one round trip. News and the index
    // series are already computed here, so they ride WITH the card (no second request). Yields and the
    // release calendar are genuinely separate feeds and stay on /api/country-extras, so they can never
    // hold the card itself.
    const [fx, idx, wbGdp, wbDebt, wbCpi, wbUnemp, cs, mn, oilLink, macroMd, policy, links, fxDlMap, idxDlMap, fredDebtToGdp] = await Promise.all([
      quote(c.fx),
      c.index ? quote(c.index) : Promise.resolve({ price: null, pct: null }),
      needGdp ? wbSeries(c.iso3, 'NY.GDP.MKTP.KD.ZG') : Promise.resolve([]),
      needDebt ? wbLatest(c.iso3, 'GC.DOD.TOTL.GD.ZS') : Promise.resolve(null),
      needCpi ? wbSeries(c.iso3, 'FP.CPI.TOTL.ZG') : Promise.resolve([]),
      needUnemp ? wbLatest(c.iso3, 'SL.UEM.TOTL.ZS') : Promise.resolve(null),
      getCountrySeries(id, '1y').catch(() => ({})),
      getMacroNews(id).catch(() => ({ items: [] })),
      pairCorr(c.fx, 'CL=F').catch(() => null),
      rk ? getMacroDash().catch(() => null) : Promise.resolve(null),
      getPolicyRate(BIS_AREA[id]).catch(() => null),
      (() => Promise.all((COUNTRY_COMMODITY_LINKS[id] || []).map(async ([commodity, csym]) => ({ commodity, corr: await pairCorr(c.fx, csym).catch(() => null) }))).catch(() => []))(),
      deltaSeries(c.fx).then((r) => r.series).catch(() => ({})),
      c.index ? deltaSeries(c.index).then((r) => r.series).catch(() => ({})) : Promise.resolve({}),
      needDebt ? fredDebt(c.iso3) : Promise.resolve(null),
    ]);
    const chg = (arr) => { const f = (arr || []).find((v) => v != null); const l = [...(arr || [])].reverse().find((v) => v != null); return f && l ? ((l - f) / f) * 100 : null; };
    const gdpGrowth = snap?.gdpGrowth?.length ? snap.gdpGrowth : wbGdp.slice(-6);
    const debtToGdp = snap?.debtToGdp || fredDebtToGdp || wbDebt;
    const cpi = snap?.cpi?.length ? snap.cpi : wbCpi.slice(-25);
    const inflation = snap?.inflation || (cpi.length ? cpi[cpi.length - 1] : null);
    // Newer vintage wins: the IMF line stops in 2018 for Nigeria while the World Bank has 2025.
    const unempFromWb = !snap?.unemployment || (wbUnemp && wbUnemp.year > snap.unemployment.year);
    const unemployment = unempFromWb ? wbUnemp : snap.unemployment;
    const perf = { index: chg(cs.index), fx: c.peg ? null : chg(cs.fx) };
    // Every price in the country card gets the same multi-horizon moves + a source/as-of.
    const fxDeltas = mapDeltas(fxDlMap);
    const idxDeltas = mapDeltas(idxDlMap);
    const asOf = (Object.keys(fxDlMap || {}).sort().slice(-1)[0]) || (cs.dates || []).slice(-1)[0] || null;
    const macro = macroMd ? (macroMd.regions?.[rk] || null) : null;
    const takes = [];
    if (policy) takes.push(`Central bank policy rate <b>${policy.latest.value}%</b> (as of ${policy.latest.date}).`);
    else if (POLICY_NOTE[id]) takes.push(POLICY_NOTE[id]);
    if (perf.index != null && c.index) takes.push(`${c.indexLabel} <b>${perf.index >= 0 ? '+' : ''}${perf.index.toFixed(0)}%</b> over the last year.`);
    if (perf.fx != null && !c.peg) takes.push(`${c.fxLabel} <b>${perf.fx >= 0 ? '+' : ''}${perf.fx.toFixed(0)}%</b> over the last year${perf.fx >= 0 ? ' (a higher USD-pair = weaker local currency)' : ''}.`);
    if (inflation || unemployment) takes.push(`Inflation <b>${inflation ? inflation.value + '% (' + inflation.year + ')' : 'n/a'}</b> · unemployment <b>${unemployment ? unemployment.value + '% (' + unemployment.year + ')' : 'n/a'}</b>.`);
    if (debtToGdp && debtToGdp.year >= 2018) takes.push(`Government debt is <b>${debtToGdp.value}% of GDP</b> (${debtToGdp.year}).`);
    if (c.peg) takes.push(`${c.label}\u2019s currency is <b>pegged to the US dollar at ${c.peg}</b>, so the FX line barely moves \u2014 the oil story shows up in the equity line instead.`);
    else if (oilLink != null) takes.push(`${c.label} is a net oil ${c.oil}; its currency's 3-month correlation vs Brent is <b>${oilLink}</b>.`);
    for (const it of (mn.items || []).slice(0, 2)) takes.push(`<b>${it.kind}</b>: ${escHtml(it.title)}.`);
    return {
      id, label: c.label, region: c.region, iso3: c.iso3, oil: c.oil, peg: c.peg || null,
      // A peg is a constant: the upstream daily series carries bad ticks (USDSAR reads 3.6397 for days
      // then jumps to the true 3.7526), so any % change off it is noise. Keep the level, drop the moves.
      fx: { label: c.fxLabel, sym: c.fx, ...(c.peg ? { price: fx.price, pct: null } : fx), deltas: c.peg ? {} : fxDeltas, asOf, source: 'Yahoo Finance' },
      index: { label: c.indexLabel, sym: c.index, ...idx, deltas: idxDeltas, asOf, source: 'Yahoo Finance' },
      macro, oilLink, perf, takeaways: takes, policy, policyNote: POLICY_NOTE[id] || null, links,
      cpi,   // annual CPI inflation % (IMF WEO, World Bank fallback)
      // News and the chart series are already computed above — send them with the card so the panel
      // does not fire two more requests after every country switch. Yields and catalysts stay on
      // /api/country-extras (separate feeds, never allowed to hold the card).
      news: mn, series: cs,
      fund: { gdpGrowth: gdpGrowth.slice(-6), debtToGdp, inflation, unemployment,
        source: snap
          ? ('IMF WEO (annual snapshot)' + (unempFromWb && wbUnemp ? ' · unemployment: World Bank' : ''))
          : (fredDebtToGdp ? 'Debt/GDP: FRED (OECD) · others World Bank (annual)' : 'World Bank (annual)') },
    };
  });
}

// The two feeds that are genuinely slow and independent of the card: the bond-yield series and the
// release calendar. One request returns both, so a country switch is card (1) + extras (1), not five
// separate round trips — and neither can delay the card itself.
async function getCountryExtras(id) {
  if (!ALL_COUNTRIES[id]) return { error: 'unknown country' };
  return cachedSWR('country-extras:' + id, 15 * 60e3, async () => {
    const [yields, catalysts] = await Promise.all([
      getBondYields(id).catch(() => null),
      getCatalysts(id).catch(() => null),
    ]);
    return { id, yields, catalysts };
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
  // A hung upstream must not hold the event pool or a panel: every Google News call settles in 12s.
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
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
  return cachedUnlessEmpty('headlines', 20 * 60e3, async () => {
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
  }, (v) => !(v.items && v.items.length));
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
  return cachedUnlessEmpty('mnews:' + id, 40 * 60e3, async () => {
    // Drop anything that is not actually an economy/market story — e.g. a sports or film headline
    // that merely names the country (the MACRO domain guard).
    // Ask for the full feed (100), not 30: the tier-1 wire query returns plenty, but only a fraction
    // of it actually NAMES the country — Qatar had 28 such stories out of 100 and none in the first 30,
    // so a 30-item window made its panel look empty.
    const items = (await fetchGoogleNews(`(${terms}) (rate OR inflation OR economy OR election OR sanctions OR protest OR IMF OR stimulus OR tariff OR downgrade) ${NEWS_TIER1}`, 100).catch(() => []))
      .filter((it) => newsContextOk(it.title, { domain: 'macro' })   // must BE an economy story...
        && titleMatches(id, it.title)                                // ...name THIS country...
        && TIER1_RE.test(it.source || ''));                          // ...and come from a real wire
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
  }, (v) => !(v.items && v.items.length));
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
  return cachedSWR('transmission', 30 * 60e3, async () => {
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
        up: ['XOM', 'CVX', 'COP', 'SLB'], down: ['NEM', 'GDX', 'AAL', 'DAL'], segments: ['crude', 'refined', 'precious', 'industrial'], regions: ['us', 'eu', 'jp', 'apac', 'me', 'af'] });
      add({ id: 'oil-importers', trigger: `Oil ${oil1m >= 0 ? '+' : ''}${oil1m.toFixed(1)}% in a month`,
        chain: 'Oil is priced in dollars and imported by most of Europe & Asia — a rising oil bill widens their <b>trade deficit</b>, pressures their <b>currencies</b> and squeezes consumer spending, while exporters gain.',
        benefits: ['Oil exporters (Norway, Canada, Brazil, Gulf, US shale)'], hurt: ['Big oil importers: Japan, euro area, India, Korea, China'],
        up: ['SU', 'PBR', 'CNQ'], down: [], segments: ['crude'], regions: ['eu', 'jp', 'apac'] });
    }
    if (oil1m != null && oil1m < -3) {
      add({ id: 'oil-deflation-rates', trigger: `Oil ${oil1m.toFixed(1)}% in a month`,
        chain: 'Falling oil cools <b>inflation expectations</b> → room for lower rates → a tailwind for <b>precious metals</b> and rate-sensitive assets, and relief for fuel users; energy producers lose out.',
        benefits: ['Airlines, trucking, chemicals', 'Precious metals (if yields fall)'], hurt: ['Energy producers & services'],
        up: ['DAL', 'UAL', 'GDX'], down: ['XOM', 'COP', 'SLB'], segments: ['crude', 'refined', 'precious'], regions: ['us', 'eu', 'jp', 'apac', 'me', 'af'] });
    }
    if (dxy1m != null && Math.abs(dxy1m) > 1.5) {
      const up = dxy1m > 0;
      add({ id: 'dollar', trigger: `US dollar ${up ? '+' : ''}${dxy1m.toFixed(1)}% in a month`,
        chain: up ? 'A firmer dollar makes dollar-priced commodities <b>more expensive</b> for the rest of the world, a broad headwind, and tightens global financial conditions, pressing emerging markets.'
          : 'A softer dollar makes dollar-priced commodities <b>cheaper</b> for the world, a broad tailwind, and eases global financial conditions, supporting emerging markets.',
        benefits: up ? ['US importers', 'dollar-funded carry'] : ['Commodities broadly', 'Emerging-market assets'], hurt: up ? ['Commodities', 'EM currencies & assets'] : ['US import prices (inflation risk)'],
        up: up ? [] : ['GLD', 'EEM', 'FCX'], down: up ? ['GLD', 'EEM', 'FCX'] : [], segments: ['precious', 'industrial', 'grains', 'softs', 'crude'], regions: ['us', 'af'] });
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
        benefits: ['Gold & silver miners', 'Royalty/streamers'], hurt: ['—'], up: ['NEM', 'AEM', 'GDX', 'WPM'], down: [], segments: ['precious'], regions: ['us', 'apac', 'af'] });
    }
    if (copper1m != null && copper1m > 5) {
      add({ id: 'copper-growth', trigger: `Copper +${copper1m.toFixed(1)}% in a month`,
        chain: 'Copper is the <b>growth barometer</b> — a sharp rise signals firm industrial demand / stimulus, lifting cyclicals and rate expectations, and (via electrification) supporting grid & EV supply chains.',
        benefits: ['Copper miners', 'Electrification & grid suppliers'], hurt: ['Cost-pressured construction & autos'],
        up: ['FCX', 'SCCO', 'RIO', 'BHP'], down: [], segments: ['industrial', 'precious'], regions: ['apac', 'af'] });
    }
    if (corn1m != null && corn1m > 4) {
      add({ id: 'food-inflation', trigger: `Grains +${corn1m.toFixed(1)}% in a month`,
        chain: 'Higher grains feed <b>food inflation</b> (a regressive squeeze on consumers, especially in emerging Asia) while helping farmers, inputs and grain traders.',
        benefits: ['Farm inputs & equipment', 'Grain traders & processors'], hurt: ['Food makers', 'Livestock (feed cost)', 'EM consumers'],
        up: ['DE', 'ADM', 'BG', 'CF'], down: ['TSN', 'KHC'], segments: ['grains', 'softs'], regions: ['apac', 'eu', 'af'] });
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
    const tight = ev.filter((e) => e.direction === 'TIGHT').length;
    const loose = ev.filter((e) => e.direction === 'LOOSE').length;
    const verdict = tight > loose
      ? `OIL IS TIGHT — ${tight} of ${ev.length} independent checks agree.`
      : loose > tight ? `OIL IS WELL SUPPLIED — ${loose} of ${ev.length} checks say plenty.`
        : `MIXED — ${tight} say tight, ${loose} say loose.`;
    return { evidence: ev, tight, loose, verdict };
  });
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

// Steel margin — the industrial segment's equivalent of the soybean crush (ore -> hot-rolled coil).
async function getSteelMargin() {
  return cached('steelmargin', 3 * 3600e3, async () => {
    const m = await getMarket();
    const now = computeSteel(m);
    const ser = (sym) => cached('a2p:' + sym, 6 * 3600e3, () => yahooSeries(sym, '2y', '1d')).then((r) => r.series);
    const [hrc, ore] = await Promise.all([ser('HRC=F'), ser('TIO=F')]);
    const dates = Object.keys(hrc).sort();
    const hd = [], margin = [], ratio = [];
    for (const d of dates) {
      if (hrc[d] == null || ore[d] == null) continue;   // only days both markets printed
      const coilPerT = hrc[d] / 0.90718474, orePerT = ore[d] * 1.6;
      hd.push(d); margin.push(coilPerT - orePerT); ratio.push(ore[d] ? coilPerT / ore[d] : null);
    }
    const pct = (a, v) => { const xs = a.filter((x) => x != null); return xs.length && v != null ? (xs.filter((x) => x <= v).length / xs.length) * 100 : null; };
    const cur = now.margin ?? [...margin].reverse().find((x) => x != null) ?? null;
    const curRatio = now.ratio ?? [...ratio].reverse().find((x) => x != null) ?? null;
    return {
      label: 'Steel margin',
      margin: cur, pct: pct(margin, cur),
      ratio: curRatio, ratioPct: pct(ratio, curRatio),
      legs: { coilPerT: now.coilPerT ?? null, orePerT: now.orePerT ?? null },
      history: { dates: hd.slice(-180), margin: margin.slice(-180), ratio: ratio.slice(-180) },
    };
  });
}

// ---------------------------------------------------------------------------
// Server-side alerts + daily digest (notifications, webhook, email)
// ---------------------------------------------------------------------------
const DIGEST_LOG = path.join(__dirname, 'digest.log');
const STATE_FILE = path.join(__dirname, '.state.json');
// Render's free tier wipes the filesystem on redeploy *and* on each sleep/wake, which would silently
// drop subscribers, rules and alert cooldowns. Point UPSTASH_REDIS_REST_URL + _TOKEN at any free Redis
// (Upstash's free tier is plenty) and the state lives there instead — plain REST, so the project stays
// zero-dependency. Without them we fall back to the local file.
const KV_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY = process.env.STATE_KEY || 'watchtower:state';
const stateDurable = Boolean(KV_URL && KV_TOKEN);
const alertSeen = new Map();                 // alert key -> last-notified ms (persisted below)
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const state = loadState();
// Restore the cooldowns so a restart/redeploy doesn't re-fire every alert.
for (const [k, v] of Object.entries(state.alertSeen || {})) alertSeen.set(k, v);
const kvHeaders = () => ({ authorization: `Bearer ${KV_TOKEN}` });
let kvTimer = null;
const kvPut = async () => {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(KV_KEY)}`, { method: 'POST', headers: kvHeaders(), body: JSON.stringify(state) });
  if (!r.ok) throw new Error(`kv set ${r.status}`);
};
const saveState = () => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}    // instant, and the fallback
  if (!stateDurable) return;
  clearTimeout(kvTimer);                                                   // debounce the remote write
  kvTimer = setTimeout(() => kvPut().catch((e) => console.warn('[state] save failed:', e.message)), 1500);
};
// On boot prefer the remote copy (it survives deploys); the file stays as a cold-start fallback.
async function loadRemoteState() {
  if (!stateDurable) return;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(KV_KEY)}`, { headers: kvHeaders() });
    if (!r.ok) throw new Error(`kv get ${r.status}`);
    const j = await r.json();
    if (!j || j.result == null) return;                     // nothing stored yet → keep the file
    const remote = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
    if (!remote || typeof remote !== 'object') return;
    Object.assign(state, remote);
    for (const [k, v] of Object.entries(state.alertSeen || {})) alertSeen.set(k, v);
    console.log(`[state] restored from Redis: ${Object.keys(remote).length} keys`);
  } catch (e) { console.warn('[state] could not read Redis, using the file:', e.message); }
}
let lastDigestDate = state.lastDigestDate || null;
let lastDigest = '';
// Per-caller, not global: one shared clock let a single visitor lock everyone else out of the test
// button, and let anyone in the world trigger a mail every minute.
const testSentAt = new Map();

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
  return out;
}

// Delivery outcomes, so the UI can say whether email actually works (and why not).
const notifyStatus = { lastAt: null, lastKind: null, lastOk: null, lastError: null, digestAt: null, digestDate: null };
// Two ways to send, and the first is the quick one: an email API key (Resend's free tier sends from
// onboarding@resend.dev to your own address with no domain and no app password), or plain SMTP.
const resendKey = () => process.env.RESEND_API_KEY || '';
const mailProvider = () => (resendKey() ? 'resend' : (process.env.SMTP_USER && process.env.SMTP_PASS ? 'smtp' : null));
const mailConfigured = () => Boolean(process.env.DIGEST_TO && mailProvider());
// Resend's no-domain sender (onboarding@resend.dev) only delivers to the account owner's own address —
// so without a verified sending domain the PUBLIC email sign-up can't reach visitors, and we say so
// instead of accepting a stranger's address and failing. Plain SMTP has no such restriction.
const emailReach = () => {
  const p = mailProvider();
  if (!p) return 'none';
  if (p === 'smtp') return 'anyone';
  const from = String(process.env.MAIL_FROM || '');
  return (!from || /resend\.dev/i.test(from)) ? 'owner-only' : 'anyone';
};

async function sendEmail(subject, text) {
  if (!mailConfigured()) return notifyStatus.lastError = 'not configured (need DIGEST_TO plus RESEND_API_KEY or SMTP_USER/SMTP_PASS)';
  if (resendKey()) {
    const r = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${resendKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Watchtower <onboarding@resend.dev>',
        to: [process.env.DIGEST_TO],
        subject,
        text,
      }),
    });
    if (!r.ok) throw new Error(`resend ${r.status} ${String(await r.text().catch(() => '')).slice(0, 80)}`);
    return true;
  }
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
  if (!mailConfigured()) { notifyStatus.lastOk = null; notifyStatus.lastError = `not configured (need DIGEST_TO plus ${resendKey() ? 'RESEND_API_KEY' : 'SMTP_USER/SMTP_PASS'})`; }
  else {
    try { await sendEmail(subject, text); notifyStatus.lastOk = true; notifyStatus.lastError = null; }
    catch (e) { notifyStatus.lastOk = false; notifyStatus.lastError = e.message; console.error('[mail]', e.message); }
  }
}

async function buildDigest() {
  const m = await getMarket();
  const [c, inv, pos] = await Promise.all([getCurves().catch(() => null), getInventories().catch(() => null), getPositioning().catch(() => null)]);
  const L = [`MARLON'S WATCHTOWER — daily digest (${new Date().toISOString()})`, ''];
  // Freshness first: if the nightly refresh stopped, this email is the thing that tells you.
  L.push(dataFreshnessLine());
  L.push('');
  L.push('PRICES  futures | real | gap | age(days)');
  for (const b of m.benchmarks) L.push(`  ${b.label.padEnd(20)} ${(b.paper ?? '—').toString().padStart(9)} | ${(b.physical ?? '—').toString().padStart(9)} | ${(b.basis == null ? '—' : sgn(b.basis)).padStart(8)} | ${b.spotLagDays ?? '—'}`);
  if (c?.wti) L.push('', `PRICES FOR MONTHS AHEAD  WTI ${c.wti.shape} (this-vs-next ${sgn(c.wti.m1m2)}, vs 6mo ${sgn(c.wti.m1m6)})  |  Brent ${c.brent.shape} (this-vs-next ${sgn(c.brent.m1m2)})`);
  if (pos?.latest) L.push('', `HEDGE-FUND BETS  ${pos.label}: ${pos.latest.net.toLocaleString()} (${pos.pct.toFixed(0)}/100 extreme), change this week ${pos.wow >= 0 ? '+' : ''}${pos.wow.toLocaleString()}`);
  if (inv?.items) { L.push('', 'US STOCKPILES (million barrels, this week):'); inv.items.forEach((i) => L.push(`  ${i.label.padEnd(16)} ${i.value.toLocaleString().padStart(10)}  (${i.wow >= 0 ? '+' : ''}${i.wow.toLocaleString()})`)); }
  const alerts = await computeServerAlerts();
  if (alerts.length) { L.push('', 'ALERTS:'); alerts.forEach((x) => L.push(`  [${x.level.toUpperCase()}] ${x.text}`)); }
  L.push('', 'Sources: FRED/EIA, Yahoo, CFTC. Not investment advice.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// IMPORTANT TODAY — the event-first half of the brief.
// The rest of this file starts from the tape. This starts from the wire: classify, cluster to one
// event per (category, subject, day), score importance, then attach the day's prices as evidence.
// The "why" is extracted from the headline's own causal clause, or falls back to a curated
// transmission rule — never invented. See EVENT_CATEGORIES in src/lib.js.
// ---------------------------------------------------------------------------
const EVENT_COUNTRIES = ['us', 'cn', 'jp', 'ea', 'in', 'uk', 'kr', 'id', 'br', 'mx', 'sa', 'za'];
const EVENT_QUERIES = [
  `(MSCI OR "FTSE Russell" OR "index review" OR reclassification OR "market access" OR "capital controls" OR "trading halt") (stocks OR equities OR index) ${NEWS_TIER1}`,
  `(sanctions OR "export ban" OR embargo OR tariffs) (oil OR gas OR metals OR grain OR markets) ${NEWS_TIER1}`,
  `(OPEC OR "output cut" OR "production cut") (oil OR crude) ${NEWS_TIER1}`,
  `(war OR conflict OR attack OR Hormuz OR "Red Sea" OR chokepoint) (oil OR shipping OR markets) ${NEWS_TIER1}`,
  `("central bank" OR "rate decision" OR "sovereign downgrade" OR IMF) (stocks OR currency OR bonds) ${NEWS_TIER1}`,
];
// A broad discovery query can surface pure politics ("North Korea says sanctions don't work").
// For those items only, require a tradable subject as well as tier-1 sourcing.
const EVENT_MARKET = /\b(oil|crude|gas|LNG|diesel|gasoline|fuel|refin\w*|gold|copper|aluminium|aluminum|iron ore|steel|corn|wheat|soybean|sugar|coffee|cocoa|cotton|palm|rice|cattle|hogs|beef|milk|butter|cheese|stocks?|shares?|equit(y|ies)|index|indices|currenc\w*|\bfx\b|bond|yields?|dollar|yuan|yen|rupiah|won|rand|peso|riyal|exports?|imports?|trade|supply|demand|prices?|commodit\w*|markets?)\b/i;
// What a country's market is actually exposed to, so a shared driver can be named without pretending
// it is a country-specific cause. The UI labels these GLOBAL / COMMODITY.
const ROW_EXPOSURE = {
  us: ['tech'], jp: ['tech'], kr: ['tech'], tw: ['tech'], cn: ['tech'], hk: ['tech'],
  za: ['metals'], au: ['metals'], cl: ['metals'], pe: ['metals'], id: ['metals'],
  sa: ['oil'], ae: ['oil'], qa: ['oil'], ng: ['oil'], ve: ['oil'],
  wti: ['oil'], brent: ['oil'], rbob: ['oil'], ulsd: ['oil'], jet: ['oil'], propane: ['oil'], natgas: ['oil'],
  gold: ['metals'], silver: ['metals'], copper: ['metals'], aluminium: ['metals'], ironore: ['metals'],
  steel: ['metals'], platinum: ['metals'], palladium: ['metals'],
  corn: ['ags'], wheat: ['ags'], soybean: ['ags'], soymeal: ['ags'], soyoil: ['ags'], sugar: ['ags'],
  coffee: ['ags'], cocoa: ['ags'], cotton: ['ags'], palm: ['ags'], rice: ['ags'], orange: ['ags'],
  cattle: ['ags'], hogs: ['ags'], feeder: ['ags'], milk: ['ags'], butter: ['ags'], nfdm: ['ags'],
  cheese: ['ags'], whey: ['ags'],
};
const REGION_GROUP = {
  us: 'americas', mx: 'americas', br: 'americas', ar: 'americas', ve: 'americas', latam: 'americas',
  eu: 'europe', de: 'europe', fr: 'europe', uk: 'europe', ea: 'europe', europe: 'europe',
  jp: 'asia', cn: 'asia', kr: 'asia', hk: 'asia', tw: 'asia', sg: 'asia', th: 'asia', my: 'asia',
  id: 'asia', ph: 'asia', vn: 'asia', in: 'asia', au: 'asia', apac: 'asia', asia: 'asia',
  sa: 'gulf', ae: 'gulf', qa: 'gulf', me: 'gulf', gulf: 'gulf',
  za: 'africa', ng: 'africa', ke: 'africa', af: 'africa', africa: 'africa',
};
const ROW_GROUP = Object.fromEntries(Object.keys(ALL_COUNTRIES)
  .map((id) => [id, REGION_GROUP[id] || REGION_GROUP[(ALL_COUNTRIES[id] || {}).region] || null])
  .filter(([, g]) => g));
const BENCH_ALIAS = {
  wti: ['WTI', 'crude oil', 'US crude', 'Hormuz', 'Red Sea', 'Suez', 'OPEC'],
  brent: ['Brent', 'Brent crude'],
  rbob: ['gasoline', 'petrol'],
  ulsd: ['diesel', 'heating oil'],
  jet: ['jet fuel'],
  propane: ['propane'],
  natgas: ['natural gas', 'LNG'],
  gold: ['gold', 'bullion'],
  copper: ['copper'],
  aluminium: ['aluminium', 'aluminum'],
  ironore: ['iron ore'],
  steel: ['steel', 'hot-rolled coil'],
  corn: ['corn'],
  wheat: ['wheat'],
  soybean: ['soybeans', 'soybean'],
  soymeal: ['soybean meal', 'soymeal'],
  soyoil: ['soybean oil', 'soyoil'],
  sugar: ['sugar'],
  coffee: ['coffee'],
  cocoa: ['cocoa'],
  cotton: ['cotton'],
  palm: ['palm oil'],
  rice: ['rice'],
  orange: ['orange juice'],
  cattle: ['live cattle', 'cattle'],
  hogs: ['lean hogs', 'hogs'],
  feeder: ['feeder cattle'],
  milk: ['Class III milk', 'milk'],
  butter: ['butter'],
  nfdm: ['nonfat dry milk', 'NFDM'],
  cheese: ['cheddar', 'cheese'],
  whey: ['dry whey', 'whey'],
};
const COUNTRY_ALIAS = {
  us: [/United States/, /\bU\.S\.\b/, /\bUS\b/, 'Wall Street', 'S&P 500', 'Federal Reserve', /\bFed\b/],
  cn: ['China', 'Chinese', 'Beijing', 'PBOC', 'Shanghai Composite', 'yuan', 'renminbi'],
  jp: ['Japan', 'Japanese', 'Tokyo', 'BoJ', 'Bank of Japan', 'Nikkei', 'TOPIX', 'yen'],
  ea: ['euro area', 'eurozone', 'ECB', 'European Central Bank', 'euro'],
  in: ['India', 'Indian', 'Mumbai', 'RBI', 'Reserve Bank of India', 'Sensex', 'Nifty', 'rupee'],
  uk: [/\bUK\b/, 'Britain', 'British', 'BoE', 'Bank of England', 'FTSE', 'sterling'],
  kr: ['Korea', 'Korean', 'Seoul', 'KOSPI', 'Bank of Korea'],
  id: ['Indonesia', 'Indonesian', 'Jakarta', 'IDX', 'rupiah', 'Bank Indonesia'],
  br: ['Brazil', 'Brazilian', 'Bovespa'],
  mx: ['Mexico', 'Mexican', 'peso', 'Banxico'],
  sa: ['Saudi', 'Riyadh', 'Tadawul', 'riyal'],
  za: ['South Africa', 'Johannesburg', 'rand'],
};
const COUNTRY_DEMONYM = {
  ar: 'Argentine', au: 'Australian', br: 'Brazilian', cn: 'Chinese', de: 'German', ea: 'European',
  fr: 'French', hk: 'Hong Kong', id: 'Indonesian', in: 'Indian', jp: 'Japanese', ke: 'Kenyan',
  kr: 'Korean', mx: 'Mexican', my: 'Malaysian', ng: 'Nigerian', ph: 'Philippine', qa: 'Qatari',
  sa: 'Saudi', sg: 'Singapore', th: 'Thai', tw: 'Taiwanese', uk: 'British', us: 'American',
  ve: 'Venezuelan', vn: 'Vietnamese', za: 'South African',
};
let _eventCatalog = null;
let evPoolAttempt = 0;
// The last selection the brief actually showed. The pool is rebuilt every 30 minutes in the
// background; without this, every rebuild window (and every request that lost the 1.5 s race)
// blanked the top of the brief until the next reload. Kept in memory, and the same five stories go
// into the state file so a restart can still show them.
const EVENT_SNAPSHOT_MAX_AGE = 2 * 3600e3;
let eventSnapshot = (state.briefEvents && Array.isArray(state.briefEvents.events) && state.briefEvents.at)
  ? { at: Date.parse(state.briefEvents.at) || 0, events: state.briefEvents.events, clusters: [] }
  : null;
function snapshotEvents() {
  if (!eventSnapshot || !(Date.now() - eventSnapshot.at <= EVENT_SNAPSHOT_MAX_AGE)) return { events: [], clusters: [] };
  return { events: eventSnapshot.events, clusters: eventSnapshot.clusters || [] };
}
function eventCatalog() {
  if (_eventCatalog) return _eventCatalog;
  const countries = Object.values(ALL_COUNTRIES).map((c) => ({
    id: c.id, label: c.label, kind: 'country',
    patterns: [...new Set([c.label, c.indexLabel, c.fxLabel, COUNTRY_DEMONYM[c.id], ...(COUNTRY_ALIAS[c.id] || [])].filter(Boolean))],
  }));
  const benches = BENCHMARKS.map((b) => ({
    id: b.id, label: b.label, kind: 'bench',
    patterns: [...new Set([
      String(b.label).replace(/\s*\(.*\)/, '').replace(/\s+\d+%.*$/, ''),
      ...(BENCH_ALIAS[b.id] || []),
    ].filter(Boolean))],
  }));
  return (_eventCatalog = [...countries, ...benches]);
}
async function settleLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...await Promise.allSettled(items.slice(i, i + limit).map(fn)));
  return out;
}
// The latest date any price series actually prints. A Sunday brief describes Friday's close, so the
// event freshness window and the labels must follow the session, not the wall clock.
function sessionDateOf(market) {
  return (market && market.benchmarks ? market.benchmarks : [])
    .map((b) => b.paperDate || b.physicalDate)
    .filter(Boolean)
    .sort()
    .pop() || null;
}

async function buildEventPool() {
  return cachedUnlessEmpty('eventpool', 30 * 60e3, async () => {
    const m = await getMarket().catch(() => null);
    const refDate = sessionDateOf(m) || new Date().toISOString().slice(0, 10);
    // The segment and country feeds already carry the on-topic filter; the extra queries cover the
    // categories the tape never asks about (index reviews, sanctions, geopolitics, policy).
    // Deliberately gentle: one group at a time, at most three concurrent Google News calls. Firing
    // all ~27 at once at boot is what made the macro/news caches come back empty (a 429 was then
    // stored as an empty answer for 40-45 minutes).
    const segLists = await settleLimit(MARKETS, 3, (m) => getNews(m.id).then((r) => r.items || []));
    const macroLists = await settleLimit(EVENT_COUNTRIES, 3, (id) => getMacroNews(id).then((r) => r.items || []));
    const headlines = await getHeadlines().then((r) => r.items || []).catch(() => []);
    const extra = await settleLimit(EVENT_QUERIES, 2, (q, i) => cachedUnlessEmpty('evq:' + i, 30 * 60e3, () => fetchGoogleNews(q, 40), (v) => !(v && v.length)));
    const dealBook = await refreshDeals().catch(() => null);
    const raw = [];
    for (const r of [...segLists, ...macroLists]) if (r.status === 'fulfilled') raw.push(...(r.value || []));
    for (const r of extra) {
      if (r.status !== 'fulfilled') continue;
      for (const it of r.value || []) {
        if (it && it.title && EVENT_MARKET.test(it.title) && newsContextOk(it.title, { requireMarket: true })) raw.push(it);
      }
    }
    raw.push(...headlines);
    // M&A is an event, not just a tape row. Same gate as the brief: announced or changed today,
    // $1B+ unless independently verified, and at most two survive selection.
    const today = refDate;
    for (const d of (dealBook && dealBook.deals) || []) {
      if (!d.target && !d.acquirer) continue;
      const ev = (d.events || []).slice(-1)[0] || null;
      const announced = d.date && d.date >= today;
      const changed = ev && ev.status && ev.status !== 'announced' && (ev.date || '') >= today;
      if (!(announced || changed)) continue;
      if (d.value == null ? !d.verified : (d.value < 1000 && !d.verified)) continue;
      raw.push({
        title: (ev && ev.title) || (d.acquirer && d.target ? `${d.acquirer} to buy ${d.target}` : (d.target || d.acquirer)),
        source: (ev && ev.source) || d.source || null,
        url: (ev && ev.url) || d.url || null,
        date: (ev && ev.date) || d.date || null,
        category: 'mna', categoryLabel: 'M&A', weight: 6,
        mechanism: 'Consolidation changes the number of buyers and the asset\'s scarcity value; the sector re-rates around the new scale.',
        entities: [{ id: 'deal:' + (d.key || d.target || d.acquirer), label: d.target || d.acquirer || 'Deal', kind: 'company' }],
      });
    }
    const seen = new Set(), items = [];
    for (const it of raw) {
      if (!it || !it.title) continue;
      if (it.source && !TIER1_RE.test(it.source)) continue;
      const sig = String(it.source || '') + '|' + String(it.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seen.has(sig)) continue;
      seen.add(sig);
      items.push(it);
    }
    return { clusters: clusterEvents(items, { catalog: eventCatalog(), refDate }), built: new Date().toISOString(), pool: items.length, refDate };
  }, (v) => !(v.clusters && v.clusters.length));
}

// ---------------------------------------------------------------------------
// On-screen daily brief — a 60-second "what happened / what's on today" as JSON.
// The raw text digest above stays for email/log; this is what the HOME tab renders.
// ---------------------------------------------------------------------------
async function buildBrief() {
  // The base tape is cached for five minutes; the event layer is attached outside that cache so a
  // cold event pool cannot freeze the top of the page for five minutes.
  const base = await cachedSWR('brief', 300_000, async () => {
    // Everything that only needs the network — no other panel's output — is fetched AT ONCE. The
    // calendar and the deal book used to be awaited at the very end, so a cold brief paid for them
    // one after another and took 2-4s longer than the slowest single feed.
    const [m, h, inv, curves, alerts, pos, cal, dealBook] = await Promise.all([
      getMarket(),
      getHistory().catch(() => null),
      // One line each: a cold curve or stockpile feed must not hold the whole brief.
      within(getInventories(), 6000),
      within(getCurves(), 6000),
      computeServerAlerts().catch(() => []),
      // Only the price board and the history are allowed to set the brief's pace. Everything else
      // feeds one line of prose and can take 20s+ from a cold cache, so it waits with a budget and
      // lands in `cached()` for the next reader.
      within(getPositioning('wti'), 3000),
      within(getCalendar(), 5000),
      within(refreshDeals(), 4000),
    ]);
    // Biggest 1-day moves across every instrument's headline series.
    const movers = [];
    for (const b of m.benchmarks) {
      const dd = h?.deltas?.[b.id];
      const d = b.paper != null ? dd?.paper : dd?.physical;
      if (d?.d1 != null) movers.push({ id: b.id, label: b.label, group: b.group, dp: b.dp, kind: 'bench', d1: d.d1, m1: d.m1 ?? null, y1: d.y1 ?? null });
    }
    // A raw % ranking is really a dairy ranking: whey, butter and HRC print in wide, infrequent ticks
    // (41-50% of days unchanged), so a quote refresh reads as a 17% "move". Score each market by its move
    // in its OWN daily σ, damped by how often it simply doesn't trade.
    const ld = (vals) => vals.filter((v) => v != null);
    const statsOf = (vals) => {
      const a = ld(vals || []);
      if (a.length < 40) return null;
      let flat = 0, n = 0; const rets = [];
      for (let i = 1; i < a.length; i++) { n++; if (a[i] === a[i - 1]) flat++; if (a[i - 1]) rets.push(Math.log(a[i] / a[i - 1])); }
      if (rets.length < 30) return null;
      const mu = rets.reduce((x, y) => x + y, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((x, y) => x + (y - mu) ** 2, 0) / rets.length) * 100;
      return { sd, flat: (flat / n) * 100 };
    };
    const liq = (flat) => Math.max(0.15, Math.min(1, 1 - flat / 12));
    // Expiry day is not a market move. A continuous front-month series jumps to the next contract,
    // and with a backwardated curve that jump is a large red number nobody traded. Name it, and stop
    // it from winning the hero slot. Each market uses ITS OWN expiry rule (lib.frontExpiry), not one
    // shared "20th of the month" — that was only ever right for WTI.
    const todayIso = new Date().toISOString().slice(0, 10);
    const expCache = new Map();
    const expiryFor = (id) => {
      const spec = CURVE_SPEC[id];
      if (!spec) return null;
      if (!expCache.has(spec.root)) expCache.set(spec.root, frontExpiry(spec.root, todayIso));
      return expCache.get(spec.root);
    };
    for (const mv of movers) {
      const raw = h && h.series && h.series[mv.id];
      const b0 = m.benchmarks.find((x) => x.id === mv.id);
      const vals = raw && (b0 && b0.paper != null ? raw.paper : raw.physical);
      const st = statsOf(vals);
      if (st && st.sd > 0) { mv.sigma = +st.sd.toFixed(2); mv.flat = Math.round(st.flat); mv.score = +((Math.abs(mv.d1) / st.sd) * liq(st.flat)).toFixed(2); }
      else mv.score = +((Math.abs(mv.d1) / 2) * 0.8).toFixed(2);        // no history? conservative 2% day
      const ks = vals ? Object.keys(raw && (b0 && b0.paper != null ? raw.paper : raw.physical) || {}).sort() : [];
      if (ks.length) { const m2 = raw && (b0 && b0.paper != null ? raw.paper : raw.physical); mv.spark = ks.slice(-30).map((k) => (m2[k] == null ? null : +m2[k])); }
      const exp = expiryFor(mv.id);
      const daysToExp = exp ? Math.round((Date.parse(exp) - Date.parse(todayIso)) / 864e5) : null;
      if (daysToExp != null && daysToExp >= 0 && daysToExp <= 2 && Math.abs(mv.d1) >= 1.5) {
        try {
          const c = await getCurveFor(mv.id);
          const px = ld(vals || []).slice(-1)[0];
          if (c && c.available && c.m1m2 != null && px) {
            const rollPct = (c.m1m2 / px) * 100;
            // Only ONE case is worth flagging: a backwardated curve (front above next) rolling down into
            // a red number. Contango cannot manufacture a fall, so a +18% dairy print is not a roll.
            if (c.m1m2 > 0 && mv.d1 < 0 && Math.abs(rollPct) >= 0.5 * Math.abs(mv.d1)) {
              mv.roll = { spread: +c.m1m2.toFixed(2), pct: +rollPct.toFixed(1), when: daysToExp === 0 ? 'today' : daysToExp === 1 ? 'tomorrow' : 'in two days', expiry: exp };
            }
          }
        } catch {}
      }
    }
    movers.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || Math.abs(b.d1) - Math.abs(a.d1));

    const happened = [];
    for (const mv of movers.slice(0, 3)) happened.push({ kind: 'move', id: mv.id, text: `${mv.label} is ${mv.d1 >= 0 ? 'up' : 'down'} <b>${Math.abs(mv.d1).toFixed(1)}%</b> today${mv.y1 != null ? ` — ${Math.abs(mv.y1).toFixed(0)}% ${mv.y1 >= 0 ? 'higher' : 'lower'} over a year` : ''}.` });
    if (curves?.wti) happened.push({ kind: 'curve', id: 'wti', text: `WTI is in <b>${curves.wti.shape.toLowerCase()}</b> — this month ${curves.wti.m1m2 >= 0 ? 'above' : 'below'} next by <b>${sgn(curves.wti.m1m2)}</b>.` });
    const crude = inv?.items?.find((i) => i.key === 'crude');
    if (crude?.surprise != null) happened.push({ kind: 'stocks', id: 'wti', text: `US crude stocks ${crude.wow >= 0 ? 'built' : 'drew'} vs last week — <b>${Math.abs(crude.surprise).toLocaleString()}k bbl ${crude.surprise < 0 ? 'more drawn than usual (bullish)' : 'more built than usual (bearish)'}</b>.` });
    if (pos?.pct3y != null && (pos.pct3y >= 90 || pos.pct3y <= 10)) happened.push({ kind: 'positioning', id: 'wti', text: `Hedge funds are <b>${pos.pct3y >= 90 ? 'crowded long' : 'crowded short'}</b> crude (${pos.pct3y.toFixed(0)}th pctile, CFTC ${pos.latest.date}) — ${pos.pct3y >= 90 ? 'unwind risk' : 'squeeze fuel'}.` });

    // ---- MACRO: the country moves that matter, and the wire story behind the biggest ones ----
    // The brief used to be commodities-only, so a day like "MSCI may cut Indonesia → stocks fall the
    // most since 1998" never appeared. Country tape items carry the same multi-horizon deltas as the
    // commodity tape, and pegged currencies carry none at all (so they can never fake a move).
    const regionItems = (await Promise.all(Object.keys(MACRO_COUNTRIES)
      .map((r) => getRegionTickers(r).then((x) => x.items || []).catch(() => [])))).flat();
    const macro = [];
    for (const it of regionItems) {
      const d1 = it.deltas && it.deltas.d1;
      if (d1 == null) continue;                                   // a peg reports no moves, by design
      const co = ALL_COUNTRIES[it.id];
      if (!co) continue;
      const isIdx = it.kind === 'index';
      if (Math.abs(d1) < (isIdx ? 1.5 : 0.75)) continue;           // otherwise the brief cries wolf daily
      macro.push({ id: it.id, label: co.label, region: co.region, kind: it.kind, sym: it.label,
        d1, m1: it.deltas.m1 ?? null, y1: it.deltas.y1 ?? null, dp: isIdx ? 1 : 3 });
    }
    await Promise.all(macro.map(async (mv) => {
      try {
        const c0 = ALL_COUNTRIES[mv.id];
        const sym = mv.kind === 'fx' ? (c0 && c0.fx) : (c0 && c0.index);
        if (!sym) return;
        const ser = (await cached('csr:1y:' + sym, 3600e3, () => yahooSeries(sym, '1y', '1d'))).series;
        const ks = Object.keys(ser).sort();
        const st = statsOf(ks.map((k) => ser[k]));
        if (st && st.sd > 0) {
          mv.sigma = +st.sd.toFixed(2); mv.flat = Math.round(st.flat);
          // Materiality floor: an index or currency moving 2% is a macro event on its own, even when that
          // market is chronically volatile (KOSPI's daily sigma is ~3.5%), so score it against the calmer
          // of "its own sigma" and a flat 2% yardstick.
          mv.score = +Math.max((Math.abs(mv.d1) / st.sd) * liq(st.flat), Math.abs(mv.d1) / 2).toFixed(2);
        }
        else mv.score = +((Math.abs(mv.d1) / 2)).toFixed(2);
        mv.spark = ks.slice(-30).map((k) => (ser[k] == null ? null : +ser[k]));
      } catch {}
    }));
    macro.sort((a, b) => Math.abs(b.score ?? 0) - Math.abs(a.score ?? 0) || Math.abs(b.d1) - Math.abs(a.d1));
    const macroTop = macro.slice(0, 4);
    // A one-line reason per move, from a tier-1 wire. A commodity story must actually name the
    // instrument (getNews already enforces that); a country story must name the country and, for an
    // index move, preferably talk about stocks. Direction is a preference, never a requirement —
    // and no matching story means no line, because the brief does not invent an explanation.
    const MARKET_WORD = /\b(stocks?|shares?|equit(y|ies)|index|indices|bourse)\b/i;
    const COMPANY_STORY = /\b(IPO|market debut|debuts?|plunges? \d|surges? \d|jumps? \d|one stock|single stock)\b/i;
    // A headline only explains a move if it is about the market: a price word, a supply event, or a
    // demand story. "Qatari electricity lifeline for Lebanon" names LNG but explains nothing.
    const STORY_WORD = /\b(prices?|rise|rises|rose|rising|fell|fall|falls|falling|surge[sd]?|soar(s|ed)?|plunge[sd]?|slid|slide[s]?|slip(s|ped)?|jump(s|ed)?|climb(s|ed)?|gain(s|ed)?|drop(s|ped)?|decline[sd]?|tumble[sd]?|retreat(s|ed)?|rebound(s|ed)?|sell-?off|rally|rallies|higher|lower|steady|unchanged|outlook|demand|supply|output|production|inventor(y|ies)|shortage|glut|surplus|OPEC|sanction[sd]?|tariff[s]?|strike|outage|harvest|drought|export[s]?|import[s]?|curb[s]?|quota|shipments?)\b/i;
    const pickStory = (items, x, co) => {
      const want = x.d1 >= 0 ? 'up' : 'down';
      const idxLabel = co && co.indexLabel ? co.indexLabel : null;
      const now = Date.now();
      return (items || [])
        .map((it) => ({ ...it, ageDays: it.ageDays ?? (it.date ? Math.round((now - Date.parse(it.date)) / 864e5) : 99) }))
        .filter((it) => it.ageDays <= 3 && (!it.source || TIER1_RE.test(it.source)))
        .filter((it) => STORY_WORD.test(it.title))
        // A commodity story must also SAY which way prices went (or name a supply event). "Qatari
        // electricity lifeline for Lebanon ... LNG supply" is not an explanation for gas falling.
        .filter((it) => x.kind !== 'bench' || newsDir(it.title) != null || EVENT_RULES.some((r) => r.re.test(it.title)))
        .filter((it) => x.kind === 'bench' || titleMatches(x.id, it.title))   // a country story must name the country
        .filter((it) => x.kind !== 'index' || MARKET_WORD.test(it.title))     // an index move needs a STOCKS story
        .map((it) => ({ it, s: (newsDir(it.title) === want ? 20 : newsDir(it.title) == null ? 10 : -99)
          + (idxLabel && it.title.includes(idxLabel) ? 8 : 0)
          + (MARKET_WORD.test(it.title) ? 4 : 0)
          // A single company's IPO or one stock's 30% debut is not an explanation for a whole index day.
          - (COMPANY_STORY.test(it.title) ? 9 : 0)
          + Math.max(0, 6 - it.ageDays * 2) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)[0]?.it || null;
    };
    const whyFor = async (x) => {
      try {
        const day = new Date().toISOString().slice(0, 10);
        const sh = (off) => new Date(Date.parse(day) + off * 864e5).toISOString().slice(0, 10);
        let items = [];
        if (x.kind === 'bench') {
          const seg = (MARKETS.find((mk) => mk.components.includes(x.id)) || {}).id;
          if (!seg) return null;
          items = (await getNews(seg, x.id)).items || [];   // getNews already requires the instrument to be named
        } else if (x.kind === 'index') {
          // Ask about the STOCK MARKET, not the economy: "Indonesia economy OR rupiah" finds the rupiah
          // story on a day the index rallied 5.7%, while "Indonesia stocks" finds the actual reason.
          // Merge with the country feed so a wire story phrased "Korean stocks..." is not missed.
          const co = ALL_COUNTRIES[x.id] || {};
          const name = co.label || x.label;
          const q = `(${name} stocks OR ${name} shares${co.indexLabel ? ` OR "${co.indexLabel}"` : ''}) after:${sh(-2)} before:${sh(2)} ${NEWS_TIER1}`;
          const [mkt, gen] = await Promise.all([
            cached('whyidx:' + x.id + ':' + day, 1800e3, () => fetchGoogleNews(q, 20)).catch(() => []),
            getMacroNews(x.id).then((r) => r.items || []).catch(() => []),
          ]);
          items = [...mkt, ...gen];
        } else {
          items = (await getMacroNews(x.id)).items || [];
        }
        // A currency story has to be about money: rates, inflation, the central bank, flows, the budget.
        const FX_STORY = /\b(currenc|fx|forex|exchange rate|central bank|rate (cut|hike|hold)|interest rates?|inflation|devalu|depreciat|appreciat|intervention|reserves|budget|election|yields?|bond)\b/i;
        const p = pickStory(items.filter((it) => x.kind !== 'fx' || FX_STORY.test(it.title)), x, ALL_COUNTRIES[x.id]);
        return p ? { title: p.title, source: p.source, url: p.url } : null;
      } catch { return null; }
    };
    for (const mv of macroTop) {
      const what = mv.kind === 'index' ? 'the stock index' : 'the currency';
      mv.text = `${mv.label} — ${what} is <b>${mv.d1 >= 0 ? 'up' : 'down'} ${Math.abs(mv.d1).toFixed(1)}%</b> today`
        + (mv.y1 != null ? ` — ${Math.abs(mv.y1).toFixed(0)}% ${mv.y1 >= 0 ? 'higher' : 'lower'} over a year` : '') + '.';
      mv.route = `#/macro/${mv.region}/${mv.id}`;
    }
    // Three commodities and three countries, so a 3% index day can never be crowded out by oil alone.
    // ---- THE RANKING ---------------------------------------------------------------------------
    // One leaderboard for every market. Commodities and countries compete on the SAME score, so the
    // top of the brief moves with the day instead of with an asset-class quota:
    //   score = |1-day move| / that market's OWN daily σ, damped by how often it actually trades.
    // Diversity is applied afterwards, not instead: at most two contracts from one complex and one
    // entry per country, so a single oil session cannot fill the page. A contract roll never leads.
    const board = [
      ...movers.map((x) => ({ ...x, kind: 'bench', tag: x.group || 'Commodity', srcKind: 'bench' })),
      ...macro.map((x) => ({ ...x, kind: x.kind, tag: x.kind === 'fx' ? 'FX' : 'Index', srcKind: x.kind })),
    ].filter((x) => x.score != null || x.d1 != null)
      .map((x) => ({ ...x, tier: priorityOf(x) }));
    // The band decides who is allowed on the page; the score only orders within it. Thin markets have
    // a tiny σ, so a quote refresh in milk or cheddar can score 10-20× a normal day. Tier 3 is held
    // back for confirmed events (the event engine), never admitted on a price move alone.
    const mix = rankByPriority(board, { max: 6, slots: { 1: 4, 2: 2, 3: 0 } });
    // Computed drivers, so EVERY move has an explanation even on a day with no wire story. This is
    // data, not narrative: what moved with it, what it is priced off, and how well it actually trades.
    const REGION_LABEL = { us: 'Americas', eu: 'European', jp: 'Japanese', apac: 'Asian', me: 'Gulf', af: 'African' };
    const pf = (v) => `${v >= 0 ? '+' : '\u2212'}${Math.abs(v).toFixed(1)}%`;
    const factsFor = (x) => {
      const f = [];
      const dir = x.d1 >= 0 ? 'up' : 'down';
      if (x.kind === 'bench') {
        if (x.group === 'Refined') {
          const crude = movers.find((mk) => mk.id === 'wti');
          if (crude && Math.sign(crude.d1) === Math.sign(x.d1) && Math.abs(crude.d1) >= 1) f.push(`crude set the direction (WTI ${pf(crude.d1)})`);
        }
        const peers = movers.filter((mk) => mk.id !== x.id && mk.group === x.group);
        const same = peers.filter((mk) => Math.sign(mk.d1) === Math.sign(x.d1));
        const top = same.slice().sort((a, b) => Math.abs(b.d1) - Math.abs(a.d1))[0];
        if (peers.length === 1) f.push(`${top ? top.label + ' moved ' + dir + ' with it (' + pf(top.d1) + ')' : 'no other ' + String(x.group || 'group').toLowerCase() + ' contract moved ' + dir}`);
        else if (peers.length > 1) f.push(`${same.length} of ${peers.length} other ${String(x.group || 'group').toLowerCase()} contracts moved ${dir} too${top ? ` (${top.label} ${pf(top.d1)})` : ''}`);
        if (x.flat >= 8) f.push(`stepped quotes — ${x.flat}% of days print unchanged`);
      } else {
        const co = ALL_COUNTRIES[x.id] || {};
        const pk = x.kind === 'fx' ? 'fx' : 'index';
        const peers = regionItems.filter((it) => it.kind === pk && it.id !== x.id && it.deltas && it.deltas.d1 != null
          && (ALL_COUNTRIES[it.id] || {}).region === co.region);
        const same = peers.filter((it) => Math.sign(it.deltas.d1) === Math.sign(x.d1));
        if (peers.length >= 2) f.push(`${same.length} of ${peers.length} other ${REGION_LABEL[co.region] || 'regional'} ${pk === 'fx' ? 'currencies' : 'indices'} moved ${dir} too`);
        if (x.kind === 'fx') {
          const idx = regionItems.find((it) => it.id === x.id && it.kind === 'index' && it.deltas && it.deltas.d1 != null);
          if (idx) f.push(`the index is ${pf(idx.deltas.d1)}`);
        } else {
          const fx = regionItems.find((it) => it.id === x.id && it.kind === 'fx' && it.deltas && it.deltas.d1 != null);
          if (fx) f.push(`${fx.label} ${pf(fx.deltas.d1)}`);
        }
      }
      // Never leave a move unexplained: if nothing above applied, state its size against its own norm.
      if (!f.length) {
        if (x.sigma) f.push(`${(Math.abs(x.d1) / x.sigma).toFixed(1)}\u00d7 a normal day (${x.sigma.toFixed(1)}%)`);
        else f.push(`${pf(x.d1)} — one of the day's largest moves`);
      }
      return f.slice(0, 2);
    };
    for (const x of mix) x.facts = factsFor(x);
    await Promise.all(mix.map(async (x) => { x.why = await whyFor(x); }));
    // The same headline under three oil rows is noise: keep it where it ranks first, drop the repeats.
    const usedWhy = new Set();
    for (const x of mix) { if (!x.why) continue; if (usedWhy.has(x.why.url)) x.why = null; else usedWhy.add(x.why.url); }

    const seenNext = new Set();
    const next = ((cal && cal.events) || getEvents())
      .filter((e) => { const k = String(e.name).toLowerCase(); if (seenNext.has(k)) return false; seenNext.add(k); return true; })
      .slice(0, 4)
      .map((e) => ({ name: e.country ? `${e.country} — ${e.name}` : e.name, date: e.date, time: e.time || null, note: e.note }));
    const hi = alerts.find((a) => a.level === 'high');
    // The headline follows the same band as the page: a thin-market quote refresh is not the day.
    const mv = movers.find((x) => priorityOf(x) < 3) || movers[0];
    const bigMacro = macroTop[0] && Math.abs(macroTop[0].d1) >= 4 ? macroTop[0] : null;
    const headline = (mv ? `Biggest move: ${mv.label} ${mv.d1 >= 0 ? 'up' : 'down'} ${Math.abs(mv.d1).toFixed(1)}%` : 'Quiet session so far')
      + (bigMacro ? ` · ${bigMacro.label}'s index ${bigMacro.d1 >= 0 ? 'up' : 'down'} ${Math.abs(bigMacro.d1).toFixed(1)}%` : '')
      + (hi ? ` · ${hi.text.replace(/\.$/, '')}` : '') + '.';
    // The hero: the highest-scoring move across commodities and macro, with a sparkline attached.
    // A roll day can still be the loudest number on screen, but it must never be the day's STORY.
    // The roll guard is applied to the hero only: a roll day can be the loudest number on screen
    // without being the day's story.
    const leadable = mix.filter((x) => !x.roll);
    const forcedId = process.env.BRIEF_HERO_TEST;
    let forcedRaw = forcedId ? [...mix, ...board].find((x) => x.id === forcedId) : null;
    if (forcedId && !forcedRaw) {   // test hook: force ANY country, even one below today's threshold
      const it = regionItems.find((r) => r.id === forcedId && r.deltas && r.deltas.d1 != null);
      const co = ALL_COUNTRIES[forcedId];
      if (it && co) forcedRaw = { id: it.id, label: co.label, region: co.region, kind: it.kind, sym: it.label,
        d1: it.deltas.d1, m1: it.deltas.m1 ?? null, y1: it.deltas.y1 ?? null, route: `#/macro/${co.region}/${co.id}` };
    }
    const forced = forcedRaw ? { ...forcedRaw, srcKind: forcedRaw.srcKind || (forcedRaw.kind === 'bench' ? 'bench' : forcedRaw.kind) } : null;
    if (forced && (!forced.facts || !forced.why)) { forced.facts = forced.facts || factsFor(forced); forced.why = forced.why || await whyFor(forced); }
    const heroRaw = forced || leadable[0] || mix[0] || null;
    let hero = null;
    if (heroRaw) {
      hero = { kind: heroRaw.kind, id: heroRaw.id, label: heroRaw.label, tag: heroRaw.tag || (heroRaw.kind === 'bench' ? (heroRaw.group || 'COMMODITY') : (heroRaw.kind === 'fx' ? 'FX' : 'INDEX')),
        sym: heroRaw.sym || null,
        assetClass: heroRaw.kind === 'bench' ? 'Commodity' : (heroRaw.kind === 'fx' ? 'FX' : 'Equity'),
        instrument: heroRaw.kind === 'bench' ? heroRaw.label : (heroRaw.kind === 'fx' ? (heroRaw.sym || `${heroRaw.label} FX`) : `${heroRaw.label} equities`),
        d1: heroRaw.d1, y1: heroRaw.y1 ?? null, m1: heroRaw.m1 ?? null,
        score: heroRaw.score ?? null, sigma: heroRaw.sigma ?? null, flat: heroRaw.flat ?? null,
        route: heroRaw.route || null, why: heroRaw.why || null, facts: heroRaw.facts || [], srcKind: heroRaw.srcKind || 'bench' };
      hero.spark = heroRaw.spark || null;
    }
    // M&A on the brief: only deals that matter (verified, or $1B+) and only if they are recent. A quiet
    // week produces no block at all rather than an empty heading.
    let briefDeals = [];
    try {
      const book = dealBook || { deals: [] };
      // "News", not "big": a deal only belongs on the brief on the day something happened to it —
      // announced, closed, terminated. A large deal from three weeks ago is not today's news.
      // Freshness is about the DEAL, not about the last time a wire mentioned it. A deal is news only
      // if it was announced in the last two days, or something happened to it (closed, terminated,
      // withdrawn) in the last two days. A retrospective article about a 2023 merger is not news.
      // Today only. A deal from two days ago is not today's news, and an empty day should produce no
      // M&A block at all rather than a stale note that never changes.
      const freshFrom = new Date().toISOString().slice(0, 10);
      const lastEvent = (d) => (d.events || [])[(d.events || []).length - 1] || null;
      briefDeals = (book.deals || [])
        .filter((d) => {
          if (!d.target && !d.acquirer) return false;
          const announcedFresh = d.date && d.date >= freshFrom;
          const ev = lastEvent(d);
          const changedFresh = ev && ev.status && ev.status !== 'announced' && (ev.date || '') >= freshFrom;
          if (!(announcedFresh || changedFresh)) return false;
          // "Big" means a billion, unless the deal is independently verified — and never more than two.
          if (d.value == null) return !!d.verified;
          return d.value >= 1000 || !!d.verified;
        })
        .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || (b.value || 0) - (a.value || 0))
        .slice(0, 2)
        .map((d) => ({ key: d.key, acquirer: d.acquirer, target: d.target, value: d.value || null, status: d.status, verified: !!d.verified, date: d.date, sector: d.sector || null }));
    } catch {}

    // WHAT HAPPENED is the rest of the same leaderboard — no second ranking, no re-sorting downstream.
    const moveRows = mix.filter((x) => x !== heroRaw).slice(0, 5).map((x) => ({
      kind: x.kind === 'bench' ? 'bench' : (x.kind === 'fx' ? 'fx' : 'index'),
      id: x.id, label: x.label, tag: x.tag || (x.kind === 'fx' ? 'FX' : 'Index'),
      sym: x.sym || null,
      assetClass: x.kind === 'bench' ? 'Commodity' : (x.kind === 'fx' ? 'FX' : 'Equity'),
      instrument: x.kind === 'bench' ? x.label : (x.kind === 'fx' ? (x.sym || `${x.label} FX`) : `${x.label} equities`),
      d1: x.d1, m1: x.m1 ?? null, y1: x.y1 ?? null, score: x.score ?? null,
      sigma: x.sigma ?? null, flat: x.flat ?? null, roll: x.roll || null,
      spark: x.spark || null, why: x.why || null, facts: x.facts || [], route: x.route || null,
    }));
    // A big deal is a thing that HAPPENED that day, not a separate section: it joins the same list,
    // tagged M&A, with its price where the value column would be.
    const dealRows = briefDeals.map((d) => ({
      // Never emit "— → Target": a missing buyer should read as just the target, not a broken arrow.
      kind: 'deal', id: d.key || d.target || d.acquirer, tag: 'M&A',
      label: d.acquirer && d.target ? `${d.acquirer} → ${d.target}` : (d.target || d.acquirer || '—'),
      d1: null, value: d.value, status: d.status, verified: d.verified, date: d.date, closed: d.closed || null,
      acquirer: d.acquirer || null, target: d.target || null,
      sector: d.sector || null, spark: null, why: null, facts: [], route: null,
    }));
    const rows = [...moveRows, ...dealRows].slice(0, 7);

    // The event layer needs the full tape as evidence — every benchmark and every country, not just
    // the rows that made the page. It is cached with the base brief, then attached outside that cache.
    const marketCtx = {};
    for (const mv of movers) (marketCtx[mv.id] ||= []).push({ id: mv.id, label: mv.label, kind: 'bench', d1: mv.d1, route: null });
    for (const it of regionItems) {
      const d1 = it.deltas && it.deltas.d1;
      if (d1 == null) continue;
      const co = ALL_COUNTRIES[it.id] || {};
      const label = it.kind === 'fx' ? (co.fxLabel || it.label) : (co.indexLabel || it.label);
      (marketCtx[it.id] ||= []).push({ id: it.id, label, kind: it.kind, d1, route: `#/macro/${co.region}/${it.id}` });
    }

    const sessionDate = sessionDateOf(m) || new Date().toISOString().slice(0, 10);
    return {
      updated: new Date().toISOString(), headline, happened, next, macro: macroTop, hero, rows,
      alerts: alerts.map((a) => ({ level: a.level, text: a.text })),
      movers: movers.slice(0, 3),
      sessionDate,
      _marketCtx: marketCtx,
    };
  });
  const { _marketCtx, ...out } = base;
  const attached = await attachEvents(_marketCtx);
  out.events = attached.events;
  // Every row gets a reason: its own wire story, a regional peer, a global theme, or a peer row that
  // already carries one. Shared drivers are labelled, never presented as country-specific causes.
  out.rows = explainRows(out.rows, attached.clusters, { exposures: ROW_EXPOSURE, groups: ROW_GROUP, directionOf: newsDir, seed: out.hero ? [out.hero] : [] });
  return out;
}

// The event layer is attached outside the base brief's five-minute cache: an empty event pool on a
// cold start must not freeze the top of the page for five minutes. It has its own 30-minute cache.
async function attachEvents(marketCtx) {
  // Build in the background — but a cold pool now gets a short, bounded moment to land. The top of
  // the brief used to be missing on every first load after a wake, because the answer was "empty"
  // while the pool built; two and a half seconds is the most a cold start may cost.
  if (!cache.has('eventpool')) {
    if (Date.now() - evPoolAttempt > 15e3) {
      evPoolAttempt = Date.now();
      await within(buildEventPool(), 2500).catch(() => null);
    }
    if (!cache.has('eventpool')) return snapshotEvents();
  }
  const pool = await within(buildEventPool(), 1500).catch(() => null);
  if (!pool || !pool.clusters || !pool.clusters.length) return snapshotEvents();
  try {
    const today = pool.refDate || new Date().toISOString().slice(0, 10);
    const history = state.eventHistory && typeof state.eventHistory === 'object' ? state.eventHistory : {};
    const seen = new Set();
    for (const [d, keys] of Object.entries(history)) {
      const age = (Date.parse(today) - Date.parse(d)) / 864e5;
      if (d < today && age <= 7 && Array.isArray(keys)) for (const k of keys) seen.add(k);
    }
    const events = selectEvents(scoreEvents(pool.clusters, { marketCtx, seen }), { max: 5, perCategory: 2 })
      .map((e) => ({
        key: e.key, category: e.category, label: e.label,
        what: e.what, why: e.why, whySource: e.whySource, mechanism: e.mechanism,
        primary: e.primary, entities: e.entities, market: e.market, sources: e.sources, source: e.source, url: e.url,
        at: e.at, date: e.date, ageDays: e.ageDays, score: e.score, novelty: e.novelty, confirmed: e.confirmed,
      }));
    // Keep the five the reader just saw, so the next rebuild window serves them instead of nothing.
    if (events.length) {
      eventSnapshot = { at: Date.now(), events, clusters: pool.clusters };
      const prev = state.briefEvents;
      if (!prev || prev.day !== today || JSON.stringify(prev.events) !== JSON.stringify(events)) {
        state.briefEvents = { day: today, at: new Date(eventSnapshot.at).toISOString(), events };
        saveState();
      }
    }
    // Remember every cluster, not just the five shown, so a story that bubbles under the surface is
    // already "developing" when it makes the page. Bounded: 80 keys a day, 30 days.
    const keys = [...new Set(pool.clusters.map((c) => c.key))].slice(0, 80).sort();
    if (JSON.stringify(history[today] || []) !== JSON.stringify(keys)) {
      history[today] = keys;
      state.eventHistory = Object.fromEntries(Object.keys(history).sort().slice(-30).map((d) => [d, history[d]]));
      saveState();
    }
    return { events, clusters: pool.clusters };
  } catch (e) { console.warn('[events]', e.message); return { events: [], clusters: [] }; }
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
  // ONE message per subscriber carrying everything that just happened. Five alerts used to mean five
  // pushes — and five publishes into the chat service, which is exactly what gets us rate-limited (it's
  // how the free ntfy tier throttled us during testing).
  const subject = alerts.length === 1
    ? `Marlon's Watchtower · ${alerts[0].level.toUpperCase()}`
    : `Marlon's Watchtower · ${alerts.length} alerts`;
  const text = alerts.map((a) => `• ${a.text}`).join('\n');
  let changed = false;
  for (const s2 of list) {
    if (s2.sentDate !== today) { s2.sentDate = today; s2.sent = 0; changed = true; }
    if ((s2.sent || 0) >= SUB_DAILY_MAX) continue;
    try { await sendToSubscriber(s2, subject, text); s2.sent = (s2.sent || 0) + alerts.length; changed = true; }
    catch (e) { console.warn('[sub]', maskTarget(s2.target), e.message); }
    await sleep(250);                        // spread the sends rather than bursting one host
  }
  if (changed) saveSubs(list);
}

// How old the company datasets are, in the email. A silent workflow failure is the one failure mode
// nobody notices until the numbers are wrong.
function dataFreshnessLine() {
  const age = (file) => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));
      const t = Date.parse(d.updated || '');
      if (!Number.isFinite(t)) return null;
      return { at: d.updated.slice(0, 16).replace('T', ' '), h: (Date.now() - t) / 3600e3 };
    } catch { return null; }
  };
  const us = age('companies.json');
  const jp = age('japan.json');
  const fmt = (label, x) => (x ? `${label} ${x.at}Z (${x.h.toFixed(0)}h old)` : `${label} missing`);
  const stale = [us, jp].filter((x) => x && x.h > 36);
  const head = stale.length ? 'DATA ⚠ STALE — the nightly refresh has not landed' : 'DATA current';
  return `${head}\n  ${fmt('US', us)} · ${fmt('Japan', jp)}`;
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

// The calendar endpoint adds the company earnings book to the macro calendar. It used to re-read
// japan.json (5.5 MB) and re-merge the whole board on every request, which cost ~2s per call. The
// merged board is now built once per half hour, through the mtime-cached readJapan().
const getCalendarFull = () => cachedSWR('calendar-full', 30 * 60e3, async () => {
  const cal = { ...(await getCalendar()) };
  const companies = [];
  try { companies.push(...(JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'events.json'), 'utf8')).events || [])); } catch {}
  try {
    const today = new Date().toISOString().slice(0, 10);
    for (const c of (readJapan().companies || [])) {
      if (!c.earnings || !c.earnings.date || c.earnings.date < today) continue;
      companies.push({
        date: c.earnings.date, kind: 'earnings', market: 'JP', ticker: c.ticker, code: c.code,
        name: c.name, label: `${c.ticker} · ${c.name} · results`,
        detail: `TSE Prime · ${c.sector}`, basis: 'scheduled', weight: 0,
        days: Math.round((Date.parse(c.earnings.date) - Date.now()) / 864e5),
      });
    }
  } catch { /* no japan data yet */ }
  cal.companies = companies;
  return cal;
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };
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
// The ?v= on an asset is a promise that its bytes never change (those URLs are served immutable for a
// year), so a deploy that changes app.js without bumping the number leaves every returning reader on
// the old file. The stamp comes from the file's own mtime now, not from a hand-edited number.
const VERSIONED_FILES = ['app.js', 'style.css', 'vendor/chart.umd.min.js'];
// The deploy image carries a minified client next to the source. Serve it at the SAME URL: index,
// the service worker's precache list and every cached ?v= URL keep working, and local development
// (no build) still gets the readable source.
const MIN_CLIENT = { 'app.js': 'app.min.js', 'style.css': 'style.min.css' };
const clientFile = (f) => (MIN_CLIENT[f] && fs.existsSync(path.join(PUBLIC, MIN_CLIENT[f])) ? MIN_CLIENT[f] : f);
const assetStamp = (f) => { try { return Math.floor(fs.statSync(path.join(PUBLIC, clientFile(f))).mtimeMs).toString(36); } catch { return null; } };
const stampIndex = (html) => {
  const stamps = Object.fromEntries(VERSIONED_FILES.map((f) => [f, assetStamp(f)]));
  return html.replace(/((?:app\.js|style\.css|vendor\/chart\.umd\.min\.js))\?v=[^"'&\s>]*/g,
    (m, f) => (stamps[f] ? `${f}?v=${stamps[f]}` : m));
};

// Same as sendJSON, but revalidates: a returning visitor gets 304 and transfers nothing.
// Content-addressed cache for the compressed JSON bodies: the calendar is ~165 KB and compressing it
// again on every request cost ~1s. The key is the etag, so an unchanged payload is encoded once.
const encBodies = new Map();
const sendJSONCached = (res, code, obj, cacheControl = 'public, max-age=30, stale-while-revalidate=60') => {
  const body = Buffer.from(JSON.stringify(obj));
  const etag = `W/"${crypto.createHash('sha1').update(body).digest('base64').slice(0, 22)}"`;
  // 30 seconds is shorter than any refresh interval the page uses, and it removes a revalidation
  // round-trip from every tab switch. Nothing here is per-user.
  const hdr = { etag, 'cache-control': cacheControl };
  if (res.req && res.req.headers['if-none-match'] === etag) { res.writeHead(304, hdr); return res.end(); }
  const enc = body.length > 1024 ? pickEncoding(res.req && res.req.headers['accept-encoding']) : null;
  if (enc) {
    const hit = encBodies.get(etag);
    let buf = hit && hit[enc];
    if (!buf) {
      buf = encodeBuf(body, enc);
      if (encBodies.size > 240) {
        // Evict the oldest quarter, not the whole map: browsing charts used to flush the pre-encoded
        // 700 KB market lists, which then had to be compressed again on the next visit.
        for (const k of [...encBodies.keys()].slice(0, 60)) encBodies.delete(k);
      }
      encBodies.set(etag, { ...(hit || {}), [enc]: buf });
    }
    res.writeHead(code, { ...hdr, 'content-type': 'application/json', 'content-encoding': enc, vary: 'Accept-Encoding' });
    return res.end(buf);
  }
  res.writeHead(code, { ...hdr, 'content-type': 'application/json' });
  res.end(body);
};

const sendJSON = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  const enc = body.length > 1024 ? pickEncoding(res.req && res.req.headers['accept-encoding']) : null;
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (enc) { headers['content-encoding'] = enc; headers.vary = 'Accept-Encoding'; res.writeHead(code, headers); return res.end(encodeBuf(body, enc)); }
  res.writeHead(code, headers);
  res.end(body);
};

// Charts are committed series that change only on a build, so a browser may keep them for ten minutes
// instead of revalidating on every return to a company. The ETag still changes on the next deploy.
const CHART_CACHE = 'public, max-age=600, stale-while-revalidate=600';
const sendChartJSON = (res, code, obj) => sendJSONCached(res, code, obj, CHART_CACHE);
// Market lists are rebuilt once a day. Five minutes stops a tab switch or a back-navigation from
// revalidating a 700 KB payload; the ETag still changes on the next deploy.
const LIST_CACHE = 'public, max-age=300, stale-while-revalidate=300';
const sendListJSON = (res, code, obj) => sendJSONCached(res, code, obj, LIST_CACHE);

// Security headers on every response. The CSP is enforced (not report-only): the shell has one
// inline <script> and it is pinned by hash, so an injected script has nothing to run under. The
// hashes are recomputed from the file at boot, so editing the shell cannot silently break the page.
const INLINE_SCRIPT_HASHES = (() => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  } catch { return []; }
})();
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${INLINE_SCRIPT_HASHES.join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline'",          // inline style attributes (bar widths, avatar tints)
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'X-Download-Options': 'noopen',
  'Content-Security-Policy': CSP,
};
const sendHtml = (res, code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(html); };

// ---------------------------------------------------------------------------
// Per-IP rate limit on the JSON API. Static files are cached and cheap; the API is what a scraper,
// a runaway tab or a hostile loop hammers, and a single call can set off a cold upstream fetch.
// Normal use is ~25 calls to open the board and then about one a minute, so 120/min with a 90-call
// burst is generous for a reader and far too slow to lift the dataset.
const RATE_BURST = Number(process.env.RATE_LIMIT_BURST || 90);
const RATE_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 120);
const RATE_REFILL = Math.max(0.1, RATE_PER_MIN / 60);      // tokens per second
const rateBuckets = new Map();                             // ip -> { tokens, at }
let rateChecks = 0;
// Render terminates TLS and forwards the caller's address. Take the right-most entry: a client can
// prepend a fake address to X-Forwarded-For, but the proxy appends the real one last. Loopback is
// exempt so local development and the test suite never rate-limit themselves.
const clientIp = (req) => {
  // When Cloudflare is in front, a Transform Rule can add this shared header. Only then is
  // CF-Connecting-IP trusted; without the secret a direct Render request could spoof it.
  const proxySecret = process.env.TRUSTED_PROXY_SECRET;
  if (proxySecret && req.headers['x-watchtower-proxy'] === proxySecret) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
  }
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return fwd.length ? fwd[fwd.length - 1] : String(req.socket.remoteAddress || 'unknown');
};
const isLoopback = (ip) => ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1';
const takeToken = (ip) => {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b) { b = { tokens: RATE_BURST, at: now }; rateBuckets.set(ip, b); }
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_REFILL);
  b.at = now;
  if (++rateChecks % 2000 === 0 && rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now - v.at > 10 * 60e3) rateBuckets.delete(k);
  }
  if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / RATE_REFILL));
  b.tokens -= 1;
  return 0;                                                 // 0 = allowed, otherwise seconds to wait
};

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
// Constant-time comparison for the optional login. A plain === leaks length and prefix timing.
const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};
const sameOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return true;                       // curl / server-to-server has no Origin
  try {
    const originHost = new URL(origin).host;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return Boolean(host) && (originHost === host || originHost === new URL(baseUrl(req)).host);
  } catch { return false; }
};
const jsonPost = (req) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return ct.startsWith('application/json') || (ct.startsWith('application/') && ct.includes('+json'));
};
// A cross-site HTML form can POST urlencoded/plain text, but not application/json without a CORS
// preflight. Requiring both a JSON content type and a same-host Origin closes the CSRF gap.
const safePost = (req) => jsonPost(req) && sameOrigin(req);
const server = http.createServer(async (req, res) => {
  for (const k in SECURITY_HEADERS) res.setHeader(k, SECURITY_HEADERS[k]);
  // HSTS only where TLS actually terminated: sending it from plain http would be a lie, and it is
  // what keeps a browser from ever downgrading a later visit to this host.
  if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Health check (no auth) for uptime monitors.
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      uptime: Math.round(process.uptime()),
      version: BUILD,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      warm: process.env.WARM || 'on',
      idx: [!!SEARCH_INDEX, !!PEER_INDEX],
      freshness: REFRESH_LEDGER ? {
        updated: REFRESH_LEDGER.updated,
        totals: REFRESH_LEDGER.totals,
        markets: Object.fromEntries(Object.entries(REFRESH_LEDGER.markets || {}).map(([k, v]) => [k, {
          companies: v.companies, fresh: v.fresh, repair: v.repair, stale: v.stale, inactive: v.inactive, unknown: v.unknown,
        }])),
      } : null,
    }));
  }
  // The API is the expensive surface, and the one a scraper or a runaway tab hammers. Local traffic
  // is exempt: the test suite makes far more calls than a person ever will.
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const ip = clientIp(req);
    const wait = isLoopback(ip) ? 0 : takeToken(ip);
    if (wait) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(wait), 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'Too many requests — slow down.', retryAfter: wait }));
    }
  }
  // Optional basic auth — set AUTH_USER + AUTH_PASS to protect a public deployment.
  // The subscription surface stays PUBLIC by design: visitors have no login, and the confirm /
  // unsubscribe links are clicked from a mail client. Those routes protect themselves with a
  // per-destination double opt-in, a host allowlist and per-IP rate limits instead.
  const PUBLIC_PATHS = new Set([
    '/api/subscribe', '/api/confirm', '/api/unsubscribe',
    '/robots.txt', '/ai.txt', '/security.html', '/terms.html', '/.well-known/security.txt', '/favicon-32.png',
  ]);
  if (process.env.AUTH_USER && process.env.AUTH_PASS && !PUBLIC_PATHS.has(url.pathname)) {
    const hdr = req.headers.authorization || '';
    const ok = hdr.startsWith('Basic ') && safeEqual(Buffer.from(hdr.slice(6), 'base64').toString('utf8'), `${process.env.AUTH_USER}:${process.env.AUTH_PASS}`);
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
    if ((notifyTest || rulesPost || subPost) && !safePost(req)) {
      return sendJSON(res, 403, { error: 'POST must be same-origin JSON' });
    }
    if (url.pathname === '/api/quotes') {
      // A screen asks for what it is showing: at most 60 refs, server-side chunked into Yahoo's
      // 20-symbol batches. Nothing is cached by the browser or an intermediary.
      const refs = [...new Set(String(url.searchParams.get('refs') || '')
        .split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 60);
      const quotes = await getLiveQuotes(refs);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ t: Date.now(), quotes }));
    }
    if (url.pathname === '/api/market') return sendJSONCached(res, 200, await getMarket().catch((e) => { console.error('[market]', e.message); return { updated: new Date().toISOString(), benchmarks: [], spreads: {}, quality: { flags: [], curveAvailable: false }, notes: [] }; }));
    if (url.pathname === '/api/history') return sendJSONCached(res, 200, await getHistory().catch((e) => { console.error('[history]', e.message); return { dates: [], series: {}, basis: {}, spreads: {}, deltas: {} }; }));
    if (url.pathname === '/api/fx') return sendJSONCached(res, 200, FX_SYMS.map((f) => ({ id: f.id, label: f.label, dp: f.dp })));
    if (url.pathname === '/api/rates') return sendJSONCached(res, 200, RATES.map((r) => ({ id: r.id, label: r.label, dp: r.dp })));
    if (url.pathname === '/api/markets') return sendJSONCached(res, 200, getMarkets());
    if (url.pathname === '/api/marketread') {
      const id = url.searchParams.get('id');
      if (!MARKETS.some((x) => x.id === id)) return sendJSON(res, 404, { error: 'unknown market' });
      return sendJSONCached(res, 200, await getMarketRead(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/marketwhy') {
      const id = url.searchParams.get('id');
      if (!MARKETS.some((x) => x.id === id)) return sendJSON(res, 404, { error: 'unknown market' });
      return sendJSONCached(res, 200, await getMarketWhy(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/attribution') {
      const id = url.searchParams.get('id');
      if (!MARKETS.some((x) => x.id === id)) return sendJSON(res, 404, { error: 'unknown segment' });
      return sendJSONCached(res, 200, await getAttribution(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/news') {
      const id = url.searchParams.get('id');
      if (!NEWS_QUERIES[id]) return sendJSON(res, 404, { error: 'unknown segment' });
      return sendJSONCached(res, 200, await getNews(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message), id, items: [] })));
    }
    if (url.pathname === '/api/transmission') return sendJSONCached(res, 200, await getTransmission().catch((e) => ({ error: String(e.message), ideas: [] })));
    if (url.pathname === '/api/headlines') return sendJSONCached(res, 200, await getHeadlines().catch((e) => ({ error: String(e.message), items: [] })));
    if (url.pathname === '/api/macro-news') {
      const id = url.searchParams.get('id');
      if (!NEWS_QUERIES[id]) return sendJSON(res, 404, { error: 'unknown region' });
      return sendJSONCached(res, 200, await getMacroNews(id).catch((e) => ({ error: String(e.message), items: [] })));
    }
    if (url.pathname === '/api/countries') return sendJSONCached(res, 200, MACRO_COUNTRIES);
    if (url.pathname === '/api/catalysts') {
      const c = url.searchParams.get('country') || 'us';
      return sendJSONCached(res, 200, await getCatalysts(c).catch((e) => ({ error: String(e.message), events: [] })));
    }
    if (url.pathname === '/api/macro-tickers') return sendJSONCached(res, 200, await getMacroTickers().catch((e) => ({ error: String(e.message), items: [] })));
    if (url.pathname === '/api/region-quotes') {
      const id = url.searchParams.get('id');
      if (!MACRO_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown region' });
      return sendJSONCached(res, 200, await getRegionTickers(id).catch((e) => ({ error: String(e.message), items: [] })));
    }
    if (url.pathname === '/api/yields') {
      const id = url.searchParams.get('id');
      if (!ALL_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown country' });
      return sendJSONCached(res, 200, await getBondYields(id).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/country-series') {
      const id = url.searchParams.get('id');
      if (!ALL_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown country' });
      return sendJSONCached(res, 200, await getCountrySeries(id, url.searchParams.get('range') || '1y', url.searchParams.get('vs') || null).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/country') {
      const id = url.searchParams.get('id');
      if (!ALL_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown country' });
      return sendJSONCached(res, 200, await getCountry(id).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/country-extras') {
      const id = url.searchParams.get('id');
      if (!ALL_COUNTRIES[id]) return sendJSON(res, 404, { error: 'unknown country' });
      return sendJSONCached(res, 200, await getCountryExtras(id).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/fundamentals') {
      const id = url.searchParams.get('id');
      if (!SCAN_QUERIES[id]) return sendJSON(res, 404, { error: 'unknown segment' });
      return sendJSONCached(res, 200, await getFundamentals(id, url.searchParams.get('component')).catch((e) => ({ error: String(e.message), items: [] })));
    }
    if (url.pathname === '/api/movewho') {
      const id = url.searchParams.get('id');
      if (!NEWS_QUERIES[id]) return sendJSON(res, 404, { error: 'unknown segment' });
      const reqs = (url.searchParams.get('dates') || '').split(',').map((s) => { const [date, dir] = s.split(':'); return { date, dir: dir === '1' ? 'up' : 'down' }; }).filter((r) => /^\d{4}-\d{2}(-\d{2})?$/.test(r.date));
      return sendJSONCached(res, 200, await getMoveWho(id, reqs, url.searchParams.get('focus')).catch((e) => ({ error: String(e.message), results: [] })));
    }
    if (url.pathname === '/api/longterm') {
      const id = url.searchParams.get('id');
      const years = Math.min(15, Math.max(1, Number(url.searchParams.get('years')) || 10));
      if (!resolveMetric(id)) return sendJSON(res, 404, { error: 'unknown metric' });
      return sendJSONCached(res, 200, await getLongterm(id, years).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/range') {
      const id = url.searchParams.get('id');
      if (!resolveMetric(id)) return sendJSON(res, 404, { error: 'unknown metric' });
      return sendJSONCached(res, 200, await getRange(id, url.searchParams.get('range') || 'ytd').catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/seasonal') {
      const b = BENCHMARKS.find((x) => x.id === url.searchParams.get('id'));
      if (!b) return sendJSON(res, 404, { error: 'unknown benchmark' });
      return sendJSONCached(res, 200, await getSeasonal(b).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/inventories') return sendJSONCached(res, 200, await getInventories());
    if (url.pathname === '/api/deals/lookup') {
      // On-demand backfill: Google News will still find an old deal when you ask for it BY NAME, even
      // though its RSS ignores date ranges. So the search box is also a lookup, not just a filter.
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
      if (q.length < 3) return sendJSON(res, 200, { added: 0, total: STORE.deals.length });
      ensureSeeded();
      // Search the term as typed plus a light deal hint. A broad boolean buries an old deal under
      // recent news; a specific name ("OxyChem") surfaces it, which is what a lookup is for.
      const items = await fetchGoogleNews(`${q} (acquisition OR merger OR deal OR buy OR acquire)`, 60).catch(() => []);
      let added = 0;
      for (const it of items) {
        const t = String(it.title || '');
        if (!/\b(acquire|acquisition|merger|takeover|to buy|buys|stake in|deal)\b/i.test(t)) continue;
        const p2 = parseDealTitle(t);
        if (!p2.acquirer && !p2.target) continue;
        const ev = {
          date: it.date ? it.date.slice(0, 10) : new Date().toISOString().slice(0, 10),
          status: eventStatus(t), title: t, source: it.source, url: it.url,
          acquirer: p2.acquirer, target: p2.target, value: p2.value, sector: dealSector(t),
        };
        if (mergeEvent(STORE, ev)) added++;
      }
      if (added) { try { fs.writeFileSync(DEAL_STORE_FILE, JSON.stringify(STORE)); } catch {} }
      const hit = STORE.deals.filter((d) => `${d.acquirer || ''} ${d.target || ''}`.toLowerCase().includes(q.toLowerCase())).length;
      return sendJSON(res, 200, { added, matches: hit, total: STORE.deals.length });
    }
    if (url.pathname === '/api/company-chart') {
      const ticker = String(url.searchParams.get('ticker') || '').trim();
      // The page used to send Yahoo's names (1mo/6mo) while the local slicer only matched 1m/6m, so
      // those two buttons quietly returned the entire series. Normalise once, here.
      const ALIAS = { '1mo': '1m', '3mo': '3m', '6mo': '6m', '1yr': '1y', '5yr': '5y', '10yr': '10y' };
      const range = ALIAS[String(url.searchParams.get('range') || '1y')] || String(url.searchParams.get('range') || '1y');
      const YAHOO = { '1m': '1mo', '3m': '3mo', '6m': '6mo', '1y': '1y', '5y': '5y', '10y': '10y', ytd: 'ytd' };
      const interval = String(url.searchParams.get('interval') || (range === '10y' ? '1mo' : range === '5y' ? '1wk' : '1d'));
      // Index symbols (^GSPC, ^VIX) are legitimate charts too, so the caret is allowed.
      if (!/^[A-Za-z0-9.\-^]{1,12}$/.test(ticker)) return sendJSON(res, 400, { error: 'bad ticker' });
      const stored = storeChart('us', ticker, range);
      if (stored) return sendChartJSON(res, 200, { ticker, range, dates: stored.dates, closes: stored.closes });
      // Served from the committed series, not from a live Yahoo call: Yahoo rate-limits this host, which
      // left the one-month and six-month charts with a single point for every company.
      const local = usCharts()[ticker];
      if (local && local.length > 1) {
        const last = local[local.length - 1][0];
        const back = (days) => new Date(Date.parse(last) - days * 86400000).toISOString().slice(0, 10);
        const from = range === '1m' ? back(31)
          : range === '3m' ? back(92)
            : range === '6m' ? back(190)
              : range === 'ytd' ? `${last.slice(0, 4)}-01-01`
                : range === '1y' ? back(366)
                  : range === '5y' ? back(1826)
                    : range === '10y' ? back(3653)
                      : '1900-01-01';
        const rows = local.filter(([d]) => d >= from);
        return sendChartJSON(res, 200, { ticker, range, dates: rows.map((r) => r[0]), closes: rows.map((r) => r[1]) });
      }
      const out = await cached('cochart:' + ticker + ':' + range + ':' + interval, 600e3, async () => {
        const { series } = await yahooSeries(ticker, YAHOO[range] || range, interval);
        const dates = Object.keys(series).sort();
        return { ticker, range, dates, closes: dates.map((d) => series[d]) };
      }).catch(() => null);
      if (!out) return sendJSON(res, 200, { error: 'no chart', dates: [], closes: [] });
      return sendChartJSON(res, 200, out);
    }
    if (url.pathname === '/api/search-quick') {
      return sendJSONCached(res, 200, globalSearchQuick(), 'public, max-age=300, stale-while-revalidate=3600');
    }
    if (url.pathname === '/api/global-search') {
      const q = String(url.searchParams.get('q') || '').slice(0, 80);
      const market = url.searchParams.get('market') || null;
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 30));
      const key = `${q.toLowerCase()}|${market || ''}|${limit}`;
      let out = GLOBAL_SEARCH_CACHE.get(key);
      if (!out) {
        const idx = globalSearchIndex();
        out = { ...searchEntries(idx.entries, q, { market, limit }), markets: idx.markets };
        if (GLOBAL_SEARCH_CACHE.size > 240) GLOBAL_SEARCH_CACHE.clear();
        GLOBAL_SEARCH_CACHE.set(key, out);
      }
      return sendJSONCached(res, 200, out, 'public, max-age=15, stale-while-revalidate=30');
    }
    if (url.pathname === '/api/market-index') {
      const mid = url.searchParams.get('market');
      const mi = globalMarketIndex();
      if (mid) {
        const m = mi.markets && mi.markets[mid];
        if (!m) return sendJSON(res, 404, { error: 'unknown market' });
        return sendJSONCached(res, 200, m, 'public, max-age=60, stale-while-revalidate=300');
      }
      return sendJSONCached(res, 200, mi, 'public, max-age=60, stale-while-revalidate=300');
    }
    if (url.pathname === '/api/global-companies') {
      const p = url.searchParams;
      const market = p.get('market') || 'all';
      const sector = p.get('sector') || 'all';
      const peMax = Number(p.get('peMax')) || 0;
      const peMin = Number(p.get('peMin')) || 0;
      const ytdMaxRaw = p.get('ytdMax');
      const ytdMax = ytdMaxRaw == null || ytdMaxRaw === '' ? null : Number(ytdMaxRaw);
      const roeRaw = p.get('roeMin');
      const roeMin = roeRaw == null || roeRaw === '' ? null : Number(roeRaw);
      const capMin = Number(p.get('capMin')) || 0;
      const ytdRaw = p.get('ytdMin');
      const ytdMin = ytdRaw == null || ytdRaw === '' ? null : Number(ytdRaw);
      const q = String(p.get('q') || '').trim().toLowerCase();
      const sort = p.get('sort') || 'cap';
      const limit = Math.max(1, Math.min(200, Number(p.get('limit')) || 50));
      const offset = Math.max(0, Number(p.get('offset')) || 0);
      const all = globalRows();
      const rows = all.filter((r) =>
        (market === 'all' || r.m === market)
        && (sector === 'all' || r.s === sector || r.native === sector)
        && (!peMax || (r.pe != null && r.pe > 0 && r.pe < peMax))
        && (!peMin || (r.pe != null && r.pe >= peMin))
        && (ytdMax == null || (r.ytd != null && r.ytd <= ytdMax))
        && (roeMin == null || (r.roe != null && r.roe >= roeMin))
        && (!capMin || r.cap >= capMin)
        && (ytdMin == null || (r.ytd != null && r.ytd >= ytdMin))
        && (!q || (r.n + ' ' + r.t).toLowerCase().includes(q)));
      const cmp = {
        cap: (a, b) => b.cap - a.cap,
        ytd: (a, b) => (b.ytd ?? -1e9) - (a.ytd ?? -1e9),
        pe: (a, b) => (a.pe == null || a.pe <= 0 ? 1e9 : a.pe) - (b.pe == null || b.pe <= 0 ? 1e9 : b.pe),
        roe: (a, b) => (b.roe ?? -1e9) - (a.roe ?? -1e9),
      }[sort] || ((a, b) => b.cap - a.cap);
      rows.sort(cmp);
      return sendJSON(res, 200, {
        total: rows.length,
        offset,
        limit,
        rows: rows.slice(offset, offset + limit),
        sectors: [...new Set(all.map((r) => r.s))].sort(),
        markets: [...new Set(all.map((r) => r.m))],
      });
    }
    if (url.pathname === '/api/home') {
      return sendJSONCached(res, 200, homeSummary(), 'public, max-age=60, stale-while-revalidate=300');
    }
    if (url.pathname === '/api/global-themes') {
      return sendJSONCached(res, 200, globalThemes(), 'public, max-age=60, stale-while-revalidate=300');
    }
    if (url.pathname === '/api/companies') {
      let valuation = null;
      try { valuation = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'valuation.json'), 'utf8')); } catch { /* none yet */ }
      const list = (COMPANIES.companies || []).map(projectUs);
      return sendListJSON(res, 200, {
        updated: COMPANIES.updated || null,
        count: list.length,
        companies: list,
        universe: COMPANIES.universe || null,
        themes: COMPANIES.themes || [],
        valuation: valuation ? { ...valuation.index, sectors: valuation.sectors || {} } : null,
      });
    }
    if (url.pathname === '/api/us-quality') {
      try {
        return sendJSONCached(res, 200, JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'us-quality.json'), 'utf8')));
      } catch {
        return sendJSON(res, 200, { error: 'US quality ledger has not been generated yet' });
      }
    }
    if (url.pathname.startsWith('/api/company/')) {
      const cik = decodeURIComponent(url.pathname.slice('/api/company/'.length));
      const c = (COMPANIES.companies || []).find((x) => String(x.cik) === cik || x.ticker === cik);
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/japan') {
      const jp = readJapanList();
      if (!jp.companies || !jp.companies.length) return sendJSON(res, 200, { companies: [], error: 'Japan has not been built yet' });
      return sendListJSON(res, 200, jp);
    }
    if (url.pathname === '/api/korea') {
      const kr = readKoreaList();
      if (!kr.companies || !kr.companies.length) return sendJSON(res, 200, { companies: [], error: 'Korea has not been built yet' });
      return sendListJSON(res, 200, kr);
    }
    if (url.pathname === '/api/korea/chart') {
      const ticker = url.searchParams.get('ticker');
      const range = url.searchParams.get('range') || '1y';
      const stored = storeChart('kr', ticker, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range });
      const kr = readKorea();
      const c = (kr.companies || []).find((x) => x.ticker === ticker);
      const series = (c && c.series) || [];
      if (!series.length) return sendJSON(res, 200, { dates: [], closes: [] });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const rows = series.filter((p) => p.d >= from);
      return sendChartJSON(res, 200, { dates: rows.map((p) => p.d), closes: rows.map((p) => p.c), range });
    }
    if (url.pathname.startsWith('/api/korea/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/korea/company/'.length));
      const c = readKoreaCompany(code) || (() => {
        const kr = readKorea();
        return (kr.companies || []).find((x) => x.code === code || x.ticker === code) || null;
      })();
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/taiwan') {
      const tw = readTaiwanList();
      if (!tw.companies || !tw.companies.length) return sendJSON(res, 200, { companies: [], error: 'Taiwan has not been built yet' });
      return sendListJSON(res, 200, tw);
    }
    if (url.pathname === '/api/taiwan/chart') {
      const code = url.searchParams.get('code');
      const range = url.searchParams.get('range') || '1y';
      const stored = storeChart('tw', code, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range, code });
      const store = readTaiwanSeries(code);
      const block = range === '5y' || range === '10y' ? store.weekly : store.daily;
      const series = (block && block[code]) || (store.weekly && store.weekly[code]) || [];
      if (!series.length) return sendJSON(res, 200, { dates: [], closes: [], range, code });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const rows = series.filter((p) => p.d >= from);
      return sendChartJSON(res, 200, { dates: rows.map((p) => p.d), closes: rows.map((p) => p.c), range, code });
    }
    if (url.pathname.startsWith('/api/taiwan/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/taiwan/company/'.length));
      const c = readTaiwanCompany(code) || (() => {
        const tw = readTaiwan();
        return (tw.companies || []).find((x) => x.code === code || x.ticker === code) || null;
      })();
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname.startsWith('/api/hongkong/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/hongkong/company/'.length));
      const c = readHongKongCompany(code);
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/hongkong/chart') {
      const code = url.searchParams.get('code');
      const range = url.searchParams.get('range') || '1y';
      const stored = storeChart('hk', code, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range, code });
      const store = readHongKongSeries(code);
      const block = range === '5y' || range === '10y' ? store.weekly : store.daily;
      const series = (block && block[code]) || (store.weekly && store.weekly[code]) || [];
      if (!series.length) return sendJSON(res, 200, { dates: [], closes: [], range, code });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const rows = series.filter((p) => p.d >= from);
      return sendChartJSON(res, 200, { dates: rows.map((p) => p.d), closes: rows.map((p) => p.c), range, code });
    }
    if (url.pathname === '/api/hongkong') {
      const hk = readHongKongList();
      if (!hk.companies || !hk.companies.length) return sendJSON(res, 200, { companies: [], error: 'Hong Kong has not been built yet' });
      return sendListJSON(res, 200, hk);
    }
    if (url.pathname.startsWith('/api/australia/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/australia/company/'.length));
      const c = readAustraliaCompany(code);
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/australia/chart') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      const range = url.searchParams.get('range') || '1y';
      const stored = storeChart('au', code, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range, code });
      const store = readAustraliaSeries(code);
      const block = range === '5y' || range === '10y' ? store.weekly : store.daily;
      const series = (block && block[code]) || (store.weekly && store.weekly[code]) || [];
      if (!series.length) return sendJSON(res, 200, { dates: [], closes: [], range, code });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const rows = series.filter((p) => p.d >= from);
      return sendChartJSON(res, 200, { dates: rows.map((p) => p.d), closes: rows.map((p) => p.c), range, code });
    }
    if (url.pathname === '/api/australia') {
      const au = readAustraliaList();
      if (!au.companies || !au.companies.length) return sendJSON(res, 200, { companies: [], error: 'Australia has not been built yet' });
      return sendListJSON(res, 200, au);
    }
    if (url.pathname.startsWith('/api/india/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/india/company/'.length));
      const c = readIndiaCompany(code);
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/india/chart') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      const range = url.searchParams.get('range') || '1y';
      const stored = storeChart('in', code, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range, code });
      const store = readIndiaSeries(code);
      const block = range === '5y' || range === '10y' ? store.weekly : store.daily;
      const series = (block && block[code]) || (store.weekly && store.weekly[code]) || [];
      if (!series.length) return sendJSON(res, 200, { dates: [], closes: [], range, code });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const rows = series.filter((p) => p.d >= from);
      return sendChartJSON(res, 200, { dates: rows.map((p) => p.d), closes: rows.map((p) => p.c), range, code });
    }
    if (url.pathname === '/api/india') {
      const ind = readIndiaList();
      if (!ind.companies || !ind.companies.length) return sendJSON(res, 200, { companies: [], error: 'India has not been built yet' });
      return sendListJSON(res, 200, ind);
    }
    if (url.pathname.startsWith('/api/indonesia/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/indonesia/company/'.length));
      const c = readIndonesiaCompany(code);
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/indonesia/chart') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      const range = url.searchParams.get('range') || '1y';
      const stored = storeChart('id', code, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range, code });
      const store = readIndonesiaSeries(code);
      const block = range === '5y' || range === '10y' ? store.weekly : store.daily;
      const series = (block && block[code]) || (store.weekly && store.weekly[code]) || [];
      if (!series.length) return sendJSON(res, 200, { dates: [], closes: [], range, code });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const rows = series.filter((p) => p.d >= from);
      return sendChartJSON(res, 200, { dates: rows.map((p) => p.d), closes: rows.map((p) => p.c), range, code });
    }
    if (url.pathname === '/api/indonesia') {
      const ind = readIndonesiaList();
      if (!ind.companies || !ind.companies.length) return sendJSON(res, 200, { companies: [], error: 'Indonesia has not been built yet' });
      return sendListJSON(res, 200, ind);
    }
    if (url.pathname.startsWith('/api/brazil/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/brazil/company/'.length));
      const c = readBrazilCompany(code);
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/brazil/chart') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      const range = url.searchParams.get('range') || '1y';
      const stored = storeChart('br', code, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range, code });
      const store = readBrazilSeries(code);
      const block = range === '5y' || range === '10y' ? store.weekly : store.daily;
      const series = (block && block[code]) || (store.weekly && store.weekly[code]) || [];
      if (!series.length) return sendJSON(res, 200, { dates: [], closes: [], range, code });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const rows = series.filter((p) => p.d >= from);
      return sendChartJSON(res, 200, { dates: rows.map((p) => p.d), closes: rows.map((p) => p.c), range, code });
    }
    if (url.pathname === '/api/brazil') {
      const br = readBrazilList();
      if (!br.companies || !br.companies.length) return sendJSON(res, 200, { companies: [], error: 'Brazil has not been built yet' });
      return sendListJSON(res, 200, br);
    }
    if (url.pathname.startsWith('/api/southafrica/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/southafrica/company/'.length));
      const c = readSouthAfricaCompany(code);
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/southafrica/chart') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      const range = url.searchParams.get('range') || '1y';
      const stored = storeChart('za', code, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range, code });
      const store = readSouthAfricaSeries(code);
      const block = range === '5y' || range === '10y' ? store.weekly : store.daily;
      const series = (block && block[code]) || (store.weekly && store.weekly[code]) || [];
      if (!series.length) return sendJSON(res, 200, { dates: [], closes: [], range, code });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const rows = series.filter((p) => p.d >= from);
      return sendChartJSON(res, 200, { dates: rows.map((p) => p.d), closes: rows.map((p) => p.c), range, code });
    }
    if (url.pathname === '/api/southafrica') {
      const za = readSouthAfricaList();
      if (!za.companies || !za.companies.length) return sendJSON(res, 200, { companies: [], error: 'South Africa has not been built yet' });
      return sendListJSON(res, 200, za);
    }
    if (url.pathname.startsWith('/api/japan/company/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/japan/company/'.length));
      const c = withJapanGrowth(readJapanCompany(code) || (() => {
        const jp = readJapan();
        return (jp.companies || []).find((x) => x.code === code || x.ticker === code) || null;
      })());
      if (!c) return sendJSON(res, 404, { error: 'not found' });
      return sendJSONCached(res, 200, normalizeCompanyEps(c));
    }
    if (url.pathname === '/api/japan-chart') {
      const code = url.searchParams.get('code');
      const range = url.searchParams.get('range') || '6m';
      const stored = storeChart('jp', code, range);
      if (stored) return sendChartJSON(res, 200, { dates: stored.dates, closes: stored.closes, range, code });
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      let store = null;
      try { store = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'japan-series.json'), 'utf8')); } catch { store = null; }
      const block = store ? ((range === '1m' || range === '3m' || range === '6m') ? store.daily : store.weekly) : null;
      // Accept either the 5-digit JPX code (72030) or the 4-digit ticker (7203). The compare box and the
      // cross-market chart use tickers, which silently returned an empty series before this.
      const series = (block && block.series) || {};
      let key = code;
      if (!series[key] && code && !series[`${code}0`]) key = code;
      if (!series[key] && code && series[`${code}0`]) key = `${code}0`;
      if (!series[key] && code && series[`${code}`.padStart(5, '0')]) key = String(code).padStart(5, '0');
      const arr = series[key] || null;
      if (!arr) return sendJSON(res, 200, { dates: [], closes: [], range, code });
      const now = Date.now();
      const from = range === '1m' ? iso(now - 31 * 864e5)
        : range === '3m' ? iso(now - 92 * 864e5)
          : range === '6m' ? iso(now - 190 * 864e5)
            : range === 'ytd' ? `${new Date().getUTCFullYear()}-01-01`
              : range === '1y' ? iso(now - 366 * 864e5)
                : range === '5y' ? iso(now - 1826 * 864e5)
                  : range === '10y' ? iso(now - 3653 * 864e5)
                    : '1900-01-01';
      const dates = [], closes = [];
      block.dates.forEach((d, i) => { if (d >= from && arr[i] != null) { dates.push(d); closes.push(arr[i]); } });
      return sendJSON(res, 200, { dates, closes, range });
    }
    if (url.pathname === '/api/deals') {
      ensureSeeded();
      const store = await refreshDeals().catch(() => STORE);
      const days = Number(url.searchParams.get('days') || 0);
      const sector = url.searchParams.get('sector') || null;
      const cutoff = days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : null;
      const deals = (store.deals || [])
        .filter((d) => (!cutoff || (d.lastSeen || d.date || '') >= cutoff) && (!sector || d.sector === sector))
        .sort((a, b) => ((b.lastSeen || b.date) < (a.lastSeen || a.date) ? -1 : 1))
        .slice(0, 2000)
        .map((d) => {
          const inf = inferStatus(d);
          return { ...d, status: inf.status, statusInferred: inf.inferred, type: d.type || dealType(d.title || '') };
        });
      const sectors = DEAL_SECTOR_RULES.map((sec) => {
        const rows = deals.filter((w) => w.sector === sec.id);
        return { id: sec.id, count: rows.length, value: rows.reduce((a, b) => a + (b.value || 0), 0) };
      }).filter((sec) => sec.count).sort((a, b) => b.value - a.value || b.count - a.count);
      const since = (store.deals || []).map((d) => d.date).filter(Boolean).sort()[0] || null;
      return sendJSONCached(res, 200, {
        // The store's own timestamp, not "now": a fresh date on every request gave every response a
        // new ETag, so the 848 KB book could never be revalidated or re-used.
        updated: store.updated || new Date().toISOString(),
        coverage: DEAL_ARCHIVE.coverage || {},
        sectors, deals,
        log: { count: (store.deals || []).length, since },
      });
    }
    if (url.pathname === '/api/regime') return sendJSONCached(res, 200, await getRegime().catch((e) => ({ error: String(e.message), rows: [] })));
    if (url.pathname === '/api/screen') return sendJSONCached(res, 200, await getScreen().catch((e) => ({ error: String(e.message), rows: [] })));
    if (url.pathname === '/api/segmentscore') return sendJSONCached(res, 200, await getSegmentScore(url.searchParams.get('segment') || 'crude').catch((e) => { console.error('[segmentscore]', e.message); return { segment: url.searchParams.get('segment') || 'crude', asOf: null, rows: [] }; }), 'public, max-age=300, stale-while-revalidate=300');
    if (url.pathname === '/api/risk') return sendJSONCached(res, 200, await getRisk().catch((e) => ({ error: String(e.message), metrics: [], matrix: {}, matrix3m: {} })));
    if (url.pathname === '/api/fxadjusted') return sendJSONCached(res, 200, await getFxAdjusted(url.searchParams.get('base') || 'USD').catch((e) => ({ error: String(e.message), rows: [] })));
    if (url.pathname === '/api/search') return sendListJSON(res, 200, searchCompanies(url.searchParams.get('q'), Math.min(20, Number(url.searchParams.get('limit')) || 8)));
    if (url.pathname === '/api/peers') return sendListJSON(res, 200, getPeers(url.searchParams.get('ref'), Math.min(12, Number(url.searchParams.get('n')) || 6)));
    if (url.pathname === '/api/fxwindows') return sendJSONCached(res, 200, await getFxWindows(url.searchParams.get('base') || 'USD').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/options') return sendJSONCached(res, 200, await getOptions(url.searchParams.get('id') || 'wti').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/positioning') {
      const seg = url.searchParams.get('segment');
      const p = seg ? getPositioningSegment(seg) : getPositioning(url.searchParams.get('id') || 'wti');
      return sendJSONCached(res, 200, await p.catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/equities') return sendJSONCached(res, 200, await getEquities());
    if (url.pathname === '/api/macro') return sendJSONCached(res, 200, await getMacro());
    if (url.pathname === '/api/macrodash') return sendJSONCached(res, 200, await getMacroDash().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/correlations') return sendJSONCached(res, 200, await getCorrelations().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/events') return sendJSONCached(res, 200, getEvents());
    if (url.pathname === '/api/calendar') {
      return sendJSONCached(res, 200, await getCalendarFull().catch((e) => ({ error: String(e.message), events: [] })));
    }
    if (url.pathname === '/api/curve') return sendJSONCached(res, 200, await getCurves());
    if (url.pathname === '/api/termstructure') {
      const id = url.searchParams.get('id');
      if (!BENCHMARKS.some((x) => x.id === id)) return sendJSON(res, 404, { error: 'unknown benchmark' });
      return sendJSONCached(res, 200, await getCurveFor(id).catch((e) => ({ error: String(e.message) })));
    }
    if (url.pathname === '/api/curvehistory') return sendJSONCached(res, 200, await getCurveHistory(url.searchParams.get('root') || 'CL').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/continuous') return sendJSONCached(res, 200, await getContinuous(url.searchParams.get('root') || 'CL').catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/tightness') return sendJSONCached(res, 200, await getTightness().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/products') return sendJSONCached(res, 200, await getProducts().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/crush') return sendJSONCached(res, 200, await getCrush().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/steel') return sendJSONCached(res, 200, await getSteelMargin().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/analogue') return sendJSONCached(res, 200, await getAnalogue(url.searchParams.get('metric') || 'basis:brent', Math.min(15, Math.max(2, Number(url.searchParams.get('years')) || 10))));
    if (url.pathname === '/api/alerts') return sendJSONCached(res, 200, { current: await computeServerAlerts().catch(() => []) });
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
      if (kind === 'email' && emailReach() !== 'anyone' && target.toLowerCase() !== String(process.env.DIGEST_TO || '').toLowerCase()) {
        return sendJSON(res, 503, { error: 'This site can’t email new addresses yet (it has no verified sending domain) — please subscribe with a chat channel instead: an ntfy.sh topic takes a minute and needs no account.' });
      }
      const ip = clientIp(req);
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
        // Say something the visitor can act on: a rate limit and a bad URL are very different problems.
        const m = String(e.message || '');
        const isMail = isEmail(target);
        const msg = /429/.test(m) ? 'That channel is rate-limiting us right now — please try again in a few minutes.'
          : /\b40[13]\b/.test(m) ? (isMail ? 'The mail provider rejected that address — check it, or subscribe with a chat channel instead.' : 'That channel rejected the message — double-check the webhook URL.')
          : isMail ? `Couldn’t email that address (${m.slice(0, 60)}).` : `Couldn’t reach that destination (${m.slice(0, 50)}). Check the address and try again.`;
        return sendJSON(res, 502, { error: msg });
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
        email: { configured: mailConfigured(), provider: mailProvider(), reach: emailReach(), to: mask(process.env.DIGEST_TO), host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465) },
        webhook: Boolean(process.env.WEBHOOK_URL),
        desktop: process.platform === 'darwin' && process.env.NOTIFY !== 'off',
        digest: { hour: Number(process.env.DIGEST_HOUR ?? 7), lastDate: notifyStatus.digestDate || state.lastDigestDate || null, lastAt: notifyStatus.digestAt },
        last: { at: notifyStatus.lastAt, kind: notifyStatus.lastKind, ok: notifyStatus.lastOk, error: notifyStatus.lastError },
        alerts: { muted: alertSeen.size },
        serverRules: { enabled: Boolean(process.env.AUTH_USER && process.env.AUTH_PASS), count: Array.isArray(state.rules) ? state.rules.length : 0 },
        subscribers: { active: subs().filter((x) => x.active).length, pending: subs().filter((x) => !x.active).length, cap: SUB_CAP, durable: stateDurable },
      });
    }
    if (url.pathname === '/api/notify/test' && req.method === 'POST') {
      // One test per caller per minute. The endpoint is reachable without auth on a default
      // deployment, so the clock is keyed by address rather than shared.
      const who = clientIp(req);
      const since = Date.now() - (testSentAt.get(who) || 0);
      if (since < 60_000) return sendJSON(res, 429, { error: `slow down — try again in ${Math.ceil((60_000 - since) / 1000)}s` });
      testSentAt.set(who, Date.now());
      if (testSentAt.size > 2000) for (const [k, t] of testSentAt) if (Date.now() - t > 3600e3) testSentAt.delete(k);
      const body = `This is a test from Marlon's Watchtower.\n\nIf you're reading it, alert + digest delivery works.\nChannels: ${[mailConfigured() && 'email', process.env.WEBHOOK_URL && 'webhook', process.platform === 'darwin' && process.env.NOTIFY !== 'off' && 'desktop'].filter(Boolean).join(', ') || 'none configured'}.`;
      await deliver('test', "Marlon's Watchtower · test message", body);
      return sendJSON(res, 200, { ok: notifyStatus.lastOk, error: notifyStatus.lastError, channels: { email: mailConfigured(), webhook: Boolean(process.env.WEBHOOK_URL) } });
    }
    if (url.pathname === '/api/brief') return sendJSONCached(res, 200, await buildBrief().catch((e) => ({ error: String(e.message) })));
    if (url.pathname === '/api/analytics') return sendJSONCached(res, 200, await getAnalytics(Number(url.searchParams.get('freight')) || FREIGHT_DEFAULT).catch((e) => { console.error('[analytics]', e.message); return { benchmarks: {} }; }));
    if (url.pathname === '/api/relvalue') return sendJSONCached(res, 200, await getRelValue(url.searchParams.get('segment') || 'crude').catch((e) => { console.error('[relvalue]', e.message); return { segment: url.searchParams.get('segment') || 'crude', asOf: null, rows: [] }; }), 'public, max-age=300, stale-while-revalidate=300');
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
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    // Swap the source for the minified build when the image has one (see MIN_CLIENT above).
    const served = '/' + clientFile(file.slice(1));
    const full = path.join(PUBLIC, served);
    let st = null;
    try { st = fs.statSync(full); } catch {}
    if (!full.startsWith(PUBLIC) || !st || st.isDirectory()) {
      const nf = path.join(PUBLIC, '404.html');
      res.writeHead(404, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
      if (fs.existsSync(nf)) return fs.createReadStream(nf).pipe(res);
      return res.end('not found');
    }
    const ext = path.extname(full);
    const enc = st.size > 1024 && COMPRESSIBLE.has(ext) ? pickEncoding(req.headers['accept-encoding']) : null;
    // Every asset link carries ?v=<cache-buster>, so the URL itself promises the bytes will never change
    // for that version. Let the browser keep it for a year: the JS is 105 KB gzipped and used to be
    // re-downloaded on every single visit because the header was plain `no-cache`.
    const versioned = url.searchParams.has('v');
    // index.html links the assets, so its content depends on THEIR mtimes — both the ETag and the
    // compressed-body cache key have to include them or a deploy serves the old version numbers.
    const isIndex = file === '/index.html';
    const assetKey = isIndex ? ':' + VERSIONED_FILES.map(assetStamp).join('-') : '';
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${assetKey}${enc ? '-' + enc : ''}"`;
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      etag,
      'last-modified': new Date(st.mtimeMs).toUTCString(),
      'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (!versioned && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    if (enc) {
      const key = full + ':' + st.mtimeMs + assetKey + ':' + enc;
      let buf = zcache.get(key);
      if (!buf) {
        const raw = isIndex ? Buffer.from(stampIndex(fs.readFileSync(full, 'utf8'))) : fs.readFileSync(full);
        buf = encodeBuf(raw, enc);
        if (zcache.size > 80) zcache.clear();
        zcache.set(key, buf);
      }
      headers['content-encoding'] = enc; headers.vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      return res.end(buf);
    }
    res.writeHead(200, headers);
    if (isIndex) return res.end(stampIndex(fs.readFileSync(full, 'utf8')));
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    // The reader gets a plain failure; the stack stays in the server log. An exception message can
    // carry a file path, an upstream URL or a token fragment, and a 500 is exactly when someone is
    // probing for one.
    console.error('[request]', req.method, req.url, err && err.stack ? err.stack : err);
    sendJSON(res, 500, { error: 'Something went wrong on the server.' });
  }
});

// Slowloris insurance: a connection that dribbles headers or a body cannot hold a worker for the
// Node defaults (60 s / 300 s). Normal pages and API calls are far inside these.
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 65_000;

server.listen(PORT, async () => {
  await loadRemoteState();                     // durable state first, so nothing reads stale values
  console.log(`\n  🛢️  Marlon's Watchtower running at  http://localhost:${PORT}`);
  console.log(`     ${BENCHMARKS.length} benchmarks: ${BENCHMARKS.map((b) => b.label).join(', ')}`);
  console.log(`     alerts:  ${[process.env.WEBHOOK_URL && 'webhook', process.env.SMTP_USER && 'email', process.platform === 'darwin' && process.env.NOTIFY !== 'off' && 'desktop'].filter(Boolean).join(', ') || 'desktop'}`);
  console.log(`     digest:  ${process.env.DIGEST_HOUR ?? 7}:00 daily → ${process.env.DIGEST_TO || process.env.WEBHOOK_URL || 'desktop + digest.log'}`);
  console.log(`     state:   ${stateDurable ? 'Upstash Redis (survives redeploys)' : '.state.json only — subscribers/rules reset when the host wipes the disk (set UPSTASH_REDIS_REST_URL + _TOKEN to keep them)'}\n`);
  setTimeout(alertLoop, 12_000);
  setInterval(alertLoop, 5 * 60_000);
  setInterval(maybeSendDigest, 60_000);
  // Warm every segment's READ + curve in the background so switching segments is instant for the
  // user (a cold read is ~1.5s; warm it is ~1ms). Started after the first paint settles, gently
  // staggered; `cached()` de-dupes so a user request during warm-up just shares the work.
  // Warm the boot-critical caches early so a visitor right after a deploy still loads fast:
  // base feeds → CFTC positioning (parallel) → boards → the 9 segment reads → the screener.
  const warmCaches = async () => {
    // Full warm is opt-in. The default is the light set: on the 512 MB free instance, warming every
    // COT series, all nine segment reads and the event pool pushed steady RSS to ~420 MB, and a
    // company page plus a chart bucket then hit the ceiling (the 502s on HK/AU charts and peers).
    // The light set keeps the landing feeds, brief, macro board and screener warm at ~250 MB; the
    // below-the-fold segment reads and positioning pay a ~1 s cold cost on first open.
    const fullWarm = process.env.WARM === 'full';
    // The brief is what the reader lands on first. Warm the base feeds first; the event pool is
    // built gently at the END (it fans out over every news feed) so it cannot compete with the
    // first visitor or the macro/news caches.
    try { await Promise.all([getMarket(), getHistory(), getAnalytics()]); } catch {}
    try { await buildBrief(); } catch {}
    // The boards a visitor can reach without waiting: the backdrop, the calendar, the macro tab's
    // default country and the currency strip. Each one was a cold second on first open.
    try { await Promise.all([getRegime(), getCalendar(), getMacroTickers(), getMacroDash(), getCountry('us')]); } catch {}
    if (fullWarm) {
      // Positioning is the single heaviest warm step (~150 MB peak when all COT series are fetched at
      // once). Warm it one instrument at a time and stop before the ceiling.
      try {
        for (const b of BENCHMARKS.filter((x) => COT_NAMES[x.id])) {
          if (process.memoryUsage().rss > 360 * 1024 * 1024) break;
          await getPositioning(b.id).catch(() => {});
          await new Promise((r) => setTimeout(r, 150));
        }
      } catch {}
      for (const m of MARKETS) { try { await getMarketRead(m.id, null); } catch {} await new Promise((r) => setTimeout(r, 300)); }
    }
    try { await getScreen(); } catch {}
    // Korea's list is the cheap projection (242 KB). Its 28 MB statement file is deliberately NOT
    // parsed here: on the free 512 MB instance that persistent cache, plus the Hong Kong and Australia
    // datasets, pushed the process into OOM — the symptom was 502s on the company chart and peers
    // endpoints. Company pages read their own small file from data/korea-companies instead.
    try { readKoreaList(); } catch {}
    // Last, and deliberately gentle (3 news calls at a time): the event layer is a nice-to-have, not
    // a reason for the macro/news feeds to come back rate-limited on a cold start. Skip it entirely
    // when the process is already close to the free-tier ceiling.
    // The event layer is the top of the brief, so every boot warms it — last, gently, and skipped
    // when the process is already close to the free-tier ceiling.
    if (process.memoryUsage().rss < 400 * 1024 * 1024) { try { await buildEventPool(); } catch {} }
  };
  // Keep the caches hot on a timer shorter than the shortest TTL (the quote cache is 3 minutes), so
  // a visitor almost never lands on an expired feed. Guarded: a slow warm must not stack up.
  let warming = false;
  const warm = () => {
    if (warming) return;
    warming = true;
    warmCaches().catch(() => {}).finally(() => { warming = false; });
  };
  // WARM=off lets the test suite exercise cold paths without the warmer competing for the same
  // upstreams (and tripping their rate limits while the tests are still asserting).
  if (process.env.WARM !== 'off') {
    setTimeout(warm, 800);
    setInterval(warm, 2 * 60_000);
  }
  // Build the search and peer indexes once, off the request path. They read committed list artifacts
  // (no network), so this runs even when the upstream warmer is off (WARM=off): the alternative is
  // paying a synchronous ~0.5 s parse inside the first company page or search, in front of the chart.
  setTimeout(() => {
    if (process.memoryUsage().rss < 300 * 1024 * 1024) {
      try { searchIndex(); peerIndex(); globalSearchIndex(); globalSearchQuick(); } catch (e) { console.log('[indexes]', e.message); }
    }
  }, 1200);

});

// Render sends SIGTERM when it replaces an instance. Close the listener and exit 0 so a normal
// deploy does not look like a crash; force the exit if a keep-alive socket refuses to drain.
const shutdown = (signal) => {
  console.log(`[shutdown] ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Background feeds are allowed to fail without taking the whole desk down. Log the stack so the
// next Render alert has a cause attached to it.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('exit', (code) => {
  console.log(`[exit] code=${code} uptime=${Math.round(process.uptime())}s rssMB=${Math.round(process.memoryUsage().rss / 1048576)}`);
});
