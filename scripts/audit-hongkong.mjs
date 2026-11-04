// Audit the Hong Kong dataset: universe, prices, formulas, currency handling and aggregates.
//
//   node scripts/audit-hongkong.mjs
//   node scripts/audit-hongkong.mjs --sample=40   also compare P/E and yield against stockanalysis
//
// Read-only. Prints findings; exits non-zero if a hard invariant fails.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCached } from './stockanalysis.mjs';
import { parseSaTable, rowOf } from './stockanalysis.mjs';
import { saPage } from './hkex.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const hk = read('hongkong.json');
const list = read('hongkong-list.json');
const SAMPLE = Number((process.argv.find((x) => x.startsWith('--sample=')) || '').split('=')[1] || 0) || 0;

const seriesOf = (code) => {
  const b = String(code).slice(0, 2);
  const f = join(ROOT, 'data', 'hongkong-series', `${b}.json`);
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
for (const c of hk.companies) {
  if (byCode.has(c.code)) dupes.push(c.code);
  byCode.set(c.code, c);
}
say('companies', hk.companies.length);
say('duplicate codes', dupes.length);
if (dupes.length) fails.push(`duplicate codes: ${dupes.join(', ')}`);

const badCode = hk.companies.filter((c) => !/^\d{4}$/.test(c.code)).map((c) => c.code);
say('codes that are not four digits', badCode.length);
if (badCode.length) fails.push(`bad codes: ${badCode.slice(0, 10).join(', ')}`);

let badField = 0;
for (const c of hk.companies) {
  if (!c.name || !c.nameEn) badField++;
  if (!c.sector) badField++;
  if (!(c.price > 0) || !(c.shares > 0)) badField++;
}
say('records missing name/sector/price/shares', badField);
if (badField) fails.push(`${badField} records have a missing required field`);

const noDesc = hk.companies.filter((c) => !c.description).length;
say('descriptions', `${hk.companies.length - noDesc}/${hk.companies.length}`);
if (noDesc) warn.push(`${noDesc} companies have no description`);

// A display name must not carry the other listing's code, and a 340-character summary must not stop
// in the middle of a segment list. Both are extractor regressions, not data gaps.
const tagged = hk.companies.filter((c) => /\s*\([A-Z]{2,6}:[A-Z0-9.]+\)\s*$/.test(c.nameEn || ''));
say('display names with a listing tag', tagged.length);
if (tagged.length) fails.push(`${tagged.length} display names carry a listing tag: ${tagged.slice(0, 8).map((c) => `${c.code} ${c.nameEn}`).join(', ')}`);
const profiles = (read('hongkong-profiles.json').entries || {});
const cutDesc = Object.entries(profiles).filter(([, p]) => p.desc && /;$/.test(p.desc));
say('summaries cut mid-list', cutDesc.length);
if (cutDesc.length) fails.push(`${cutDesc.length} summaries end on a semicolon: ${cutDesc.slice(0, 8).map(([k]) => k).join(', ')}`);

// A cross-list match is the one place a wrong company can enter quietly: the resolver matched
// "CHINA RAIL CONS" to China Construction Bank's ADR on 2026-11-02, and the same weakness hit China
// Southern/Eastern Air. The source name must agree with the exchange's own short name on the strong
// industry words, not just "China".
const cross = read('hongkong-crosslist.json').entries || {};
const conflicts = [];
for (const [code, e] of Object.entries(cross)) {
  const h = e.hkgName || '', src = e.sourceName || '';
  if (/\bAIR\b/.test(h) && !/\bAIR/i.test(src)) conflicts.push(`${code} ${h} → ${src}`);
  if (/\bBANK\b/.test(h) && !/\b(BANK|INSUR)/i.test(src)) conflicts.push(`${code} ${h} → ${src}`);
}
say('cross-list industry conflicts', conflicts.length);
if (conflicts.length) fails.push(`cross-list industry conflicts: ${conflicts.slice(0, 8).join('; ')}`);

const noStmt = hk.companies.filter((c) => !c.reports || !c.reports.ttm || c.reports.ttm.revenue == null).length;
say('with a TTM statement row', hk.companies.length - noStmt);
if (noStmt) warn.push(`${noStmt} companies have no TTM statement row`);

const ccy = {};
for (const c of hk.companies) ccy[c.reportCurrency] = (ccy[c.reportCurrency] || 0) + 1;
say('report currencies', Object.entries(ccy).map(([k, v]) => `${k} ${v}`).join(' · '));

// --- price / cap formulas -------------------------------------------------------------------------
const rates = (hk.fx && hk.fx.rates) || null;
const usdHkd = (hk.fx && hk.fx.rate) || null;
// The cap is HKD and must become the report currency; the dividend is the report currency and must
// become HKD. These are inverses — one rate cannot serve both.
const ccyPerHkd = (c) => (c === 'HKD' ? 1 : rates && rates.HKD && rates[c] ? rates[c] / rates.HKD : null);
const hkdPerCcy = (c) => (c === 'HKD' ? 1 : rates && rates.HKD && rates[c] ? rates.HKD / rates[c] : null);

let capBad = 0, priceBad = 0, seriesBad = 0, staleBad = 0;
const today = new Date().toISOString().slice(0, 10);
for (const c of hk.companies) {
  if (Math.abs(c.price * (c.sharesCurrent ?? c.shares) - c.marketCap) / c.marketCap > 1e-9) capBad++;
  const s = seriesOf(c.code);
  const arr = s.daily.length ? s.daily : s.weekly;
  if (!arr.length) { seriesBad++; continue; }
  const last = arr[arr.length - 1];
  if (Math.abs(last.c - c.price) > 0.02) priceBad++;
  if (c.priceDate !== last.d) priceBad++;
  for (let i = 1; i < arr.length; i++) if (!(arr[i].d > arr[i - 1].d)) { seriesBad++; break; }
  if (Date.parse(c.priceDate) < Date.parse(today) - 10 * 864e5) staleBad++;
}
say('market cap != price × current shares', capBad);
say('price/date != last close', priceBad);
say('series missing/unsorted', seriesBad);
say('prices older than 10 days', staleBad);
say('price session vs HKEX report', `${hk.session || '—'} (last close ${hk.companies[0] ? hk.companies[0].priceDate : '—'})`);
if (capBad || priceBad || seriesBad) fails.push('price/cap series inconsistency');

let moveBad = 0;
for (const c of hk.companies) {
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
for (const c of hk.companies) {
  const r = c.reports || {};
  const ttm = r.ttm || {}, latest = r.latest || {};
  // A company with no TTM column is valued on its last fiscal year — the derive already does that, so
  // the audit must compare against the same figure or it reports its own blind spot as a failure.
  const annual = (r.annual || []).filter((x) => x && x.end).sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const fy = annual[annual.length - 1] || null;
  const eq = latest.equityCommon ?? latest.equity ?? (fy ? (fy.equityCommon ?? fy.equity) : null);
  const ni = ttm.netIncome != null ? ttm.netIncome : (fy ? fy.netIncome : null);
  const conv = ccyPerHkd(c.reportCurrency || 'HKD');
  const dpsRate = hkdPerCcy(c.reportCurrency || 'HKD');
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
  if (c.fcf != null) {
    const cashT = c.fcfBasis === 'TTM';
    const fcfWant = cashT ? ttm.freeCashFlow : (fy ? fy.freeCashFlow : null);
    const cfo = cashT ? ttm.operatingCashFlow : (fy ? fy.operatingCashFlow : null);
    const capex = cashT ? ttm.capitalExpenditure : (fy ? fy.capitalExpenditure : null);
    const fallback = cfo != null && capex != null ? cfo - Math.abs(capex) : null;
    if (fcfWant != null ? Math.abs(fcfWant - c.fcf) > 2 : (fallback != null && Math.abs(fallback - c.fcf) > 2)) fcfBad++;
  }
  if (c.opMargin != null && ttm.revenue && ttm.operatingProfit != null) {
    if (Math.abs((ttm.operatingProfit / ttm.revenue) * 100 - c.opMargin) > 0.06) marginBad++;
  }
  const dps = fy && fy.dividendPerShare != null ? fy.dividendPerShare : ttm.dividendPerShare;
  if (c.dividendYield != null && dps != null && c.dividendYieldBasis !== 'vendor') {
    const want = +(((dps * dpsRate) / c.price) * 100).toFixed(2);
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

// --- market aggregates ----------------------------------------------------------------------------
const median = (xs) => { const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2); };
const total = hk.companies.reduce((a, c) => a + c.marketCap, 0);
say('total cap', `HK$${(total / 1e12).toFixed(2)}T (market ${(hk.market.totalCap / 1e12).toFixed(2)}T)`);
if (Math.abs(total - hk.market.totalCap) / total > 1e-9) fails.push('market total cap differs from the sum');
say('median P/E', `${median(hk.companies.map((c) => c.pe))} (market ${hk.market.medianPe})`);
say('median P/B', `${median(hk.companies.map((c) => c.pb))} (market ${hk.market.medianPb})`);
say('median ROE', `${median(hk.companies.map((c) => c.roe))} (market ${hk.market.medianRoe})`);
say('median yield', `${median(hk.companies.map((c) => c.dividendYield))} (market ${hk.market.medianYield})`);
say('below book', `${hk.companies.filter((c) => c.pb != null && c.pb < 1).length} (market ${hk.market.belowBook})`);
const sectorSum = hk.market.sectors.reduce((a, s) => a + s.cap, 0);
if (Math.abs(sectorSum - total) / total > 0.02) warn.push('sector caps do not sum to the market total');
say('sector caps sum', `HK$${(sectorSum / 1e12).toFixed(2)}T`);

// --- index ----------------------------------------------------------------------------------------
const idx = hk.index || {};
const is = idx.series || [];
let idxBad = 0;
for (let i = 1; i < is.length; i++) if (!(is[i].d > is[i - 1].d) || !(is[i].c > 0)) idxBad++;
say('HSI points', is.length);
say('HSI level / date', `${idx.level} / ${idx.date}`);
if (idxBad) fails.push('HSI series has a duplicate/unsorted/non-positive point');
const top = hk.companies[0];
say('largest company', `${top ? `${top.code} ${top.nameEn} ${(top.marketCap / 1e12).toFixed(2)}T` : '—'}`);

// --- audit counters written by the build ----------------------------------------------------------
const a = hk.audit || {};
say('HKEX lines quoted', a.quoted ?? '—');
say('main-board company lines', a.commonStocks ?? '—');
say('without a statement page', a.withoutStatements ?? '—');
say('small without a profile', a.incompleteSmall ?? 0);
say('throttled, not fetched this run', a.throttled ?? 0);
say('statements older than 450 days (excluded)', a.stale ?? 0);
say('current share counts (vendor or SEC)', `${a.currentShares ?? 0}/${hk.companies.length}`);
say('SEC cover counts', a.secShares ?? 0);
say('removed: no defensible current shares', a.unsourced ?? 0);
if (a.unsourced) warn.push(`${a.unsourced} companies have no vendor or SEC share count and are excluded (${(a.unsourcedCodes || []).map((x) => x.code).join(', ')})`);
if (a.stale) warn.push(`${a.stale} companies have statements older than 450 days and are excluded (${(a.staleCodes || []).map((x) => `${x.code} ${x.end}`).join(', ')})`);
if ((a.currentShares ?? 0) < hk.companies.length) warn.push(`${hk.companies.length - (a.currentShares ?? 0)} companies have no vendor or SEC share count; their cap uses the filing's total share count`);
if (a.withoutStatements) warn.push(`${a.withoutStatements} listed lines have no statement page (no share count, so no cap) — excluded rather than estimated`);
if (a.incompleteSmall) warn.push(`${a.incompleteSmall} small shells without a profile page are excluded (no description, sector or industry to show)`);
if (a.throttled) warn.push(`${a.throttled} companies were rate-limited and are NOT in this dataset — rerun build:hongkong to fill them (nothing was cached as missing)`);

// --- optional same-source cross-check -------------------------------------------------------------
// The statistics page is a different page from the statement tables the build parses, so it is an
// independent check of the ratios (and it carries the current share count).
const parseStat = (html, id) => {
  const m = new RegExp(`\\{id:"${id}",[^}]*?value:"([^"]+)"`).exec(html || '');
  if (!m) return null;
  const n = Number(String(m[1]).replace(/[%,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const parseShares = (html) => {
  const m = /has ([\d.,]+)\s*(thousand|million|billion|trillion) shares outstanding/i.exec(html || '');
  if (!m) return null;
  const mult = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }[m[2].toLowerCase()];
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && mult ? n * mult : null;
};
if (SAMPLE) {
  const sample = hk.companies.slice(0, SAMPLE);
  mkdirSync(join(ROOT, 'data', 'cache', 'hongkong-audit'), { recursive: true });
  let cmp = 0, peOff = 0, dyOff = 0, pbDiff = 0, pbPriceBasis = 0, roeDiff = 0, shCmp = 0, shOff = 0;
  for (const c of sample) {
    const f = join(ROOT, 'data', 'cache', 'hongkong-audit', `stats-${c.code}.json`);
    let html = null;
    const url = `https://stockanalysis.com/quote/hkg/${c.code}/statistics/`;
    try { html = await getCached(url, f, { ttlMs: 7 * 864e5, retries: 2 }); } catch { html = null; }
    if (!html) continue;
    const pe = parseStat(html, 'pe');
    const pb = parseStat(html, 'pb');
    const roe = parseStat(html, 'roe');
    const dy = parseStat(html, 'dividendYield');
    const sh = parseShares(html);
    const capM = /\{id:"marketcap",title:"Market Cap",value:"[^"]+",hover:"([\d,]+)"/.exec(html);
    const vcap = capM ? Number(capM[1].replace(/,/g, '')) : null;
    if (pe != null && c.pe != null) { cmp++; if (Math.abs(c.pe - pe) / pe > 0.15) peOff++; }
    const pbOurs = c.pbTotal ?? c.pb;
    const roeOurs = c.roeTotal ?? c.roe;
    if (pb != null && pbOurs != null) {
      // An A+H issuer's vendor cap uses the A-share price for every share; ours uses the H price.
      // Comparing P/B across those two caps is comparing two listings, not checking the equity.
      if (vcap && c.marketCap && Math.abs(c.marketCap - vcap) / vcap > 0.1) pbPriceBasis++;
      else if (Math.abs(pbOurs - pb) / pb > 0.15) pbDiff++;
    }
    if (roe != null && roeOurs != null) {
      // The vendor's ROE can be the prior fiscal year while ours is TTM; a match to our FY figure is
      // a period difference, not a formula error.
      const fyMatch = (c.roeFY != null && Math.abs(c.roeFY - roe) <= 3)
        || (c.roePriorFY != null && Math.abs(c.roePriorFY - roe) <= 3);
      if (!fyMatch && Math.abs(roeOurs - roe) > 3) roeDiff++;
    }
    if (dy != null && c.dividendYield != null && Math.abs(c.dividendYield - dy) > 0.3) dyOff++;
    if (sh > 0) {
      shCmp++;
      const ours = c.sharesCurrent ?? c.shares;
      if (ours > 0 && Math.abs(ours - sh) / sh > 0.05) shOff++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  say('sample P/E compared / >15% off', `${cmp} / ${peOff}`);
  say('sample P/B >15% from vendor (total equity)', pbDiff);
  say('sample P/B skipped (A+H price basis)', pbPriceBasis);
  say('sample ROE >3pp from vendor (total equity)', roeDiff);
  say('sample yield >0.3pp off', dyOff);
  say('sample shares compared / >5% off', `${shCmp} / ${shOff}`);
  if (!cmp) warn.push('the sample cross-check compared nothing — check the stats-page parser before trusting the sample');
  if (peOff) warn.push(`${peOff}/${cmp} sample P/E differ from stockanalysis's own statistics by >15% — check the price date or the trailing window`);
  if (dyOff) warn.push(`${dyOff} sample dividend yields differ from the vendor by >0.3pp — check the DPS period and, for a foreign reporter, the payment-date FX (this build converts at the current rate)`);
  if (shOff) warn.push(`${shOff}/${shCmp} sample market caps use a share count >5% from the vendor's current count`);
  if (pbDiff || roeDiff) warn.push(`${pbDiff} P/B and ${roeDiff} ROE values differ from the vendor even on the total-equity reconciliation — investigate (the vendor's ROE can be the prior fiscal year while ours is TTM)`);
}

// --- list projection ------------------------------------------------------------------------------
say('list companies', list.companies.length);
if (list.companies.length !== hk.companies.length) fails.push('list projection length differs');
if (JSON.stringify(list.market) !== JSON.stringify(hk.market)) fails.push('list market differs from the full file');

console.log('\nWARNINGS');
for (const w of warn) console.log('  ! ' + w);
console.log('\nFAILURES');
for (const f of fails) console.log('  ✗ ' + f);
console.log(fails.length ? `\n${fails.length} hard failure(s)` : '\nall hard invariants pass');
process.exit(fails.length ? 1 : 0);
