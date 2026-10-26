// Golden-file diff gate.
//
// Every rebuild can silently move a number. This compares the current dataset against a committed
// snapshot and refuses to pass when a value moves by more than a threshold without the snapshot being
// deliberately refreshed. That turns "nobody noticed Broadcom's P/E went 40 → 260" into a failed check.
//
//   node scripts/check-snapshot.mjs            # compare (exit 1 on unexplained movement)
//   node scripts/check-snapshot.mjs --update   # accept the current data as the new baseline

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const SNAP = join(ROOT, 'data', 'snapshot.json');
const UPDATE = process.argv.includes('--update');

const FIELDS = ['revenue', 'netIncome', 'assets', 'equity', 'marketCap', 'pe', 'pb', 'evEbitda'];
// Ratios legitimately swing; absolute figures should not move 20% without a reason.
const TOL = { revenue: 0.2, netIncome: 0.3, assets: 0.2, equity: 0.2, marketCap: 0.25, pe: 0.5, pb: 0.5, evEbitda: 0.5 };

const C = JSON.parse(readFileSync(FILE, 'utf8')).companies;
const current = {};
for (const c of C) {
  if (!c.ticker) continue;
  current[c.ticker] = Object.fromEntries(FIELDS.map((f) => [f, c[f] ?? null]));
}

if (UPDATE || !existsSync(SNAP)) {
  writeFileSync(SNAP, JSON.stringify({ updated: new Date().toISOString(), companies: current }, null, 0));
  console.log(`${UPDATE ? 'updated' : 'created'} ${SNAP} with ${Object.keys(current).length} companies`);
  process.exit(0);
}

const prev = JSON.parse(readFileSync(SNAP, 'utf8')).companies;
const moves = [];
for (const [t, now] of Object.entries(current)) {
  const was = prev[t];
  if (!was) { moves.push([t, 'new company', '', '']); continue; }
  for (const f of FIELDS) {
    const a = was[f];
    const b = now[f];
    if (a == null && b == null) continue;
    if (a == null || b == null) { moves.push([t, f, String(a), String(b)]); continue; }
    const rel = Math.abs(b - a) / Math.max(Math.abs(a), Math.abs(b));
    if (rel > (TOL[f] || 0.2)) moves.push([t, f, a, b, (rel * 100).toFixed(0) + '%']);
  }
}
for (const t of Object.keys(prev)) if (!current[t]) moves.push([t, 'removed', '', '']);

if (!moves.length) { console.log(`no movement beyond tolerance across ${Object.keys(current).length} companies`); process.exit(0); }

console.log(`${moves.length} values moved beyond tolerance:\n`);
for (const m of moves.slice(0, 40)) console.log('  ' + m.join('  '));
if (moves.length > 40) console.log(`  … ${moves.length - 40} more`);
console.log('\nIf these are legitimate (new filings), refresh the baseline: node scripts/check-snapshot.mjs --update');
process.exit(1);
