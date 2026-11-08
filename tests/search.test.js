import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, normalizeCode, query, searchEntries } from '../src/search.js';

const e = (over = {}) => ({
  market: 'us', id: '1', ticker: 'AAPL', code: 'AAPL', name: 'Apple Inc.', nameEn: 'Apple Inc.',
  aliases: ['iPhone'], capUsd: 3e12, indexSymbol: '^GSPC', indexLabel: 'S&P 500',
  issuerKey: 'us:1', listings: [{ ticker: 'AAPL' }], ...over,
});

const entries = [
  e(),
  e({
    market: 'us', id: '2', ticker: 'GOOGL', code: 'GOOGL', name: 'Alphabet Inc.', nameEn: 'Alphabet Inc.',
    aliases: ['Google', 'YouTube'], capUsd: 2e12, issuerKey: 'us:2',
    listings: [{ ticker: 'GOOGL' }, { ticker: 'GOOG' }],
  }),
  e({
    market: 'jp', id: '72030', ticker: '7203', code: '72030', name: 'TOYOTA MOTOR CORPORATION',
    nameEn: 'Toyota Motor Corporation', aliases: ['Toyota'], capUsd: 3e11, indexSymbol: 'TOPIX',
    indexLabel: 'TOPIX', issuerKey: 'jp:72030', listings: [{ ticker: '7203', code: '72030' }],
  }),
  e({
    market: 'kr', id: '005930', ticker: '005930', code: '005930', name: '삼성전자',
    nameEn: 'Samsung Electronics', aliases: ['Samsung'], capUsd: 3e11, indexSymbol: 'KOSPI',
    indexLabel: 'KOSPI', issuerKey: 'kr:005930', listings: [{ ticker: '005930' }],
  }),
  e({
    market: 'tw', id: '2330', ticker: '2330', code: '2330', name: '台積電',
    nameEn: 'Taiwan Semiconductor Manufacturing', aliases: ['TSMC'], capUsd: 5e11,
    indexSymbol: 'TAIEX', indexLabel: 'TAIEX', issuerKey: 'tw:2330', listings: [{ ticker: '2330' }],
  }),
];

test('normalize folds accents, ampersands and punctuation', () => {
  assert.equal(normalize('Schrödinger'), 'schrodinger');
  assert.equal(normalize('S&P 500'), 's and p 500');
  assert.equal(normalize('AT&T Inc.'), 'at and t inc');
  assert.equal(normalize('삼성전자'), '삼성전자');
});

test('codes survive exchange prefixes, dots and dashes', () => {
  assert.equal(normalizeCode('NASDAQ:AAPL'), 'AAPL');
  assert.equal(normalizeCode('TSE:7203'), '7203');
  assert.equal(normalizeCode('BRK.B'), 'BRKB');
  assert.equal(normalizeCode('BRK-B'), 'BRKB');
  assert.equal(normalizeCode('0700'), '0700');
  assert.equal(query('0700').numeric, '700');
});

test('finds a US ticker, a local code, a name and a brand', () => {
  assert.equal(searchEntries(entries, 'aapl', { limit: 1 }).results[0].ticker, 'AAPL');
  assert.equal(searchEntries(entries, '7203', { limit: 1 }).results[0].market, 'jp');
  assert.equal(searchEntries(entries, '005930', { limit: 1 }).results[0].market, 'kr');
  assert.equal(searchEntries(entries, '2330', { limit: 1 }).results[0].market, 'tw');
  assert.equal(searchEntries(entries, 'toyota', { limit: 1 }).results[0].market, 'jp');
  assert.equal(searchEntries(entries, 'samsung', { limit: 1 }).results[0].market, 'kr');
  assert.equal(searchEntries(entries, 'tsmc', { limit: 1 }).results[0].market, 'tw');
});

test('a share-class listing is searchable from the parent company', () => {
  const r = searchEntries(entries, 'goog', { limit: 1 }).results[0];
  assert.equal(r.ticker, 'GOOGL');
  assert.ok(r.listings.some((l) => l.ticker === 'GOOG'), 'GOOG is exposed as a listing');
});

test('a market filter is respected', () => {
  const r = searchEntries(entries, 'samsung', { market: 'tw', limit: 5 });
  assert.equal(r.total, 0);
  assert.deepEqual(r.results, []);
});

test('a typo still finds the obvious company', () => {
  const r = searchEntries(entries, 'toyta', { limit: 3 }).results;
  assert.equal(r[0].market, 'jp');
});

test('market cap only breaks a tie, never beats an exact match', () => {
  const small = e({ id: 's', ticker: 'SMALL', code: 'SMALL', name: 'Acme Corp', capUsd: 1e9, issuerKey: 'us:s', listings: [{ ticker: 'SMALL' }] });
  const big = e({ id: 'b', ticker: 'BIG', code: 'BIG', name: 'Acme Corp', capUsd: 1e12, issuerKey: 'us:b', listings: [{ ticker: 'BIG' }] });
  const r = searchEntries([small, big], 'acme', { limit: 2 }).results;
  assert.equal(r[0].ticker, 'BIG');
  const exact = searchEntries([small, big, e({ id: 'x', ticker: 'ACME', code: 'ACME', name: 'Different', capUsd: 1e6, issuerKey: 'us:x', listings: [{ ticker: 'ACME' }] })], 'acme', { limit: 3 }).results;
  assert.equal(exact[0].ticker, 'ACME');
});

test('the response carries the fields the UI renders', () => {
  const r = searchEntries(entries, 'apple', { limit: 1 }).results[0];
  for (const k of ['market', 'id', 'ticker', 'name', 'nameEn', 'capUsd', 'indexSymbol', 'listings', 'matchedOn', 'issuerKey']) {
    assert.ok(k in r, `${k} is present`);
  }
});
