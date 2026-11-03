// Build the Australia dataset: every ASX-listed company.
//
//   node scripts/build-australia.mjs                         full run (all listed companies, five years)
//   node scripts/build-australia.mjs --limit=30              smoke test
//   node scripts/build-australia.mjs --codes=BHP,CBA,PLS     named companies
//   node scripts/build-australia.mjs --skip-prices           reuse the cached daily files
//   node scripts/build-australia.mjs --skip-fin              reuse the statements already in the file
//
// Sources:
//   - ASX listed-companies CSV: the universe, the exchange short name and the GICS industry group.
//   - Yahoo (https.get — undici's fingerprint is rejected): five years of daily closes for {CODE}.AX,
//     and the S&P/ASX 200 (^AXJO).
//   - stockanalysis.com (ASX): English statements, annual and half-year, plus the diluted share count
//     and the dividend per share. Values are in millions of the report currency, which is USD for BHP
//     and RIO and occasionally EUR/GBP — the statement currency is carried into derivation so an AUD
//     market cap is never divided by a USD profit.
//   - open.er-api.com: one USD table; the AUD cross and every report-currency cross are read from it.
//
// Output: data/australia.json (records + reports), data/australia-series/{X}.json (daily and weekly
// closes, bucketed by the first character of the code), data/australia-list.json (the compact
// /api/australia payload).

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { join } from 'node:path';
import {
  ROOT, AU_CACHE, AU_SA, asxCsv, sectorOf, isNotApplic, isUnclassified, isFundLine, pad, saPage, saUsPage, US_CROSS, yaSymbol,
} from './asx.mjs';
import {
  sleep, readJson, writeJson, getCached, parseSaTable, rowOf, periodFromTitle, statementCurrency,
} from './stockanalysis.mjs';
import { deriveListing } from './derive-listing.mjs';

const OUT = join(ROOT, 'data', 'australia.json');
const SERIES_DIR = join(ROOT, 'data', 'australia-series');
const LIST_OUT = join(ROOT, 'data', 'australia-list.json');
const DETAIL_DIR = join(ROOT, 'data', 'australia-companies');
const PROFILES = join(ROOT, 'data', 'australia-profiles.json');
const THEMES = join(ROOT, 'data', 'australia-themes.json');
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
// A stockanalysis build is a long crawl of one host. `--pace=N` is the pause after each company; a
// blocked host is handled inside stockanalysis.mjs (three push-backs → a 90 s quiet period).
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
console.log('ASX listed-companies CSV…');
const csv = await asxCsv({ fresh: flag('fresh') });
const listed = csv.rows.map((r) => ({
  code: pad(r.code),
  ticker: pad(r.code),
  name: r.name,
  gicsIndustryGroup: r.gicsIndustryGroup,
}));
// ETFs, listed investment companies and debt trusts are in the CSV but are not companies. Count them.
const excluded = listed.filter((c) => isFundLine(c.name)).map((c) => ({ code: c.code, name: c.name }));
const companies = listed.filter((c) => !isFundLine(c.name));
console.log(`  ${csv.rows.length} listed lines · ${excluded.length} ETFs/funds/trusts excluded · ${companies.length} companies${csv.banner ? ` · ${csv.banner}` : ''}`);

let universe = CODES.length ? companies.filter((c) => CODES.includes(c.code)) : (LIMIT ? companies.slice(0, LIMIT) : companies);

// --- 2. Yahoo price history -----------------------------------------------------------------------
const YH_CACHE = join(AU_CACHE, 'yahoo');
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

// The ASX has no daily price limit: a small cap can legitimately double in a session. So the guard is
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
    const raw = await yahooSeries(yaSymbol(c.code));
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
      const f = join(YH_CACHE, `${yaSymbol(c.code)}.json`);
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
  c.price = +last.c.toFixed(3);
  c.priceDate = last.d;
}
console.log(`  ${universe.filter((c) => c.series && c.series.length > 1).length} codes with a history · ${universe.filter((c) => c.price > 0).length} priced`);
// A useful two-phase run on a throttled day: warm every Yahoo series now, run the statements later.
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
  // Total equity includes non-controlling interests; common equity does not. P/B and ROE are about the
  // ordinary shareholder, so the common figure is the one the ratios use (total is kept for display).
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
  const rev = rowOf(t, ['Revenue', 'Total Revenue', 'Operating Revenue']);
  const op = rowOf(t, ['Operating Income']);
  const ni = rowOf(t, ['Net Income to Common', 'Net Income']);
  const cols = t.cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id)).slice(0, 8).reverse();
  return cols.map((c) => ({
    d: c.id, revenue: scale(rev && rev.values[c.id]), operatingProfit: scale(op && op.values[c.id]), netIncome: scale(ni && ni.values[c.id]),
  }));
}

// The ASX pages have no "TTM" column in the annual table: stockanalysis serves the rolling twelve
// months on the `?p=trailing` view, one column per period end, newest first. The latest column is the
// current TTM — the same window the vendor's own P/E uses — so the ratios are trailing, not last FY.
function latestColumn(html) {
  const t = parseSaTable(html);
  const col = t.cols.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id));
  if (!col) return null;
  const get = (row) => (row ? row.values[col.id] : null);
  return { t, id: col.id, get };
}
function trailingIncomeOf(html) {
  const L = latestColumn(html);
  if (!L) return null;
  const { t, id, get } = L;
  const rev = rowOf(t, ['Revenue', 'Total Revenue', 'Operating Revenue']);
  const op = rowOf(t, ['Operating Income']);
  const ni = rowOf(t, ['Net Income to Common', 'Net Income']);
  const eps = rowOf(t, ['EPS (Diluted)', 'EPS (Basic)']);
  const sh = rowOf(t, ['Shares Outstanding (Diluted)', 'Diluted Shares Outstanding', 'Shares Outstanding (Basic)', 'Basic Shares Outstanding', 'Shares Outstanding']);
  const dps = rowOf(t, ['Dividend Per Share']);
  return {
    end: id,
    ttm: {
      revenue: scale(get(rev)), operatingProfit: scale(get(op)), netIncome: scale(get(ni)),
      eps: perShare(get(eps)), shares: scale(get(sh)), dividendPerShare: perShare(get(dps)),
    },
    periods: quartersOf(html),
  };
}
function trailingBalanceOf(html) {
  const L = latestColumn(html);
  if (!L) return null;
  const { t, id, get } = L;
  const a = rowOf(t, ['Total Assets']);
  const l = rowOf(t, ['Total Liabilities']);
  const et = rowOf(t, ['Total Equity', "Shareholders' Equity", 'Total Stockholders Equity']);
  const ec = rowOf(t, ['Total Common Equity', 'Total Stockholders Equity', 'Stockholders Equity', 'Common Equity', 'Total Equity', "Shareholders' Equity"]);
  return {
    end: id,
    latest: {
      assets: scale(get(a)), liabilities: scale(get(l)),
      equity: scale(get(et || ec)), equityCommon: scale(get(ec || et)),
    },
  };
}
async function page(code, p, q = false) {
  const f = join(AU_SA, `${code}-${p}${q ? '-t' : ''}.json`);
  // A 404 returns null (the page genuinely does not exist); throttling throws, and the caller marks the
  // company so the audit can say "not fetched this run" instead of "no statements".
  return getCached(saPage(code, p, q), f, { ttlMs: q ? TTL_Q : TTL_FIN, timeout: 30000, retries: 6 });
}
async function usPage(ticker, p, q = false) {
  const f = join(AU_SA, `us-${ticker}-${p}${q ? '-q' : ''}.json`);
  return getCached(saUsPage(ticker, p, q), f, { ttlMs: q ? TTL_Q : TTL_FIN, timeout: 30000, retries: 6 });
}

if (!SKIP_FIN) {
  console.log('financials…'); let done = 0, miss = 0;
  const finWorkers = Number(arg('fin-workers', SKIP_PRICES ? 6 : 2)) || (SKIP_PRICES ? 6 : 2);
  await pool(universe, finWorkers, async (c) => {
    try {
      // Sequential, not Promise.all: five simultaneous requests per worker is a burst the source
      // reads as a scraper. One page at a time with the global pace stays under the limit.
      let inc = await page(c.code, 'income-statement');
      let bal = await page(c.code, 'balance-sheet');
      let csh = await page(c.code, 'cash-flow-statement');
      let tinc = await page(c.code, 'income-statement', true);
      let tbal = await page(c.code, 'balance-sheet', true);
      let cross = null;
      // A CDI / dual-listed line with no ASX statement page: read the same company's primary US
      // listing, and scale the share count by the CDI ratio so the ASX price still gives the cap.
      if (!inc && US_CROSS[c.code]) {
        cross = US_CROSS[c.code];
        inc = await usPage(cross.ticker, 'income-statement');
        bal = await usPage(cross.ticker, 'balance-sheet');
        csh = await usPage(cross.ticker, 'cash-flow-statement');
        tinc = await usPage(cross.ticker, 'income-statement', true);
        tbal = null;
      }
      const I = incomeOf(inc), B = balanceOf(bal), C = cashOf(csh);
      const TI = cross ? null : trailingIncomeOf(tinc), TB = cross ? null : trailingBalanceOf(tbal);
      const annual = new Map();
      const add = (end, obj) => { if (!annual.has(end)) annual.set(end, { end }); Object.assign(annual.get(end), obj); };
      for (const r of I.annual) add(r.end, r);
      for (const r of B.annual) add(r.end, r);
      for (const r of C.annual) add(r.end, r);
      // The trailing view is the TTM window. Fall back to the latest annual row on a company whose
      // vendor page has no trailing table (then peBasis says FY, never "TTM" for an annual number).
      c.ttm = { ...((cross ? I.ttm : (TI && TI.ttm) || I.ttm) || {}), ...(C.ttm || {}) };
      c.ttmEnd = cross ? I.ttmEnd : ((TI && TI.end) || I.ttmEnd || C.ttmEnd || null);
      c.latest = cross ? (B.latest || {}) : ((TB && TB.latest) || B.latest || {});
      c.latestEnd = cross ? B.ttmEnd : ((TB && TB.end) || B.ttmEnd || null);
      c.annual = [...annual.values()].filter((r) => r.revenue != null || r.equity != null).sort((a, b) => a.end.localeCompare(b.end));
      c.quarters = cross ? quartersOf(tinc) : ((TI && TI.periods) || quartersOf(tinc));
      c.reportCurrency = I.currency || (cross ? 'USD' : 'AUD');
      // Shares come from the filing, not from a divisor: diluted shares are the count the EPS row uses.
      const rawShares = (cross ? (I.ttm && I.ttm.shares) : (TI && TI.ttm.shares)) || (I.ttm && I.ttm.shares) || (c.annual.length ? c.annual[c.annual.length - 1].shares : null) || null;
      c.shares = rawShares != null && cross ? rawShares * cross.ratio : rawShares;
      if (cross) {
        c.crossListing = { market: 'us', ticker: cross.ticker.toUpperCase(), ratio: cross.ratio, note: cross.note };
        c.sharesBasis = cross.ratio === 1 ? 'filing (same ordinary shares)' : `filing × ${cross.ratio} (CDI ratio)`;
        c.periodBasis = 'quarter';
        // The ASX price is per CDI. One global share is `ratio` CDIs, so per-share figures (EPS, DPS)
        // must be divided by the ratio before they are compared with that price; otherwise the P/E
        // band and the dividend yield are off by the CDI ratio (RMD's yield read 10.5%, not 1.05%).
        if (cross.ratio !== 1) {
          const d = cross.ratio;
          if (c.ttm) {
            if (c.ttm.eps != null) c.ttm.eps /= d;
            if (c.ttm.dividendPerShare != null) c.ttm.dividendPerShare /= d;
          }
          for (const r of c.annual) {
            if (r.eps != null) r.eps /= d;
            if (r.dividendPerShare != null) r.dividendPerShare /= d;
          }
          c.perShareBasis = `per CDI (1/${d} share)`;
        }
      }
    } catch (e) {
      if (e && e.throttled) {
        c.throttled = true;
        // The source is blocking us, not missing the page. Go quiet rather than sprint through the
        // rest of the market marking every company "throttled": the pages are not cached as misses, so
        // a later run fills them, and this run's output stays honest either way.
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
    c.reportCurrency = p.reportCurrency || 'AUD';
    c.shares = p.shares || null;
    // A cross-listed line's provenance must survive the cache rebuild, or the company page stops
    // saying that the statements are the NYSE listing's and the audit reports "none".
    c.crossListing = p.crossListing || null;
    c.periodBasis = p.periodBasis || null;
    c.sharesBasis = p.sharesBasis || null;
  }
}

// A company without a statement page has no share count, so it cannot have a market cap. A company
// without a Yahoo price cannot have a cap either. Both are counted and named, never estimated.
const throttled = universe.filter((c) => c.throttled);
const covered = universe.filter((c) => c.shares > 0 && c.price > 0);
const dropped = universe.filter((c) => !(c.shares > 0) && !c.throttled).map((c) => ({ code: c.code, name: c.name }));
const noPrice = universe.filter((c) => c.shares > 0 && !(c.price > 0)).map((c) => ({ code: c.code, name: c.name }));
if (dropped.length) console.log(`  ${dropped.length} listed companies without a statement page (no shares, no cap)`);
if (noPrice.length) console.log(`  ${noPrice.length} companies without a price (no cap; excluded rather than estimated)`);
if (throttled.length) console.log(`  ${throttled.length} companies throttled this run — rerun the build to fill them (nothing was cached as missing)`);

// --- 4. FX ----------------------------------------------------------------------------------------
// One USD table gives the AUD cross and every report-currency cross. A missing table leaves the ratios
// of foreign reporters blank, not wrong.
let fx = { pair: 'USDAUD', rate: null, date: iso(Date.now()), rates: null };
try {
  const f = join(AU_CACHE, 'er-usd.json');
  const text = await getCached('https://open.er-api.com/v6/latest/USD', f, { ttlMs: TTL_DAY, retries: 3 });
  const j = JSON.parse(text);
  const rates = j && j.rates ? Object.fromEntries(Object.entries(j.rates).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) : null;
  if (rates && rates.AUD > 0) {
    fx = { pair: 'USDAUD', rate: +rates.AUD.toFixed(4), date: (j.time_last_update_utc ? iso(Date.parse(j.time_last_update_utc)) : iso(Date.now())), rates };
  }
} catch { /* fx stays null; foreign reporters get no ratios */ }

// --- 5. the S&P/ASX 200 ---------------------------------------------------------------------------
const axjo = (await yahooSeries('^AXJO', `${YEARS}y`)).slice(-1300);
const idx = axjo.length > 1 ? (() => {
  const last = axjo[axjo.length - 1], prev = axjo[axjo.length - 2];
  const six = pointOnOrBefore(axjo, iso(Date.parse(last.d) - 182 * DAY));
  const jan = axjo.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  return {
    level: last.c, date: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null,
    series: axjo,
  };
})() : null;

// --- 6. derive ------------------------------------------------------------------------------------
// The P/E band pairs each fiscal year's EPS with the price at that year end, not the calendar year end:
// a June-year company would otherwise compare a December price with a June EPS.
for (const c of covered) {
  for (const r of c.annual || []) {
    const p = pointOnOrBefore(c.series || [], r.end);
    if (p) r.px = p.c;
  }
}
let out = deriveListing({ companies: covered, fx, baseCurrency: 'AUD' });

// --- 7. English names, descriptions and sectors ---------------------------------------------------
const profiles = readJson(PROFILES) || { entries: {} };
let withDesc = 0;
for (const c of out) {
  const p = profiles.entries && profiles.entries[c.code];
  c.nameEn = (p && p.name) || c.name;
  c.nameFull = (p && p.legal) || null;
  c.description = (p && p.desc) || null;
  // "Not Applic" is a real CSV value for ~300 rows. The profile's GICS sector resolves it; "Other" is
  // the last resort. The raw group stays on the record so the audit can count what was resolved.
  c.sector = sectorOf(c.gicsIndustryGroup, p && p.sector);
  c.sectorSource = !isUnclassified(c.gicsIndustryGroup) ? 'asx-gics-group' : (p && p.sector ? 'profile-gics-sector' : 'other');
  c.industry = (p && p.industry) || null;
  if (c.description) withDesc++;
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
  advancing: out.filter((c) => (c.chg1d || 0) > 0).length,
  declining: out.filter((c) => (c.chg1d || 0) < 0).length,
  upYtd: out.filter((c) => (c.chgYtd || 0) > 0).length,
  foreignReporters: out.filter((c) => c.reportCurrency !== 'AUD').length,
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
  tickers: (t.tickers || []).filter((x) => have.has(pad(x))),
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

const audit = {
  quoted: csv.rows.length,
  excludedNonCompanies: excluded.length,
  excluded: excluded.slice(0, 40),
  companies: companies.length,
  considered: universe.length,
  withStatements: cleaned.length,
  withoutStatements: dropped.length,
  noStatements: dropped,
  withoutPrice: noPrice.length,
  noPrice,
  throttled: throttled.length,
  dropped: dropped.slice(0, 40),
  notApplicSectors: cleaned.filter((c) => isNotApplic(c.gicsIndustryGroup)).length,
  classPending: cleaned.filter((c) => String(c.gicsIndustryGroup || '').trim() === 'Class Pend').length,
  resolvedFromProfile: cleaned.filter((c) => c.sectorSource === 'profile-gics-sector').length,
  pe: cleaned.filter((c) => c.pe != null).length,
  pb: cleaned.filter((c) => c.pb != null).length,
  foreignReporters: cleaned.filter((c) => c.reportCurrency !== 'AUD').length,
  noFx: fx.rate == null,
};

writeJson(`${OUT}.tmp`, {
  updated: new Date().toISOString(),
  universe: `ASX listed companies · ${cleaned.length} companies`,
  currency: 'AUD',
  fx,
  session: csv.banner || null,
  market, index: idx, themes, audit,
  companies: cleaned,
});
renameSync(`${OUT}.tmp`, OUT);

// One-character buckets (BHP → "B", 14D → "1"): one chart parses a few hundred kilobytes, not the
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
  const { australiaList } = await import('../src/project.js');
  const list = australiaList({ ...JSON.parse(readFileSync(OUT, 'utf8')) });
  writeFileSync(`${LIST_OUT}.tmp`, JSON.stringify(list)); renameSync(`${LIST_OUT}.tmp`, LIST_OUT);
} catch (e) { console.log(`  list artifact: ${e.message}`); }

// One small file per company for the company page. Parsing the 8 MB dataset for one record costs the
// free Render instance ~50 MB; on a 512 MB box that (plus the chart buckets) was enough to OOM and
// turn company pages into 502s. The detail endpoint reads only this file.
rmSync(DETAIL_DIR, { recursive: true, force: true });
mkdirSync(DETAIL_DIR, { recursive: true });
for (const c of cleaned) writeFileSync(join(DETAIL_DIR, `${c.code}.json`), JSON.stringify(c));

// Re-index the per-company chart store so a chart never has to parse a whole bucket again.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'au'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }

// Curated brands are not in the exchange feed; attach them after the rebuild so search keeps
// resolving "Bunnings" or "Penfolds" to the listed company instead of losing the tags.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'attach-market-brands.mjs'), 'au'], { stdio: 'inherit' }); }
catch (e) { console.log(`  brands: ${e.message}`); }

console.log(`${cleaned.length} companies · ${audit.pe} P/E · ${withDesc} descriptions · ASX 200 ${idx ? idx.level : '—'} · USD/AUD ${fx.rate}`);
console.log(`${dropped.length} without statements · ${noPrice.length} without a price · ${audit.foreignReporters} report in a currency other than AUD · ${audit.notApplicSectors} "Not Applic" sectors resolved`);
console.log(cleaned.slice(0, 5).map((c) => `  ${c.code} ${c.nameEn || c.name} · A$${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'} · ${c.reportCurrency}`).join('\n'));
