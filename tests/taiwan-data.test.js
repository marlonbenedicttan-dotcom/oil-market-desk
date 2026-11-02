// Invariants for the committed Taiwan dataset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, '..', 'data', f), 'utf8'));
const tw = read('taiwan.json');
const series = read('taiwan-series.json');

test('every Taiwan company is a priced common stock with a sector', () => {
  assert.ok(tw.companies.length > 0, 'the dataset is built');
  for (const c of tw.companies) {
    assert.match(c.code, /^\d{4}$/, `${c.code} is a four-digit TWSE code`);
    assert.ok(c.name || c.nameEn, `${c.code} has a name`);
    assert.ok(c.price > 0, `${c.code} has a positive price`);
    assert.ok(c.shares > 0, `${c.code} has issued shares`);
    assert.ok(c.sector, `${c.code} has a sector`);
    assert.equal(c.currency, 'TWD');
  }
});

test('market cap is price × shares', () => {
  for (const c of tw.companies) {
    const cap = c.price * c.shares;
    assert.ok(Math.abs(cap - c.marketCap) / cap < 1e-9, `${c.code} cap reconciles`);
  }
});

test('ratios are either absent or physically possible', () => {
  for (const c of tw.companies) {
    if (c.pe != null) assert.ok(c.pe > 0.01 && c.pe < 500, `${c.code} P/E ${c.pe}`);
    if (c.pb != null) assert.ok(c.pb > 0 && c.pb < 50, `${c.code} P/B ${c.pb}`);
    if (c.roe != null) assert.ok(c.roe > -1000 && c.roe < 1000, `${c.code} ROE ${c.roe}`);
  }
});

test('the market totals are the sum of the constituents', () => {
  const total = tw.companies.reduce((a, c) => a + c.marketCap, 0);
  assert.ok(Math.abs(total - tw.market.totalCap) / total < 1e-9);
  assert.equal(tw.market.companies, tw.companies.length);
});

test('the TAIEX series is dated, ordered and positive', () => {
  assert.ok(tw.index && tw.index.level > 0);
  const s = tw.index.series;
  assert.ok(s.length > 100, 'at least a few months of index history');
  for (let i = 1; i < s.length; i++) assert.ok(s[i].d > s[i - 1].d, 'dates ascend');
  for (const p of s) assert.ok(p.c > 0);
});

test('the list projection carries the fields the Taiwan filters read', () => {
  const list = read('taiwan-list.json');
  assert.equal(list.companies.length, tw.companies.length);
  for (const c of list.companies) {
    assert.ok('pe' in c && 'pb' in c && 'roe' in c && 'dividendYield' in c && 'marketCap' in c);
    assert.equal(c.series, undefined, 'the list never ships price history');
  }
});

test('the daily/weekly chart store covers the listed codes', () => {
  const c = tw.companies[0];
  assert.ok(Array.isArray(series.daily[c.code]) || Array.isArray(series.weekly[c.code]), `${c.code} has history`);
  const w = series.weekly[c.code] || [];
  for (let i = 1; i < w.length; i++) assert.ok(w[i].d > w[i - 1].d, 'weekly dates ascend');
});
