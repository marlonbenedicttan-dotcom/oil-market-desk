// Resolve eight complete quarters per company from the full XBRL index.
//
// The old pass asked for a fixed list of tags per concept. A company that tags the same thing differently
// got a null, so 59 companies had eight blank revenue columns and the margin column with them. This reads
// one `companyfacts` document per company, keeps every tag, and resolves each period by:
//
//   1. the highest-priority tag that has that exact quarter, then
//   2. a quarter differenced from year-to-date figures sharing the same start (Q2 = H1 − Q1), then
//   3. for operating income only, revenue − costsAndExpenses.
//
//   node scripts/resolve-quarters.mjs                 # every company, cache-first
//   node scripts/resolve-quarters.mjs --only=V,F,HCA  # a few
//   node scripts/resolve-quarters.mjs --fetch          # force the broad facts download
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CACHE = join(ROOT, 'data', 'cache', 'facts-broad');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const FORCE = process.argv.includes('--fetch');
mkdirSync(CACHE, { recursive: true });

const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dur = (r) => (Date.parse(r.end) - Date.parse(r.start)) / DAY;

// --- facts ----------------------------------------------------------------------------------------
// Keep every us-gaap tag, but only rows that can become a quarter: 60–400 day durations, last six years.
// That turns a 5–10 MB document into ~100 KB without losing anything the resolver needs.
async function broadFacts(cik) {
  const f = join(CACHE, `${cik}.json`);
  if (!FORCE && existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* refetch */ } }
  const since = new Date(Date.now() - 6 * 365 * DAY).toISOString().slice(0, 10);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, {
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) { await sleep(15000 * (attempt + 1)); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      const g = j.facts?.['us-gaap'] || {};
      const out = {};
      for (const [tag, v] of Object.entries(g)) {
        const usd = v?.units?.USD;
        if (!Array.isArray(usd)) continue;
        const rows = [];
        for (const e of usd) {
          if (!e.start || !e.end || e.val == null) continue;
          if (e.end < since) continue;
          const d = (Date.parse(e.end) - Date.parse(e.start)) / DAY;
          if (d < 60 || d > 400) continue;
          rows.push([e.start, e.end, e.val, e.form || '', e.filed || '']);
        }
        if (rows.length) out[tag] = rows;
      }
      writeFileSync(f, JSON.stringify(out));
      return out;
    } catch { await sleep(3000); }
  }
  return null;
}

// --- period maps ----------------------------------------------------------------------------------
// One map per concept: end date → value, with the best tag for each period.
function periodMap(facts, tags) {
  const discrete = new Map();   // end -> {val, tag, rank}
  const cumulative = new Map(); // start -> [{start,end,val,tag,rank,filed}]
  tags.forEach((tag, rank) => {
    const rows = facts[tag];
    if (!rows) return;
    for (const [start, end, val, form, filed] of rows) {
      const d = (Date.parse(end) - Date.parse(start)) / DAY;
      if (d > 75 && d < 105) {
        const cur = discrete.get(end);
        if (!cur || rank < cur.rank) discrete.set(end, { val, tag, rank });
      } else if (d >= 150) {
        // Keyed by tag AND start: differencing across two different concepts produced nonsense
        // (Visa's fiscal-year revenue minus another tag's quarter = 37.5B for a 10.9B quarter).
        const key = `${tag}|${start}`;
        if (!cumulative.has(key)) cumulative.set(key, []);
        cumulative.get(key).push({ start, end, val, tag, rank, filed });
      }
    }
  });
  // Difference consecutive cumulative periods that share a start date.
  for (const list of cumulative.values()) {
    list.sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      const span = (Date.parse(cur.end) - Date.parse(prev.end)) / DAY;
      if (span <= 75 || span >= 105) continue;
      const cand = { val: cur.val - prev.val, tag: cur.tag, rank: cur.rank + 0.5, derived: 'ytd' };
      const existing = discrete.get(cur.end);
      if (!existing || cand.rank < existing.rank) discrete.set(cur.end, cand);
    }
  }
  return discrete;
}

// "RevenueFromContractWithCustomerExcludingAssessedTax" is a revenue tag, so a bare /tax/ exclusion
// threw away the single most common revenue concept in the whole index.
// A total revenue line, not a slice of one. "BrokerageCommissionsRevenue" and
// "ContractWithCustomerLiabilityRevenueRecognized" both contain "revenue" and are not revenue.
const REV_WHITELIST = new Set([
  'Revenues', 'RevenuesNetOfInterestExpense', 'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet',
  'RegulatedAndUnregulatedOperatingRevenue', 'OperatingRevenues',
]);
const JUNK = /commission|brokerage|segment|product|service|liability|adjustment|gain|loss|interestincome|fee|premium|rental|relatedparty|deferred|costof|^other/i;
const isRevenue = (t) => /revenue|sales/i.test(t) && !JUNK.test(t);
const REV_PRIORITY = [
  'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense',
  'SalesRevenueNet', 'SalesRevenueGoodsNet', 'RegulatedAndUnregulatedOperatingRevenue',
  'OperatingRevenues', 'InterestAndDividendIncomeOperating',
];
const OPI_PRIORITY = ['OperatingIncomeLoss'];
const NI_PRIORITY = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'];

function rankFor(tags, priority) {
  const ordered = [...priority.filter((t) => tags.includes(t)), ...tags.filter((t) => !priority.includes(t)).sort()];
  return ordered;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik && !c.noFilings && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())));
console.log(`${todo.length} companies`);

let done = 0, noFacts = 0, incomplete = 0;
let i = 0;
async function worker() {
  while (i < todo.length) {
    const c = todo[i++];
    const facts = await broadFacts(c.cik);
    if (!facts) { noFacts++; await sleep(200); continue; }

    const allTags = Object.keys(facts);
    // Whitelisted concepts first; anything else only as a fallback.
    const revTags = rankFor(allTags.filter((t) => REV_WHITELIST.has(t) || isRevenue(t)), REV_PRIORITY);
    const opTags = rankFor(allTags.filter((t) => OPI_PRIORITY.includes(t) || /^CostsAndExpenses$|^CostOfRevenue$|^CostOfGoodsAndServicesSold$/.test(t)), OPI_PRIORITY);
    const niTags = rankFor(allTags.filter((t) => NI_PRIORITY.includes(t)), NI_PRIORITY);

    let rev = periodMap(facts, revTags.filter((t) => REV_WHITELIST.has(t)));
    // Banks do not tag a single revenue line: they report net interest income and noninterest income
    // separately, and total revenue is the two added together.
    const isBank = /^(60|6199)/.test(String(c.sic || '')) || (c.sector === 'Financials' && !rev.size);
    if (isBank) {
      const nii = periodMap(facts, ['InterestIncomeExpenseNet', 'InterestIncomeExpenseNonoperatingNet', 'InterestIncomeExpenseAfterProvisionForLoanLoss']);
      const nonii = periodMap(facts, ['NoninterestIncome']);
      const bank = new Map();
      for (const end of new Set([...nii.keys(), ...nonii.keys()])) {
        const a1 = nii.get(end), b1 = nonii.get(end);
        if (a1 && b1) bank.set(end, { val: a1.val + b1.val, tag: 'net interest + noninterest income' });
        else if (a1) bank.set(end, a1);
      }
      if (bank.size >= 4) rev = bank;
    }
    // Still nothing: accept the broader set, which is better than a blank column.
    if (!rev.size) rev = periodMap(facts, revTags.filter(isRevenue));
    const opi = periodMap(facts, opTags.filter((t) => t === 'OperatingIncomeLoss'));
    const ni = periodMap(facts, niTags);
    const costs = periodMap(facts, opTags.filter((t) => /^CostsAndExpenses$|^CostOfRevenue$|^CostOfGoodsAndServicesSold$/.test(t)));

    const annualRev = c.revenue || null;
    const ends = [...new Set([...rev.keys(), ...ni.keys()])].sort().slice(-8);
    const quarters = ends.map((end) => {
      const r = rev.get(end);
      const o = opi.get(end);
      const n = ni.get(end);
      // Operating income, or revenue − costs when the company does not tag the operating line.
      let op = o ? o.val : null;
      let opBasis = o ? 'filed' : null;
      if (op == null && r && costs.has(end)) {
        const cand = r.val - costs.get(end).val;
        if (Math.abs(cand) < Math.abs(r.val) * 3) { op = cand; opBasis = 'derived'; }
      }
      const revenue = r ? r.val : null;
      return {
        end,
        revenue,
        operatingIncome: op,
        opBasis,
        netIncome: n ? n.val : null,
        margin: revenue && op != null ? +((op / revenue) * 100).toFixed(1) : null,
        netMargin: revenue && n ? +((n.val / revenue) * 100).toFixed(1) : null,
      };
    });

    // Sanity: a quarter's revenue should sit near the median quarter, and near annual ÷ 4.
    const vals = quarters.map((q) => q.revenue).filter((v) => v != null && v > 0).sort((a, b) => a - b);
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
    const suspect = quarters.filter((q) => {
      if (q.revenue == null) return false;
      if (annualRev && (q.revenue > annualRev * 2 || q.revenue < annualRev / 20)) return true;
      if (med && (q.revenue > med * 4 || q.revenue < med / 4)) return true;
      return false;
    });
    const clean = quarters.map((q) => (suspect.includes(q) ? { ...q, revenue: null, margin: null, netMargin: null } : q));

    c.quarters = clean;
    c.quartersSource = {
      revenue: [...rev.values()].map((v) => v.tag).sort((a, b) => a.localeCompare(b))[0] || null,
      operatingIncome: [...opi.values()].map((v) => v.tag)[0] || (clean.some((q) => q.opBasis === 'derived') ? 'derived' : null),
      netIncome: [...ni.values()].map((v) => v.tag)[0] || null,
    };
    const filled = clean.filter((q) => q.revenue != null).length;
    if (filled < 8) incomplete++;
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${todo.length} · ${incomplete} with fewer than 8 revenue quarters`);
    await sleep(140);
  }
}
await Promise.all([worker(), worker(), worker()]);

console.log(`resolved ${done} companies · ${noFacts} without facts · ${incomplete} with <8 revenue quarters`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
