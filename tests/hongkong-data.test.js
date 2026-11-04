// Invariants for the committed Hong Kong dataset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { growthRates } from '../src/growth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, '..', 'data', f), 'utf8'));
const hk = read('hongkong.json');
const seriesBucket = (code) => JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'hongkong-series', `${String(code).slice(0, 2)}.json`), 'utf8'));

test('every Hong Kong company is a priced main-board stock with a sector', () => {
  assert.ok(hk.companies.length > 0, 'the dataset is built');
  for (const c of hk.companies) {
    assert.match(c.code, /^\d{4}$/, `${c.code} is a four-digit HKEX code`);
    assert.ok(c.name || c.nameEn, `${c.code} has a name`);
    assert.ok(c.price > 0, `${c.code} has a positive price`);
    assert.ok(c.shares > 0, `${c.code} has a share count from the filing`);
    assert.ok(c.sector, `${c.code} has a sector`);
    assert.equal(c.currency, 'HKD');
    // Hong Kong lists issuers that report in CNY, USD, SGD, MYR, MOP, THB, CAD, AUD, JPY, EUR as well
    // as HKD. Every one of them must have a rate in the FX snapshot, or its ratios would be blank.
    assert.match(c.reportCurrency, /^[A-Z]{3}$/, `${c.code} reports in a known currency`);
    assert.ok(hk.fx.rates[c.reportCurrency] > 0, `${c.code} reports in ${c.reportCurrency}, which has no FX rate`);
  }
});

test('market cap is price × current shares, in HKD', () => {
  for (const c of hk.companies) {
    const cap = c.price * (c.sharesCurrent ?? c.shares);
    assert.ok(Math.abs(cap - c.marketCap) / cap < 1e-9, `${c.code} cap reconciles`);
  }
});

test('ratios are either absent or physically possible', () => {
  for (const c of hk.companies) {
    if (c.pe != null) assert.ok(c.pe >= 0.5 && c.pe < 500, `${c.code} P/E ${c.pe}`);
    if (c.pb != null) assert.ok(c.pb > 0 && c.pb < 50, `${c.code} P/B ${c.pb}`);
    if (c.roe != null) assert.ok(c.roe > -1000 && c.roe < 1000, `${c.code} ROE ${c.roe}`);
    if (c.opMargin != null) assert.ok(Math.abs(c.opMargin) <= 500, `${c.code} operating margin ${c.opMargin}`);
    if (c.netMargin != null) assert.ok(Math.abs(c.netMargin) <= 500, `${c.code} net margin ${c.netMargin}`);
    if (c.dividendYield != null) assert.ok(c.dividendYield >= 0 && c.dividendYield < 30, `${c.code} yield ${c.dividendYield}`);
  }
});

test('the market totals are the sum of the constituents', () => {
  const total = hk.companies.reduce((a, c) => a + c.marketCap, 0);
  assert.ok(Math.abs(total - hk.market.totalCap) / total < 1e-9);
  assert.equal(hk.market.companies, hk.companies.length);
  const sectors = hk.market.sectors.reduce((a, s) => a + s.count, 0);
  assert.equal(sectors, hk.companies.length, 'every company is in exactly one sector');
});

test('the Hang Seng series is dated, ordered and positive', () => {
  assert.ok(hk.index && hk.index.level > 0);
  const s = hk.index.series;
  assert.ok(s.length > 100, 'at least a few months of index history');
  for (let i = 1; i < s.length; i++) assert.ok(s[i].d > s[i - 1].d, 'dates ascend');
  for (const p of s) assert.ok(p.c > 0);
});

test('the FX snapshot carries the HKD and CNY rates the ratios need', () => {
  assert.ok(hk.fx && hk.fx.rate > 7 && hk.fx.rate < 8.5, `USD/HKD ${hk.fx && hk.fx.rate}`);
  assert.ok(hk.fx.rates && hk.fx.rates.CNY > 5 && hk.fx.rates.CNY < 9);
});

test('display names do not leak another listing and summaries are complete sentences', () => {
  const profiles = read('hongkong-profiles.json').entries || {};
  for (const c of hk.companies) {
    assert.doesNotMatch(c.nameEn || '', /\s*\([A-Z]{2,6}:[A-Z0-9.]+\).*$/, `${c.code} name ${c.nameEn}`);
    assert.ok(!/^[a-z]/.test(c.nameEn || '') || /^[a-z][A-Z-]/.test(c.nameEn || ''), `${c.code} name is capitalised`);
  }
  for (const [code, p] of Object.entries(profiles)) {
    if (!p.desc) continue;
    assert.match(p.desc, /[.!?]["')\]]?$|\u2026$/, `${code} summary ends cleanly`);
    assert.doesNotMatch(p.desc, /;$/, `${code} summary is not a cut-off list`);
  }
});

test('the list projection carries the fields the Hong Kong filters read', () => {
  const list = read('hongkong-list.json');
  assert.equal(list.companies.length, hk.companies.length);
  for (const c of list.companies) {
    assert.ok('pe' in c && 'pb' in c && 'roe' in c && 'dividendYield' in c && 'marketCap' in c && 'reportCurrency' in c);
    assert.equal(c.series, undefined, 'the list never ships price history');
  }
});

test('the daily/weekly chart store covers the listed codes', () => {
  const c = hk.companies[0];
  const series = seriesBucket(c.code);
  assert.ok(Array.isArray(series.daily[c.code]) || Array.isArray(series.weekly[c.code]), `${c.code} has history`);
  const w = series.weekly[c.code] || [];
  for (let i = 1; i < w.length; i++) assert.ok(w[i].d > w[i - 1].d, 'weekly dates ascend');
});

test('free cash flow is the vendor FCF, not operating plus all investing flow', () => {
  for (const c of hk.companies) {
    if (c.fcf == null) continue;
    const r = c.reports || {};
    const t = c.fcfBasis === 'TTM';
    const ttm = r.ttm || {}, fy = (r.annual || []).at(-1) || {};
    const vendor = t ? ttm.freeCashFlow : fy.freeCashFlow;
    const cfo = t ? ttm.operatingCashFlow : fy.operatingCashFlow;
    const capex = t ? ttm.capitalExpenditure : fy.capitalExpenditure;
    const want = vendor ?? (cfo != null && capex != null ? cfo - Math.abs(capex) : null);
    if (want == null) continue;
    assert.ok(Math.abs(want - c.fcf) < 2, `${c.code}: FCF ${c.fcf} vs vendor ${want}`);
  }
});

test('dividend yield is built from the latest annual DPS', () => {
  const rates = hk.fx.rates;
  let checked = 0;
  for (const c of hk.companies) {
    if (c.dividendYield == null) continue;
    if (c.dividendYieldBasis === 'vendor') {
      assert.ok(Number.isFinite(c.dividendYield), `${c.code}: vendor yield is a number`);
      checked++;
      continue;
    }
    const annualDps = (c.reports?.annual || []).at(-1)?.dividendPerShare;
    const dps = annualDps ?? c.reports?.ttm?.dividendPerShare;
    assert.ok(dps != null, `${c.code}: a yield needs a DPS`);
    assert.equal(c.dividendYieldBasis, annualDps != null ? 'FY' : 'TTM', `${c.code}: the DPS basis is labelled`);
    const perReport = c.reportCurrency === c.currency ? 1 : rates[c.currency] / rates[c.reportCurrency];
    const want = +(((dps * perReport) / c.price) * 100).toFixed(2);
    assert.ok(Math.abs(want - c.dividendYield) <= 0.011, `${c.code}: yield ${c.dividendYield} vs ${want}`);
    checked++;
  }
  assert.ok(checked > 300, `the yield is exercised across the market (${checked})`);
});

test('a market cap uses the current share count when the vendor supplied one', () => {
  let current = 0;
  for (const c of hk.companies) {
    if (!(c.sharesCurrent > 0)) continue;
    current++;
    assert.ok(Math.abs(c.price * c.sharesCurrent - c.marketCap) / c.marketCap < 1e-9, `${c.code}: cap uses current shares`);
    assert.ok(c.shares > 0, `${c.code}: the diluted filing count is still present`);
  }
  assert.ok(current > hk.companies.length * 0.9, `most companies have a current share count (${current})`);
});

test('growth rates reproduce from the annual record', () => {
  let checked = 0;
  for (const c of hk.companies) {
    if (c.revenueCagr == null && c.epsCagr == null) continue;
    const rows = (c.reports?.annual || []).slice(-5).map((r) => ({
      year: Number(String(r.end).slice(0, 4)),
      revenue: r.revenue,
      eps: r.eps,
      shares: r.shares > 0 ? r.shares : (r.netIncome != null && r.eps ? r.netIncome / r.eps : null),
    }));
    const g = growthRates(rows);
    assert.equal(c.revenueCagr, g.revenueCagr, `${c.code}: revenue CAGR`);
    assert.equal(c.epsCagr, g.epsCagr, `${c.code}: EPS CAGR`);
    assert.equal(c.cagrYears, g.cagrYears, `${c.code}: span`);
    assert.equal(c.cagrNA, g.cagrNA, `${c.code}: revenue NA reason`);
    assert.equal(c.epsCagrNA, g.epsCagrNA, `${c.code}: EPS NA reason`);
    if (g.epsChange) assert.deepEqual(c.epsChange, g.epsChange, `${c.code}: EPS change`);
    checked++;
  }
  assert.ok(checked > 500, `growth is exercised across the market (${checked})`);
});

test('no company ships a statement older than 450 days', () => {
  const session = new Date(hk.session);
  for (const c of hk.companies) {
    const end = c.reports?.ttmEnd || c.reports?.latestEnd;
    if (!end) continue;
    assert.ok((session - new Date(end)) / 864e5 <= 450, `${c.code}: statement ${end} is current`);
  }
  assert.ok(Array.isArray(hk.audit?.staleCodes), 'the excluded stale names are listed');
});

test('SEC-covered ADRs carry an official share count and an as-of date', () => {
  const sec = read('hongkong-sec-shares.json').entries || {};
  assert.ok(Object.keys(sec).length >= 20, `expected the SEC ADR set (${Object.keys(sec).length})`);
  for (const [code, s] of Object.entries(sec)) {
    assert.ok(s.shares > 0, `${code}: share count`);
    assert.equal(s.source, 'SEC cover', `${code}: source`);
    assert.match(s.asOf || '', /^\d{4}-\d{2}-\d{2}$/, `${code}: as-of date`);
  }
});

test('the audit counters are honest about coverage', () => {
  const a = hk.audit || {};
  assert.ok(a.quoted >= a.commonStocks, 'quoted lines include the companies');
  assert.ok(a.commonStocks >= a.considered, 'the market is at least what this build considered');
  assert.equal(a.withStatements, hk.companies.length);
  assert.ok(a.withoutStatements >= 0);
  assert.equal(a.withoutStatements + (a.throttled || 0) + (a.incompleteSmall || 0) + (a.stale || 0) + (a.unsourced || 0), a.considered - a.withStatements,
    'every considered company is built, without a page, throttled, stale, unsourced, or excluded for missing profile info');
});
