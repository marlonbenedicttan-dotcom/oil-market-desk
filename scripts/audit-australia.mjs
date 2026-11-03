// Audit the Australia dataset: universe, prices, formulas, currency handling and aggregates.
//
//   node scripts/audit-australia.mjs
//   node scripts/audit-australia.mjs --sample=40   also compare P/E and yield against stockanalysis
//
// Read-only. Prints findings; exits non-zero if a hard invariant fails.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCached, parseSaTable, rowOf } from './stockanalysis.mjs';
import { saPage } from './asx.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const au = read('australia.json');
const list = read('australia-list.json');
const SAMPLE = Number((process.argv.find((x) => x.startsWith('--sample=')) || '').split('=')[1] || 0) || 0;

const seriesOf = (code) => {
  const b = String(code).slice(0, 1).toUpperCase();
  const f = join(ROOT, 'data', 'australia-series', `${b}.json`);
  if (!existsSync(f)) return { daily: [], weekly: [] };
  try {
    const s = JSON.parse(readFileSync(f, 'utf8'));
    return { daily: s.daily[code] || [], weekly: s.weekly[code] || [] };
  } catch { return { daily: [], weekly: [] }; }
};

const fails = [];
const warn = [];
const say = (label, value) => console.log(`${label.padEnd(38)} ${value}`);

// --- universe ------------------------------------------------------------------------------------
const byCode = new Map();
const dupes = [];
for (const c of au.companies) {
  if (byCode.has(c.code)) dupes.push(c.code);
  byCode.set(c.code, c);
}
say('companies', au.companies.length);
say('duplicate codes', dupes.length);
if (dupes.length) fails.push(`duplicate codes: ${dupes.join(', ')}`);

const badCode = au.companies.filter((c) => !/^[A-Z0-9]{3}$/.test(c.code)).map((c) => c.code);
say('codes that are not three characters', badCode.length);
if (badCode.length) fails.push(`bad codes: ${badCode.slice(0, 10).join(', ')}`);

let badField = 0;
for (const c of au.companies) {
  if (!c.name || !c.nameEn) badField++;
  if (!c.sector) badField++;
  if (!(c.price > 0) || !(c.shares > 0)) badField++;
  if (!c.reportCurrency) badField++;
}
say('records missing name/sector/price/shares/currency', badField);
if (badField) fails.push(`${badField} records have a missing required field`);

const noDesc = au.companies.filter((c) => !c.description).length;
say('descriptions', `${au.companies.length - noDesc}/${au.companies.length}`);
if (noDesc) warn.push(`${noDesc} companies have no description`);

const noStmt = au.companies.filter((c) => !c.reports || !c.reports.ttm || c.reports.ttm.revenue == null).length;
say('with a TTM statement row', au.companies.length - noStmt);
if (noStmt) warn.push(`${noStmt} companies have no TTM statement row`);

const ccy = {};
for (const c of au.companies) ccy[c.reportCurrency] = (ccy[c.reportCurrency] || 0) + 1;
say('report currencies', Object.entries(ccy).map(([k, v]) => `${k} ${v}`).join(' · '));

const sectorSource = {};
for (const c of au.companies) sectorSource[c.sectorSource || 'unknown'] = (sectorSource[c.sectorSource || 'unknown'] || 0) + 1;
say('sector sources', Object.entries(sectorSource).map(([k, v]) => `${k} ${v}`).join(' · '));
const notApplic = au.companies.filter((c) => c.sector === 'Not Applic').length;
say('unresolved "Not Applic" sectors', notApplic);
if (notApplic) fails.push(`${notApplic} companies still show the raw "Not Applic" value`);

// --- price / cap formulas -------------------------------------------------------------------------
const rates = (au.fx && au.fx.rates) || null;
const usdAud = (au.fx && au.fx.rate) || null;
// The cap is AUD and must become the report currency; the dividend is the report currency and must
// become AUD. These are inverses — one rate cannot serve both.
const ccyPerAud = (c) => (c === 'AUD' ? 1 : rates && rates.AUD && rates[c] ? rates[c] / rates.AUD : null);
const audPerCcy = (c) => (c === 'AUD' ? 1 : rates && rates.AUD && rates[c] ? rates.AUD / rates[c] : null);

let capBad = 0, priceBad = 0, seriesBad = 0, staleBad = 0;
const today = new Date().toISOString().slice(0, 10);
for (const c of au.companies) {
  if (Math.abs(c.price * c.shares - c.marketCap) / c.marketCap > 1e-9) capBad++;
  const s = seriesOf(c.code);
  const arr = s.daily.length ? s.daily : s.weekly;
  if (!arr.length) { seriesBad++; continue; }
  const last = arr[arr.length - 1];
  if (Math.abs(last.c - c.price) > 0.02) priceBad++;
  if (c.priceDate !== last.d) priceBad++;
  for (let i = 1; i < arr.length; i++) if (!(arr[i].d > arr[i - 1].d)) { seriesBad++; break; }
  if (Date.parse(c.priceDate) < Date.parse(today) - 10 * 864e5) staleBad++;
}
say('market cap != price × shares', capBad);
say('price/date != last close', priceBad);
say('series missing/unsorted', seriesBad);
say('prices older than 10 days', staleBad);
if (capBad || priceBad || seriesBad) fails.push('price/cap series inconsistency');

let moveBad = 0;
for (const c of au.companies) {
  const s = seriesOf(c.code);
  const arr = s.daily.length ? s.daily : s.weekly;
  if (arr.length < 2) continue;
  const one = +(((arr[arr.length - 1].c / arr[arr.length - 2].c) - 1) * 100).toFixed(2);
  if (c.chg1d == null || Math.abs(one - c.chg1d) > 0.02) moveBad++;
}
say('chg1d not reproduced from series', moveBad);
if (moveBad) fails.push('chg1d differs from the series');

// --- ratio formulas ------------------------------------------------------------------------------
let peBad = 0, pbBad = 0, roeBad = 0, fcfBad = 0, marginBad = 0, yldBad = 0, fxSkipped = 0;
for (const c of au.companies) {
  const r = c.reports || {};
  const ttm = r.ttm || {}, latest = r.latest || {};
  const eq = latest.equity;
  const ni = ttm.netIncome;
  const conv = ccyPerAud(c.reportCurrency || 'AUD');
  const dpsRate = audPerCcy(c.reportCurrency || 'AUD');
  const capRep = conv != null ? c.marketCap * conv : null;
  if (conv == null) { fxSkipped++; continue; }
  if (c.pe != null) {
    const want = +(capRep / ni).toFixed(2);
    if (!(ni > 0) || Math.abs(want - c.pe) > 0.011) peBad++;
  }
  if (c.pb != null) {
    const want = +(capRep / eq).toFixed(2);
    if (!(eq > 0) || Math.abs(want - c.pb) > 0.011) pbBad++;
  }
  if (c.roe != null) {
    const want = (ni / eq) * 100;
    if (!(eq > 0) || Math.abs(want - c.roe) > 0.06) roeBad++;
  }
  if (c.fcf != null && ttm.operatingCashFlow != null && ttm.investingCashFlow != null) {
    if (Math.abs(ttm.operatingCashFlow + ttm.investingCashFlow - c.fcf) > 2) fcfBad++;
  }
  if (c.opMargin != null && ttm.revenue && ttm.operatingProfit != null) {
    if (Math.abs((ttm.operatingProfit / ttm.revenue) * 100 - c.opMargin) > 0.06) marginBad++;
  }
  if (c.dividendYield != null && ttm.dividendPerShare != null) {
    const want = +(((ttm.dividendPerShare * dpsRate) / c.price) * 100).toFixed(2);
    if (Math.abs(want - c.dividendYield) > 0.06) yldBad++;
  }
}
say('P/E formula mismatches', peBad);
say('P/B formula mismatches', pbBad);
say('ROE formula mismatches', roeBad);
say('FCF formula mismatches', fcfBad);
say('operating-margin mismatches', marginBad);
say('dividend-yield mismatches', yldBad);
if (fxSkipped) say('skipped for a missing FX rate', fxSkipped);
if (peBad || pbBad || roeBad || fcfBad || marginBad || yldBad) fails.push('a formula does not reproduce');

// The ten largest names must carry P/B and ROE, and a P/E whenever the company actually earned money
// over the trailing year. A loss-maker with a blank P/E is correct data, not a failed fetch.
if (au.companies.length >= 100) {
  const top10 = au.companies.slice(0, 10);
  const topMissing = top10
    .filter((c) => c.pb == null || c.roe == null || (c.pe == null && (c.reports?.ttm?.netIncome ?? 0) > 0))
    .map((c) => c.code);
  say('top 10 missing a ratio they should have', topMissing.length ? topMissing.join(', ') : 'none');
  if (topMissing.length) fails.push(`the ten largest names are incomplete: ${topMissing.join(', ')}`);
}

// --- market aggregates ----------------------------------------------------------------------------
const median = (xs) => { const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2); };
const total = au.companies.reduce((a, c) => a + c.marketCap, 0);
say('total cap', `A$${(total / 1e12).toFixed(2)}T (market ${(au.market.totalCap / 1e12).toFixed(2)}T)`);
if (Math.abs(total - au.market.totalCap) / total > 1e-9) fails.push('market total cap differs from the sum');
say('median P/E', `${median(au.companies.map((c) => c.pe))} (market ${au.market.medianPe})`);
say('median P/B', `${median(au.companies.map((c) => c.pb))} (market ${au.market.medianPb})`);
say('median ROE', `${median(au.companies.map((c) => c.roe))} (market ${au.market.medianRoe})`);
say('median yield', `${median(au.companies.map((c) => c.dividendYield))} (market ${au.market.medianYield})`);
say('below book', `${au.companies.filter((c) => c.pb != null && c.pb < 1).length} (market ${au.market.belowBook})`);
const sectorSum = au.market.sectors.reduce((a, s) => a + s.cap, 0);
if (Math.abs(sectorSum - total) / total > 0.02) warn.push('sector caps do not sum to the market total');
say('sector caps sum', `A$${(sectorSum / 1e12).toFixed(2)}T`);

// --- index ----------------------------------------------------------------------------------------
const idx = au.index || {};
const is = idx.series || [];
let idxBad = 0;
for (let i = 1; i < is.length; i++) if (!(is[i].d > is[i - 1].d) || !(is[i].c > 0)) idxBad++;
say('ASX 200 points', is.length);
say('ASX 200 level / date', `${idx.level} / ${idx.date}`);
if (idxBad) fails.push('ASX 200 series has a duplicate/unsorted/non-positive point');
const top = au.companies[0];
say('largest company', `${top ? `${top.code} ${top.nameEn} ${(top.marketCap / 1e12).toFixed(2)}T` : '—'}`);

// --- audit counters written by the build ----------------------------------------------------------
const a = au.audit || {};
say('CSV listed companies', a.quoted ?? '—');
say('ETFs/funds/trusts excluded', a.excludedNonCompanies ?? '—');
say('three-character companies', a.companies ?? '—');
say('without a statement page', a.withoutStatements ?? '—');
say('without a price', a.withoutPrice ?? '—');
say('throttled, not fetched this run', a.throttled ?? 0);
say('"Not Applic" rows resolved', `${a.notApplicSectors ?? 0} (${a.resolvedFromProfile ?? 0} from the profile)`);
if (a.classPending) say('"Class Pend" rows resolved', a.classPending);
if (a.withoutStatements) warn.push(`${a.withoutStatements} listed companies have no statement page (no share count, so no cap) — excluded rather than estimated`);
if (a.withoutPrice) warn.push(`${a.withoutPrice} companies have no Yahoo price — excluded rather than estimated`);
if (a.throttled) warn.push(`${a.throttled} companies were rate-limited and are NOT in this dataset — rerun build:australia to fill them (nothing was cached as missing)`);

// --- optional same-source cross-check -------------------------------------------------------------
if (SAMPLE) {
  const sample = au.companies.slice(0, SAMPLE);
  let cmp = 0, peOff = 0, dyOff = 0;
  for (const c of sample) {
    const f = join(ROOT, 'data', 'cache', 'australia-audit', `${c.code}.json`);
    let html = null;
    try { html = await getCached(saPage(c.code, ''), f, { ttlMs: 7 * 864e5, retries: 2 }); } catch { html = null; }
    if (!html) continue;
    const t = parseSaTable(html);
    const peRow = rowOf(t, ['PE Ratio']);
    const dyRow = rowOf(t, ['Dividend Yield']);
    const col = t.cols.find((x) => x.id === 'TTM') || t.cols[0];
    if (!col) continue;
    const pe = peRow && peRow.values[col.id];
    const dy = dyRow && dyRow.values[col.id];
    if (pe != null && c.pe != null) { cmp++; if (Math.abs(c.pe - pe) / pe > 0.15) peOff++; }
    if (dy != null && c.dividendYield != null && Math.abs(c.dividendYield - dy) > 0.3) dyOff++;
    await new Promise((r) => setTimeout(r, 250));
  }
  say('sample P/E compared / >15% off', `${cmp} / ${peOff}`);
  say('sample yield >0.3pp off', dyOff);
  if (peOff) warn.push(`${peOff}/${cmp} sample P/E differ from stockanalysis's own overview by >15% — the same source computing a different trailing window`);
}

// --- list projection ------------------------------------------------------------------------------
say('list companies', list.companies.length);
if (list.companies.length !== au.companies.length) fails.push('list projection length differs');
if (JSON.stringify(list.market) !== JSON.stringify(au.market)) fails.push('list market differs from the full file');

console.log('\nWARNINGS');
for (const w of warn) console.log('  ! ' + w);
console.log('\nFAILURES');
for (const f of fails) console.log('  ✗ ' + f);
console.log(fails.length ? `\n${fails.length} hard failure(s)` : '\nall hard invariants pass');
process.exit(fails.length ? 1 : 0);
