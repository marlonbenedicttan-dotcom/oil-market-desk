// Build the Indonesia dataset: every company on the Indonesia Stock Exchange (IDX).
//
//   node scripts/build-indonesia.mjs                          full run (five years)
//   node scripts/build-indonesia.mjs --limit=30               smoke test
//   node scripts/build-indonesia.mjs --codes=BBCA,TLKM        named companies
//   node scripts/build-indonesia.mjs --skip-prices            reuse the cached daily files
//   node scripts/build-indonesia.mjs --skip-fin               reuse the statements already in the file
//   node scripts/build-indonesia.mjs --prices-only            warm Yahoo and stop
//
// Sources:
//   - stockanalysis.com's IDX exchange list: the universe (915 rows, 912 companies). IDX blocks this
//     network at the edge, so the list comes from the same vendor as the statements and is pinned in
//     data/indonesia-universe.json as a fallback.
//   - Yahoo (https.get — undici's fingerprint is rejected): five years of daily closes for {TICKER}.JK
//     and the IDX Composite (^JKSE).
//   - stockanalysis.com (IDX): English statements with a TTM column, the diluted share count, the
//     dividend per share, the GICS sector/industry and the profile.
//   - open.er-api.com: one USD table (USD/IDR and every report-currency cross).
//
// Output: data/indonesia.json (records + reports), data/indonesia-series/{X}.json (daily and weekly
// closes, bucketed by the first character of the ticker), data/indonesia-list.json (the compact
// /api/indonesia payload).
//
// Most IDX issuers report to 31 December, but the build never assumes it: every price, P/E band and
// "as of" date is taken from the filing's own period end.

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { join } from 'node:path';
import {
  ROOT, ID_CACHE, ID_SA, idxUniverse, readUniverseSnapshot, writeUniverseSnapshot, isOrdinaryLine,
  pad, saPage, saProfile, yaSymbol, INDEX_SYMBOL, isFinancialSector, isBankLike,
} from './idx.mjs';
import { sleep, readJson, writeJson, getCached, parseSaTable, rowOf, periodFromTitle, statementCurrency } from './stockanalysis.mjs';
import { deriveListing } from './derive-listing.mjs';

const OUT = join(ROOT, 'data', 'indonesia.json');
const SERIES_DIR = join(ROOT, 'data', 'indonesia-series');
const LIST_OUT = join(ROOT, 'data', 'indonesia-list.json');
const DETAIL_DIR = join(ROOT, 'data', 'indonesia-companies');
const PROFILES = join(ROOT, 'data', 'indonesia-profiles.json');
const THEMES = join(ROOT, 'data', 'indonesia-themes.json');
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
// A live read of the vendor's exchange list; if the vendor is throttled or unreachable, the committed
// snapshot from the last successful build keeps the market whole. A shrinking market is worse than a
// slightly stale list, and the freshness check names the file that stopped updating.
console.log('IDX exchange list…');
let uni = null;
try {
  uni = await idxUniverse({ fresh: flag('fresh') });
  console.log(`  ${uni.quoted} rows · ${uni.excluded.length} non-companies excluded · ${uni.rows.length} companies · ${uni.pages} pages`);
  writeUniverseSnapshot(uni.rows, { quoted: uni.quoted, excluded: uni.excluded.map((r) => r.code), pages: uni.pages });
} catch (e) {
  const snap = readUniverseSnapshot();
  if (!snap) throw e;
  uni = { rows: snap.rows, excluded: [], quoted: snap.count, pages: 0, stale: true };
  console.log(`  list unavailable (${e.message}) — using the committed snapshot from ${String(snap.updated).slice(0, 10)}`);
}

const excluded = uni.excluded || [];
const listed = uni.rows.filter((r) => isOrdinaryLine(r.code)).map((r) => ({
  code: pad(r.code),
  ticker: pad(r.code),
  name: String(r.name || '').replace(/\s+/g, ' ').trim() || pad(r.code),
  vendorCap: r.vendorCap ?? null,
}));
console.log(`  ${listed.length} companies`);

let universe = CODES.length ? listed.filter((c) => CODES.includes(c.code)) : (LIMIT ? listed.slice(0, LIMIT) : listed);

// --- 2. Yahoo price history -----------------------------------------------------------------------
const YH_CACHE = join(ID_CACHE, 'yahoo');
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
  const f = join(ID_SA, `${code.replace(/[^\w-]/g, '_')}-${p}${q ? '-q' : ''}.json`);
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
      // The statement currency is published so a USD reporter is never valued in rupiah.
      c.reportCurrency = I.currency || 'IDR';
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
  const prevDoc = readJson(OUT) || {};
  const prevBy = new Map((prevDoc.companies || []).map((c) => [c.code, c]));
  // The first pass named the delinquent filers. Carry that verdict into the reuse pass, so a company
  // that is absent because it was excluded as stale is still counted as stale (not as a new listing).
  const prevStale = new Set(((prevDoc.audit && prevDoc.audit.staleCodes) || []).map((x) => x.code));
  for (const c of universe) {
    const p = prevBy.get(c.code);
    // A company absent from the previous file was never fetched in this pass. Re-adding it with empty
    // reports would put a statement-less shell back into the market (and undo the stale exclusion);
    // leave it out and let the next full run fetch it.
    if (!p) {
      if (prevStale.has(c.code)) c.stale = true;
      else c.noPrev = true;
      continue;
    }
    c.ttm = (p.reports && p.reports.ttm) || null;
    c.latest = (p.reports && p.reports.latest) || {};
    c.annual = (p.reports && p.reports.annual) || [];
    c.quarters = (p.reports && p.reports.quarters) || [];
    c.ttmEnd = (p.reports && p.reports.ttmEnd) || null;
    c.latestEnd = (p.reports && p.reports.latestEnd) || null;
    c.reportCurrency = p.reportCurrency || 'IDR';
    c.shares = p.shares || null;
    c.periodBasis = p.periodBasis || null;
  }
}

// A trailing column that reports an OPERATING profit above its own revenue is not a trailing twelve
// months: it is two periods spliced together (a fresh demerger, a holdco, a trader). Every ratio built on
// it is fiction, so the company is excluded and named rather than published with a P/B of 0.00.
//
// Net income above revenue is NOT a test: a holding company earns dividends from its stakes below the
// revenue line, and a one-off gain does the same.
const broken = universe.filter((c) => {
  const t = c.ttm || {};
  return t.revenue > 0 && t.operatingProfit > t.revenue * 1.05;
});
for (const c of broken) c.broken = true;
if (broken.length) console.log(`  ${broken.length} companies with an inconsistent trailing column — excluded`);

// --- stale statements -----------------------------------------------------------------------------
// A statement older than 450 days is not "the latest result"; it is a delinquent filer (or a dead
// shell). The window allows a non-December year-end whose next report is not due yet, but excludes a
// company that has missed a whole reporting year. Same rule as Hong Kong and Australia, and the audit
// re-checks it so a stale name can never re-enter unnoticed.
const STALE_DAYS = 450;
const SESSION_DATE = universe.map((c) => c.priceDate).filter(Boolean).sort().pop() || iso(Date.now());
const stale = universe.filter((c) => {
  // A company carried as stale from the previous pass stays stale even though its reports were not
  // re-read here (the --skip-fin pass has no statement dates for it).
  if (c.stale) return true;
  const end = c.ttmEnd || c.latestEnd || (c.annual && c.annual.length ? c.annual[c.annual.length - 1].end : null);
  return end && (Date.parse(SESSION_DATE) - Date.parse(end)) / DAY > STALE_DAYS;
});
for (const c of stale) c.stale = true;
if (stale.length) console.log(`  ${stale.length} companies with statements older than ${STALE_DAYS} days — excluded`);

// A company without a statement page has no share count, so it cannot have a market cap. A company
// without a Yahoo price cannot have a cap either. Both are counted and named, never estimated.
//
// Some IDX banks do not print a diluted share count on the income statement at all. The vendor's
// statistics page does carry the current count, so a company with a current count but no filing count is
// still capitalisable — it must be kept rather than dropped before the current-share file is applied.
const SHARES = (readJson(join(ROOT, 'data', 'indonesia-shares.json')) || {}).entries || {};
const hasShares = (c) => c.shares > 0 || (SHARES[c.code] && SHARES[c.code].shares > 0);
// A record with a current share count but no statement is a shell: it has no profit, revenue or book
// value to publish. The full build fetches all four pages; the --skip-fin second pass only reuses what
// the first pass already read, so a company it never saw must not re-enter the market empty.
const hasStatements = (c) => !!((c.ttm && (c.ttm.netIncome != null || c.ttm.revenue != null)) || (c.annual && c.annual.length));
const throttled = universe.filter((c) => c.throttled);
const covered = universe.filter((c) => !c.noPrev && hasStatements(c) && hasShares(c) && c.price > 0 && !c.broken && !c.stale);
const dropped = universe.filter((c) => !c.throttled && !c.broken && !c.stale && !c.noPrev && !hasStatements(c)).map((c) => ({ code: c.code, name: c.name }));
const noPrice = universe.filter((c) => !c.throttled && !c.broken && !c.stale && !c.noPrev && hasStatements(c) && hasShares(c) && !(c.price > 0)).map((c) => ({ code: c.code, name: c.name }));
if (dropped.length) console.log(`  ${dropped.length} listed companies without a statement page (no shares, no cap)`);
if (noPrice.length) console.log(`  ${noPrice.length} companies without a price (no cap; excluded rather than estimated)`);
if (throttled.length) console.log(`  ${throttled.length} companies throttled this run — rerun the build to fill them (nothing was cached as missing)`);

// --- current shares (vendor statistics page) -------------------------------------------------------
// The filing's diluted count is a period weighted average; a split, bonus or placement after the period
// end leaves the cap (and P/E, P/B, ROE) stale. data/indonesia-shares.json is written by
// fetch-listing-shares.mjs. Where the vendor prints "n/a" the filing count is kept — the honest
// fallback, not an estimate. A bank with no filing count uses the current count as its only denominator.
let currentShares = 0, impliedShares = 0;
for (const c of covered) {
  const s = SHARES[c.code];
  c.sharesBasis = 'filing (diluted weighted average)';
  if (s && s.shares > 0) {
    c.sharesCurrent = s.shares;
    c.sharesBasis = 'current (stockanalysis.com)';
    currentShares++;
    continue;
  }
  // The vendor prints "n/a" for some small caps, but it still publishes a market cap on that same page.
  // Cap ÷ price is then the count their headline is built on, which keeps ours consistent with theirs
  // (and the invariant cap = price × shares holds). Only used when it lands within 0.5–2× of the filing
  // count, so a stale or glitched cap cannot corrupt the share count.
  if (s && s.marketCap > 0 && c.price > 0 && c.shares > 0) {
    const implied = s.marketCap / c.price;
    const ratio = implied / c.shares;
    if (ratio > 0.5 && ratio < 2) {
      c.sharesCurrent = implied;
      c.sharesBasis = 'current (vendor market cap ÷ price)';
      impliedShares++;
    }
  }
  if (!(c.shares > 0) && !(c.sharesCurrent > 0)) c.sharesBasis = 'missing';
}
if (currentShares || impliedShares) console.log(`  ${currentShares} on a current share count · ${impliedShares} from the vendor cap ÷ price · ${covered.filter((c) => !(c.sharesCurrent > 0)).length} on the filing count`);

// --- 4. FX ----------------------------------------------------------------------------------------
// One USD table gives the IDR cross and every report-currency cross. A missing table leaves the ratios
// of a foreign reporter blank, not wrong.
let fx = { pair: 'USDIDR', rate: null, date: iso(Date.now()), rates: null };
try {
  const f = join(ID_CACHE, 'er-usd.json');
  const text = await getCached('https://open.er-api.com/v6/latest/USD', f, { ttlMs: TTL_DAY, retries: 3 });
  const j = JSON.parse(text);
  const rates = j && j.rates ? Object.fromEntries(Object.entries(j.rates).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) : null;
  if (rates && rates.IDR > 0) {
    fx = { pair: 'USDIDR', rate: +rates.IDR.toFixed(4), date: (j.time_last_update_utc ? iso(Date.parse(j.time_last_update_utc)) : iso(Date.now())), rates };
  }
} catch { /* fx stays null; foreign reporters get no ratios */ }

// --- 5. the IDX Composite -------------------------------------------------------------------------
const jkse = (await yahooSeries(INDEX_SYMBOL, `${YEARS}y`)).slice(-1300);
const idx = jkse.length > 1 ? (() => {
  const last = jkse[jkse.length - 1], prev = jkse[jkse.length - 2];
  const six = pointOnOrBefore(jkse, iso(Date.parse(last.d) - 182 * DAY));
  const jan = jkse.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  return {
    level: last.c, date: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null,
    series: jkse,
  };
})() : null;

// --- 6. derive ------------------------------------------------------------------------------------
// The P/E band pairs each fiscal year's EPS with the price at that period end, not the calendar year
// end: a non-December year-end would otherwise compare a December price with a June EPS.
for (const c of covered) {
  for (const r of c.annual || []) {
    const p = pointOnOrBefore(c.series || [], r.end);
    if (p) r.px = p.c;
  }
}
let out = deriveListing({ companies: covered, fx, baseCurrency: 'IDR' });

// --- 7. descriptions and sectors -------------------------------------------------------------------
// IDX's own list has no industry column and the exchange blocks the network, so the GICS sector and
// industry come from the vendor profile — the same extractor Japan, Korea, Taiwan, Hong Kong, Australia
// and India use. A company whose profile failed keeps "Other" and is counted, never guessed.
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

// --- 7b. ratios that do not exist for a bank ------------------------------------------------------
// A lender's revenue is interest income, it reports no operating-profit line, and its cash flow is loans
// and deposits — an operating margin and a free-cash-flow yield are not missing, they do not exist.
// Insurers keep their margin but lose free cash flow, because their investing flow is the portfolio.
// This is the same rule the US, Japan, Hong Kong, Australia and India pages use.
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

// --- 7c. ratios that are arithmetically valid but not meaningful -------------------------------
// A micro-cap with a negative operating profit can print an operating margin of −400% or a ROE of
// −900% on a near-zero equity base. The number reproduces, but it is not a valuation or a return a
// reader can use. The same rule Hong Kong and Australia use: withhold a P/E below 0.5× and any margin
// or ROE beyond ±500%, and keep the field blank rather than publish a figure that invites a wrong read.
let withheld = 0;
for (const c of out) {
  const na = [];
  if (c.pe != null && c.pe < 0.5) { c.pe = null; na.push('pe'); }
  if (c.opMargin != null && Math.abs(c.opMargin) > 500) { c.opMargin = null; na.push('opMargin'); }
  if (c.netMargin != null && Math.abs(c.netMargin) > 500) { c.netMargin = null; na.push('netMargin'); }
  if (c.roe != null && Math.abs(c.roe) > 500) { c.roe = null; na.push('roe'); }
  if (na.length) {
    c.naRatios = [...new Set([...(c.naRatios || []), ...na])];
    withheld++;
  }
}
if (withheld) console.log(`  ${withheld} companies with a ratio outside the published range — withheld`);

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
  foreignReporters: out.filter((c) => (c.reportCurrency || 'IDR') !== 'IDR').length,
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
// The curated file lists `tickers`; a name that is not in the IDX universe is dropped and the theme is
// dropped with it if nothing is left.
const themes = (themeBook.themes || []).map((t) => ({
  ...t,
  tickers: (t.tickers || []).filter((x) => known.has(pad(x))).map(pad),
})).filter((t) => t.tickers.length);

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
  quoted: uni.quoted || listed.length + excluded.length,
  excludedNonCompanies: excluded.length,
  excluded: excluded.slice(0, 40).map((r) => ({ code: r.code, name: r.name })),
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
  stale: stale.length,
  staleCodes: stale.map((c) => ({ code: c.code, name: c.name, end: c.ttmEnd || c.latestEnd || null })),
  dropped: dropped.slice(0, 40),
  sectors: market.sectors.length,
  resolvedFromProfile: cleaned.filter((c) => c.sectorSource === 'profile-gics-sector').length,
  pe: cleaned.filter((c) => c.pe != null).length,
  pb: cleaned.filter((c) => c.pb != null).length,
  roe: cleaned.filter((c) => c.roe != null).length,
  currentShares: cleaned.filter((c) => c.sharesCurrent > 0).length,
  netProfitTTM: cleaned.filter((c) => c.netIncomeTTM != null).length,
  financials: cleaned.filter((c) => c.financial).length,
  bankLike: cleaned.filter((c) => c.bankLike).length,
  foreignReporters: cleaned.filter((c) => c.reportCurrency !== 'IDR').length,
  noFx: fx.rate == null,
  universePages: uni.pages || 0,
  universeStale: !!uni.stale,
  // The vendor's own headline cap, compared with ours. A gap is a stale share count or a different
  // share class — an input no formula check can catch — and is reported rather than hidden.
  vendorCap: (() => {
    const rows = listed.filter((c) => c.vendorCap > 0);
    const gaps = [];
    for (const c of cleaned) {
      const v = listed.find((x) => x.code === c.code);
      if (!v || !(v.vendorCap > 0) || !(c.marketCap > 0)) continue;
      const gap = Math.abs(c.marketCap / v.vendorCap - 1);
      if (gap > 0.1) gaps.push({ code: c.code, gap: +(gap * 100).toFixed(1) });
    }
    return { compared: rows.length, over10pct: gaps.length, examples: gaps.slice(0, 8) };
  })(),
};

writeJson(`${OUT}.tmp`, {
  updated: new Date().toISOString(),
  universe: `IDX · ${cleaned.length} companies`,
  indexName: 'IDX Composite',
  currency: 'IDR',
  fx,
  session: cleaned.map((c) => c.priceDate).filter(Boolean).sort().pop() || null,
  market, index: idx, themes, audit, companies: cleaned,
});
renameSync(`${OUT}.tmp`, OUT);

// One-character buckets (BBCA → "B"): one chart parses a few hundred kilobytes, not the whole market.
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
  const { indonesiaList } = await import('../src/project.js');
  const list = indonesiaList({ ...JSON.parse(readFileSync(OUT, 'utf8')) });
  writeFileSync(`${LIST_OUT}.tmp`, JSON.stringify(list)); renameSync(`${LIST_OUT}.tmp`, LIST_OUT);
} catch (e) { console.log(`  list artifact: ${e.message}`); }

// One small file per company for the company page: parsing the whole market for one record costs the
// free instance ~50 MB.
rmSync(DETAIL_DIR, { recursive: true, force: true });
mkdirSync(DETAIL_DIR, { recursive: true });
for (const c of cleaned) writeFileSync(join(DETAIL_DIR, `${c.code}.json`), JSON.stringify(c));

// Re-index the per-company chart store so a chart never has to parse a whole bucket again.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'id'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }

try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'attach-market-brands.mjs'), 'id'], { stdio: 'inherit' }); }
catch (e) { console.log(`  brands: ${e.message}`); }

console.log(`${cleaned.length} companies · ${market.medianPe ?? '—'} median P/E · ${withDesc} descriptions · IDX Composite ${idx ? Math.round(idx.level) : '—'} · USD/IDR ${fx.rate}`);
console.log(`${dropped.length} without statements · ${noPrice.length} without a price · ${market.foreignReporters} report in another currency · ${market.sectors.length} sectors`);
console.log(cleaned.slice(0, 5).map((c) => `  ${c.code} ${c.nameEn || c.name} · Rp${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'} · ${c.reportCurrency}`).join('\n'));
