// Resolve the annual fundamentals from the full XBRL index — the same approach that fixed the quarters.
//
// The old annual pass asked for a fixed tag per concept, so operating income was present for 72% of
// companies and EBITDA for 69%. This reads the broad facts already cached for every company and resolves
// each fiscal year by priority tag, then by derivation:
//
//   operating income = revenue − costsAndExpenses      when OperatingIncomeLoss is not tagged
//   EBITDA           = operating income + D&A
//   EPS              = net income ÷ shares             when the per-share tag is absent
//
// It rebuilds the five-year series the CAGR and the financials table are computed from.
//
//   node scripts/resolve-fundamentals.mjs
//   node scripts/resolve-fundamentals.mjs --only=AAPL,JPM
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CACHE = join(ROOT, 'data', 'cache', 'facts-broad');
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;

const DAY = 86400000;
const dur = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;

// Fiscal-year rows: 340–380 days, latest filing wins per end date.
function annualMap(facts, tags) {
  const out = new Map();
  tags.forEach((tag, rank) => {
    const rows = facts[tag];
    if (!rows) return;
    for (const [start, end, val, form, filed] of rows) {
      const d = dur(start, end);
      if (d < 340 || d > 380) continue;
      if (!/^10-K/.test(form)) continue;
      const cur = out.get(end);
      if (!cur || rank < cur.rank || (rank === cur.rank && String(filed) > String(cur.filed))) {
        out.set(end, { val, tag, rank, filed });
      }
    }
  });
  return out;
}

const REV = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense',
  'SalesRevenueNet', 'SalesRevenueGoodsNet', 'RegulatedAndUnregulatedOperatingRevenue', 'OperatingRevenues'];
const OPI = ['OperatingIncomeLoss'];
const COSTS = ['CostsAndExpenses', 'CostOfRevenue', 'CostOfGoodsAndServicesSold'];
const DA = ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet',
  'DepreciationAndAmortization', 'Depreciation', 'DepreciationAmortizationAndAccretionNet'];
const NI = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'];
const GROSS = ['GrossProfit'];
const OPEX = ['OperatingExpenses', 'OperatingCostsAndExpenses'];
const TAX = ['IncomeTaxExpenseBenefit'];
const INTEREST = ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt', 'InterestIncomeExpenseNet'];
const PRETAX = ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'];
const ASSETS = ['Assets'];
const EQUITY = ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'CommonStockholdersEquity'];

function instantMap(facts, tags) {
  const out = new Map();
  tags.forEach((tag, rank) => {
    for (const [start, end, val, form, filed] of facts[tag] || []) {
      if (start !== end) continue;                       // instants only
      const cur = out.get(end);
      if (!cur || rank < cur.rank) out.set(end, { val, tag, rank });
    }
  });
  return out;
}

// The broad cache keeps USD units only, so balance-sheet instants arrive as 1-day rows; if the cache has
// no instants, fall back to the last row at or before each year end.
function instantAt(map, end) {
  let best = null;
  for (const [d, v] of map) if (d <= end && (!best || d > best.d)) best = { d, ...v };
  return best;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik && !c.noFilings && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())));
console.log(`${todo.length} companies`);

let resolved = 0, noFacts = 0, opFilled = 0, ebitdaFilled = 0, epsFilled = 0;
for (const c of todo) {
  const f = join(CACHE, `${c.cik}.json`);
  if (!existsSync(f)) { noFacts++; continue; }
  let facts;
  try { facts = JSON.parse(readFileSync(f, 'utf8')); } catch { noFacts++; continue; }

  const rev = annualMap(facts, REV);
  const opi = annualMap(facts, OPI);
  const costs = annualMap(facts, COSTS);
  const da = annualMap(facts, DA);
  const ni = annualMap(facts, NI);
  const gross = annualMap(facts, GROSS);
  const opex = annualMap(facts, OPEX);
  const tax = annualMap(facts, TAX);
  const interest = annualMap(facts, INTEREST);
  const pretax = annualMap(facts, PRETAX);
  const assets = instantMap(facts, ASSETS);
  const equity = instantMap(facts, EQUITY);

  const ends = [...new Set([...rev.keys(), ...ni.keys(), ...opi.keys()])].sort().slice(-5);
  if (!ends.length) { noFacts++; continue; }

  const old = new Map((c.series || []).map((s) => [String(s.fy), s]));
  const series = ends.map((end) => {
    const fy = Number(end.slice(0, 4));
    const r = rev.get(end), o = opi.get(end), n = ni.get(end), k = costs.get(end), d = da.get(end);
    let opInc = o ? o.val : null;
    let opBasis = o ? 'filed' : null;
    // Fallback chain for filers that never tag an operating line: revenue − costs, then gross profit −
    // operating expenses, then net income + tax + interest.
    if (opInc == null && r && k && Math.abs(r.val - k.val) < Math.abs(r.val) * 3) { opInc = r.val - k.val; opBasis = 'derived'; }
    if (opInc == null && gross.get(end) && opex.get(end)) {
      const cand = gross.get(end).val - opex.get(end).val;
      if (Math.abs(cand) < Math.abs(gross.get(end).val) * 3) { opInc = cand; opBasis = 'derived'; }
    }
    // Pretax income + interest is operating income for a filer that reports no operating line at all.
    if (opInc == null && pretax.get(end)) {
      const cand = pretax.get(end).val + (interest.get(end)?.val || 0);
      if (Math.abs(cand) < Math.abs(pretax.get(end).val) * 6) { opInc = cand; opBasis = 'derived'; }
    }
    if (opInc == null && n) {
      const cand = n.val + (tax.get(end)?.val || 0) + (interest.get(end)?.val || 0);
      if (Math.abs(cand) < Math.abs(n.val) * 6) { opInc = cand; opBasis = 'derived'; }
    }
    const ebitda = opInc != null && d ? opInc + d.val : null;
    const prev = old.get(String(fy)) || {};
    const shares = c.shares || null;
    let eps = prev.eps ?? null;
    if (eps == null && n && shares > 0) eps = +(n.val / shares).toFixed(2);
    return {
      fy,
      revenue: r ? r.val : (prev.revenue ?? null),
      gross: gross.get(end)?.val ?? prev.gross ?? null,
      opInc: opInc ?? prev.opInc ?? null,
      opBasis: opBasis || (prev.opInc != null ? 'filed' : null),
      da: d ? d.val : (prev.da ?? null),
      ebitda: ebitda ?? prev.ebitda ?? null,
      netIncome: n ? n.val : (prev.netIncome ?? null),
      assets: instantAt(assets, end)?.val ?? prev.assets ?? null,
      equity: instantAt(equity, end)?.val ?? prev.equity ?? null,
      eps,
    };
  });
  series.sort((a, b) => a.fy - b.fy);
  c.series = series;

  // Fill the scalars the ratios read, without overwriting a figure that is already there.
  const last = series[series.length - 1];
  if (c.revenue == null && last.revenue != null) c.revenue = last.revenue;
  if (c.netIncome == null && last.netIncome != null) c.netIncome = last.netIncome;
  if (c.assets == null && last.assets != null) c.assets = last.assets;
  if (c.equity == null && last.equity != null) c.equity = last.equity;
  if (c.opInc == null && last.opInc != null) { c.opInc = last.opInc; c.opIncBasis = last.opBasis; opFilled++; }
  if (c.da == null && last.da != null) c.da = last.da;
  if (c.ebitda == null && last.ebitda != null) { c.ebitda = last.ebitda; ebitdaFilled++; }
  if (c.eps == null && last.eps != null) { c.eps = last.eps; epsFilled++; }

  resolved++;
  if (resolved % 100 === 0) console.log(`  ${resolved}/${todo.length} · opInc +${opFilled} · EBITDA +${ebitdaFilled} · EPS +${epsFilled}`);
}

console.log(`series rebuilt for ${resolved} companies · ${noFacts} without facts`);
console.log(`filled from derivation: operating income ${opFilled}, EBITDA ${ebitdaFilled}, EPS ${epsFilled}`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
