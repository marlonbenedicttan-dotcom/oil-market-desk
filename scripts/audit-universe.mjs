// Universe audit: is the set itself well formed?
//
// Counts, uniqueness, weights, sectors, share classes and required identity fields. This is the layer
// that would have caught "499 of 503" in the old S&P 500 set before it reached the screen.
//
//   node scripts/audit-universe.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'companies.json'), 'utf8'));
const C = data.companies || [];
const issues = [];

const members = data.universe?.members;
const absent = Array.isArray(data.universe?.absent) ? data.universe.absent : [];
const ciks = new Set(C.filter((c) => c.cik).map((c) => String(c.cik)));
const tickers = new Map();
for (const c of C) {
  if (!c.ticker) { issues.push(`row without a ticker: ${c.name || '(unnamed)'}`); continue; }
  if (tickers.has(c.ticker)) issues.push(`duplicate ticker ${c.ticker}`);
  tickers.set(c.ticker, c);
}

console.log(`UNIVERSE AUDIT · ${C.length} securities · ${ciks.size} companies · ${data.universe?.name || 'unknown'} · ${C.length + absent.length}/${members ?? '?'} members accounted for\n`);

// --- counts ----------------------------------------------------------------
// A member with no sourceable row is disclosed in `universe.absent`; it is never dropped silently.
if (members && C.length + absent.length !== members) {
  issues.push(`row count ${C.length} + ${absent.length} absent ≠ universe members ${members}`);
}
const shareClasses = C.filter((c) => c.shareClass);
const companies = C.length - shareClasses.length;
if (data.universe?.companies != null && companies !== data.universe.companies) {
  issues.push(`company count ${companies} ≠ universe companies ${data.universe.companies}`);
}
for (const a of absent) if (!a.ticker || !a.reason) issues.push(`absent member without a reason: ${JSON.stringify(a)}`);

// --- identity --------------------------------------------------------------
for (const c of C) {
  for (const f of ['cik', 'name', 'ticker', 'sector', 'price', 'marketCap']) {
    if (c[f] == null || c[f] === '') issues.push(`${c.ticker || c.name}: missing ${f}`);
  }
}

// --- sectors ---------------------------------------------------------------
const sectors = new Set(C.map((c) => c.sector).filter(Boolean));
if (sectors.has('Other')) issues.push(`sector "Other" still present: ${C.filter((c) => c.sector === 'Other').map((c) => c.ticker).join(' ')}`);
console.log(`sectors: ${[...sectors].sort().join(', ')}`);

// --- share classes ---------------------------------------------------------
for (const c of shareClasses) {
  const sib = tickers.get(c.shareClassOf);
  if (!sib) issues.push(`${c.ticker}: share class of missing ${c.shareClassOf}`);
  else if (String(sib.cik) !== String(c.cik)) issues.push(`${c.ticker}: CIK ${c.cik} ≠ sibling ${sib.cik}`);
  if (c.marketCap === sib?.marketCap) issues.push(`${c.ticker}: market cap identical to sibling (clone not priced?)`);
}

// --- index weights ---------------------------------------------------------
const weighted = C.filter((c) => c.indexWeight != null);
const sum = weighted.reduce((a, c) => a + c.indexWeight, 0);
console.log(`\nindex weights: ${weighted.length}/${C.length} present · sum ${sum.toFixed(3)}%`);
if (weighted.length !== C.length) {
  const missing = C.filter((c) => c.indexWeight == null).map((c) => c.ticker);
  issues.push(`${missing.length} without an index weight: ${missing.slice(0, 8).join(' ')}`);
}
if (sum < 99 || sum > 101) issues.push(`index weights sum to ${sum.toFixed(3)}%, expected ~100`);

// --- market cap vs weights -------------------------------------------------
// If both are right, cap share and weight share should track each other. A 3× gap means one is wrong.
const totalCap = weighted.reduce((a, c) => a + (c.marketCap || 0), 0);
const skew = weighted
  .filter((c) => c.marketCap && totalCap && c.indexWeight)
  .map((c) => ({ t: c.ticker, r: (c.marketCap / totalCap) / (c.indexWeight / sum) }))
  // SPTM weights are float-adjusted, so a low-float company can legitimately carry far less weight
  // than its market cap implies. Large caps rarely diverge past 10×; small caps with a controlling
  // holder (Skydance, Sphere, Life360, Laureate) legitimately pass 20×. A 50× gap still means one of
  // the two numbers is wrong, not that the float is small.
  .filter((x) => x.r > 50 || x.r < 0.02)
  .sort((a, b) => Math.abs(Math.log(b.r)) - Math.abs(Math.log(a.r)));
if (skew.length) issues.push(`${skew.length} cap/weight mismatches: ${skew.slice(0, 6).map((x) => `${x.t} ${x.r.toFixed(1)}x`).join(' ')}`);

console.log(`\n${issues.length} universe issues`);
for (const i of issues.slice(0, 20)) console.log('  ' + i);
if (issues.length > 20) console.log(`  … ${issues.length - 20} more`);
// The universe accounting is an invariant, not a market move: a non-zero exit is a real gate.
if (issues.length) process.exit(1);
