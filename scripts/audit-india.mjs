// Audit the India dataset: universe, prices, formulas, sector handling and aggregates.
//
//   node scripts/audit-india.mjs
//   node scripts/audit-india.mjs --sample=40   also compare P/E against the vendor's statistics
//
// Read-only. Prints findings; exits non-zero if a hard invariant fails.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const ind = read('india.json');
const list = read('india-list.json');

const fails = [];
const warn = [];
const say = (label, value) => console.log(`${label.padEnd(42)} ${value}`);

// --- universe -------------------------------------------------------------------------------------
const byCode = new Map();
const dupes = [];
for (const c of ind.companies) {
  if (byCode.has(c.code)) dupes.push(c.code);
  byCode.set(c.code, c);
}
say('companies', ind.companies.length);
say('duplicate codes', dupes.length);
if (dupes.length) fails.push(`duplicate codes: ${dupes.join(', ')}`);

const badCode = ind.companies.filter((c) => !/^[A-Z0-9&-]{1,20}$/.test(c.code)).map((c) => c.code);
say('codes that are not valid NSE symbols', badCode.length);
if (badCode.length) fails.push(`bad codes: ${badCode.slice(0, 10).join(', ')}`);

let badField = 0;
for (const c of ind.companies) {
  if (!c.name || !c.nameEn) badField++;
  if (!c.sector) badField++;
  if (!(c.price > 0) || !(c.shares > 0)) badField++;
  if (!c.reportCurrency) badField++;
}
say('records missing name/sector/price/shares/currency', badField);
if (badField) fails.push(`${badField} records have a missing required field`);

const noDesc = ind.companies.filter((c) => !c.description).length;
say('descriptions', `${ind.companies.length - noDesc}/${ind.companies.length}`);
if (noDesc) warn.push(`${noDesc} companies have no description`);

// A statement older than 450 days means a whole reporting year was missed. India reports April–March,
// so the window has to allow a March year-end whose next annual report is not due yet.
const now = Date.parse(ind.session || ind.updated);
const stale = ind.companies.filter((c) => {
  const end = c.reports && c.reports.ttmEnd;
  return end && Number.isFinite(now) && (now - Date.parse(end)) / 864e5 > 450;
});
say('statements older than 450 days', stale.length);
if (stale.length) warn.push(`${stale.length} companies ship a statement older than 450 days (${stale.slice(0, 5).map((c) => c.code).join(', ')})`);

// --- formulas -------------------------------------------------------------------------------------
const badCap = [];
for (const c of ind.companies) {
  const shares = c.sharesCurrent > 0 ? c.sharesCurrent : c.shares;
  if (!(c.price > 0) || !(shares > 0)) continue;
  const cap = c.price * shares;
  if (!(c.marketCap > 0) || Math.abs(c.marketCap / cap - 1) > 0.02) badCap.push(c.code);
}
say('market cap ≠ price × shares', badCap.length);
if (badCap.length) fails.push(`${badCap.length} caps do not reproduce (${badCap.slice(0, 6).join(', ')})`);

const off = (a, b, abs = 0) => a != null && b != null && b !== 0
  && Math.abs(a - b) > abs && Math.abs(a - b) / Math.abs(b) > 0.02;

// Two NIFTY names (Infosys, HCL Tech) file their statements in USD on the NSE page. The published
// ratios are computed in that currency, so the audit must convert the rupee cap before comparing —
// otherwise a correct P/E of 14.7 looks like 1,390.
const rates = (ind.fx && ind.fx.rates) || null;
const capReport = (c) => {
  if (!c.reportCurrency || c.reportCurrency === 'INR') return c.marketCap;
  if (!rates || !rates.INR || !rates[c.reportCurrency]) return null;
  return c.marketCap * (rates[c.reportCurrency] / rates.INR);
};

const badPe = [], badPb = [], badRoe = [];
for (const c of ind.companies) {
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

const impossible = ind.companies.filter((c) => (c.pe != null && c.pe <= 0) || (c.pb != null && c.pb <= 0)
  || (c.roe != null && Math.abs(c.roe) > 500) || (c.opMargin != null && Math.abs(c.opMargin) > 100));
say('ratios outside a physical range', impossible.length);
if (impossible.length) fails.push(`impossible ratios: ${impossible.slice(0, 6).map((c) => c.code).join(', ')}`);

// A bank must not carry an operating margin or a free-cash-flow ratio; an insurer keeps the margin and
// loses FCF. This is the rule the US, Japan, Hong Kong and Australia pages follow.
const bankWithMargin = ind.companies.filter((c) => c.bankLike && c.opMargin != null);
const finWithFcf = ind.companies.filter((c) => c.financial && (c.fcf != null || c.fcfYield != null));
say('banks carrying an operating margin', bankWithMargin.length);
if (bankWithMargin.length) fails.push(`bank-like companies with an op margin: ${bankWithMargin.slice(0, 6).map((c) => c.code).join(', ')}`);
say('financials carrying free cash flow', finWithFcf.length);
if (finWithFcf.length) fails.push(`financials with FCF: ${finWithFcf.slice(0, 6).map((c) => c.code).join(', ')}`);
say('bank-like / financial companies', `${ind.companies.filter((c) => c.bankLike).length} / ${ind.companies.filter((c) => c.financial).length}`);

// --- aggregates -----------------------------------------------------------------------------------
const total = ind.companies.reduce((a, c) => a + (c.marketCap || 0), 0);
say('total cap = sum of constituents', `${Math.round(total / 1e9)}B vs ${Math.round(ind.market.totalCap / 1e9)}B`);
if (Math.abs(total - ind.market.totalCap) / Math.max(1, total) > 0.001) fails.push('market totalCap is not the sum of its constituents');

const sectorSum = (ind.market.sectors || []).reduce((a, s) => a + s.count, 0);
say('sector rows cover every company', `${sectorSum} vs ${ind.companies.length}`);
if (sectorSum !== ind.companies.length) fails.push('sector partition does not cover the market');

// --- FX -------------------------------------------------------------------------------------------
say('FX snapshot', ind.fx && ind.fx.rate ? `USD/INR ${ind.fx.rate}` : 'missing');
if (!(ind.fx && ind.fx.rate > 0)) fails.push('no FX snapshot: every ratio would be blank');

// --- index ----------------------------------------------------------------------------------------
const idx = ind.index || {};
say('index', `${ind.indexName || 'NIFTY 50'} ${idx.level ?? '—'} as of ${idx.date || '—'}`);
if (!(idx.level > 0)) warn.push('index level missing');
if (!Array.isArray(idx.series) || idx.series.length < 100) warn.push('index series is short');

// --- list projection ------------------------------------------------------------------------------
say('list companies', list.companies.length);
if (list.companies.length !== ind.companies.length) fails.push('list projection length differs');
if (JSON.stringify(list.market) !== JSON.stringify(ind.market)) fails.push('list market differs from the full file');

console.log('\nWARNINGS');
for (const w of warn) console.log('  ! ' + w);
console.log('\nFAILURES');
for (const f of fails) console.log('  ✗ ' + f);
console.log(fails.length ? `\n${fails.length} hard failure(s)` : '\nall hard invariants pass');
process.exit(fails.length ? 1 : 0);
