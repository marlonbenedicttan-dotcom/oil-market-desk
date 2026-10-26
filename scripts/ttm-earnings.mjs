// Recompute trailing-twelve-month and fiscal-year net income from the freshest tag, not the first one.
//
// The frames pass assumed a company keeps reporting `NetIncomeLoss` forever. Broadcom stopped tagging
// it quarterly in 2019 and moved to `ProfitLoss`, so "the last four quarters" summed 2018–19 and
// produced a $3.0B TTM against a company earning $23B a year. That is not a rounding error; it is a
// different decade.
//
// This pass reads three net-income concepts per company, keeps the one whose latest data is newest,
// and only accepts a TTM that is four contiguous quarters newer than the fiscal year and within a
// sane multiple of it.
//
//   node scripts/ttm-earnings.mjs --dry
//   node scripts/ttm-earnings.mjs --limit=20

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
    const wait = Math.max(0, 130 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${tag}.json`, {
        headers: { 'User-Agent': UA },
      });
      if (res.status === 404) { writeFileSync(file, 'null'); return null; }
      if (!res.ok) { await sleep(1200 * (i + 1)); continue; }
      const doc = await res.json();
      writeFileSync(file, JSON.stringify(doc));
      return doc;
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

const DAY = 86400000;
const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;

function fiscalYear(doc) {
  const usd = Array.isArray(doc?.units?.USD) ? doc.units.USD : [];
  const rows = usd.filter((e) => e.start && e.end && e.form === '10-K' && dur(e) > 300 && dur(e) < 400);
  if (!rows.length) return null;
  rows.sort((a, b) => a.end.localeCompare(b.end));
  const x = rows[rows.length - 1];
  return { val: x.val, end: x.end, year: Number(x.end.slice(0, 4)) };
}

function trailing(doc) {
  const fy = fiscalYear(doc);
  const usd = Array.isArray(doc?.units?.USD) ? doc.units.USD : [];
  const rows = usd.filter((e) => e.start && e.end && dur(e) > 75 && dur(e) < 105);
  const byEnd = new Map();
  for (const e of rows) {
    const cur = byEnd.get(e.end);
    if (!cur || String(e.filed) > String(cur.filed)) byEnd.set(e.end, e);
  }
  const qs = [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
  if (!qs.length) return null;
  const latest = qs[qs.length - 1];

  // The fourth quarter is normally only tagged inside the 10-K, never as its own quarter. Rebuild it
  // as fiscal year minus the three quarters that fall inside that year, or the window has a hole.
  const quarterFor = (target) => {
    const hit = qs.find((e) => Math.abs(Date.parse(e.end) - target) <= 20 * DAY);
    if (hit) return hit;
    if (!fy || Math.abs(Date.parse(fy.end) - target) > 20 * DAY) return null;
    const inside = qs.filter((e) => Date.parse(e.end) <= Date.parse(fy.end) + 5 * DAY
      && Date.parse(e.start) >= Date.parse(fy.end) - 370 * DAY);
    const three = inside.slice(-3);
    if (three.length !== 3) return null;
    return { end: fy.end, val: fy.val - three.reduce((a, e) => a + e.val, 0) };
  };

  const parts = [];
  for (let i = 0; i < 4; i++) {
    const q = quarterFor(Date.parse(latest.end) - i * 91 * DAY);
    if (!q) return null;
    parts.push(q);
  }
  parts.reverse();
  const span = (Date.parse(parts[3].end) - Date.parse(parts[0].end)) / DAY;
  if (span < 250 || span > 300) return null;

  // A quarter that is several times the trailing norm is a tagging artifact (a year-to-date figure
  // filed as a quarter, or a restated scope), not earnings. Without this, one such quarter can double
  // a company's trailing net income and halve its P/E.
  const prior = qs.filter((e) => Date.parse(e.end) < Date.parse(parts[0].end)).slice(-4).map((e) => e.val);
  if (prior.length === 4) {
    const sorted = [...prior].sort((x, y) => x - y);
    const median = (sorted[1] + sorted[2]) / 2;
    if (median > 0 && parts.some((p) => p.val > median * 3)) return null;
  }

  return { val: parts.reduce((a, e) => a + e.val, 0), asOf: parts[3].end };
}

const TAGS = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'];

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik).slice(0, LIMIT);
console.log(`${todo.length} companies`);

let changed = 0;
let done = 0;
for (const c of todo) {
  let best = null;
  for (const tag of TAGS) {
    const doc = await concept(c.cik, tag);
    const fy = fiscalYear(doc);
    const ttm = trailing(doc);
    const stamp = Math.max(fy ? Date.parse(fy.end) : 0, ttm ? Date.parse(ttm.asOf) : 0);
    if (!stamp) continue;
    if (!best || stamp > best.stamp) best = { tag, fy, ttm, stamp };
  }
  done++;
  if (done % 50 === 0) console.log(`  … ${done}`);

  if (!best) { c.netIncomeTTM = null; c.netIncomeTTMAsOf = null; continue; }

  const before = JSON.stringify([c.netIncome, c.netIncomeTTM, c.netIncomeTTMAsOf]);

  if (best.fy) {
    c.netIncome = best.fy.val;
    c.fyNetIncome = best.fy.year;
    c.netIncomeEnd = best.fy.end;
    c.netIncomeTag = best.tag;
  }
  // A TTM is only useful when it is newer than the fiscal year and lands in the same order of
  // magnitude; otherwise the fiscal year is the honest number.
  const t = best.ttm;
  const fy = best.fy;
  const fresh = t && (!fy || Date.parse(t.asOf) > Date.parse(fy.end));
  const sane = !fresh || !fy || fy.val === 0 ? fresh : (Math.abs(t.val / fy.val) >= 0.2 && Math.abs(t.val / fy.val) <= 5);
  if (fresh && sane) {
    c.netIncomeTTM = t.val;
    c.netIncomeTTMAsOf = t.asOf;
  } else {
    c.netIncomeTTM = null;
    c.netIncomeTTMAsOf = null;
  }

  if (JSON.stringify([c.netIncome, c.netIncomeTTM, c.netIncomeTTMAsOf]) !== before) changed++;
}

// A fiscal year that is years behind the rest of the universe is a stale tag, not a late filer.
const maxYear = Math.max(...data.companies.map((c) => c.fyNetIncome || 0));
let cleared = 0;
for (const c of data.companies) {
  if (c.fyNetIncome && c.fyNetIncome < maxYear - 2) {
    c.netIncome = null;
    c.fyNetIncome = null;
    c.netIncomeTag = null;
    c.netIncomeTTM = null;
    c.netIncomeTTMAsOf = null;
    cleared++;
  }
}
console.log(`recomputed earnings · ${changed} changed · ${cleared} stale years cleared`);
if (DRY) console.log('dry run — nothing written');
else {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
