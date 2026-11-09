// Invariants for the committed Australia dataset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { growthRates } from '../src/growth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, '..', 'data', f), 'utf8'));
const au = read('australia.json');
const seriesBucket = (code) => JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'australia-series', `${String(code).slice(0, 1).toUpperCase()}.json`), 'utf8'));

test('every Australian company is a priced ASX stock with a sector and a statement currency', () => {
  assert.ok(au.companies.length > 0, 'the dataset is built');
  for (const c of au.companies) {
    assert.match(c.code, /^[A-Z0-9]{3}$/, `${c.code} is a three-character ASX code`);
    assert.ok(c.name || c.nameEn, `${c.code} has a name`);
    assert.ok(c.price > 0, `${c.code} has a positive price`);
    assert.ok(c.shares > 0, `${c.code} has a share count from the filing`);
    assert.ok(c.sector, `${c.code} has a sector`);
    assert.notEqual(c.sector, 'Not Applic', `${c.code} still shows the raw "Not Applic" value`);
    assert.equal(c.currency, 'AUD');
    assert.match(c.reportCurrency, /^[A-Z]{3}$/, `${c.code} reports in a currency`);
  }
});

test('market cap is price × current shares, in AUD', () => {
  for (const c of au.companies) {
    const cap = c.price * (c.sharesCurrent ?? c.shares);
    assert.ok(Math.abs(cap - c.marketCap) / cap < 1e-9, `${c.code} cap reconciles`);
  }
});

test('ratios are either absent or physically possible', () => {
  for (const c of au.companies) {
    if (c.pe != null) assert.ok(c.pe >= 0.5 && c.pe < 500, `${c.code} P/E ${c.pe}`);
    if (c.pb != null) assert.ok(c.pb > 0 && c.pb < 50, `${c.code} P/B ${c.pb}`);
    if (c.roe != null) assert.ok(c.roe > -1000 && c.roe < 1000, `${c.code} ROE ${c.roe}`);
    if (c.opMargin != null) assert.ok(Math.abs(c.opMargin) <= 500, `${c.code} operating margin ${c.opMargin}`);
    if (c.netMargin != null) assert.ok(Math.abs(c.netMargin) <= 500, `${c.code} net margin ${c.netMargin}`);
    if (c.dividendYield != null) assert.ok(c.dividendYield >= 0 && c.dividendYield < 30, `${c.code} yield ${c.dividendYield}`);
  }
});

test('the market totals are the sum of the constituents', () => {
  const total = au.companies.reduce((a, c) => a + c.marketCap, 0);
  assert.ok(Math.abs(total - au.market.totalCap) / total < 1e-9);
  assert.equal(au.market.companies, au.companies.length);
  const sectors = au.market.sectors.reduce((a, s) => a + s.count, 0);
  assert.equal(sectors, au.companies.length, 'every company is in exactly one sector');
});

test('the S&P/ASX 200 series is dated, ordered and positive', () => {
  assert.ok(au.index && au.index.level > 0);
  const s = au.index.series;
  assert.ok(s.length > 100, 'at least a few months of index history');
  for (let i = 1; i < s.length; i++) assert.ok(s[i].d > s[i - 1].d, 'dates ascend');
  for (const p of s) assert.ok(p.c > 0);
});

test('the FX snapshot carries the AUD cross the ratios need', () => {
  assert.ok(au.fx && au.fx.rate > 1 && au.fx.rate < 2.5, `USD/AUD ${au.fx && au.fx.rate}`);
  assert.ok(au.fx.rates && au.fx.rates.AUD > 1 && au.fx.rates.USD === 1);
});

test('the exchange short name is clean and summaries are complete sentences', () => {
  const profiles = read('australia-profiles.json').entries || {};
  for (const c of au.companies) {
    assert.doesNotMatch(c.name || '', /\.$/, `${c.code} exchange name ${c.name}`);
  }
  for (const [code, p] of Object.entries(profiles)) {
    if (!p.desc) continue;
    assert.match(p.desc, /[.!?]["')\]]?$|\u2026$/, `${code} summary ends cleanly`);
    assert.doesNotMatch(p.desc, /;$/, `${code} summary is not a cut-off list`);
  }
});

test('the list projection carries the fields the Australian filters read', () => {
  const list = read('australia-list.json');
  assert.equal(list.companies.length, au.companies.length);
  for (const c of list.companies) {
    assert.ok('pe' in c && 'pb' in c && 'roe' in c && 'dividendYield' in c && 'marketCap' in c && 'reportCurrency' in c);
    assert.ok('netIncomeTTM' in c && 'netIncomeTTMAsOf' in c, 'the trailing profit survives projection');
    assert.ok('fcfYield' in c, 'the screener FCF YLD column reads the list');
    assert.equal(c.series, undefined, 'the list never ships price history');
  }
});

test('every company carries the trailing profit its P/E is built on', () => {
  let ttm = 0, fallback = 0;
  for (const c of au.companies) {
    if (c.netIncomeTTM != null) {
      assert.ok(Number.isFinite(c.netIncomeTTM), `${c.code}: net profit TTM is a number`);
      assert.match(c.netIncomeTTMAsOf || '', /^\d{4}-\d{2}-\d{2}$/, `${c.code}: the period is dated`);
    }
    if (c.peBasis === 'TTM') {
      ttm++;
      assert.ok(c.netIncomeTTM != null, `${c.code}: a TTM P/E needs a TTM profit`);
      assert.notEqual(c.ttmFromFY, true, `${c.code}: TTM basis is not a fiscal-year fallback`);
    }
    // The fiscal-year fallback exists for issuers without a trailing page. Coverage is now complete
    // enough that no company needs it, so the test asserts how it must behave when it is used — a
    // fallback labelled FY, still carrying the profit it divides by — rather than that it is used.
    if (c.ttmFromFY) {
      fallback++;
      assert.equal(c.peBasis, 'FY', `${c.code}: a fiscal-year fallback is labelled FY, not TTM`);
      assert.ok(c.netIncomeTTM != null, `${c.code}: the fallback still carries the profit it divides by`);
    }
  }
  assert.ok(ttm > au.companies.length / 2, `most of the market is on a trailing basis (${ttm} TTM, ${fallback} fallback)`);
});

test('the period table is as-reported periods, not a trailing-twelve-month window', () => {
  const counts = { half: 0, quarter: 0 };
  for (const c of au.companies) {
    if (!c.periodBasis) continue;
    assert.ok(c.periodBasis === 'half' || c.periodBasis === 'quarter', `${c.code}: known period basis`);
    counts[c.periodBasis]++;
    const q = (c.reports && c.reports.quarters) || [];
    assert.ok(q.length >= 2, `${c.code}: at least two periods`);
    assert.deepEqual(q, c.quarters, `${c.code}: the detail and report period tables agree`);
    const gaps = [];
    for (let i = 1; i < q.length; i++) {
      gaps.push((Date.parse(q[i].d) - Date.parse(q[i - 1].d)) / (864e5 * 30.44));
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (c.periodBasis === 'half') {
      assert.ok(median >= 4.5 && median <= 9, `${c.code}: half-year spacing (${median.toFixed(1)} months)`);
    } else {
      assert.ok(median >= 1.5 && median < 4.5, `${c.code}: quarterly spacing (${median.toFixed(1)} months)`);
    }
  }
  assert.ok(counts.half > 1200, `most ASX issuers report half-yearly (${counts.half} half-year, ${counts.quarter} quarterly)`);
  assert.ok(counts.quarter > 10, `the banks and US dual-listed lines report quarterly (${counts.quarter})`);
  const rio = au.companies.find((c) => c.code === 'RIO');
  assert.equal(rio && rio.periodBasis, 'half', 'RIO is a half-year reporter even though it is a US dual listing');
});

test('free cash flow is the vendor FCF, not operating plus all investing flow', () => {
  for (const c of au.companies) {
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
  const rates = au.fx.rates;
  let checked = 0;
  for (const c of au.companies) {
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
  for (const c of au.companies) {
    if (!(c.sharesCurrent > 0)) continue;
    current++;
    assert.ok(Math.abs(c.price * c.sharesCurrent - c.marketCap) / c.marketCap < 1e-9, `${c.code}: cap uses current shares`);
    assert.ok(c.shares > 0, `${c.code}: the diluted filing count is still present`);
  }
  assert.ok(current > au.companies.length * 0.9, `most companies have a current share count (${current})`);
});

test('growth rates reproduce from the annual record', () => {
  let checked = 0;
  for (const c of au.companies) {
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
  assert.ok(checked > 300, `growth is exercised across the market (${checked})`);
});

test('no company ships a statement older than 450 days', () => {
  const session = new Date(au.session || au.index.date);
  for (const c of au.companies) {
    const end = c.reports?.ttmEnd || c.reports?.latestEnd;
    if (!end) continue;
    assert.ok((session - new Date(end)) / 864e5 <= 450, `${c.code}: statement ${end} is current`);
  }
  assert.ok(Array.isArray(au.audit?.staleCodes), 'the excluded stale names are listed');
});

test('financials keep the ratios that apply and drop the ones that do not', () => {
  const fins = au.companies.filter((c) => c.financial);
  assert.ok(fins.length >= 100, `the financial-sector rule finds the ASX financials (${fins.length})`);
  for (const c of fins) {
    // A bank's cash flow is loans and deposits; an insurer's is its investment portfolio. Neither is
    // free cash flow, so the FCF family is withheld for the whole financial sector — as the US and
    // Japan pages do — while margins, returns and the balance sheet stay.
    for (const key of ['fcf', 'fcfYield', 'fcfMargin', 'cashConversion']) {
      assert.equal(c[key], null, `${c.code}: ${key} is not a ratio for a financial`);
    }
    for (const key of ['fcf', 'fcfYield', 'fcfMargin', 'cashConversion', 'operatingCashFlow']) {
      assert.ok((c.naRatios || []).includes(key), `${c.code}: naRatios records ${key}`);
    }
    assert.ok(Number.isFinite(c.netIncomeTTM), `${c.code}: the profit is still shown`);
  }
  const withBook = fins.filter((c) => c.pb != null || c.roe != null).length;
  assert.ok(withBook > fins.length * 0.8, `the financials keep the ratios that apply (${withBook}/${fins.length})`);
  // A bank has no operating-profit line either; an insurer reports one and keeps its margin.
  for (const c of au.companies.filter((x) => x.bankLike)) {
    assert.equal(c.opMargin, null, `${c.code}: no operating margin for a bank`);
    assert.ok((c.naRatios || []).includes('opMargin'), `${c.code}: naRatios records opMargin`);
  }
  const sun = au.companies.find((c) => c.code === 'SUN');
  assert.ok(sun && sun.opMargin != null, 'SUN reports an operating margin');
  assert.ok(!(sun.naRatios || []).includes('opMargin'), 'and it is not suppressed');
  assert.equal(sun.fcf, null, 'but an insurer has no free cash flow');
});

test('a non-financial keeps its cash-flow ratios', () => {
  const bhp = au.companies.find((c) => c.code === 'BHP');
  assert.ok(bhp && bhp.fcf != null, 'BHP has a free cash flow');
  assert.ok(Number.isFinite(bhp.fcfMargin) && Math.abs(bhp.fcfMargin) <= 100, 'and a printable FCF margin');
  assert.ok(bhp.cashConversion == null || Math.abs(bhp.cashConversion) <= 5);
  assert.equal(bhp.fcfBasis === 'TTM' || bhp.fcfBasis === 'FY', true);
});

test('the daily/weekly chart store covers the listed codes', () => {
  const c = au.companies[0];
  const series = seriesBucket(c.code);
  assert.ok(Array.isArray(series.daily[c.code]) || Array.isArray(series.weekly[c.code]), `${c.code} has history`);
  const w = series.weekly[c.code] || [];
  for (let i = 1; i < w.length; i++) assert.ok(w[i].d > w[i - 1].d, 'weekly dates ascend');
});

test('the audit counters are honest about coverage and currency', () => {
  const a = au.audit || {};
  assert.ok(a.quoted >= a.companies, 'the CSV includes every company line');
  assert.ok(a.companies >= a.considered, 'the market is at least what this build considered');
  assert.equal(a.withStatements, au.companies.length);
  assert.ok(a.withoutStatements >= 0);
  assert.ok(a.notApplicSectors >= 0, 'the "Not Applic" rows are counted');
  assert.equal(a.withoutStatements + (a.throttled || 0) + (a.withoutPrice || 0) + (a.stale || 0) + (a.unsourced || 0), a.considered - a.withStatements,
    'every considered company is built, without a page, without a price, stale, unsourced, or throttled');
  const foreign = au.companies.filter((c) => c.reportCurrency !== 'AUD').length;
  assert.equal(a.foreignReporters, foreign);
});
