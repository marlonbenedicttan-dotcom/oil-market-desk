// Refresh the last sale price for every company, from the exchange's own quote endpoint.
//
// The dataset stores a price snapshot, and every ratio is computed from the market cap. A price that is
// a week old makes P/E a week old, so the daily refresh starts here.
//
//   node scripts/refresh-prices.mjs
//   node scripts/refresh-prices.mjs --only=AAPL,MSFT

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.ticker && (!onlySet || onlySet.has(c.ticker.toUpperCase())));
console.log(`${todo.length} tickers`);

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

let ok = 0;
let fail = 0;
let i = 0;
async function worker() {
  while (i < todo.length) {
    const c = todo[i++];
    const sym = String(c.ticker).replace('-', '.');
    try {
      const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (!res.ok) { fail++; await sleep(250); continue; }
      const j = await res.json();
      const px = num(j?.data?.primaryData?.lastSalePrice);
      if (!px) { fail++; await sleep(250); continue; }
      c.price = +px.toFixed(4);
      c.priceAt = new Date().toISOString();
      // A Nasdaq-sourced cap stays authoritative; anything else is price × shares.
      if (c.marketCapSource !== 'nasdaq' && c.shares) {
        c.marketCap = Math.round(c.price * c.shares);
        c.sharesDerived = true;
      }
      ok++;
    } catch { fail++; }
    await sleep(120);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

console.log(`prices refreshed: ${ok} · failed ${fail}`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
