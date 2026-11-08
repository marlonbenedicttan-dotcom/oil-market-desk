import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchEntries } from '../src/search.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const index = read('search-index.json');
const markets = read('market-index.json');
const quick = read('search-quick.json');
const top = (q) => searchEntries(index.entries, q, { limit: 1 }).results[0];

test('the global index covers every company market', () => {
  const expected = ['us', 'jp', 'kr', 'tw', 'hk', 'au', 'in', 'id', 'br', 'za'];
  for (const m of expected) assert.ok(index.markets[m], `${m} is in the index`);
  assert.ok(index.entries.length > 9000, `expected a broad index, got ${index.entries.length}`);
  assert.equal(Object.keys(index.markets).length, expected.length);
});

test('every entry carries the identity the UI needs', () => {
  for (const e of index.entries) {
    for (const k of ['market', 'id', 'ticker', 'name', 'indexSymbol', 'issuerKey']) {
      assert.ok(e[k] != null && e[k] !== '', `${e.ticker || e.id}: missing ${k}`);
    }
    assert.ok(Array.isArray(e.listings), `${e.ticker}: listings array`);
  }
});

test('one entry per issuer (share classes and BDRs are grouped)', () => {
  const keys = new Set(index.entries.map((e) => e.issuerKey));
  assert.equal(keys.size, index.entries.length, 'issuer keys are unique');
});

test('the market counts add up to the entries', () => {
  const sum = Object.values(index.markets).reduce((a, m) => a + (m.count || 0), 0);
  assert.equal(sum, index.entries.length);
});

test('the market index has every country and a default series', () => {
  for (const [id, m] of Object.entries(markets.markets)) {
    assert.ok(m.label && m.flag && m.default, `${id}: label/flag/default`);
    const ix = m.indices[m.default];
    assert.ok(ix, `${id}: default index exists`);
    assert.ok(Array.isArray(ix.points) && ix.points.length > 10, `${id}: index has history`);
    assert.ok(Number.isFinite(ix.level), `${id}: index has a level`);
  }
  assert.ok(markets.markets.us.indices['^SP1500'], 'US S&P 1500 series');
  assert.ok(markets.markets.us.indices['^GSPC'], 'US S&P 500 series');
  assert.ok(markets.markets.jp.indices.TOPIX, 'Japan TOPIX series');
});

test('the canonical cross-market searches land on the right company', () => {
  const cases = [
    ['toyota', 'jp', '7203'], ['7203', 'jp', '7203'], ['samsung', 'kr', '005930'],
    ['005930', 'kr', '005930'], ['tsmc', 'tw', '2330'], ['2330', 'tw', '2330'],
    ['bhp', 'au', 'BHP'], ['reliance', 'in', 'RELIANCE'], ['bbca', 'id', 'BBCA'],
    ['petr4', 'br', 'PETR4'], ['nubank', 'br', 'ROXO34'], ['naspers', 'za', 'NPN'],
    ['apple', 'us', 'AAPL'], ['0700', 'hk', '0700'],
  ];
  for (const [q, market, ticker] of cases) {
    const r = top(q);
    assert.ok(r, `${q} returns a result`);
    assert.equal(r.market, market, `${q} market`);
    assert.equal(String(r.ticker), ticker, `${q} ticker`);
  }
});

test('the local quick index is complete and searchable', () => {
  assert.equal(quick.entries.length, index.entries.length, 'every issuer has a quick row');
  for (const e of quick.entries) {
    for (const k of ['market', 'id', 'ticker', 'name', 'hay']) assert.ok(e[k] != null && e[k] !== '', `${e.ticker || e.id}: missing ${k}`);
    assert.ok(Array.isArray(e.codes) && e.codes.length, `${e.ticker}: codes`);
  }
  const nubank = quick.entries.find((e) => e.hay.includes('nubank'));
  assert.ok(nubank, 'Nubank is searchable in the local index');
  assert.equal(nubank.market, 'br');
  assert.equal(String(nubank.ticker), 'ROXO34');
  const apple = quick.entries.find((e) => String(e.ticker) === 'AAPL');
  assert.match(apple.hay, /apple/, 'Apple is searchable in the local index');
  assert.equal(Object.keys(quick.markets).length, Object.keys(index.markets).length);
});
