// Daily refresh: prices, market caps, and fundamentals for any company that filed something new.
//
// The point is that a new 10-Q should flow through to TTM earnings and every ratio without anyone
// running a script by hand. This is what the scheduled workflow calls.
//
//   node scripts/refresh-daily.mjs
//   node scripts/refresh-daily.mjs --skip-prices

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_PRICES = process.argv.includes('--skip-prices');
const step = (label, args) => {
  console.log(`\n── ${label} ──`);
  try {
    execFileSync('node', args, { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.log(`${label} failed: ${e.message}`);
  }
};

if (!SKIP_PRICES) {
  step('prices', ['scripts/refresh-prices.mjs']);
  step('market caps', ['scripts/fetch-nasdaq.mjs']);
  step('brands', ['scripts/attach-us-brands.mjs']);
  step('descriptions', ['scripts/attach-us-descriptions.mjs']);
}

step('new filings', ['scripts/detect-new-filings.mjs']);

let changed = [];
let changedCiks = [];
try {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', 'filings-changed.json'), 'utf8'));
  changed = (j.tickers || []).filter(Boolean);
  changedCiks = (j.details || []).map((d) => d.cik).filter(Boolean);
} catch { /* none */ }

if (changed.length) {
  // A new accession invalidates every per-CIK cache. Without this, align-periods and the equity pass
  // can keep serving the old filing while only resolve-quarters refetches its own cache.
  for (const cik of changedCiks) {
    for (const rel of [`facts/${cik}.json`, `facts-broad/${cik}.json`]) {
      try { unlinkSync(join(ROOT, 'data', 'cache', rel)); } catch { /* absent */ }
    }
    try {
      const dir = join(ROOT, 'data', 'cache', 'concepts');
      for (const f of readdirSync(dir)) if (f.startsWith(`${cik}_`)) unlinkSync(join(dir, f));
    } catch { /* absent */ }
  }
  const only = `--only=${changed.join(',')}`;
  console.log(`\n${changed.length} companies filed something new: ${changed.slice(0, 12).join(' ')}${changed.length > 12 ? ' …' : ''}`);
  step('earnings', ['scripts/ttm-earnings.mjs', only]);
  step('quarters', ['scripts/resolve-quarters.mjs', only, '--fetch']);
  step('annual fundamentals', ['scripts/resolve-fundamentals.mjs', only]);
  step('balance sheet', ['scripts/balance-pass.mjs', only]);
  step('period alignment', ['scripts/align-periods.mjs', only]);
  step('net income repair', ['scripts/fix-net-income.mjs', only]);
  step('provenance', ['scripts/attach-provenance.mjs', only]);
  step('ratios', ['scripts/derive-companies.mjs']);
  step('second source', ['scripts/reconcile-nasdaq.mjs']);
  step('revenue definition', ['scripts/align-revenue.mjs']);
}

// The headline TTM and the quarterly table are filled from different caches; make them agree after
// either has been refreshed, or the page shows a trailing profit the quarters below do not add up to.
step('ttm vs quarters', ['scripts/reconcile-ttm.mjs']);
step('equity instants', ['scripts/refresh-us-equity.mjs']);
step('debt and shares', ['scripts/refresh-us-debt-shares.mjs']);
step('ratios', ['scripts/derive-companies.mjs']);
step('second source', ['scripts/reconcile-nasdaq.mjs']);
// The second source can move a cap; recompute P/E, P/B and ROE against the final cap before the audit.
step('ratios after second source', ['scripts/derive-companies.mjs']);
step('verdicts', ['scripts/arbitrate.mjs']);
step('single-source verification', ['scripts/verify-filing-index.mjs']);
step('series sync', ['scripts/sync-series.mjs']);
step('stale US facts', ['scripts/refresh-us-stale.mjs']);
step('audit', ['scripts/audit-calculations.mjs']);

console.log('\ndaily refresh complete');
