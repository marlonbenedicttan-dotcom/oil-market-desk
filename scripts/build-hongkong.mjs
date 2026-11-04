// Build the Hong Kong dataset: every HKEX main-board listed company.
//
//   node scripts/build-hongkong.mjs                         full run (all listed companies, five years)
//   node scripts/build-hongkong.mjs --limit=30 --days=400   smoke test
//   node scripts/build-hongkong.mjs --codes=0700,9988       named companies
//   node scripts/build-hongkong.mjs --skip-prices           reuse the cached daily files
//   node scripts/build-hongkong.mjs --skip-fin              reuse the statements already in the file
//   node scripts/build-hongkong.mjs --fresh-report          refetch just the newest HKEX report page
//
// `--fresh` refetches every statement page too, which is a cold crawl. The scheduled job wants the
// opposite: a fresh exchange report (the page is occasionally posted incomplete and then corrected)
// with the statement and price caches intact — that is `--fresh-report`.
//
// Sources:
//   - HKEX daily quotation report: the universe, the day's official close and the previous close.
//   - Yahoo (https.get — undici's fingerprint is rejected): five years of daily closes, and the
//     Hang Seng Index.
//   - stockanalysis.com (HKG): English statements, annual and quarterly, plus the diluted share count
//     and the dividend per share. Values are in millions of the report currency, which is CNY or USD
//     for a mainland or international issuer — the statement currency is carried into derivation so a
//     HKD market cap is never divided by a CNY profit.
//   - open.er-api.com: USD/HKD and USD/CNY (the ECB does not publish intraday crosses for either).
//
// Output: data/hongkong.json (records + reports), data/hongkong-series/{NN}.json (daily and weekly
// closes, bucketed by the first two code digits), data/hongkong-list.json (the compact /api/hongkong
// payload).

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { join } from 'node:path';
import {
  ROOT, HK_CACHE, HK_SA, latestDaily, readDaily, parseQuotations, isCompanyRow, pad4,
  saPage, yahooSymbol,
} from './hkex.mjs';
import {
  UA, sleep, readJson, writeJson, getCached, parseSaTable, rowOf, periodFromTitle, statementCurrency,
  cleanListingName,
} from './stockanalysis.mjs';
import { deriveHongKong } from './derive-hongkong.mjs';

const OUT = join(ROOT, 'data', 'hongkong.json');
const SERIES_DIR = join(ROOT, 'data', 'hongkong-series');
const LIST_OUT = join(ROOT, 'data', 'hongkong-list.json');
const DETAIL_DIR = join(ROOT, 'data', 'hongkong-companies');
const PROFILES = join(ROOT, 'data', 'hongkong-profiles.json');
const CROSSLIST = join(ROOT, 'data', 'hongkong-crosslist.json');
// A Hong Kong code whose HKG statement page does not exist is served from the company's other listing
// (HSBC → LON:HSBA, Ping An → OTC:PNGAY). The statements and the share count are the company's own, in
// its own reporting currency, so the cap is still Hong Kong price × total shares.
const CROSS = (readJson(CROSSLIST) || {}).entries || {};
const listingOf = (code) => (CROSS[code] ? `${CROSS[code].exchange}/${CROSS[code].code}` : `hkg/${code}`);
const THEMES = join(ROOT, 'data', 'hongkong-themes.json');
const HSI_FILE = join(ROOT, 'data', 'hongkong-hsi.json');
const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const arg = (k, d = null) => { const x = process.argv.find((a) => a.startsWith(`--${k}=`)); return x ? x.split('=')[1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);

const LIMIT = Number(arg('limit', 0)) || 0;
const CODES = (arg('codes', '') || '').split(',').map((s) => s.trim()).filter(Boolean).map((c) => pad4(c));
const YEARS = Number(arg('years', 5)) || 5;
const SKIP_PRICES = flag('skip-prices');
// --cached-only parses only the statement pages already on disk and never touches the network. That
// is how a partial build becomes a usable, honestly-labelled market in seconds while the tail is
// still being fetched in the background.
const CACHED_ONLY = flag('cached-only');
// --fast fetches only the two pages the market actually needs: the income statement (revenue, profit,
// EPS, dividend per share, free cash flow, share count) and the balance sheet (assets, liabilities,
// equity). The cash-flow and quarterly pages add the CFO/CFI split and the period table, at 2× the
// requests — worth it for a full build, not for finishing a throttled tail.
const FAST = flag('fast');
const coveredCount = () => universe.filter((c) => c.shares > 0).length;
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

// --- 1. the universe ------------------------------------------------------------------------------
console.log('HKEX daily quotation report…');
// `--daily=YYYY-MM-DD` pins the session. That matters when the exchange has posted a file that is
// still incomplete: on 2026-11-03 the 7,305-line page omitted 147 live companies that the 11-02
// report carried. A pinned build uses the complete session instead of silently shrinking the universe.
const PINNED_DAILY = arg('daily', null);
// A cached report is normally trusted, but the exchange sometimes posts one incomplete and replaces it
// later. The scheduled job asks for the newest page every run without paying for a full refetch.
const FRESH_REPORT = FRESH || flag('fresh-report');
const daily = PINNED_DAILY ? null : (FRESH_REPORT ? await latestDaily({ fresh: true }) : await latestDaily());
const dailyText = PINNED_DAILY ? readDaily(PINNED_DAILY) : (daily && daily.text);
if (!dailyText) {
  console.error('No HKEX daily report available (network and cache both empty).');
  process.exit(1);
}
const sessionDate = PINNED_DAILY || (daily && daily.date);
const quoted = parseQuotations(dailyText);
const companies = quoted.filter(isCompanyRow).map((r) => ({
  code: pad4(r.hkexCode),
  ticker: pad4(r.hkexCode),
  hkexCode: r.hkexCode,
  name: r.name,
  // The report's close is already rounded to the exchange's own tick; the Yahoo series is not, so the
  // price is normalised when it replaces this one below.
  price: +r.close.toFixed(3),
  priceDate: sessionDate,
  prevClose: r.prevClose,
  turnover: r.turnover || 0,
}));
console.log(`  ${quoted.length} quoted lines · ${companies.length} main-board companies`);
console.log(`  session ${sessionDate}`);

let universe = CODES.length ? companies.filter((c) => CODES.includes(c.code)) : (LIMIT ? companies.slice(0, LIMIT) : companies);

// --- 2. Yahoo price history -----------------------------------------------------------------------
const YH_CACHE = join(HK_CACHE, 'yahoo');
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
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
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

// Hong Kong has no daily price limit: a small cap can legitimately double in a session. So the guard is
// narrow — a jump beyond ±60% that completely reverses within three sessions is a bad print and is
// flattened. A move that holds is left alone: Yahoo's closes are already split-adjusted, so it is a
// real corporate action or a real move, and inventing an adjustment would fake history.
function sanitizeSeries(series) {
  const s = series.map((p) => ({ d: p.d, c: p.c }));
  let fixed = 0;
  for (let i = 5; i < s.length; i++) {
    const r = s[i].c / s[i - 1].c;
    if (r <= 1.6 && r >= 0.4) continue;
    const pre = s[i - 1].c;
    let reverses = false;
    for (let j = i + 1; j <= Math.min(i + 3, s.length - 1); j++) {
      if (Math.abs(s[j].c / pre - 1) < 0.2) { reverses = true; break; }
    }
    if (reverses) { s[i].c = pre; fixed++; }
  }
  return { s, adjustments: fixed };
}

if (!SKIP_PRICES) {
  console.log(`prices… ${universe.length} codes, ${YEARS}y daily (Yahoo)`);
  let done = 0;
  const workers = Number(arg('price-workers', 3)) || 3;
  await pool(universe, workers, async (c) => {
    const raw = await yahooSeries(yahooSymbol(c.code));
    if (raw.length > 1) {
      const clean = sanitizeSeries(raw);
      c.series = clean.s;
      c.priceSource = 'yahoo';
      c.priceAdjusted = clean.adjustments || 0;
    }
    if (++done % 100 === 0) console.log(`  ${done}/${universe.length} codes`);
    await sleep(120);
  });
} else {
  for (const c of universe) {
    try {
      const f = join(YH_CACHE, `${yahooSymbol(c.code)}.json`);
      if (existsSync(f)) {
        const s = JSON.parse(JSON.parse(readFileSync(f, 'utf8')).text);
        if (s && s.length > 1) {
          const clean = sanitizeSeries(s);
          c.series = clean.s; c.priceSource = 'yahoo'; c.priceAdjusted = clean.adjustments || 0;
          continue;
        }
      }
    } catch { /* fall through */ }
  }
}
for (const c of universe) {
  if (!c.series || !c.series.length) c.series = [{ d: c.priceDate, c: c.price }];
  const last = c.series[c.series.length - 1];
  c.price = +last.c.toFixed(3);
  c.priceDate = last.d;
}
console.log(`  ${universe.filter((c) => c.series.length > 1).length} codes with a history`);

const pointOnOrBefore = (s, d) => { let hit = null; for (const p of s) { if (p.d > d) break; hit = p; } return hit; };
for (const c of universe) {
  const s = c.series;
  const last = s[s.length - 1], prev = s.length > 1 ? s[s.length - 2] : null;
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
  // Total equity includes non-controlling interests; common equity does not. P/B and ROE use common.
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
// A deliberate gap between statement pages. The source rate-limits per IP and a burst earns a much
// longer penalty than the gap costs, so the build paces itself rather than sprinting into a 429 wall.
const PAGE_GAP = Number(arg('page-gap', 120)) || 120;
// A Cloudflare challenge answers HTTP 200 with a page that has no statement table. Caching that as a
// company page is how HSBC and Alibaba disappeared from the first build: the company looked like it had
// "no statements" when in fact the source had never answered. A real financials page always carries the
// table header id="TTM" and a "Financials in millions XXX" line.
// Annual pages carry a TTM column; quarterly pages have only dated columns (2026-09-30 …). Both are
// real statement pages, so the check is "a statement table with dated or TTM headers", not "has TTM".
const looksLikeStatement = (html) => !!html
  && /Financials in millions [A-Z]{3}/.test(html)
  && /<th[^>]*id="(TTM|\d{4}-\d{2}-\d{2})"/.test(html);

// The cache key carries the listing, because the HKG page for a cross-listed company is a cached 404
// and would otherwise short-circuit the fetch from its London/A-share/OTC page.
const cacheKey = (code, p, q) => `${CROSS[code] ? `${CROSS[code].exchange}-${CROSS[code].code}` : code}-${p}${q ? '-q' : ''}`;
async function page(code, p, q = false) {
  const f = join(HK_SA, `${cacheKey(code, p, q)}.json`);
  if (CACHED_ONLY) {
    const hit = existsSync(f) ? readJson(f) : null;
    return hit && hit.text && looksLikeStatement(hit.text) ? hit.text : null;
  }
  // Read a warm page before taking the inter-request pause. The pause is there to protect the source
  // from a crawler; making a cached company pay it too turned a 4-minute resume into an hour. A fresh
  // page still waits its turn below.
  const ttl = q ? TTL_Q : TTL_FIN;
  if (!FRESH && existsSync(f)) {
    const hit = readJson(f);
    if (hit && hit.text && looksLikeStatement(hit.text) && hit.fetched && Date.now() - Date.parse(hit.fetched) < ttl) return hit.text;
    if (hit && hit.notFound && hit.fetched && Date.now() - Date.parse(hit.fetched) < 7 * DAY) return null;
  }
  if (PAGE_GAP > 0) await sleep(PAGE_GAP);
  // A 404 returns null (the page genuinely does not exist); throttling throws, and the caller marks the
  // company so the audit can say "not fetched this run" instead of "no statements".
  // Build the URL for the listing that owns the statements — a replace() on the HKG URL left the Hong
  // Kong code in the path, so every cross-listed fetch 404'd.
  const url = `https://stockanalysis.com/quote/${listingOf(code)}/financials/${p}/${q ? '?p=quarterly' : ''}`;
  const html = await getCached(url, f, { ttlMs: q ? TTL_Q : TTL_FIN, timeout: 30000, retries: 6 });
  if (html && !looksLikeStatement(html)) {
    try { unlinkSync(f); } catch { /* already gone */ }
    const err = new Error('challenge page, not a statement');
    err.throttled = true;
    throw err;
  }
  return html;
}

if (!SKIP_FIN) {
  // Busiest first: a build that is interrupted (or rate-limited) has then covered the companies a reader
  // is most likely to open, and the audit says exactly how much of the market is still missing.
  universe.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  console.log('financials… (busiest first)'); let done = 0, miss = 0;
  const finWorkers = Number(arg('fin-workers', SKIP_PRICES ? 6 : 2)) || (SKIP_PRICES ? 6 : 2);
  await pool(universe, finWorkers, async (c) => {
    try {
      // One page at a time, not four at once. A four-request burst per company is what earned the
      // challenge pages; the cached pages return instantly, so serialising costs little and keeps the
      // source answering.
      const inc = await page(c.code, 'income-statement');
      const bal = await page(c.code, 'balance-sheet');
      const csh = FAST ? null : await page(c.code, 'cash-flow-statement');
      const qinc = FAST ? null : await page(c.code, 'income-statement', true);
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
      c.reportCurrency = I.currency || 'HKD';
      if (CROSS[c.code]) c.statementsFrom = `${CROSS[c.code].exchange.toUpperCase()}:${CROSS[c.code].code}`;
      // Shares come from the filing, not from a divisor: diluted shares are the count the EPS row uses.
      c.shares = (I.ttm && I.ttm.shares) || (c.annual.length ? c.annual[c.annual.length - 1].shares : null) || null;
    } catch (e) {
      if (e && e.throttled) c.throttled = true;
      else miss++;
      c.ttm = null; c.latest = {}; c.annual = []; c.quarters = []; c.shares = null;
    }
    if (++done % 25 === 0) console.log(`  ${done}/${universe.length} companies`);
    await sleep(150);
  });
  console.log(`  ${coveredCount()} with a usable statement set · ${miss} failed this run`);
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
    c.reportCurrency = p.reportCurrency || 'HKD';
    c.shares = p.shares || null;
  }
}

// --- current shares (vendor statistics page) ------------------------------------------------------
// The statement's diluted count is a period weighted average; a placement or buyback after the
// period end would leave the cap (and P/E, P/B) stale. This side file is written by
// `fetch-listing-shares.mjs`; fall back to the filing count when it has no entry.
const SHARES = (readJson(join(ROOT, 'data', 'hongkong-shares.json')) || {}).entries || {};
// SEC cover counts are the official point-in-time count for ADRs whose HKG statistics page is n/a.
// They are used only when the vendor did not supply a current count, and the basis is kept on the
// record so the company page and audit can say where the number came from.
const SEC_SHARES = (readJson(join(ROOT, 'data', 'hongkong-sec-shares.json')) || {}).entries || {};
for (const c of universe) {
  const s = SHARES[c.code];
  if (s && s.shares > 0) c.sharesCurrent = s.shares;
  if (s && Number.isFinite(s.yield)) c.vendorDividendYield = s.yield;
  if (!(c.sharesCurrent > 0)) {
    const sec = SEC_SHARES[c.code];
    if (sec && sec.shares > 0) {
      c.sharesCurrent = sec.shares;
      c.sharesBasis = `SEC cover${sec.asOf ? ` · ${sec.asOf}` : ''}`;
    }
  }
}

// --- stale statements -----------------------------------------------------------------------------
// A 2014 statement on a 2026 listing is not "the latest annual result"; it is a dead shell. 450 days
// allows a June year-end company that has not yet filed the next year, but excludes delinquent ones.
const STALE_DAYS = 450;
const stale = universe.filter((c) => {
  const end = c.ttmEnd || c.latestEnd || (c.annual && c.annual.length ? c.annual[c.annual.length - 1].end : null);
  return end && (Date.parse(sessionDate) - Date.parse(end)) / DAY > STALE_DAYS;
});
for (const c of stale) c.stale = true;
if (stale.length) console.log(`  ${stale.length} companies with statements older than ${STALE_DAYS} days — excluded`);

// Four HK lines have no vendor statistics page and no usable SEC cover count (their quarterly
// primary document is the financial statements, the SEC cover is ADS, or there is no SEC filing).
// They are named and excluded rather than carried with a filing count the audit cannot defend.
const UNSOURCED = new Set(['6160', '9688', '2525', '9630']);
const unsourced = universe.filter((c) => UNSOURCED.has(c.code));
for (const c of unsourced) c.unsourced = true;
if (unsourced.length) console.log(`  ${unsourced.length} companies without a defensible current share count — excluded`);

// A company with no statement page has no share count, so it cannot have a market cap. Keeping it
// would put an unpriced row in the middle of the market aggregates; instead it is counted and named,
// never silently dropped. ETFs land here too, which is how the ones whose names do not say "ETF" go.
const throttled = universe.filter((c) => c.throttled);
const covered = universe.filter((c) => c.shares > 0 && !c.stale && !c.unsourced);
const dropped = universe.filter((c) => !(c.shares > 0) && !c.throttled && !c.stale && !c.unsourced).map((c) => ({ code: c.code, name: c.name }));
if (dropped.length) console.log(`  ${dropped.length} listed lines without a statement page (no shares, no cap)`);
if (throttled.length) console.log(`  ${throttled.length} companies throttled this run — rerun the build to fill them (nothing was cached as missing)`);

// --- 4. FX ----------------------------------------------------------------------------------------
// HKD and CNY are not in the ECB feed the macro tab uses, so the build takes one USD table and reads
// both crosses from it. A missing table leaves the ratios of foreign reporters blank, not wrong.
let fx = { pair: 'USDHKD', rate: null, date: iso(Date.now()), rates: null };
try {
  const f = join(HK_CACHE, 'er-usd.json');
  const text = await getCached('https://open.er-api.com/v6/latest/USD', f, { ttlMs: TTL_DAY, retries: 3 });
  const j = JSON.parse(text);
  // Keep every currency a Hong Kong issuer might report in, not just the two biggest: the derive step
  // needs a cross for each, and a missing one blanks that company's whole ratio set.
  const WANTED = ['HKD', 'CNY', 'USD', 'SGD', 'MYR', 'MOP', 'THB', 'CAD', 'AUD', 'JPY', 'EUR', 'GBP',
    'TWD', 'KRW', 'INR', 'IDR', 'PHP', 'VND', 'CHF', 'NZD'];
  const rates = j && j.rates ? Object.fromEntries(WANTED.filter((c) => Number(j.rates[c]) > 0).map((c) => [c, Number(j.rates[c])])) : null;
  if (rates && rates.HKD > 0) {
    fx = { pair: 'USDHKD', rate: +rates.HKD.toFixed(4), date: (j.time_last_update_utc ? iso(Date.parse(j.time_last_update_utc)) : iso(Date.now())), rates };
  }
} catch { /* fx stays null; foreign reporters get no ratios */ }

// --- 5. the Hang Seng Index -----------------------------------------------------------------------
const hsi = (await yahooSeries('^HSI', `${YEARS}y`)).slice(-1300);
const idx = hsi.length > 1 ? (() => {
  const last = hsi[hsi.length - 1], prev = hsi[hsi.length - 2];
  const six = pointOnOrBefore(hsi, iso(Date.parse(last.d) - 182 * DAY));
  const jan = hsi.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  return {
    level: last.c, date: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null,
    series: hsi,
  };
})() : null;

// --- 6. derive ------------------------------------------------------------------------------------
// The P/E band pairs each fiscal year's EPS with the price at that year end.
for (const c of covered) {
  for (const r of c.annual || []) {
    const p = pointOnOrBefore(c.series || [], r.end);
    if (p) r.px = p.c;
  }
}
let out = deriveHongKong({ companies: covered, fx });

// --- 7. English names, descriptions and sectors ---------------------------------------------------
const profiles = readJson(PROFILES) || { entries: {} };
let withDesc = 0;
for (const c of out) {
  const p = profiles.entries && profiles.entries[c.code];
  // The exchange tape occasionally prints a full stop after a name ("ETHK LABS INC."). The company
  // page shows this short name beside the ticker, so trim the punctuation rather than ship it.
  c.name = String(c.name || '').replace(/[.\s]+$/, '').trim();
  c.nameEn = cleanListingName((p && p.name) || c.name, (p && p.legal) || '');
  c.nameFull = (p && p.legal) || null;
  c.description = (p && p.desc) || null;
  c.sector = (p && p.sector) || 'Other';
  c.industry = (p && p.industry) || null;
  if (c.description) withDesc++;
}

// A company with no profile page has no description, no industry and a sector of "Other"; it adds a
// row a reader cannot interpret. Keep a large one (that is a data failure worth seeing), but drop the
// small shells: every one today is under HK$2.3B, and together they are a rounding error in the
// market. The count is published in `audit.incompleteSmall`, never silently removed.
const MIN_PROFILE_CAP = 5e9;
const incomplete = out.filter((c) => !c.description && (c.marketCap || 0) < MIN_PROFILE_CAP)
  .map((c) => ({ code: c.code, name: c.name, nameEn: c.nameEn, marketCap: c.marketCap }));
out = out.filter((c) => c.description || (c.marketCap || 0) >= MIN_PROFILE_CAP);

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
  advancing: out.filter((c) => (c.chg1d || 0) > 0).length,
  declining: out.filter((c) => (c.chg1d || 0) < 0).length,
  upYtd: out.filter((c) => (c.chgYtd || 0) > 0).length,
  foreignReporters: out.filter((c) => c.reportCurrency !== 'HKD').length,
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
  tickers: (t.tickers || []).filter((x) => have.has(pad4(x))),
}));

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

// Audit counts: the ratios that came out blank, by reason. There is no exchange-published P/E for Hong
// Kong to reconcile against (TWSE has one), so the audit is coverage, not a cross-check.
const audit = {
  quoted: quoted.length,
  commonStocks: companies.length,
  considered: universe.length,
  withStatements: cleaned.length,
  withoutStatements: dropped.length,
  stale: stale.length,
  staleCodes: stale.map((c) => ({ code: c.code, name: c.name, end: c.ttmEnd || c.latestEnd })),
  unsourced: unsourced.length,
  unsourcedCodes: unsourced.map((c) => ({ code: c.code, name: c.name, marketCap: c.marketCap })),
  currentShares: cleaned.filter((c) => c.sharesCurrent > 0).length,
  secShares: cleaned.filter((c) => /^SEC cover/.test(c.sharesBasis || '')).length,
  incompleteSmall: incomplete.length,
  incomplete: incomplete.slice(0, 40),
  throttled: throttled.length,
  dropped: dropped.slice(0, 40),
  pe: cleaned.filter((c) => c.pe != null).length,
  pb: cleaned.filter((c) => c.pb != null).length,
  foreignReporters: cleaned.filter((c) => c.reportCurrency !== 'HKD').length,
  noFx: fx.rate == null,
};

writeJson(`${OUT}.tmp`, {
  updated: new Date().toISOString(),
  universe: `HKEX main board · ${cleaned.length} listed companies`,
  currency: 'HKD',
  fx,
  session: sessionDate,
  market, index: idx, themes, audit,
  // The market overview is anchored on the index, not on our (incomplete) coverage.
  hsi: readJson(HSI_FILE) || null,
  companies: cleaned,
});
renameSync(`${OUT}.tmp`, OUT);

// Two-character buckets (0700 → "07"): one chart parses a few hundred kilobytes, not the whole market.
mkdirSync(SERIES_DIR, { recursive: true });
const bucketBook = {};
for (const kind of ['daily', 'weekly']) {
  for (const [code, arr] of Object.entries(series[kind])) {
    const b = String(code).slice(0, 2);
    if (!/^\d{2}$/.test(b)) continue;
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
  const { hongkongList } = await import('../src/project.js');
  const list = hongkongList({ ...JSON.parse(readFileSync(OUT, 'utf8')) });
  writeFileSync(`${LIST_OUT}.tmp`, JSON.stringify(list)); renameSync(`${LIST_OUT}.tmp`, LIST_OUT);
} catch (e) { console.log(`  list artifact: ${e.message}`); }

// One small file per company for the company page: parsing the 9 MB dataset for one record costs the
// free Render instance ~50 MB, which is what pushed it into OOM once Australia was added. See the
// Australia build for the same artifact.
rmSync(DETAIL_DIR, { recursive: true, force: true });
mkdirSync(DETAIL_DIR, { recursive: true });
for (const c of cleaned) writeFileSync(join(DETAIL_DIR, `${c.code}.json`), JSON.stringify(c));

// Re-index the per-company chart store so a chart never has to parse a whole bucket again.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'hk'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }

// Curated brands are not in the exchange feed; attach them after the rebuild so search keeps
// resolving "WeChat" or "Watsons" to the listed company instead of losing the tags.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'attach-market-brands.mjs'), 'hk'], { stdio: 'inherit' }); }
catch (e) { console.log(`  brands: ${e.message}`); }

console.log(`${cleaned.length} companies · ${audit.pe} P/E · ${withDesc} descriptions · HSI ${idx ? idx.level : '—'} · USD/HKD ${fx.rate}`);
console.log(`session ${sessionDate} · ${dropped.length} lines without statements · ${audit.foreignReporters} report in CNY/USD`);
console.log(cleaned.slice(0, 5).map((c) => `  ${c.code} ${c.nameEn || c.name} · HK$${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'} · ${c.reportCurrency}`).join('\n'));
