// Detect amended filings and record what changed.
//
// A 10-K/A can restate prior-year revenue or equity. Most data feeds silently overwrite the old number;
// this keeps both, dates the change, and links the amendment. The stored figure becomes the amended one
// (that is the correct number), and the previous value is preserved in `restatement.changes`.
//
//   node scripts/detect-restatements.mjs
//   node scripts/detect-restatements.mjs --only=TSLA,CVX

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const FACTS = join(ROOT, 'data', 'cache', 'facts');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(FACTS, { recursive: true });

const FLOW = {
  revenue: ['Revenues', 'RevenuesNetOfInterestExpense', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RegulatedAndUnregulatedOperatingRevenue', 'OperatingRevenues'],
  netIncome: ['NetIncomeLossAvailableToCommonStockholdersBasic', 'NetIncomeLoss', 'ProfitLoss'],
};
const INSTANT = { assets: ['Assets'], equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] };

async function facts(cik) {
  const f = join(FACTS, `${cik}.json`);
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* refetch */ } }
  const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const j = await res.json();
  const slim = { facts: { 'us-gaap': {} } };
  for (const [k, v] of Object.entries(j.facts?.['us-gaap'] || {})) {
    if (Array.isArray(v?.units?.USD)) slim.facts['us-gaap'][k] = { units: { USD: v.units.USD } };
  }
  writeFileSync(f, JSON.stringify(slim));
  return slim;
}

// The amended figure is the one filed last for a given period.
function at(usd, target, kind) {
  const rows = (Array.isArray(usd) ? usd : []).filter((e) => e.end && (kind === 'instant' ? !e.start : e.start)
    && (kind === 'instant' || ((dur(e) > 300 && dur(e) < 400) || (dur(e) > 75 && dur(e) < 105))));
  const near = rows.filter((e) => Math.abs(Date.parse(e.end) - target) <= 25 * DAY);
  if (!near.length) return null;
  near.sort((a, b) => (a.end === b.end ? String(a.filed).localeCompare(String(b.filed)) : a.end.localeCompare(b.end)));
  return near[near.length - 1];
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik && c.netIncomeEnd && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())));
console.log(`${todo.length} companies`);

let checked = 0;
let restated = 0;
for (const c of todo) {
  let subs = null;
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
    if (res.ok) subs = await res.json();
  } catch { /* skip */ }
  await sleep(120);
  if (!subs) continue;
  const r = subs.filings?.recent;
  const ams = [];
  for (let k = 0; k < (r.form || []).length; k++) {
    if (!/^10-[KQ]\/A$/.test(r.form[k])) continue;
    ams.push({ form: r.form[k], filed: r.filingDate[k], period: r.reportDate?.[k] || null, accn: r.accessionNumber[k], doc: r.primaryDocument[k] });
  }
  if (!ams.length) continue;
  checked++;

  const target = Date.parse(c.netIncomeEnd);
  const relevant = ams.filter((a) => a.period && Math.abs(Date.parse(a.period) - target) <= 120 * DAY)
    .sort((a, b) => a.filed.localeCompare(b.filed)).pop();
  if (!relevant) continue;

  const j = await facts(c.cik);
  if (!j) continue;
  const g = j.facts?.['us-gaap'] || {};
  const found = {};
  for (const [field, tags] of Object.entries(FLOW)) {
    let best = null;
    for (const tag of tags) {
      const v = at(g[tag]?.units?.USD, target, 'flow');
      if (v && (!best || v.end > best.end)) best = v;
    }
    if (best) found[field] = best.val;
  }
  for (const [field, tags] of Object.entries(INSTANT)) {
    let best = null;
    for (const tag of tags) {
      const v = at(g[tag]?.units?.USD, target, 'instant');
      if (v && (!best || v.end > best.end)) best = v;
    }
    if (best) found[field] = best.val;
  }

  const changes = {};
  for (const f of ['revenue', 'netIncome', 'assets', 'equity']) {
    if (found[f] == null || c[f] == null) continue;
    const diff = Math.abs(found[f] - c[f]) / Math.max(Math.abs(found[f]), Math.abs(c[f]));
    if (diff > 0.005) changes[f] = { was: c[f], now: found[f] };
  }

  if (Object.keys(changes).length) {
    const accn = String(relevant.accn).replace(/-/g, '');
    c.restatement = {
      period: c.netIncomeEnd,
      form: relevant.form,
      filed: relevant.filed,
      accn: relevant.accn,
      url: relevant.doc ? `https://www.sec.gov/Archives/edgar/data/${c.cik}/${accn}/${relevant.doc}` : null,
      changes,
    };
    for (const [f, v] of Object.entries(changes)) c[f] = v.now;
    c.lastFiling = { form: relevant.form, filed: relevant.filed, period: relevant.period, accn: relevant.accn, url: c.restatement.url };
    restated++;
    console.log(`  ${c.ticker}: ${relevant.form} ${relevant.filed} changed ${Object.keys(changes).join(', ')}`);
  }
}

console.log(`\n${checked} companies with amendments · ${restated} restatements recorded`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
