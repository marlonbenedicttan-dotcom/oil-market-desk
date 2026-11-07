// Curated B3 BDR lens.
//
//   node scripts/build-brazil-bdrs.mjs
//   node scripts/build-brazil-bdrs.mjs --codes=ROXO34,AAPL34
//   node scripts/build-brazil-bdrs.mjs --fresh
//
// A BDR is a depositary receipt of a foreign company. The B3 quote page is a stub (profile and
// statements 404), so this pass uses:
//   - the B3 exchange list row for the company-total market cap in BRL and the B3 name;
//   - the underlying foreign listing for statements, profile, current shares and dividend yield;
//   - the BDR's own .SA series for the price and returns.
// The cap is the global company cap (BRL), not the BDR tranche, and classes are not summed. Ratios
// are company-level in the report currency; the BDR price is the line price. No per-BDR P/E band.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import {
  ROOT, BR_CACHE, b3Universe, readBdrs, saUnderlyingPage, saUnderlyingProfile, saUnderlyingStats,
  yaSymbol, isFinancialSector, isBankLike, pad,
} from './b3.mjs';
import { sleep, readJson, writeJson, getCached, parseSaTable, rowOf, periodFromTitle, statementCurrency } from './stockanalysis.mjs';
import { deriveListing } from './derive-listing.mjs';
import { extractProfile } from './profile.mjs';

const OUT = join(ROOT, 'data', 'brazil-bdr-data.json');
const CACHE = join(ROOT, 'data', 'cache', 'brazil-bdr');
const PROFILES = join(ROOT, 'data', 'brazil-profiles.json');
const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const arg = (k, d = null) => { const x = process.argv.find((a) => a.startsWith(`--${k}=`)); return x ? x.split('=')[1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const CODES = (arg('codes', '') || '').split(',').map((s) => pad(s)).filter(Boolean);
const LIMIT = Number(arg('limit', 0)) || 0;
const FRESH = flag('fresh');
const TTL_DAY = 6 * 3600e3;
const TTL_FIN = 7 * DAY;
const TTL_Q = 1 * DAY;
const TTL_PROFILE = 30 * DAY;
mkdirSync(CACHE, { recursive: true });
mkdirSync(join(CACHE, 'profiles'), { recursive: true });
mkdirSync(join(CACHE, 'stats'), { recursive: true });

const allow = readBdrs();
let entries = allow.bdrs.filter((b) => !CODES.length || CODES.includes(b.code));
if (LIMIT) entries = entries.slice(0, LIMIT);

// The B3 list gives the BRL company cap; fall back to the allowlist's pinned cap if the list fails.
let uni = { all: [] };
try { uni = await b3Universe({ fresh: FRESH }); } catch (e) { console.warn(`B3 list unavailable (${e.message}); using the pinned caps`); }
const rowBy = new Map((uni.all || []).map((r) => [r.code, r]));

// FX from the domestic build; refetch only if it is missing.
let dom = readJson(join(ROOT, 'data', 'brazil.json')) || {};
let fx = dom.fx || null;
if (!fx || !fx.rate || !fx.rates) {
  try {
    const text = await getCached('https://open.er-api.com/v6/latest/USD', join(BR_CACHE, 'er-usd.json'), { ttlMs: TTL_DAY, retries: 3 });
    const j = JSON.parse(text);
    const rates = j && j.rates ? Object.fromEntries(Object.entries(j.rates).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) : null;
    if (rates && rates.BRL > 0) fx = { pair: 'USDBRL', rate: +rates.BRL.toFixed(4), date: iso(Date.now()), rates };
  } catch { /* ratios blank */ }
}

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
const hasData = (html) => {
  try {
    const t = parseSaTable(html);
    return t.rows.some((r) => /^(Revenue|Net Income)/.test(r.label) && Object.values(r.values).some((v) => v != null));
  } catch { return false; }
};
const MULT = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
function parseShares(html) {
  if (!html) return null;
  const prose = /has ([\d.,]+)\s*(thousand|million|billion|trillion) shares outstanding/i.exec(html);
  if (prose) {
    const n = Number(prose[1].replace(/,/g, ''));
    if (Number.isFinite(n) && MULT[prose[2].toLowerCase()]) return n * MULT[prose[2].toLowerCase()];
  }
  const table = /Shares Outstanding[\s\S]{0,400}?title="([\d,]+)"/.exec(html);
  if (table) {
    const n = Number(table[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
function parseYield(html) {
  const m = /\{id:"dividendYield",[^}]*?value:"([^"]+)"/.exec(html || '');
  if (!m) return null;
  const n = Number(String(m[1]).replace(/[%,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function parseCap(html) {
  const m = /\{id:"marketcap",title:"Market Cap",value:"[^"]+",hover:"([\d,]+)"/.exec(html || '');
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

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
async function yahooSeries(symbol, range = '5y') {
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
      const s = ts.map((t, i) => ({ d: iso(t * 1000), c: (q.close || [])[i], v: (q.volume || [])[i] })).filter((p) => p.c != null && p.c > 0);
      if (!s.length) return [];
      writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), text: JSON.stringify(s) }));
      return s;
    } catch { await sleep(800); }
  }
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
    for (let j = i + 1; j <= Math.min(i + 3, arr.length - 1); j++) if (Math.abs(arr[j].c / pre - 1) < 0.2) { reverses = true; break; }
    if (reverses) { arr[i].c = pre; fixed++; }
  }
  return { s: arr, adjustments: fixed };
}
const pointOnOrBefore = (s, d) => { let hit = null; for (const p of s) { if (p.d > d) break; hit = p; } return hit; };

async function page(b, p, q = false) {
  const f = join(CACHE, `${b.code}-${p}${q ? '-q' : ''}.json`);
  return getCached(saUnderlyingPage(b, p, q), f, { fresh: FRESH, ttlMs: q ? TTL_Q : TTL_FIN, timeout: 30000, retries: 6 });
}
async function profileOf(b) {
  const f = join(CACHE, 'profiles', `${b.code}.json`);
  const html = await getCached(saUnderlyingProfile(b), f, { fresh: FRESH, ttlMs: TTL_PROFILE, timeout: 25000, retries: 4 });
  return html ? extractProfile(html) : null;
}
async function statsOf(b) {
  const f = join(CACHE, 'stats', `${b.code}.json`);
  return getCached(saUnderlyingStats(b), f, { fresh: FRESH, ttlMs: TTL_DAY, timeout: 25000, retries: 4 });
}

const companies = [];
const seriesOut = {};
const dropped = [];
let done = 0;
for (const b of entries) {
  const row = rowBy.get(b.code);
  const vendorCap = (row && row.vendorCap) || b.vendorCap || 0;
  if (!(vendorCap > 0)) { dropped.push({ code: b.code, why: 'no B3 cap' }); continue; }
  const displayName = (row && row.name ? String(row.name).replace(/&amp;/g, '&') : b.name) || b.code;
  let inc = null, bal = null, csh = null, qtr = null, stat = null, prof = null;
  try {
    [inc, bal, csh, qtr, stat, prof] = await Promise.all([
      page(b, 'income-statement'), page(b, 'balance-sheet'), page(b, 'cash-flow-statement'),
      page(b, 'income-statement', true), statsOf(b), profileOf(b),
    ]);
  } catch (e) {
    dropped.push({ code: b.code, why: e && e.throttled ? 'throttled' : 'fetch failed' });
    continue;
  }
  if (!inc || !hasData(inc)) { dropped.push({ code: b.code, why: 'no underlying statements' }); continue; }
  let I, B, C;
  try {
    I = incomeOf(inc); B = balanceOf(bal); C = cashOf(csh);
  } catch { dropped.push({ code: b.code, why: 'statement parse failed' }); continue; }
  const annual = new Map();
  const add = (end, obj) => { if (!annual.has(end)) annual.set(end, { end }); Object.assign(annual.get(end), obj); };
  for (const r of I.annual) add(r.end, r);
  for (const r of B.annual) add(r.end, r);
  for (const r of C.annual) add(r.end, r);
  const annualRows = [...annual.values()].filter((r) => r.revenue != null || r.equity != null).sort((a, e) => a.end.localeCompare(e.end));
  const ttm = { ...(I.ttm || {}), ...(C.ttm || {}) };
  const ttmEnd = I.ttmEnd || C.ttmEnd || null;
  const latest = B.latest || {};
  const latestEnd = B.ttmEnd || null;
  const reportCurrency = I.currency || 'USD';
  const shares = (I.ttm && I.ttm.shares) || (annualRows.length ? annualRows[annualRows.length - 1].shares : null) || null;
  const sharesCurrent = parseShares(stat) || null;
  const vendorYield = parseYield(stat);
  const statsCapUsd = parseCap(stat);
  const rawSeries = await yahooSeries(yaSymbol(b.code));
  let series = [];
  if (rawSeries.length > 1) series = sanitizeSeries(rawSeries).s;
  const priceInfo = series.length ? series[series.length - 1] : null;
  if (!priceInfo) { dropped.push({ code: b.code, why: 'no BDR price' }); continue; }
  const lastEnd = ttmEnd || latestEnd || (annualRows.length ? annualRows[annualRows.length - 1].end : null);
  const session = priceInfo.d;
  const ttmAgeDays = lastEnd ? Math.round((Date.parse(session) - Date.parse(lastEnd)) / DAY) : null;
  const stale = ttmAgeDays != null && ttmAgeDays > 450;
  const broken = ttm.revenue > 0 && ttm.operatingProfit > ttm.revenue * 1.05;
  if (stale || broken) { dropped.push({ code: b.code, why: stale ? 'stale statement' : 'broken statement' }); continue; }
  const flatPct = (() => {
    const win = series.slice(-250);
    if (win.length < 2) return null;
    let same = 0;
    for (let i = 1; i < win.length; i++) if (win[i].c === win[i - 1].c) same++;
    return Math.round((same / (win.length - 1)) * 100);
  })();
  const noRecentTrading = flatPct != null && flatPct >= 90;
  const shortHistory = series.length > 0 && series.length < 100;
  const avgOver = (n, value) => {
    const win = series.slice(-n).filter((p) => p.v != null && Number.isFinite(p.v) && p.v > 0 && p.c > 0);
    if (!win.length) return null;
    const xs = win.map((p) => (value ? p.c * p.v : p.v));
    return xs.reduce((a, e) => a + e, 0) / xs.length;
  };
  const avgValue30 = avgOver(30, true);
  const thinTrading = avgValue30 != null && avgValue30 < 1e6;
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const six = pointOnOrBefore(series, iso(Date.parse(session) - 182 * DAY));
  const jan = series.find((p) => p.d >= `${session.slice(0, 4)}-01-01`);
  const input = {
    code: b.code, ticker: b.code, name: displayName, nameEn: (prof && prof.name) || displayName,
    nameFull: (prof && prof.legal) || null, description: (prof && prof.desc) || null,
    sector: (prof && prof.sector) || 'Other', sectorSource: prof && prof.sector ? 'profile-gics-sector' : 'other',
    industry: (prof && prof.industry) || null, brands: (prof && prof.brands) || [],
    bdr: true, bdrUnderlying: b.underlying || null, bdrGroup: b.group || 'global', bdrNote: b.note || null,
    bdrExchange: b.exchange || null, bdrTicker: b.ticker || null,
    shareClass: 'BDR', multiClass: false, base: `bdr:${b.code}`,
    price: +priceInfo.c.toFixed(3), priceDate: session,
    marketCap: vendorCap, vendorCap, shares, sharesCurrent,
    sharesBasis: sharesCurrent ? 'global current (underlying statistics)' : 'global diluted (underlying filing)',
    ttm, latest, annual: annualRows, quarters: quartersOf(qtr), ttmEnd, latestEnd, reportCurrency,
    ttmAgeDays, ttmStale: ttmAgeDays != null && ttmAgeDays > 365, stale,
    broken, noRecentTrading, shortHistory, thinTrading, flatPct, avgValue30,
    avgVolume30: avgOver(30, false),
    chg1d: noRecentTrading ? null : (prev ? +(((priceInfo.c / prev.c) - 1) * 100).toFixed(2) : null),
    chg6m: noRecentTrading ? null : (six ? +(((priceInfo.c / six.c) - 1) * 100).toFixed(2) : null),
    chgYtd: noRecentTrading ? null : (jan ? +(((priceInfo.c / jan.c) - 1) * 100).toFixed(2) : null),
    vendorDividendYield: vendorYield != null ? vendorYield : undefined,
    _statsCapUsd: statsCapUsd || null,
    series,
  };
  let c = deriveListing({ companies: [input], fx, baseCurrency: 'BRL' })[0];
  if (!c) { dropped.push({ code: b.code, why: 'derive failed' }); continue; }
  // The BDR price is a fraction of the underlying; do not build a per-BDR P/E band from global EPS.
  c.bands = null;
  // The vendor's global yield is the only defensible yield; never use global DPS ÷ BDR price.
  c.dividendYield = vendorYield != null ? vendorYield : null;
  c.dividendYieldBasis = vendorYield != null ? 'vendor' : null;
  c.financial = isFinancialSector(c.sector);
  c.bankLike = isBankLike(c);
  const na = [];
  if (c.financial) {
    for (const k of ['fcf', 'fcfYield', 'fcfMargin', 'cashConversion', 'operatingCashFlow']) { c[k] = null; na.push(k); }
  }
  if (c.bankLike) {
    for (const k of ['opMargin', 'operatingProfit', 'evEbitda', 'currentRatio', 'debtEquity', 'roic', 'assetTurnover']) { c[k] = null; na.push(k); }
  }
  if (na.length) c.naRatios = [...new Set(na)];
  if (c.pe != null && c.pe < 0.5) { c.pe = null; c.naRatios = [...new Set([...(c.naRatios || []), 'pe'])]; }
  if (c.opMargin != null && Math.abs(c.opMargin) > 500) c.opMargin = null;
  if (c.roe != null && Math.abs(c.roe) > 500) c.roe = null;
  const { series: _s, ...rest } = c;
  companies.push({
    ...rest,
    reports: { ttm: c.ttm, latest: c.latest, annual: c.annual, quarters: c.quarters, ttmEnd: c.ttmEnd || null, latestEnd: c.latestEnd || null },
    history: c.history || [],
    quarters: c.quarters,
  });
  seriesOut[b.code] = series;
  done++;
  if (done % 5 === 0) console.log(`  ${done}/${entries.length} BDRs`);
}
console.log(`${companies.length} BDRs built · ${dropped.length} dropped`);

const book = readJson(PROFILES) || { entries: {} };
book.entries = book.entries || {};
for (const b of entries) {
  const c = companies.find((x) => x.code === b.code);
  if (!c) continue;
  const f = join(CACHE, 'profiles', `${b.code}.json`);
  try {
    const p = extractProfile(readFileSync(f, 'utf8'));
    if (p) book.entries[b.code] = { ...p, fetched: new Date().toISOString(), source: 'stockanalysis.com underlying' };
  } catch { /* no profile */ }
}
book.updated = new Date().toISOString();
writeFileSync(`${PROFILES}.tmp`, JSON.stringify(book));
renameSync(`${PROFILES}.tmp`, PROFILES);

const audit = {
  requested: entries.length,
  built: companies.length,
  dropped: dropped.length,
  droppedCodes: dropped.slice(0, 20),
  groups: companies.reduce((a, c) => { a[c.bdrGroup] = (a[c.bdrGroup] || 0) + 1; return a; }, {}),
  reportCurrencies: [...new Set(companies.map((c) => c.reportCurrency))],
  financial: companies.filter((c) => c.financial).length,
  bankLike: companies.filter((c) => c.bankLike).length,
  pe: companies.filter((c) => c.pe != null).length,
  pb: companies.filter((c) => c.pb != null).length,
  roe: companies.filter((c) => c.roe != null).length,
  dividendYield: companies.filter((c) => c.dividendYield != null).length,
  noRecentTrading: companies.filter((c) => c.noRecentTrading).length,
  shortHistory: companies.filter((c) => c.shortHistory).length,
  ttmStale: companies.filter((c) => c.ttmStale).length,
  thinTrading: companies.filter((c) => c.thinTrading).length,
  series: Object.keys(seriesOut).length,
};
const doc = {
  updated: new Date().toISOString(),
  note: 'Curated BDR lens. Global company caps in BRL; underlying statements; BDR line prices. Excluded from the domestic totals.',
  fx, session: companies.map((c) => c.priceDate).filter(Boolean).sort().pop() || null,
  audit, companies, series: seriesOut,
};
writeJson(`${OUT}.tmp`, doc);
renameSync(`${OUT}.tmp`, OUT);
console.log(`${companies.length} BDRs · ${Object.keys(seriesOut).length} series · ${audit.reportCurrencies.join('/')} · ${audit.noRecentTrading} no-trade · ${audit.thinTrading} thin`);
console.log(companies.slice(0, 6).map((c) => `  ${c.code} ${c.nameEn} · R$${c.price} · cap R$${(c.marketCap / 1e9).toFixed(0)}B · P/E ${c.pe ?? '—'} · ${c.reportCurrency} · ${c.bdrGroup}`).join('\n'));
