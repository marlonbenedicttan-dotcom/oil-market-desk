// Balance-sheet pass: every instant value from each company's newest 10-K, not from a calendar frame.
//
// The annual frames are keyed CY...Q4I, so a company with a July fiscal year gets an instant up to a
// year stale, and a company that stops tagging a concept keeps its last value forever (Garmin's
// stockholders' equity was from 2010; UnitedHealth's from 2014). This reads the newest 10-K instant
// per concept, tries the acceptable tag family, and refuses anything more than two years behind the
// rest of the universe.
//
//   node scripts/balance-pass.mjs
//   node scripts/balance-pass.mjs --dry --limit=20

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DRY = process.argv.includes('--dry');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '--limit=0').split('=')[1]) || Infinity;
const CACHE = join(ROOT, 'data', 'cache', 'concepts');
mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

async function concept(cik, tag) {
  const file = join(CACHE, `${cik}_${tag}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* refetch */ }
  }
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 260 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`, {
        headers: { 'User-Agent': UA },
      });
      if (res.status === 404) return null;
      if (res.status === 429) {
        // Back the whole pool off, not just this request.
        last = Date.now() + 4000;
        await sleep(4000 * (i + 1));
        continue;
      }
      if (!res.ok) { await sleep(1500 * (i + 1)); continue; }
      const doc = await res.json();
      writeFileSync(file, JSON.stringify(doc));
      return doc;
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

function latestInstant(doc) {
  const usd = Array.isArray(doc?.units?.USD) ? doc.units.USD : [];
  const rows = usd.filter((e) => !e.start && e.end && e.form === '10-K');
  if (!rows.length) return null;
  rows.sort((a, b) => a.end.localeCompare(b.end));
  const x = rows[rows.length - 1];
  return { val: x.val, end: x.end };
}

// field -> acceptable concepts, in preference order
const FIELDS = {
  equity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    'CommonStockholdersEquity',
    'PartnersCapital',
    'PartnersCapitalIncludingPortionAttributableToNoncontrollingInterest',
  ],
  assets: ['Assets'],
  currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  debt: [
    'LongTermDebtNoncurrent',
    'LongTermDebt',
    'LongTermDebtAndCapitalLeaseObligations',
    'DebtLongtermAndShorttermCombinedAmount',
  ],
  cash: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik).slice(0, LIMIT);
console.log(`${todo.length} companies`);

const picked = [];
let done = 0;
const queue = todo.slice();
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    const found = {};
    for (const [field, tags] of Object.entries(FIELDS)) {
      let best = null;
      for (const tag of tags) {
        const v = latestInstant(await concept(c.cik, tag));
        if (!v) continue;
        if (!best || v.end > best.end) best = { ...v, tag };
      }
      if (best) found[field] = best;
    }
    done++;
    if (done % 50 === 0) console.log(`  … ${done}`);
    picked.push({ c, found });
  }
}
await Promise.all([worker(), worker()]);

// Freshness: two years behind the newest instant in the universe means the tag stopped being used.
const newest = Math.max(0, ...picked.flatMap(({ found }) => Object.values(found).map((v) => Date.parse(v.end))).filter(Number.isFinite));
const cutoff = newest - 730 * 86400000;

let changed = 0;
let stale = 0;
for (const { c, found } of picked) {
  for (const [field, v] of Object.entries(found)) {
    if (Date.parse(v.end) < cutoff) { stale++; continue; }
    if (c.assets && field === 'equity' && (v.val > c.assets * 1.02 || v.val < -c.assets)) continue;
    if (c.assets && field === 'currentAssets' && v.val > c.assets * 1.02) continue;
    const endKey = field + 'End';
    if (c[endKey] && v.end < c[endKey]) continue;      // never move backwards
    if (c[field] !== v.val) changed++;
    c[field] = v.val;
    c[endKey] = v.end;
    c[field + 'Tag'] = v.tag;
  }
}

console.log(`balance pass · ${changed} values changed · ${stale} stale instants refused`);
if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
