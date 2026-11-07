// Build the Brazil dataset: every B3 operating company, one share class per issuer.
//
//   node scripts/build-brazil.mjs                          full run
//   node scripts/build-brazil.mjs --limit=30               smoke test (largest issuer groups)
//   node scripts/build-brazil.mjs --codes=PETR4,VALE3      named classes
//   node scripts/build-brazil.mjs --skip-prices            reuse cached prices
//   node scripts/build-brazil.mjs --skip-fin               reuse statements
//   node scripts/build-brazil.mjs --prices-only            warm Yahoo and stop
//
// Sources:
//   - stockanalysis.com B3 exchange list: every listed line; BDRs (31–39) and FII/funds are excluded by
//     the universe step. One class per issuer is selected (PETR4 is covered; PETR3 is not).
//   - Yahoo (.SA, ^BVSP): five years of daily closes and volume.
//   - stockanalysis.com (BVMF): statements, TTM, shares, dividend yield, GICS sector/profile.
//   - open.er-api.com: USD/BRL.
//
// The vendor's market cap is the COMPANY total, repeated on every class line. The selected class keeps
// that one company cap; classes are never summed, and the cap is not re-derived from the class price.

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { join } from 'node:path';
import {
  ROOT, BR_CACHE, BR_SA, b3Universe, readUniverseSnapshot, writeUniverseSnapshot, baseOf, classLabel,
  pad, saPage, saProfile, yaSymbol, INDEX_SYMBOL, isFinancialSector, isBankLike,
} from './b3.mjs';
import { sleep, readJson, writeJson, getCached, parseSaTable, rowOf, periodFromTitle, statementCurrency } from './stockanalysis.mjs';
import { deriveListing } from './derive-listing.mjs';

const OUT = join(ROOT, 'data', 'brazil.json');
const SERIES_DIR = join(ROOT, 'data', 'brazil-series');
const LIST_OUT = join(ROOT, 'data', 'brazil-list.json');
const DETAIL_DIR = join(ROOT, 'data', 'brazil-companies');
const PROFILES = join(ROOT, 'data', 'brazil-profiles.json');
const THEMES = join(ROOT, 'data', 'brazil-themes.json');
const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const arg = (k, d = null) => { const x = process.argv.find((a) => a.startsWith(`--${k}=`)); return x ? x.split('=')[1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);

const LIMIT = Number(arg('limit', 0)) || 0;
const CODES = (arg('codes', '') || '').split(',').map((s) => pad(s)).filter(Boolean);
const YEARS = Number(arg('years', 5)) || 5;
const SKIP_PRICES = flag('skip-prices');
const SKIP_FIN = flag('skip-fin');
const PRICES_ONLY = flag('prices-only');
const TTL_DAY = 6 * 3600e3;
const TTL_FIN = 7 * DAY;
const TTL_Q = 1 * DAY;
const PACE = Number(arg('pace', 150)) || 150;

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const at = i++; out[at] = await fn(items[at], at); }
  });
  await Promise.all(workers);
  return out;
}

// --- 1. universe and class selection --------------------------------------------------------------
console.log('B3 exchange list…');
let uni = null;
try {
  uni = await b3Universe({ fresh: flag('fresh') });
  writeUniverseSnapshot(uni.rows, { quoted: uni.quoted, excludedBdr: uni.excludedBdr, excludedFunds: uni.excludedFunds, pages: uni.pages });
  console.log(`  ${uni.quoted} rows · ${uni.excludedBdr} BDRs · ${uni.excludedFunds} FII/funds excluded · ${uni.rows.length} class lines`);
} catch (e) {
  const snap = readUniverseSnapshot();
  if (!snap) throw e;
  uni = { rows: snap.rows, excludedBdr: snap.excludedBdr || 0, excludedFunds: snap.excludedFunds || 0, quoted: snap.quoted || snap.count, pages: 0, stale: true };
  console.log(`  list unavailable (${e.message}) — using the committed snapshot from ${String(snap.updated).slice(0, 10)}`);
}

const groups = new Map();
for (const r of uni.rows) {
  const b = baseOf(r.code);
  if (!groups.has(b)) groups.set(b, []);
  groups.get(b).push(r);
}
let groupList = [...groups.values()];
if (CODES.length) groupList = groupList.filter((g) => g.some((r) => CODES.includes(r.code)));
else if (LIMIT) groupList = groupList.slice(0, LIMIT);

async function page(code, p, q = false) {
  const f = join(BR_SA, `${code.replace(/[^\w-]/g, '_')}-${p}${q ? '-q' : ''}.json`);
  return getCached(saPage(code, p, q), f, { ttlMs: q ? TTL_Q : TTL_FIN, timeout: 30000, retries: 6 });
}
const hasData = (html) => {
  try {
    const t = parseSaTable(html);
    return t.rows.some((r) => /^(Revenue|Net Income)/.test(r.label)
      && Object.values(r.values).some((v) => v != null));
  } catch { return false; }
};

console.log(`  ${groupList.length} issuer groups · selecting the covered class…`);
const selected = [];
const noClass = [];
let selDone = 0;
for (const cands of groupList) {
  cands.sort((a, b) => (b.vendorCap || 0) - (a.vendorCap || 0));
  const order = CODES.length
    ? [...cands].sort((a, b) => (CODES.includes(a.code) ? -1 : 0) - (CODES.includes(b.code) ? -1 : 0))
    : cands;
  let pick = null;
  for (const cand of order.slice(0, 4)) {
    let html = null;
    try { html = await page(cand.code, 'income-statement'); } catch { /* throttled; try next */ }
    if (html && hasData(html)) { pick = cand; break; }
  }
  if (pick) {
    selected.push({
      ...pick,
      code: pad(pick.code), ticker: pad(pick.code), base: baseOf(pick.code),
      shareClass: classLabel(pick.code), multiClass: cands.length > 1,
    });
  } else noClass.push({ base: baseOf(cands[0].code), codes: cands.map((c) => c.code) });
  if (++selDone % 50 === 0) console.log(`  ${selDone}/${groupList.length} groups`);
  await sleep(60);
}
console.log(`  ${selected.length} companies with a covered class · ${noClass.length} without a statement page`);

let universe = selected;
if (CODES.length) universe = selected.filter((c) => CODES.includes(c.code));
if (LIMIT && CODES.length) universe = selected;

// --- 2. Yahoo price history -----------------------------------------------------------------------
const YH_CACHE = join(BR_CACHE, 'yahoo');
mkdirSync(YH_CACHE, { recursive: true });
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
async function yahooSeries(symbol, range = `${YEARS}y`) {
  const f = join(YH_CACHE, `${symbol.replace(/[^\w.-]/g, '_')}.json`);
  if (existsSync(f)) {
    try {
      const hit = JSON.parse(readFileSync(f, 'utf8'));
      if (hit.fetched && Date.now() - Date.parse(hit.fetched) < 6 * 3600e3) {
        const s = hit.text ? JSON.parse(hit.text) : null;
        if (s && (!s.length || s[0].v !== undefined)) return s;
      }
    } catch { /* refetch */ }
  }
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (yahooUntil > Date.now()) await sleep(Math.min(30000, yahooUntil - Date.now()));
    const r = await httpsGet(url);
    if (r.status === 404) return [];
    if (r.status === 429) { yahooUntil = Date.now() + 60e3; await sleep(5000 * (attempt + 1)); continue; }
    if (r.status !== 200 || !r.text) { await sleep(1000 * (attempt + 1)); continue; }
    try {
      const j = JSON.parse(r.text);
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) return [];
      const ts = res.timestamp || [];
      const q = res.indicators.quote[0] || {};
      const closes = q.close || [];
      const vols = q.volume || [];
      const s = ts.map((t, i) => ({ d: iso(t * 1000), c: closes[i], v: vols[i] })).filter((p) => p.c != null && p.c > 0);
      if (!s.length) return [];
      writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), text: JSON.stringify(s) }));
      return s;
    } catch { await sleep(800); }
  }
  // Keep the company on a throttled refetch: fall back to the last cached series.
  try {
    const hit = JSON.parse(readFileSync(f, 'utf8'));
    const s = hit.text ? JSON.parse(hit.text) : null;
    if (s && s.length) return s;
  } catch { /* no cache */ }
  return [];
}

function sanitizeSeries(s) {
  const byDate = new Map();
  for (const p of s) byDate.set(p.d, p);
  const arr = [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d));
  let fixed = 0;
  for (let i = 1; i < arr.length - 1; i++) {
    const pre = arr[i - 1].c;
    if (Math.abs(arr[i].c / pre - 1) < 0.6) continue;
    let reverses = false;
    for (let j = i + 1; j <= Math.min(i + 3, arr.length - 1); j++) {
      if (Math.abs(arr[j].c / pre - 1) < 0.2) { reverses = true; break; }
    }
    if (reverses) { arr[i].c = pre; fixed++; }
  }
  return { s: arr, adjustments: fixed };
}

if (!SKIP_PRICES) {
  console.log(`prices… ${universe.length} classes, ${YEARS}y daily (Yahoo)`);
  let done = 0;
  await pool(universe, Number(arg('price-workers', 3)) || 3, async (c) => {
    const raw = await yahooSeries(yaSymbol(c.code));
    if (raw.length > 1) {
      const clean = sanitizeSeries(raw);
      c.series = clean.s;
      c.priceSource = 'yahoo';
      c.priceAdjusted = clean.adjustments || 0;
    }
    if (++done % 100 === 0) console.log(`  ${done}/${universe.length} symbols`);
    await sleep(120);
  });
} else {
  for (const c of universe) {
    try {
      const f = join(YH_CACHE, `${yaSymbol(c.code).replace(/[^\w.-]/g, '_')}.json`);
      if (existsSync(f)) {
        const s = JSON.parse(JSON.parse(readFileSync(f, 'utf8')).text);
        if (s && s.length > 1) {
          const clean = sanitizeSeries(s);
          c.series = clean.s; c.priceSource = 'yahoo'; c.priceAdjusted = clean.adjustments || 0;
        }
      }
    } catch { /* fall through */ }
  }
}
for (const c of universe) {
  if (!c.series || !c.series.length) continue;
  const last = c.series[c.series.length - 1];
  if (!(last && last.c > 0)) continue;
  c.price = +last.c.toFixed(3);
  c.priceDate = last.d;
}
console.log(`  ${universe.filter((c) => c.series && c.series.length > 1).length} with a history · ${universe.filter((c) => c.price > 0).length} priced`);
if (PRICES_ONLY) { console.log('prices cached — stopping (--prices-only)'); process.exit(0); }

const pointOnOrBefore = (s, d) => { let hit = null; for (const p of s) { if (p.d > d) break; hit = p; } return hit; };
for (const c of universe) {
  const s = c.series || [];
  if (s.length < 2) continue;
  const last = s[s.length - 1], prev = s[s.length - 2];
  const six = pointOnOrBefore(s, iso(Date.parse(last.d) - 182 * DAY));
  const jan = s.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  c.chg1d = prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null;
  c.chg6m = six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null;
  c.chgYtd = jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null;
  const ye = {};
  for (const p of s) ye[p.d.slice(0, 4)] = p.c;
  c.yearEnd = ye;
}

// --- 3. financials ---------------------------------------------------------------------------------
const scale = (v) => (v == null ? null : v * 1e6);
const perShare = (v) => (v == null ? null : v);
function incomeOf(html) {
  const t = parseSaTable(html);
  const ttmCol = t.cols.find((c) => c.id === 'TTM');
  const ttmId = ttmCol && ttmCol.id;
  const ttmEnd = periodFromTitle(ttmCol && ttmCol.title);
  const ann = t.cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id));
  const get = (row, id) => (row ? row.values[id] : null);
  const rev = rowOf(t, ['Revenue', 'Total Revenue', 'Operating Revenue']);
  const op = rowOf(t, ['Operating Income']);
  const ni = rowOf(t, ['Net Income to Common', 'Net Income']);
  const eps = rowOf(t, ['EPS (Diluted)', 'EPS (Basic)']);
  const sh = rowOf(t, ['Shares Outstanding (Diluted)', 'Diluted Shares Outstanding', 'Shares Outstanding (Basic)', 'Basic Shares Outstanding', 'Shares Outstanding']);
  const dps = rowOf(t, ['Dividend Per Share']);
  return {
    ttmEnd, currency: statementCurrency(html),
    ttm: ttmId ? {
      revenue: scale(get(rev, ttmId)), operatingProfit: scale(get(op, ttmId)),
      netIncome: scale(get(ni, ttmId)), eps: perShare(get(eps, ttmId)),
      shares: scale(get(sh, ttmId)), dividendPerShare: perShare(get(dps, ttmId)),
    } : null,
    annual: ann.map((c) => ({
      end: c.id, revenue: scale(get(rev, c.id)), operatingProfit: scale(get(op, c.id)),
      netIncome: scale(get(ni, c.id)), eps: perShare(get(eps, c.id)),
      shares: scale(get(sh, c.id)), dividendPerShare: perShare(get(dps, c.id)),
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
  const et = rowOf(t, ['Total Equity', "Shareholders' Equity", 'Total Stockholders Equity']);
  const ec = rowOf(t, ['Total Common Equity', 'Total Stockholders Equity', 'Stockholders Equity', 'Common Equity', 'Total Equity', "Shareholders' Equity"]);
  return {
    ttmEnd,
    latest: ttmId ? {
      assets: scale(get(a, ttmId)), liabilities: scale(get(l, ttmId)),
      equity: scale(get(et || ec, ttmId)), equityCommon: scale(get(ec || et, ttmId)),
    } : null,
    annual: ann.map((c) => ({
      end: c.id, assets: scale(get(a, c.id)), liabilities: scale(get(l, c.id)),
      equity: scale(get(et || ec, c.id)), equityCommon: scale(get(ec || et, c.id)),
    })),
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
  const capex = rowOf(t, ['Capital Expenditures', 'Capital Expenditure']);
  return {
    ttmEnd,
    ttm: ttmId ? {
      operatingCashFlow: scale(get(cfo, ttmId)), investingCashFlow: scale(get(cfi, ttmId)),
      capitalExpenditure: scale(get(capex, ttmId)), freeCashFlow: scale(get(fcf, ttmId)),
    } : null,
    annual: ann.map((c) => ({
      end: c.id, operatingCashFlow: scale(get(cfo, c.id)), investingCashFlow: scale(get(cfi, c.id)),
      capitalExpenditure: scale(get(capex, c.id)), freeCashFlow: scale(get(fcf, c.id)),
    })),
  };
}
function quartersOf(html) {
  const t = parseSaTable(html);
  const rev = rowOf(t, ['Revenue', 'Total Revenue', 'Operating Revenue']);
  const op = rowOf(t, ['Operating Income']);
  const ni = rowOf(t, ['Net Income to Common', 'Net Income']);
  const cols = t.cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id)).slice(0, 8).reverse();
  return cols.map((c) => ({
    d: c.id, revenue: scale(rev && rev.values[c.id]), operatingProfit: scale(op && op.values[c.id]), netIncome: scale(ni && ni.values[c.id]),
  }));
}

if (!SKIP_FIN) {
  console.log('financials…'); let done = 0, miss = 0;
  await pool(universe, Number(arg('fin-workers', SKIP_PRICES ? 6 : 2)) || (SKIP_PRICES ? 6 : 2), async (c) => {
    try {
      const inc = await page(c.code, 'income-statement');
      const bal = await page(c.code, 'balance-sheet');
      const csh = await page(c.code, 'cash-flow-statement');
      const qtr = await page(c.code, 'income-statement', true);
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
      c.quarters = quartersOf(qtr);
      c.reportCurrency = I.currency || 'BRL';
      c.shares = (I.ttm && I.ttm.shares) || (c.annual.length ? c.annual[c.annual.length - 1].shares : null) || null;
    } catch (e) {
      if (e && e.throttled) { c.throttled = true; await sleep(60000); } else miss++;
      c.ttm = null; c.latest = {}; c.annual = []; c.quarters = []; c.shares = null;
    }
    if (++done % 25 === 0) console.log(`  ${done}/${universe.length} companies`);
    await sleep(PACE);
  });
  console.log(`  ${universe.length - miss} with statements · ${miss} missing`);
} else {
  const prevBy = new Map(((readJson(OUT) || {}).companies || []).map((c) => [c.code, c]));
  const prevDoc = readJson(OUT) || {};
  for (const c of universe) {
    const p = prevBy.get(c.code);
    if (!p) { c.noPrev = true; continue; }
    c.ttm = (p.reports && p.reports.ttm) || null;
    c.latest = (p.reports && p.reports.latest) || {};
    c.annual = (p.reports && p.reports.annual) || [];
    c.quarters = (p.reports && p.reports.quarters) || [];
    c.ttmEnd = (p.reports && p.reports.ttmEnd) || null;
    c.latestEnd = (p.reports && p.reports.latestEnd) || null;
    c.reportCurrency = p.reportCurrency || 'BRL';
    c.shares = p.shares || null;
    c.marketCap = p.marketCap || null;
  }
}

const broken = universe.filter((c) => {
  const t = c.ttm || {};
  return t.revenue > 0 && t.operatingProfit > t.revenue * 1.05;
});
for (const c of broken) c.broken = true;

const STALE_DAYS = 450;
const SESSION_DATE = universe.map((c) => c.priceDate).filter(Boolean).sort().pop() || iso(Date.now());
const lastEndOf = (c) => c.ttmEnd || c.latestEnd || (c.annual && c.annual.length ? c.annual[c.annual.length - 1].end : null);
const avgOver = (s, n, value) => {
  const win = (s || []).slice(-n).filter((p) => p.v != null && Number.isFinite(p.v) && p.v > 0 && p.c > 0);
  if (!win.length) return null;
  const xs = win.map((p) => (value ? p.c * p.v : p.v));
  return xs.reduce((a, b) => a + b, 0) / xs.length;
};
const flatOf = (s) => {
  const win = (s || []).slice(-250);
  if (win.length < 2) return null;
  let same = 0;
  for (let i = 1; i < win.length; i++) if (win[i].c === win[i - 1].c) same++;
  return Math.round((same / (win.length - 1)) * 100);
};
for (const c of universe) {
  c.flatPct = flatOf(c.series);
  c.noRecentTrading = c.flatPct != null && c.flatPct >= 90;
  c.shortHistory = !!c.series && c.series.length > 0 && c.series.length < 100;
  c.avgVolume30 = avgOver(c.series, 30, false);
  c.avgValue30 = avgOver(c.series, 30, true);
  // R$ 1M/day is a low floor for B3; below it a name is not investable at any size.
  c.thinTrading = c.avgValue30 != null && c.avgValue30 < 1e6;
  const end = lastEndOf(c);
  c.ttmAgeDays = end ? Math.round((Date.parse(SESSION_DATE) - Date.parse(end)) / DAY) : null;
  c.ttmStale = c.ttmAgeDays != null && c.ttmAgeDays > 365;
  if (c.noRecentTrading) { c.chg1d = null; c.chg6m = null; c.chgYtd = null; }
}
const stale = universe.filter((c) => {
  const end = lastEndOf(c);
  return end && (Date.parse(SESSION_DATE) - Date.parse(end)) / DAY > STALE_DAYS;
});
for (const c of stale) c.stale = true;

const SHARES = (readJson(join(ROOT, 'data', 'brazil-shares.json')) || {}).entries || {};
const hasStatements = (c) => !!((c.ttm && (c.ttm.netIncome != null || c.ttm.revenue != null)) || (c.annual && c.annual.length));
const hasShares = (c) => c.shares > 0 || (SHARES[c.code] && SHARES[c.code].shares > 0);
const throttled = universe.filter((c) => c.throttled);
const covered = universe.filter((c) => !c.noPrev && hasStatements(c) && hasShares(c) && c.price > 0 && !c.broken && !c.stale);
const noShares = universe.filter((c) => !c.noPrev && hasStatements(c) && !hasShares(c) && c.price > 0 && !c.broken && !c.stale);
const dropped = universe.filter((c) => !c.throttled && !c.broken && !c.stale && !c.noPrev && !hasStatements(c)).map((c) => ({ code: c.code, name: c.name }));
const noPrice = universe.filter((c) => !c.throttled && !c.broken && !c.stale && !c.noPrev && hasStatements(c) && hasShares(c) && !(c.price > 0)).map((c) => ({ code: c.code, name: c.name }));
if (stale.length) console.log(`  ${stale.length} companies with statements older than ${STALE_DAYS} days — excluded`);
if (dropped.length) console.log(`  ${dropped.length} without a statement page`);
if (noShares.length) console.log(`  ${noShares.length} without a defensible share count — excluded`);
if (noPrice.length) console.log(`  ${noPrice.length} without a price`);
if (throttled.length) console.log(`  ${throttled.length} throttled — rerun`);

let currentShares = 0;
for (const c of covered) {
  const s = SHARES[c.code];
  c.sharesBasis = 'filing (diluted weighted average)';
  if (s && s.shares > 0) {
    c.sharesCurrent = s.shares;
    c.sharesBasis = 'current (stockanalysis.com)';
    currentShares++;
  }
  if (s && Number.isFinite(s.yield) && s.yield >= 0 && s.yield < 30) c.vendorDividendYield = s.yield;
  // The vendor list cap is the COMPANY total on every class line. Use it, never price × class shares.
  if (c.vendorCap > 0) c.marketCap = c.vendorCap;
  else if (s && s.marketCap > 0) c.marketCap = s.marketCap;
}
if (currentShares) console.log(`  ${currentShares} on a current share count`);

let fx = { pair: 'USDBRL', rate: null, date: iso(Date.now()), rates: null };
try {
  const f = join(BR_CACHE, 'er-usd.json');
  const text = await getCached('https://open.er-api.com/v6/latest/USD', f, { ttlMs: TTL_DAY, retries: 3 });
  const j = JSON.parse(text);
  const rates = j && j.rates ? Object.fromEntries(Object.entries(j.rates).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) : null;
  if (rates && rates.BRL > 0) fx = { pair: 'USDBRL', rate: +rates.BRL.toFixed(4), date: (j.time_last_update_utc ? iso(Date.parse(j.time_last_update_utc)) : iso(Date.now())), rates };
} catch { /* ratios blank */ }

const bvsp = (await yahooSeries(INDEX_SYMBOL, `${YEARS}y`)).slice(-1300);
const idx = bvsp.length > 1 ? (() => {
  const last = bvsp[bvsp.length - 1], prev = bvsp[bvsp.length - 2];
  const six = pointOnOrBefore(bvsp, iso(Date.parse(last.d) - 182 * DAY));
  const jan = bvsp.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  return {
    level: last.c, date: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null,
    series: bvsp,
  };
})() : null;

for (const c of covered) {
  for (const r of c.annual || []) {
    const p = pointOnOrBefore(c.series || [], r.end);
    if (p) r.px = p.c;
  }
}
let out = deriveListing({ companies: covered, fx, baseCurrency: 'BRL' });

const profiles = readJson(PROFILES) || { entries: {} };
let withDesc = 0;
for (const c of out) {
  const p = profiles.entries && profiles.entries[c.code];
  c.name = String(c.name || '').replace(/\s+/g, ' ').trim();
  c.nameEn = (p && p.name) || c.name;
  c.nameFull = (p && p.legal) || null;
  c.description = (p && p.desc) || null;
  c.sector = (p && p.sector) || 'Other';
  c.sectorSource = p && p.sector ? 'profile-gics-sector' : 'other';
  c.industry = (p && p.industry) || null;
  if (c.description) withDesc++;
}

let bankLike = 0;
const FCF_KEYS = ['fcf', 'fcfYield', 'fcfMargin', 'cashConversion', 'operatingCashFlow'];
for (const c of out) {
  c.financial = isFinancialSector(c.sector);
  c.bankLike = isBankLike(c);
  const na = [];
  if (c.financial) {
    na.push(...FCF_KEYS);
    c.fcf = null; c.fcfYield = null; c.fcfMargin = null; c.cashConversion = null;
  }
  if (c.bankLike) {
    bankLike++;
    na.push('opMargin', 'operatingProfit', 'evEbitda', 'currentRatio', 'debtEquity', 'roic', 'assetTurnover');
    c.opMargin = null;
  } else if (c.financial && c.opMargin == null) na.push('opMargin');
  if (na.length) c.naRatios = [...new Set(na)];
}

let withheld = 0;
for (const c of out) {
  const na = [];
  if (c.pe != null && c.pe < 0.5) { c.pe = null; na.push('pe'); }
  if (c.opMargin != null && Math.abs(c.opMargin) > 500) { c.opMargin = null; na.push('opMargin'); }
  if (c.netMargin != null && Math.abs(c.netMargin) > 500) { c.netMargin = null; na.push('netMargin'); }
  if (c.roe != null && Math.abs(c.roe) > 500) { c.roe = null; na.push('roe'); }
  if (na.length) { c.naRatios = [...new Set([...(c.naRatios || []), ...na])]; withheld++; }
}

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
  upYtd: out.filter((c) => c.chgYtd != null && c.chgYtd > 0).length,
  advancing: out.filter((c) => c.chg1d != null && c.chg1d > 0).length,
  declining: out.filter((c) => c.chg1d != null && c.chg1d < 0).length,
  foreignReporters: out.filter((c) => (c.reportCurrency || 'BRL') !== 'BRL').length,
  financials: out.filter((c) => c.financial).length,
  bankLike,
  multiClass: out.filter((c) => c.multiClass).length,
};
market.sectors = (() => {
  const by = new Map();
  for (const c of out) {
    if (!by.has(c.sector)) by.set(c.sector, []);
    by.get(c.sector).push(c);
  }
  return [...by.entries()].map(([name, list]) => ({
    name, count: list.length,
    cap: list.reduce((a, c) => a + (c.marketCap || 0), 0),
    pe: median(list.map((c) => c.pe)),
    pb: median(list.map((c) => c.pb)),
    roe: median(list.map((c) => c.roe)),
    yield: median(list.map((c) => c.dividendYield)),
    chgYtd: median(list.map((c) => c.chgYtd)),
  })).sort((a, b) => b.cap - a.cap);
})();

const themeBook = readJson(THEMES) || { themes: [] };
const known = new Set(out.map((c) => c.code));
const themes = (themeBook.themes || []).map((t) => ({
  ...t,
  tickers: (t.tickers || []).filter((x) => known.has(pad(x))).map(pad),
})).filter((t) => t.tickers.length);

out.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
const series = { daily: {}, weekly: {} };
for (const c of out) {
  const s = (c.series || []).map(({ d, c: close }) => ({ d, c: close }));
  series.daily[c.code] = s.slice(-400);
  const w = [];
  for (let i = s.length - 1; i >= 0; i -= 5) w.push(s[i]);
  series.weekly[c.code] = w.reverse();
  delete c.series;
}
const cleaned = out.map((c) => {
  const { series: _s, yearEnd, ttm, latest, annual, quarters, ...rest } = c;
  return { ...rest, reports: { ttm, latest, annual, quarters, ttmEnd: c.ttmEnd || null, latestEnd: c.latestEnd || null }, history: c.history || [], quarters };
});

const audit = {
  quoted: uni.quoted || 0,
  excludedBdr: uni.excludedBdr || 0,
  excludedFunds: uni.excludedFunds || 0,
  classLines: uni.rows.length,
  issuerGroups: groups.size,
  considered: universe.length,
  companies: cleaned.length,
  withStatements: cleaned.length,
  withoutStatements: dropped.length,
  noStatements: dropped.slice(0, 40),
  withoutShares: noShares.length,
  noShares: noShares.map((c) => ({ code: c.code, name: c.name })),
  withoutPrice: noPrice.length,
  noPrice: noPrice.slice(0, 40),
  noCoveredClass: noClass.slice(0, 40),
  throttled: throttled.length,
  stale: stale.length,
  staleCodes: stale.map((c) => ({ code: c.code, name: c.name, end: lastEndOf(c) })),
  broken: broken.length,
  brokenCodes: broken.map((c) => ({ code: c.code, name: c.name })),
  sectors: market.sectors.length,
  pe: cleaned.filter((c) => c.pe != null).length,
  pb: cleaned.filter((c) => c.pb != null).length,
  roe: cleaned.filter((c) => c.roe != null).length,
  dividendYield: cleaned.filter((c) => c.dividendYield != null).length,
  vendorYield: cleaned.filter((c) => c.dividendYieldBasis === 'vendor').length,
  currentShares: cleaned.filter((c) => c.sharesCurrent > 0).length,
  netProfitTTM: cleaned.filter((c) => c.netIncomeTTM != null).length,
  financials: cleaned.filter((c) => c.financial).length,
  bankLike: cleaned.filter((c) => c.bankLike).length,
  foreignReporters: cleaned.filter((c) => c.reportCurrency !== 'BRL').length,
  multiClass: cleaned.filter((c) => c.multiClass).length,
  noRecentTrading: cleaned.filter((c) => c.noRecentTrading).length,
  noRecentTradingCodes: cleaned.filter((c) => c.noRecentTrading).map((c) => c.code),
  shortHistory: cleaned.filter((c) => c.shortHistory).length,
  shortHistoryCodes: cleaned.filter((c) => c.shortHistory).map((c) => c.code),
  ttmStale: cleaned.filter((c) => c.ttmStale).length,
  ttmStaleCodes: cleaned.filter((c) => c.ttmStale).map((c) => c.code),
  thinTrading: cleaned.filter((c) => c.thinTrading).length,
  thinTradingCodes: cleaned.filter((c) => c.thinTrading).map((c) => c.code),
  noFx: fx.rate == null,
  vendorCap: (() => {
    const rows = uni.rows.filter((c) => c.vendorCap > 0);
    const gaps = [];
    for (const c of cleaned) {
      const v = uni.rows.find((x) => x.code === c.code);
      if (!v || !(v.vendorCap > 0) || !(c.marketCap > 0)) continue;
      const gap = Math.abs(c.marketCap / v.vendorCap - 1);
      if (gap > 0.1) gaps.push({ code: c.code, gap: +(gap * 100).toFixed(1) });
    }
    return { compared: rows.length, over10pct: gaps.length, examples: gaps.slice(0, 8) };
  })(),
};

writeJson(`${OUT}.tmp`, {
  updated: new Date().toISOString(),
  universe: `B3 · ${cleaned.length} companies`,
  indexName: 'Ibovespa',
  currency: 'BRL',
  fx,
  session: cleaned.map((c) => c.priceDate).filter(Boolean).sort().pop() || null,
  market, index: idx, themes, audit, companies: cleaned,
});
renameSync(`${OUT}.tmp`, OUT);

mkdirSync(SERIES_DIR, { recursive: true });
const bucketBook = {};
for (const kind of ['daily', 'weekly']) {
  for (const [code, arr] of Object.entries(series[kind])) {
    const b = String(code).slice(0, 1).toUpperCase();
    if (!/^[A-Z0-9]$/.test(b)) continue;
    (bucketBook[b] = bucketBook[b] || { daily: {}, weekly: {} })[kind][code] = arr;
  }
}
const seriesStamp = new Date().toISOString();
for (const [b, obj] of Object.entries(bucketBook)) {
  const f = join(SERIES_DIR, `${b}.json`);
  writeJson(`${f}.tmp`, { updated: seriesStamp, ...obj });
  renameSync(`${f}.tmp`, f);
}

try {
  const { brazilList } = await import('../src/project.js');
  const list = brazilList({ ...JSON.parse(readFileSync(OUT, 'utf8')) });
  writeFileSync(`${LIST_OUT}.tmp`, JSON.stringify(list)); renameSync(`${LIST_OUT}.tmp`, LIST_OUT);
} catch (e) { console.log(`  list artifact: ${e.message}`); }

rmSync(DETAIL_DIR, { recursive: true, force: true });
mkdirSync(DETAIL_DIR, { recursive: true });
for (const c of cleaned) writeFileSync(join(DETAIL_DIR, `${c.code}.json`), JSON.stringify(c));

try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'br'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'attach-market-brands.mjs'), 'br'], { stdio: 'inherit' }); }
catch (e) { console.log(`  brands: ${e.message}`); }

console.log(`${cleaned.length} companies · ${market.medianPe ?? '—'} median P/E · ${withDesc} descriptions · Ibovespa ${idx ? Math.round(idx.level) : '—'} · USD/BRL ${fx.rate}`);
console.log(`${dropped.length} without statements · ${noPrice.length} without a price · ${market.multiClass} multi-class · ${market.foreignReporters} report in another currency · ${market.sectors.length} sectors`);
console.log(cleaned.slice(0, 5).map((c) => `  ${c.code} ${c.nameEn || c.name} · R$${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'} · ${c.reportCurrency} · ${c.shareClass}`).join('\n'));
