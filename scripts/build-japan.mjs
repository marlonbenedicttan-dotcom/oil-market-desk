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
const DAYS = Number((process.argv.find((x) => x.startsWith('--days=')) || '').split('=')[1] || 200);
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
const series = new Map();                              // code -> [{d, c}]
for (const c of (prev?.companies || [])) {
  if (Array.isArray(c.series)) series.set(c.code, c.series.map((p) => ({ d: p.d, c: p.c })));
}
const have = new Set([...series.values()].flatMap((s) => s.map((p) => p.d)));
const start = Date.now() - DAYS * DAY;
const dates = [];
for (let t = start; t <= Date.now(); t += DAY) {
  const d = iso(t);
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6 || have.has(d)) continue; // weekends; already fetched
  dates.push(d);
}
console.log(`prices… ${dates.length} days to fetch`);
const capToday = new Map();
let fetched = 0;
for (const d of dates) {
  let rows;
  try { rows = await api.barsByDate(d); } catch (e) { console.log(`  ${d}: ${e.message}`); continue; }
  for (const r of rows) {
    if (!prime.has(r.Code) || r.AdjC == null) continue;
    const arr = series.get(r.Code) || [];
    arr.push({ d, c: r.AdjC });
    series.set(r.Code, arr);
    if (r.MktCap) capToday.set(r.Code, r.MktCap);
  }
  fetched++;
  if (fetched % 20 === 0) console.log(`  ${fetched}/${dates.length} days`);
}

// --- 3. rank by market cap and take the top N --------------------------------------------------
// MktCap is quoted in millions of yen (verified: JPX itself reads ~1,083,850 at a ¥1.08T cap).
// Prices already cached carry their market cap forward, so a run that fetches only today's bar
// still ranks the whole universe.
const prevCap = new Map(((prev && prev.companies) || []).map((c) => [c.code, c.marketCap]));
const ranked = [...prime.values()]
  .map((c) => ({ ...c, cap: capToday.has(c.code) ? capToday.get(c.code) * 1e6 : (prevCap.get(c.code) || 0) }))
  .filter((c) => c.cap > 0 && (series.get(c.code)?.length || 0) > 20)
  .sort((a, b) => b.cap - a.cap)
  .slice(0, SIZE);
console.log(`universe: ${ranked.length} companies`);

// --- 4. financials, one company at a time ------------------------------------------------------
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

// --- 5. earnings dates and FX -------------------------------------------------------------------
console.log('calendar + fx…');
const cal = await api.earningsCalendar().catch(() => []);
const nextByCode = new Map();
for (const r of cal) {
  if (!r.Date || r.Date < iso(Date.now())) continue;
  if (!nextByCode.has(r.Code) || r.Date < nextByCode.get(r.Code).date) {
    nextByCode.set(r.Code, { date: r.Date, quarter: r.FQ || '', basis: 'scheduled' });
  }
}
let fx = null;
try {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?range=5d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
  fx = closes.filter((x) => x != null).pop() || null;
} catch { fx = null; }

// --- 6. derive ----------------------------------------------------------------------------------
const companies = deriveJapan({ ranked, fins, series, nextByCode, fx });

const out = {
  updated: new Date().toISOString(),
  universe: `TSE Prime · top ${companies.length} by market cap`,
  currency: 'JPY',
  fx: { pair: 'USDJPY', rate: fx, date: iso(Date.now()) },
  companies,
};
writeFileSync(OUT + '.tmp', JSON.stringify(out));
renameSync(OUT + '.tmp', OUT);

const withPe = companies.filter((c) => c.pe != null).length;
const withFcf = companies.filter((c) => c.fcf != null).length;
console.log(`${companies.length} companies · ${withPe} with P/E · ${withFcf} with cash flow · FX ${fx}`);
console.log(companies.slice(0, 5).map((c) => `  ${c.ticker} ${c.name} · ¥${c.price} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'}`).join('\n'));
