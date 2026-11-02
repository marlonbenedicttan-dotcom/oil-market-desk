// Audit the Taiwan dataset: universe, prices, formulas, aggregates and the exchange cross-check.
//
//   node scripts/audit-taiwan.mjs
//
// Read-only. Prints findings; exits non-zero if a hard invariant fails.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const tw = read('taiwan.json');
const list = read('taiwan-list.json');
const master = JSON.parse(JSON.parse(readFileSync(join(ROOT, 'data', 'cache', 'twse', 'master.json'), 'utf8')).text);
const val = JSON.parse(JSON.parse(readFileSync(join(ROOT, 'data', 'cache', 'twse', 'valuation.json'), 'utf8')).text);
const valBy = new Map(val.map((v) => [v.Code, v]));
const fmDir = join(ROOT, 'data', 'cache', 'taiwan-finmind');
const seriesOf = (code) => {
  const b = String(code)[0];
  const f = join(ROOT, 'data', 'taiwan-series', `${b}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
};
const seriesFor = (code) => { const s = seriesOf(code); return s ? { daily: s.daily[code] || [], weekly: s.weekly[code] || [] } : { daily: [], weekly: [] }; };

const fails = [];
const warn = [];
const say = (label, value) => console.log(`${label.padEnd(34)} ${value}`);

// --- universe ------------------------------------------------------------------------------------
const byCode = new Map();
const dupes = [];
for (const c of tw.companies) {
  if (byCode.has(c.code)) dupes.push(c.code);
  byCode.set(c.code, c);
}
say('companies', tw.companies.length);
say('duplicate codes', dupes.length);
if (dupes.length) fails.push(`duplicate codes: ${dupes.join(', ')}`);

const masterStocks = new Map(master.filter((m) => /^\d{4}$/.test(m['公司代號']) && !String(m['公司代號']).startsWith('91') && Number(m['已發行普通股數或TDR原股發行股數']) > 0)
  .map((m) => [m['公司代號'], m]));
const missing = [...masterStocks.keys()].filter((c) => !byCode.has(c));
say('master common stocks', masterStocks.size);
say('master not in dataset', missing.length);
if (missing.length) say('  missing', missing.slice(0, 10).map((c) => `${c} ${masterStocks.get(c)['公司簡稱']}`).join(' · '));
if (missing.length) warn.push(`${missing.length} master stocks have no current trade/price (absent rather than estimated)`);

let badField = 0;
for (const c of tw.companies) {
  if (!c.name || !c.nameEn) badField++;
  if (!c.sector) badField++;
  if (!(c.price > 0) || !(c.shares > 0)) badField++;
  if (!c.description) badField++;
}
say('records missing name/sector/price/shares/desc', badField);
if (badField) fails.push(`${badField} records have a missing required field`);

const noDesc = tw.companies.filter((c) => !c.description).length;
say('descriptions', `${tw.companies.length - noDesc}/${tw.companies.length}`);
if (noDesc) warn.push(`${noDesc} companies have no description`);

const noStmt = tw.companies.filter((c) => !c.reports || !c.reports.ttm || c.reports.ttm.revenue == null).length;
say('with a TTM statement row', tw.companies.length - noStmt);
if (noStmt) warn.push(`${noStmt} companies have no TTM statement row`);

// --- price / cap formulas -------------------------------------------------------------------------
let capBad = 0, priceBad = 0, seriesBad = 0, staleBad = 0;
const today = new Date().toISOString().slice(0, 10);
for (const c of tw.companies) {
  if (Math.abs(c.price * c.shares - c.marketCap) / c.marketCap > 1e-9) capBad++;
  const s = seriesFor(c.code);
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

// Stored moves vs recomputed from the series (daily last 400).
let moveBad = 0;
for (const c of tw.companies) {
  const s = seriesFor(c.code);
  const arr = s.daily.length ? s.daily : s.weekly;
  if (arr.length < 2) continue;
  const last = arr[arr.length - 1];
  const prev = arr[arr.length - 2];
  const one = +(((last.c / prev.c) - 1) * 100).toFixed(2);
  if (c.chg1d == null || Math.abs(one - c.chg1d) > 0.02) moveBad++;
}
say('chg1d not reproduced from series', moveBad);
if (moveBad) fails.push('chg1d differs from the series');

// --- ratio formulas ------------------------------------------------------------------------------
let peBad = 0, pbBad = 0, roeBad = 0, fcfBad = 0, marginBad = 0;
for (const c of tw.companies) {
  const r = c.reports || {};
  const ttm = r.ttm || {}, latest = r.latest || {};
  const eq = latest.equity;
  const ni = ttm.netIncome;
  if (c.pe != null) {
    const want = +(c.marketCap / ni).toFixed(2);
    if (!(ni > 0) || Math.abs(want - c.pe) > 0.011) peBad++;
  }
  if (c.pb != null) {
    const want = +(c.marketCap / eq).toFixed(2);
    if (!(eq > 0) || Math.abs(want - c.pb) > 0.011) pbBad++;
  }
  if (c.roe != null) {
    const want = (ni / eq) * 100;
    if (!(eq > 0) || Math.abs(want - c.roe) > 0.06) roeBad++;
  }
  if (c.fcf != null && ttm.operatingCashFlow != null && ttm.investingCashFlow != null) {
    const want = ttm.operatingCashFlow + ttm.investingCashFlow;
    if (Math.abs(want - c.fcf) > 2) fcfBad++;
  }
  if (c.opMargin != null && ttm.revenue && ttm.operatingProfit != null) {
    const want = (ttm.operatingProfit / ttm.revenue) * 100;
    if (Math.abs(want - c.opMargin) > 0.06) marginBad++;
  }
}
say('P/E formula mismatches', peBad);
say('P/B formula mismatches', pbBad);
say('ROE formula mismatches', roeBad);
say('FCF formula mismatches', fcfBad);
say('operating-margin mismatches', marginBad);
if (peBad || pbBad || roeBad || fcfBad || marginBad) fails.push('a formula does not reproduce');

// --- market aggregates ----------------------------------------------------------------------------
const median = (xs) => { const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2); };
const total = tw.companies.reduce((a, c) => a + c.marketCap, 0);
say('total cap', `${(total / 1e12).toFixed(2)}T (market ${(tw.market.totalCap / 1e12).toFixed(2)}T)`);
if (Math.abs(total - tw.market.totalCap) / total > 1e-9) fails.push('market total cap differs from the sum');
say('median P/E', `${median(tw.companies.map((c) => c.pe))} (market ${tw.market.medianPe})`);
say('median P/B', `${median(tw.companies.map((c) => c.pb))} (market ${tw.market.medianPb})`);
say('median ROE', `${median(tw.companies.map((c) => c.roe))} (market ${tw.market.medianRoe})`);
say('median yield', `${median(tw.companies.map((c) => c.dividendYield))} (market ${tw.market.medianYield})`);
say('below book', `${tw.companies.filter((c) => c.pb != null && c.pb < 1).length} (market ${tw.market.belowBook})`);
say('advancing / declining', `${tw.companies.filter((c) => (c.chg1d || 0) > 0).length} / ${tw.companies.filter((c) => (c.chg1d || 0) < 0).length} (market ${tw.market.advancing} / ${tw.market.declining})`);
const sectorSum = tw.market.sectors.reduce((a, s) => a + s.cap, 0);
say('sector caps sum', `${(sectorSum / 1e12).toFixed(2)}T`);
if (Math.abs(sectorSum - total) / total > 0.02) warn.push('sector caps do not sum to the market total');

// --- TAIEX ----------------------------------------------------------------------------------------
const idx = tw.index || {};
const is = idx.series || [];
let idxBad = 0;
for (let i = 1; i < is.length; i++) if (!(is[i].d > is[i - 1].d) || !(is[i].c > 0)) idxBad++;
say('TAIEX points', is.length);
say('TAIEX level / date', `${idx.level} / ${idx.date}`);
say('TAIEX series errors', idxBad);
if (idxBad) fails.push('TAIEX series has a duplicate/unsorted/non-positive point');
// Cap-weighted TSMC share of the covered market, the concentration the UI should state.
const tsmc = byCode.get('2330');
say('TSMC weight of covered cap', tsmc ? `${((tsmc.marketCap / total) * 100).toFixed(1)}%` : 'missing');

// --- exchange cross-check -------------------------------------------------------------------------
const cmp = [];
for (const c of tw.companies) {
  const v = valBy.get(c.code);
  if (!v) continue;
  const pe = Number(v.PEratio), pb = Number(v.PBratio), dy = Number(v.DividendYield);
  cmp.push({ code: c.code, name: c.nameEn, pe, pb, dy, c });
}
const finite = (x) => Number.isFinite(x) && x > 0;
const peOff = cmp.filter((x) => finite(x.pe) && finite(x.c.pe) && Math.abs(x.c.pe - x.pe) / x.pe > 0.15).length;
const pbOff = cmp.filter((x) => finite(x.pb) && finite(x.c.pb) && Math.abs(x.c.pb - x.pb) / x.pb > 0.15).length;
const peCmp = cmp.filter((x) => finite(x.pe) && finite(x.c.pe)).length;
const pbCmp = cmp.filter((x) => finite(x.pb) && finite(x.c.pb)).length;
say('TWSE P/E compared / >15% off', `${peCmp} / ${peOff}`);
say('TWSE P/B compared / >15% off', `${pbCmp} / ${pbOff}`);
const dyOff = cmp.filter((x) => finite(x.dy) && x.c.dividendYield != null && Math.abs(x.c.dividendYield - x.dy) > 0.2).length;
say('TWSE yield >0.2pp off', dyOff);

// --- split / source audit -------------------------------------------------------------------------
// Taiwan has a ±10% daily limit, so a single-day move beyond ±25% is a split, a capital reduction
// or a bad print — not a trade. Weekly +35% moves are real in the 2026 rally (five limit-ups), so
// only extreme weekly moves (>70% up / >45% down) are flagged there.
const fmCodes = new Set(tw.companies.filter((c) => c.priceSource === 'finmind').map((c) => c.code));
const dailyJumps = [], weeklyJumps = [];
for (const c of tw.companies) {
  const s = seriesFor(c.code);
  for (let i = 1; i < s.daily.length; i++) {
    if (i < 5) continue;                       // the first sessions after listing have no daily limit
    const r = s.daily[i].c / s.daily[i - 1].c;
    if (r > 1.25 || r < 0.75) dailyJumps.push({ code: c.code, d: s.daily[i].d, move: +((r - 1) * 100).toFixed(1), source: c.priceSource || '?' });
  }
  for (let i = 1; i < s.weekly.length; i++) {
    const r = s.weekly[i].c / s.weekly[i - 1].c;
    if (r > 1.7 || r < 0.55) weeklyJumps.push({ code: c.code, d: s.weekly[i].d, move: +((r - 1) * 100).toFixed(1), source: c.priceSource || '?' });
  }
}
say('Yahoo-sourced / FinMind fallback', `${tw.companies.length - fmCodes.size} / ${fmCodes.size}`);
say('single-day moves >25% (bad/split)', dailyJumps.length);
say('weekly extremes (>70% / <-45%)', weeklyJumps.length);
if (dailyJumps.length) {
  say('  daily examples', dailyJumps.slice(0, 8).map((j) => `${j.code} ${j.d} ${j.move}% (${j.source})`).join(' · '));
  warn.push(`${dailyJumps.length} single-day moves beyond the ±10% limit (split/capital reduction/bad print)`);
}
if (weeklyJumps.length) {
  say('  weekly examples', weeklyJumps.slice(0, 8).map((j) => `${j.code} ${j.d} ${j.move}% (${j.source})`).join(' · '));
  warn.push(`${weeklyJumps.length} weekly extremes that cannot be five limit moves`);
}

// --- list projection ------------------------------------------------------------------------------
say('list companies', list.companies.length);
const listPe = list.companies.filter((c) => c.pe != null).length;
say('list with P/E', listPe);
if (list.companies.length !== tw.companies.length) fails.push('list projection length differs');
if (JSON.stringify(list.market) !== JSON.stringify(tw.market)) fails.push('list market differs from the full file');

// --- verdict --------------------------------------------------------------------------------------
console.log('\nWARNINGS');
for (const w of warn) console.log('  ! ' + w);
console.log('\nFAILURES');
for (const f of fails) console.log('  ✗ ' + f);
console.log(fails.length ? `\n${fails.length} hard failure(s)` : '\nall hard invariants pass');
process.exit(fails.length ? 1 : 0);
