// Data-quality audit: separate "the formula is right" from "the feed is old or the tags disagree".
//
//   node scripts/audit-data-quality.mjs
//   node scripts/audit-data-quality.mjs --strict   # exit 1 when any issue is found
//
// Writes data/data-quality.json and prints a per-market summary. It does not modify market files; a
// stale company is repaired by the next full build (or a targeted refresh).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const DAY = 864e5;
const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const dateOf = (q) => String(q.end || q.d || '').slice(0, 10);
const listOf = (rel) => { const d = join(ROOT, 'data', rel); if (!existsSync(d)) return []; return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => read(join(d, f))).filter(Boolean); };

// The matrix model is the authority on the fiscal-year grouping; use it rather than treating every
// calendar year as a fiscal year (Japan's March year-end made the naive audit flag 2,648 companies).
const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const start = app.indexOf('function coMatrixPeriods');
const end = app.indexOf('function coMatrixInner');
const build = new Function(`${app.slice(start, end)}\nreturn coMatrixBuild;`)();

const ttmFromQuarters = (quarters, periodBasis) => {
  const rows = (quarters || []).map((x) => ({ d: dateOf(x), revenue: x.revenue ?? x.sales ?? null, netIncome: x.netIncome ?? x.np ?? null })).filter((x) => x.d).sort((a, b) => a.d.localeCompare(b.d));
  if (rows.length < 2) return null;
  let n = periodBasis === 'half' ? 2 : periodBasis === 'quarter' ? 4 : 0;
  if (!n) { const g = []; for (let i = 1; i < rows.length; i++) g.push((Date.parse(rows[i].d) - Date.parse(rows[i - 1].d)) / DAY); g.sort((a, b) => a - b); n = g[Math.floor(g.length / 2)] > 135 ? 2 : 4; }
  const last = rows.slice(-n); if (last.length !== n) return null;
  const lo = n === 2 ? 150 : 70, hi = n === 2 ? 220 : 200;
  for (let i = 1; i < last.length; i++) { const gap = (Date.parse(last[i].d) - Date.parse(last[i - 1].d)) / DAY; if (gap < lo || gap > hi) return null; }
  const nis = last.map((x) => x.netIncome), revs = last.map((x) => x.revenue);
  return { n, end: last[last.length - 1].d,
    netIncome: nis.every((v) => v != null) ? nis.reduce((a, b) => a + b, 0) : null,
    revenue: revs.every((v) => v != null) ? revs.reduce((a, b) => a + b, 0) : null };
};

const MARKETS = [
  ['us', 'US', 'companies.json'],
  ['japan', 'Japan', 'japan-companies'],
  ['korea', 'Korea', 'korea-companies'],
  ['taiwan', 'Taiwan', 'taiwan-companies'],
  ['hongkong', 'Hong Kong', 'hongkong-companies'],
  ['australia', 'Australia', 'australia-companies'],
  ['india', 'India', 'india-companies'],
  ['indonesia', 'Indonesia', 'indonesia-companies'],
  ['brazil', 'Brazil', 'brazil-companies'],
  ['southafrica', 'South Africa', 'southafrica-companies'],
];

const report = { updated: new Date().toISOString(), markets: {}, issues: [] };
let total = 0, flagged = 0;
for (const [id, label, source] of MARKETS) {
  const rows = source.endsWith('.json') ? (read(join(ROOT, 'data', source))?.companies || []) : listOf(source);
  const stat = { companies: rows.length, stale: 0, gap: 0, annual: 0, tag: 0, ttm: 0 };
  for (const c of rows) {
    total++;
    const m = build(c, { market: id });
    if (!m) continue;
    const qs = (c.quarters || []).map((q) => ({ d: dateOf(q), revenue: q.revenue ?? q.sales ?? null, netIncome: q.netIncome ?? q.np ?? null })).filter((q) => q.d).sort((a, b) => a.d.localeCompare(b.d));
    if (!qs.length) continue;
    const issues = [];
    const latest = m.periods[m.periods.length - 1];
    const age = (Date.parse(TODAY) - Date.parse(latest.date)) / DAY;
    const priceDate = c.priceDate || c.priceAsOf || null;
    const quoteFresh = !priceDate || (Date.parse(TODAY) - Date.parse(priceDate)) / DAY < 45;
    if (age > 450 && quoteFresh) { stat.stale++; issues.push(`stale feed: latest period ${latest.date} (${Math.round(age)}d old)`); }
    const lastN = m.periods.slice(-m.n);
    let contiguous = lastN.length === m.n;
    for (let i = 1; contiguous && i < lastN.length; i++) {
      const gap = (Date.parse(lastN[i].date) - Date.parse(lastN[i - 1].date)) / DAY;
      if (gap < (m.n === 2 ? 150 : 70) || gap > (m.n === 2 ? 220 : 200)) contiguous = false;
    }
    if (!contiguous && m.periods.length >= m.n) { stat.gap++; issues.push('missing period in the latest window'); }
    const qTtm = ttmFromQuarters(c.quarters, c.periodBasis);
    const tileNet = c.reports?.ttm?.netIncome ?? c.netIncomeTTM ?? null;
    if (qTtm && tileNet != null && Math.abs(qTtm.netIncome - tileNet) / Math.max(Math.abs(qTtm.netIncome), Math.abs(tileNet), 1) > 0.10) {
      stat.ttm++; issues.push(`TTM tile ${tileNet} vs four quarters ${qTtm.netIncome}`);
    }
    // Fiscal-year reconciliation on the matrix's own groups, not calendar years.
    const annual = new Map();
    for (const s of c.series || []) annual.set(Number(s.fy), s.revenue);
    for (const h of c.history || []) annual.set(Number(String(h.y).slice(0, 4)), h.s);
    const financial = /^(Financials|Real estate|Banks|Insurance)$/i.test(c.sector || '') || /^(60|61|6199)/.test(String(c.sic || ''));
    if (!financial) {
      for (const y of m.years) {
        if (typeof y !== 'number' || !Number.isInteger(y)) continue;
        const g = m.groups.get(y); const a = annual.get(y);
        if (!g || a == null) continue;
        const vals = Object.keys(g).map((q) => g[q].revenue).filter((v) => v != null);
        if (vals.length !== m.n) continue;
        const sum = vals.reduce((x, z) => x + z, 0);
        if (Math.abs(sum - a) / Math.max(Math.abs(a), 1) > 0.15) { stat.annual++; issues.push(`FY${y}: quarters ${sum} vs annual ${a}`); break; }
      }
    }
    // A quarterly revenue line should be a meaningful fraction of the annual figure; a tiny or
    // oversized one is usually a contract-liability/segment tag rather than total revenue.
    const annualValues = [...annual.values()].filter((v) => v > 0);
    const lastAnnual = annualValues[annualValues.length - 1] || null;
    const lastQ = [...qs].reverse().find((q) => q.revenue != null && q.revenue > 0);
    if (!financial && lastAnnual && lastQ) {
      const ratio = lastQ.revenue / lastAnnual;
      if (ratio < 0.04 || ratio > 0.8) { stat.tag++; issues.push(`revenue tag suspect: quarter ${lastQ.revenue} vs annual ${lastAnnual}`); }
    }
    if (issues.length) {
      flagged++;
      if (report.issues.length < 300) report.issues.push({ market: id, id: c.ticker || c.code, issues: issues.slice(0, 4) });
    }
  }
  report.markets[id] = stat;
  console.log(`${label.padEnd(12)} companies ${String(stat.companies).padStart(5)} · stale ${String(stat.stale).padStart(4)} · gap ${String(stat.gap).padStart(4)} · annual ${String(stat.annual).padStart(4)} · tag ${String(stat.tag).padStart(4)} · ttm ${String(stat.ttm).padStart(4)}`);
}
writeFileSync(join(ROOT, 'data', 'data-quality.json'), JSON.stringify(report));
console.log(`\n${flagged} of ${total} companies carry at least one data-quality issue; report in data/data-quality.json`);
if (process.argv.includes('--strict') && flagged) process.exit(1);
