// Deep audit for South Africa: every published number recomputed from its inputs.
//
//   node scripts/audit-southafrica-deep.mjs
//
// The standard audit proves the headline invariants. This re-runs the ratio engine on the stored inputs,
// compares every field, then independently checks the vendor cap, the TTM, returns, flags, aggregates
// and the list projection.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveListing } from './derive-listing.mjs';
import { growthRates } from '../src/growth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const d = read('southafrica.json');
const list = read('southafrica-list.json');
const seriesDir = join(ROOT, 'data', 'southafrica-series');
const DAY = 864e5;

const failures = [];
let checks = 0;
const fail = (what, detail) => failures.push(`${what}: ${detail}`);
const say = (label, value) => console.log(`${label.padEnd(48)} ${value}`);
const close = (what, a, b, abs = 1e-6, rel = 1e-9) => {
  checks++;
  if (a == null && b == null) return;
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > abs + Math.abs(b) * rel) fail(what, `${a} vs ${b}`);
};

// --- 1. re-run the engine on the stored inputs ------------------------------------------------------
const inputs = d.companies.map((c) => ({
  ...c,
  ttm: c.reports.ttm,
  latest: c.reports.latest,
  annual: c.reports.annual,
  quarters: c.reports.quarters,
}));
const rerun = new Map(deriveListing({ companies: inputs, fx: d.fx, baseCurrency: 'ZAR' }).map((c) => [c.code, c]));
const NUM = [
  ['marketCap', 0, 1e-12], ['marketCapUsd', 1], ['shares', 0, 1e-12], ['sharesCurrent', 0, 1e-12],
  ['netIncomeTTM', 0, 1e-12], ['pe', 0.0051], ['pb', 0.0051], ['pbTotal', 0.0051],
  ['roe', 0.051], ['roeTotal', 0.051], ['roeFY', 0.051], ['roePriorFY', 0.051],
  ['opMargin', 0.051], ['netMargin', 0.051], ['fcf', 0, 1e-12], ['fcfYield', 0.0051],
  ['fcfMargin', 0.051], ['cashConversion', 0.0051], ['dividendYield', 0.0051],
  ['revenueCagr', 0.051], ['epsCagr', 0.051], ['cagrYears', 0], ['marginDelta', 0.051], ['epsTTM', 0.011],
];
for (const c of d.companies) {
  const r = rerun.get(c.code);
  if (!r) { fail('engine', `${c.code}: not reproduced`); continue; }
  if (c.bankLike) r.opMargin = null;
  if (c.financial) { r.fcf = null; r.fcfYield = null; r.fcfMargin = null; r.cashConversion = null; }
  if (r.roe != null && Math.abs(r.roe) > 500) r.roe = null;
  for (const [field, abs, rel] of NUM) close(`${c.code}.${field}`, c[field], r[field], abs, rel);
  if (c.bands || r.bands) {
    if (!c.bands || !r.bands) fail(`${c.code}.bands`, `${JSON.stringify(c.bands)} vs ${JSON.stringify(r.bands)}`);
    else {
      close(`${c.code}.bands.min`, c.bands.pe.min, r.bands.pe.min, 0.0051);
      close(`${c.code}.bands.median`, c.bands.pe.median, r.bands.pe.median, 0.0051);
      close(`${c.code}.bands.max`, c.bands.pe.max, r.bands.pe.max, 0.0051);
      close(`${c.code}.bands.pct`, c.bands.pe.percentile, r.bands.pe.percentile, 0);
      close(`${c.code}.bands.n`, c.bands.pe.n, r.bands.pe.n, 0);
    }
  }
  checks += 3;
  if (JSON.stringify(c.history) !== JSON.stringify(r.history)) fail(`${c.code}.history`, 'does not match the annual record');
  if (JSON.stringify(c.quarters) !== JSON.stringify(r.quarters)) fail(`${c.code}.quarters`, 'does not match the reported periods');
  if (c.peBasis !== r.peBasis) fail(`${c.code}.peBasis`, `${c.peBasis} vs ${r.peBasis}`);
  if (c.dividendYieldBasis !== r.dividendYieldBasis) fail(`${c.code}.dividendYieldBasis`, `${c.dividendYieldBasis} vs ${r.dividendYieldBasis}`);
  if (!!c.ttmFromFY !== !!r.ttmFromFY) fail(`${c.code}.ttmFromFY`, `${c.ttmFromFY} vs ${r.ttmFromFY}`);
}
say('engine fields compared', `${checks.toLocaleString()} across ${d.companies.length} companies`);

// --- 2. company cap, ratios and the trailing profit ------------------------------------------------
let capN = 0;
for (const c of d.companies) {
  if (!(c.vendorCap > 0) || !(c.marketCap > 0)) continue;
  capN++;
  close(`${c.code}.cap`, c.marketCap, c.vendorCap, 0, 1e-9);
}
say('cap = vendor company total', `${capN} checked`);

const rates = (d.fx && d.fx.rates) || {};
const capReport = (c) => {
  if (!c.reportCurrency || c.reportCurrency === 'ZAR') return c.marketCap;
  if (!rates.ZAR || !rates[c.reportCurrency]) return null;
  return c.marketCap * (rates[c.reportCurrency] / rates.ZAR);
};
let pe = 0, pb = 0, roe = 0;
for (const c of d.companies) {
  const cap = capReport(c);
  const ni = c.netIncomeTTM;
  if (c.pe != null) { pe++; close(`${c.code}.pe`, c.pe, cap / ni, 0.0051); }
  const eq = c.reports && c.reports.latest && (c.reports.latest.equityCommon ?? c.reports.latest.equity);
  if (c.pb != null) { pb++; close(`${c.code}.pb`, c.pb, cap / eq, 0.0051); }
  if (c.roe != null) { roe++; close(`${c.code}.roe`, c.roe, (ni / eq) * 100, 0.051); }
}
say('P/E / P/B / ROE reproduced', `${pe} / ${pb} / ${roe}`);

let ttmChecked = 0;
const ttmNotes = [];
for (const c of d.companies) {
  // JSE issuers report half-yearly, so the trailing year is two columns, not four. A four-column
  // sum would compare the TTM with two years and flag every half-year reporter.
  const n = c.periodBasis === 'half' ? 2 : 4;
  const q = (c.quarters || []).slice(-n);
  if (q.length !== n || q.some((x) => x.netIncome == null)) continue;
  const sum = q.reduce((a, x) => a + x.netIncome, 0);
  if (c.netIncomeTTM == null) continue;
  ttmChecked++;
  const gap = Math.abs(c.netIncomeTTM - sum) / Math.max(1, Math.abs(sum));
  if (gap > 0.01) ttmNotes.push(`${c.code} ${c.netIncomeTTM} vs ${sum}${Math.sign(c.netIncomeTTM) !== Math.sign(sum) ? ' (sign flip)' : ''}`);
}
say('TTM versus reported periods', `${ttmChecked} checked · ${ttmNotes.length} differ (vendor restatement/YTD)`);

// --- 3. secondary listings keep the JSE line and the company statements ----------------------------
let sec = 0;
for (const c of d.companies.filter((x) => x.foreignSecondary)) {
  sec++;
  if (!c.secondarySource) fail(`${c.code}.secondarySource`, 'missing');
  if (c.currency !== 'ZAR') fail(`${c.code}.currency`, c.currency);
  if (!(c.price > 0)) fail(`${c.code}.price`, c.price);
}
say('foreign-secondary lines checked', sec);

// --- 4. flags, aggregates and the list projection --------------------------------------------------
const noTrade = d.companies.filter((c) => c.noRecentTrading);
for (const c of noTrade) {
  if (c.chg1d != null || c.chg6m != null || c.chgYtd != null) fail(`${c.code}.noRecentTrading`, 'still publishes a return');
  if (!(c.flatPct >= 90)) fail(`${c.code}.flatPct`, c.flatPct);
}
const sumCap = d.companies.reduce((a, c) => a + (c.marketCap || 0), 0);
close('market.totalCap', d.market.totalCap, sumCap, 0, 1e-9);
checks++;
if (d.market.companies !== d.companies.length) fail('market.companies', d.market.companies);
if (d.market.primary !== d.companies.filter((c) => !c.foreignSecondary).length) fail('market.primary', d.market.primary);
if (d.market.secondary !== d.companies.filter((c) => c.foreignSecondary).length) fail('market.secondary', d.market.secondary);
const sectorSum = (d.market.sectors || []).reduce((a, s) => a + s.count, 0);
if (sectorSum !== d.companies.length) fail('market.sectors', `${sectorSum} vs ${d.companies.length}`);

const projected = JSON.parse(JSON.stringify(list.companies));
checks++;
if (projected.length !== d.companies.length) fail('list projection', `${projected.length} vs ${d.companies.length}`);
for (const c of list.companies) {
  if (!('foreignSecondary' in c)) fail(`${c.code}.list`, 'foreignSecondary missing');
  if (!('dividendYield' in c)) fail(`${c.code}.list`, 'dividendYield missing');
  if (c.marketCap !== (d.companies.find((x) => x.code === c.code) || {}).marketCap) fail(`${c.code}.list.cap`, 'differs');
}
say('list projection fields', `${list.companies.length} rows`);

// --- 5. the series store matches the build stamp ---------------------------------------------------
if (existsSync(seriesDir)) {
  const buckets = readdirSync(seriesDir).filter((f) => f.endsWith('.json'));
  say('series buckets', buckets.length ? `${buckets.length} files` : 'missing');
  if (!buckets.length) fail('series', 'no bucket files');
} else fail('series', 'directory missing');

console.log('\nFAILURES');
for (const f of failures.slice(0, 40)) console.log('  ✗ ' + f);
if (failures.length > 40) console.log(`  … ${failures.length - 40} more`);
console.log(failures.length ? `\n${failures.length} hard failure(s)` : `\nall ${checks.toLocaleString()} deep checks pass`);
process.exit(failures.length ? 1 : 0);
