// Fetch current shares outstanding for every covered listing.
//
// The statement pages give a diluted *weighted-average* share count for the period. That is the right
// denominator for EPS, but the wrong one for market cap: a placement or buyback after the period end
// leaves the cap (and P/E, P/B) stale. The vendor's statistics page carries the current count in prose
// ("... has 8.99 billion shares outstanding"), so we fetch one page per company and keep it in a small
// side file the build reads. Cached for a day; resumable; safe to re-run.
//
//   node scripts/fetch-listing-shares.mjs australia
//   node scripts/fetch-listing-shares.mjs hongkong
//   node scripts/fetch-listing-shares.mjs australia --limit=50 --codes=BHP,CBA
//   node scripts/fetch-listing-shares.mjs australia --fresh
//
// Read-only with respect to the market data; writes data/<market>-shares.json + a disk cache.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCached, sleep, readJson, writeJson } from './stockanalysis.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKETS = {
  australia: { data: 'australia.json', quote: 'asx', out: 'australia-shares.json', cache: 'australia-shares' },
  hongkong: { data: 'hongkong.json', quote: 'hkg', out: 'hongkong-shares.json', cache: 'hongkong-shares' },
  // NSE symbols carry '&' and '-', which stockanalysis spells '_' in the slug (M_M, BAJAJ_AUTO).
  india: { data: 'india.json', quote: 'nse', out: 'india-shares.json', cache: 'india-shares', slug: (c) => String(c).replace(/[&-]/g, '_') },
};
const market = (process.argv[2] || '').toLowerCase();
const M = MARKETS[market];
if (!M) {
  console.error('usage: node scripts/fetch-listing-shares.mjs australia|hongkong|india [--limit=N] [--codes=A,B] [--fresh]');
  process.exit(2);
}
const arg = (k, d = null) => { const x = process.argv.find((a) => a.startsWith(`--${k}=`)); return x ? x.split('=')[1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const LIMIT = Number(arg('limit', 0)) || 0;
const CODES = (arg('codes', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TTL = 24 * 3600e3;

const data = readJson(join(ROOT, 'data', M.data));
if (!data || !Array.isArray(data.companies)) {
  console.error(`no ${M.data} — build the market once before fetching current shares`);
  process.exit(1);
}
const cacheDir = join(ROOT, 'data', 'cache', M.cache);
mkdirSync(cacheDir, { recursive: true });
const outFile = join(ROOT, 'data', M.out);
const previous = readJson(outFile) || { entries: {} };
const entries = { ...(previous.entries || {}) };
// A Hong Kong listing with no HKG statistics page can still have the company's total share count on
// its other listing (A-share, LON, OTC). That is exactly the whole-company count the H-price cap uses.
const cross = market === 'hongkong'
  ? (readJson(join(ROOT, 'data', 'hongkong-crosslist.json')) || {}).entries || {}
  : {};
// A few A+H lines are not in the statement cross-list (their HKG page exists), but their A-share
// page carries the total share count the H-price cap needs. These are only used for shares.
const SHARES_CROSS = market === 'hongkong' ? {
  '2318': { exchange: 'sha', code: '601318' },   // Ping An
  '3750': { exchange: 'she', code: '300750' },   // CATL
  '2238': { exchange: 'sha', code: '601238' },   // GAC Group
  '0187': { exchange: 'sha', code: '600860' },   // Jingcheng Machinery
  '6160': { exchange: 'sha', code: '688235' },   // BeOne Medicines
  '2068': { exchange: 'sha', code: '601068' },   // China Aluminum International Engineering
} : market === 'australia' ? {
  // CDIs / dual-listed lines: the US page gives the global ordinary count; multiply by the CDI ratio
  // so the ASX price capitalises the same number of CDIs the filing does.
  RIO: { exchange: 'us', code: 'RIO', ratio: 1 },
  RMD: { exchange: 'us', code: 'RMD', ratio: 10 },
  AMC: { exchange: 'us', code: 'AMCR', ratio: 1 },
} : {};
const crossAll = { ...cross, ...SHARES_CROSS };

const MULT = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
function parseShares(html) {
  if (!html) return null;
  // The summary sentence is the canonical current count.
  const prose = /has ([\d.,]+)\s*(thousand|million|billion|trillion) shares outstanding/i.exec(html);
  if (prose) {
    const n = Number(prose[1].replace(/,/g, ''));
    if (Number.isFinite(n) && MULT[prose[2].toLowerCase()]) return n * MULT[prose[2].toLowerCase()];
  }
  // Fallback: the statistics table exposes the exact count in a title attribute.
  const table = /Shares Outstanding[\s\S]{0,400}?title="([\d,]+)"/.exec(html);
  if (table) {
    const n = Number(table[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
function parseMarketCap(html) {
  const m = /\{id:"marketcap",title:"Market Cap",value:"[^"]+",hover:"([\d,]+)"/.exec(html || '');
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
function parseYield(html) {
  const m = /\{id:"dividendYield",[^}]*?value:"([^"]+)"/.exec(html || '');
  if (!m) return null;
  const n = Number(String(m[1]).replace(/[%,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const at = i++; await fn(items[at], at); }
  }));
}

let list = data.companies.map((c) => c.code);
if (CODES.length) {
  const want = new Set(CODES);
  list = list.filter((c) => want.has(c));
}
if (LIMIT) list = list.slice(0, LIMIT);
console.log(`${market}: ${list.length} codes`);

let done = 0, got = 0, miss = 0;
await pool(list, 2, async (code) => {
  const slug = M.slug ? M.slug(code) : code;
  const f = join(cacheDir, `${slug}.json`);
  const url = `https://stockanalysis.com/quote/${M.quote}/${slug}/statistics/`;
  let html = null;
  try { html = await getCached(url, f, { ttlMs: TTL, fresh: flag('fresh'), retries: 2, timeout: 30000 }); } catch { html = null; }
  let shares = parseShares(html);
  let source = shares > 0 ? M.quote : null;
  if (!(shares > 0) && crossAll[code]) {
    const c = crossAll[code];
    const cf = join(cacheDir, `cross-${c.exchange}-${c.code}.json`);
    const cu = c.exchange === 'us'
      ? `https://stockanalysis.com/stocks/${c.code}/statistics/`
      : `https://stockanalysis.com/quote/${c.exchange}/${c.code}/statistics/`;
    let ch = null;
    try { ch = await getCached(cu, cf, { ttlMs: TTL, fresh: flag('fresh'), retries: 2, timeout: 30000 }); } catch { ch = null; }
    const cs = parseShares(ch);
    if (cs > 0) { shares = cs * (c.ratio || 1); html = ch; source = `${c.exchange}:${c.code}`; }
  }
  if (shares > 0) {
    // A cross-listing page's market cap and yield are in that listing's currency/price, not HKD;
    // keep only the share count from it.
    const own = source === M.quote;
    entries[code] = {
      shares, source,
      marketCap: own ? parseMarketCap(html) : null,
      yield: own ? parseYield(html) : null,
      fetched: new Date().toISOString(),
    };
    got++;
  } else {
    miss++;
    // Keep any older good value; do not overwrite it with a miss.
    // Keep the vendor's market cap even when the share count is "n/a": the build derives a current
    // count from it (cap ÷ price), which is the number their own headline is built on.
    if (!entries[code] || !(entries[code].shares > 0)) entries[code] = { shares: null, marketCap: parseMarketCap(html), yield: parseYield(html), fetched: new Date().toISOString() };
  }
  if (++done % 100 === 0) {
    // Write as we go: a long throttled run still leaves a usable partial side file for the build.
    writeJson(outFile, { updated: new Date().toISOString(), market, entries });
    console.log(`  ${done}/${list.length} · ${got} with shares · ${miss} missed`);
  }
  await sleep(180);
});

writeJson(outFile, { updated: new Date().toISOString(), market, entries });
console.log(`${market}: ${got}/${list.length} current share counts · ${miss} missed · wrote data/${M.out}`);
