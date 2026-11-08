import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RISK_SERIES, keepLastSeries, latestDate } from '../src/risk.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a good series replaces the previous map', () => {
  const fresh = { map: { '2026-11-01': 20, '2026-11-02': 21, '2026-11-03': 22, '2026-11-04': 23, '2026-11-06': 25 }, source: 'Yahoo' };
  const prev = { map: { '2026-10-30': 18, '2026-10-31': 19, '2026-11-01': 20, '2026-11-02': 21, '2026-11-05': 24 }, source: 'Yahoo' };
  assert.deepEqual(keepLastSeries(fresh, prev), { map: fresh.map, source: 'Yahoo', stale: false });
});

test('an empty series keeps the previous map and marks it stale', () => {
  const prev = { map: { '2026-10-30': 18, '2026-10-31': 19, '2026-11-01': 20, '2026-11-05': 24, '2026-11-06': 21 }, source: 'Yahoo' };
  assert.deepEqual(keepLastSeries({ map: {}, source: 'Yahoo' }, prev), { ...prev, stale: true });
  assert.deepEqual(keepLastSeries(null, prev), { ...prev, stale: true });
});

test('no series at all is a blank, never a fake zero', () => {
  assert.equal(keepLastSeries(null, null), null);
  assert.equal(keepLastSeries({ map: { '2026-11-06': 1 } }, null), null);
});

test('latestDate ignores order and handles an empty map', () => {
  assert.equal(latestDate({ '2026-11-04': 1, '2026-11-06': 2, '2026-11-05': 3 }), '2026-11-06');
  assert.equal(latestDate({}), '');
});

test('SPX and VIX have exact FRED fallbacks; the 10y is FRED-first', () => {
  const byKey = new Map(RISK_SERIES.map((s) => [s.key, s]));
  assert.equal(byKey.get('spx').fallbackFred, 'SP500');
  assert.equal(byKey.get('vix').fallbackFred, 'VIXCLS');
  assert.equal(byKey.get('us10y').fred, 'DGS10');
});

// The seed must carry the series maps, not just the rendered numbers, or the matrix cannot be rebuilt
// when a feed is down. A stale seed is a real alarm: companies-daily refreshes it.
test('the committed risk seed covers every series with enough history', () => {
  const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'risk-seed.json'), 'utf8'));
  assert.ok(Date.now() - Date.parse(seed.updated) < 14 * 864e5, 'risk seed is older than 14 days');
  for (const s of RISK_SERIES) {
    const item = seed.series[s.key];
    assert.ok(item && item.map, `${s.key} is missing from the risk seed`);
    assert.ok(Object.keys(item.map).length >= 50, `${s.key} has only ${Object.keys(item.map || {}).length} points`);
    assert.ok(latestDate(item.map), `${s.key} has no dates`);
  }
});
