// Tag every US company with the S&P size index it belongs to: 500 (large), 400 (mid) or 600 (small).
//
// SPTM only tells us the composite membership. The three SPDR funds are the authoritative sub-index
// lists, so the MARKET view can offer S&P 1500 / 500 / 400 / 600 as separate cohorts without guessing
// from market cap. A company in the composite but absent from all three keeps `spTier: null` and is
// still counted in the 1500 cohort.
//
//   node scripts/attach-us-tiers.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHoldingsAt, normalizeTicker } from './us-universe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const BASE = 'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us';
const FUNDS = {
  sp500: [`${BASE}/holdings-daily-us-en-spy.xlsx`, join(ROOT, 'data', '.spy-holdings.xlsx')],
  sp400: [`${BASE}/holdings-daily-us-en-mdy.xlsx`, join(ROOT, 'data', '.mdy-holdings.xlsx')],
  sp600: [`${BASE}/holdings-daily-us-en-spsm.xlsx`, join(ROOT, 'data', '.spsm-holdings.xlsx')],
};

const tierOf = new Map();
for (const [tier, [url, file]] of Object.entries(FUNDS)) {
  const list = await fetchHoldingsAt(url, file);
  for (const m of list) tierOf.set(m.ticker, tier);
  console.log(`${tier}: ${list.length}`);
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const missing = [];
let tagged = 0;
for (const c of data.companies) {
  const tier = tierOf.get(normalizeTicker(c.ticker));
  if (tier) { c.spTier = tier; tagged++; }
  else { delete c.spTier; missing.push(c.ticker); }
}
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`tiers tagged: ${tagged}/${data.companies.length}${missing.length ? ` · untiered: ${missing.slice(0, 20).join(' ')}` : ''}`);
