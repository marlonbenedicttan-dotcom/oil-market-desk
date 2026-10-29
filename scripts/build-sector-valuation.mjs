// Sector valuation: is this sector expensive against its own history?
//
// The same construction as the index, applied per sector: sum the market caps and the earnings of the
// companies that have a five-year price history, for each fiscal year, and divide. Using one consistent
// set of companies per year keeps the comparison like-for-like.
//
//   node scripts/build-sector-valuation.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const OUT = join(ROOT, 'data', 'valuation.json');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const companies = data.companies.filter((c) => !c.shareClass && c.sector);

const sectors = new Map();
for (const c of companies) {
  if (!sectors.has(c.sector)) sectors.set(c.sector, []);
  sectors.get(c.sector).push(c);
}

const out = {};
for (const [sector, list] of sectors) {
  const years = new Map();   // fy -> { cap, earn }
  for (const c of list) {
    if (!c.peHistory || !c.marketCap || !c.price) continue;
    const series = new Map((c.series || []).map((s) => [s.fy, s]));
    for (const y of c.peHistory.years) {
      const s = series.get(y.fy);
      if (!s || !(s.netIncome > 0)) continue;
      const cap = c.marketCap * (y.price / c.price);
      const agg = years.get(y.fy) || { cap: 0, earn: 0 };
      agg.cap += cap;
      agg.earn += s.netIncome;
      years.set(y.fy, agg);
    }
  }
  const history = [...years.entries()].filter(([, v]) => v.earn > 0)
    .map(([fy, v]) => ({ fy, pe: +(v.cap / v.earn).toFixed(1) })).sort((a, b) => a.fy - b.fy);
  if (history.length < 2) continue;

  // Current, on the same companies (those with history) so the comparison is like-for-like.
  const pool = list.filter((c) => c.peHistory && c.marketCap && c.netIncomeTTM > 0);
  const capNow = pool.reduce((a, c) => a + c.marketCap, 0);
  const earnNow = pool.reduce((a, c) => a + c.netIncomeTTM, 0);
  const peNow = earnNow > 0 ? +(capNow / earnNow).toFixed(1) : null;
  const pes = history.map((h) => h.pe);
  const below = peNow != null ? pes.filter((x) => x <= peNow).length : null;

  out[sector] = {
    pe: peNow,
    years: history,
    min: +Math.min(...pes).toFixed(1),
    median: +median(pes).toFixed(1),
    max: +Math.max(...pes).toFixed(1),
    percentile: below != null ? Math.round((below / pes.length) * 100) : null,
    companies: pool.length,
  };
}

const val = JSON.parse(readFileSync(OUT, 'utf8'));
val.sectors = out;
val.updated = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(val, null, 1));

console.log(`sector valuation for ${Object.keys(out).length} sectors`);
for (const [s, v] of Object.entries(out).sort((a, b) => (b[1].pe || 0) - (a[1].pe || 0))) {
  console.log(`  ${s.padEnd(14)} ${String(v.pe).padStart(5)}x  ${v.min}–${v.max} (median ${v.median}) · ${v.percentile}th pctile · ${v.companies} cos`);
}
