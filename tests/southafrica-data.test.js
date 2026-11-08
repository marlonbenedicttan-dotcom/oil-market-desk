import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTER_FIELDS, projectZa } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const za = read('southafrica.json');
const list = read('southafrica-list.json');
const snap = read('southafrica-universe.json');

const EXCLUDED = new Set(['BHG', 'S32', 'INP', 'AGL', 'MNP', 'QLT', 'SOLBE1', 'FTB', 'EMN', 'RTO', 'AON', 'BRN', 'NY1', 'FDETNQ']);

test('the JSE build has a real universe', () => {
  assert.ok(za.companies.length > 200, `only ${za.companies.length} companies`);
  assert.equal(za.currency, 'ZAR');
  assert.ok(za.fx && za.fx.rate > 5 && za.fx.rate < 30, `USD/ZAR ${za.fx && za.fx.rate}`);
  assert.equal(za.indexName, 'JSE All Share');
  assert.equal(snap.count, 244);
});

test('foreign-secondary lines are flagged and sourced, the exclusions are out', () => {
  const primary = za.companies.filter((c) => !c.foreignSecondary);
  const secondary = za.companies.filter((c) => c.foreignSecondary);
  assert.ok(secondary.length >= 20, `only ${secondary.length} secondary lines`);
  for (const code of ['CFR', 'PRX', 'ANH', 'ANG', 'BTI', 'GLN', 'N91', 'BYI', 'CNP', 'MCZ', 'EPS']) {
    assert.ok(secondary.some((c) => c.code === code), `${code} is missing from the secondary lens`);
  }
  for (const c of secondary) {
    assert.ok(c.secondarySource, `${c.code}: no source`);
    assert.ok(c.secondaryExchange, `${c.code}: no exchange`);
    assert.equal(c.currency, 'ZAR', `${c.code}: not priced in rand`);
  }
  for (const c of za.companies) assert.ok(!EXCLUDED.has(c.code), `${c.code} is excluded by decision`);
  assert.equal(za.market.primary, primary.length);
  assert.equal(za.market.secondary, secondary.length);
  assert.equal(za.market.listed, za.companies.length);
  assert.equal(za.market.companies, za.companies.length);
  assert.equal(za.audit.primaryCount, primary.length);
  assert.equal(za.audit.secondaryCount, secondary.length);
});

test('the price is the JSE line, calibrated to the exchange list in rand', () => {
  let checked = 0;
  for (const c of za.companies) {
    if (!(c.vendorPrice > 0) || !(c.price > 0)) continue;
    checked++;
    // The list prints cents; the dataset is rand. Yahoo's own unit varies by line.
    assert.ok(Math.abs(c.price / (c.vendorPrice / 100) - 1) < 0.02, `${c.code}: ${c.price} vs list ${c.vendorPrice / 100}`);
  }
  assert.ok(checked > 200, `only ${checked} prices compared`);
});

test('the cap is the vendor company total in rand', () => {
  let checked = 0;
  for (const c of za.companies) {
    if (!(c.vendorCap > 0) || !(c.marketCap > 0)) continue;
    checked++;
    assert.ok(Math.abs(c.marketCap / c.vendorCap - 1) < 0.02, `${c.code}: ${c.marketCap} vs ${c.vendorCap}`);
  }
  assert.ok(checked > 200, `only ${checked} caps compared`);
});

test('every published ratio reproduces from its own inputs', () => {
  const rates = (za.fx && za.fx.rates) || {};
  const capReport = (c) => {
    if (!c.reportCurrency || c.reportCurrency === 'ZAR') return c.marketCap;
    if (!rates.ZAR || !rates[c.reportCurrency]) return null;
    return c.marketCap * (rates[c.reportCurrency] / rates.ZAR);
  };
  let checked = 0;
  for (const c of za.companies) {
    const cap = capReport(c);
    const ni = c.netIncomeTTM;
    if (c.pe != null && cap != null) {
      checked++;
      assert.ok(ni > 0, `${c.code}: a P/E on a loss`);
      assert.ok(Math.abs(c.pe - cap / ni) / (cap / ni) < 0.03, `${c.code}: P/E ${c.pe} vs ${(cap / ni).toFixed(2)}`);
    }
    const eq = c.reports && c.reports.latest && (c.reports.latest.equityCommon ?? c.reports.latest.equity);
    if (c.pb != null && cap != null) {
      assert.ok(eq > 0, `${c.code}: P/B on negative equity`);
      const want = cap / eq;
      assert.ok(Math.abs(c.pb - want) <= 0.005 + Math.abs(want) * 0.03, `${c.code}: P/B ${c.pb} vs ${want.toFixed(4)}`);
    }
  }
  assert.ok(checked > 100, `only ${checked} P/Es checked`);
});

test('a bank ships no operating margin and no free cash flow', () => {
  for (const c of za.companies) {
    if (c.bankLike) assert.equal(c.opMargin, null, `${c.code} is bank-like with an op margin`);
    if (c.financial) {
      assert.equal(c.fcf, null, `${c.code} is a financial with free cash flow`);
      assert.equal(c.fcfYield, null, `${c.code} is a financial with an FCF yield`);
    }
  }
});

test('totals and sectors cover every JSE line', () => {
  const total = za.companies.reduce((a, c) => a + (c.marketCap || 0), 0);
  assert.ok(Math.abs(total - za.market.totalCap) / total < 0.001);
  const sectorCount = (za.market.sectors || []).reduce((a, s) => a + s.count, 0);
  assert.equal(sectorCount, za.companies.length);
  assert.ok((za.market.sectors || []).length >= 8, `only ${(za.market.sectors || []).length} sectors`);
});

test('the index is the JSE All Share, dated, ordered and positive', () => {
  const s = za.index.series || [];
  assert.ok(s.length > 100, `index has ${s.length} points`);
  assert.ok(s.every((p) => p.c > 0));
  for (let i = 1; i < s.length; i++) assert.ok(s[i].d > s[i - 1].d);
  assert.match(za.index.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('the list projection carries the fields the South Africa filters read', () => {
  const fields = FILTER_FIELDS.za;
  const sample = projectZa(za.companies[0]);
  for (const f of fields) assert.ok(f in sample, `filter field "${f}" is missing from the projection`);
  assert.equal(list.companies.length, za.companies.length);
  assert.equal(list.currency, 'ZAR');
  assert.equal(list.indexName, 'JSE All Share');
});
