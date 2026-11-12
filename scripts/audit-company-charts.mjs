// Audit the per-company price charts against the range chips. The chart store is the local source of
// truth; a code missing from it may still be served by the live fallback, so it is reported separately.
//
//   node scripts/audit-company-charts.mjs
//
// The important invariant is `hiddenLong`: a company with at least one year of prices must not have a
// 5Y click silently replaced by a shorter window. That is the bug that made Quants Research (9552)
// fall back to 1Y on a 4.4-year series.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const WINDOWS = [['1m', 31], ['3m', 92], ['6m', 190], ['ytd', 0], ['1y', 366], ['5y', 1826], ['10y', 3653]];
const WINDOWS_5Y = WINDOWS.filter(([k]) => k !== '10y');
const MARKETS = [
  ['us', 'US', 'companies.json', 'us', true],
  ['japan', 'Japan', 'japan-companies', 'jp', false],
  ['korea', 'Korea', 'korea-companies', 'kr', false],
  ['taiwan', 'Taiwan', 'taiwan-companies', 'tw', false],
  ['hongkong', 'Hong Kong', 'hongkong-companies', 'hk', false],
  ['australia', 'Australia', 'australia-companies', 'au', false],
  ['india', 'India', 'india-companies', 'in', false],
  ['indonesia', 'Indonesia', 'indonesia-companies', 'id', false],
  ['brazil', 'Brazil', 'brazil-companies', 'br', false],
  ['southafrica', 'South Africa', 'southafrica-companies', 'za', false],
];

const companies = (source) => {
  if (source.endsWith('.json')) return read(join(DATA, source))?.companies || [];
  const dir = join(DATA, source);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => read(join(dir, f))).filter(Boolean);
};

// The chart store is one NDJSON line per company; only the line span is needed, not the prices.
const store = (mkt) => {
  const idx = read(join(DATA, 'charts', `${mkt}.idx.json`));
  if (!idx) return new Map();
  const file = join(DATA, 'charts', `${mkt}.ndjson`);
  const out = new Map();
  let all;
  try { all = readFileSync(file); } catch { return out; }
  for (const [key, [offset, length]] of Object.entries(idx.keys || {})) {
    try {
      const line = JSON.parse(all.subarray(offset, offset + length).toString('utf8'));
      const points = line.p || [];
      if (!points.length) continue;
      const first = idx.dates[points[0][0]];
      const last = idx.dates[points[points.length - 1][0]];
      out.set(key, { n: points.length, first, last, span: Math.round((Date.parse(last) - Date.parse(first)) / 864e5) });
    } catch { /* skip a corrupt line */ }
  }
  return out;
};

// Mirrors public/app.js coFitRange. A 5Y selection stays 5Y once the line spans a year; 10Y falls to
// 5Y when it cannot cover ten years.
const fitRange = (span, range) => {
  const wins = WINDOWS.filter(([k, d]) => k === 'ytd' || span >= d * 0.9).map(([k]) => k);
  if (wins.includes(range)) return range;
  if (range === '5y' && span >= 365) return '5y';
  if (range === '10y' && span >= 365) return '10y';
  return wins[wins.length - 1] || '1y';
};

const report = { updated: new Date().toISOString(), markets: {}, issues: [] };
for (const [id, label, source, mkt, ten] of MARKETS) {
  const charts = store(mkt);
  const ranges = ten ? WINDOWS : WINDOWS_5Y;
  const stat = { companies: 0, charted: 0, noLocalChart: 0, short: 0, hiddenLong: 0, tenFallback: 0 };
  const seen = new Set();
  for (const c of companies(source)) {
    const companyId = c.ticker || c.code;
    if (!companyId || seen.has(companyId)) continue;
    seen.add(companyId);
    stat.companies++;
    const keys = [c.code, c.ticker, String(c.code || '').padStart(5, '0'), String(c.ticker || '').padStart(4, '0')].filter(Boolean);
    const s = keys.map((k) => charts.get(k)).find(Boolean);
    if (!s) { stat.noLocalChart++; if (report.issues.length < 80) report.issues.push({ market: id, id: companyId, issue: 'no local chart (fallback may still answer)' }); continue; }
    stat.charted++;
    if (s.n < 2) { stat.short++; continue; }
    const used = ranges.map(([range]) => [range, fitRange(s.span, range)]);
    for (const [range, fit] of used) {
      if (range !== fit && (range === '5y' || range === '10y')) {
        if (s.span >= 365) {
          if (range === '5y') { stat.hiddenLong++; if (report.issues.length < 80) report.issues.push({ market: id, id: companyId, issue: `5y fell back to ${fit}`, spanDays: s.span }); }
          else if (fit !== '5y') { stat.tenFallback++; }
        }
      }
    }
  }
  report.markets[id] = stat;
  console.log(`${label.padEnd(12)} companies ${String(stat.companies).padStart(5)} · charted ${String(stat.charted).padStart(5)} · no local chart ${String(stat.noLocalChart).padStart(4)} · short ${String(stat.short).padStart(3)} · hidden 5Y ${String(stat.hiddenLong).padStart(3)} · 10Y fallback ${String(stat.tenFallback).padStart(3)}`);
}
report.totals = Object.values(report.markets).reduce((a, s) => {
  for (const k of ['companies', 'charted', 'noLocalChart', 'short', 'hiddenLong', 'tenFallback']) a[k] = (a[k] || 0) + s[k];
  return a;
}, {});
writeFileSync(join(DATA, 'audit-company-charts.json'), JSON.stringify(report));
console.log(`\n${report.totals.companies} companies · ${report.totals.charted} charted · ${report.totals.hiddenLong} hidden long windows · ${report.totals.noLocalChart} without a local chart`);
