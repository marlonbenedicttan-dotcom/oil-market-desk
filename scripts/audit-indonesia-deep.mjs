// Deep audit for Indonesia: every published number, recomputed from its own inputs.
//
//   node scripts/audit-indonesia-deep.mjs
//
// The standard audit (audit-indonesia.mjs) proves the headline invariants. This one is deliberately
// adversarial: it re-runs the ratio engine on the stored inputs and compares every field, then checks
// the fields the engine does not own (returns from the archived series, the index, the list projection,
// the HSC/stale/theme sets, and the audit counters). A field that does not reproduce is printed with
// both values. Read-only; exits non-zero on any mismatch.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveListing } from './derive-listing.mjs';
import { growthRates } from '../src/growth.js';
import { indonesiaList } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const d = read('indonesia.json');
const list = read('indonesia-list.json');
const sharesFile = read('indonesia-shares.json');
const hscFile = read('indonesia-hsc.json');
const seriesDir = join(ROOT, 'data', 'indonesia-series');
const DAY = 864e5;

const failures = [];
const notes = [];
let checks = 0;
const fail = (what, detail) => failures.push(`${what}: ${detail}`);
const say = (label, value) => console.log(`${label.padEnd(46)} ${value}`);

const eq = (a, b, abs = 0, rel = 1e-9) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= abs + Math.abs(b) * rel;
};
const close = (what, a, b, abs = 1e-6, rel = 1e-9) => {
  checks++;
  if (!eq(a, b, abs, rel)) fail(what, `${a} vs ${b}`);
};

// --- 1. re-run the engine on the stored inputs ----------------------------------------------------
// marketCap is removed so the cap is recomputed from price × current shares, not trusted.
const inputs = d.companies.map((c) => {
  const { marketCap: _cap, ...rest } = c;
  return {
    ...rest,
    ttm: c.reports.ttm,
    latest: c.reports.latest,
    annual: c.reports.annual,
    quarters: c.reports.quarters,
  };
});
const rerun = new Map(deriveListing({ companies: inputs, fx: d.fx, baseCurrency: 'IDR' }).map((c) => [c.code, c]));

const NUM = [
  ['marketCap', 0, 1e-12], ['marketCapUsd', 1], ['shares', 0, 1e-12], ['sharesCurrent', 0, 1e-12],
  ['netIncomeTTM', 0, 1e-12], ['pe', 0.0051], ['pb', 0.0051], ['pbTotal', 0.0051],
  ['roe', 0.051], ['roeTotal', 0.051], ['roeFY', 0.051], ['roePriorFY', 0.051],
  ['opMargin', 0.051], ['netMargin', 0.051], ['fcf', 0, 1e-12], ['fcfYield', 0.0051],
  ['fcfMargin', 0.051], ['cashConversion', 0.0051], ['dividendYield', 0.0051],
  ['revenueCagr', 0.051], ['epsCagr', 0.051], ['cagrYears', 0], ['marginDelta', 0.051],
  ['epsTTM', 0.011],
];
for (const c of d.companies) {
  const r = rerun.get(c.code);
  if (!r) { fail('engine', `${c.code}: not reproduced`); continue; }
  // The build's post-processing: a bank has no operating margin, a financial has no FCF, and an ROE
  // beyond ±500% is withheld. Apply the same rules before comparing.
  if (c.bankLike) r.opMargin = null;
  if (c.financial) { r.fcf = null; r.fcfYield = null; r.fcfMargin = null; r.cashConversion = null; }
  if (r.roe != null && Math.abs(r.roe) > 500) r.roe = null;
  for (const [field, abs, rel] of NUM) close(`${c.code}.${field}`, c[field], r[field], abs, rel);
  // Bands are a percentile of the five year-end P/Es plus today's — every input is in the record.
  if (c.bands || r.bands) {
    if (!c.bands || !r.bands) fail(`${c.code}.bands`, `${JSON.stringify(c.bands)} vs ${JSON.stringify(r.bands)}`);
    else {
      close(`${c.code}.bands.pe.min`, c.bands.pe.min, r.bands.pe.min, 0.0051);
      close(`${c.code}.bands.pe.median`, c.bands.pe.median, r.bands.pe.median, 0.0051);
      close(`${c.code}.bands.pe.max`, c.bands.pe.max, r.bands.pe.max, 0.0051);
      close(`${c.code}.bands.pe.percentile`, c.bands.pe.percentile, r.bands.pe.percentile, 0);
      close(`${c.code}.bands.pe.n`, c.bands.pe.n, r.bands.pe.n, 0);
    }
  }
  // The five-year record and the trailing table are copies, not recomputations.
  checks += 2;
  if (JSON.stringify(c.history) !== JSON.stringify(r.history)) fail(`${c.code}.history`, 'does not match the annual record');
  if (JSON.stringify(c.quarters) !== JSON.stringify(r.quarters)) fail(`${c.code}.quarters`, 'does not match the reported periods');
  // Labels must agree with the values.
  checks += 3;
  if (c.peBasis !== r.peBasis) fail(`${c.code}.peBasis`, `${c.peBasis} vs ${r.peBasis}`);
  if (c.dividendYieldBasis !== r.dividendYieldBasis) fail(`${c.code}.dividendYieldBasis`, `${c.dividendYieldBasis} vs ${r.dividendYieldBasis}`);
  if (!!c.ttmFromFY !== !!r.ttmFromFY) fail(`${c.code}.ttmFromFY`, `${c.ttmFromFY} vs ${r.ttmFromFY}`);
}
say('engine fields compared', `${checks.toLocaleString()} across ${d.companies.length} companies`);

// --- 2. independent formula checks ----------------------------------------------------------------
// The re-run proves the stored file matches the engine. These prove the engine's arithmetic on the
// published values, independently.
const rates = (d.fx && d.fx.rates) || {};
const capReport = (c) => {
  if (!c.reportCurrency || c.reportCurrency === 'IDR') return c.marketCap;
  if (!rates.IDR || !rates[c.reportCurrency]) return null;
  return c.marketCap * (rates[c.reportCurrency] / rates.IDR);
};
let pe = 0, pb = 0, roe = 0, cap = 0, fx = 0;
for (const c of d.companies) {
  const sh = c.sharesCurrent > 0 ? c.sharesCurrent : c.shares;
  if (c.price > 0 && sh > 0) {
    cap++; close(`${c.code}.cap`, c.marketCap, c.price * sh, 0, 1e-12);
    if (d.fx.rate) { fx++; close(`${c.code}.capUsd`, c.marketCapUsd, c.marketCap / d.fx.rate, 1); }
  }
  const capR = capReport(c);
  const ni = c.netIncomeTTM;
  if (c.pe != null) { pe++; close(`${c.code}.pe`, c.pe, capR / ni, 0.0051); }
  const eqc = c.reports && c.reports.latest && (c.reports.latest.equityCommon ?? c.reports.latest.equity);
  if (c.pb != null) { pb++; close(`${c.code}.pb`, c.pb, capR / eqc, 0.0051); }
  if (c.roe != null) { roe++; close(`${c.code}.roe`, c.roe, (ni / eqc) * 100, 0.051); }
}
say('cap = price × shares', `${cap} checked`);
say('cap in USD = cap ÷ USD/IDR', `${fx} checked`);
say('P/E = cap (report ccy) ÷ TTM profit', `${pe} checked`);
say('P/B = cap ÷ common equity', `${pb} checked`);
say('ROE = TTM profit ÷ common equity', `${roe} checked`);

// Growth, independently from the last five fiscal years.
let growthChecked = 0;
for (const c of d.companies) {
  if (c.revenueCagr == null && c.epsCagr == null) continue;
  const rows = (c.reports.annual || []).slice(-5).map((r) => ({
    year: Number(String(r.end).slice(0, 4)),
    revenue: r.revenue, eps: r.eps,
    shares: r.shares > 0 ? r.shares : (r.netIncome != null && r.eps ? r.netIncome / r.eps : null),
  }));
  const g = growthRates(rows);
  growthChecked++;
  close(`${c.code}.revenueCagr`, c.revenueCagr, g.revenueCagr, 0.051);
  close(`${c.code}.epsCagr`, c.epsCagr, g.epsCagr, 0.051);
  close(`${c.code}.cagrYears`, c.cagrYears, g.cagrYears, 0);
  if ((c.cagrNA || null) !== (g.cagrNA || null)) fail(`${c.code}.cagrNA`, `${c.cagrNA} vs ${g.cagrNA}`);
  if ((c.epsCagrNA || null) !== (g.epsCagrNA || null)) fail(`${c.code}.epsCagrNA`, `${c.epsCagrNA} vs ${g.epsCagrNA}`);
}
say('growth reproduced from the annual record', `${growthChecked} checked`);

// Dividend yield: the vendor value is an input; a DPS-derived value must equal DPS × FX ÷ price.
let dyVendor = 0, dyDps = 0;
for (const c of d.companies) {
  if (c.dividendYield == null) continue;
  if (c.dividendYieldBasis === 'vendor') {
    dyVendor++;
    const s = sharesFile.entries[c.code];
    if (!s || !Number.isFinite(s.yield)) fail(`${c.code}.dividendYield`, 'vendor basis without a vendor yield');
    else close(`${c.code}.dividendYield`, c.dividendYield, s.yield, 0.0051);
  } else if (c.dividendYieldBasis === 'FY' || c.dividendYieldBasis === 'TTM') {
    dyDps++;
    const fy = (c.reports.annual || []).slice(-1)[0];
    const dps = c.dividendYieldBasis === 'FY' ? fy && fy.dividendPerShare : c.reports.ttm && c.reports.ttm.dividendPerShare;
    const per = c.reportCurrency === 'IDR' ? 1 : (rates.IDR / rates[c.reportCurrency]);
    if (dps > 0 && per) close(`${c.code}.dividendYield`, c.dividendYield, ((dps * per) / c.price) * 100, 0.0051);
    else fail(`${c.code}.dividendYield`, 'DPS basis without a usable DPS/FX');
  } else fail(`${c.code}.dividendYield`, `unknown basis ${c.dividendYieldBasis}`);
}
say('dividend yield (vendor / DPS)', `${dyVendor} / ${dyDps} checked`);

// --- 3. returns against the archived series -------------------------------------------------------
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
  if (last.d !== c.priceDate) fail(`${c.code}.priceDate`, `${c.priceDate} vs series ${last.d}`);
  close(`${c.code}.price`, c.price, last.c, 0.0011);
  // A frozen price deliberately withholds the returns; 0% would be a lie of omission.
  if (c.noRecentTrading) {
    if (c.chg1d != null || c.chg6m != null || c.chgYtd != null) fail(`${c.code}.returns`, 'a no-trade company still publishes a return');
    continue;
  }
  close(`${c.code}.chg1d`, c.chg1d, ((last.c / prev.c) - 1) * 100, 0.011);
  const six = pointOnOrBefore(s, iso(Date.parse(last.d) - 182 * DAY));
  if (six) close(`${c.code}.chg6m`, c.chg6m, ((last.c / six.c) - 1) * 100, 0.011);
  else if (c.chg6m != null) fail(`${c.code}.chg6m`, 'published but the archived series has no 6M point');
  const jan = s.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  if (jan) close(`${c.code}.chgYtd`, c.chgYtd, ((last.c / jan.c) - 1) * 100, 0.011);
  else if (c.chgYtd != null) fail(`${c.code}.chgYtd`, 'published but the archived series has no YTD point');
}
say('returns reproduce from the series', `${ret} checked`);

// --- 3b. trading quality ---------------------------------------------------------------------------
const flatOf = (s) => {
  const win = (s || []).slice(-250);
  if (win.length < 2) return null;
  let same = 0;
  for (let i = 1; i < win.length; i++) if (win[i].c === win[i - 1].c) same++;
  return Math.round((same / (win.length - 1)) * 100);
};
let quality = 0;
for (const c of d.companies) {
  const s = (bucketOf(c.code).daily || {})[c.code] || [];
  const flat = flatOf(s);
  quality++;
  if (c.noRecentTrading) {
    if (!(flat >= 90)) fail(`${c.code}.noTrade`, `flagged with flat ${flat}%`);
    if (c.chg1d != null || c.chg6m != null || c.chgYtd != null) fail(`${c.code}.noTrade`, 'a return is still published');
  } else if (flat != null && flat >= 90) fail(`${c.code}.noTrade`, `flat ${flat}% but not flagged`);
  if (!!c.shortHistory !== (s.length > 0 && s.length < 100)) fail(`${c.code}.shortHistory`, `${s.length} sessions`);
  const end = c.reports && (c.reports.ttmEnd || c.reports.latestEnd);
  const age = end ? Math.round((Date.parse(d.session) - Date.parse(end)) / DAY) : null;
  if (c.ttmAgeDays !== age) fail(`${c.code}.ttmAgeDays`, `${c.ttmAgeDays} vs ${age}`);
  if (!!c.ttmStale !== (age != null && age > 365)) fail(`${c.code}.ttmStale`, `age ${age}`);
  if (!!c.thinTrading !== (c.avgValue30 != null && c.avgValue30 < 1e8)) fail(`${c.code}.thinTrading`, `avg ${c.avgValue30}`);
}
say('trading-quality flags', `${quality} checked`);

// --- 4. index --------------------------------------------------------------------------------------
{
  const s = d.index.series || [];
  const last = s[s.length - 1], prev = s[s.length - 2];
  const six = pointOnOrBefore(s, iso(Date.parse(last.d) - 182 * DAY));
  const jan = s.find((p) => p.d >= `${last.d.slice(0, 4)}-01-01`);
  close('index.level', d.index.level, last.c, 1e-6);
  close('index.chg1d', d.index.chg1d, ((last.c / prev.c) - 1) * 100, 0.011);
  close('index.chg6m', d.index.chg6m, ((last.c / six.c) - 1) * 100, 0.011);
  close('index.chgYtd', d.index.chgYtd, ((last.c / jan.c) - 1) * 100, 0.011);
  if (d.index.date !== last.d) fail('index.date', `${d.index.date} vs ${last.d}`);
}

// --- 5. market aggregates -------------------------------------------------------------------------
const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
};
const m = d.market;
close('market.totalCap', m.totalCap, d.companies.reduce((a, c) => a + (c.marketCap || 0), 0), 1);
close('market.medianPe', m.medianPe, median(d.companies.map((c) => c.pe)), 0.0051);
close('market.medianPb', m.medianPb, median(d.companies.map((c) => c.pb)), 0.0051);
close('market.medianRoe', m.medianRoe, median(d.companies.map((c) => c.roe)), 0.0051);
close('market.medianYield', m.medianYield, median(d.companies.map((c) => c.dividendYield)), 0.0051);
close('market.belowBook', m.belowBook, d.companies.filter((c) => c.pb != null && c.pb < 1).length, 0);
close('market.upYtd', m.upYtd, d.companies.filter((c) => c.chgYtd != null && c.chgYtd > 0).length, 0);
close('market.advancing', m.advancing, d.companies.filter((c) => c.chg1d != null && c.chg1d > 0).length, 0);
close('market.declining', m.declining, d.companies.filter((c) => c.chg1d != null && c.chg1d < 0).length, 0);
const sectorSum = (m.sectors || []).reduce((a, s) => a + s.count, 0);
close('market.sectorCount', sectorSum, d.companies.length, 0);
for (const s of m.sectors || []) {
  const list = d.companies.filter((c) => c.sector === s.name);
  close(`sector.${s.name}.count`, s.count, list.length, 0);
  close(`sector.${s.name}.cap`, s.cap, list.reduce((a, c) => a + (c.marketCap || 0), 0), 1);
  close(`sector.${s.name}.pe`, s.pe, median(list.map((c) => c.pe)), 0.0051);
  close(`sector.${s.name}.pb`, s.pb, median(list.map((c) => c.pb)), 0.0051);
  close(`sector.${s.name}.roe`, s.roe, median(list.map((c) => c.roe)), 0.0051);
  close(`sector.${s.name}.yield`, s.yield, median(list.map((c) => c.dividendYield)), 0.0051);
  close(`sector.${s.name}.ytd`, s.chgYtd, median(list.map((c) => c.chgYtd)), 0.0051);
}
close('market.foreignReporters', m.foreignReporters, d.companies.filter((c) => c.reportCurrency !== 'IDR').length, 0);
const session = d.companies.map((c) => c.priceDate).filter(Boolean).sort().pop();
checks++;
if (d.session !== session) fail('market.session', `${d.session} vs ${session}`);

// --- 5b. chart store -------------------------------------------------------------------------------
// The chart endpoints read a per-company weekly store, not the buckets. Its last point must be the
// same session and close as the record, or a chart would silently end on an older price.
{
  const idx = read('charts/id.idx.json');
  const lines = readFileSync(join(ROOT, 'data', 'charts', 'id.ndjson'), 'utf8').trim().split('\n').filter(Boolean);
  const store = new Map(lines.map((l) => JSON.parse(l)).map((o) => [o.k, o.p]));
  close('chart.keys', store.size, d.companies.length, 0);
  checks++;
  if (idx.through !== session) fail('chart.through', `${idx.through} vs ${session}`);
  for (const c of d.companies) {
    const p = store.get(c.code);
    if (!Array.isArray(p) || !p.length) { fail(`${c.code}.chart`, 'missing from the chart store'); continue; }
    const [di, px] = p[p.length - 1];
    checks++;
    if (idx.dates[di] !== c.priceDate) fail(`${c.code}.chartDate`, `${c.priceDate} vs ${idx.dates[di]}`);
    close(`${c.code}.chartLast`, px, c.price, 0.0011);
  }
}

// --- 6. list projection, HSC, stale, themes -------------------------------------------------------
const projected = indonesiaList(d);
// attach-market-brands removes an empty `brands` key; the projection writes `brands: null`. Same value,
// different JSON shape, so normalise before comparing.
const normaliseBrands = (doc) => {
  const clone = JSON.parse(JSON.stringify(doc));
  for (const c of clone.companies || []) if (c.brands == null) delete c.brands;
  return clone;
};
checks++;
if (JSON.stringify(normaliseBrands(projected)) !== JSON.stringify(normaliseBrands(list))) fail('list', 'projection does not match the stored artifact');
const byCode = new Map(d.companies.map((c) => [c.code, c]));
const staleCodes = d.audit.staleCodes || [];
const stalePresent = staleCodes.filter((x) => byCode.has(x.code));
if (stalePresent.length) fail('stale', `${stalePresent.length} stale companies are still in the market`);
const pruneFile = read('indonesia-prune.json');
const prunedCodes = Object.keys(pruneFile.entries || {});
close('audit.pruned', d.audit.pruned, prunedCodes.length, 0);
const prunedPresent = prunedCodes.filter((code) => byCode.has(code));
if (prunedPresent.length) fail('prune.present', `still in the market: ${prunedPresent.join(', ')}`);
const hscCodes = Object.keys(hscFile.entries || {});
const hscFlagged = d.companies.filter((c) => c.hsc);
close('hsc.count', hscFlagged.length, hscCodes.length, 0);
close('audit.hsc', d.audit.hsc, hscFlagged.length, 0);
close('audit.hscTotal', d.audit.hscTotal, hscCodes.length, 0);
if ((d.audit.hscPruned || []).length) fail('hsc.pruned', d.audit.hscPruned.join(', '));
close('audit.noRecentTrading', d.audit.noRecentTrading, d.companies.filter((c) => c.noRecentTrading).length, 0);
close('audit.shortHistory', d.audit.shortHistory, d.companies.filter((c) => c.shortHistory).length, 0);
close('audit.ttmStale', d.audit.ttmStale, d.companies.filter((c) => c.ttmStale).length, 0);
close('audit.thinTrading', d.audit.thinTrading, d.companies.filter((c) => c.thinTrading).length, 0);
const hscMissing = hscCodes.filter((code) => !byCode.has(code));
if (hscMissing.length) fail('hsc.missing', hscMissing.join(', '));
for (const t of d.themes || []) {
  for (const code of t.tickers || []) if (!byCode.has(code)) fail('theme', `${t.id}: ${code} not in the market`);
}
for (const c of d.companies) {
  if (c.bankLike && c.opMargin != null) fail(`${c.code}.opMargin`, 'bank with an operating margin');
  if (c.financial && (c.fcf != null || c.fcfYield != null)) fail(`${c.code}.fcf`, 'financial with free cash flow');
  if (c.pe != null && c.pe < 0.5) fail(`${c.code}.pe`, `published below 0.5× (${c.pe})`);
  if (c.roe != null && Math.abs(c.roe) > 500) fail(`${c.code}.roe`, `published beyond ±500% (${c.roe})`);
  if (!c.reportCurrency) fail(`${c.code}.reportCurrency`, 'missing');
}

// --- 7. audit counters -----------------------------------------------------------------------------
const a = d.audit;
close('audit.companies', a.companies, d.companies.length, 0);
close('audit.pe', a.pe, d.companies.filter((c) => c.pe != null).length, 0);
close('audit.pb', a.pb, d.companies.filter((c) => c.pb != null).length, 0);
close('audit.roe', a.roe, d.companies.filter((c) => c.roe != null).length, 0);
close('audit.dividendYield', a.dividendYield, d.companies.filter((c) => c.dividendYield != null).length, 0);
close('audit.vendorYield', a.vendorYield, d.companies.filter((c) => c.dividendYieldBasis === 'vendor').length, 0);
close('audit.currentShares', a.currentShares, d.companies.filter((c) => c.sharesCurrent > 0).length, 0);
close('audit.netProfitTTM', a.netProfitTTM, d.companies.filter((c) => c.netIncomeTTM != null).length, 0);
close('audit.financials', a.financials, d.companies.filter((c) => c.financial).length, 0);
close('audit.bankLike', a.bankLike, d.companies.filter((c) => c.bankLike).length, 0);
close('audit.stale', a.stale, staleCodes.length, 0);

// --- report ---------------------------------------------------------------------------------------
say('checks run', checks.toLocaleString());
console.log('\nFAILURES');
for (const f of failures.slice(0, 40)) console.log('  ✗ ' + f);
if (failures.length > 40) console.log(`  … ${failures.length - 40} more`);
console.log(failures.length ? `\n${failures.length} mismatch(es)` : '\nevery number reproduces from its inputs');
process.exit(failures.length ? 1 : 0);
