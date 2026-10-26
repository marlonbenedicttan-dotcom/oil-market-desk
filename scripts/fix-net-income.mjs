// Repair the last few companies whose net-income tag stopped years ago.
//
// Six companies in the universe report their newest net income under a concept the three-tag pass
// does not know (Welltower's `NetIncomeLoss` ends in 2011; the number since then lives elsewhere).
// Rather than guess tag names, this reads the company's whole XBRL index once and picks the net-income
// concept with the most recent fiscal year, then rebuilds TTM from its quarters.
//
//   node scripts/fix-net-income.mjs --dry

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;

function fiscalYear(usd) {
  const rows = usd.filter((e) => e.start && e.end && e.form === '10-K' && dur(e) > 300 && dur(e) < 400);
  if (!rows.length) return null;
  rows.sort((a, b) => a.end.localeCompare(b.end));
  const x = rows[rows.length - 1];
  return { val: x.val, end: x.end, year: Number(x.end.slice(0, 4)) };
}

function trailing(usd, fy) {
  const rows = usd.filter((e) => e.start && e.end && dur(e) > 75 && dur(e) < 105);
  const byEnd = new Map();
  for (const e of rows) {
    const cur = byEnd.get(e.end);
    if (!cur || String(e.filed) > String(cur.filed)) byEnd.set(e.end, e);
  }
  const qs = [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
  if (!qs.length) return null;
  const latest = qs[qs.length - 1];
  const quarterFor = (target) => {
    const hit = qs.find((e) => Math.abs(Date.parse(e.end) - target) <= 20 * DAY);
    if (hit) return hit;
    if (!fy || Math.abs(Date.parse(fy.end) - target) > 20 * DAY) return null;
    const inside = qs.filter((e) => Date.parse(e.end) <= Date.parse(fy.end) + 5 * DAY
      && Date.parse(e.start) >= Date.parse(fy.end) - 370 * DAY);
    const three = inside.slice(-3);
    if (three.length !== 3) return null;
    return { end: fy.end, val: fy.val - three.reduce((a, e) => a + e.val, 0) };
  };
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const q = quarterFor(Date.parse(latest.end) - i * 91 * DAY);
    if (!q) return null;
    parts.push(q);
  }
  parts.reverse();
  const span = (Date.parse(parts[3].end) - Date.parse(parts[0].end)) / DAY;
  if (span < 250 || span > 300) return null;
  return { val: parts.reduce((a, e) => a + e.val, 0), asOf: parts[3].end };
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const targets = data.companies.filter((c) => c.cik && (
  c.netIncome == null
  || (c.fyNetIncome && c.fyNetIncome < 2024)
  || !['NetIncomeLoss', 'ProfitLoss'].includes(c.netIncomeTag || '')
));
console.log(`${targets.length} companies to repair`);

for (const c of targets) {
  let facts = null;
  for (let i = 0; i < 3 && !facts; i++) {
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(c.cik).padStart(10, '0')}.json`, {
        headers: { 'User-Agent': UA },
      });
      if (res.ok) facts = await res.json();
      else await sleep(1200 * (i + 1));
    } catch { await sleep(900 * (i + 1)); }
  }
  if (!facts) { console.log(`  ${c.ticker}: no facts`); continue; }

  // Preference order matters: when two concepts cover the same year, the plain bottom line wins over
  // a "continuing operations including NCI" variant, which is a different scope.
  const RANK = {
    NetIncomeLoss: 0,
    NetIncomeLossAvailableToCommonStockholdersBasic: 1,
    NetIncomeLossAttributableToParent: 2,
    ProfitLoss: 3,                       // includes NCI: last resort
    NetIncomeLossAvailableToCommonStockholdersDiluted: 4,
    IncomeLossFromContinuingOperations: 5,
    IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest: 6,
  };
  let best = null;
  for (const [tag, body] of Object.entries(facts.facts?.['us-gaap'] || {})) {
    // After-tax concepts only. "IncomeLossFromContinuingOperationsBeforeIncomeTaxes..." is pre-tax
    // income, and using it as net income overstates earnings by the whole tax charge.
    const ALLOWED = new Set([
      'NetIncomeLoss',
      'ProfitLoss',
      'NetIncomeLossAttributableToParent',
      'NetIncomeLossAvailableToCommonStockholdersBasic',
      'NetIncomeLossAvailableToCommonStockholdersDiluted',
      'IncomeLossFromContinuingOperations',
      'IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest',
    ]);
    if (!ALLOWED.has(tag)) continue;
    const usd = body.units?.USD;
    if (!Array.isArray(usd)) continue;
    const fy = fiscalYear(usd);
    if (!fy) continue;
    const rank = RANK[tag];
    if (!best || fy.end > best.fy.end || (fy.end === best.fy.end && rank < best.rank)) {
      best = { tag, fy, rank, ttm: trailing(usd, fy) };
    }
  }
  if (!best) { console.log(`  ${c.ticker}: no annual net income`); continue; }

  const was = c.netIncome == null ? 'none' : `${(c.netIncome / 1e9).toFixed(2)}B (${c.fyNetIncome})`;
  // A decade-old annual figure is not a current net income; better to show nothing than 2014.
  if (best.fy.year < 2024) {
    c.netIncome = null;
    c.fyNetIncome = null;
    c.netIncomeTag = null;
    c.netIncomeTTM = null;
    c.netIncomeTTMAsOf = null;
    console.log(`  ${c.ticker}: ${was} → cleared (newest annual is ${best.fy.year})`);
    continue;
  }
  c.netIncome = best.fy.val;
  c.fyNetIncome = best.fy.year;
  c.netIncomeEnd = best.fy.end;
  c.netIncomeTag = best.tag;
  if (best.ttm && Date.parse(best.ttm.asOf) > Date.parse(best.fy.end)) {
    c.netIncomeTTM = best.ttm.val;
    c.netIncomeTTMAsOf = best.ttm.asOf;
  } else {
    c.netIncomeTTM = null;
    c.netIncomeTTMAsOf = null;
  }
  console.log(`  ${c.ticker}: ${was} → ${(best.fy.val / 1e9).toFixed(2)}B (${best.fy.year}, ${best.tag})`);
  await sleep(200);
}

if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
