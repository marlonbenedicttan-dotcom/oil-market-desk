// Invariants for the committed Hong Kong dataset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('market cap is price × shares, in HKD', () => {
  for (const c of hk.companies) {
    const cap = c.price * c.shares;
    assert.ok(Math.abs(cap - c.marketCap) / cap < 1e-9, `${c.code} cap reconciles`);
  }
});

test('ratios are either absent or physically possible', () => {
  for (const c of hk.companies) {
    if (c.pe != null) assert.ok(c.pe > 0.01 && c.pe < 500, `${c.code} P/E ${c.pe}`);
    if (c.pb != null) assert.ok(c.pb > 0 && c.pb < 50, `${c.code} P/B ${c.pb}`);
    if (c.roe != null) assert.ok(c.roe > -1000 && c.roe < 1000, `${c.code} ROE ${c.roe}`);
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

test('the audit counters are honest about coverage', () => {
  const a = hk.audit || {};
  assert.ok(a.quoted >= a.commonStocks, 'quoted lines include the companies');
  assert.ok(a.commonStocks >= a.considered, 'the market is at least what this build considered');
  assert.equal(a.withStatements, hk.companies.length);
  assert.ok(a.withoutStatements >= 0);
  assert.equal(a.withoutStatements + (a.throttled || 0), a.considered - a.withStatements,
    'every considered company is either built, without a page, or throttled');
});
