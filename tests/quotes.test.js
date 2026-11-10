// Live quote plumbing — pure, fixture-based, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRef, yahooSymbol, normalizeQuote, chunk, INDEX_REF } from '../src/quotes.js';

test('each market maps to the Yahoo suffix the chart builders use', () => {
  assert.equal(yahooSymbol('us', 'AAPL'), 'AAPL');
  assert.equal(yahooSymbol('us', 'BRK.B'), 'BRK-B');
  assert.equal(yahooSymbol('jp', '7203'), '7203.T');
  assert.equal(yahooSymbol('kr', '005930'), '005930.KS');
  assert.equal(yahooSymbol('tw', '2330'), '2330.TW');
  assert.equal(yahooSymbol('hk', '700'), '0700.HK');
  assert.equal(yahooSymbol('au', 'BHP'), 'BHP.AX');
  assert.equal(yahooSymbol('in', 'M&M'), 'M&M.NS');
  assert.equal(yahooSymbol('id', 'BBCA'), 'BBCA.JK');
  assert.equal(yahooSymbol('br', 'PETR4'), 'PETR4.SA');
  assert.equal(yahooSymbol('za', 'NPN'), 'NPN.JO');
  assert.equal(yahooSymbol('us', '^GSPC'), '^GSPC');
  assert.equal(yahooSymbol('xx', 'AAPL'), null);
});

test('a ref is a market and a code, never a Yahoo suffix', () => {
  assert.deepEqual(parseRef('us:aapl'), { market: 'us', code: 'AAPL', symbol: 'AAPL' });
  assert.deepEqual(parseRef('hk:700'), { market: 'hk', code: '700', symbol: '0700.HK' });
  assert.deepEqual(parseRef('jp:7203'), { market: 'jp', code: '7203', symbol: '7203.T' });
  assert.deepEqual(parseRef('us:^GSPC'), { market: 'us', code: '^GSPC', symbol: '^GSPC' });
  assert.equal(parseRef('AAPL'), null, 'no market');
  assert.equal(parseRef('xx:AAPL'), null, 'unknown market');
  assert.equal(parseRef('us:'), null, 'empty code');
});

test('a quote is the last price, the previous close and the move', () => {
  const q = normalizeQuote({
    currency: 'USD', regularMarketPrice: 110, chartPreviousClose: 100, regularMarketTime: 1794295428,
  });
  assert.equal(q.price, 110);
  assert.equal(q.prevClose, 100);
  assert.equal(q.chg1d, 10);
  assert.equal(q.currency, 'USD');
  assert.equal(q.time, new Date(1794295428 * 1000).toISOString());
  assert.equal(q.source, 'yahoo');
  assert.equal(normalizeQuote({ regularMarketPrice: 0 }), null);
  assert.equal(normalizeQuote(null), null);
});

test('a JSE cent quote is converted to rand', () => {
  const q = normalizeQuote({ currency: 'ZAc', regularMarketPrice: 77300, chartPreviousClose: 76702, regularMarketTime: 1794295428 });
  assert.equal(q.currency, 'ZAR');
  assert.equal(q.price, 773);
  assert.equal(q.prevClose, 767.02);
  assert.ok(Math.abs(q.chg1d - 0.78) < 0.01);
});

test('the ten index refs are the symbols the market pages use', () => {
  assert.equal(INDEX_REF.us, 'us:^GSPC');
  assert.equal(INDEX_REF.za, 'za:^J203.JO');
  for (const ref of Object.values(INDEX_REF)) assert.ok(parseRef(ref), ref);
});

test('a batch never exceeds the provider limit', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(chunk(Array.from({ length: 41 }, (_, i) => i), 20).length, 3);
});
