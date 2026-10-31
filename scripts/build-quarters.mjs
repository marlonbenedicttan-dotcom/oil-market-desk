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
//
// Some filers only tag year-to-date figures in their 10-Qs — Visa, Abbott, HCA, Ford — so a 90-day
// filter returns nothing and the quarter columns came back blank. Those are recovered by differencing
// consecutive cumulative periods that share a start date: Q2 = H1 − Q1, Q3 = 9M − H1, Q4 = FY − 9M.
// A discrete figure always wins over a derived one.
function quarterRows(usd) {
  const all = Array.isArray(usd) ? usd : [];
  const rows = all.filter((e) => e.start && e.end && dur(e) > 75 && dur(e) < 105);
  const byEnd = new Map();
  for (const e of rows) {
    const cur = byEnd.get(e.end);
    if (!cur || String(e.filed) > String(cur.filed)) byEnd.set(e.end, e);
  }

  // Cumulative rows, de-duplicated by (start, end) keeping the latest filing.
  const cum = new Map();
  for (const e of all) {
    if (!e.start || !e.end) continue;
    const d = dur(e);
    if (d < 150 || d > 400) continue;
    const k = `${e.start}|${e.end}`;
    const cur = cum.get(k);
    if (!cur || String(e.filed) > String(cur.filed)) cum.set(k, e);
  }
  const byStart = new Map();
  for (const e of cum.values()) {
    if (!byStart.has(e.start)) byStart.set(e.start, []);
    byStart.get(e.start).push(e);
  }
  for (const list of byStart.values()) {
    list.sort((a, b) => a.end.localeCompare(b.end));
    let prev = null;
    for (const e of list) {
      if (prev && prev.start === e.start) {
        const span = (Date.parse(e.end) - Date.parse(prev.end)) / DAY;
        if (span > 75 && span < 105 && !byEnd.has(e.end)) {
          byEnd.set(e.end, { start: prev.end, end: e.end, val: e.val - prev.val, filed: e.filed, derived: true });
        }
      }
      prev = e;
    }
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

// When none of the whitelisted tags carries a quarter, read the whole company document and take every
// revenue-ish tag it has. Visa tags `Revenues`, Abbott `RevenueFromContractWithCustomerExcludingAssessedTax`
// only in the 10-K — the whitelist cannot know every variant, so the fallback stops whitelisting.
async function factsRevenue(cik) {
  const f = join(ROOT, 'data', 'cache', 'quarters', `${cik}.json`);
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* refetch */ } }
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const j = await res.json();
    const g = j.facts?.['us-gaap'] || {};
    const out = {};
    for (const [tag, v] of Object.entries(g)) {
      if (!/revenue|sales/i.test(tag)) continue;
      const rows = quarterRows(v?.units?.USD);
      if (rows.length >= 2) out[tag] = rows.map((r) => ({ end: r.end, val: r.val, derived: !!r.derived }));
    }
    if (Object.keys(out).length) writeFileSync(f, JSON.stringify(out));
    return out;
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
  // One tag is not enough: Visa, Ford, General Dynamics and HCA tag quarterly revenue under a different
  // concept than their annual figure, so picking a single series left eight blank columns. Merge every
  // candidate tag per period — the primary (newest) series wins, the others fill the gaps.
  const revCandidates = [];
  for (const tag of REVENUE) {
    const rows = quarterRows(await conceptUnits(c.cik, tag));
    if (rows.length) revCandidates.push({ tag, rows });
  }
  const mergeRows = (cands) => {
    const primary = newestSeries(cands);
    const byEnd = new Map();
    if (primary) for (const r of primary.rows) byEnd.set(r.end, { val: r.val, tag: primary.tag });
    for (const { tag, rows } of cands) for (const r of rows) if (!byEnd.has(r.end)) byEnd.set(r.end, { val: r.val, tag });
    return byEnd;
  };
  let revMap = mergeRows(revCandidates);
  if (revMap.size < 4) {
    const broad = await factsRevenue(c.cik);
    if (broad) {
      const extra = Object.entries(broad).map(([tag, rows]) => ({ tag, rows }));
      revMap = mergeRows([...revCandidates, ...extra]);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const niCandidates = [];
  for (const tag of NETINC) {
    const rows = quarterRows(g[tag]?.units?.USD);
    if (rows.length) niCandidates.push({ tag, rows });
  }
  const niMap = mergeRows(niCandidates);
  if (!revMap.size && !niMap.size) { skipped++; continue; }
  const ends = new Set([...revMap.keys(), ...niMap.keys()]);
  const quarters = [...ends].sort().slice(-8).map((end) => ({
    end,
    revenue: revMap.get(end)?.val ?? null,
    netIncome: niMap.get(end)?.val ?? null,
  }));

  c.quarters = quarters;
  await new Promise((r) => setTimeout(r, 120));
  // Provenance: the dominant tag, and a note when the series needed more than one.
  const tagTally = (m) => {
    const t = {};
    for (const v of m.values()) t[v.tag] = (t[v.tag] || 0) + 1;
    return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  const revTags = tagTally(revMap), niTags = tagTally(niMap);
  c.quartersSource = { revenue: revTags[0] || null, netIncome: niTags[0] || null };
  if (revTags.length > 1 || niTags.length > 1) c.quartersSource.mixed = { revenue: revTags, netIncome: niTags };
  built++;
}

console.log(`quarters built for ${built} companies · ${skipped} without quarterly data`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
