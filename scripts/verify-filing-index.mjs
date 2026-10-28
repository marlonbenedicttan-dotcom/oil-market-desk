// Verify the companies the second source does not cover, against their own filing index.
//
// Nasdaq publishes no financial tables for a handful of names (a 2026 spin-off, a foreign private
// issuer, a second share class) and is a year behind on two others. That leaves them "unchecked" — not
// wrong, just unconfirmed.
//
// This re-derives the four headline figures from the company's XBRL index at the same fiscal date and
// compares them with what we stored. Two independent extraction paths agreeing is weaker than two
// publishers agreeing, and the record says so: `method: 'filing-index'`.
//
//   node scripts/verify-filing-index.mjs

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const FACTS = join(ROOT, 'data', 'cache', 'facts');
mkdirSync(FACTS, { recursive: true });
const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAGS = {
  revenue: ['Revenues', 'RevenuesNetOfInterestExpense', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RegulatedAndUnregulatedOperatingRevenue', 'OperatingRevenues'],
  netIncome: ['NetIncomeLossAvailableToCommonStockholdersBasic', 'NetIncomeLoss', 'ProfitLoss'],
};
const INSTANT = {
  assets: ['Assets'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
};

async function facts(cik) {
  const f = join(FACTS, `${cik}.json`);
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* refetch */ } }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
      if (!res.ok) { await sleep(1500 * (i + 1)); continue; }
      const j = await res.json();
      const slim = { facts: { 'us-gaap': {} } };
      for (const [k, v] of Object.entries(j.facts?.['us-gaap'] || {})) {
        if (Array.isArray(v?.units?.USD)) slim.facts['us-gaap'][k] = { units: { USD: v.units.USD } };
      }
      writeFileSync(f, JSON.stringify(slim));
      return slim;
    } catch { await sleep(900 * (i + 1)); }
  }
  return null;
}

const at = (usd, target, kind) => {
  const rows = (usd || []).filter((e) => e.end && (kind === 'instant' ? !e.start : e.start)
    && (kind === 'instant' || ((dur(e) > 300 && dur(e) < 400) || (dur(e) > 75 && dur(e) < 105))));
  let best = null;
  for (const e of rows) {
    const d = Math.abs(Date.parse(e.end) - target) / DAY;
    if (d > 25) continue;
    if (!best || d < best.d) best = { val: e.val, end: e.end, d };
  }
  return best;
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => (c.verification?.status === 'unchecked') && c.cik && c.netIncomeEnd);
console.log(`${todo.length} unchecked companies with a fiscal date`);

let verified = 0;
for (const c of todo) {
  const j = await facts(c.cik);
  if (!j) { console.log(`  ${c.ticker}: no index`); continue; }
  const g = j.facts?.['us-gaap'] || {};
  const target = Date.parse(c.netIncomeEnd);
  const found = {};
  for (const [field, tags] of Object.entries(TAGS)) {
    let best = null;
    for (const tag of tags) {
      const v = at(g[tag]?.units?.USD, target, 'flow');
      if (v && (!best || v.d < best.d)) best = v;
    }
    if (best) found[field] = best.val;
  }
  for (const [field, tags] of Object.entries(INSTANT)) {
    let best = null;
    for (const tag of tags) {
      const v = at(g[tag]?.units?.USD, target, 'instant');
      if (v && (!best || v.d < best.d)) best = v;
    }
    if (best) found[field] = best.val;
  }

  const fields = ['revenue', 'netIncome', 'assets', 'equity'].filter((f) => found[f] != null && c[f] != null);
  if (!fields.length) { console.log(`  ${c.ticker}: no comparable field`); continue; }
  const diffs = fields.map((f) => Math.abs(found[f] - c[f]) / Math.max(Math.abs(found[f]), Math.abs(c[f])));
  const worst = Math.max(...diffs);
  if (worst <= 0.01) {
    c.verification = { status: 'verified', method: 'filing-index', checked: fields.length, fields: {} };
    verified++;
    console.log(`  ${c.ticker}: verified against the filing index (${fields.length} fields)`);
  } else {
    const bad = fields.filter((f, i) => diffs[i] > 0.01).map((f) => `${f} ${(c[f] / 1e9).toFixed(2)} vs ${(found[f] / 1e9).toFixed(2)}B`);
    console.log(`  ${c.ticker}: MISMATCH ${bad.join(' · ')}`);
  }
  await sleep(200);
}

console.log(`\n${verified} verified against the filing index`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
