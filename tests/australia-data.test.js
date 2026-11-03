// Invariants for the committed Australia dataset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('market cap is price × shares, in AUD', () => {
  for (const c of au.companies) {
    const cap = c.price * c.shares;
    assert.ok(Math.abs(cap - c.marketCap) / cap < 1e-9, `${c.code} cap reconciles`);
  }
});

test('ratios are either absent or physically possible', () => {
  for (const c of au.companies) {
    if (c.pe != null) assert.ok(c.pe > 0.01 && c.pe < 500, `${c.code} P/E ${c.pe}`);
    if (c.pb != null) assert.ok(c.pb > 0 && c.pb < 50, `${c.code} P/B ${c.pb}`);
    if (c.roe != null) assert.ok(c.roe > -1000 && c.roe < 1000, `${c.code} ROE ${c.roe}`);
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

test('the list projection carries the fields the Australian filters read', () => {
  const list = read('australia-list.json');
  assert.equal(list.companies.length, au.companies.length);
  for (const c of list.companies) {
    assert.ok('pe' in c && 'pb' in c && 'roe' in c && 'dividendYield' in c && 'marketCap' in c && 'reportCurrency' in c);
    assert.equal(c.series, undefined, 'the list never ships price history');
  }
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
  assert.equal(a.withoutStatements + (a.throttled || 0) + (a.withoutPrice || 0), a.considered - a.withStatements,
    'every considered company is built, without a page, without a price, or throttled');
  const foreign = au.companies.filter((c) => c.reportCurrency !== 'AUD').length;
  assert.equal(a.foreignReporters, foreign);
});
