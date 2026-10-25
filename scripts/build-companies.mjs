// Build a company directory from SEC XBRL — the one global dataset that is structured and free.
//
// Universe: every company that appears in the deal book with an SEC CIK (the filing URL carries it),
// plus its SIC industry and the three facts that matter for a profile: revenue, net income, assets.
// No parsing, no estimates — these are tagged numbers from the filings.
//
//   node scripts/build-companies.mjs --limit=50 --dry
//   node scripts/build-companies.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIC_SECTOR } from '../src/deals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'deals-store.json');
const OUT = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const LIMIT = Number(arg('limit', 9999));
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 165 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 403 || res.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!res.ok) return null;
      return res.json();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

// Latest annual (10-K) value of a concept, in USD.
function annual(concept, tag) {
  const units = concept?.units || {};
  const key = Object.keys(units).find((u) => u === 'USD') || Object.keys(units)[0];
  const arr = units[key];
  if (!Array.isArray(arr)) return null;
  const rows = arr.filter((r) => r.form === '10-K' && r.fp === 'FY');
  if (!rows.length) return null;
  rows.sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const r = rows[rows.length - 1];
  return { val: r.val, end: r.end, fy: r.fy };
}

const store = JSON.parse(readFileSync(STORE, 'utf8'));
const ciks = new Map();
for (const d of store.deals) {
  const m = /\/Archives\/edgar\/data\/(\d+)\//.exec(d.url || '');
  if (!m) continue;
  const cik = String(Number(m[1]));
  if (!ciks.has(cik)) ciks.set(cik, d.acquirer || d.target);
}
const list = [...ciks.entries()].slice(0, LIMIT);
console.log(`${list.length} companies with an SEC CIK`);

const out = [];
for (const [cik, name] of list) {
  const sub = await get(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`);
  if (!sub) continue;
  const base = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik.padStart(10, '0')}/us-gaap/`;
  // Four independent concepts: fetch them together, not one after another.
  const [r1, r2, r3, ni, assets] = await Promise.all([
    get(base + 'RevenueFromContractWithCustomerExcludingAssessedTax.json'),
    get(base + 'Revenues.json'),
    get(base + 'SalesRevenueNet.json'),
    get(base + 'NetIncomeLoss.json'),
    get(base + 'Assets.json'),
  ]);
  const rev = r1 || r2 || r3;
  const company = {
    cik, ticker: (sub.tickers || [])[0] || null, name: sub.name || name,
    sic: sub.sic || null, sector: SIC_SECTOR(sub.sic),
    industry: sub.sicDescription || null,
    state: sub.stateOfIncorporation || null,
    fiscal: rev ? rev.fy : null,
    revenue: annual(rev)?.val ?? null,
    netIncome: annual(ni)?.val ?? null,
    assets: annual(assets)?.val ?? null,
    asOf: annual(rev)?.end || annual(assets)?.end || null,
  };
  if (company.revenue || company.assets) out.push(company);
  if (out.length % 25 === 0) {
    console.log(`  ${out.length} kept · ${name.slice(0, 30)}`);
    if (!DRY) {                       // save as we go: a long build must not lose its work
      writeFileSync(OUT + '.tmp', JSON.stringify({ updated: new Date().toISOString(), count: out.length, companies: out.slice().sort((a, b) => (b.revenue || 0) - (a.revenue || 0)) }));
      renameSync(OUT + '.tmp', OUT);
    }
  }
}

out.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
if (!DRY) {
  writeFileSync(OUT + '.tmp', JSON.stringify({ updated: new Date().toISOString(), count: out.length, companies: out }));
  renameSync(OUT + '.tmp', OUT);
}
console.log(`wrote ${out.length} companies · with revenue ${out.filter((c) => c.revenue).length}`);
