// Audit the South Africa dataset: universe, secondary listings, caps, formulas, sectors and aggregates.
//
//   node scripts/audit-southafrica.mjs
//   node scripts/audit-southafrica.mjs --sample=30   also compare P/E and cap against the vendor page
//
// Read-only. Exits non-zero on a hard invariant.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDED, SECONDARY, isSecondary } from './jse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const za = read('southafrica.json');
const list = read('southafrica-list.json');
const snap = (() => { try { return read('southafrica-universe.json'); } catch { return null; } })();
const SAMPLE = Number((process.argv.find((x) => x.startsWith('--sample=')) || '').split('=')[1] || 0) || 0;

const fails = [];
const warn = [];
const say = (label, value) => console.log(`${label.padEnd(48)} ${value}`);

const byCode = new Map();
const dupes = [];
for (const c of za.companies) { if (byCode.has(c.code)) dupes.push(c.code); byCode.set(c.code, c); }
say('companies', za.companies.length);
say('duplicate codes', dupes.length);
if (dupes.length) fails.push(`duplicate codes: ${dupes.join(', ')}`);

const badCode = za.companies.filter((c) => !/^[A-Z0-9]{2,8}$/.test(c.code)).map((c) => c.code);
say('codes that are not valid JSE lines', badCode.length);
if (badCode.length) fails.push(`bad codes: ${badCode.slice(0, 10).join(', ')}`);

const primary = za.companies.filter((c) => !c.foreignSecondary);
const secondary = za.companies.filter((c) => c.foreignSecondary);
say('JSE-primary lines', primary.length);
say('foreign-secondary lines', secondary.length);
say('secondary outside the named map', secondary.filter((c) => !SECONDARY[c.code]).length);
if (secondary.some((c) => !SECONDARY[c.code])) fails.push(`unmapped foreign-secondary lines: ${secondary.filter((c) => !SECONDARY[c.code]).map((c) => c.code).join(', ')}`);
for (const c of secondary) {
  const s = SECONDARY[c.code];
  if (!s) continue;
  if (!c.secondarySource) fails.push(`${c.code}: secondary listing without a source`);
  if (!c.secondaryExchange) fails.push(`${c.code}: secondary listing without an exchange`);
}
const excludedInMarket = za.companies.filter((c) => EXCLUDED.has(c.code));
say('excluded codes that re-entered', excludedInMarket.length);
if (excludedInMarket.length) fails.push(`excluded codes in the market: ${excludedInMarket.map((c) => c.code).join(', ')}`);
const funds = za.companies.filter((c) => /\b(etf|exchange[ -]traded fund|collective investment)\b/i.test(c.name || ''));
say('funds/ETFs in the market (must be 0)', funds.length);
if (funds.length) fails.push(`funds in the market: ${funds.slice(0, 6).map((c) => c.code).join(', ')}`);

let badField = 0;
for (const c of za.companies) {
  if (!c.name || !c.nameEn) badField++;
  if (!c.sector) badField++;
  if (!(c.price > 0)) badField++;
  if (!c.reportCurrency) badField++;
  if (!(c.marketCap > 0)) badField++;
}
say('records missing name/sector/price/cap/currency', badField);
if (badField) fails.push(`${badField} records have a missing required field`);
say('descriptions', `${za.companies.filter((c) => c.description).length}/${za.companies.length}`);

// The vendor list cap is the company total in rand; it is the authority for every line, primary and
// secondary. A line whose cap is re-derived from price × shares is not the company cap.
const badCap = [];
let capCompared = 0;
for (const c of za.companies) {
  if (!(c.vendorCap > 0) || !(c.marketCap > 0)) continue;
  capCompared++;
  const gap = Math.abs(c.marketCap / c.vendorCap - 1);
  if (gap > 0.02) badCap.push(`${c.code} ${(gap * 100).toFixed(1)}%`);
}
say('cap = vendor headline cap (>2% off)', badCap.length);
if (badCap.length) fails.push(`caps do not reproduce the vendor headline: ${badCap.slice(0, 6).join(', ')}`);
say('caps compared', capCompared);

// The exchange list price is in cents; Yahoo's JSE unit is inconsistent, so the build calibrates each
// series to the list last price. This catches a unit mistake before it becomes a wrong return or chart.
const badPrice = [];
for (const c of za.companies) {
  if (!(c.vendorPrice > 0) || !(c.price > 0)) continue;
  const gap = Math.abs(c.price / (c.vendorPrice / 100) - 1);
  if (gap > 0.02) badPrice.push(`${c.code} ${c.price} vs ${(c.vendorPrice / 100).toFixed(2)}`);
}
say('price ≠ exchange-list price (>2%)', badPrice.length);
if (badPrice.length) fails.push(`prices do not match the exchange list: ${badPrice.slice(0, 8).join(', ')}`);

const off = (a, b, abs = 0) => a != null && b != null && b !== 0
  && Math.abs(a - b) > abs && Math.abs(a - b) / Math.abs(b) > 0.02;
const rates = (za.fx && za.fx.rates) || null;
const capReport = (c) => {
  if (!c.reportCurrency || c.reportCurrency === 'ZAR') return c.marketCap;
  if (!rates || !rates.ZAR || !rates[c.reportCurrency]) return null;
  return c.marketCap * (rates[c.reportCurrency] / rates.ZAR);
};
const badPe = [], badPb = [], badRoe = [];
for (const c of za.companies) {
  const r = c.reports || {};
  const ni = c.netIncomeTTM;
  const cap = capReport(c);
  if (c.pe != null && ni > 0 && cap != null && off(c.pe, cap / ni, 0.05)) badPe.push(`${c.code} ${c.pe} vs ${(cap / ni).toFixed(2)}`);
  const eq = r.latest && (r.latest.equityCommon ?? r.latest.equity);
  if (c.pb != null && eq > 0 && cap != null && off(c.pb, cap / eq, 0.03)) badPb.push(c.code);
  if (c.roe != null && eq > 0 && ni != null && Math.abs(c.roe - (ni / eq) * 100) > 0.5) badRoe.push(c.code);
}
say('P/E = cap ÷ TTM profit mismatches', badPe.length);
if (badPe.length) fails.push(`P/E does not reproduce: ${badPe.slice(0, 6).join(' · ')}`);
say('P/B = cap ÷ common equity mismatches', badPb.length);
if (badPb.length) fails.push(`P/B does not reproduce: ${badPb.slice(0, 6).join(', ')}`);
say('ROE = TTM profit ÷ equity mismatches', badRoe.length);
if (badRoe.length) fails.push(`ROE does not reproduce: ${badRoe.slice(0, 6).join(', ')}`);

const impossible = za.companies.filter((c) => (c.pe != null && c.pe <= 0) || (c.pb != null && c.pb <= 0)
  || (c.roe != null && Math.abs(c.roe) > 500) || (c.opMargin != null && Math.abs(c.opMargin) > 500));
say('ratios outside a physical range', impossible.length);
if (impossible.length) fails.push(`impossible ratios: ${impossible.slice(0, 6).map((c) => c.code).join(', ')}`);

const bankWithMargin = za.companies.filter((c) => c.bankLike && c.opMargin != null);
const finWithFcf = za.companies.filter((c) => c.financial && (c.fcf != null || c.fcfYield != null));
say('banks carrying an operating margin', bankWithMargin.length);
if (bankWithMargin.length) fails.push(`bank-like with an op margin: ${bankWithMargin.slice(0, 6).map((c) => c.code).join(', ')}`);
say('financials carrying free cash flow', finWithFcf.length);
if (finWithFcf.length) fails.push(`financials with FCF: ${finWithFcf.slice(0, 6).map((c) => c.code).join(', ')}`);
say('bank-like / financial companies', `${za.companies.filter((c) => c.bankLike).length} / ${za.companies.filter((c) => c.financial).length}`);

const total = za.companies.reduce((a, c) => a + (c.marketCap || 0), 0);
say('total cap = sum of constituents', `${(total / 1e12).toFixed(2)}T vs ${(za.market.totalCap / 1e12).toFixed(2)}T`);
if (Math.abs(total - za.market.totalCap) / Math.max(1, total) > 0.001) fails.push('market totalCap is not the sum of its constituents');
const sectorSum = (za.market.sectors || []).reduce((a, s) => a + s.count, 0);
say('sector rows cover every company', `${sectorSum} vs ${za.companies.length}`);
if (sectorSum !== za.companies.length) fails.push('sector partition does not cover the market');
say('market primary/secondary/listed', `${za.market.primary} / ${za.market.secondary} / ${za.market.listed}`);
if (za.market.primary !== primary.length) fails.push('market.primary is not the JSE-primary count');
if (za.market.secondary !== secondary.length) fails.push('market.secondary is not the foreign-secondary count');
if (za.market.listed !== za.companies.length) fails.push('market.listed is not the combined count');
if (za.market.companies !== za.companies.length) fails.push('market.companies is not the listed count');

say('FX snapshot', za.fx && za.fx.rate ? `USD/ZAR ${za.fx.rate}` : 'missing');
if (!(za.fx && za.fx.rate > 5)) fails.push('no FX snapshot');

const idx = za.index || {};
say('index', `${za.indexName || 'JSE All Share'} ${idx.level ?? '—'} as of ${idx.date || '—'}`);
if (!(idx.level > 0)) warn.push('index level missing');
if (!Array.isArray(idx.series) || idx.series.length < 100) warn.push('index series is short');
if (za.indexName !== 'JSE All Share') fails.push(`indexName is ${za.indexName}`);

const noTrade = za.companies.filter((c) => c.noRecentTrading);
const short = za.companies.filter((c) => c.shortHistory);
const ttmStale = za.companies.filter((c) => c.ttmStale);
const ttmBasis = za.companies.reduce((a, c) => { const k = c.peBasis || 'none'; a[k] = (a[k] || 0) + 1; return a; }, {});
const ttmBuild = za.companies.reduce((a, c) => { const k = c.ttmComputed || (c.peBasis === 'TTM' ? 'vendor column' : 'none'); a[k] = (a[k] || 0) + 1; return a; }, {});
const thin = za.companies.filter((c) => c.thinTrading);
say('no recent trading', `${noTrade.length}${noTrade.length ? ' · ' + noTrade.map((c) => c.code).join(', ') : ''}`);
say('short history (<100 sessions)', `${short.length}${short.length ? ' · ' + short.map((c) => c.code).join(', ') : ''}`);
say('P/E profit basis', `TTM ${ttmBasis.TTM || 0} · FY ${ttmBasis.FY || 0}${ttmBasis.FY ? ' · ' + za.companies.filter((c) => c.peBasis === 'FY').map((c) => c.code).join(', ') : ''}`);
say('TTM construction', Object.entries(ttmBuild).map(([k, v]) => `${k} ${v}`).join(' · '));
say('TTM older than 365 days', `${ttmStale.length}${ttmStale.length ? ' · ' + ttmStale.map((c) => c.code).join(', ') : ''}`);
say('thin trading (< R1M/day)', thin.length);
for (const c of noTrade) {
  if (!(c.flatPct >= 90)) fails.push(`${c.code}: no-trade with flat ${c.flatPct}%`);
  if (c.chg1d != null || c.chg6m != null || c.chgYtd != null) fails.push(`${c.code}: no-trade still publishes a return`);
}
for (const c of ttmStale) if (!(c.ttmAgeDays > 365)) fails.push(`${c.code}: stale TTM with ${c.ttmAgeDays} days`);
for (const c of thin) if (!(c.avgValue30 != null && c.avgValue30 < 1e6)) fails.push(`${c.code}: thin with ${c.avgValue30}`);

say('list companies', list.companies.length);
if (list.companies.length !== za.companies.length) fails.push('list projection length differs');
if (JSON.stringify(list.market) !== JSON.stringify(za.market)) fails.push('list market differs from the full file');
for (const k of ['sector', 'marketCap', 'pe', 'pb', 'roe', 'dividendYield', 'bands', 'chgYtd', 'priceDate', 'foreignSecondary']) {
  if (!(k in list.companies[0])) fails.push(`list projection is missing ${k}`);
}

if (snap) {
  say('universe snapshot lines', `${snap.count} · ${snap.excluded?.length ?? 0} excluded · ${snap.rows.filter((r) => isSecondary(r.code)).length} secondary`);
  if (snap.count !== 244) warn.push(`snapshot has ${snap.count} lines, expected 244`);
  const built = new Set(za.companies.map((c) => c.code));
  const missing = snap.rows.map((r) => r.code).filter((code) => !built.has(code));
  say('publishable lines missing', missing.length);
  if (missing.length) warn.push(`${missing.length} snapshot lines are not in the build: ${missing.slice(0, 8).join(', ')}`);
} else warn.push('no committed universe snapshot');

const vc = za.audit && za.audit.vendorCap;
if (vc) say('vendor cap compared / >10% off', `${vc.compared} / ${vc.over10pct}`);

if (SAMPLE) {
  const { getCached } = await import('./stockanalysis.mjs');
  const { sourceStats } = await import('./jse.mjs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(ROOT, 'data', 'cache', 'southafrica-audit'), { recursive: true });
  const sample = [...za.companies].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, SAMPLE);
  const stat = (html, id) => {
    const m = new RegExp(`\\{id:"${id}",[^}]*?hover:"([^"]+)"`).exec(html || '')
      || new RegExp(`\\{id:"${id}",[^}]*?value:"([^"]+)"`).exec(html || '');
    if (!m) return null;
    const n = Number(String(m[1]).replace(/[%$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  let cmp = 0, peOff = 0, dyOff = 0, capOff = 0;
  const peOut = [], capOut = [];
  for (const c of sample) {
    const f = join(ROOT, 'data', 'cache', 'southafrica-audit', `stats-${c.code}.json`);
    let html = null;
    try { html = await getCached(sourceStats(c.code), f, { ttlMs: 7 * 864e5, retries: 2 }); } catch { html = null; }
    if (!html) continue;
    const pe = stat(html, 'pe');
    const dy = stat(html, 'dividendYield');
    const vcap = stat(html, 'marketcap');
    if (pe != null && c.pe != null) { cmp++; if (Math.abs(c.pe - pe) / pe > 0.15) { peOff++; peOut.push(`${c.code} ${c.pe} vs ${pe}`); } }
    if (dy != null && c.dividendYield != null && Math.abs(c.dividendYield - dy) > 0.3) dyOff++;
    // The vendor statistics cap is in the primary listing's currency for a foreign-secondary line;
    // ours is the JSE list cap in rand. A raw comparison there is not a like-for-like check.
    if (!c.foreignSecondary && vcap && c.marketCap && Math.abs(c.marketCap - vcap) / vcap > 0.1) { capOff++; capOut.push(`${c.code} ${((Math.abs(c.marketCap - vcap) / vcap) * 100).toFixed(1)}%`); }
  }
  say('sample P/E compared / >15% off', `${cmp} / ${peOff}`);
  say('sample market cap >10% off', `${capOff}${capOut.length ? ' · ' + capOut.slice(0, 6).join(', ') : ''}`);
  say('sample yield >0.3pp off', dyOff);
  if (peOff) warn.push(`${peOff}/${cmp} sample P/E differ by >15% (${peOut.slice(0, 6).join(', ')}) — the vendor P/E can annualize or use its own cap; ours is the vendor cap over the trailing profit`);
  if (capOff) warn.push(`${capOff}/${sample.length} sample caps differ by >10%`);
}

console.log('\nWARNINGS');
for (const w of warn) console.log('  ! ' + w);
console.log('\nFAILURES');
for (const f of fails) console.log('  ✗ ' + f);
console.log(fails.length ? `\n${fails.length} hard failure(s)` : '\nall hard invariants pass');
process.exit(fails.length ? 1 : 0);
