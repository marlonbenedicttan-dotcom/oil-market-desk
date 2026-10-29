// Build the Japan dataset: TSE Prime, ranked by market cap.
//
// Everything comes from J-Quants (JPX's own API) — no scraping, no EDINET, no JP-GAAP XBRL mapping.
// Prices are fetched one trading day at a time (all issues per call), financials one company at a time.
//
//   node scripts/build-japan.mjs                 full run, ~225 names
//   node scripts/build-japan.mjs --limit=20      smoke test after subscribing
//   node scripts/build-japan.mjs --days=200      how much price history to keep
//
// The universe is "TSE Prime, top N by market cap" rather than the Nikkei 225, because the Nikkei is a
// licensed index whose membership is not in the exchange's master file. Same shape, no licence.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient } from './jquants.mjs';
import { deriveJapan } from './derive-japan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'japan.json');
const CACHE = join(ROOT, 'data', 'cache', 'jquants');
const SIZE = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 225);
// 300 days clears 1 January, so "YTD" is measured from the first session of the year, not from the
// start of the window.
const DAYS = Number((process.argv.find((x) => x.startsWith('--days=')) || '').split('=')[1] || 300);
const DAY = 864e5;
mkdirSync(CACHE, { recursive: true });

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const readCache = (name) => { try { return JSON.parse(readFileSync(join(CACHE, name), 'utf8')); } catch { return null; } };
const writeCache = (name, v) => writeFileSync(join(CACHE, name), JSON.stringify(v));

const api = makeClient();

// --- 1. the master file: codes, names, sectors, market segment --------------------------------
console.log('master…');
let master = readCache('master.json');
if (!master || Date.parse(master.fetched) < Date.now() - 7 * DAY) {
  master = { fetched: new Date().toISOString(), rows: await api.master() };
  writeCache('master.json', master);
}
// The master file carries the exchange's 33 sectors in Japanese only. Map them once, here.
const SECTOR_EN = {
  '水産・農林業': 'Fishery, Agriculture & Forestry', '鉱業': 'Mining', '建設業': 'Construction',
  '食料品': 'Foods', '繊維製品': 'Textiles & Apparels', 'パルプ・紙': 'Pulp & Paper',
  '化学': 'Chemicals', '医薬品': 'Pharmaceutical', '石油・石炭製品': 'Oil & Coal Products',
  'ゴム製品': 'Rubber Products', 'ガラス・土石製品': 'Glass & Ceramics', '鉄鋼': 'Iron & Steel',
  '非鉄金属': 'Nonferrous Metals', '金属製品': 'Metal Products', '機械': 'Machinery',
  '電気機器': 'Electric Appliances', '輸送用機器': 'Transportation Equipment',
  '精密機器': 'Precision Instruments', 'その他製品': 'Other Products',
  '電気・ガス業': 'Electric Power & Gas', '陸運業': 'Land Transportation',
  '海運業': 'Marine Transportation', '空運業': 'Air Transportation',
  '倉庫・運輸関連業': 'Warehousing & Transport', '情報・通信業': 'Information & Communication',
  '卸売業': 'Wholesale Trade', '小売業': 'Retail Trade', '銀行業': 'Banks',
  '証券、商品先物取引業': 'Securities & Commodity Futures', '証券・商品先物取引業': 'Securities & Commodity Futures',
  '保険業': 'Insurance',
  'その他金融業': 'Other Financials', '不動産業': 'Real Estate', 'サービス業': 'Services',
};

const prime = new Map();
for (const r of master.rows) {
  if (r.Mkt !== '0111') continue;                     // 0111 = Prime
  prime.set(r.Code, {
    code: r.Code,
    ticker: String(r.Code).slice(0, 4),
    name: r.CoNameEn || r.CoName,
    nameJa: r.CoName,
    // Some rows use a halfwidth interpunct (･) where others use the fullwidth one (・).
    sector: SECTOR_EN[String(r.S33Nm || '').replace(/\uFF65/g, '\u30FB')] || r.S33Nm || '—',
    size: r.ScaleCat || '',
  });
}
console.log(`  ${prime.size} Prime issues`);

// --- 2. prices: one request per trading day, all issues ---------------------------------------
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
// Prices are cached for the whole Prime market, not just the names in the last output — otherwise a
// small --limit run would silently shrink the universe on the next full run.
const SERIES_CACHE = join(CACHE, 'series.json');
const series = new Map();                              // code -> [{d, c}]
try {
  const raw = JSON.parse(readFileSync(SERIES_CACHE, 'utf8'));
  for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) series.set(k, v);
} catch { /* first run */ }
for (const c of (prev?.companies || [])) {
  if (!series.has(c.code) && Array.isArray(c.series)) series.set(c.code, c.series.map((p) => ({ d: p.d, c: p.c })));
}
// A date counts as fetched only if most of the market has it. Otherwise a run that once had a small
// universe would leave every other company with a handful of points.
const dateCoverage = new Map();
for (const arr of series.values()) for (const p of arr) dateCoverage.set(p.d, (dateCoverage.get(p.d) || 0) + 1);
const coverageFloor = Math.max(1, Math.floor(prime.size * 0.5));
const have = new Set([...dateCoverage].filter(([, n]) => n >= coverageFloor).map(([d]) => d));
const capToday = new Map();
const start = Date.now() - DAYS * DAY;
const dates = [];
for (let t = start; t <= Date.now(); t += DAY) {
  const d = iso(t);
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6 || have.has(d)) continue; // weekends; already fetched
  dates.push(d);
}
console.log(`prices… ${dates.length} days to fetch`);
let fetched = 0;
for (const d of dates) {
  let rows;
  try { rows = await api.barsByDate(d); } catch (e) { console.log(`  ${d}: ${e.message}`); continue; }
  for (const r of rows) {
    if (!prime.has(r.Code) || r.AdjC == null) continue;
    if (r.MktCap) capToday.set(r.Code, r.MktCap);
    const arr = series.get(r.Code) || [];
    arr.push({ d, c: r.AdjC });
    series.set(r.Code, arr);
  }
  fetched++;
  if (fetched % 20 === 0) console.log(`  ${fetched}/${dates.length} days`);
}

// Normalise before anything reads it: one point per date, oldest first. A run that overlaps another
// would otherwise append the same day twice.
for (const [k, v] of series) {
  const byDate = new Map();
  for (const p of v) byDate.set(p.d, p);
  series.set(k, [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d)));
}

// Persist every price series (trimmed to the window) so the cache outlives the output file.
{
  const keep = {};
  const floor = iso(Date.now() - (DAYS + 10) * DAY);
  for (const [k, v] of series) keep[k] = v.filter((p) => p.d >= floor);
  writeFileSync(SERIES_CACHE, JSON.stringify(keep));
}

// --- 3. valuation: the exchange's own ratios and ex-treasury market cap ------------------------
// One request covers every issue. PER and ROE here are TTM; MktCap excludes treasury shares and is
// split-adjusted, which the bars endpoint's field is not (and is being retired).
// Ask for the most recent day we actually have bars for, and step back if the exchange has not
// published that day's valuation yet (it appears after the Tokyo close).
let lastBarDate = null;
for (const arr of series.values()) {
  const d = arr.length ? arr[arr.length - 1].d : null;
  if (d && (!lastBarDate || d > lastBarDate)) lastBarDate = d;
}
let valRows = [];
for (let back = 0; back < 6 && !valRows.length && lastBarDate; back++) {
  const d = iso(Date.parse(lastBarDate + 'T00:00:00Z') - back * DAY);
  try { valRows = await api.valuation(d); } catch (e) { console.log(`  valuation ${d}: ${e.message}`); }
  if (valRows.length) console.log(`  valuation as of ${d}`);
}
const valByCode = new Map(valRows.filter((r) => prime.has(r.Code)).map((r) => [r.Code, r]));
console.log(`  valuation rows for ${valByCode.size} Prime issues`);

// --- 4. rank by market cap and take the top N --------------------------------------------------
const prevCap = new Map(((prev && prev.companies) || []).map((c) => [c.code, c.marketCap]));
const ranked = [...prime.values()]
  .map((c) => ({
    ...c,
    cap: valByCode.get(c.code)?.MktCap ? valByCode.get(c.code).MktCap * 1e6
      : (prevCap.get(c.code) || (capToday.get(c.code) || 0) * 1e6 || 0),
  }))
  .filter((c) => c.cap > 0 && (series.get(c.code)?.length || 0) > 20)
  .sort((a, b) => b.cap - a.cap)
  .slice(0, SIZE);
console.log(`universe: ${ranked.length} companies`);

// --- 5. financials, one company at a time ------------------------------------------------------
console.log('financials…');
const fins = new Map();
for (let i = 0; i < ranked.length; i++) {
  const c = ranked[i];
  const cached = readCache(`fins-${c.code}.json`);
  if (cached && Date.parse(cached.fetched) > Date.now() - 7 * DAY) { fins.set(c.code, cached.rows); continue; }
  try {
    const rows = await api.finsByCode(c.code);
    fins.set(c.code, rows);
    writeCache(`fins-${c.code}.json`, { fetched: new Date().toISOString(), rows });
  } catch (e) { console.log(`  ${c.code}: ${e.message}`); }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${ranked.length}`);
}

// --- 6. earnings dates and FX -------------------------------------------------------------------
console.log('calendar + fx…');
const cal = await api.earningsCalendar().catch(() => []);
const nextByCode = new Map();
for (const r of cal) {
  if (!r.Date || r.Date < iso(Date.now())) continue;
  if (!nextByCode.has(r.Code) || r.Date < nextByCode.get(r.Code).date) {
    nextByCode.set(r.Code, { date: r.Date, quarter: r.FQ || '', basis: 'scheduled' });
  }
}
// TOPIX, for relative performance. Light includes the index; only TOPIX, not the other indices.
let topix = null;
try {
  const rows = await api.topix(iso(Date.now() - DAYS * DAY), iso(Date.now()));
  const closes = rows.filter((r) => r.C != null).sort((a, b) => a.Date.localeCompare(b.Date));
  if (closes.length > 1) {
    const last = closes[closes.length - 1];
    const jan1 = closes.find((r) => r.Date >= `${new Date().getUTCFullYear()}-01-01`);
    const six = closes[Math.max(0, closes.length - 126)];
    topix = {
      level: last.C,
      date: last.Date,
      chg1d: +(((last.C / closes[closes.length - 2].C) - 1) * 100).toFixed(2),
      chg6m: six ? +(((last.C / six.C) - 1) * 100).toFixed(2) : null,
      chgYtd: jan1 ? +(((last.C / jan1.C) - 1) * 100).toFixed(2) : null,
      series: closes.map((r) => ({ d: r.Date, c: r.C })),
    };
  }
} catch (e) { console.log(`  topix: ${e.message}`); }

let fx = null;
try {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?range=5d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
  fx = closes.filter((x) => x != null).pop() || null;
} catch { fx = null; }

// --- 7. derive ----------------------------------------------------------------------------------
const companies = deriveJapan({ ranked, fins, series, val: valByCode, nextByCode, fx });

// Sector medians, so a multiple can be read against its own industry rather than the whole market.
{
  const median = (xs) => {
    const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
  };
  const bySector = new Map();
  for (const c of companies) {
    if (!bySector.has(c.sector)) bySector.set(c.sector, []);
    bySector.get(c.sector).push(c);
  }
  const stats = new Map();
  for (const [sector, list] of bySector) {
    stats.set(sector, {
      count: list.length,
      pe: median(list.map((c) => c.pe)),
      pb: median(list.map((c) => c.pb)),
      roe: median(list.map((c) => c.roe)),
      yield: median(list.map((c) => (c.dividend ? c.dividend.yield : null))),
    });
  }
  for (const c of companies) c.sectorMedian = stats.get(c.sector) || null;
}

const out = {
  updated: new Date().toISOString(),
  universe: `TSE Prime · top ${companies.length} by market cap`,
  currency: 'JPY',
  fx: { pair: 'USDJPY', rate: fx, date: iso(Date.now()) },
  topix,
  companies,
};
writeFileSync(OUT + '.tmp', JSON.stringify(out));
renameSync(OUT + '.tmp', OUT);

const withPe = companies.filter((c) => c.pe != null).length;
const withFcf = companies.filter((c) => c.fcf != null).length;
console.log(`${companies.length} companies · ${withPe} with P/E · ${withFcf} with cash flow · FX ${fx}`);
console.log(companies.slice(0, 5).map((c) => `  ${c.ticker} ${c.name} · ¥${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'}`).join('\n'));
