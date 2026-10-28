// Free cash flow: what the business actually generated, not what it reported as earnings.
//
// FCF = operating cash flow − capital expenditure, both taken from the same fiscal year as the income
// statement. Earnings can be flattered by accruals; cash cannot. This is the metric that makes an
// earnings figure checkable.
//
//   node scripts/build-cashflow.mjs
//   node scripts/build-cashflow.mjs --only=AAPL,MSFT

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CACHE = join(ROOT, 'data', 'cache', 'concepts');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
mkdirSync(CACHE, { recursive: true });

const OCF = ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'];
const CAPEX = ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements'];

async function units(cik, tag) {
  const f = join(CACHE, `${cik}_${tag}.json`);
  if (existsSync(f)) {
    try { const j = JSON.parse(readFileSync(f, 'utf8')); const u = j?.units?.USD; if (Array.isArray(u) && u.length) return u; } catch { /* refetch */ }
  }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (!res.ok) { await new Promise((r) => setTimeout(r, 1200 * (i + 1))); continue; }
      const j = await res.json();
      writeFileSync(f, JSON.stringify(j));
      const u = j?.units?.USD;
      return Array.isArray(u) ? u : null;
    } catch { await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  return null;
}

// The annual value for the fiscal year of the income statement, else the latest annual one.
function annual(usd, year) {
  const rows = (Array.isArray(usd) ? usd : []).filter((e) => e.start && e.end && dur(e) > 300 && dur(e) < 400);
  if (!rows.length) return null;
  rows.sort((a, b) => (a.end === b.end ? String(a.filed).localeCompare(String(b.filed)) : a.end.localeCompare(b.end)));
  const hit = year ? [...rows].reverse().find((e) => Number(e.end.slice(0, 4)) === year) : null;
  const x = hit || rows[rows.length - 1];
  return { val: x.val, end: x.end };
}

async function firstOf(cik, tags, year) {
  for (const tag of tags) {
    const v = annual(await units(cik, tag), year);
    if (v) return { ...v, tag };
  }
  return null;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik && !c.noFilings && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())));
console.log(`${todo.length} companies`);

let built = 0;
let noOcf = 0;
let noCapex = 0;
for (const c of todo) {
  const year = c.netIncomeEnd ? Number(String(c.netIncomeEnd).slice(0, 4)) : null;
  const ocf = await firstOf(c.cik, OCF, year);
  if (!ocf) { c.fcf = null; c.operatingCashFlow = null; c.capex = null; noOcf++; continue; }
  // Free cash flow is not a bank metric: operating cash flow moves with loans and deposits, not with
  // the business. Record the cash flow, mark FCF n/a — the same rule as EV/EBITDA.
  if (c.sector === 'Financials') {
    c.operatingCashFlow = ocf.val;
    c.capex = null;
    c.fcf = null;
    c.fcfNA = true;
    noCapex++;
    continue;
  }
  let capex = await firstOf(c.cik, CAPEX, year);
  if (!capex) {
    // A bank's operating cash flow is dominated by loan and deposit movements, so "free cash flow" is
    // not a meaningful number for it (JPM: -$148B). Mark it n/a rather than publish a false signal.
    if (c.sector === 'Financials') {
      c.operatingCashFlow = ocf.val;
      c.capex = null;
      c.fcf = null;
      c.fcfNA = true;
      noCapex++;
      continue;
    }
    {
      noCapex++;
      c.operatingCashFlow = ocf.val;
      c.fcf = null;
      c.fcfEnd = ocf.end;
      continue;
    }
  }
  c.operatingCashFlow = ocf.val;
  c.capex = Math.abs(capex.val);
  c.capexOmitted = capex.tag === 'none (financial)';
  c.fcf = ocf.val - Math.abs(capex.val);
  c.fcfEnd = ocf.end;
  c.fcfTag = ocf.tag;
  c.capexTag = capex.tag;
  built++;
}

console.log(`FCF built for ${built} · no operating cash flow ${noOcf} · no capex ${noCapex}`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
