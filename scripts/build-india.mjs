// Build the India dataset: the NIFTY 500.
//
//   node scripts/build-india.mjs                          full run (500 companies, five years)
//   node scripts/build-india.mjs --limit=30               smoke test
//   node scripts/build-india.mjs --codes=RELIANCE,TCS     named companies
//   node scripts/build-india.mjs --skip-prices            reuse the cached daily files
//   node scripts/build-india.mjs --skip-fin               reuse the statements already in the file
//   node scripts/build-india.mjs --prices-only            warm Yahoo and stop
//
// Sources:
//   - niftyindices.com NIFTY 500 CSV: the universe, the NSE symbol and the NSE industry (20 macro
//     sectors). Keyless, refreshed daily.
//   - Yahoo (https.get — undici's fingerprint is rejected): five years of daily closes for {SYMBOL}.NS
//     and the NIFTY 50 (^NSEI).
//   - stockanalysis.com (NSE): English statements with a TTM column, the diluted share count, the
//     dividend per share, and the profile (company name, description, GICS industry).
//   - open.er-api.com: one USD table (USD/INR and every report-currency cross).
//
// Output: data/india.json (records + reports), data/india-series/{X}.json (daily and weekly closes,
// bucketed by the first character of the symbol), data/india-list.json (the compact /api/india payload).
//
// India reports from April to March, so the fiscal year is not the calendar year. Prices, the P/E band
// and every "as of" date come from the filing's own period end, never from the calendar.

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { join } from 'node:path';
import {
  ROOT, IN_CACHE, IN_SA, isOrdinaryLine, pad, saPage, saProfile, yaSymbol, INDEX_SYMBOL,
  isFinancialSector, isBankLike,
} from './nse.mjs';
import { sleep, readJson, writeJson, getCached, parseSaTable, rowOf, periodFromTitle, statementCurrency } from './stockanalysis.mjs';
import { deriveListing } from './derive-listing.mjs';

const OUT = join(ROOT, 'data', 'india.json');
const SERIES_DIR = join(ROOT, 'data', 'india-series');
const LIST_OUT = join(ROOT, 'data', 'india-list.json');
const DETAIL_DIR = join(ROOT, 'data', 'india-companies');
const PROFILES = join(ROOT, 'data', 'india-profiles.json');
const THEMES = join(ROOT, 'data', 'india-themes.json');
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
// stockanalysis is one host for the whole crawl. `--pace` is the pause after each company.
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

// --- 1. the universe ------------------------------------------------------------------------------
console.log('NIFTY 500 constituents…');
const csv = await (async () => {
  const f = join(IN_CACHE, 'ind_nifty500list.json');
  const text = await getCached('https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv', f, {
    fresh: flag('fresh'), ttlMs: TTL_DAY, timeout: 45000, retries: 4,
  });
  if (!text) throw new Error('NIFTY 500 CSV returned nothing');
  const { parseNifty500 } = await import('./nse.mjs');
  const rows = parseNifty500(text);
  if (!rows.length) throw new Error('NIFTY 500 CSV parsed to zero rows');
  return { rows };
})();
const excluded = csv.rows.filter((r) => !isOrdinaryLine(r.series)).map((r) => ({ code: r.code, name: r.name, series: r.series }));
const listed = csv.rows.filter((r) => isOrdinaryLine(r.series)).map((r) => ({
  code: pad(r.code),
  ticker: pad(r.code),
  name: r.name,
  gicsIndustryGroup: r.industry,
  isin: r.isin,
  // `series` is the price history on every other market; keeping the NSE trading series under this
  // name is what stops the EQ/BE flag from being read as a price series (498 "histories" of length 2).
  seriesCode: r.series,
}));
console.log(`  ${csv.rows.length} rows · ${excluded.length} non-equity lines excluded · ${listed.length} companies`);

let universe = CODES.length ? listed.filter((c) => CODES.includes(c.code)) : (LIMIT ? listed.slice(0, LIMIT) : listed);

// --- 2. Yahoo price history -----------------------------------------------------------------------
const YH_CACHE = join(IN_CACHE, 'yahoo');
mkdirSync(YH_CACHE, { recursive: true });

// Yahoo rejects Node's undici fingerprint (fetch fails; the same URL over https.get returns 200).
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
        if (s) return s;
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
      const closes = (res.indicators.quote[0] || {}).close || [];
      const s = ts.map((t, i) => ({ d: iso(t * 1000), c: closes[i] })).filter((p) => p.c != null && p.c > 0);
      if (!s.length) return [];
      writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), text: JSON.stringify(s) }));
      return s;
    } catch { await sleep(800); }
  }
  return [];
}

// A price series with one bar is a listing-day stub, not a history. Duplicate dates are collapsed and
// the series is ordered; a bar beyond ±60% that fully reverses within three sessions is a bad print.
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
  console.log(`prices… ${universe.length} symbols, ${YEARS}y daily (Yahoo)`);
  let done = 0;
  const workers = Number(arg('price-workers', 3)) || 3;
  await pool(universe, workers, async (c) => {
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
  // A cached file from an interrupted run can end on a bar without a close; it has no price.
  if (!(last && last.c > 0)) continue;
  c.price = +last.c.toFixed(3);
  c.priceDate = last.d;
}
console.log(`  ${universe.filter((c) => c.series && c.series.length > 1).length} symbols with a history · ${universe.filter((c) => c.price > 0).length} priced`);
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

// --- 3. financials from stockanalysis --------------------------------------------------------------
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
    ttmEnd,
    currency: statementCurrency(html),
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

async function page(code, p, q = false) {
  const f = join(IN_SA, `${code.replace(/[^\w-]/g, '_')}-${p}${q ? '-q' : ''}.json`);
  // A 404 returns null (the page genuinely does not exist); throttling throws, and the caller marks the
  // company so the audit can say "not fetched this run" instead of "no statements".
  return getCached(saPage(code, p, q), f, { ttlMs: q ? TTL_Q : TTL_FIN, timeout: 30000, retries: 6 });
}

if (!SKIP_FIN) {
  console.log('financials…'); let done = 0, miss = 0;
  const finWorkers = Number(arg('fin-workers', SKIP_PRICES ? 6 : 2)) || (SKIP_PRICES ? 6 : 2);
  await pool(universe, finWorkers, async (c) => {
    try {
      // Sequential, not Promise.all: four simultaneous requests per worker is a burst the source reads
      // as a scraper. One page at a time with the global pace stays under the limit.
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
      // The statement currency is published so a USD/EUR reporter is never valued in rupees.
      c.reportCurrency = I.currency || 'INR';
      const rawShares = (I.ttm && I.ttm.shares) || (c.annual.length ? c.annual[c.annual.length - 1].shares : null) || null;
      c.shares = rawShares;
    } catch (e) {
      if (e && e.throttled) {
        c.throttled = true;
        // The source is blocking us, not missing the page. Go quiet rather than sprint through the rest
        // of the market marking every company "throttled".
        await sleep(60000);
      } else miss++;
      c.ttm = null; c.latest = {}; c.annual = []; c.quarters = []; c.shares = null;
    }
    if (++done % 25 === 0) console.log(`  ${done}/${universe.length} companies`);
    await sleep(PACE);
  });
  console.log(`  ${universe.length - miss} with statements · ${miss} missing`);
} else {
  const prevBy = new Map(((readJson(OUT) || {}).companies || []).map((c) => [c.code, c]));
  for (const c of universe) {
    const p = prevBy.get(c.code);
    if (!p) continue;
    c.ttm = (p.reports && p.reports.ttm) || null;
    c.latest = (p.reports && p.reports.latest) || {};
    c.annual = (p.reports && p.reports.annual) || [];
    c.quarters = (p.reports && p.reports.quarters) || [];
    c.ttmEnd = (p.reports && p.reports.ttmEnd) || null;
    c.latestEnd = (p.reports && p.reports.latestEnd) || null;
    c.reportCurrency = p.reportCurrency || 'INR';
    c.shares = p.shares || null;
    c.periodBasis = p.periodBasis || null;
    c.sharesBasis = p.sharesBasis || null;
  }
}

// A trailing column that reports more profit than revenue is not a trailing twelve months: it is two
// different periods spliced together (Vedanta Oil and Gas, a fresh demerger, had a TTM profit five
// times its revenue on the vendor page). Every ratio built on it is fiction, so the company is
// excluded and named rather than published with a P/B of 0.00.
const broken = universe.filter((c) => {
  const t = c.ttm || {};
  return t.revenue > 0 && (t.netIncome > t.revenue * 3 || t.operatingProfit > t.revenue * 3);
});
for (const c of broken) c.broken = true;
if (broken.length) console.log(`  ${broken.length} companies with an inconsistent trailing column — excluded`);

// A company without a statement page has no share count, so it cannot have a market cap. A company
// without a Yahoo price cannot have a cap either. Both are counted and named, never estimated.
const throttled = universe.filter((c) => c.throttled);
const covered = universe.filter((c) => c.shares > 0 && c.price > 0 && !c.broken);
const dropped = universe.filter((c) => !(c.shares > 0) && !c.throttled && !c.broken).map((c) => ({ code: c.code, name: c.name }));
const noPrice = universe.filter((c) => c.shares > 0 && !(c.price > 0)).map((c) => ({ code: c.code, name: c.name }));
if (dropped.length) console.log(`  ${dropped.length} listed companies without a statement page (no shares, no cap)`);
if (noPrice.length) console.log(`  ${noPrice.length} companies without a price (no cap; excluded rather than estimated)`);
if (throttled.length) console.log(`  ${throttled.length} companies throttled this run — rerun the build to fill them (nothing was cached as missing)`);

// --- 4. FX ----------------------------------------------------------------------------------------
// One USD table gives the INR cross and every report-currency cross. A missing table leaves the ratios
// of a foreign reporter blank, not wrong.
let fx = { pair: 'USDINR', rate: null, date: iso(Date.now()), rates: null };
try {
  const f = join(IN_CACHE, 'er-usd.json');
  const text = await getCached('https://open.er-api.com/v6/latest/USD', f, { ttlMs: TTL_DAY, retries: 3 });
  const j = JSON.parse(text);
  const rates = j && j.rates ? Object.fromEntries(Object.entries(j.rates).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) : null;
  if (rates && rates.INR > 0) {
    fx = { pair: 'USDINR', rate: +rates.INR.toFixed(4), date: (j.time_last_update_utc ? iso(Date.parse(j.time_last_update_utc)) : iso(Date.now())), rates };
  }
} catch { /* fx stays null; foreign reporters get no ratios */ }

// --- 5. the NIFTY 50 ------------------------------------------------------------------------------
const nsei = (await yahooSeries(INDEX_SYMBOL, `${YEARS}y`)).slice(-1300);
const idx = nsei.length > 1 ? (() => {
  const last = nsei[nsei.length - 1], prev = nsei[nsei.length - 2];
  const six = pointOnOrBefore(nsei, iso(Date.parse(last.d) - 182 * DAY));
  const jan = nsei.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  return {
    level: last.c, date: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null,
    series: nsei,
  };
})() : null;

// --- 6. derive ------------------------------------------------------------------------------------
// The P/E band pairs each fiscal year's EPS with the price at that period end, not the calendar year
// end: an Indian March-year company would otherwise compare a December price with a March EPS.
for (const c of covered) {
  for (const r of c.annual || []) {
    const p = pointOnOrBefore(c.series || [], r.end);
    if (p) r.px = p.c;
  }
}
let out = deriveListing({ companies: covered, fx, baseCurrency: 'INR' });

// --- 7. descriptions and sectors -------------------------------------------------------------------
// The NSE industry is the sector (20 macro sectors). The profile's GICS industry is finer and is used
// only for the bank/insurer split, because "Financial Services" on the NSE list covers all of them.
const profiles = readJson(PROFILES) || { entries: {} };
let withDesc = 0;
for (const c of out) {
  const p = profiles.entries && profiles.entries[c.code];
  c.name = String(c.name || '').replace(/\s+/g, ' ').trim();
  c.nameEn = (p && p.name) || c.name;
  c.nameFull = (p && p.legal) || null;
  c.description = (p && p.desc) || null;
  c.sector = c.gicsIndustryGroup || (p && p.sector) || 'Other';
  c.sectorSource = c.gicsIndustryGroup ? 'nse-industry' : (p && p.sector ? 'profile-gics-sector' : 'other');
  c.industry = (p && p.industry) || null;
  if (c.description) withDesc++;
}

// --- 7b. ratios that do not exist for a bank ------------------------------------------------------
// A lender's revenue is interest income, it reports no operating-profit line, and its cash flow is loans
// and deposits — an operating margin and a free-cash-flow yield are not missing, they do not exist.
// Insurers keep their margin but lose free cash flow, because their investing flow is the portfolio.
// This is the same rule the US, Japan, Hong Kong and Australia pages use.
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
  } else if (c.financial && c.opMargin == null) {
    na.push('opMargin');
  }
  if (na.length) c.naRatios = [...new Set(na)];
}

// --- 8. market aggregates + themes ----------------------------------------------------------------
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
  foreignReporters: out.filter((c) => (c.reportCurrency || 'INR') !== 'INR').length,
  financials: out.filter((c) => c.financial).length,
  bankLike,
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
  members: (t.members || []).filter((x) => known.has(pad(x))).map(pad),
})).filter((t) => t.members.length);

// --- 9. write -------------------------------------------------------------------------------------
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
  const { series: _s, yearEnd, ttm, latest, annual, quarters, ...rest } = c;
  return { ...rest, reports: { ttm, latest, annual, quarters, ttmEnd: c.ttmEnd || null, latestEnd: c.latestEnd || null }, history: c.history || [], quarters };
});

const audit = {
  quoted: csv.rows.length,
  excludedNonCompanies: excluded.length,
  excluded: excluded.slice(0, 40),
  companies: cleaned.length,
  considered: universe.length,
  withStatements: cleaned.length,
  withoutStatements: dropped.length,
  noStatements: dropped,
  withoutPrice: noPrice.length,
  noPrice,
  throttled: throttled.length,
  broken: broken.length,
  brokenCodes: broken.map((c) => ({ code: c.code, name: c.name })),
  dropped: dropped.slice(0, 40),
  sectors: market.sectors.length,
  resolvedFromProfile: cleaned.filter((c) => c.sectorSource === 'profile-gics-sector').length,
  pe: cleaned.filter((c) => c.pe != null).length,
  pb: cleaned.filter((c) => c.pb != null).length,
  roe: cleaned.filter((c) => c.roe != null).length,
  netProfitTTM: cleaned.filter((c) => c.netIncomeTTM != null).length,
  financials: cleaned.filter((c) => c.financial).length,
  bankLike: cleaned.filter((c) => c.bankLike).length,
  foreignReporters: cleaned.filter((c) => c.reportCurrency !== 'INR').length,
  noFx: fx.rate == null,
};

writeJson(`${OUT}.tmp`, {
  updated: new Date().toISOString(),
  universe: `NIFTY 500 · ${cleaned.length} companies`,
  indexName: 'NIFTY 50',
  currency: 'INR',
  fx,
  session: cleaned.map((c) => c.priceDate).filter(Boolean).sort().pop() || null,
  market, index: idx, themes, audit, companies: cleaned,
});
renameSync(`${OUT}.tmp`, OUT);

// One-character buckets (RELIANCE → "R", M&M → "M"): one chart parses a few hundred kilobytes, not the
// whole market.
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
  const { indiaList } = await import('../src/project.js');
  const list = indiaList({ ...JSON.parse(readFileSync(OUT, 'utf8')) });
  writeFileSync(`${LIST_OUT}.tmp`, JSON.stringify(list)); renameSync(`${LIST_OUT}.tmp`, LIST_OUT);
} catch (e) { console.log(`  list artifact: ${e.message}`); }

// One small file per company for the company page: parsing the whole market for one record costs the
// free instance ~50 MB.
rmSync(DETAIL_DIR, { recursive: true, force: true });
mkdirSync(DETAIL_DIR, { recursive: true });
for (const c of cleaned) writeFileSync(join(DETAIL_DIR, `${c.code}.json`), JSON.stringify(c));

// Re-index the per-company chart store so a chart never has to parse a whole bucket again.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'in'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }

try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'attach-market-brands.mjs'), 'in'], { stdio: 'inherit' }); }
catch (e) { console.log(`  brands: ${e.message}`); }

console.log(`${cleaned.length} companies · ${market.medianPe ?? '—'} median P/E · ${withDesc} descriptions · NIFTY 50 ${idx ? Math.round(idx.level) : '—'} · USD/INR ${fx.rate}`);
console.log(`${dropped.length} without statements · ${noPrice.length} without a price · ${market.foreignReporters} report in another currency · ${market.sectors.length} sectors`);
console.log(cleaned.slice(0, 5).map((c) => `  ${c.code} ${c.nameEn || c.name} · ₹${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'} · ${c.reportCurrency}`).join('\n'));
