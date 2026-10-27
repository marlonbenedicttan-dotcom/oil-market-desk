// Freshness audit: is the data current, and is every row internally on one period?
//
// Stale filings are the failure mode that produced DTE's 2014 numbers and Ford's 2024 earnings beside a
// 2025 market cap. This checks the age of each company's fiscal data, that the balance sheet is dated
// the same as the earnings, and the age of the dataset itself.
//
//   node scripts/audit-freshness.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'companies.json'), 'utf8'));
const C = data.companies || [];
const TODAY = Date.now();
const DAY = 864e5;
const issues = [];

const age = (d) => (d ? Math.round((TODAY - Date.parse(d)) / DAY) : null);
const iso = (d) => (d ? String(d).slice(0, 10) : null);

console.log(`FRESHNESS AUDIT · ${C.length} securities · data updated ${iso(data.updated)} (${age(data.updated)} days ago)`);
console.log(`universe as of ${data.universe?.asOf} (${age(data.universe?.asOf)} days ago)\n`);

if (age(data.updated) > 3) issues.push(`dataset is ${age(data.updated)} days old`);
if (age(data.universe?.asOf) > 21) issues.push(`universe snapshot is ${age(data.universe?.asOf)} days old`);

// --- fiscal data age -------------------------------------------------------
const stale = C.filter((c) => !c.noFilings && age(c.netIncomeEnd) > 540)
  .map((c) => `${c.ticker} FY${iso(c.netIncomeEnd)} (${age(c.netIncomeEnd)}d)`);
if (stale.length) issues.push(`${stale.length} filings older than 18 months: ${stale.slice(0, 8).join(' ')}`);

const noPeriod = C.filter((c) => !c.noFilings && !c.netIncomeEnd).map((c) => c.ticker);
if (noPeriod.length) issues.push(`${noPeriod.length} without a fiscal date: ${noPeriod.slice(0, 8).join(' ')}`);

// --- balance sheet must share the earnings date ----------------------------
const skew = [];
for (const c of C) {
  if (!c.netIncomeEnd || !c.assetsEnd) continue;
  const d = Math.abs(Date.parse(c.assetsEnd) - Date.parse(c.netIncomeEnd)) / DAY;
  if (d > 120) skew.push(`${c.ticker} income ${iso(c.netIncomeEnd)} vs assets ${iso(c.assetsEnd)}`);
}
if (skew.length) issues.push(`${skew.length} mixed-period balance sheets: ${skew.slice(0, 6).join(' · ')}`);

// --- coverage by period ----------------------------------------------------
const years = {};
for (const c of C) {
  const y = c.netIncomeEnd ? String(c.netIncomeEnd).slice(0, 4) : 'none';
  years[y] = (years[y] || 0) + 1;
}
console.log('fiscal years represented:', Object.entries(years).sort().map(([y, n]) => `${y}:${n}`).join('  '));

// --- price / cap age proxy -------------------------------------------------
const noPrice = C.filter((c) => c.price == null).map((c) => c.ticker);
if (noPrice.length) issues.push(`${noPrice.length} without a price: ${noPrice.join(' ')}`);

const offHours = C.filter((c) => c.marketCapSource !== 'nasdaq' && c.marketCap).map((c) => c.ticker);
if (offHours.length) issues.push(`${offHours.length} market caps not from the exchange: ${offHours.slice(0, 8).join(' ')}`);

console.log(`\n${issues.length} freshness issues`);
for (const i of issues.slice(0, 20)) console.log('  ' + i);
if (issues.length > 20) console.log(`  … ${issues.length - 20} more`);
