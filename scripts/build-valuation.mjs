// Historical valuation: is today's P/E high or low for this company, and for the index?
//
// For each company, take the price at each fiscal-year end and divide by that year's EPS. That gives a
// five-year P/E range and where today sits inside it. Summing market caps and earnings across the
// universe gives the same for the S&P 500 itself.
//
// Prices come from Nasdaq's own historical chart (one request per company, cached). Shares are today's,
// so historical market caps are approximate — buybacks and issuance move the true count. That is stated
// on the page rather than hidden.
//
//   node scripts/build-valuation.mjs
//   node scripts/build-valuation.mjs --only=AAPL,MSFT

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const OUT = join(ROOT, 'data', 'valuation.json');
const CACHE = join(ROOT, 'data', 'cache', 'charts');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(CACHE, { recursive: true });

async function chart(ticker) {
  const f = join(CACHE, `${ticker}.json`);
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* refetch */ } }
  const sym = String(ticker).replace('-', '.');
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/chart?assetclass=stocks&fromdate=2019-01-01&todate=${new Date().toISOString().slice(0, 10)}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      });
      if (res.status === 429) { await sleep(2500 * (i + 1)); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      const rows = j?.data?.chart;
      if (!Array.isArray(rows) || !rows.length) return null;
      const slim = rows.map((r) => [r.z?.dateTime, r.y]).filter((x) => x[0] && x[1] != null);
      writeFileSync(f, JSON.stringify(slim));
      return slim;
    } catch { await sleep(900 * (i + 1)); }
  }
  return null;
}

const toIso = (mdY) => {
  const [m, d, y] = String(mdY).split('/').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const closeAt = (rows, target) => {
  let best = null;
  for (const [d, v] of rows) {
    const t = Date.parse(toIso(d));
    const diff = Math.abs(t - target) / DAY;
    if (diff > 10) continue;
    if (!best || diff < best.diff) best = { v, diff, date: toIso(d) };
  }
  return best;
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.ticker && c.series?.length && c.netIncomeEnd && (!onlySet || onlySet.has(c.ticker.toUpperCase())));
console.log(`${todo.length} companies with history`);

// Fiscal year end month/day, taken from the latest filing and applied to earlier years.
const fyMonthDay = (c) => String(c.netIncomeEnd).slice(5);

let built = 0;
const indexYears = new Map();   // fy -> { cap, earnings }
let i = 0;

async function worker() {
  while (i < todo.length) {
    const c = todo[i++];
    const rows = await chart(c.ticker);
    if (!rows) continue;
    const md = fyMonthDay(c);
    const years = [];
    for (const s of c.series) {
      if (!(s.eps > 0)) continue;
      const target = Date.parse(`${s.fy}-${md}`);
      const hit = closeAt(rows, target);
      if (!hit) continue;
      years.push({ fy: s.fy, price: hit.v, pe: +(hit.v / s.eps).toFixed(1) });
      // index accumulation
      if (c.marketCap && c.price) {
        const cap = c.marketCap * (hit.v / c.price);
        const agg = indexYears.get(s.fy) || { cap: 0, earnings: 0 };
        agg.cap += cap;
        if (s.netIncome > 0) agg.earnings += s.netIncome;
        indexYears.set(s.fy, agg);
      }
    }
    if (years.length < 3) continue;
    const pes = years.map((y) => y.pe).filter((x) => x > 0 && x < 500);
    if (pes.length < 3) continue;
    const cur = c.pe;
    const below = cur != null ? pes.filter((x) => x <= cur).length : null;
    c.peHistory = {
      years,
      min: +Math.min(...pes).toFixed(1),
      median: +median(pes).toFixed(1),
      max: +Math.max(...pes).toFixed(1),
      percentile: below != null ? Math.round((below / pes.length) * 100) : null,
    };
    built++;
    await sleep(150);
  }
}
await Promise.all([worker(), worker(), worker()]);

// --- index ---------------------------------------------------------------
const history = [...indexYears.entries()].filter(([, v]) => v.earnings > 0)
  .map(([fy, v]) => ({ fy, pe: +(v.cap / v.earnings).toFixed(1) })).sort((a, b) => a.fy - b.fy);
const currentCap = data.companies.filter((c) => !c.shareClass && c.marketCap).reduce((a, c) => a + c.marketCap, 0);
const currentEarn = data.companies.filter((c) => !c.shareClass && c.netIncomeTTM > 0).reduce((a, c) => a + c.netIncomeTTM, 0);
const currentPe = currentEarn > 0 ? +(currentCap / currentEarn).toFixed(1) : null;
const pes = history.map((h) => h.pe);
const below = currentPe != null ? pes.filter((x) => x <= currentPe).length : null;
const valuation = {
  updated: new Date().toISOString(),
  index: {
    pe: currentPe,
    years: history,
    min: pes.length ? +Math.min(...pes).toFixed(1) : null,
    median: pes.length ? +median(pes).toFixed(1) : null,
    max: pes.length ? +Math.max(...pes).toFixed(1) : null,
    percentile: below != null && pes.length ? Math.round((below / pes.length) * 100) : null,
    basis: 'Σ market cap ÷ Σ trailing net income, current shares applied to past prices',
  },
};

console.log(`P/E history for ${built} companies`);
console.log(`index P/E ${valuation.index.pe} · ${valuation.index.min}–${valuation.index.max} (median ${valuation.index.median}) · ${valuation.index.percentile}th percentile`);

writeFileSync(OUT, JSON.stringify(valuation, null, 1));
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log('written');
