// Capital metrics: the ones that apply when free cash flow does not.
//
// A bank's operating cash flow moves with loans and deposits, so FCF is meaningless there. What matters
// is tangible book, the efficiency ratio and net interest margin. And every company — bank, loss-maker,
// anyone — can answer "what does it return to me" through shareholder yield.
//
//   node scripts/build-capital-metrics.mjs
//   node scripts/build-capital-metrics.mjs --sector=Financials

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CACHE = join(ROOT, 'data', 'cache', 'concepts');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const SECTOR = (process.argv.find((x) => x.startsWith('--sector=')) || '').split('=')[1];
const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
mkdirSync(CACHE, { recursive: true });

const BUYBACK = ['PaymentsForRepurchaseOfCommonStock', 'PaymentsForRepurchaseOfEquity'];
const DIVIDEND = ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'];
const GOODWILL = ['Goodwill'];
const INTANGIBLES = ['IntangibleAssetsNetExcludingGoodwill', 'FiniteLivedIntangibleAssetsNet'];
const NONINT = ['NoninterestExpense'];
const NII = ['InterestIncomeExpenseNet'];

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

const annual = (usd, year) => {
  const rows = (Array.isArray(usd) ? usd : []).filter((e) => e.start && e.form === '10-K' && dur(e) > 300 && dur(e) < 400);
  if (!rows.length) return null;
  rows.sort((a, b) => (a.end === b.end ? String(a.filed).localeCompare(String(b.filed)) : a.end.localeCompare(b.end)));
  const hit = year ? [...rows].reverse().find((e) => Number(e.end.slice(0, 4)) === year) : null;
  const x = hit || rows[rows.length - 1];
  return { val: x.val, end: x.end };
};
const instant = (usd, year) => {
  const rows = (Array.isArray(usd) ? usd : []).filter((e) => !e.start && e.form === '10-K');
  if (!rows.length) return null;
  rows.sort((a, b) => (a.end === b.end ? String(a.filed).localeCompare(String(b.filed)) : a.end.localeCompare(b.end)));
  const hit = year ? [...rows].reverse().find((e) => Number(e.end.slice(0, 4)) === year) : null;
  const x = hit || rows[rows.length - 1];
  return { val: x.val, end: x.end };
};
async function first(cik, tags, picker, year) {
  for (const tag of tags) {
    const v = picker(await units(cik, tag), year);
    if (v) return { ...v, tag };
  }
  return null;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik && !c.noFilings && (!SECTOR || c.sector === SECTOR));
console.log(`${todo.length} companies`);

let built = 0;
for (const c of todo) {
  const year = c.netIncomeEnd ? Number(String(c.netIncomeEnd).slice(0, 4)) : null;

  // Buybacks — every company, so shareholder yield exists everywhere.
  const bb = await first(c.cik, BUYBACK, annual, year);
  if (bb) { c.buybacks = Math.abs(bb.val); c.buybacksEnd = bb.end; }
  const dv = await first(c.cik, DIVIDEND, annual, year);
  if (dv) { c.dividendsPaid = Math.abs(dv.val); c.dividendsEnd = dv.end; }

  if (c.sector !== 'Financials') continue;

  const gw = await first(c.cik, GOODWILL, instant, year);
  const it = await first(c.cik, INTANGIBLES, instant, year);
  if (gw || it) {
    c.goodwill = gw ? gw.val : 0;
    c.intangibles = it ? it.val : 0;
  }
  const ne = await first(c.cik, NONINT, annual, year);
  if (ne) c.noninterestExpense = Math.abs(ne.val);
  const ni = await first(c.cik, NII, annual, year);
  if (ni) c.netInterestIncome = ni.val;
  built++;
}

console.log(`capital metrics for ${built} financials · buybacks for ${data.companies.filter((c) => c.buybacks != null).length}`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
