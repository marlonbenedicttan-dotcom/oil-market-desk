// Build the South Africa dataset: every company on the Johannesburg Stock Exchange (JSE).
//
//   node scripts/build-southafrica.mjs                          full run (five years)
//   node scripts/build-southafrica.mjs --limit=30               smoke test
//   node scripts/build-southafrica.mjs --codes=NPN,FSR          named companies
//   node scripts/build-southafrica.mjs --skip-prices            reuse the cached daily files
//   node scripts/build-southafrica.mjs --skip-fin               reuse the statements already in the file
//   node scripts/build-southafrica.mjs --prices-only            warm Yahoo and stop
//
// Sources:
//   - stockanalysis.com's Johannesburg exchange list: the universe (258 lines). Six lines are
//     foreign-domiciled secondary listings (CFR, PRX, ANH, ANG, BTI, GLN) whose statements come from the
//     primary exchange; six lines are excluded by decision (BHG/S32 are in the Australia market, INP
//     duplicates INL, AGL/MNP/QLT have no free statement page).
//   - Yahoo (.JO, ^J203.JO): five years of daily closes and volume, and the JSE All Share.
//   - stockanalysis.com (JSE or the primary exchange): statements, TTM, current shares, dividend yield,
//     GICS sector/profile.
//   - open.er-api.com: one USD table (USD/ZAR and every report-currency cross).
//
// The vendor's list cap is the COMPANY total in rand, and it is the authority for the cap: the JSE line
// price times a share count is not used to re-derive it. A company whose statements are older than 450
// days is excluded and named.

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { join } from 'node:path';
import {
  ROOT, ZA_CACHE, ZA_SA, jseUniverse, readUniverseSnapshot, writeUniverseSnapshot, EXCLUDED, SECONDARY,
  isSecondary, secondaryOf, pad, sourcePage, sourceStats, yaSymbol, INDEX_SYMBOL, INDEX_NAME, isFinancialSector, isBankLike,
} from './jse.mjs';
import { sleep, readJson, writeJson, getCached, parseSaTable, rowOf, periodFromTitle, statementCurrency } from './stockanalysis.mjs';
import { deriveListing } from './derive-listing.mjs';

const OUT = join(ROOT, 'data', 'southafrica.json');
const SERIES_DIR = join(ROOT, 'data', 'southafrica-series');
const LIST_OUT = join(ROOT, 'data', 'southafrica-list.json');
const DETAIL_DIR = join(ROOT, 'data', 'southafrica-companies');
const PROFILES = join(ROOT, 'data', 'southafrica-profiles.json');
const THEMES = join(ROOT, 'data', 'southafrica-themes.json');
const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const arg = (k, d = null) => { const x = process.argv.find((a) => a.startsWith(`--${k}=`)); return x ? x.split('=')[1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);

const LIMIT = Number(arg('limit', 0)) || 0;
const CODES = (arg('codes', '') || '').split(',').map((s) => pad(s)).filter(Boolean);
const YEARS = Number(arg('years', 5)) || 5;
const SKIP_PRICES = flag('skip-prices');
// The local session close, in UTC. A cache is only reusable once its last bar reaches the latest
// completed session; a 6h-old file that still ends on Friday is stale.
const CLOSE_HOUR_UTC = 15;
function lastExpectedSession(now = Date.now()) {
  const d = new Date(now);
  if (d.getUTCHours() < CLOSE_HOUR_UTC) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}
const EXPECTED_SESSION = lastExpectedSession();
const SKIP_FIN = flag('skip-fin');
const PRICES_ONLY = flag('prices-only');
const TTL_DAY = 6 * 3600e3;
const TTL_FIN = 7 * DAY;
const TTL_Q = Number(arg('quarter-cache-days', 1)) * DAY || DAY;
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
console.log('JSE exchange list…');
let uni = null;
try {
  uni = await jseUniverse({ fresh: flag('fresh') });
  writeUniverseSnapshot(uni.rows, {
    quoted: uni.quoted, pages: uni.pages,
    excluded: uni.excluded.map((r) => ({ code: r.code, reason: EXCLUDED.get(r.code) })),
    secondary: Object.fromEntries(Object.entries(SECONDARY).map(([k, v]) => [k, { exchange: v.exchange, ticker: v.ticker, market: v.market }])),
  });
  console.log(`  ${uni.quoted} rows · ${uni.excluded.length} excluded · ${uni.rows.length} companies (${uni.secondary} foreign-secondary) · ${uni.pages} page(s)`);
} catch (e) {
  const snap = readUniverseSnapshot();
  if (!snap) throw e;
  uni = { rows: snap.rows, excluded: [], quoted: snap.count, pages: 0, stale: true };
  console.log(`  list unavailable (${e.message}) — using the committed snapshot from ${String(snap.updated).slice(0, 10)}`);
}

const excluded = uni.excluded || [];
const listed = uni.rows.filter((r) => !EXCLUDED.has(r.code)).map((r) => {
  const s = secondaryOf(r.code);
  return {
    code: pad(r.code),
    ticker: pad(r.code),
    name: String(r.name || '').replace(/\s+/g, ' ').trim() || pad(r.code),
    vendorCap: r.vendorCap ?? null,
    // The exchange list quotes JSE prices in cents. It is the calibration point for the Yahoo series:
    // Yahoo is not consistent across JSE lines (most print cents, some already rand, and a few foreign
    // secondaries print a different unit), so the whole series is scaled to this last price.
    vendorPrice: r.vendorPrice ?? null,
    foreignSecondary: !!s,
    ...(s ? { secondaryExchange: s.market, secondaryCountry: s.country, secondaryTicker: s.ticker.toUpperCase(), secondarySource: `${s.exchange}:${s.ticker}` } : {}),
  };
});
console.log(`  ${listed.length} companies · ${listed.filter((c) => c.foreignSecondary).length} foreign-secondary · ${listed.filter((c) => !c.foreignSecondary).length} JSE-primary`);

let universe = CODES.length ? listed.filter((c) => CODES.includes(c.code)) : (LIMIT ? listed.slice(0, LIMIT) : listed);

// --- 2. Yahoo price history -----------------------------------------------------------------------
const YH_CACHE = join(ZA_CACHE, 'yahoo');
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
  // The cache key must carry the range. The old single key was poisoned by a 2-year fetch, so a
  // later 5-year build silently reused 500 sessions and every long chart fell back to 1Y.
  const f = join(YH_CACHE, `${symbol.replace(/[^\w.-]/g, '_')}-${String(range).replace(/[^\w.-]/g, '_')}.json`);
  if (existsSync(f)) {
    try {
      const hit = JSON.parse(readFileSync(f, 'utf8'));
      const cached = hit.text ? JSON.parse(hit.text) : null;
      const last = cached && cached.length ? cached[cached.length - 1].d : null;
      const covers = !EXPECTED_SESSION || (last && last >= EXPECTED_SESSION);
      if (hit.fetched && Date.now() - Date.parse(hit.fetched) < 6 * 3600e3 && covers) {
        const s = cached;
        if (s && (!s.length || s[0].v !== undefined)) { s.lastBar = hit.lastBar || null; return s; }
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
      const raw = ts.map((t, i) => ({ d: iso(t * 1000), c: closes[i], v: vols[i] }));
      const s = raw.filter((p) => p.c != null && p.c > 0);
      if (!s.length) return [];
      // The newest bar the source printed, even while its close is still null. It separates "no
      // close published yet" (the source lags a session) from "we never fetched this session"
      // (our failure) — the freshness guard must not confuse the two.
      s.lastBar = raw.length ? raw[raw.length - 1].d : null;
      writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), text: JSON.stringify(s), lastBar: s.lastBar }));
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
    for (let j = i + 1; j <= Math.min(i + 3, arr.length - 1); j++) {
      if (Math.abs(arr[j].c / pre - 1) < 0.2) { reverses = true; break; }
    }
    if (reverses) { arr[i].c = pre; fixed++; }
  }
  return { s: arr, adjustments: fixed };
}

if (!SKIP_PRICES) {
  console.log(`prices… ${universe.length} lines, ${YEARS}y daily (Yahoo .JO)`);
  let done = 0;
  await pool(universe, Number(arg('price-workers', 3)) || 3, async (c) => {
    const raw = await yahooSeries(yaSymbol(c.code));
    // JSE quotes are in cents on the exchange list, but Yahoo is not consistent across lines: most
    // print cents (75,725.0 for Naspers), several thin lines already print rand, and a few foreign
    // secondaries print another unit. Scale the whole series so its last close equals the exchange
    // list price in rand; returns are invariant to the scale and the traded-value proxy is then real.
    const rawLast = raw.length ? raw[raw.length - 1].c : null;
    const target = c.vendorPrice > 0 ? c.vendorPrice / 100 : null;
    const scale = target > 0 && rawLast > 0 ? target / rawLast : 0.01;
    // Accept only the two honest JSE conventions: rand (ratio ~1) and cents (ratio ~100). A wildly
    // different ratio means the Yahoo symbol is another instrument, not another unit — e.g. SCD.JO
    // was ~15,000× the JSE line. Drop the series and let the no-price audit name it.
    const ratio = rawLast > 0 && target > 0 ? rawLast / target : null;
    const usable = ratio == null || (ratio >= 0.5 && ratio <= 2) || (ratio >= 50 && ratio <= 200);
    c.priceScale = usable ? +scale.toPrecision(6) : null;
    const scaled = usable ? raw.map((p) => ({ ...p, c: p.c * scale })) : [];
    if (scaled.length > 1) {
      const clean = sanitizeSeries(scaled);
      c.series = clean.s;
      c.priceSource = 'yahoo';
      c.priceAdjusted = clean.adjustments || 0;
      c.priceBar = raw.lastBar || null;
    }
    if (++done % 100 === 0) console.log(`  ${done}/${universe.length} symbols`);
    await sleep(120);
  });
} else {
  for (const c of universe) {
    try {
      const f = join(YH_CACHE, `${yaSymbol(c.code).replace(/[^\w.-]/g, '_')}-${YEARS}y.json`);
      if (existsSync(f)) {
        const hit = JSON.parse(readFileSync(f, 'utf8'));
        const s = hit.text ? JSON.parse(hit.text) : null;
        if (s && s.length > 1) {
          const rawLast = s[s.length - 1].c;
          const target = c.vendorPrice > 0 ? c.vendorPrice / 100 : null;
          const scale = target > 0 && rawLast > 0 ? target / rawLast : 0.01;
          const ratio = rawLast > 0 && target > 0 ? rawLast / target : null;
          const usable = ratio == null || (ratio >= 0.5 && ratio <= 2) || (ratio >= 50 && ratio <= 200);
          c.priceScale = usable ? +scale.toPrecision(6) : null;
          if (!usable) continue;
          const clean = sanitizeSeries(s.map((p) => ({ ...p, c: p.c * scale })));
          c.series = clean.s; c.priceSource = 'yahoo'; c.priceAdjusted = clean.adjustments || 0; c.priceBar = hit.lastBar || null;
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
  c.priceBar = c.priceBar || last.d;
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

// --- 3. financials --------------------------------------------------------------------------------
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
  const eps = rowOf(t, ['Earnings Per Share', 'EPS (Diluted)', 'EPS (Basic)', 'Earnings Per Share (Diluted)']);
  const dps = rowOf(t, ['Dividend Per Share']);
  const dy = rowOf(t, ['Dividend Yield']);
  return {
    ttmEnd, currency: statementCurrency(html),
    vendorYield: ttmId ? get(dy, ttmId) : null,
    ttm: ttmId ? {
      revenue: scale(get(rev, ttmId)), operatingProfit: scale(get(op, ttmId)),
      netIncome: scale(get(ni, ttmId)), eps: perShare(get(eps, ttmId)),
      dividendPerShare: perShare(get(dps, ttmId)),
    } : null,
    annual: ann.map((c) => ({
      end: c.id, revenue: scale(get(rev, c.id)), operatingProfit: scale(get(op, c.id)),
      netIncome: scale(get(ni, c.id)), eps: perShare(get(eps, c.id)),
      dividendPerShare: perShare(get(dps, c.id)),
    })),
  };
}
// A few JSE issuers have no trailing column on the annual page, but stockanalysis still publishes a
// separate ?p=trailing view: one rolling twelve-month column per period end. It is the vendor's own
// TTM, so prefer it to arithmetic on the half-year columns. The newest dated column is the current
// window; older columns are the same rolling window at earlier dates.
function trailingOf(html) {
  const t = parseSaTable(html);
  const col = t.cols.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id));
  if (!col) return null;
  const get = (row) => (row ? row.values[col.id] : null);
  const rev = rowOf(t, ['Revenue', 'Total Revenue', 'Operating Revenue']);
  const op = rowOf(t, ['Operating Income']);
  const ni = rowOf(t, ['Net Income to Common', 'Net Income']);
  const eps = rowOf(t, ['Earnings Per Share', 'EPS (Diluted)', 'EPS (Basic)', 'Earnings Per Share (Diluted)']);
  const dps = rowOf(t, ['Dividend Per Share']);
  return {
    end: col.id,
    ttm: {
      revenue: scale(get(rev)), operatingProfit: scale(get(op)),
      netIncome: scale(get(ni)), eps: perShare(get(eps)), dividendPerShare: perShare(get(dps)),
    },
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
  const sh = rowOf(t, ['Total Common Shares Outstanding', 'Shares Outstanding (Diluted)', 'Shares Outstanding (Basic)', 'Shares Outstanding']);
  return {
    ttmEnd,
    latest: ttmId ? {
      assets: scale(get(a, ttmId)), liabilities: scale(get(l, ttmId)),
      equity: scale(get(et || ec, ttmId)), equityCommon: scale(get(ec || et, ttmId)),
      shares: scale(get(sh, ttmId)),
    } : null,
    annual: ann.map((c) => ({
      end: c.id, assets: scale(get(a, c.id)), liabilities: scale(get(l, c.id)),
      equity: scale(get(et || ec, c.id)), equityCommon: scale(get(ec || et, c.id)),
      shares: scale(get(sh, c.id)),
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
  const cols = t.cols.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.id)).slice(0, 20).reverse();
  return cols.map((c) => ({
    d: c.id, revenue: scale(rev && rev.values[c.id]), operatingProfit: scale(op && op.values[c.id]), netIncome: scale(ni && ni.values[c.id]),
  }));
}

// The JSE reports half-yearly, not quarterly: the vendor's "quarterly" table is a run of six-month
// columns for most issuers. Detect the cadence so the page labels the table the way the filing
// actually reports, and the TTM audit compares two half-years, not four quarters.
function basisOf(quarters) {
  const q = quarters || [];
  const gaps = q.slice(1).map((x, i) => (Date.parse(x.d) - Date.parse(q[i].d)) / DAY).filter((x) => x > 0);
  if (!q.length) return null;
  const medGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
  return medGap != null && medGap > 120 ? 'half' : 'quarter';
}

// stockanalysis serves no trailing column for some JSE issuers (Richemont is the obvious one). The
// half-year table still holds the two periods that make a trailing twelve months, so build it there.
// The sum is only accepted when it reconciles with the fiscal year at a shared period end; a
// cumulative rather than discrete half-year table therefore falls back to the labelled fiscal year.
function trailingFromHalves(c) {
  const q = c.quarters || [];
  if (c.periodBasis !== 'half' || q.length < 2) return null;
  const last = q.slice(-2);
  const gap = (Date.parse(last[1].d) - Date.parse(last[0].d)) / DAY;
  if (!(gap > 120 && gap < 250)) return null;
  const sum = {};
  for (const f of ['revenue', 'operatingProfit', 'netIncome']) {
    if (last.every((x) => x[f] != null)) sum[f] = last[0][f] + last[1][f];
  }
  if (sum.netIncome == null) return null;
  const fy = (c.annual || []).at(-1);
  // A lagging half-year table must not replace a newer annual report: TEX's last half is 2025-06
  // while its annual is 2026-06, and using the halves would make a current company look stale.
  if (fy && last[1].d < fy.end) return null;
  if (fy && fy.end === last[1].d && fy.netIncome != null && Math.abs(sum.netIncome - fy.netIncome) / Math.max(1, Math.abs(fy.netIncome)) > 0.03) return null;
  return { ttm: sum, ttmEnd: last[1].d };
}

async function page(code, p, q = false, trailing = false) {
  const s = secondaryOf(code);
  const key = s ? `${s.exchange}-${s.ticker}` : code;
  const f = join(ZA_SA, `${key.replace(/[^\w-]/g, '_')}-${p}${q ? '-q' : trailing ? '-trailing' : ''}.json`);
  return getCached(sourcePage(code, p, q, trailing), f, { ttlMs: q ? TTL_Q : TTL_FIN, timeout: 30000, retries: 6 });
}

async function trailingIncome(code) {
  try {
    const html = await page(code, 'income-statement', false, true);
    return trailingOf(html);
  } catch {
    return null;
  }
}

// The statistics page carries the current share count and dividend yield. The financials page used to
// repeat them, but stockanalysis removed that block in November 2026 — so the build reads them here,
// daily, exactly as the Indonesia/Hong Kong builds do. Yield is a price-derived number and must not be
// frozen at the last statement date.
async function statsPage(code) {
  const s = secondaryOf(code);
  const key = s ? `${s.exchange}-${s.ticker}` : code;
  const f = join(ZA_SA, `${key.replace(/[^\w-]/g, '_')}-statistics.json`);
  try { return await getCached(sourceStats(code), f, { ttlMs: TTL_DAY, timeout: 30000, retries: 4 }); }
  catch { return null; }
}
function statNumber(html, id) {
  const m = new RegExp(`\\{id:"${id}",[^}]*?hover:"([^"]+)"`).exec(String(html || ''))
    || new RegExp(`\\{id:"${id}",[^}]*?value:"([^"]+)"`).exec(String(html || ''));
  if (!m) return null;
  const n = Number(String(m[1]).replace(/[%$,]/g, ''));
  return Number.isFinite(n) ? n : null;
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
      c.periodBasis = basisOf(c.quarters);
      if (!(c.ttm && c.ttm.netIncome != null)) {
        // The half-year table is already in hand, so use it first. If it lags the annual report or
        // does not reconcile, ask the vendor for its separate ?p=trailing view before giving up.
        const half = trailingFromHalves(c);
        if (half) {
          c.ttm = half.ttm; c.ttmEnd = half.ttmEnd; c.ttmComputed = '2 half-years';
        } else {
          const t = await trailingIncome(c.code);
          const fy = c.annual.at(-1);
          if (t && t.ttm.netIncome != null && (!fy || t.end >= fy.end)) {
            c.ttm = { ...(c.ttm || {}), ...t.ttm };
            c.ttmEnd = t.end;
            c.ttmComputed = 'vendor trailing view';
          }
        }
      }
      c.reportCurrency = I.currency || 'ZAR';
      if (Number.isFinite(I.vendorYield) && I.vendorYield >= 0 && I.vendorYield < 30) c.vendorDividendYield = I.vendorYield;
      const stats = await statsPage(c.code);
      if (stats) {
        const y = statNumber(stats, 'dividendYield');
        if (Number.isFinite(y) && y >= 0 && y < 30) c.vendorDividendYield = y;
        const sh = statNumber(stats, 'sharesout');
        if (sh > 0) c.sharesCurrent = sh;
      }
      // The latest balance sheet carries the current ordinary count. It is a better cap denominator
      // than the period weighted average, and the JSE line's cap is the vendor's headline anyway.
      c.shares = (B.latest && B.latest.shares) || (I.ttm && I.ttm.shares) || (c.annual.length ? c.annual[c.annual.length - 1].shares : null) || null;
      if (B.latest && B.latest.shares > 0) c.sharesCurrent = B.latest.shares;
    } catch (e) {
      if (e && e.throttled) { c.throttled = true; await sleep(60000); } else miss++;
      c.ttm = null; c.latest = {}; c.annual = []; c.quarters = []; c.shares = null;
    }
    if (++done % 25 === 0) console.log(`  ${done}/${universe.length} companies`);
    await sleep(PACE);
  });
  console.log(`  ${universe.length - miss} with statements · ${miss} missing`);
} else {
  const prevDoc = readJson(OUT) || {};
  const prevBy = new Map((prevDoc.companies || []).map((c) => [c.code, c]));
  const prevStale = new Map(((prevDoc.audit && prevDoc.audit.staleCodes) || []).map((x) => [x.code, x.end || null]));
  for (const c of universe) {
    const p = prevBy.get(c.code);
    if (!p) {
      if (prevStale.has(c.code)) { c.stale = true; c.staleEnd = prevStale.get(c.code); }
      else c.noPrev = true;
      continue;
    }
    c.ttm = (p.reports && p.reports.ttm) || null;
    c.latest = (p.reports && p.reports.latest) || {};
    c.annual = (p.reports && p.reports.annual) || [];
    c.quarters = (p.reports && p.reports.quarters) || [];
    c.ttmEnd = (p.reports && p.reports.ttmEnd) || null;
    c.ttmComputed = p.ttmComputed;
    c.latestEnd = (p.reports && p.reports.latestEnd) || null;
    c.reportCurrency = p.reportCurrency || 'ZAR';
    c.shares = p.shares || null;
    c.sharesCurrent = p.sharesCurrent || null;
    c.vendorDividendYield = p.vendorDividendYield;
    c.sharesCurrent = p.sharesCurrent || c.sharesCurrent || null;
    c.periodBasis = basisOf(c.quarters);
    if (!(c.ttm && c.ttm.netIncome != null)) {
      const half = trailingFromHalves(c);
      if (half) { c.ttm = half.ttm; c.ttmEnd = half.ttmEnd; c.ttmComputed = '2 half-years'; }
    }
  }
}

const broken = universe.filter((c) => {
  const t = c.ttm || {};
  return t.revenue > 0 && t.operatingProfit > t.revenue * 1.05;
});
for (const c of broken) c.broken = true;
if (broken.length) console.log(`  ${broken.length} companies with an inconsistent trailing column — excluded`);

// --- stale statements -----------------------------------------------------------------------------
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
  // R 1M/day is a deliberately low floor: below it a name is not investable at any size.
  c.thinTrading = c.avgValue30 != null && c.avgValue30 < 1e6;
  const end = lastEndOf(c);
  c.ttmAgeDays = end ? Math.round((Date.parse(SESSION_DATE) - Date.parse(end)) / DAY) : null;
  c.ttmStale = c.ttmAgeDays != null && c.ttmAgeDays > 365;
  if (c.noRecentTrading) { c.chg1d = null; c.chg6m = null; c.chgYtd = null; }
}
const stale = universe.filter((c) => {
  if (c.stale) return true;
  const end = lastEndOf(c);
  return end && (Date.parse(SESSION_DATE) - Date.parse(end)) / DAY > STALE_DAYS;
});
for (const c of stale) c.stale = true;
if (stale.length) console.log(`  ${stale.length} companies with statements older than ${STALE_DAYS} days — excluded`);

const hasStatements = (c) => !!((c.ttm && (c.ttm.netIncome != null || c.ttm.revenue != null)) || (c.annual && c.annual.length));
const hasCap = (c) => c.vendorCap > 0 || c.shares > 0 || c.sharesCurrent > 0;
const throttled = universe.filter((c) => c.throttled);
const covered = universe.filter((c) => !c.noPrev && hasStatements(c) && hasCap(c) && c.price > 0 && !c.broken && !c.stale);
const dropped = universe.filter((c) => !c.throttled && !c.broken && !c.stale && !c.noPrev && !hasStatements(c)).map((c) => ({ code: c.code, name: c.name }));
const noCap = universe.filter((c) => !c.throttled && !c.broken && !c.stale && !c.noPrev && hasStatements(c) && !hasCap(c)).map((c) => ({ code: c.code, name: c.name }));
const noPrice = universe.filter((c) => !c.throttled && !c.broken && !c.stale && !c.noPrev && hasStatements(c) && hasCap(c) && !(c.price > 0)).map((c) => ({ code: c.code, name: c.name }));
// A new line in the exchange list has no cached statements in a --skip-fin rebuild. It must not vanish
// silently: the test that guards the foreign-secondary lens reads this list.
const noPrev = universe.filter((c) => c.noPrev).map((c) => ({ code: c.code, name: c.name }));
if (dropped.length) console.log(`  ${dropped.length} listed companies without a statement page`);
if (noCap.length) console.log(`  ${noCap.length} companies without a market cap — excluded rather than estimated`);
if (noPrice.length) console.log(`  ${noPrice.length} companies without a price`);
if (noPrev.length) console.log(`  ${noPrev.length} new listings without cached statements — kept on the next full run`);
if (throttled.length) console.log(`  ${throttled.length} companies throttled this run — rerun to fill them`);

// --- current shares --------------------------------------------------------------------------------
// The JSE line cap is the vendor's company total, so the share count is published for the company page
// and the per-share displays, never used to re-derive the cap.
let currentShares = 0;
for (const c of covered) {
  if (c.sharesCurrent > 0) currentShares++;
  c.sharesBasis = c.sharesCurrent > 0 ? 'current (latest balance sheet)' : 'filing';
  if (c.vendorCap > 0) c.marketCap = c.vendorCap;
  else if (c.sharesCurrent > 0 && c.price > 0) c.marketCap = c.price * c.sharesCurrent;
  else if (c.shares > 0 && c.price > 0) c.marketCap = c.price * c.shares;
}
if (currentShares) console.log(`  ${currentShares} on a current share count`);

// --- 4. FX ----------------------------------------------------------------------------------------
let fx = { pair: 'USDZAR', rate: null, date: iso(Date.now()), rates: null };
try {
  const f = join(ZA_CACHE, 'er-usd.json');
  const text = await getCached('https://open.er-api.com/v6/latest/USD', f, { ttlMs: TTL_DAY, retries: 3 });
  const j = JSON.parse(text);
  const rates = j && j.rates ? Object.fromEntries(Object.entries(j.rates).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) : null;
  if (rates && rates.ZAR > 0) {
    fx = { pair: 'USDZAR', rate: +rates.ZAR.toFixed(4), date: (j.time_last_update_utc ? iso(Date.parse(j.time_last_update_utc)) : iso(Date.now())), rates };
  }
} catch { /* fx stays null; foreign reporters get no ratios */ }

// --- 5. the JSE All Share -------------------------------------------------------------------------
const jse = (await yahooSeries(INDEX_SYMBOL, `${YEARS}y`)).slice(-1300);
const idx = jse.length > 1 ? (() => {
  const last = jse[jse.length - 1], prev = jse[jse.length - 2];
  const six = pointOnOrBefore(jse, iso(Date.parse(last.d) - 182 * DAY));
  const jan = jse.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  return {
    level: last.c, date: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan ? +(((last.c / jan.c) - 1) * 100).toFixed(2) : null,
    series: jse,
  };
})() : null;

// --- 6. derive ------------------------------------------------------------------------------------
for (const c of covered) {
  for (const r of c.annual || []) {
    const p = pointOnOrBefore(c.series || [], r.end);
    if (p) r.px = p.c;
  }
}
let out = deriveListing({ companies: covered, fx, baseCurrency: 'ZAR' });

// --- 7. descriptions and sectors -------------------------------------------------------------------
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
  // A REIT whose vendor profile omits the GICS row is still real estate; the name and the description
  // both say so. This is a narrow rule, not a blanket fallback for an unclassified company.
  if (!p?.sector && /\b(reit|property fund|real estate)\b/i.test(`${c.nameEn || ''} ${c.description || ''}`)) {
    c.sector = 'Real Estate';
    c.sectorSource = 'profile-name-rule';
  }
  c.industry = (p && p.industry) || null;
  if (c.description) withDesc++;
}

// --- 7b. ratios that do not exist for a bank ------------------------------------------------------
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
  primary: out.filter((c) => !c.foreignSecondary).length,
  secondary: out.filter((c) => c.foreignSecondary).length,
  listed: out.length,
  totalCap: out.reduce((a, c) => a + (c.marketCap || 0), 0),
  medianPe: median(out.map((c) => c.pe)),
  medianPb: median(out.map((c) => c.pb)),
  medianRoe: median(out.map((c) => c.roe)),
  medianYield: median(out.map((c) => c.dividendYield)),
  belowBook: out.filter((c) => c.pb != null && c.pb < 1).length,
  upYtd: out.filter((c) => c.chgYtd != null && c.chgYtd > 0).length,
  advancing: out.filter((c) => c.chg1d != null && c.chg1d > 0).length,
  declining: out.filter((c) => c.chg1d != null && c.chg1d < 0).length,
  foreignReporters: out.filter((c) => (c.reportCurrency || 'ZAR') !== 'ZAR').length,
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
  tickers: (t.tickers || []).filter((x) => known.has(pad(x))).map(pad),
})).filter((t) => t.tickers.length);

// --- 9. write -------------------------------------------------------------------------------------
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
  // `yearEnd` is kept: the deep audit re-runs the band engine on the stored inputs, and without the
  // calendar year-end prices the reconstructable P/E distribution would be one or two years short.
  const { series: _s, ttm, latest, annual, quarters, ...rest } = c;
  return { ...rest, reports: { ttm, latest, annual, quarters, ttmEnd: c.ttmEnd || null, latestEnd: c.latestEnd || null }, history: c.history || [], quarters };
});

const audit = {
  quoted: uni.quoted || listed.length + excluded.length,
  excluded: excluded.slice(0, 40).map((r) => ({ code: r.code, name: r.name, reason: EXCLUDED.get(r.code) || null })),
  excludedCount: excluded.length,
  secondary: cleaned.filter((c) => c.foreignSecondary).map((c) => ({ code: c.code, exchange: c.secondaryExchange, source: c.secondarySource })),
  secondaryCount: cleaned.filter((c) => c.foreignSecondary).length,
  primaryCount: cleaned.filter((c) => !c.foreignSecondary).length,
  classLines: uni.rows.length,
  considered: universe.length,
  companies: cleaned.length,
  withStatements: cleaned.length,
  withoutStatements: dropped.length,
  noStatements: dropped.slice(0, 40),
  withoutCap: noCap.length,
  noCap,
  withoutPrice: noPrice.length,
  noPrice: noPrice.slice(0, 40),
  noPrev: noPrev.length,
  noPrevCodes: noPrev.slice(0, 40),
  throttled: throttled.length,
  broken: broken.length,
  brokenCodes: broken.map((c) => ({ code: c.code, name: c.name })),
  stale: stale.length,
  staleCodes: stale.map((c) => ({ code: c.code, name: c.name, end: lastEndOf(c) })),
  priceScale: (() => {
    const bad = cleaned.filter((c) => c.vendorPrice > 0 && c.price > 0 && Math.abs(c.price / (c.vendorPrice / 100) - 1) > 0.02);
    return { compared: cleaned.filter((c) => c.vendorPrice > 0 && c.price > 0).length, over2pct: bad.length, examples: bad.slice(0, 8).map((c) => ({ code: c.code, price: c.price, list: c.vendorPrice / 100 })) };
  })(),
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
  foreignReporters: cleaned.filter((c) => c.reportCurrency !== 'ZAR').length,
  noRecentTrading: cleaned.filter((c) => c.noRecentTrading).length,
  noRecentTradingCodes: cleaned.filter((c) => c.noRecentTrading).map((c) => c.code),
  shortHistory: cleaned.filter((c) => c.shortHistory).length,
  shortHistoryCodes: cleaned.filter((c) => c.shortHistory).map((c) => c.code),
  ttmStale: cleaned.filter((c) => c.ttmStale).length,
  ttmStaleCodes: cleaned.filter((c) => c.ttmStale).map((c) => c.code),
  thinTrading: cleaned.filter((c) => c.thinTrading).length,
  thinTradingCodes: cleaned.filter((c) => c.thinTrading).map((c) => c.code),
  noFx: fx.rate == null,
  universePages: uni.pages || 0,
  universeStale: !!uni.stale,
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
  universe: `JSE · ${cleaned.length} lines`,
  indexName: INDEX_NAME,
  currency: 'ZAR',
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
// A removed line must not leave its bucket behind: a stale UPL.json would still answer a chart
// request for a company the market no longer publishes.
for (const f of readdirSync(SERIES_DIR)) {
  if (!f.endsWith('.json')) continue;
  if (bucketBook[f.replace(/\.json$/, '')]) continue;
  unlinkSync(join(SERIES_DIR, f));
}

try {
  const { southafricaList } = await import('../src/project.js');
  const list = southafricaList(JSON.parse(readFileSync(OUT, 'utf8')));
  writeFileSync(`${LIST_OUT}.tmp`, JSON.stringify(list)); renameSync(`${LIST_OUT}.tmp`, LIST_OUT);
} catch (e) { console.log(`  list artifact: ${e.message}`); }

rmSync(DETAIL_DIR, { recursive: true, force: true });
mkdirSync(DETAIL_DIR, { recursive: true });
for (const c of cleaned) writeFileSync(join(DETAIL_DIR, `${c.code}.json`), JSON.stringify(c));

try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'za'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'attach-market-brands.mjs'), 'za'], { stdio: 'inherit' }); }
catch (e) { console.log(`  brands: ${e.message}`); }

console.log(`${cleaned.length} companies (${market.primary} primary + ${market.secondary} secondary) · ${market.medianPe ?? '—'} median P/E · ${withDesc} descriptions · ${INDEX_NAME} ${idx ? Math.round(idx.level) : '—'} · USD/ZAR ${fx.rate}`);
console.log(`${dropped.length} without statements · ${noCap.length} without a cap · ${noPrice.length} without a price · ${market.foreignReporters} report in another currency · ${market.sectors.length} sectors`);
console.log(cleaned.slice(0, 5).map((c) => `  ${c.code} ${c.nameEn || c.name} · R${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'} · ${c.reportCurrency}`).join('\n'));
