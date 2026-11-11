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
  // The assets guard only makes sense when assets are at least as new as this equity instant.
  // Equity can be negative (Starbucks has bought back more than its book value); that is a real
  // balance-sheet fact, not a bad print. The assets guard only rejects a value that cannot be equity.
  if (c.equityEnd && best.end < c.equityEnd) { /* keep the newer existing equity */ }
  else if (c.assets && (best.val > c.assets * 1.02 || best.val < -c.assets)) skipped++;
  else {
    if (c.equity !== best.val) changed++;
    c.equity = best.val;
    c.equityEnd = best.end;
    c.equityTag = best.tag;
    c.equityForm = best.form || null;
  }

  // The annual balance pass aligned assets to the last 10-K; the latest 10-Q carries a newer instant.
  const asset = latest(g.Assets?.units?.USD);
  if (asset && (!c.assetsEnd || asset.end > c.assetsEnd)) {
    if (!(asset.val > 0)) { /* impossible; leave the old value */ }
    else { c.assets = asset.val; c.assetsEnd = asset.end; c.assetsTag = 'Assets'; }
  }
  const ca = latest(g.AssetsCurrent?.units?.USD);
  if (ca && ca.val > 0) c.currentAssets = ca.val;
  const cl = latest(g.LiabilitiesCurrent?.units?.USD);
  if (cl && cl.val > 0) c.currentLiabilities = cl.val;
}

console.log(`US equity: ${changed} values updated · ${skipped} skipped`);
if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
