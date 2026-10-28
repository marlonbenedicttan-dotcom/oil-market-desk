// Daily refresh: prices, market caps, and fundamentals for any company that filed something new.
//
// The point is that a new 10-Q should flow through to TTM earnings and every ratio without anyone
// running a script by hand. This is what the scheduled workflow calls.
//
//   node scripts/refresh-daily.mjs
//   node scripts/refresh-daily.mjs --skip-prices

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
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
}

step('new filings', ['scripts/detect-new-filings.mjs']);

let changed = [];
try {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', 'filings-changed.json'), 'utf8'));
  changed = (j.tickers || []).filter(Boolean);
} catch { /* none */ }

if (changed.length) {
  const only = `--only=${changed.join(',')}`;
  console.log(`\n${changed.length} companies filed something new: ${changed.slice(0, 12).join(' ')}${changed.length > 12 ? ' …' : ''}`);
  step('earnings', ['scripts/ttm-earnings.mjs', only]);
  step('balance sheet', ['scripts/balance-pass.mjs', only]);
  step('period alignment', ['scripts/align-periods.mjs', only]);
  step('net income repair', ['scripts/fix-net-income.mjs', only]);
  step('provenance', ['scripts/attach-provenance.mjs', only]);
  step('ratios', ['scripts/derive-companies.mjs']);
  step('second source', ['scripts/reconcile-nasdaq.mjs']);
  step('revenue definition', ['scripts/align-revenue.mjs']);
}

step('ratios', ['scripts/derive-companies.mjs']);
step('second source', ['scripts/reconcile-nasdaq.mjs']);
step('verdicts', ['scripts/arbitrate.mjs']);
step('single-source verification', ['scripts/verify-filing-index.mjs']);
step('series sync', ['scripts/sync-series.mjs']);
step('audit', ['scripts/audit-calculations.mjs']);

console.log('\ndaily refresh complete');
