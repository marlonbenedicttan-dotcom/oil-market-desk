// Refresh US book equity from the latest 10-Q/10-K instant in the committed SEC company-facts cache.
//
// The annual balance pass used 10-K instants only, so P/B and ROE divided a TTM profit by book equity
// up to a year old (AMZN/GOOGL: equity 2025-12 vs profit 2026-09). The facts cache already contains the
// 10-Q instants; this reads them without another request.
//
//   node scripts/refresh-us-equity.mjs
//   node scripts/refresh-us-equity.mjs --dry
//
// Writes data/companies.json. Run `node scripts/derive-companies.mjs` afterwards to recompute P/B/ROE.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const FACTS = join(ROOT, 'data', 'cache', 'facts');
const DRY = process.argv.includes('--dry');
const data = JSON.parse(readFileSync(FILE, 'utf8'));

const EQUITY_TAGS = [
  'StockholdersEquity',
  'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  'CommonStockholdersEquity',
  'PartnersCapital',
  'PartnersCapitalIncludingPortionAttributableToNoncontrollingInterest',
];
const latest = (rows) => {
  const h = (rows || []).filter((e) => !e.start && e.end && e.val != null);
  h.sort((a, b) => a.end.localeCompare(b.end));
  return h.at(-1) || null;
};

let changed = 0, skipped = 0;
for (const c of data.companies || []) {
  if (!c.cik) continue;
  let facts = null;
  try { facts = JSON.parse(readFileSync(join(FACTS, `${c.cik}.json`), 'utf8')); } catch { continue; }
  const g = facts.facts && facts.facts['us-gaap'];
  if (!g) continue;
  let best = null;
  for (const tag of EQUITY_TAGS) {
    const row = latest(g[tag]?.units?.USD);
    if (!row) continue;
    if (!best || row.end > best.end) best = { ...row, tag };
  }
  if (!best) { skipped++; continue; }
  // Match the parent-owners' equity to the common-share market cap.
  if (/IncludingPortionAttributableToNoncontrollingInterest/.test(best.tag)) {
    const mi = latest(g.MinorityInterest?.units?.USD);
    if (mi && mi.end === best.end) best = { val: best.val - mi.val, end: best.end, tag: `${best.tag} less MinorityInterest` };
  }
  if (!(best.val > 0)) { skipped++; continue; }
  // The assets guard only makes sense when assets are at least as new as this equity instant.
  const assetsFresh = c.assetsEnd && best.end <= c.assetsEnd;
  if (assetsFresh && c.assets && (best.val > c.assets * 1.02 || best.val < -c.assets)) { skipped++; continue; }
  if (c.equityEnd && best.end < c.equityEnd) { skipped++; continue; }
  if (c.equity !== best.val) changed++;
  c.equity = best.val;
  c.equityEnd = best.end;
  c.equityTag = best.tag;
  c.equityForm = best.form || null;
}

console.log(`US equity: ${changed} values updated · ${skipped} skipped`);
if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
