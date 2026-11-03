// Build the Taiwan dataset: every TWSE-listed common stock.
//
//   node scripts/build-taiwan.mjs                      full run (all listed companies, five years)
//   node scripts/build-taiwan.mjs --limit=20 --days=400  smoke test
//   node scripts/build-taiwan.mjs --codes=2330,2454     named companies
//   node scripts/build-taiwan.mjs --skip-prices         reuse the cached daily files
//
// Sources:
//   - TWSE OpenAPI: company master, daily all-stock prices, official P/E / P/B / yield.
//   - stockanalysis.com (TPE): English statements, annual and quarterly. The same source the Japan
//     and Korea profile fetchers use; values are in millions TWD.
//   - Yahoo: TAIEX history and USD/TWD (the ECB does not publish TWD).
//
// Output: data/taiwan.json (records + reports), data/taiwan-series/{0..9}.json (daily/weekly closes, bucketed),
// data/taiwan-list.json (the compact /api/taiwan payload).

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { join } from 'node:path';
import {
  ROOT, TWSE, UA, SA_CACHE, TW_CACHE, readJson, writeJson, getCached, sleep,
  parseDayCsv, parseSaTable, rowOf, sectorOf, periodFromTitle,
} from './twse.mjs';
import { deriveTaiwan } from './derive-taiwan.mjs';

const OUT = join(ROOT, 'data', 'taiwan.json');
const SERIES_DIR = join(ROOT, 'data', 'taiwan-series');
const LIST_OUT = join(ROOT, 'data', 'taiwan-list.json');
const PROFILES = join(ROOT, 'data', 'taiwan-profiles.json');
const THEMES = join(ROOT, 'data', 'taiwan-themes.json');
const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const listedIso = (v) => { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const ymd = (d) => iso(d).replace(/-/g, '');
const arg = (k, d = null) => { const x = process.argv.find((a) => a.startsWith(`--${k}=`)); return x ? x.split('=')[1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);

const LIMIT = Number(arg('limit', 0)) || 0;
const CODES = (arg('codes', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const YEARS = Number(arg('years', 5)) || 5;
const DAYS = Number(arg('days', 0)) || YEARS * 365;
const SKIP_PRICES = flag('skip-prices');
const SKIP_FIN = flag('skip-fin');
const FRESH = flag('fresh');
const TTL_DAY = 6 * 3600e3;
const TTL_FIN = 7 * DAY;
const TTL_Q = 1 * DAY;

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const at = i++; out[at] = await fn(items[at], at); }
  });
  await Promise.all(workers);
  return out;
}

// --- 1. master + official valuation -------------------------------------------------------------
console.log('TWSE master…');
const master = JSON.parse(await getCached(TWSE.master, join(TW_CACHE, 'master.json'), { ttlMs: TTL_DAY, fresh: FRESH }));
const valuation = JSON.parse(await getCached(TWSE.valuation, join(TW_CACHE, 'valuation.json'), { ttlMs: TTL_DAY, fresh: FRESH }));
const valBy = new Map(valuation.map((v) => [v.Code, v]));
const masterBy = new Map();
for (const m of master) {
  const code = m['公司代號'];
  if (!/^\d{4}$/.test(code)) continue;                    // ETFs, warrants, preferred lines
  if (code.startsWith('91')) continue;                    // TDRs are not common stock
  const shares = Number(m['已發行普通股數或TDR原股發行股數']) || 0;
  if (!shares) continue;
  masterBy.set(code, {
    code,
    ticker: code,
    name: (m['公司簡稱'] || m['公司名稱'] || code).trim(),
    abbr: (m['英文簡稱'] || '').trim(),
    industry: String(m['產業別'] || '').padStart(2, '0'),
    sector: sectorOf(m['產業別']),
    shares,
    listed: m['上市日期'] || null,
    website: m['網址'] || null,
  });
}
console.log(`  ${masterBy.size} listed common stocks`);

// --- 2. the universe, then Yahoo price history ---------------------------------------------------
// The TWSE's all-stock file only serves the latest session (older dates are blocked by its WAF), so
// the universe comes from the official latest close and the history from Yahoo, one request per code.
const dayAll = JSON.parse(await getCached(TWSE.dayAll, join(TW_CACHE, 'day-all.json'), { ttlMs: 3600e3, fresh: FRESH }));
const closeBy = new Map(dayAll.map((d) => [d.Code, Number(d.ClosingPrice)]));
const priced = [];
for (const [code, m] of masterBy) {
  const px = closeBy.get(code);
  if (!(px > 0)) continue;
  priced.push({ ...m, price: px, priceDate: iso(Date.now()), marketCap: px * m.shares });
}
priced.sort((a, b) => b.marketCap - a.marketCap);
let universe = CODES.length ? priced.filter((c) => CODES.includes(c.code)) : (LIMIT ? priced.slice(0, LIMIT) : priced);
console.log(`  ${priced.length} priced · building ${universe.length}`);

const FIN_CACHE = join(ROOT, 'data', 'cache', 'taiwan-finmind');
const YH_CACHE = join(ROOT, 'data', 'cache', 'taiwan-yahoo');
const FINMIND_TOKEN = process.env.FINMIND_TOKEN || '';
mkdirSync(FIN_CACHE, { recursive: true });
mkdirSync(YH_CACHE, { recursive: true });

function parseFinmind(text) {
  try {
    const j = JSON.parse(text);
    if (j.status !== 200 || !Array.isArray(j.data)) return [];
    return j.data.map((r) => ({ d: r.date, c: Number(r.close) })).filter((p) => p.d && Number.isFinite(p.c) && p.c > 0);
  } catch { return []; }
}
function cachedFinmind(code) {
  const f = join(FIN_CACHE, `${code}.json`);
  if (!existsSync(f)) return null;
  try { return parseFinmind(JSON.parse(readFileSync(f, 'utf8')).text); } catch { return null; }
}

// Yahoo is the price source for the history: one request per code. It rate-limits bursts, so a 429
// parks the whole pool for a minute instead of burning retries. FinMind is the fallback (and already
// holds the first ~300 codes from an earlier run).
// Yahoo rejects Node's undici fingerprint (fetch fails; the same URL over https.get returns 200).
// A plain https.get is the reliable client here.
function httpsGet(url, timeout = 25000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (oil-basis)', Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, text: '' }); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: 200, text: body }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, text: '' }));
  });
}
let yahooUntil = 0;
async function yahooPrice(code) {
  const f = join(YH_CACHE, `${code}.json`);
  if (existsSync(f)) {
    try {
      const hit = JSON.parse(readFileSync(f, 'utf8'));
      if (hit.fetched && Date.now() - Date.parse(hit.fetched) < 6 * 3600e3) {
        const s = hit.text ? JSON.parse(hit.text) : null;
        if (s) return s;
      }
    } catch { /* refetch */ }
  }
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${code}.TW?range=${YEARS}y&interval=1d`;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (yahooUntil > Date.now()) await sleep(Math.min(30000, yahooUntil - Date.now()));
    const r = await httpsGet(url);
    if (r.status === 429) { yahooUntil = Date.now() + 60e3; await sleep(5000 * (attempt + 1)); continue; }
    if (r.status !== 200 || !r.text) { await sleep(1000 * (attempt + 1)); continue; }
    try {
      const j = JSON.parse(r.text);
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) return [];
      const ts = res.timestamp || [];
      const closes = (res.indicators.quote[0] || {}).close || [];
      const s = ts.map((t, i) => ({ d: iso(t * 1000), c: closes[i] })).filter((p) => p.c != null && p.c > 0);
      if (!s.length) return [];
      writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), text: JSON.stringify(s) }));
      return s;
    } catch { await sleep(800); }
  }
  return [];
}
async function finmindPrice(code) {
  const f = join(FIN_CACHE, `${code}.json`);
  const q = `dataset=TaiwanStockPrice&data_id=${code}&start_date=${iso(Date.now() - YEARS * 365 * DAY)}`;
  try {
    const text = await getCached(`https://api.finmindtrade.com/api/v4/data?${q}${FINMIND_TOKEN ? `&token=${encodeURIComponent(FINMIND_TOKEN)}` : ''}`, f, { ttlMs: 6 * 3600e3, retries: 2, timeout: 25000 });
    return text ? parseFinmind(text) : [];
  } catch { return []; }   // 402 = the free hourly quota; the caller falls back to Yahoo
}
// Taiwan's daily limit is ±10%, so a single-day move beyond ±25% is a split, a capital reduction or a
// bad print. Yahoo's raw close does not adjust the first two, which turns a 20:1 split into a −95%
// "return". If the jump reverses within three sessions it is a bad print: flatten it. If it holds, it
// is a corporate action: back-adjust every earlier close by the observed ratio, so the 5-year strip is
// continuous and the latest price stays the real one.
function sanitizeSeries(series) {
  const s = series.map((p) => ({ d: p.d, c: p.c }));
  let adjustments = 0;
  for (let pass = 0; pass < 8; pass++) {
    let fixed = false;
    for (let i = 1; i < s.length; i++) {
      const r = s[i].c / s[i - 1].c;
      if (r <= 1.25 && r >= 0.75) continue;
      if (i < 5) continue;                       // a newly listed stock has no daily limit at first
      const pre = s[i - 1].c;
      let reverses = false;
      for (let j = i + 1; j <= Math.min(i + 3, s.length - 1); j++) {
        if (Math.abs(s[j].c / pre - 1) < 0.2) { reverses = true; break; }
      }
      if (reverses) s[i].c = pre;                // bad print/no-limit spike: no fake move
      else { const f = s[i].c / pre; for (let k = 0; k < i; k++) s[k].c *= f; }
      adjustments++;
      fixed = true;
      break;                                     // restart: the adjustment can expose another jump
    }
    if (!fixed) break;
  }
  return { s, adjustments };
}
async function priceSeries(code) {
  // Yahoo's close is split-adjusted; FinMind's is raw. Prefer Yahoo, and keep FinMind only as a
  // fallback so a split never enters the five-year return strip as a real move.
  const y = await yahooPrice(code);
  if (y.length > 1) return { s: y, source: 'yahoo' };
  const fm = cachedFinmind(code);
  if (fm && fm.length > 1) return { s: fm, source: 'finmind' };
  return { s: y.length ? y : (await finmindPrice(code)), source: y.length ? 'yahoo' : 'finmind' };
}
if (!SKIP_PRICES) {
  console.log(`prices… ${universe.length} codes, ${YEARS}y daily (Yahoo, FinMind fallback)`);
  let done = 0;
  await pool(universe, 2, async (c) => {
    const got = await priceSeries(c.code);
    if (got.s.length) {
      // Never chart grey-market or pre-listing prices: the exchange master's listing date is the start.
      const start = listedIso(c.listed);
      const base = start ? got.s.filter((p) => p.d >= start) : got.s;
      const clean = sanitizeSeries(base.length > 1 ? base : got.s);
      c.series = clean.s;
      c.priceSource = got.source;
      c.priceAdjusted = clean.adjustments || 0;
    }
    if (++done % 100 === 0) console.log(`  ${done}/${universe.length} codes`);
    await sleep(180);
  });
} else {
  for (const c of universe) {
    try {
      const f = join(YH_CACHE, `${c.code}.json`);
      if (existsSync(f)) {
        const s = JSON.parse(JSON.parse(readFileSync(f, 'utf8')).text);
        if (s && s.length > 1) {
          const start = listedIso(c.listed);
          const base = start ? s.filter((p) => p.d >= start) : s;
          const clean = sanitizeSeries(base.length > 1 ? base : s);
          c.series = clean.s; c.priceSource = 'yahoo'; c.priceAdjusted = clean.adjustments || 0;
          continue;
        }
      }
    } catch { /* fall through */ }
    const fm = cachedFinmind(c.code);
    if (fm && fm.length > 1) { c.series = fm; c.priceSource = 'finmind'; }
  }
}
for (const c of universe) {
  if (!c.series || !c.series.length) c.series = [{ d: c.priceDate, c: c.price }];
  const last = c.series[c.series.length - 1];
  c.price = last.c;
  c.priceDate = last.d;
  c.marketCap = c.price * c.shares;
}
console.log(`  ${universe.filter((c) => c.series.length > 1).length} codes with a history`);

const prevOf = (s, i) => (i > 0 ? s[i - 1] : null);
const pointOnOrBefore = (s, d) => { let hit = null; for (const p of s) { if (p.d > d) break; hit = p; } return hit; };
for (const c of universe) {
  const s = c.series;
  const last = s[s.length - 1], prev = prevOf(s, s.length - 1);
  const six = pointOnOrBefore(s, iso(Date.parse(last.d) - 182 * DAY));
  const jan = s.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  c.chg1d = prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null;
  c.chg6m = six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null;
  c.chgYtd = jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null;
  const ye = {};
  for (const p of s) ye[p.d.slice(0, 4)] = p.c;
  c.yearEnd = ye;
}

// --- 4. financials from stockanalysis ------------------------------------------------------------
const MONTHLY = { '01': 31, '02': 28, '03': 31, '04': 30, '05': 31, '06': 30, '07': 31, '08': 31, '09': 30, '10': 31, '11': 30, '12': 31 };
const sa = (code, page, q = false) => `https://stockanalysis.com/quote/tpe/${code}/financials/${page}/${q ? '?p=quarterly' : ''}`;
const scale = (v, isPerShare = false) => (v == null ? null : (isPerShare ? v : v * 1e6));

function incomeOf(html) {
  const t = parseSaTable(html);
  const ttmCol = t.cols.find((c) => c.id === 'TTM');
  const ttmId = ttmCol && ttmCol.id;
  const ttmEnd = periodFromTitle(ttmCol && ttmCol.title);
  const ann = t.cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id));
  const get = (row, id) => (row ? row.values[id] : null);
  const rev = rowOf(t, ['Revenue', 'Total Revenue']);
  const op = rowOf(t, ['Operating Income']);
  const ni = rowOf(t, ['Net Income to Common', 'Net Income']);
  const eps = rowOf(t, ['EPS (Diluted)', 'EPS (Basic)']);
  return {
    ttmEnd,
    ttm: ttmId ? {
      revenue: scale(get(rev, ttmId)), operatingProfit: scale(get(op, ttmId)),
      netIncome: scale(get(ni, ttmId)), eps: scale(get(eps, ttmId), true),
    } : null,
    annual: ann.map((c) => ({
      end: c.id, revenue: scale(get(rev, c.id)), operatingProfit: scale(get(op, c.id)),
      netIncome: scale(get(ni, c.id)), eps: scale(get(eps, c.id), true),
    })),
  };
}
function balanceOf(html) {
  const t = parseSaTable(html);
  const ttmCol = t.cols.find((c) => c.id === 'TTM') || t.cols[0];
  const ttmId = ttmCol && ttmCol.id;
  const ttmEnd = periodFromTitle(ttmCol && ttmCol.title);
  const ann = t.cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id));
  const get = (row, id) => (row ? row.values[id] : null);
  const a = rowOf(t, ['Total Assets']);
  const l = rowOf(t, ['Total Liabilities']);
  const e = rowOf(t, ['Total Equity', 'Total Stockholders Equity', "Shareholders' Equity", 'Total Common Equity']);
  return {
    ttmEnd,
    latest: ttmId ? { assets: scale(get(a, ttmId)), liabilities: scale(get(l, ttmId)), equity: scale(get(e, ttmId)) } : null,
    annual: ann.map((c) => ({ end: c.id, assets: scale(get(a, c.id)), liabilities: scale(get(l, c.id)), equity: scale(get(e, c.id)) })),
  };
}
function cashOf(html) {
  const t = parseSaTable(html);
  const ttmCol = t.cols.find((c) => c.id === 'TTM');
  const ttmId = ttmCol && ttmCol.id;
  const ttmEnd = periodFromTitle(ttmCol && ttmCol.title);
  const ann = t.cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id));
  const get = (row, id) => (row ? row.values[id] : null);
  const cfo = rowOf(t, ['Operating Cash Flow']);
  const cfi = rowOf(t, ['Investing Cash Flow']);
  const fcf = rowOf(t, ['Free Cash Flow']);
  return {
    ttmEnd,
    ttm: ttmId ? {
      operatingCashFlow: scale(get(cfo, ttmId)), investingCashFlow: scale(get(cfi, ttmId)), freeCashFlow: scale(get(fcf, ttmId)),
    } : null,
    annual: ann.map((c) => ({
      end: c.id, operatingCashFlow: scale(get(cfo, c.id)), investingCashFlow: scale(get(cfi, c.id)), freeCashFlow: scale(get(fcf, c.id)),
    })),
  };
}
function quartersOf(html) {
  const t = parseSaTable(html);
  const rev = rowOf(t, ['Revenue', 'Total Revenue']);
  const op = rowOf(t, ['Operating Income']);
  const ni = rowOf(t, ['Net Income to Common', 'Net Income']);
  const cols = t.cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id)).slice(0, 8).reverse();
  return cols.map((c) => ({
    d: c.id, revenue: scale(rev && rev.values[c.id]), operatingProfit: scale(op && op.values[c.id]), netIncome: scale(ni && ni.values[c.id]),
  }));
}
async function page(code, p, q = false) {
  const f = join(SA_CACHE, `${code}-${p}${q ? '-q' : ''}.json`);
  try {
    return await getCached(sa(code, p, q), f, { ttlMs: q ? TTL_Q : TTL_FIN, timeout: 30000, retries: 5 });
  } catch { return null; }   // throttled: this company is retried on the next build
}

if (!SKIP_FIN) {
  console.log('financials…');  let done = 0, miss = 0;
  // All four statement pages per company are disk-cached; when the price cache is warm there is no
  // network left, so parse several companies at once. A fresh build keeps the gentle 2-company pace.
  const finWorkers = Number(arg('fin-workers', SKIP_PRICES ? 8 : 2)) || (SKIP_PRICES ? 8 : 2);
  await pool(universe, finWorkers, async (c) => {
    try {
      const [inc, bal, csh, qinc] = await Promise.all([
        page(c.code, 'income-statement'), page(c.code, 'balance-sheet'),
        page(c.code, 'cash-flow-statement'), page(c.code, 'income-statement', true),
      ]);
      const I = incomeOf(inc), B = balanceOf(bal), C = cashOf(csh);
      const annual = new Map();
      const add = (end, obj) => { if (!annual.has(end)) annual.set(end, { end }); Object.assign(annual.get(end), obj); };
      for (const r of I.annual) add(r.end, r);
      for (const r of B.annual) add(r.end, r);
      for (const r of C.annual) add(r.end, r);
      c.ttm = { ...(I.ttm || {}), ...(C.ttm || {}) };
      c.ttmEnd = I.ttmEnd || C.ttmEnd || null;
      c.latest = B.latest || {};
      c.latestEnd = B.ttmEnd || null;
      c.annual = [...annual.values()].filter((r) => r.revenue != null || r.equity != null).sort((a, b) => a.end.localeCompare(b.end));
      c.quarters = quartersOf(qinc);
    } catch (e) {
      miss++;
      c.ttm = null; c.latest = {}; c.annual = []; c.quarters = [];
    }
    if (++done % 25 === 0) console.log(`  ${done}/${universe.length} companies`);
    await sleep(180);
  });
  console.log(`  ${universe.length - miss} with statements · ${miss} missing`);
} else {
  // A profile-attach rebuild reuses the statements already in the file: no page is fetched, and the
  // ratios are still derived here so they stay consistent with the current price.
  const prevBy = new Map(((readJson(OUT) || {}).companies || []).map((c) => [c.code, c]));
  for (const c of universe) {
    const p = prevBy.get(c.code);
    if (!p) continue;
    c.ttm = (p.reports && p.reports.ttm) || null;
    c.latest = (p.reports && p.reports.latest) || {};
    c.annual = (p.reports && p.reports.annual) || [];
    c.quarters = (p.reports && p.reports.quarters) || p.quarters || [];
    c.ttmEnd = (p.reports && p.reports.ttmEnd) || p.ttmEnd || null;
    c.latestEnd = (p.reports && p.reports.latestEnd) || p.latestEnd || null;
  }
}

// --- 5. TAIEX and USD/TWD ------------------------------------------------------------------------
// TWSE's monthly market report carries the official TAIEX close for every session, one small request
// per month, and it is not behind the WAF that blocks the old daily endpoint.
const rocSlash = (s) => { const m = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(s || '')); return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : null; };
const taiexMap = new Map();
{
  const from = new Date(Date.now() - YEARS * 365 * DAY);
  const now = new Date();
  for (let y = from.getUTCFullYear(), m = from.getUTCMonth(); y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth()); m++) {
    if (m > 11) { m = 0; y++; }
    const mm = String(m + 1).padStart(2, '0');
    const key = `${y}${mm}`;
    const cur = key === `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const f = join(TW_CACHE, `fmtqik-${key}.json`);
    try {
      const text = await getCached(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${key}01&response=json`, f, { ttlMs: cur ? 3600e3 : 30 * DAY, retries: 3 });
      const j = JSON.parse(text);
      if (j.stat === 'OK' && Array.isArray(j.data)) {
        for (const row of j.data) {
          const d = rocSlash(row[0]);
          const c = Number(String(row[4] || '').replace(/,/g, ''));
          if (d && Number.isFinite(c) && c > 0) taiexMap.set(d, c);
        }
      }
    } catch { /* a missing month is skipped, not fatal */ }
    await sleep(120);
  }
}
const taiex = [...taiexMap.entries()].map(([d, c]) => ({ d, c })).sort((a, b) => a.d.localeCompare(b.d));

let fxRate = null;
try {
  const f = join(TW_CACHE, 'usdtwd.json');
  const text = await getCached('https://open.er-api.com/v6/latest/USD', f, { ttlMs: TTL_DAY, retries: 3 });
  const j = JSON.parse(text);
  fxRate = j && j.rates && Number(j.rates.TWD) ? +Number(j.rates.TWD).toFixed(3) : null;
} catch { fxRate = null; }

const idx = taiex.length ? (() => {
  const last = taiex[taiex.length - 1], prev = taiex[taiex.length - 2];
  const six = pointOnOrBefore(taiex, iso(Date.parse(last.d) - 182 * DAY));
  const jan = taiex.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  return {
    level: last.c, date: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null,
    series: taiex.slice(-1300),
  };
})() : null;

// --- 6. derive -----------------------------------------------------------------------------------
const val = (code) => valBy.get(code) || {};
const finite = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? +n.toFixed(2) : null; };
for (const c of universe) {
  const v = val(c.code);
  c.dividendYield = finite(v.DividendYield);
  c.twsePe = finite(v.PEratio);
  c.twsePb = finite(v.PBratio);
}
let out = deriveTaiwan({ companies: universe, fx: fxRate });

// --- 7. English names + descriptions -------------------------------------------------------------
const profiles = readJson(PROFILES) || { entries: {} };
let withDesc = 0;
for (const c of out) {
  const p = profiles.entries && profiles.entries[c.code];
  c.nameEn = (p && p.name) || c.abbr || null;
  c.nameFull = (p && p.legal) || null;
  c.description = (p && p.desc) || null;
  if (c.description) withDesc++;
}

// --- 8. market aggregates + themes ---------------------------------------------------------------
const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
};
const market = {
  companies: out.length,
  totalCap: out.reduce((a, c) => a + (c.marketCap || 0), 0),
  medianPe: median(out.map((c) => c.pe)),
  medianPb: median(out.map((c) => c.pb)),
  medianRoe: median(out.map((c) => c.roe)),
  medianYield: median(out.map((c) => c.dividendYield)),
  belowBook: out.filter((c) => c.pb != null && c.pb < 1).length,
  advancing: out.filter((c) => (c.chg1d || 0) > 0).length,
  declining: out.filter((c) => (c.chg1d || 0) < 0).length,
  upYtd: out.filter((c) => (c.chgYtd || 0) > 0).length,
  sectors: [...out.reduce((m, c) => m.set(c.sector, [...(m.get(c.sector) || []), c]), new Map())]
    .map(([name, list]) => ({
      name, count: list.length,
      cap: list.reduce((a, c) => a + (c.marketCap || 0), 0),
      pe: median(list.map((c) => c.pe)), pb: median(list.map((c) => c.pb)),
      roe: median(list.map((c) => c.roe)), yield: median(list.map((c) => c.dividendYield)),
      chgYtd: median(list.map((c) => c.chgYtd)),
    })).sort((a, b) => b.cap - a.cap),
};
const themeBook = readJson(THEMES) || { themes: [] };
const have = new Set(out.map((c) => c.ticker));
const themes = (themeBook.themes || []).map((t) => ({
  id: t.id, label: t.label, kind: t.kind, note: t.note,
  tickers: (t.tickers || []).filter((x) => have.has(x)),
}));

// --- 9. write ------------------------------------------------------------------------------------
out.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
const series = { daily: {}, weekly: {} };
for (const c of out) {
  const s = c.series || [];
  series.daily[c.code] = s.slice(-400);
  const w = [];
  for (let i = s.length - 1; i >= 0; i -= 5) w.push(s[i]);
  series.weekly[c.code] = w.reverse();
  delete c.series;
}
const cleaned = out.map((c) => {
  const { series, yearEnd, ttm, latest, annual, quarters, ...rest } = c;
  return { ...rest, reports: { ttm, latest, annual, quarters, ttmEnd: c.ttmEnd || null, latestEnd: c.latestEnd || null }, history: c.history || [], quarters };
});

// Audit counts: computed vs the exchange's own P/E and P/B.
const chk = cleaned.filter((c) => c.pe != null && c.twsePe != null);
const peDiff = chk.filter((c) => Math.abs(c.pe - c.twsePe) / c.twsePe > 0.15).length;
const chkPb = cleaned.filter((c) => c.pb != null && c.twsePb != null);
const pbDiff = chkPb.filter((c) => Math.abs(c.pb - c.twsePb) / c.twsePb > 0.15).length;

writeJson(`${OUT}.tmp`, {
  updated: new Date().toISOString(),
  universe: `TWSE · ${cleaned.length} listed companies`,
  currency: 'TWD',
  fx: { pair: 'USDTWD', rate: fxRate, date: iso(Date.now()) },
  market, index: idx, themes,
  audit: { peCompared: chk.length, peOff15: peDiff, pbCompared: chkPb.length, pbOff15: pbDiff },
  companies: cleaned,
});
renameSync(`${OUT}.tmp`, OUT);
// Ten small buckets by the first digit of the code, not one 23 MB file: the free instance must not
// parse every company's history to draw one chart.
mkdirSync(SERIES_DIR, { recursive: true });
const bucketBook = {};
for (const kind of ['daily', 'weekly']) {
  for (const [code, arr] of Object.entries(series[kind])) {
    const b = String(code)[0];
    if (!/^[0-9]$/.test(b)) continue;
    (bucketBook[b] = bucketBook[b] || { daily: {}, weekly: {} })[kind][code] = arr;
  }
}
const seriesStamp = new Date().toISOString();
for (const [b, obj] of Object.entries(bucketBook)) {
  const f = join(SERIES_DIR, `${b}.json`);
  writeJson(`${f}.tmp`, { updated: seriesStamp, ...obj });
  renameSync(`${f}.tmp`, f);
}

// compact list payload
try {
  const { taiwanList } = await import('../src/project.js');
  const list = taiwanList({ ...JSON.parse(readFileSync(OUT, 'utf8')) });
  writeFileSync(`${LIST_OUT}.tmp`, JSON.stringify(list)); renameSync(`${LIST_OUT}.tmp`, LIST_OUT);
} catch (e) { console.log(`  list artifact: ${e.message}`); }

// Re-index the per-company chart store so a chart never has to parse a whole bucket again.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'tw'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }

// Curated brands are not in the exchange feed; attach them after every rebuild so search keeps
// resolving "TSMC" or "Giant" to the listed company instead of losing the tags.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'attach-market-brands.mjs'), 'tw'], { stdio: 'inherit' }); }
catch (e) { console.log(`  brands: ${e.message}`); }

console.log(`${cleaned.length} companies · ${cleaned.filter((c) => c.pe != null).length} P/E · ${withDesc} descriptions · TAIEX ${idx ? idx.level : '—'} · FX ${fxRate}`);
console.log(`audit: P/E ${peDiff}/${chk.length} off >15% · P/B ${pbDiff}/${chkPb.length} off >15%`);
console.log(cleaned.slice(0, 5).map((c) => `  ${c.code} ${c.nameEn || c.name} · NT$${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'}`).join('\n'));
