// Build the last eight quarters of revenue and net income for each company.
//
// The five-year table answers "how has this business grown"; the quarterly table answers "what is
// happening now". Both come from the same filing index, so the quarters reconcile with the annual
// figures rather than being a separate feed.
//
//   node scripts/build-quarters.mjs
//   node scripts/build-quarters.mjs --only=AAPL,MSFT

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const FACTS = join(ROOT, 'data', 'cache', 'facts');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
mkdirSync(FACTS, { recursive: true });

const REVENUE = ['Revenues', 'RevenuesNetOfInterestExpense', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RegulatedAndUnregulatedOperatingRevenue', 'OperatingRevenues'];
const NETINC = ['NetIncomeLossAvailableToCommonStockholdersBasic', 'NetIncomeLoss', 'ProfitLoss'];

async function facts(cik) {
  const f = join(FACTS, `${cik}.json`);
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* refetch */ } }
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const j = await res.json();
    const slim = { facts: { 'us-gaap': {} } };
    for (const [k, v] of Object.entries(j.facts?.['us-gaap'] || {})) {
      if (Array.isArray(v?.units?.USD)) slim.facts['us-gaap'][k] = { units: { USD: v.units.USD } };
    }
    writeFileSync(f, JSON.stringify(slim));
    return slim;
  } catch { return null; }
}

// Quarterly rows for one concept, de-duplicated by period end (the last filed wins).
function quarterRows(usd) {
  const rows = (Array.isArray(usd) ? usd : []).filter((e) => e.start && e.end && dur(e) > 75 && dur(e) < 105);
  const byEnd = new Map();
  for (const e of rows) {
    const cur = byEnd.get(e.end);
    if (!cur || String(e.filed) > String(cur.filed)) byEnd.set(e.end, e);
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
}

// Revenue is not in the slim facts cache (the earnings passes never needed it), so read it per concept.
const CONCEPTS = join(ROOT, 'data', 'cache', 'concepts');
mkdirSync(CONCEPTS, { recursive: true });
async function conceptUnits(cik, tag) {
  const f = join(CONCEPTS, `${cik}_${tag}.json`);
  if (existsSync(f)) { try { const j = JSON.parse(readFileSync(f, 'utf8')); const u = j?.units?.USD; if (Array.isArray(u) && u.length) return u; } catch { /* refetch */ } }
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const j = await res.json();
    writeFileSync(f, JSON.stringify(j));
    const u = j?.units?.USD;
    return Array.isArray(u) ? u : null;
  } catch { return null; }
}

// Pick the tag whose latest quarter is the NEWEST, not the first with four rows: Apple's `Revenues`
// stopped being tagged quarterly in 2018 and would otherwise supply a decade-old table.
function newestSeries(candidates, min = 4) {
  let best = null;
  for (const { tag, rows } of candidates) {
    if (!rows || rows.length < min) continue;
    const last = rows[rows.length - 1].end;
    if (!best || last > best.last) best = { tag, rows, last };
  }
  return best;
}
const series = (g, tags, min = 4) => newestSeries(tags.map((tag) => ({ tag, rows: quarterRows(g[tag]?.units?.USD) })), min);

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik && !c.noFilings && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())));
console.log(`${todo.length} companies`);

let built = 0;
let skipped = 0;
for (const c of todo) {
  const j = await facts(c.cik);
  if (!j) { skipped++; continue; }
  const g = j.facts?.['us-gaap'] || {};
  let rev = newestSeries(await Promise.all(REVENUE.map(async (tag) => ({ tag, rows: quarterRows(await conceptUnits(c.cik, tag)) }))));
  // The per-concept endpoint is empty for some CIKs; fall back to the full index, caching only the
  // eight rows we keep so a rebuild does not re-download a 15 MB document.
  if (!rev) {
    const qf = join(ROOT, 'data', 'cache', 'quarters', `${c.cik}.json`);
    mkdirSync(dirname(qf), { recursive: true });
    if (existsSync(qf)) { try { rev = JSON.parse(readFileSync(qf, 'utf8')); } catch { rev = null; } }
    if (!rev) {
      try {
        let res = null;
        for (let attempt = 0; attempt < 3 && !res?.ok; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
          res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(c.cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
        }
        if (res?.ok) {
          const jj = await res.json();
          const gg = jj.facts?.['us-gaap'] || {};
          for (const tag of REVENUE) {
            const rows = quarterRows(gg[tag]?.units?.USD);
            if (rows.length >= 4) { rev = { tag, rows: rows.map((e) => ({ end: e.end, val: e.val })) }; break; }
          }
          if (rev) writeFileSync(qf, JSON.stringify(rev));
        }
      } catch { /* leave revenue empty */ }
    }
  }
  const ni = series(g, NETINC);
  if (!rev && !ni) { skipped++; continue; }
  const ends = new Set([...(rev?.rows || []), ...(ni?.rows || [])].map((e) => e.end));
  const quarters = [...ends].sort().slice(-8).map((end) => {
    const r = rev?.rows.find((e) => e.end === end);
    const n = ni?.rows.find((e) => e.end === end);
    return { end, revenue: r?.val ?? null, netIncome: n?.val ?? null };
  });
  c.quarters = quarters;
  await new Promise((r) => setTimeout(r, 120));
  c.quartersSource = { revenue: rev?.tag || null, netIncome: ni?.tag || null };
  built++;
}

console.log(`quarters built for ${built} companies · ${skipped} without quarterly data`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
