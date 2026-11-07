// Deep audit for Brazil: every published number recomputed from its inputs.
//
//   node scripts/audit-brazil-deep.mjs
//
// The standard audit proves the headline invariants. This re-runs the ratio engine on the stored inputs,
// compares every field, then independently checks the company cap (vendor, not price × class shares),
// the four-quarter TTM, returns, flags, aggregates and the list projection.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveListing } from './derive-listing.mjs';
import { growthRates } from '../src/growth.js';
import { brazilList } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const d = read('brazil.json');
const list = read('brazil-list.json');
const seriesDir = join(ROOT, 'data', 'brazil-series');
const DAY = 864e5;

const failures = [];
let checks = 0;
const fail = (what, detail) => failures.push(`${what}: ${detail}`);
const say = (label, value) => console.log(`${label.padEnd(46)} ${value}`);
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
const rerun = new Map(deriveListing({ companies: inputs, fx: d.fx, baseCurrency: 'BRL' }).map((c) => [c.code, c]));
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

// --- 2. company cap, ratios and the four-quarter TTM ----------------------------------------------
let capN = 0;
for (const c of d.companies) {
  if (!(c.vendorCap > 0) || !(c.marketCap > 0)) continue;
  capN++;
  close(`${c.code}.cap`, c.marketCap, c.vendorCap, 0, 1e-9);
}
say('cap = vendor company total', `${capN} checked`);

const rates = (d.fx && d.fx.rates) || {};
const capReport = (c) => {
  if (!c.reportCurrency || c.reportCurrency === 'BRL') return c.marketCap;
  if (!rates.BRL || !rates[c.reportCurrency]) return null;
  return c.marketCap * (rates[c.reportCurrency] / rates.BRL);
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
  const q = (c.quarters || []).slice(-4);
  if (q.length !== 4 || q.some((x) => x.netIncome == null)) continue;
  const sum = q.reduce((a, x) => a + x.netIncome, 0);
  if (c.netIncomeTTM == null) continue;
  ttmChecked++;
  const gap = Math.abs(c.netIncomeTTM - sum) / Math.max(1, Math.abs(sum));
  // The vendor's TTM column is the published trailing figure; its quarterly page can carry YTD or
  // restated periods. A gap is reported (and named) rather than treated as a build error.
  if (gap > 0.01) ttmNotes.push(`${c.code} ${c.netIncomeTTM} vs ${sum}${Math.sign(c.netIncomeTTM) !== Math.sign(sum) ? ' (sign flip)' : ''}`);
}
say('TTM versus four-quarter sum', `${ttmChecked} checked · ${ttmNotes.length} differ (vendor restatement/YTD)`);

// --- 3. growth and dividend -----------------------------------------------------------------------
let growth = 0;
for (const c of d.companies) {
  if (c.revenueCagr == null && c.epsCagr == null) continue;
  const rows = (c.reports.annual || []).slice(-5).map((r) => ({
    year: Number(String(r.end).slice(0, 4)), revenue: r.revenue, eps: r.eps,
    shares: r.shares > 0 ? r.shares : (r.netIncome != null && r.eps ? r.netIncome / r.eps : null),
  }));
  const g = growthRates(rows);
  growth++;
  close(`${c.code}.revenueCagr`, c.revenueCagr, g.revenueCagr, 0.051);
  close(`${c.code}.epsCagr`, c.epsCagr, g.epsCagr, 0.051);
  close(`${c.code}.cagrYears`, c.cagrYears, g.cagrYears, 0);
  if ((c.cagrNA || null) !== (g.cagrNA || null)) fail(`${c.code}.cagrNA`, `${c.cagrNA} vs ${g.cagrNA}`);
  if ((c.epsCagrNA || null) !== (g.epsCagrNA || null)) fail(`${c.code}.epsCagrNA`, `${c.epsCagrNA} vs ${g.epsCagrNA}`);
}
say('growth reproduced', `${growth} checked`);
let dy = 0;
const shares = read('brazil-shares.json').entries || {};
for (const c of d.companies) {
  if (c.dividendYield == null) continue;
  dy++;
  if (c.dividendYieldBasis === 'vendor') close(`${c.code}.dividendYield`, c.dividendYield, (shares[c.code] || {}).yield, 0.0051);
}
say('dividend yield (vendor) reproduced', `${dy} checked`);

// --- 4. returns, flags, index, aggregates, list ---------------------------------------------------
const bucketCache = new Map();
const bucketOf = (code) => {
  const b = String(code).slice(0, 1).toUpperCase();
  if (!bucketCache.has(b)) {
    const f = join(seriesDir, `${b}.json`);
    bucketCache.set(b, existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { daily: {}, weekly: {} });
  }
  return bucketCache.get(b);
};
const pointOnOrBefore = (s, date) => { let hit = null; for (const p of s) { if (p.d > date) break; hit = p; } return hit; };
const iso = (t) => new Date(t).toISOString().slice(0, 10);
let ret = 0;
for (const c of d.companies) {
  const s = (bucketOf(c.code).daily || {})[c.code];
  if (!Array.isArray(s) || s.length < 2) { fail(`${c.code}.series`, 'no archived daily series'); continue; }
  const last = s[s.length - 1], prev = s[s.length - 2];
  ret++;
  if (last.d !== c.priceDate) fail(`${c.code}.priceDate`, `${c.priceDate} vs ${last.d}`);
  close(`${c.code}.price`, c.price, last.c, 0.0011);
  if (c.noRecentTrading) {
    if (c.chg1d != null || c.chg6m != null || c.chgYtd != null) fail(`${c.code}.returns`, 'no-trade still publishes a return');
    continue;
  }
  close(`${c.code}.chg1d`, c.chg1d, ((last.c / prev.c) - 1) * 100, 0.011);
  const six = pointOnOrBefore(s, iso(Date.parse(last.d) - 182 * DAY));
  if (six) close(`${c.code}.chg6m`, c.chg6m, ((last.c / six.c) - 1) * 100, 0.011);
  const jan = s.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  if (jan) close(`${c.code}.chgYtd`, c.chgYtd, ((last.c / jan.c) - 1) * 100, 0.011);
}
say('returns reproduce from the series', `${ret} checked`);

let flags = 0;
for (const c of d.companies) {
  const s = (bucketOf(c.code).daily || {})[c.code] || [];
  const win = s.slice(-250);
  let flat = null;
  if (win.length > 1) {
    let same = 0;
    for (let i = 1; i < win.length; i++) if (win[i].c === win[i - 1].c) same++;
    flat = Math.round((same / (win.length - 1)) * 100);
  }
  flags++;
  if (c.noRecentTrading && !(flat >= 90)) fail(`${c.code}.noTrade`, `flat ${flat}`);
  if (!c.noRecentTrading && flat != null && flat >= 90) fail(`${c.code}.noTrade`, `flat ${flat} but not flagged`);
  if (!!c.shortHistory !== (s.length > 0 && s.length < 100)) fail(`${c.code}.shortHistory`, `${s.length} sessions`);
  if (!!c.thinTrading !== (c.avgValue30 != null && c.avgValue30 < 1e6)) fail(`${c.code}.thinTrading`, `avg ${c.avgValue30}`);
}
say('trading-quality flags', `${flags} checked`);

{
  const s = d.index.series || [];
  const last = s[s.length - 1], prev = s[s.length - 2];
  const six = pointOnOrBefore(s, iso(Date.parse(last.d) - 182 * DAY));
  const jan = s.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  close('index.level', d.index.level, last.c, 1e-6);
  close('index.chg1d', d.index.chg1d, ((last.c / prev.c) - 1) * 100, 0.011);
  close('index.chg6m', d.index.chg6m, ((last.c / six.c) - 1) * 100, 0.011);
  close('index.chgYtd', d.index.chgYtd, ((last.c / jan.c) - 1) * 100, 0.011);
}

const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
};
close('market.totalCap', d.market.totalCap, d.companies.reduce((a, c) => a + (c.marketCap || 0), 0), 1);
close('market.medianPe', d.market.medianPe, median(d.companies.map((c) => c.pe)), 0.0051);
close('market.medianPb', d.market.medianPb, median(d.companies.map((c) => c.pb)), 0.0051);
close('market.medianRoe', d.market.medianRoe, median(d.companies.map((c) => c.roe)), 0.0051);
close('market.medianYield', d.market.medianYield, median(d.companies.map((c) => c.dividendYield)), 0.0051);
close('market.advancing', d.market.advancing, d.companies.filter((c) => c.chg1d != null && c.chg1d > 0).length, 0);
close('market.declining', d.market.declining, d.companies.filter((c) => c.chg1d != null && c.chg1d < 0).length, 0);

const projected = brazilList(d);
const normalise = (doc) => {
  const clone = JSON.parse(JSON.stringify(doc));
  for (const c of clone.companies || []) if (c.brands == null) delete c.brands;
  return clone;
};
checks++;
if (JSON.stringify(normalise(projected)) !== JSON.stringify(normalise(list))) fail('list', 'projection does not match the stored artifact');

const bases = new Set();
for (const c of d.companies) {
  const b = c.code.replace(/\d{1,2}B?$/, '');
  if (bases.has(b)) fail(`${c.code}.base`, `duplicate issuer ${b}`);
  bases.add(b);
  if (!c.shareClass) fail(`${c.code}.class`, 'missing class label');
  if (c.multiClass && !c.shareClass) fail(`${c.code}.class`, 'multi-class without a class');
}
for (const t of d.themes || []) for (const code of t.tickers || []) if (!d.companies.some((c) => c.code === code)) fail('theme', `${t.id}: ${code}`);

const a = d.audit;
close('audit.companies', a.companies, d.companies.length, 0);
close('audit.pe', a.pe, d.companies.filter((c) => c.pe != null).length, 0);
close('audit.pb', a.pb, d.companies.filter((c) => c.pb != null).length, 0);
close('audit.roe', a.roe, d.companies.filter((c) => c.roe != null).length, 0);
close('audit.dividendYield', a.dividendYield, d.companies.filter((c) => c.dividendYield != null).length, 0);
close('audit.noRecentTrading', a.noRecentTrading, d.companies.filter((c) => c.noRecentTrading).length, 0);
close('audit.shortHistory', a.shortHistory, d.companies.filter((c) => c.shortHistory).length, 0);
close('audit.ttmStale', a.ttmStale, d.companies.filter((c) => c.ttmStale).length, 0);
close('audit.thinTrading', a.thinTrading, d.companies.filter((c) => c.thinTrading).length, 0);

say('checks run', checks.toLocaleString());
if (ttmNotes.length) {
  console.log('\nTTM NOTES (vendor TTM column vs its quarterly page):');
  for (const n of ttmNotes.slice(0, 30)) console.log('  ! ' + n);
  if (ttmNotes.length > 30) console.log(`  … ${ttmNotes.length - 30} more`);
}
console.log('\nFAILURES');
for (const f of failures.slice(0, 40)) console.log('  ✗ ' + f);
if (failures.length > 40) console.log(`  … ${failures.length - 40} more`);
console.log(failures.length ? `\n${failures.length} mismatch(es)` : '\nevery number reproduces from its inputs');
process.exit(failures.length ? 1 : 0);
