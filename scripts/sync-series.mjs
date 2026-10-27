// Make the five-year table's latest row agree with the audited headline.
//
// The series comes from the annual-frames pass, which was built before the headline figures were
// repaired (banks' revenue components, stale equity tags, preferred-adjusted earnings). The result is a
// table whose last row contradicts the numbers printed above it — AXP shows $41.3B of revenue in the
// series and $72.2B in the headline, for the same fiscal year.
//
// This copies the audited headline into the series row for the same year. Older years are left as filed.
//
//   node scripts/sync-series.mjs --dry

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) : null);

let synced = 0;
let rows = 0;
for (const c of data.companies) {
  const s = c.series || [];
  if (!s.length) continue;
  const years = {
    revenue: c.fyRevenue || yearOf(c.netIncomeEnd),
    netIncome: yearOf(c.netIncomeEnd) || c.fyNetIncome,
    assets: yearOf(c.assetsEnd) || c.fyAssets,
    equity: yearOf(c.equityEnd) || c.fyAssets,
  };
  let touched = false;
  for (const f of ['revenue', 'netIncome', 'assets', 'equity']) {
    const y = years[f];
    if (!y || c[f] == null) continue;
    const row = s.find((x) => x.fy === y);
    if (!row) continue;
    if (row[f] !== c[f]) { row[f] = c[f]; touched = true; }
  }
  if (touched) { synced++; rows += 1; }
}

console.log(`${synced} companies · latest series row synced to the audited headline`);
if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
