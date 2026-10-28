// Align revenue with the standard "total revenue" definition.
//
// Banks and utilities are where the two publishers disagree by construction: a bank's top line can be
// net interest income, total interest income, or revenue net of interest expense; a utility's can include
// or exclude fuel pass-through. Both are defensible, but the column has to mean one thing.
//
// This pass tries the filing's own revenue tags first and keeps the one that measures the standard total.
// Where no tag matches, it adopts the exchange's total revenue and records that as the source.
//
//   node scripts/align-revenue.mjs --dry

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const RECON = join(ROOT, 'data', 'reconciliation.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DRY = process.argv.includes('--dry');
const CACHE = join(ROOT, 'data', 'cache', 'concepts');
const FACTS = join(ROOT, 'data', 'cache', 'facts');
mkdirSync(CACHE, { recursive: true });
mkdirSync(FACTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;

async function get(url) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 220 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (res.status === 429) { last = Date.now() + 4000; await sleep(4000 * (i + 1)); continue; }
      if (!res.ok) { await sleep(1500 * (i + 1)); continue; }
      return await res.json();
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

async function conceptUnits(cik, tag) {
  const file = join(CACHE, `${cik}_${tag}.json`);
  let doc = null;
  if (existsSync(file)) { try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { doc = null; } }
  if (!doc) {
    doc = await get(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`);
    if (doc) writeFileSync(file, JSON.stringify(doc));
  }
  const u = doc?.units?.USD;
  if (Array.isArray(u) && u.length) return u;
  const ff = join(FACTS, `${cik}.json`);
  let facts = null;
  if (existsSync(ff)) { try { facts = JSON.parse(readFileSync(ff, 'utf8')); } catch { facts = null; } }
  if (!facts) {
    facts = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`);
    if (facts) {
      const slim = { facts: { 'us-gaap': {} } };
      for (const [k, v] of Object.entries(facts.facts?.['us-gaap'] || {})) {
        if (Array.isArray(v?.units?.USD)) slim.facts['us-gaap'][k] = { units: { USD: v.units.USD } };
      }
      writeFileSync(ff, JSON.stringify(slim));
    }
  }
  const u2 = facts?.facts?.['us-gaap']?.[tag]?.units?.USD;
  return Array.isArray(u2) ? u2 : null;
}

function annual(usd, year) {
  const rows = (usd || []).filter((e) => e.start && e.end && e.form === '10-K' && dur(e) > 300 && dur(e) < 400);
  if (!rows.length) return null;
  rows.sort((a, b) => a.end.localeCompare(b.end));
  const hit = year ? rows.find((e) => Number(e.end.slice(0, 4)) === year) : null;
  const x = hit || rows[rows.length - 1];
  return { val: x.val, end: x.end };
}

const TAGS = [
  'Revenues',
  'RevenuesNetOfInterestExpense',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RegulatedAndUnregulatedOperatingRevenue',
  'OperatingRevenues',
  'RevenuesExcludingInterestAndDividends',
  'InterestIncomeExpenseNet',
  'SalesRevenueNet',
];

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const recon = JSON.parse(readFileSync(RECON, 'utf8'));
const target = Object.fromEntries(recon.companies.filter((r) => r.ticker && r.nasdaq?.revenue).map((r) => [r.ticker, r.nasdaq.revenue]));
const rPeriod = Object.fromEntries(recon.companies.filter((r) => r.ticker && r.period).map((r) => [r.ticker, r.period]));

const todo = data.companies.filter((c) => {
  const t = target[c.ticker];
  if (!t || !c.revenue) return false;
  const diff = Math.abs(c.revenue - t) / Math.max(c.revenue, t);
  return diff > 0.05;
});
console.log(`${todo.length} companies whose revenue differs from the exchange by more than 5%`);

let viaTag = 0;
let viaExchange = 0;
let left = 0;
for (const c of todo) {
  const t = target[c.ticker];
  const year = c.fyRevenue || (c.netIncomeEnd ? Number(String(c.netIncomeEnd).slice(0, 4)) : null);
  let best = null;
  for (const tag of TAGS) {
    const v = annual(await conceptUnits(c.cik, tag), year);
    if (!v) continue;
    const diff = Math.abs(v.val - t) / Math.max(v.val, t);
    if (diff <= 0.05 && (!best || diff < best.diff)) best = { ...v, tag, diff };
  }
  if (best) {
    c.revenue = best.val;
    c.fyRevenue = Number(best.end.slice(0, 4));
    c.revenueTag = best.tag;
    c.revenueSource = 'sec';
    viaTag++;
    console.log(`  ${c.ticker}: ${(c.revenue / 1e9).toFixed(1)}B via ${best.tag}`);
    continue;
  }
  // No tag measures the standard total: adopt the exchange's figure, and say so.
  // Adopt the exchange figure only when the periods actually match: JBL's exchange row is FY2025 while
  // our fiscal year is FY2026, and copying it would put last year's revenue on this year's balance sheet.
  const periodOk = !rPeriod[c.ticker] || !c.netIncomeEnd
    || Math.abs(Date.parse(rPeriod[c.ticker]) - Date.parse(c.netIncomeEnd)) < 120 * 86400000;
  if (periodOk) {
    c.revenue = t;
    c.revenueSource = 'nasdaq';
    c.revenueBasis = 'exchange total revenue';
    viaExchange++;
    console.log(`  ${c.ticker}: ${(t / 1e9).toFixed(1)}B from the exchange (no matching tag)`);
  } else {
    left++;
    console.log(`  ${c.ticker}: left as filed (${(c.revenue / 1e9).toFixed(1)}B vs ${(t / 1e9).toFixed(1)}B)`);
  }
  await sleep(60);
}

console.log(`\nvia filing tag ${viaTag} · via exchange ${viaExchange} · left ${left}`);
if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
