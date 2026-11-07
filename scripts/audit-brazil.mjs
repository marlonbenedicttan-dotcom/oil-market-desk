// Audit the Brazil dataset: universe, class selection, caps, formulas, sectors and aggregates.
//
//   node scripts/audit-brazil.mjs
//   node scripts/audit-brazil.mjs --sample=30   also compare P/E and cap against the vendor statistics
//
// Read-only. Exits non-zero on a hard invariant.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBdrs } from './b3.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const br = read('brazil.json');
const list = read('brazil-list.json');
const snap = (() => { try { return read('brazil-universe.json'); } catch { return null; } })();
const SAMPLE = Number((process.argv.find((x) => x.startsWith('--sample=')) || '').split('=')[1] || 0) || 0;

const fails = [];
const warn = [];
const say = (label, value) => console.log(`${label.padEnd(46)} ${value}`);

const byCode = new Map();
const dupes = [];
for (const c of br.companies) { if (byCode.has(c.code)) dupes.push(c.code); byCode.set(c.code, c); }
say('companies', br.companies.length);
say('duplicate codes', dupes.length);
if (dupes.length) fails.push(`duplicate codes: ${dupes.join(', ')}`);

const badCode = br.companies.filter((c) => !/^[A-Z0-9]{4,7}$/.test(c.code)).map((c) => c.code);
say('codes that are not valid B3 lines', badCode.length);
if (badCode.length) fails.push(`bad codes: ${badCode.slice(0, 10).join(', ')}`);
const domestic = br.companies.filter((c) => !c.bdr);
const bdr = br.companies.filter((c) => c.bdr);
const allow = readBdrs();
const allowCodes = new Set((allow.bdrs || []).map((b) => b.code));
say('domestic companies', domestic.length);
say('BDRs in the market', bdr.length);
say('BDRs outside the allowlist', bdr.filter((c) => !allowCodes.has(c.code)).length);
const strayBdr = br.companies.filter((c) => /3[1-9]$/.test(c.code) && !c.bdr);
if (strayBdr.length) fails.push(`unmarked BDRs in the domestic market: ${strayBdr.slice(0, 6).map((c) => c.code).join(', ')}`);
if (bdr.some((c) => !allowCodes.has(c.code))) fails.push(`BDRs outside the curated allowlist: ${bdr.filter((c) => !allowCodes.has(c.code)).slice(0, 6).map((c) => c.code).join(', ')}`);
const funds = br.companies.filter((c) => /\b(fundo|fii|fiagro|fidc|etf)\b/i.test(c.name || ''));
say('funds in the market (must be 0)', funds.length);
if (funds.length) fails.push(`funds in the market: ${funds.slice(0, 6).map((c) => c.code).join(', ')}`);

// One class per domestic issuer: the base is the code without its class suffix. BDRs use their own
// code identity (`bdr:CODE`), because a BDR and a domestic subsidiary can share a base (JBSS32/JBSS3).
const baseOf = (code) => String(code).replace(/\d{1,2}B?$/, '');
const bases = new Map();
const multiBases = [];
for (const c of domestic) {
  const b = baseOf(c.code);
  if (bases.has(b)) multiBases.push(`${b}: ${bases.get(b)},${c.code}`);
  else bases.set(b, c.code);
}
say('domestic issuer base codes', bases.size);
say('duplicate domestic issuer bases', multiBases.length);
if (multiBases.length) fails.push(`duplicate domestic issuer classes: ${multiBases.slice(0, 6).join(' · ')}`);
const bdrCodes = new Set();
for (const c of bdr) {
  if (bdrCodes.has(c.code)) fails.push(`duplicate BDR code: ${c.code}`);
  bdrCodes.add(c.code);
  if (!c.bdrUnderlying) fails.push(`${c.code}: BDR without an underlying`);
}
say('multi-class issuers (one class kept)', domestic.filter((c) => c.multiClass).length);

let badField = 0;
for (const c of br.companies) {
  if (!c.name || !c.nameEn) badField++;
  if (!c.sector) badField++;
  if (!(c.price > 0)) badField++;
  if (!c.reportCurrency) badField++;
  if (!(c.marketCap > 0)) badField++;
}
say('records missing name/sector/price/cap/currency', badField);
if (badField) fails.push(`${badField} records have a missing required field`);
say('descriptions', `${br.companies.filter((c) => c.description).length}/${br.companies.length}`);

// The vendor list cap is the COMPANY total, repeated on each class; it is the authority for B3. The
// price × class shares product is not the company cap and must not be asserted.
const badCap = [];
const capGap = [];
for (const c of br.companies) {
  if (!(c.vendorCap > 0) || !(c.marketCap > 0)) continue;
  const gap = Math.abs(c.marketCap / c.vendorCap - 1);
  if (gap > 0.02) badCap.push(`${c.code} ${(gap * 100).toFixed(1)}%`);
  if (gap > 0.1) capGap.push(`${c.code} ${(gap * 100).toFixed(1)}%`);
}
say('company cap ≠ vendor headline cap (>2%)', badCap.length);
if (badCap.length) fails.push(`caps do not reproduce the vendor headline: ${badCap.slice(0, 6).join(', ')}`);

const off = (a, b, abs = 0) => a != null && b != null && b !== 0
  && Math.abs(a - b) > abs && Math.abs(a - b) / Math.abs(b) > 0.02;
const rates = (br.fx && br.fx.rates) || null;
const capReport = (c) => {
  if (!c.reportCurrency || c.reportCurrency === 'BRL') return c.marketCap;
  if (!rates || !rates.BRL || !rates[c.reportCurrency]) return null;
  return c.marketCap * (rates[c.reportCurrency] / rates.BRL);
};
const badPe = [], badPb = [], badRoe = [];
for (const c of br.companies) {
  const r = c.reports || {};
  const ni = c.netIncomeTTM;
  if (c.pe != null && ni > 0) {
    const cap = capReport(c);
    const want = cap != null ? cap / ni : null;
    if (off(c.pe, want, 0.05)) badPe.push(`${c.code} ${c.pe} vs ${want.toFixed(2)}`);
  }
  const eq = r.latest && (r.latest.equityCommon ?? r.latest.equity);
  const capP = capReport(c);
  if (c.pb != null && eq > 0 && capP != null && off(c.pb, capP / eq, 0.03)) badPb.push(c.code);
  if (c.roe != null && eq > 0 && ni != null && Math.abs(c.roe - (ni / eq) * 100) > 0.5) badRoe.push(c.code);
}
say('P/E = cap ÷ TTM profit mismatches', badPe.length);
if (badPe.length) fails.push(`P/E does not reproduce: ${badPe.slice(0, 6).join(' · ')}`);
say('P/B = cap ÷ common equity mismatches', badPb.length);
if (badPb.length) fails.push(`P/B does not reproduce: ${badPb.slice(0, 6).join(', ')}`);
say('ROE = TTM profit ÷ equity mismatches', badRoe.length);
if (badRoe.length) fails.push(`ROE does not reproduce: ${badRoe.slice(0, 6).join(', ')}`);

const impossible = br.companies.filter((c) => (c.pe != null && c.pe <= 0) || (c.pb != null && c.pb <= 0)
  || (c.roe != null && Math.abs(c.roe) > 500) || (c.opMargin != null && Math.abs(c.opMargin) > 500));
say('ratios outside a physical range', impossible.length);
if (impossible.length) fails.push(`impossible ratios: ${impossible.slice(0, 6).map((c) => c.code).join(', ')}`);

const bankWithMargin = br.companies.filter((c) => c.bankLike && c.opMargin != null);
const finWithFcf = br.companies.filter((c) => c.financial && (c.fcf != null || c.fcfYield != null));
say('banks carrying an operating margin', bankWithMargin.length);
if (bankWithMargin.length) fails.push(`bank-like with an op margin: ${bankWithMargin.slice(0, 6).map((c) => c.code).join(', ')}`);
say('financials carrying free cash flow', finWithFcf.length);
if (finWithFcf.length) fails.push(`financials with FCF: ${finWithFcf.slice(0, 6).map((c) => c.code).join(', ')}`);
say('without a share count (excluded)', `${br.audit.withoutShares ?? '—'}`);
say('bank-like / financial companies', `${br.companies.filter((c) => c.bankLike).length} / ${br.companies.filter((c) => c.financial).length}`);

const total = domestic.reduce((a, c) => a + (c.marketCap || 0), 0);
say('total cap = sum of constituents', `${(total / 1e12).toFixed(1)}T vs ${(br.market.totalCap / 1e12).toFixed(1)}T`);
if (Math.abs(total - br.market.totalCap) / Math.max(1, total) > 0.001) fails.push('market totalCap is not the sum of its constituents');
const sectorSum = (br.market.sectors || []).reduce((a, s) => a + s.count, 0);
say('sector rows cover every domestic company', `${sectorSum} vs ${domestic.length}`);
if (sectorSum !== domestic.length) fails.push('domestic sector partition does not cover the domestic market');
say('market domestic/listed/BDRs', `${br.market.companies} / ${br.market.listed} / ${br.market.bdrs}`);
if (br.market.companies !== domestic.length) fails.push('market.companies is not the domestic count');
if (br.market.bdrs !== bdr.length) fails.push('market.bdrs is not the BDR count');
if (br.market.listed !== br.companies.length) fails.push('market.listed is not the combined count');

say('FX snapshot', br.fx && br.fx.rate ? `USD/BRL ${br.fx.rate}` : 'missing');
if (!(br.fx && br.fx.rate > 0)) fails.push('no FX snapshot');

const idx = br.index || {};
say('index', `${br.indexName || 'Ibovespa'} ${idx.level ?? '—'} as of ${idx.date || '—'}`);
if (!(idx.level > 0)) warn.push('index level missing');
if (!Array.isArray(idx.series) || idx.series.length < 100) warn.push('index series is short');

const noTrade = domestic.filter((c) => c.noRecentTrading);
const short = domestic.filter((c) => c.shortHistory);
const ttmStale = domestic.filter((c) => c.ttmStale);
const thin = domestic.filter((c) => c.thinTrading);
const bdrNoTrade = bdr.filter((c) => c.noRecentTrading);
const bdrShort = bdr.filter((c) => c.shortHistory);
const bdrStale = bdr.filter((c) => c.ttmStale);
const bdrThin = bdr.filter((c) => c.thinTrading);
say('BDR no-trade / short / stale / thin', `${bdrNoTrade.length} / ${bdrShort.length} / ${bdrStale.length} / ${bdrThin.length}`);
say('no recent trading', `${noTrade.length}${noTrade.length ? ' · ' + noTrade.map((c) => c.code).join(', ') : ''}`);
say('short history (<100 sessions)', `${short.length}${short.length ? ' · ' + short.map((c) => c.code).join(', ') : ''}`);
say('TTM older than 365 days', `${ttmStale.length}${ttmStale.length ? ' · ' + ttmStale.map((c) => c.code).join(', ') : ''}`);
say('thin trading (< R$1M/day)', thin.length);
for (const c of noTrade) {
  if (!(c.flatPct >= 90)) fails.push(`${c.code}: no-trade with flat ${c.flatPct}%`);
  if (c.chg1d != null || c.chg6m != null || c.chgYtd != null) fails.push(`${c.code}: no-trade still publishes a return`);
}
for (const c of ttmStale) if (!(c.ttmAgeDays > 365)) fails.push(`${c.code}: stale TTM with ${c.ttmAgeDays} days`);
for (const c of thin) if (!(c.avgValue30 != null && c.avgValue30 < 1e6)) fails.push(`${c.code}: thin with ${c.avgValue30}`);

say('list companies', list.companies.length);
if (list.companies.length !== br.companies.length) fails.push('list projection length differs');
if (JSON.stringify(list.market) !== JSON.stringify(br.market)) fails.push('list market differs from the full file');

if (snap) {
  say('universe snapshot lines', `${snap.count} · ${snap.excludedBdr || 0} BDRs · ${snap.excludedFunds || 0} funds`);
  const builtBases = new Set(br.companies.map((c) => baseOf(c.code)));
  const snapBases = [...new Set((snap.rows || []).map((r) => baseOf(r.code)))];
  const missing = snapBases.filter((b) => !builtBases.has(b));
  say('publishable issuer bases missing', missing.length);
  if (missing.length) warn.push(`${missing.length} issuer bases are not in the build: ${missing.slice(0, 8).join(', ')} (stale/no share count)`);
} else warn.push('no committed universe snapshot');

const vc = br.audit && br.audit.vendorCap;
if (vc) say('vendor cap compared / >10% off', `${vc.compared} / ${vc.over10pct}`);

if (SAMPLE) {
  const { getCached } = await import('./stockanalysis.mjs');
  const { mkdirSync } = await import('node:fs');
  const { saSlug } = await import('./b3.mjs');
  mkdirSync(join(ROOT, 'data', 'cache', 'brazil-audit'), { recursive: true });
  const sample = [...domestic].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, SAMPLE);
  const stat = (html, id) => {
    const m = new RegExp(`\\{id:"${id}",[^}]*?(?:hover|value):"([^"]+)"`).exec(html);
    if (!m) return null;
    const n = Number(String(m[1]).replace('%', '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  let cmp = 0, peOff = 0, capOff = 0, dyOff = 0;
  const peOut = [], capOut = [];
  for (const c of sample) {
    const f = join(ROOT, 'data', 'cache', 'brazil-audit', `stats-${saSlug(c.code)}.json`);
    let html = null;
    try { html = await getCached(`https://stockanalysis.com/quote/bvmf/${saSlug(c.code)}/statistics/`, f, { ttlMs: 7 * 864e5, retries: 2 }); } catch { html = null; }
    if (!html) continue;
    const pe = stat(html, 'pe'), dy = stat(html, 'dividendYield');
    const capM = /\{id:"marketcap",[^}]*hover:"([\d,]+)"/.exec(html);
    const vcap = capM ? Number(capM[1].replace(/,/g, '')) : null;
    if (pe != null && c.pe != null) { cmp++; if (Math.abs(c.pe - pe) / pe > 0.15) { peOff++; peOut.push(`${c.code} ${c.pe} vs ${pe}`); } }
    if (dy != null && c.dividendYield != null && Math.abs(c.dividendYield - dy) > 0.3) dyOff++;
    if (vcap && c.marketCap && Math.abs(c.marketCap - vcap) / vcap > 0.1) { capOff++; capOut.push(`${c.code} ${((Math.abs(c.marketCap - vcap) / vcap) * 100).toFixed(1)}%`); }
  }
  say('sample P/E compared / >15% off', `${cmp} / ${peOff}`);
  say('sample market cap >10% off', `${capOff}${capOut.length ? ' · ' + capOut.slice(0, 6).join(', ') : ''}`);
  say('sample yield >0.3pp off', dyOff);
  if (peOff) warn.push(`${peOff}/${cmp} sample P/E differ by >15% (${peOut.slice(0, 6).join(', ')}) — the vendor statistics P/E can annualize or normalize the latest quarter; ours is the sum of the last four quarters`);
  if (capOff) warn.push(`${capOff}/${sample.length} sample caps differ by >10%`);
}

console.log('\nWARNINGS');
for (const w of warn) console.log('  ! ' + w);
console.log('\nFAILURES');
for (const f of fails) console.log('  ✗ ' + f);
console.log(fails.length ? `\n${fails.length} hard failure(s)` : '\nall hard invariants pass');
process.exit(fails.length ? 1 : 0);
