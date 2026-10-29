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
const CAPEX = [
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsToAcquireProductiveAssets',
  'PaymentsForCapitalImprovements',
  // Industry variants: pharma tags "other PP&E", E&Ps tag oil-and-gas property, REITs tag development.
  'PaymentsToAcquireOtherPropertyPlantAndEquipment',
  'PaymentsToAcquireOilAndGasPropertyAndEquipment',
  'PaymentsToAcquireOilAndGasProperty',
  'PaymentsToDevelopRealEstateAssets',
  'PaymentsToAcquireRealEstate',
  'PaymentsForConstructionInProcess',
  'PaymentsToAcquireMachineryAndEquipment',
];

const ALL_TAGS = [...OCF, ...CAPEX];
const factsDone = new Set();
async function factsFallback(cik) {
  if (factsDone.has(cik)) return;
  factsDone.add(cik);
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return;
    const j = await res.json();
    const g = j.facts?.['us-gaap'] || {};
    // Cache every cash-flow tag we might ask for, so the index is fetched once per company.
    for (const tag of ALL_TAGS) {
      const u = g[tag]?.units?.USD;
      if (Array.isArray(u) && u.length) writeFileSync(join(CACHE, `${cik}_${tag}.json`), JSON.stringify({ units: { USD: u } }));
    }
  } catch { /* leave uncached */ }
}

async function units(cik, tag) {
  const f = join(CACHE, `${cik}_${tag}.json`);
  if (existsSync(f)) {
    try { const j = JSON.parse(readFileSync(f, 'utf8')); const u = j?.units?.USD; if (Array.isArray(u) && u.length) return u; } catch { /* refetch */ }
  }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`, { headers: { 'User-Agent': UA } });
      if (res.status === 404) break;
      if (!res.ok) { await new Promise((r) => setTimeout(r, 1200 * (i + 1))); continue; }
      const j = await res.json();
      writeFileSync(f, JSON.stringify(j));
      const u = j?.units?.USD;
      if (Array.isArray(u) && u.length) return u;
      break;
    } catch { await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  // The per-concept endpoint is empty or missing for some CIKs; the index has the values.
  await factsFallback(cik);
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const u = j?.units?.USD;
    return Array.isArray(u) && u.length ? u : null;
  } catch { return null; }
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

// Cash flow is reported year-to-date, not quarterly: a 10-Q shows six or nine months, never three.
// TTM = last fiscal year + current YTD − the same YTD a year earlier.
function ttm(usd) {
  const rows = (Array.isArray(usd) ? usd : []).filter((e) => e.start && e.end);
  const annual = rows.filter((e) => dur(e) > 300 && dur(e) < 400).sort((a, b) => a.end.localeCompare(b.end));
  const fy = annual[annual.length - 1];
  if (!fy) return null;
  const ytd = rows.filter((e) => dur(e) >= 120 && dur(e) <= 330 && Date.parse(e.end) > Date.parse(fy.end))
    .sort((a, b) => a.end.localeCompare(b.end));
  const latest = ytd[ytd.length - 1];
  if (!latest) return { val: fy.val, asOf: fy.end };        // the fiscal year is the latest period
  const prior = rows.find((e) => Math.abs(dur(e) - dur(latest)) < 20
    && Math.abs(Date.parse(e.end) - (Date.parse(latest.end) - 365 * DAY)) < 30 * DAY);
  if (!prior) return null;
  return { val: fy.val + latest.val - prior.val, asOf: latest.end };
}
async function ttmOf(cik, tags) {
  for (const tag of tags) {
    const v = ttm(await units(cik, tag));
    if (v) return { ...v, tag };
  }
  return null;
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

  // Trailing twelve months, when four contiguous quarters exist.
  const ocfT = await ttmOf(c.cik, OCF);
  const capT = await ttmOf(c.cik, CAPEX);
  if (ocfT && capT) {
    c.operatingCashFlowTTM = ocfT.val;
    c.capexTTM = Math.abs(capT.val);
    c.fcfTTM = ocfT.val - Math.abs(capT.val);
    c.fcfTTMAsOf = ocfT.asOf;
  }
  built++;
}

console.log(`FCF built for ${built} · no operating cash flow ${noOcf} · no capex ${noCapex}`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
