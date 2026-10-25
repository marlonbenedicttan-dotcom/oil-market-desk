// Add current market cap, P/E and P/B to the company dataset.
//
// Price comes from Yahoo (one request per ticker), shares from the XBRL cover page, earnings and equity
// from the filings. Market cap = price × shares; P/E = market cap ÷ net income; P/B = market cap ÷ equity.
// These are CURRENT, not historical — labelled as such, because a 5-year price series per company would
// be thousands of requests and the fundamentals already carry the history.
//
//   node scripts/price-companies.mjs --limit=600

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '--limit=600').split('=')[1]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const targets = data.companies.filter((c) => c.ticker && c.shares && c.revenue).slice(0, LIMIT);
console.log(`${targets.length} companies with a ticker and share count`);

let ok = 0;
for (const c of targets) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(c.ticker)}?range=5d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) continue;
    const j = await res.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? null;
    if (!price) continue;
    c.price = +price.toFixed(2);
    c.marketCap = Math.round(price * c.shares);
    // Trailing P/E prefers TTM EPS (four quarters) and falls back to the fiscal-year figure.
    const epsT = c.epsTTM > 0 ? c.epsTTM : (c.eps > 0 ? c.eps : null);
    c.peTTM = epsT ? +(price / epsT).toFixed(1) : null;
    c.pe = c.peTTM;
    c.peBasis = c.epsTTM > 0 ? 'TTM' : (c.eps > 0 ? 'FY' : null);
    // P/B from price ÷ book value per share (equity ÷ shares).
    const bvps = c.equity > 0 && c.shares ? c.equity / c.shares : null;
    c.pb = bvps && bvps > 0 ? +(price / bvps).toFixed(1) : null;
    // EV = market cap + debt - cash; EBITDA = operating income + D&A.
    c.ev = c.debt != null || c.cash != null ? c.marketCap + (c.debt || 0) - (c.cash || 0) : null;
    // Operating income may only exist inside the series (the headline block doesn't carry it).
    const opInc = c.opInc ?? [...(c.series || [])].reverse().find((x) => x.opInc != null)?.opInc ?? null;
    const ebitda = opInc != null ? opInc + (c.da || 0) : null;
    c.evEbitda = c.ev && ebitda > 0 ? +(c.ev / ebitda).toFixed(1) : null;
    c.currentRatio = c.currentAssets != null && c.currentLiabilities > 0 ? +(c.currentAssets / c.currentLiabilities).toFixed(2) : null;
    c.debtEquity = c.debt != null && c.equity > 0 ? +(c.debt / c.equity).toFixed(2) : null;
    ok++;
  } catch {}
  await sleep(120);
  if (ok && ok % 100 === 0) console.log(`  ${ok} priced`);
}

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`priced ${ok} · companies with market cap: ${data.companies.filter((c) => c.marketCap).length}`);
