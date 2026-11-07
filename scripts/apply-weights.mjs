// Apply S&P 1500 index weights from the fund's own holdings file.
//
// The weights are what make the list sortable by "share of the index" and what caught SKYD's mismatch.
// They used to be applied once during the universe filter and were lost whenever a later pass rebuilt
// the file — VYLR ended up with none. SPTM's weights are the composite index's float-adjusted weights
// (SPY + MDY + SPSM in one file), so the column still sums to ~100.
//
//   node scripts/apply-weights.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHoldings, normalizeTicker, indexMap } from './us-universe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');

const weights = indexMap(await fetchHoldings());

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let set = 0;
const missing = [];
for (const c of data.companies) {
  const t = normalizeTicker(c.ticker);
  const m = weights.get(t);
  if (!m) { missing.push(c.ticker); continue; }
  if (c.indexWeight !== m.weight) { c.indexWeight = m.weight; set++; }
  if (!c.indexName) c.indexName = m.name;
}

const sum = data.companies.reduce((a, c) => a + (c.indexWeight || 0), 0);
console.log(`weights applied: ${set} updated · ${data.companies.length - missing.length}/${data.companies.length} matched · sum ${sum.toFixed(3)}%`);
if (missing.length) console.log('not in the holdings file:', missing.join(' '));

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log('written');
