import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryBands } from '../src/lib.js';

// Fridays in ISO week 28 across six years — the same seasonal week.
const ROWS = [
  { period: '2021-07-16', value: 10 },
  { period: '2022-07-15', value: 20 },
  { period: '2023-07-14', value: 30 },
  { period: '2024-07-12', value: 40 },
  { period: '2025-07-11', value: 50 },
  { period: '2026-07-10', value: 60 },
];

test('inventoryBands compares each week with the prior five same-week levels', () => {
  const out = inventoryBands(ROWS, 156, 5);
  assert.equal(out.length, 6);
  assert.equal(out[0].n, 0);
  assert.equal(out[0].min, null);
  const last = out[5];
  assert.equal(last.period, '2026-07-10');
  assert.equal(last.value, 60);
  assert.equal(last.n, 5);
  assert.equal(last.min, 10);
  assert.equal(last.max, 50);
  assert.equal(last.avg, 30);
});

test('inventoryBands leaves a band null with fewer than three prior years', () => {
  const out = inventoryBands(ROWS.slice(0, 3), 156, 5);
  assert.equal(out[2].n, 2);
  assert.equal(out[2].min, null);
  assert.equal(out[2].avg, null);
  assert.equal(out[2].max, null);
});

test('inventoryBands keeps only the requested number of recent weeks', () => {
  const out = inventoryBands(ROWS, 2, 5);
  assert.deepEqual(out.map((r) => r.period), ['2025-07-11', '2026-07-10']);
});

test('inventoryBands ignores rows without a usable value', () => {
  const out = inventoryBands([...ROWS, { period: '2026-07-17', value: null }, { period: '2026-07-24' }], 156, 5);
  assert.equal(out.length, 6);
  assert.equal(out.at(-1).period, '2026-07-10');
});
