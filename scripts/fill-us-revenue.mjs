// Fill the annual revenue line for companies whose top line is not tagged under a generic concept.
//
// The frames API only sees `Revenues`/`RevenueFromContract…`; a bank reports net interest income plus
// non-interest income, a REIT reports lease income, and a homebuilder often uses a building-specific
// tag. `resolve-quarters` already reads the full companyfacts document (data/cache/facts-broad), so
// this pass uses the same source for the annual scalar instead of leaving a visible 0 or a blank.
//
//   node scripts/fill-us-revenue.mjs
//   node scripts/fill-us-revenue.mjs --dry

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CACHE = join(ROOT, 'data', 'cache', 'facts-broad');
const DRY = process.argv.includes('--dry');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DAY = 86400000;

const REV = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense',
  'SalesRevenueNet', 'SalesRevenueGoodsNet', 'RegulatedAndUnregulatedOperatingRevenue', 'OperatingRevenues',
  'HomebuildingRevenue', 'RealEstateRevenueNet', 'OperatingLeaseLeaseIncome'];
const NI = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'];

function annual(facts, tags, positive = true) {
  for (const tag of tags) {
    const rows = (facts[tag] || []).filter(([s, e, v, f]) => {
      if (v == null || !s || !e) return false;
      if (positive && !(v > 0)) return false;   // a 0 "Revenues" line is not the top line
      const d = (Date.parse(e) - Date.parse(s)) / DAY;
      return d >= 340 && d <= 380 && /^10-K/.test(f || '');
    });
    if (rows.length) { rows.sort((a, b) => a[1].localeCompare(b[1])); const x = rows.at(-1); return { end: x[1], val: x[2], tag }; }
  }
  return null;
}

// A bank's top line: net interest income + non-interest income, else gross interest − interest expense
// + non-interest income. Same construction resolve-quarters uses for the quarterly column.
function bankRevenue(facts) {
  const nii = annual(facts, ['InterestIncomeExpenseNet', 'InterestIncomeExpenseNonoperatingNet', 'InterestIncomeExpenseAfterProvisionForLoanLoss']);
  const nonii = annual(facts, ['NoninterestIncome']);
  if (nii && nonii && nii.end === nonii.end) return { end: nii.end, val: nii.val + nonii.val, tag: 'net interest + noninterest income' };
  if (nii) return { ...nii, tag: 'net interest income' };
  const gross = annual(facts, ['InterestAndDividendIncomeOperating']);
  const exp = annual(facts, ['InterestExpense']);
  if (gross && exp && gross.end === exp.end) {
    const non = nonii && nonii.end === gross.end ? nonii.val : 0;
    return { end: gross.end, val: gross.val - exp.val + non, tag: 'interest income − interest expense + noninterest income' };
  }
  return null;
}

async function broadFacts(cik) {
  mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, `${cik}.json`);
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* refetch */ } }
  const since = new Date(Date.now() - 6 * 365 * DAY).toISOString().slice(0, 10);
  const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, {
    headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const out = {};
  for (const [tag, v] of Object.entries(j.facts?.['us-gaap'] || {})) {
    const usd = v?.units?.USD;
    if (!Array.isArray(usd)) continue;
    const rows = [];
    for (const e of usd) {
      if (!e.start || !e.end || e.val == null || e.end < since) continue;
      const d = (Date.parse(e.end) - Date.parse(e.start)) / DAY;
      if (d < 60 || d > 400) continue;
      rows.push([e.start, e.end, e.val, e.form || '', e.filed || '']);
    }
    if (rows.length) out[tag] = rows;
  }
  writeFileSync(f, JSON.stringify(out));
  return out;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let filled = 0;
const missing = [];
for (const c of data.companies) {
  if (!c.cik || c.noFilings) continue;
  const needRev = c.revenue == null || c.revenue === 0;
  if (!needRev && (c.series || []).length) continue;
  const facts = await broadFacts(c.cik);
  if (!facts) { missing.push(c.ticker); continue; }
  if (needRev) {
    const rev = (c.sector === 'Financials' ? bankRevenue(facts) : null)
      || annual(facts, REV)
      || (c.sector === 'Financials' ? bankRevenue(facts) : null);
    if (!rev || !(rev.val > 0)) { missing.push(c.ticker); continue; }
    c.revenue = rev.val;
    c.fyRevenue = Number(rev.end.slice(0, 4));
    c.revenueSource = rev.tag;
    const s = (c.series || []).find((x) => x.fy === c.fyRevenue);
    if (s && (s.revenue == null || s.revenue === 0)) s.revenue = rev.val;
    if (c.netIncome == null) {
      const ni = annual(facts, NI, false);
      if (ni) { c.netIncome = ni.val; c.fyNetIncome = Number(ni.end.slice(0, 4)); }
    }
    filled++;
    if (filled % 25 === 0) console.log(`  ${filled} filled`);
  }
  // Keep a one-year record rather than an empty five-year table when only the latest annual line is
  // sourceable (Pinnacle's reorganisation left it with a new CIK and no cached annual series).
  if (!(c.series || []).length && c.revenue != null) {
    const fy = c.fyRevenue || (c.netIncomeEnd ? Number(c.netIncomeEnd.slice(0, 4)) : null);
    if (fy) c.series = [{ fy, revenue: c.revenue, netIncome: c.netIncome ?? null, assets: c.assets ?? null, equity: c.equity ?? null, eps: c.eps ?? null }];
  }
}

console.log(`annual revenue filled for ${filled} companies${missing.length ? ` · still missing ${missing.length}: ${missing.slice(0, 12).join(' ')}` : ''}`);
if (!DRY) { data.updated = new Date().toISOString(); writeFileSync(FILE + '.tmp', JSON.stringify(data)); renameSync(FILE + '.tmp', FILE); }
