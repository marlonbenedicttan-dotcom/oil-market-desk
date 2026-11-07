// Audit the Indonesia dataset: universe, prices, formulas, sector handling and aggregates.
//
//   node scripts/audit-indonesia.mjs
//   node scripts/audit-indonesia.mjs --sample=40   also compare P/E against the vendor's statistics
//
// Read-only. Prints findings; exits non-zero if a hard invariant fails.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const ind = read('indonesia.json');
const list = read('indonesia-list.json');
const snap = (() => { try { return read('indonesia-universe.json'); } catch { return null; } })();

const SAMPLE = Number((process.argv.find((x) => x.startsWith('--sample=')) || '').split('=')[1] || 0) || 0;

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

const badCode = ind.companies.filter((c) => !/^[A-Z0-9]{4}$/.test(c.code)).map((c) => c.code);
say('codes that are not valid IDX symbols', badCode.length);
if (badCode.length) fails.push(`bad codes: ${badCode.slice(0, 10).join(', ')}`);

let badField = 0;
for (const c of ind.companies) {
  if (!c.name || !c.nameEn) badField++;
  if (!c.sector) badField++;
  if (!(c.price > 0) || !(c.shares > 0 || c.sharesCurrent > 0)) badField++;
  if (!c.reportCurrency) badField++;
}
say('records missing name/sector/price/shares/currency', badField);
if (badField) fails.push(`${badField} records have a missing required field`);

const noDesc = ind.companies.filter((c) => !c.description).length;
say('descriptions', `${ind.companies.length - noDesc}/${ind.companies.length}`);
if (noDesc) warn.push(`${noDesc} companies have no description`);

// A statement older than 450 days means a whole reporting year was missed.
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

// Some IDX issuers report outside IDR (usually a USD-reporting subsidiary). The published ratios are
// computed in that currency, so the audit converts the rupiah cap before comparing.
const rates = (ind.fx && ind.fx.rates) || null;
const capReport = (c) => {
  if (!c.reportCurrency || c.reportCurrency === 'IDR') return c.marketCap;
  if (!rates || !rates.IDR || !rates[c.reportCurrency]) return null;
  return c.marketCap * (rates[c.reportCurrency] / rates.IDR);
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
  || (c.roe != null && Math.abs(c.roe) > 500) || (c.opMargin != null && Math.abs(c.opMargin) > 500));
say('ratios outside a physical range', impossible.length);
if (impossible.length) fails.push(`impossible ratios: ${impossible.slice(0, 6).map((c) => c.code).join(', ')}`);

// A bank must not carry an operating margin or a free-cash-flow ratio; an insurer keeps the margin and
// loses FCF. This is the rule the US, Japan, Hong Kong, Australia and India pages follow.
const bankWithMargin = ind.companies.filter((c) => c.bankLike && c.opMargin != null);
const finWithFcf = ind.companies.filter((c) => c.financial && (c.fcf != null || c.fcfYield != null));
say('banks carrying an operating margin', bankWithMargin.length);
if (bankWithMargin.length) fails.push(`bank-like companies with an op margin: ${bankWithMargin.slice(0, 6).map((c) => c.code).join(', ')}`);
say('financials carrying free cash flow', finWithFcf.length);
if (finWithFcf.length) fails.push(`financials with FCF: ${finWithFcf.slice(0, 6).map((c) => c.code).join(', ')}`);
say('bank-like / financial companies', `${ind.companies.filter((c) => c.bankLike).length} / ${ind.companies.filter((c) => c.financial).length}`);

// --- aggregates -----------------------------------------------------------------------------------
const total = ind.companies.reduce((a, c) => a + (c.marketCap || 0), 0);
say('total cap = sum of constituents', `${Math.round(total / 1e12)}T vs ${Math.round(ind.market.totalCap / 1e12)}T`);
if (Math.abs(total - ind.market.totalCap) / Math.max(1, total) > 0.001) fails.push('market totalCap is not the sum of its constituents');

const sectorSum = (ind.market.sectors || []).reduce((a, s) => a + s.count, 0);
say('sector rows cover every company', `${sectorSum} vs ${ind.companies.length}`);
if (sectorSum !== ind.companies.length) fails.push('sector partition does not cover the market');

// --- FX -------------------------------------------------------------------------------------------
say('FX snapshot', ind.fx && ind.fx.rate ? `USD/IDR ${ind.fx.rate}` : 'missing');
if (!(ind.fx && ind.fx.rate > 0)) fails.push('no FX snapshot: every ratio would be blank');

// --- index ----------------------------------------------------------------------------------------
const idx = ind.index || {};
say('index', `${ind.indexName || 'IDX Composite'} ${idx.level ?? '—'} as of ${idx.date || '—'}`);
if (!(idx.level > 0)) warn.push('index level missing');
if (!Array.isArray(idx.series) || idx.series.length < 100) warn.push('index series is short');

// --- list projection ------------------------------------------------------------------------------
say('list companies', list.companies.length);
if (list.companies.length !== ind.companies.length) fails.push('list projection length differs');
if (JSON.stringify(list.market) !== JSON.stringify(ind.market)) fails.push('list market differs from the full file');

// --- universe snapshot ----------------------------------------------------------------------------
// The committed list is what a failed vendor fetch falls back to. If it disagrees with the built market
// by more than a few names, the snapshot is stale and the next live run should replace it.
if (snap) {
  say('universe snapshot rows', snap.count);
  const built = new Set(ind.companies.map((c) => c.code));
  const inSnap = (snap.rows || []).filter((r) => built.has(r.code)).length;
  const share = snap.count ? inSnap / snap.count : 0;
  say('snapshot names present in the build', `${inSnap}/${snap.count} (${(share * 100).toFixed(1)}%)`);
  if (share < 0.95) warn.push('the committed universe snapshot disagrees with the built market — the next live run should replace it');
} else {
  warn.push('no committed universe snapshot: a failed vendor fetch has no fallback');
}

// --- vendor headline cap --------------------------------------------------------------------------
// The vendor's own cap is a second, independent share count. A large gap is a stale count or a share
// class, not an arithmetic error, so it is reported and not failed.
const vc = ind.audit && ind.audit.vendorCap;
if (vc) {
  say('vendor cap compared / >10% off', `${vc.compared} / ${vc.over10pct}${vc.examples && vc.examples.length ? ' · ' + vc.examples.slice(0, 5).map((x) => `${x.code} ${x.gap}%`).join(', ') : ''}`);
  if (vc.compared && vc.over10pct / vc.compared > 0.15) warn.push(`${vc.over10pct}/${vc.compared} market caps differ from the vendor by >10% — check the share count`);
}

// --- optional cross-check against the vendor's own statistics page --------------------------------
// The invariants above only prove the arithmetic is self-consistent. This asks whether the inputs are:
// the vendor publishes its own P/E, P/B, ROE, yield and market cap, and a 15% gap means a different
// price date, a different share count, or a formula that is not the one it claims.
if (SAMPLE) {
  const { getCached } = await import('./stockanalysis.mjs');
  const { mkdirSync } = await import('node:fs');
  const { saSlug } = await import('./idx.mjs');
  mkdirSync(join(ROOT, 'data', 'cache', 'indonesia-audit'), { recursive: true });
  const sample = [...ind.companies].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, SAMPLE);
  const stat = (html, id) => {
    const m = new RegExp(`\\{id:"${id}",[^}]*?(?:hover|value):"([^"]+)"`).exec(html);
    if (!m) return null;
    const n = Number(String(m[1]).replace('%', '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  let cmp = 0, peOff = 0, dyOff = 0, pbDiff = 0, capOff = 0;
  const peOut = [], capOut = [];
  for (const c of sample) {
    const f = join(ROOT, 'data', 'cache', 'indonesia-audit', `stats-${saSlug(c.code)}.json`);
    let html = null;
    try { html = await getCached(`https://stockanalysis.com/quote/idx/${saSlug(c.code)}/statistics/`, f, { ttlMs: 7 * 864e5, retries: 2 }); } catch { html = null; }
    if (!html) continue;
    const pe = stat(html, 'pe'), pb = stat(html, 'pb'), dy = stat(html, 'dividendYield');
    const capM = /\{id:"marketcap",[^}]*hover:"([\d,]+)"/.exec(html);
    const vcap = capM ? Number(capM[1].replace(/,/g, '')) : null;
    if (pe != null && c.pe != null) {
      cmp++;
      if (Math.abs(c.pe - pe) / pe > 0.15) { peOff++; peOut.push(`${c.code} ${c.pe} vs ${pe}`); }
    }
    if (dy != null && c.dividendYield != null && Math.abs(c.dividendYield - dy) > 0.3) dyOff++;
    // The vendor divides P/B by total equity including minorities; this build uses common equity. A
    // difference there is the definition, not an error, so it is counted separately.
    if (pb != null && c.pb != null && Math.abs(c.pb - pb) / pb > 0.15) pbDiff++;
    // A market cap gap means a stale or wrong share count — the input no formula check can catch.
    if (vcap && c.marketCap) {
      const gap = Math.abs(c.marketCap - vcap) / vcap;
      if (gap > 0.1) { capOff++; capOut.push(`${c.code} ${(gap * 100).toFixed(1)}%`); }
    }
  }
  say('sample P/E compared / >15% off', `${cmp} / ${peOff}`);
  say('sample market cap >10% off', `${capOff}${capOut.length ? ' · ' + capOut.slice(0, 6).join(', ') : ''}`);
  say('sample yield >0.3pp off', dyOff);
  say('sample P/B >15% from vendor (total equity)', pbDiff);
  if (peOff) warn.push(`${peOff}/${cmp} sample P/E differ from the vendor by >15% (${peOut.slice(0, 6).join(', ')})`);
  if (capOff) warn.push(`${capOff}/${sample.length} sample market caps differ from the vendor by >10% — check the share count`);
  if (!cmp) warn.push('the sample compared nothing — the vendor page did not render its P/E');
}

console.log('\nWARNINGS');
for (const w of warn) console.log('  ! ' + w);
console.log('\nFAILURES');
for (const f of fails) console.log('  ✗ ' + f);
console.log(fails.length ? `\n${fails.length} hard failure(s)` : '\nall hard invariants pass');
process.exit(fails.length ? 1 : 0);
