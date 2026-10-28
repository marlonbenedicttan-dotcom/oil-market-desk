// Deep audit: the things the arithmetic audit cannot see.
//
// The reconciliation checks whether a number is right. This checks whether the *record* is complete and
// internally coherent: coverage per field, the five-year series agreeing with the headline figures,
// descriptions that are real sentences, share classes pointing at a sibling, and the universe count.
//
//   node scripts/audit-deep.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'companies.json'), 'utf8'));
const C = data.companies || [];
const issues = [];

const pct = (n) => `${((n / C.length) * 100).toFixed(1)}%`;

console.log(`DEEP AUDIT · ${C.length} securities · ${new Set(C.filter((c) => c.cik).map((c) => c.cik)).size} companies\n`);

// --- 1. coverage ------------------------------------------------------------
const FIELDS = ['price', 'marketCap', 'revenue', 'netIncome', 'netIncomeTTM', 'assets', 'equity', 'debt', 'cash', 'fcf', 'description', 'sector', 'cik'];
console.log('COVERAGE');
for (const f of FIELDS) {
  const n = C.filter((c) => c[f] != null && c[f] !== '').length;
  const gaps = C.filter((c) => c[f] == null || c[f] === '').map((c) => c.ticker);
  console.log(`  ${f.padEnd(13)} ${String(n).padStart(3)}/${C.length}  ${pct(n).padStart(6)}${gaps.length && gaps.length <= 6 ? '   missing: ' + gaps.join(' ') : ''}`);
}

// --- 2. universe ------------------------------------------------------------
const members = data.universe?.members;
if (members && C.length !== members) issues.push(`universe says ${members} constituents, data has ${C.length}`);
const noCik = C.filter((c) => !c.cik);
if (noCik.length) issues.push(`${noCik.length} rows without a CIK: ${noCik.map((c) => c.ticker).join(' ')}`);

// --- 3. share classes must point at a real sibling ---------------------------
for (const c of C.filter((x) => x.shareClass)) {
  const sib = C.find((x) => x.ticker === c.shareClassOf);
  if (!sib) issues.push(`${c.ticker}: share class points at missing ${c.shareClassOf}`);
  else if (sib.cik !== c.cik) issues.push(`${c.ticker}: CIK differs from sibling ${c.shareClassOf}`);
}

// --- 4. five-year series must agree with the headline ------------------------
const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) : null);
let seriesChecked = 0;
for (const c of C) {
  const s = (c.series || []).slice().sort((a, b) => a.fy - b.fy);
  if (!s.length) continue;
  const last = s[s.length - 1];
  seriesChecked++;
  // Each headline field carries its own period. Only compare when the series row is that same year,
  // otherwise a FY2026 headline is being judged against a FY2025 series row.
  const YEAR = {
    revenue: c.fyRevenue || yearOf(c.netIncomeEnd),
    netIncome: yearOf(c.netIncomeEnd) || c.fyNetIncome,
    assets: yearOf(c.assetsEnd) || c.fyAssets,
    equity: yearOf(c.equityEnd) || c.fyAssets,
  };
  for (const f of ['revenue', 'netIncome', 'assets', 'equity']) {
    if (c[f] == null || last[f] == null) continue;
    if (!YEAR[f] || last.fy !== YEAR[f]) continue;
    const rel = Math.abs(c[f] - last[f]) / Math.max(Math.abs(c[f]), Math.abs(last[f]));
    if (rel > 0.01) issues.push(`${c.ticker}: ${f} headline ${(c[f] / 1e9).toFixed(2)}B vs series FY${last.fy} ${(last[f] / 1e9).toFixed(2)}B`);
  }
}
console.log(`\nSERIES  ${seriesChecked} companies with history · checked against headline figures`);

// --- 5. descriptions --------------------------------------------------------
const RESIDUE = /(Item\s+\d+[A-Z]?\.|PART\s+I{1,3}\b|Mine Safety Disclosures|Table of Contents|FORM 10-K|Market for .{0,80}Common Equity|Issuer Purchases of Equity)/i;
// A lowercase first letter is fine when it is a brand ("eBay Inc. is …"); only punctuation is wrong.
const badDesc = C.filter((c) => c.description && (RESIDUE.test(c.description) || !/^[A-Za-z0-9"“]/.test(c.description)));
if (badDesc.length) issues.push(`${badDesc.length} descriptions look wrong: ${badDesc.slice(0, 5).map((c) => c.ticker).join(' ')}`);
console.log(`DESCRIPTIONS  ${C.filter((c) => c.description).length} present · ${badDesc.length} flagged`);

// --- 6. ratios must have their inputs ---------------------------------------
for (const c of C) {
  if (c.pe != null && !(c.marketCap > 0 && (c.netIncome > 0 || c.netIncomeTTM > 0))) issues.push(`${c.ticker}: P/E without positive earnings`);
  if (c.pb != null && !(c.marketCap > 0 && c.equity > 0)) issues.push(`${c.ticker}: P/B without positive equity`);
  if (c.evEbitda != null && !(c.ev > 0)) issues.push(`${c.ticker}: EV/EBITDA without EV`);
}

// --- 7. results -------------------------------------------------------------
console.log(`\n${issues.length} coherence issues`);
for (const i of issues.slice(0, 20)) console.log('  ' + i);
if (issues.length > 20) console.log(`  … ${issues.length - 20} more`);
