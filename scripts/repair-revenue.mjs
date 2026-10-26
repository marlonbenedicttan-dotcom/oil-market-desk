// Repair revenue that came from the wrong tag.
//
// The annual-frames pass merges several revenue concepts and lets the last one win. For banks and
// insurers that last tag is often a component — "revenue from contracts with customers" for an insurer
// is premium income only, and net interest income for a bank is not the top line. The tell is a
// company whose net income exceeds its revenue, which cannot happen in a real income statement.
//
// This pass re-asks the SEC for the total-revenue tags, in order of specificity, and only accepts a
// value large enough to be a top line. If no tag qualifies, revenue is cleared rather than left wrong.
//
//   node scripts/repair-revenue.mjs --dry

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DRY = process.argv.includes('--dry');
const CACHE = join(ROOT, 'data', 'cache', 'concepts');
mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function concept(cik, tag) {
  const file = join(CACHE, `${cik}_${tag}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* refetch */ }
  }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`, {
        headers: { 'User-Agent': UA },
      });
      // Do not cache a 404: the SEC occasionally returns one transiently, and a cached "no such tag"
      // then looks like the company does not report revenue (that is how Bunge lost its top line).
      if (res.status === 404) return null;
      if (!res.ok) { await sleep(1200 * (i + 1)); continue; }
      const doc = await res.json();
      writeFileSync(file, JSON.stringify(doc));
      return doc;
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

const DAY = 86400000;
function annual(doc) {
  const usd = Array.isArray(doc?.units?.USD) ? doc.units.USD : [];
  const rows = usd.filter((e) => e.start && e.end && e.form === '10-K'
    && Date.parse(e.end) - Date.parse(e.start) > 300 * DAY
    && Date.parse(e.end) - Date.parse(e.start) < 400 * DAY);
  if (!rows.length) return null;
  rows.sort((a, b) => a.end.localeCompare(b.end));
  const x = rows[rows.length - 1];
  return { val: x.val, year: Number(x.end.slice(0, 4)) };
}

// Total revenue first, components last. A bank's top line is "revenues net of interest expense";
// an insurer's is "revenues".
const TAGS = [
  'Revenues',
  'RevenuesNetOfInterestExpense',
  'RevenuesExcludingInterestAndDividends',
  'InterestIncomeExpenseNet',
  'OperatingRevenues',
  'RegulatedAndUnregulatedOperatingRevenue',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'SalesRevenueNet',
];

const RECON = join(ROOT, 'data', 'reconciliation.json');
const RECON_MODE = process.argv.includes('--recon');
const TARGETS = new Map();

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const byTicker = Object.fromEntries(data.companies.filter((c) => c.ticker).map((c) => [c.ticker, c]));

// Two triggers:
//   1. internal  — profit exceeds revenue, which is impossible.
//   2. second source — Nasdaq's total revenue differs by more than 25%, which means our tag measured
//      a component. The second source decides *that* we are wrong; the filing still decides the value.
let bad;
if (RECON_MODE) {
  const recon = JSON.parse(readFileSync(RECON, 'utf8'));
  // Keep the actual record objects. Spreading them made a copy, so the repair wrote into a throwaway
  // and the file came back unchanged.
  bad = recon.companies
    .filter((r) => r.sector !== 'Financials' && (r.diff?.revenue ?? 0) > 0.25 && byTicker[r.ticker])
    .map((r) => { TARGETS.set(r.ticker, r.nasdaq.revenue); return byTicker[r.ticker]; });
} else {
  bad = data.companies.filter((c) => c.revenue > 0 && c.netIncome != null && c.netIncome > c.revenue * 1.2);
}
console.log(`${bad.length} companies with suspect revenue`);

for (const c of bad) {
  let chosen = null;
  for (const tag of TAGS) {
    const v = annual(await concept(c.cik, tag));
    if (!v) continue;
    const target = TARGETS.get(c.ticker);
    if (target) {
      // Accept the tag that measures the same scope the exchange reports, within 25%.
      if (Math.abs(v.val - target) / target <= 0.25) { chosen = { ...v, tag }; break; }
    } else if (v.val >= c.netIncome * 0.9) { chosen = { ...v, tag }; break; }
  }
  // Some registrants (Bunge Global's new CIK) 404 on the per-concept endpoint while their filing
  // index is complete. Fall back to the index before giving up on the field.
  if (!chosen) {
    const target = TARGETS.get(c.ticker);
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(c.cik).padStart(10, '0')}.json`, {
        headers: { 'User-Agent': UA },
      });
      if (res.ok) {
        const j = await res.json();
        for (const tag of TAGS) {
          const usd = j.facts?.['us-gaap']?.[tag]?.units?.USD;
          if (!Array.isArray(usd)) continue;
          const rows = usd.filter((e) => e.start && e.end && e.form === '10-K'
            && Date.parse(e.end) - Date.parse(e.start) > 300 * DAY && Date.parse(e.end) - Date.parse(e.start) < 400 * DAY);
          if (!rows.length) continue;
          rows.sort((x, y) => x.end.localeCompare(y.end));
          const v = { val: rows[rows.length - 1].val, year: Number(rows[rows.length - 1].end.slice(0, 4)) };
          if (!target || Math.abs(v.val - target) / target <= 0.25) { chosen = { ...v, tag }; break; }
        }
      }
    } catch { /* keep the field empty rather than guess */ }
  }

  const was = c.revenue;
  if (chosen) {
    c.revenue = chosen.val;
    c.fyRevenue = chosen.year;
    c.revenueTag = chosen.tag;
    console.log(`  ${c.ticker}: ${(was / 1e9).toFixed(2)}B → ${(chosen.val / 1e9).toFixed(2)}B (${chosen.tag})`);
  } else {
    c.revenue = null;
    c.fyRevenue = null;
    console.log(`  ${c.ticker}: ${(was / 1e9).toFixed(2)}B → cleared (no total-revenue tag found)`);
  }
}

if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
