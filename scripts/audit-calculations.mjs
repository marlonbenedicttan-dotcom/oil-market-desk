// Audit every derived number in the company dataset.
//
// Recompute each ratio from its primitives and compare with what is stored; then run sanity ranges.
// This is the structural check that has to pass before any new data is layered on top.
//
//   node scripts/audit-calculations.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'companies.json'), 'utf8'));
const C = data.companies || [];

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const pct = (n, d) => (n == null || d == null || d === 0 ? null : (n / d) * 100);

const issues = { marketCap: [], pe: [], pb: [], ev: [], evEbitda: [], current: [], de: [], margin: [], growth: [] };
const anomalies = [];
let checked = 0;

for (const c of C) {
  checked++;

  // --- recompute and compare -------------------------------------------------
  // Market cap from Nasdaq is the source of truth; price × shares is only a fallback, so it is not a
  // reconciliation error when they differ.
  if (c.marketCap != null && c.marketCapSource !== 'nasdaq' && c.price != null && c.shares != null) {
    const want = Math.round(c.price * c.shares);
    if (!near(c.marketCap, want, Math.max(1e6, want * 1e-6))) issues.marketCap.push([c.ticker, c.marketCap, want]);
  }
  if (c.pe != null) {
    // P/E is market cap ÷ net income — the same primitives derive() uses.
    const want = c.marketCap && c.netIncome > 0 ? +(c.marketCap / c.netIncome).toFixed(1) : null;
    if (want == null || !near(c.pe, want, 0.15)) issues.pe.push([c.ticker, c.pe, want]);
  }
  if (c.pb != null && c.equity > 0 && c.marketCap) {
    const want = +(c.marketCap / c.equity).toFixed(1);
    if (!near(c.pb, want, 0.15)) issues.pb.push([c.ticker, c.pb, want]);
  }
  if (c.ev != null && c.marketCap != null) {
    const want = c.marketCap + (c.debt || 0) - (c.cash || 0);
    if (!near(c.ev, want, 1)) issues.ev.push([c.ticker, c.ev, want]);
  }
  if (c.currentRatio != null && c.currentAssets != null && c.currentLiabilities > 0) {
    const want = +(c.currentAssets / c.currentLiabilities).toFixed(2);
    if (!near(c.currentRatio, want, 0.02)) issues.current.push([c.ticker, c.currentRatio, want]);
  }
  if (c.debtEquity != null && c.debt != null && c.equity > 0) {
    const want = +(c.debt / c.equity).toFixed(2);
    if (!near(c.debtEquity, want, 0.02)) issues.de.push([c.ticker, c.debtEquity, want]);
  }
  if (c.revenue && c.netIncome != null && c.netIncome > c.revenue * 1.2) issues.margin.push([c.ticker, c.revenue, c.netIncome]);

  // --- sanity ranges ---------------------------------------------------------
  if (c.marketCap != null && (c.marketCap < 1e6 || c.marketCap > 2e13)) anomalies.push(`${c.ticker}: market cap ${c.marketCap}`);
  if (c.pe != null && (c.pe > 500 || c.pe < 0.5)) anomalies.push(`${c.ticker}: P/E ${c.pe}`);
  if (c.pb != null && (c.pb > 100 || c.pb < 0)) anomalies.push(`${c.ticker}: P/B ${c.pb}`);
  if (c.currentRatio != null && c.currentRatio > 50) anomalies.push(`${c.ticker}: current ratio ${c.currentRatio}`);
  if (c.debtEquity != null && c.debtEquity > 50) anomalies.push(`${c.ticker}: D/E ${c.debtEquity}`);
  if (c.shares != null && c.shares < 1e5) anomalies.push(`${c.ticker}: shares ${c.shares}`);
  if (c.revenue != null && c.revenue < 0) anomalies.push(`${c.ticker}: negative revenue`);
  // Banks report net interest income as "revenue", so a margin there is meaningless by construction;
  // a one-off gain can also push a normal company above 100% legitimately.
  const m = pct(c.netIncome, c.revenue);
  if (m != null && c.sector !== 'Financials' && (m > 150 || m < -300)) anomalies.push(`${c.ticker}: margin ${m.toFixed(0)}%`);
}

const total = Object.values(issues).reduce((a, b) => a + b.length, 0);
console.log(`checked ${checked} companies · ${total} reconciliation mismatches · ${anomalies.length} out-of-range values\n`);
for (const [k, v] of Object.entries(issues)) {
  console.log(`${k.padEnd(12)} ${String(v.length).padStart(4)} mismatches`);
  for (const row of v.slice(0, 3)) console.log('   ', row.join(' | '));
}
console.log('\nAnomalies (first 12):');
for (const a of anomalies.slice(0, 12)) console.log('  ', a);

// Reference spot-checks against values that are widely known.
const by = Object.fromEntries(C.filter((c) => c.ticker).map((c) => [c.ticker, c]));
const refs = [
  ['AAPL', (c) => c.marketCap > 2e12, 'market cap above $2T'],
  ['MSFT', (c) => c.marketCap > 1e12, 'market cap above $1T'],
  ['AAPL', (c) => c.pe > 5 && c.pe < 120, 'P/E in a plausible band'],
  ['JPM', (c) => c.marketCap > 3e11, 'market cap above $300B'],
];
console.log('\nReference checks:');
for (const [t, fn, label] of refs) {
  const c = by[t];
  console.log(`  ${t.padEnd(5)} ${c ? (fn(c) ? 'PASS' : 'FAIL') : 'MISSING'}  ${label}`);
}
