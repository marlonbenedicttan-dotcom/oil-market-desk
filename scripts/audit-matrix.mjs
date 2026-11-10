// Audit every company's quarterly / half-year matrix.
//
// The matrix is a browser function, so this script extracts the pure model from public/app.js
// (the same block tests/matrix.test.js uses) and runs it over every stored company. It is the
// system-level check: the individual tests cover named companies, this covers the 12,000+ pages
// and fails the build when a change makes quarter labels, ordering, or dates impossible.
//
//   node scripts/audit-matrix.mjs            report warnings, fail on critical issues
//   node scripts/audit-matrix.mjs --strict   fail on warnings too
//
// Critical: future-dated periods, non-integer or out-of-range quarters, cells whose dates run
// backwards. Warning: calendar fallback, periods that collide on one fiscal quarter (>21 days
// apart), an annual record that cannot reconcile, and companies with quarters but no matrix.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'public', 'app.js');
const strict = process.argv.includes('--strict');
const today = new Date().toISOString().slice(0, 10);

const src = readFileSync(APP, 'utf8');
const start = src.indexOf('function coMatrixPeriods');
const end = src.indexOf('function coMatrixInner');
if (start < 0 || end < 0) {
  console.error('Could not find the matrix model in public/app.js');
  process.exit(2);
}
const { coMatrixBuild } = new Function(`${src.slice(start, end)}\nreturn { coMatrixBuild };`)();

const MARKETS = [
  ['us', null],
  ['jp', 'japan-companies'],
  ['kr', 'korea-companies'],
  ['tw', 'taiwan-companies'],
  ['hk', 'hongkong-companies'],
  ['au', 'australia-companies'],
  ['in', 'india-companies'],
  ['id', 'indonesia-companies'],
  ['br', 'brazil-companies'],
  ['za', 'southafrica-companies'],
];

function companies(market, dir) {
  if (market === 'us') {
    const j = JSON.parse(readFileSync(join(ROOT, 'data', 'companies.json'), 'utf8'));
    return (j.companies || []).map((c) => ({ c, id: c.ticker || c.cik }));
  }
  const out = [];
  for (const f of readdirSync(join(ROOT, 'data', dir))) {
    if (!f.endsWith('.json')) continue;
    try { out.push({ c: JSON.parse(readFileSync(join(ROOT, 'data', dir, f), 'utf8')), id: f.replace('.json', '') }); }
    catch { /* a partial file is not a company */ }
  }
  return out;
}

const totals = { critical: 0, warnings: 0, companies: 0, models: 0, noModel: 0 };
const rows = [];

for (const [market, dir] of MARKETS) {
  const row = {
    market, companies: 0, models: 0, noModel: 0, noQuarters: 0,
    future: 0, badQuarter: 0, order: 0, collisions: 0, outliers: 0, calendar: 0,
    repaired: 0, annualOnly: 0, unreconciled: 0, stale: 0,
    examples: { future: [], badQuarter: [], order: [], collisions: [], outliers: [], calendar: [], noModel: [] },
  };
  for (const { c, id } of companies(market, dir)) {
    row.companies++;
    totals.companies++;
    const quarters = Array.isArray(c.quarters) ? c.quarters : [];
    if (!quarters.length) { row.noQuarters++; continue; }
    const m = coMatrixBuild(c, { market });
    if (!m) {
      row.noModel++;
      if (quarters.length >= 4) {
        row.examples.noModel.push(id);
        totals.warnings++;
      }
      continue;
    }
    row.models++;
    totals.models++;

    for (const p of m.periods) {
      if (p.date && p.date > today) {
        row.future++;
        totals.critical++;
        if (row.examples.future.length < 5) row.examples.future.push(`${id}: ${p.date}`);
      }
    }

    for (const [fy, g] of m.groups) {
      const qs = Object.keys(g).map(Number).sort((a, b) => a - b);
      for (let i = 0; i < qs.length; i++) {
        const q = qs[i];
        if (!Number.isInteger(q) || q < 1 || q > m.n) {
          row.badQuarter++;
          totals.critical++;
          if (row.examples.badQuarter.length < 5) row.examples.badQuarter.push(`${id}: FY${fy} Q${q}`);
        }
        if (i && g[qs[i]].date && g[qs[i - 1]].date && String(g[qs[i]].date) <= String(g[qs[i - 1]].date)) {
          row.order++;
          totals.critical++;
          if (row.examples.order.length < 5) row.examples.order.push(`${id}: FY${fy} Q${qs[i - 1]} ${g[qs[i - 1]].date} → Q${qs[i]} ${g[qs[i]].date}`);
        }
      }
    }

    if (m.quality && m.quality.collisions && m.quality.collisions.length) {
      row.collisions += m.quality.collisions.length;
      totals.warnings += m.quality.collisions.length;
      if (row.examples.collisions.length < 5) row.examples.collisions.push(`${id}: ${m.quality.collisions.slice(0, 2).join('; ')}`);
    }
    if (m.quality && m.quality.outliers && m.quality.outliers.length) {
      row.outliers += m.quality.outliers.length;
      totals.warnings += m.quality.outliers.length;
      if (row.examples.outliers.length < 5) row.examples.outliers.push(`${id}: ${m.quality.outliers.slice(0, 3).join(', ')}`);
    }
    if (m.grouping === 'calendar') {
      row.calendar++;
      totals.warnings++;
      if (row.examples.calendar.length < 5) row.examples.calendar.push(id);
    }
    if (m.repairs) {
      row.repaired += m.repairs.repaired?.size || 0;
      row.annualOnly += m.repairs.annualOnly?.size || 0;
      const bad = m.repairs.unreconciled?.size || 0;
      row.unreconciled += bad;
      totals.warnings += bad;
    }
    const last = m.periods[m.periods.length - 1]?.date;
    if (last && (Date.now() - Date.parse(last)) / 864e5 > 450) row.stale++;
  }
  rows.push(row);
}

const pad = (v, n) => String(v).padStart(n);
console.log('MATRIX AUDIT — every stored company\n');
console.log(['market', 'cos', 'models', 'noModel', 'future', 'badQ', 'order', 'collide', 'outlier', 'calendar', 'repaired', 'annualOnly', 'unrecon', 'stale'].map((h, i) => i === 0 ? h.padEnd(7) : pad(h, 10)).join(''));
for (const r of rows) {
  console.log([r.market.padEnd(7), pad(r.companies, 10), pad(r.models, 10), pad(r.noModel, 10), pad(r.future, 10), pad(r.badQuarter, 10), pad(r.order, 10), pad(r.collisions, 10), pad(r.outliers, 10), pad(r.calendar, 10), pad(r.repaired, 10), pad(r.annualOnly, 10), pad(r.unreconciled, 10), pad(r.stale, 10)].join(''));
}
console.log(`\ntotal ${totals.companies} companies · ${totals.models} matrices · ${totals.critical} critical · ${totals.warnings} warnings\n`);
for (const r of rows) {
  for (const key of ['future', 'badQuarter', 'order', 'collisions', 'outliers', 'calendar', 'noModel']) {
    if (!r.examples[key].length) continue;
    console.log(`${r.market} ${key}: ${r.examples[key].slice(0, 5).join(' | ')}`);
  }
}

if (totals.critical || (strict && totals.warnings)) {
  console.error(`\nMATRIX AUDIT FAILED: ${totals.critical} critical${strict ? ` and ${totals.warnings} warning(s)` : ''}.`);
  process.exit(1);
}
console.log('MATRIX AUDIT PASSED — no future periods, no fractional/out-of-range quarters, no reversed cells.');
