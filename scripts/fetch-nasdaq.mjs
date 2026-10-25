// Take market cap from Nasdaq's own quote summary instead of deriving it from a share count.
//
// Deriving market cap (price × shares) kept breaking on dual-class shares, ADRs and stale cover-page
// counts. Nasdaq publishes the number directly, so we use it and recompute the ratios from it.
// The summary also carries sector, industry and dividend yield.
//
//   node scripts/fetch-nasdaq.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const list = data.companies.filter((c) => c.ticker);
console.log(`${list.length} tickers`);

const num = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,%]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

let ok = 0, fail = 0;
for (const c of list) {
  try {
    const tryFetch = async (sym) => {
      const r = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!r.ok) return null;
      const jj = await r.json();
      return jj?.data?.summaryData || null;
    };
    // Nasdaq uses dots for share classes (BRK.B), the SEC uses dashes (BRK-B).
    let s = await tryFetch(c.ticker);
    if (!s && c.ticker.includes('-')) s = await tryFetch(c.ticker.replace(/-/g, '.'));
    if (!s) { fail++; continue; }
    const cap = num(s.MarketCap?.value);
    if (cap) { c.marketCap = cap; c.marketCapSource = 'nasdaq'; ok++; }
    const y = num(s.Yield?.value);
    if (y != null) c.dividendYield = y;
    if (s.Sector?.value && s.Sector.value !== 'N/A') c.nasdaqSector = s.Sector.value;
    if (s.Industry?.value && s.Industry.value !== 'N/A') c.industry = s.Industry.value;
  } catch { fail++; }
  await sleep(140);
  if ((ok + fail) % 100 === 0) console.log(`  ${ok + fail}/${list.length} · ok ${ok}`);
}

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`market cap from Nasdaq: ${ok} · failed ${fail}`);
