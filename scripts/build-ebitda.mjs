// Trailing EBITDA, so net debt/EBITDA is on the same basis as P/E and FCF.
//
// Operating income is reported quarterly in 10-Qs; D&A is reported year-to-date in the cash-flow
// statement. Two different constructions, both needed:
//   opInc TTM = the last four quarters (Q4 rebuilt as FY minus the three quarters inside that year)
//   D&A  TTM = last fiscal year + current YTD − the same YTD a year earlier
//
//   node scripts/build-ebitda.mjs

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CACHE = join(ROOT, 'data', 'cache', 'concepts');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
mkdirSync(CACHE, { recursive: true });

const OPINC = ['OperatingIncomeLoss'];
const DA = ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization'];

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

// Quarterly sum with the missing Q4 rebuilt from the fiscal year.
function quarterlyTTM(usd) {
  const rows = (Array.isArray(usd) ? usd : []).filter((e) => e.start && e.end && dur(e) > 75 && dur(e) < 105);
  const byEnd = new Map();
  for (const e of rows) {
    const cur = byEnd.get(e.end);
    if (!cur || String(e.filed) > String(cur.filed)) byEnd.set(e.end, e);
  }
  const qs = [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
  if (!qs.length) return null;
  const latest = qs[qs.length - 1];
  // Berkshire's operating-income tag stops in 2012; a decade-old quarter is not a trailing figure.
  if (Date.now() - Date.parse(latest.end) > 730 * DAY) return null;
  const annual = (Array.isArray(usd) ? usd : []).filter((e) => e.start && e.form === '10-K' && dur(e) > 300 && dur(e) < 400)
    .sort((a, b) => a.end.localeCompare(b.end));
  const fy = annual[annual.length - 1];
  const quarterFor = (target) => {
    const hit = qs.find((e) => Math.abs(Date.parse(e.end) - target) <= 20 * DAY);
    if (hit) return hit;
    if (!fy || Math.abs(Date.parse(fy.end) - target) > 20 * DAY) return null;
    const inside = qs.filter((e) => Date.parse(e.end) <= Date.parse(fy.end) + 5 * DAY
      && Date.parse(e.start) >= Date.parse(fy.end) - 370 * DAY).slice(-3);
    if (inside.length !== 3) return null;
    return { end: fy.end, val: fy.val - inside.reduce((a, e) => a + e.val, 0) };
  };
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const q = quarterFor(Date.parse(latest.end) - i * 91 * DAY);
    if (!q) return null;
    parts.push(q);
  }
  const span = (Date.parse(parts[0].end) - Date.parse(parts[3].end)) / DAY;
  if (span < 250 || span > 300) return null;
  return { val: parts.reduce((a, e) => a + e.val, 0), asOf: parts[0].end };
}

// Year-to-date cash-flow construction.
function ytdTTM(usd) {
  const rows = (Array.isArray(usd) ? usd : []).filter((e) => e.start && e.end);
  const annual = rows.filter((e) => dur(e) > 300 && dur(e) < 400).sort((a, b) => a.end.localeCompare(b.end));
  const fy = annual[annual.length - 1];
  if (!fy) return null;
  const ytd = rows.filter((e) => dur(e) >= 120 && dur(e) <= 330 && Date.parse(e.end) > Date.parse(fy.end))
    .sort((a, b) => a.end.localeCompare(b.end));
  const latest = ytd[ytd.length - 1];
  if (!latest) return { val: fy.val, asOf: fy.end };
  const prior = rows.find((e) => Math.abs(dur(e) - dur(latest)) < 20
    && Math.abs(Date.parse(e.end) - (Date.parse(latest.end) - 365 * DAY)) < 30 * DAY);
  if (!prior) return null;
  return { val: fy.val + latest.val - prior.val, asOf: latest.end };
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
// Financials are included only when they operate real assets (capex is tagged) — a conglomerate like
// Berkshire has a meaningful EBITDA; a pure bank does not.
const todo = data.companies.filter((c) => c.cik && !c.noFilings
  && (c.sector !== 'Financials' || c.fcf != null));
console.log(`${todo.length} non-financial companies`);

let built = 0;
for (const c of todo) {
  let op = null;
  for (const tag of OPINC) { const v = quarterlyTTM(await units(c.cik, tag)); if (v) { op = v; break; } }
  let da = null;
  for (const tag of DA) { const v = ytdTTM(await units(c.cik, tag)); if (v) { da = v; break; } }
  // Clear any previous figure first: a failed extraction must not leave a stale TTM on the record.
  c.opIncTTM = null; c.daTTM = null; c.ebitdaTTM = null; c.ebitdaBasis = null;
  if (op && da) {
    c.opIncTTM = op.val;
    c.daTTM = da.val;
    c.ebitdaTTM = op.val + da.val;
    c.ebitdaTTMAsOf = op.asOf;
    built++;
  } else if (op) {
    // No trailing D&A: the fiscal-year figure is the best available, and the basis says so.
    c.opIncTTM = op.val;
    c.ebitdaTTM = op.val + (c.da || 0);
    c.ebitdaBasis = 'TTM operating income + FY D&A';
    built++;
  }
}

console.log(`trailing EBITDA for ${built} companies`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
