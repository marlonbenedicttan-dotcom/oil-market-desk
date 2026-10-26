// Fill the fields the annual XBRL "frames" pass missed.
//
// Frames are a good bulk source but they only contain companies that filed a given tag for that exact
// period. Banks report revenue as "Revenues, Net of Interest Expense", utilities as "Regulated and
// Unregulated Operating Revenue", and some companies simply tag debt or equity differently. This pass
// asks the SEC for one concept at a time for one company at a time, so it can try the whole family of
// acceptable tags instead of only the two or three that fit a frame.
//
// Everything written here comes from an SEC filing. Nothing is estimated.
//
//   node scripts/fill-gaps.mjs --dry
//   node scripts/fill-gaps.mjs

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DRY = process.argv.includes('--dry');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '--limit=0').split('=')[1]) || Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 130 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.status === 404) return null;
      if (res.status === 403 || res.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) return null;
      return res.json();
    } catch { await sleep(700 * (i + 1)); }
  }
  return null;
}

const DAY = 86400000;
// Every concept response is cached on disk. SEC throttles hard, and a 30-minute pass that dies at
// 95% should not refetch the first 95% on the next run.
const CACHE = join(ROOT, 'data', 'cache', 'concepts');
mkdirSync(CACHE, { recursive: true });

async function concept(cik, tag) {
  const file = join(CACHE, `${cik}_${tag}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt cache: refetch */ }
  }
  const doc = await get(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`);
  // Never cache a failed fetch: a 403 or a timeout would otherwise look like "this tag does not exist"
  // forever, which is how Mastercard's net income became a 2013 number.
  if (doc) { try { writeFileSync(file, JSON.stringify(doc)); } catch { /* best-effort */ } }
  return doc;
}

// A flow value: a full-year duration reported in a 10-K. Latest year wins.
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

// An instant value (balance sheet): no start date, reported in a 10-K.
function instant(doc) {
  const usd = Array.isArray(doc?.units?.USD) ? doc.units.USD : [];
  const rows = usd.filter((e) => !e.start && e.end && e.form === '10-K');
  if (!rows.length) return null;
  rows.sort((a, b) => a.end.localeCompare(b.end));
  const x = rows[rows.length - 1];
  return { val: x.val, year: Number(x.end.slice(0, 4)) };
}

// Trailing twelve months: the last four distinct quarters.
function ttm(doc) {
  const usd = Array.isArray(doc?.units?.USD) ? doc.units.USD : [];
  const rows = usd.filter((e) => e.start && e.end
    && Date.parse(e.end) - Date.parse(e.start) > 70 * DAY
    && Date.parse(e.end) - Date.parse(e.start) < 110 * DAY);
  const byEnd = new Map();
  for (const e of rows) byEnd.set(e.end, e);        // later filing replaces an earlier restatement
  const ends = [...byEnd.keys()].sort();
  if (ends.length < 4) return null;
  return ends.slice(-4).reduce((a, k) => a + byEnd.get(k).val, 0);
}

async function firstOf(cik, tags, kind) {
  for (const tag of tags) {
    const doc = await concept(cik, tag);
    const v = doc ? kind(doc) : null;
    if (v != null) return typeof v === 'object' ? { ...v, tag } : { val: v, tag };
  }
  return null;
}

// Revenue has the widest spread of acceptable tags: an industrial, a bank, and a utility each report
// their top line under a different concept. Ordered from most to least specific.
const REVENUE_TAGS = [
  'RevenuesNetOfInterestExpense',                        // banks
  'RegulatedAndUnregulatedOperatingRevenue',             // utilities
  'OperatingRevenues',                                   // utilities
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'SalesRevenueNet',
  'RevenuesExcludingInterestAndDividends',
  'InterestIncomeExpenseNet',                            // bank fallback: net interest income
];
const EQUITY_TAGS = [
  'StockholdersEquity',
  'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  'CommonStockholdersEquity',
  'PartnersCapital',
];
const DEBT_TAGS = [
  'LongTermDebtNoncurrent',
  'LongTermDebt',
  'LongTermDebtAndCapitalLeaseObligations',
  'DebtLongtermAndShorttermCombinedAmount',
];
const CASH_TAGS = [
  'CashAndCashEquivalentsAtCarryingValue',
  'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
];
const DA_TAGS = [
  'DepreciationDepletionAndAmortization',
  'DepreciationAmortizationAndAccretionNet',
  'DepreciationAndAmortization',
  'DepreciationDepletionAndAmortizationExcludingAmortizationOfDeferredCharges',
];
const OPINC_TAGS = [
  'OperatingIncomeLoss',
  'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
];
const NETINC_TAGS = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'];

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const filled = {};
const note = (k, t) => { (filled[k] = filled[k] || []).push(t); };

let processed = 0;
for (const c of data.companies) {
  if (!c.cik) continue;
  if (processed >= LIMIT) break;
  const has = (k) => c[k] != null;
  const need = {
    revenue: !has('revenue'),
    equity: !has('equity'),
    debt: !has('debt'),
    cash: !has('cash'),
    da: !has('da'),
    netIncome: !has('netIncome'),
    netIncomeTTM: !has('netIncomeTTM'),
  };
  if (!Object.values(need).some(Boolean)) continue;
  processed++;
  if (processed % 25 === 0) console.log(`  … ${processed}`);

  if (need.revenue) {
    const r = await firstOf(c.cik, REVENUE_TAGS, annual);
    if (r) { c.revenue = r.val; c.fyRevenue = r.year; note('revenue', `${c.ticker} ${r.tag}`); }
  }
  if (need.netIncome) {
    const r = await firstOf(c.cik, NETINC_TAGS, annual);
    if (r) { c.netIncome = r.val; c.fyNetIncome = r.year; note('netIncome', `${c.ticker} ${r.tag}`); }
  }
  if (need.netIncomeTTM) {
    const r = await firstOf(c.cik, NETINC_TAGS, ttm);
    if (r) { c.netIncomeTTM = r.val; note('netIncomeTTM', `${c.ticker} ${r.tag}`); }
  }
  if (need.equity) {
    const r = await firstOf(c.cik, EQUITY_TAGS, instant);
    if (r) { c.equity = r.val; note('equity', `${c.ticker} ${r.tag}`); }
  }
  if (need.debt) {
    const r = await firstOf(c.cik, DEBT_TAGS, instant);
    if (r) { c.debt = r.val; note('debt', `${c.ticker} ${r.tag}`); }
  }
  if (need.cash) {
    const r = await firstOf(c.cik, CASH_TAGS, instant);
    if (r) { c.cash = r.val; note('cash', `${c.ticker} ${r.tag}`); }
  }
  if (need.da) {
    const r = await firstOf(c.cik, DA_TAGS, annual);
    if (r) { c.da = r.val; note('da', `${c.ticker} ${r.tag}`); }
  }
  // Operating income is only stored on the series, so rebuild the latest year from the filing too.
  if (!c.opInc) {
    const r = await firstOf(c.cik, OPINC_TAGS, annual);
    if (r) { c.opInc = r.val; note('opInc', `${c.ticker} ${r.tag}`); }
  }
}

console.log('filled:');
for (const [k, v] of Object.entries(filled)) console.log(`  ${k.padEnd(13)} ${v.length}`);
console.log('sample:', Object.values(filled).flat().slice(0, 8).join(' · '));

if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
