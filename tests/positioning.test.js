import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignPriceToRows } from '../src/lib.js';

test('alignPriceToRows gives each weekly report the last close on or before its date', () => {
  const prices = { '2025-01-02': 10, '2025-01-09': 11, '2025-01-16': 12 };
  const rows = [
    { date: '2025-01-01', net: 1 },
    { date: '2025-01-08', net: 2 },
    { date: '2025-01-15', net: 3 },
    { date: '2025-01-22', net: 4 },
  ];
  assert.deepEqual(alignPriceToRows(prices, rows), [
    { date: '2025-01-01', net: 1, price: null },
    { date: '2025-01-08', net: 2, price: 10 },
    { date: '2025-01-15', net: 3, price: 11 },
    { date: '2025-01-22', net: 4, price: 12 },
  ]);
});

test('alignPriceToRows keeps every original field and handles an empty price map', () => {
  const rows = [{ date: '2025-01-01', net: -100, oi: 500 }];
  assert.deepEqual(alignPriceToRows({}, rows), [{ date: '2025-01-01', net: -100, oi: 500, price: null }]);
  assert.deepEqual(alignPriceToRows(null, rows), [{ date: '2025-01-01', net: -100, oi: 500, price: null }]);
  assert.deepEqual(alignPriceToRows({ '2025-01-01': 7 }, []), []);
});
