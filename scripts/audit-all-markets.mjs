// Audit every company market in one pass.
//
//   node scripts/audit-all-markets.mjs
//
// Runs the per-market hard audits, the Indonesia/Brazil/South Africa deep audits, the refresh-collapse guards and
// the cross-market freshness check. Writes data/audit-all-markets.json and exits non-zero if any step
// fails. The scheduled markets-audit-daily workflow runs this after the daily refreshes.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const STEPS = [
  // US
  ['US', 'audit-calculations.mjs'],
  ['US', 'audit-deep.mjs'],
  ['US', 'audit-universe.mjs'],
  ['US', 'audit-freshness.mjs'],
  ['US', 'audit-deals.mjs'],
  ['US', 'invariants.mjs'],
  ['US', 'reconcile-nasdaq.mjs'],
  ['US', 'arbitrate.mjs'],
  // check-snapshot is deliberately not a hard gate: a new filing legitimately moves equity/profit
  // beyond the baseline tolerance (see companies-daily). Refresh the baseline deliberately with
  // `node scripts/check-snapshot.mjs --update`; the all-markets scheduled audit must not go red on it.
  ['US', 'audit-themes.mjs'],
  // US / Japan / Korea cross-market source check
  ['US / JP / KR', 'audit-markets.mjs'],
  // Taiwan
  ['TW', 'audit-taiwan.mjs'],
  ['TW', 'audit-taiwan-refresh.mjs'],
  // Hong Kong
  ['HK', 'audit-hongkong.mjs'],
  ['HK', 'audit-market-refresh.mjs', 'hk'],
  // Australia
  ['AU', 'audit-australia.mjs'],
  ['AU', 'audit-market-refresh.mjs', 'au'],
  // India
  ['IN', 'audit-india.mjs'],
  ['IN', 'audit-market-refresh.mjs', 'in'],
  // Indonesia
  ['ID', 'audit-indonesia.mjs'],
  ['ID', 'audit-indonesia-deep.mjs'],
  ['ID', 'audit-market-refresh.mjs', 'id'],
  // Brazil
  ['BR', 'audit-brazil.mjs'],
  ['BR', 'audit-brazil-deep.mjs'],
  ['BR', 'audit-market-refresh.mjs', 'br'],
  // South Africa
  ['ZA', 'audit-southafrica.mjs'],
  ['ZA', 'audit-southafrica-deep.mjs'],
  ['ZA', 'audit-market-refresh.mjs', 'za'],
  // Freshness across all committed datasets
  ['ALL', 'check-freshness.mjs'],
];

const started = Date.now();
const report = { checked: new Date().toISOString(), ok: true, durationMs: 0, steps: [], failures: [] };

for (const [market, script, ...args] of STEPS) {
  const t0 = Date.now();
  console.log(`\n=== ${market} · ${script}${args.length ? ' ' + args.join(' ') : ''} ===`);
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  report.steps.push({ market, script, args, status: r.status, signal: r.signal, ok, ms });
  if (!ok) {
    report.ok = false;
    const label = `${market} · ${script}${args.length ? ' ' + args.join(' ') : ''}`;
    report.failures.push(`${label} exited ${r.status == null ? r.signal : r.status}`);
    console.log(`--- FAIL (${ms}ms) ---`);
  } else {
    console.log(`--- ok (${ms}ms) ---`);
  }
}

report.durationMs = Date.now() - started;
writeFileSync(join(ROOT, 'data', 'audit-all-markets.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n${report.ok ? 'ALL MARKETS PASS' : 'AUDIT FAILURES'} — ${report.steps.length} steps, ${(report.durationMs / 1000).toFixed(1)}s`);
for (const f of report.failures) console.log(`  ✗ ${f}`);
console.log('report: data/audit-all-markets.json');
process.exit(report.ok ? 0 : 1);
