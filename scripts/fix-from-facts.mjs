// Repair a named list of companies from their full XBRL index.
//
// The bulk path (frames) is fast but keyed to calendar periods; the per-concept path is precise but
// chatty. This is the third path for the exception queue: one request per company, every field, and
// only values that are newer than what we already hold.
//
//   node scripts/fix-from-facts.mjs GRMN PANW MU
//   node scripts/fix-from-facts.mjs --from-recon        # every materially divergent company

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const RECON = join(ROOT, 'data', 'reconciliation.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FLOW = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense', 'OperatingRevenues'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  da: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization'],
};
const INSTANT = {
  assets: ['Assets'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'CommonStockholdersEquity'],
  currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  debt: ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
};

const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;

function annual(usd) {
  const rows = usd.filter((e) => e.start && e.end && e.form === '10-K' && dur(e) > 300 && dur(e) < 400);
  if (!rows.length) return null;
  rows.sort((a, b) => a.end.localeCompare(b.end));
  const x = rows[rows.length - 1];
  return { val: x.val, end: x.end };
}
function instant(usd) {
  const rows = usd.filter((e) => !e.start && e.end && e.form === '10-K');
  if (!rows.length) return null;
  rows.sort((a, b) => a.end.localeCompare(b.end));
  const x = rows[rows.length - 1];
  return { val: x.val, end: x.end };
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const byTicker = Object.fromEntries(data.companies.filter((c) => c.ticker).map((c) => [c.ticker, c]));

let targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (process.argv.includes('--from-recon')) {
  const recon = JSON.parse(readFileSync(RECON, 'utf8'));
  targets = recon.companies.filter((r) => r.status === 'diverge' && byTicker[r.ticker]).map((r) => r.ticker);
}
console.log(`${targets.length} companies: ${targets.join(' ')}`);

for (const t of targets) {
  const c = byTicker[t];
  if (!c) continue;
  let facts = null;
  for (let i = 0; i < 3 && !facts; i++) {
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(c.cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
      if (res.ok) facts = await res.json();
      else if (res.status === 429) await sleep(8000 * (i + 1));
      else await sleep(1500 * (i + 1));
    } catch { await sleep(1500 * (i + 1)); }
  }
  if (!facts) { console.log(`  ${t}: no facts`); continue; }

  const g = facts.facts?.['us-gaap'] || {};
  const changes = [];

  for (const [field, tags] of Object.entries({ ...FLOW, ...INSTANT })) {
    const picker = FLOW[field] ? annual : instant;
    // A bank's top line is "revenues net of interest expense"; plain "Revenues" there is a component
    // (Interactive Brokers: $2.4B against a $6.2B top line).
    const order = field === 'revenue' && c.sector === 'Financials'
      ? ['RevenuesNetOfInterestExpense', 'Revenues', 'InterestIncomeExpenseNet', ...tags]
      : tags;
    let best = null;
    for (const tag of order) {
      const usd = g[tag]?.units?.USD;
      if (!Array.isArray(usd)) continue;
      const v = picker(usd);
      if (!v) continue;
      // Revenue must at least cover net income; a smaller figure is a component of it.
      if (field === 'revenue' && c.netIncome > 0 && v.val < c.netIncome * 0.9) continue;
      if (!best || v.end > best.end) best = { ...v, tag };
    }
    if (!best) continue;
    const endKey = field + 'End';
    if (c[endKey] && best.end < c[endKey]) continue;
    if (c.assets && field === 'equity' && (best.val > c.assets * 1.02 || best.val < -c.assets)) continue;
    if (c[field] !== best.val) changes.push(`${field} ${((c[field] || 0) / 1e9).toFixed(1)}→${(best.val / 1e9).toFixed(1)}B`);
    c[field] = best.val;
    c[endKey] = best.end;
    c[field + 'Tag'] = best.tag;
    if (field === 'netIncome') { c.fyNetIncome = Number(best.end.slice(0, 4)); c.netIncomeEnd = best.end; }
  }
  console.log(`  ${t}: ${changes.length ? changes.join(' · ') : 'no change'}`);
  await sleep(600);
}

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log('written');
