// Complete the S&P 500 set: the four constituents the company list was missing.
//
// SPY holds 503 securities but only 500 companies, because three of them are dual-class pairs:
// GOOGL/GOOG (Alphabet), FOXA/FOX (Fox), NWSA/NWS (News Corp). Our list had one row per CIK, so those
// three second classes and one recent spin-off (VYLR) were absent — "499 of 503".
//
// A share-class row carries the same filings as its sibling but its own price and market cap, and is
// marked `shareClass` so totals never double-count the company.
//
//   node scripts/add-share-classes.mjs
//   node scripts/add-share-classes.mjs --dry

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLASSES = [
  { ticker: 'GOOG', of: 'GOOGL', name: 'Alphabet Inc. Class C' },
  { ticker: 'FOX', of: 'FOXA', name: 'Fox Corp Class B' },
  { ticker: 'NWS', of: 'NWSA', name: 'News Corp Class B' },
];
// VYLR is its own company (a 2026 spin-off) with a Form 10 but no 10-K yet.
const NEW_LISTING = { ticker: 'VYLR', cik: '2128626', name: 'Vylor Inc.' };

async function quote(ticker) {
  const sym = String(ticker).replace('-', '.');
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      });
      if (!res.ok) { await sleep(600 * (i + 1)); continue; }
      const j = await res.json();
      const d = j?.data;
      if (!d) return null;
      const s = d.summaryData || {};
      let price = Number(String(d.primaryData?.lastSalePrice || '').replace(/[$,]/g, '')) || null;
      if (!price) {
        // The summary endpoint returns a null primaryData for some share classes; the quote info
        // endpoint still carries the last sale.
        try {
          const r2 = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`, {
            headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
          });
          const j2 = await r2.json();
          price = Number(String(j2?.data?.primaryData?.lastSalePrice || '').replace(/[$,]/g, '')) || null;
        } catch { /* leave null */ }
      }
      const cap = Number(String(s.MarketCap?.value || '').replace(/[$,]/g, '')) || null;
      return {
        price, cap,
        sector: s.Sector?.value || null,
        industry: s.Industry?.value || null,
        yield: Number(String(s.Yield?.value || '').replace('%', '')) || null,
      };
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

async function profile(ticker) {
  try {
    const res = await fetch(`https://api.nasdaq.com/api/company/${ticker}/company-profile?assetclass=stocks`, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    });
    const j = await res.json();
    return j?.data?.CompanyDescription?.value || null;
  } catch { return null; }
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const byTicker = Object.fromEntries(data.companies.filter((c) => c.ticker).map((c) => [c.ticker, c]));
const added = [];

for (const cls of CLASSES) {
  if (byTicker[cls.ticker]) continue;
  const sib = byTicker[cls.of];
  if (!sib) { console.log(`  ${cls.ticker}: sibling ${cls.of} missing`); continue; }
  const q = await quote(cls.ticker);
  if (!q?.cap) { console.log(`  ${cls.ticker}: no quote`); continue; }
  const row = JSON.parse(JSON.stringify(sib));
  Object.assign(row, {
    ticker: cls.ticker,
    name: cls.name,
    indexName: cls.name.toUpperCase(),
    price: q.price,
    marketCap: Math.round(q.cap),
    marketCapSource: 'nasdaq',
    dividendYield: q.yield ?? sib.dividendYield ?? null,
    nasdaqSector: q.sector || sib.nasdaqSector,
    shareClass: true,
    shareClassOf: cls.of,
  });
  row.shares = q.price ? Math.round(q.cap / q.price) : row.shares;
  row.sharesDerived = true;
  data.companies.push(row);
  added.push(cls.ticker);
  await sleep(250);
}

if (!byTicker[NEW_LISTING.ticker]) {
  const q = await quote(NEW_LISTING.ticker);
  const desc = await profile(NEW_LISTING.ticker);
  if (q?.cap) {
    data.companies.push({
      cik: NEW_LISTING.cik,
      ticker: NEW_LISTING.ticker,
      name: NEW_LISTING.name,
      sector: q.sector === 'Consumer Staples' ? 'Consumer' : (q.sector || 'Other'),
      industry: q.industry || null,
      nasdaqSector: q.sector || null,
      price: q.price,
      marketCap: Math.round(q.cap),
      marketCapSource: 'nasdaq',
      shares: q.price ? Math.round(q.cap / q.price) : null,
      sharesDerived: true,
      dividendYield: q.yield ?? null,
      description: desc ? String(desc).replace(/\s+/g, ' ').trim().slice(0, 300) : null,
      descriptionSource: desc ? 'nasdaq' : null,
      noFilings: true,        // Form 10 filed, no 10-K yet: no XBRL financials exist
    });
    added.push(NEW_LISTING.ticker);
  }
}

console.log(`${added.length} added: ${added.join(' ')}`);
console.log(`now ${data.companies.length} securities`);
if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
