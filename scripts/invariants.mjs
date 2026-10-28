// Invariants: the checks that catch a wrong *input*, not just wrong arithmetic.
//
// The audit answers "do the ratios match the primitives". This answers "are the primitives possible".
// Every failure is grouped by cause so the fix is one rule, not one company at a time.
//
//   node scripts/invariants.mjs
//   node scripts/invariants.mjs --verbose

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const OUT = join(ROOT, 'data', 'invariants.json');
const VERBOSE = process.argv.includes('--verbose');

const C = JSON.parse(readFileSync(FILE, 'utf8')).companies;
const DAY = 86400000;

const newestFY = Math.max(...C.map((c) => c.fyNetIncome || 0));
const newestTTM = Math.max(0, ...C.map((c) => Date.parse(c.netIncomeTTMAsOf || '')).filter(Number.isFinite));
const maxAssets = Math.max(...C.map((c) => c.assets || 0));

const issues = new Map();
const add = (cause, ticker, detail) => {
  if (!issues.has(cause)) issues.set(cause, []);
  issues.get(cause).push({ ticker, detail });
};

for (const c of C) {
  const t = c.ticker || c.name;

  // A company that has not filed a 10-K yet (a 2026 spin-off) cannot have financials; that is a fact
  // about the company, not a defect in the pipeline.
  if (c.noFilings) { add('no annual report yet (new listing)', t, 'Form 10 filed, no 10-K'); continue; }

  // --- coverage, with a reason rather than a bare dash ------------------------
  for (const [field, reason] of [
    ['revenue', 'no consolidated revenue tag'],
    ['netIncome', 'no after-tax net income tag'],
    ['equity', 'no stockholders-equity tag'],
  ]) {
    if (c[field] == null) add(`missing: ${field} (${reason})`, t, '');
  }

  // --- scope: a component is not a total -------------------------------------
  if (c.revenue != null && c.netIncome != null && c.netIncome > c.revenue * 1.02) {
    add('revenue looks like a component (profit > revenue)', t, `${(c.revenue / 1e9).toFixed(2)}B vs NI ${(c.netIncome / 1e9).toFixed(2)}B`);
  }
  if (c.revenue != null && c.assets != null && c.assets > 5e9 && c.sector !== 'Financials'
      && c.revenue < c.assets * 0.01) {
    add('revenue implausibly small vs assets', t, `${(c.revenue / 1e9).toFixed(2)}B vs assets ${(c.assets / 1e9).toFixed(0)}B`);
  }

  // --- balance sheet must be internally possible -----------------------------
  if (c.equity != null && c.assets != null && c.equity > c.assets * 1.01) {
    add('equity exceeds assets', t, `${(c.equity / 1e9).toFixed(1)}B > ${(c.assets / 1e9).toFixed(1)}B`);
  }
  if (c.currentAssets != null && c.assets != null && c.currentAssets > c.assets * 1.01) {
    add('current assets exceed total assets', t, `${(c.currentAssets / 1e9).toFixed(1)}B > ${(c.assets / 1e9).toFixed(1)}B`);
  }
  if (c.currentLiabilities != null && c.assets != null && c.currentLiabilities > c.assets * 1.01) {
    add('current liabilities exceed total assets', t, `${(c.currentLiabilities / 1e9).toFixed(1)}B > ${(c.assets / 1e9).toFixed(1)}B`);
  }

  // --- period freshness ------------------------------------------------------
  if (c.fyNetIncome && c.fyNetIncome < newestFY - 2) {
    add('stale fiscal year', t, `FY${c.fyNetIncome} vs universe FY${newestFY}`);
  }
  if (c.netIncomeTTMAsOf && newestTTM && !c.ttmFromFY && newestTTM - Date.parse(c.netIncomeTTMAsOf) > 500 * DAY) {
    add('stale trailing quarters', t, c.netIncomeTTMAsOf);
  }
  // A profit turning into a loss is a real event, not a data error. Only earnings above revenue are
  // impossible; losses are allowed to 3x revenue.
  if (c.netIncomeTTM != null && c.revenue
      && (c.netIncomeTTM > c.revenue * 1.2 || c.netIncomeTTM < c.revenue * -3)) {
    add('TTM implausible against revenue', t, `${(c.netIncomeTTM / c.revenue).toFixed(2)}x revenue`);
  }

  // --- market cap must agree with price x shares -----------------------------
  if (c.marketCap && c.price && c.shares) {
    const implied = c.price * c.shares;
    const d = Math.abs(implied - c.marketCap) / c.marketCap;
    if (d > 0.10) add('cap vs price x shares (class/ADR/buyback)', t, `${(d * 100).toFixed(0)}%`);
  }

  // --- cash flow -------------------------------------------------------------
  if (c.fcf != null && c.operatingCashFlow != null && c.fcf > c.operatingCashFlow + 1) {
    add('free cash flow above operating cash flow', t, `${(c.fcf / 1e9).toFixed(1)}B vs ${(c.operatingCashFlow / 1e9).toFixed(1)}B`);
  }
  if (c.fcf != null && c.revenue && Math.abs(c.fcf) > c.revenue * 2) {
    add('free cash flow implausible vs revenue', t, `${(c.fcf / 1e9).toFixed(1)}B vs ${(c.revenue / 1e9).toFixed(1)}B`);
  }

  // --- ratios in a band a human would accept ---------------------------------
  if (c.pe != null && c.pe > 300 && c.sector !== 'Financials') add('P/E above 300 (check earnings)', t, String(c.pe));
  if (c.pb != null && c.pb > 100) add('P/B above 100 (check equity)', t, String(c.pb));
  if (c.evEbitda != null && c.evEbitda > 100) add('EV/EBITDA above 100 (check D&A)', t, String(c.evEbitda));
  if (c.debt != null && c.assets != null && c.debt > c.assets) {
    add('debt exceeds assets', t, `${(c.debt / 1e9).toFixed(0)}B > ${(c.assets / 1e9).toFixed(0)}B`);
  }
}

// Not every flag is a defect. A high P/B at an asset-light company and a market cap that cannot be
// reproduced from one share class are expected; they are review items, not work items.
const INFORMATIONAL = /cap vs price|P\/B above|P\/E above|EV\/EBITDA above|no annual report yet/;

const rows = [...issues.entries()].sort((a, b) => b[1].length - a[1].length);
const total = rows.reduce((a, [, v]) => a + v.length, 0);
const actionable = rows.filter(([k]) => !INFORMATIONAL.test(k)).reduce((a, [, v]) => a + v.length, 0);
console.log(`${C.length} companies · ${total} flags (${actionable} actionable, ${total - actionable} informational) in ${rows.length} causes\n`);

for (const [cause, list] of rows) {
  console.log(`${String(list.length).padStart(4)}  ${cause}`);
  const show = VERBOSE ? list : list.slice(0, 8);
  for (const x of show) console.log(`        ${x.ticker.padEnd(6)} ${x.detail}`);
  if (!VERBOSE && list.length > show.length) console.log(`        … ${list.length - show.length} more`);
}

writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  companies: C.length,
  total,
  causes: Object.fromEntries(rows.map(([k, v]) => [k, v])),
}, null, 1));
console.log(`\nwrote ${OUT}`);
