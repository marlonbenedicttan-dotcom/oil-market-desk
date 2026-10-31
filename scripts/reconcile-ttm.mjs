// Trailing-twelve-month reconciliation: the headline must be the four quarters the page shows.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileTtm } from '../src/lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const stat = reconcileTtm(data.companies);

console.log(`ttm reconciled · ${stat.adopted} taken from quarters · ${stat.held} already agreeing · ${stat.gaps} where the quarter table is behind · ${stat.unresolved} with no quarters`);
if (stat.changes.length) {
  console.log('largest corrections:');
  stat.changes
    .sort((a, b) => Math.abs(b[3] - (b[1] || 0)) - Math.abs(a[3] - (a[1] || 0)))
    .slice(0, 6)
    .forEach(([t, before, wasAsOf, after, nowAsOf]) =>
      console.log(`  ${t.padEnd(6)} ${before == null ? '—' : (before / 1e9).toFixed(2) + 'B'} (${wasAsOf || '—'}) → ${(after / 1e9).toFixed(2)}B (${nowAsOf})`));
}

if (DRY) console.log('dry run — nothing written');
else {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
