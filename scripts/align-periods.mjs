// Align the balance sheet to the fiscal date of the income statement.
//
// The frames pass gives an instant for a calendar period, and the earnings pass gives a fiscal year.
// For a company whose fiscal year does not line up with the calendar — or whose 10-K is a year ahead of
// its earnings tag — the two end up from different years. That is how Fortive showed 2025 assets beside
// 2024 earnings, and why the second source disagreed by 31%.
//
// This pass reads the company's own XBRL instants and picks the one dated at `netIncomeEnd`, so assets
// and equity belong to the same year as the profit.
//
//   node scripts/align-periods.mjs
//   node scripts/align-periods.mjs --dry

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
let last = 0;

const latestInstant = (doc) => {
  const usd = Array.isArray(doc?.units?.USD) ? doc.units.USD : [];
  return usd.filter((e) => !e.start && e.end).map((e) => e.end).sort().at(-1) || null;
};
const latestFacts = (doc) => {
  const g = doc?.facts?.['us-gaap'] || {};
  let end = null;
  for (const body of Object.values(g)) {
    for (const e of body?.units?.USD || []) {
      if (!e.start && e.end && (!end || e.end > end)) end = e.end;
    }
  }
  return end;
};
async function concept(cik, tag, minEnd = null) {
  const file = join(CACHE, `${cik}_${tag}.json`);
  if (existsSync(file)) {
    try {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      if (!minEnd || (latestInstant(hit) || '') >= minEnd) return hit;
    } catch { /* refetch */ }
  }
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 240 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`, {
        headers: { 'User-Agent': UA },
      });
      if (res.status === 404) return null;
      if (res.status === 429) { last = Date.now() + 4000; await sleep(4000 * (i + 1)); continue; }
      if (!res.ok) { await sleep(1500 * (i + 1)); continue; }
      const doc = await res.json();
      writeFileSync(file, JSON.stringify(doc));
      return doc;
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

const DAY = 86400000;

// The instant reported at (or nearest to) a target date, from 10-K and 10-Q facts alike.
function at(doc, target) {
  const usd = Array.isArray(doc?.units?.USD) ? doc.units.USD : [];
  // The same date can appear several times: a shell-period 10-Q with assets of 0, a restated 10-Q, and
  // the 10-K. Zero is never a balance sheet, and the annual filing is the authoritative one.
  const rows = usd.filter((e) => !e.start && e.end && Number(e.val) !== 0);
  if (!rows.length) return null;
  let best = null;
  for (const e of rows) {
    const d = Math.abs(Date.parse(e.end) - target) / DAY;
    if (d > 20) continue;
    const score = d * 10 + (e.form === '10-K' ? 0 : 5) - (Date.parse(e.filed || 0) / 1e13);
    if (!best || score < best.score) best = { val: e.val, end: e.end, score };
  }
  return best;
}

// Some CIKs return a valid companyconcept document with an empty USD object. For those, read the
// company's full index once instead of giving up on the balance sheet.
const FACTS = join(ROOT, 'data', 'cache', 'facts');
mkdirSync(FACTS, { recursive: true });
// Cache only the concepts we read: a full filing index is 10–20 MB, and 500 of them is over a gigabyte.
const SLIM = new Set(['Assets', 'AssetsCurrent', 'LiabilitiesCurrent', 'StockholdersEquity',
  'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'CommonStockholdersEquity',
  'MinorityInterest', 'NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic',
  'NetIncomeLossAttributableToParent', 'DepreciationDepletionAndAmortization',
  'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization', 'OperatingIncomeLoss',
  'CashAndCashEquivalentsAtCarryingValue', 'LongTermDebtNoncurrent', 'LongTermDebt',
  'Revenues', 'RevenuesNetOfInterestExpense', 'RevenueFromContractWithCustomerIncludingAssessedTax',
  'RevenueFromContractWithCustomerExcludingAssessedTax', 'RegulatedAndUnregulatedOperatingRevenue', 'OperatingRevenues',
]);
const slimFacts = (j) => {
  const g = j?.facts?.['us-gaap'] || {};
  const out = {};
  for (const [k, v] of Object.entries(g)) {
    if (SLIM.has(k) && Array.isArray(v?.units?.USD)) out[k] = { units: { USD: v.units.USD } };
  }
  return { facts: { 'us-gaap': out } };
};

async function factsDoc(cik, minEnd = null) {
  const file = join(FACTS, `${cik}.json`);
  if (existsSync(file)) {
    try {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      if (!minEnd || (latestFacts(hit) || '') >= minEnd) return hit;
    } catch { /* refetch */ }
  }
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) return null;
    const j = await res.json();
    writeFileSync(file, JSON.stringify(slimFacts(j)));
    return j;
  } catch { return null; }
}
const atFacts = (facts, tag, target) => at({ units: { USD: facts?.facts?.['us-gaap']?.[tag]?.units?.USD } }, target);

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const todo = data.companies.filter((c) => c.cik && c.netIncomeEnd && !c.noFilings
  && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())));
console.log(`${todo.length} companies with a fiscal date`);

let aligned = 0;
let changed = 0;
let done = 0;
const queue = todo.slice();

async function worker() {
  while (queue.length) {
    const c = queue.shift();
    // Align to the newest filing, not the last annual report: a 10-Q carries a newer balance-sheet
    // instant, and the old target left assets/equity a quarter or more behind (Starbucks, Ford).
    const target = Date.parse(c.lastFiling?.period || c.netIncomeEnd);
    if (!Number.isFinite(target)) { done++; continue; }
    const targetEnd = new Date(target).toISOString().slice(0, 10);
    let a = at(await concept(c.cik, 'Assets', targetEnd), target);
    let e = at(await concept(c.cik, 'StockholdersEquity', targetEnd), target);
    if (!a || !e) {
      const facts = await factsDoc(c.cik, targetEnd);
      a = a || atFacts(facts, 'Assets', target);
      e = e || atFacts(facts, 'StockholdersEquity', target)
        || atFacts(facts, 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', target);
    }
    done++;
    if (done % 50 === 0) console.log(`  … ${done}`);
    if (!a && !e) continue;
    aligned++;
    if (a && (c.assets !== a.val || c.assetsEnd !== a.end)) {
      c.assets = a.val; c.assetsEnd = a.end; c.assetsTag = 'Assets'; changed++;
    }
    if (e) {
      // Some filers report the *total* equity under the parent tag at quarter-end. If the value equals
      // the including-NCI figure, subtract the minority interest so the denominator matches the cap.
      const incl = atFacts(await factsDoc(c.cik, targetEnd), 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', target);
      const mi = atFacts(await factsDoc(c.cik, targetEnd), 'MinorityInterest', target);
      let val = e.val;
      let tag = 'StockholdersEquity';
      if (incl && mi && Math.abs(val - incl.val) / Math.max(Math.abs(val), Math.abs(incl.val)) < 0.01) {
        val = val - mi.val;
        tag = 'StockholdersEquity less MinorityInterest';
      }
      if (c.equity !== val || c.equityEnd !== e.end) {
        c.equity = val; c.equityEnd = e.end; c.equityTag = tag; changed++;
      }
    }
  }
}
await Promise.all([worker(), worker()]);

console.log(`aligned ${aligned} companies · ${changed} values moved to the fiscal date`);
if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
