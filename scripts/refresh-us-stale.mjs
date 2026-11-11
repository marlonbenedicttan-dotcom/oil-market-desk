// Repair US filings whose latest 10-K/10-Q is newer than the values we publish.
//
// Daily detection only sees accessions it has not recorded. A cache miss during that run, a filing
// detected before the facts feed caught up, or a company first seen before the current cache policy
// could leave TTM, assets, equity or debt behind forever. This sweep finds those companies and forces
// a fresh resolution from SEC, then repairs the derived columns.
//
//   node scripts/refresh-us-stale.mjs
//   node scripts/refresh-us-stale.mjs --dry

import { readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const CACHE = join(ROOT, 'data', 'cache');

const isFundamental = (c) => /^(10-[KQ]|20-F|40-F)/.test(String(c.lastFiling?.form || ''));
const stale = data.companies.filter((c) => {
  if (!c.cik || !c.lastFiling?.period || !isFundamental(c)) return false;
  const qEnd = (c.quarters || []).slice(-1)[0]?.end || null;
  return (qEnd && c.lastFiling.period > qEnd)
    || (c.netIncomeTTMAsOf && c.lastFiling.period > c.netIncomeTTMAsOf)
    || (c.assetsEnd && c.lastFiling.period > c.assetsEnd)
    || (c.equityEnd && c.lastFiling.period > c.equityEnd)
    || (c.debtEnd && c.lastFiling.period > c.debtEnd);
});
console.log(`${stale.length} US companies with a filing newer than their published facts`);
if (!stale.length) process.exit(0);
const tickers = stale.map((c) => c.ticker).filter(Boolean);
console.log(tickers.slice(0, 20).join(' ') + (tickers.length > 20 ? ' …' : ''));
if (DRY) process.exit(0);

// Force the source caches to refetch for exactly these CIKs.
for (const c of stale) {
  const cik = String(c.cik);
  for (const rel of [`facts/${cik}.json`, `facts-broad/${cik}.json`]) {
    try { unlinkSync(join(CACHE, rel)); } catch { /* absent */ }
  }
  try {
    for (const f of readdirSync(join(CACHE, 'concepts'))) {
      if (f.startsWith(`${cik}_`)) unlinkSync(join(CACHE, 'concepts', f));
    }
  } catch { /* absent */ }
}
const only = `--only=${[...new Set(tickers)].join(',')}`;
const run = (script, args = []) => {
  console.log(`\n── ${script} ${args.join(' ')} ──`);
  execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, stdio: 'inherit' });
};
run('resolve-quarters.mjs', [only, '--fetch']);
run('align-periods.mjs', [only]);
run('refresh-us-debt-shares.mjs');
run('refresh-us-instance-debt.mjs', ['--limit=25']);
run('refresh-us-instance-balance.mjs', ['--limit=25']);
run('reconcile-ttm.mjs');
run('apply-restatements.mjs');
run('derive-companies.mjs');
run('sync-series.mjs');
