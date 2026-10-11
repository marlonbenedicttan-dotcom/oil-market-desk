import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sgn, inBox, haversineNm, isoWeek, monthly, pctOver, percentile, realizedVol, computeCracks } from '../src/lib.js';

test('sgn formats with sign', () => {
  assert.equal(sgn(4.39), '+4.39');
  assert.equal(sgn(-2), '-2.00');
  assert.equal(sgn(null), '—');
});

test('inBox detects points in a bounding box', () => {
  assert.equal(inBox(26.5, 56.5, [[24, 54], [28, 58]]), true);
  assert.equal(inBox(0, 0, [[24, 54], [28, 58]]), false);
});

test('haversineNm ≈ 60 nm per degree of longitude at the equator', () => {
  const d = haversineNm(0, 0, 0, 1);
  assert.ok(d > 59 && d < 61, `got ${d}`);
});

test('isoWeek', () => {
  assert.equal(isoWeek('2026-01-01'), 1);
  assert.equal(isoWeek('2026-12-31'), 53);
});

test('monthly keeps the last value of each month', () => {
  const m = monthly({ '2026-01-05': 1, '2026-01-20': 2, '2026-02-01': 3 });
  assert.deepEqual(m, { '2026-01': 2, '2026-02': 3 });
});

test('pctOver computes % change from the start', () => {
  assert.equal(Math.round(pctOver([100, 101, 102, 103, 104, 105], 5)), 5);
  assert.equal(pctOver([null, null], 1), null);
});

test('percentile ranks a value within a series', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 3), 60);
});

test('realizedVol returns null with too few points', () => {
  assert.equal(realizedVol([1, 2, 3], 30), null);
});

test('computeCracks builds refining margins', () => {
  const m = { benchmarks: [
    { id: 'wti', paper: 100, physical: 100 },
    { id: 'rbob', paper: 3, physical: 3 },
    { id: 'ulsd', paper: 4, physical: 4 },
    { id: 'jet', physical: 5 },
  ] };
  const c = computeCracks(m);
  assert.equal(c.gasoline, 3 * 42 - 100);
  assert.equal(c.diesel, 4 * 42 - 100);
  assert.equal(c.c321, ((2 * 3 + 4) * 42) / 3 - 100);
  assert.equal(c.jetPhys, 5 * 42 - 100);
});
