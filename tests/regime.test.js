import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepLastGood, buildRegimeRow, REGIME_BOARD } from '../src/regime.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a good refresh replaces the row', () => {
  const prev = { id: 'vix', price: 20, asOf: '2026-11-05', source: 'Yahoo' };
  const fresh = { id: 'vix', price: 25, asOf: '2026-11-06', source: 'Yahoo' };
  assert.deepEqual(keepLastGood(fresh, prev), { ...fresh, stale: false });
});

test('a failed refresh keeps the last good row and marks it stale', () => {
  const prev = { id: 'vix', price: 20, asOf: '2026-11-05', source: 'Yahoo' };
  assert.deepEqual(keepLastGood(null, prev), { ...prev, stale: true });
});

test('a refresh that returns no price does not erase the last good row', () => {
  const prev = { id: 'vix', price: 20, asOf: '2026-11-05', source: 'Yahoo' };
  const empty = { id: 'vix', price: null, asOf: null, source: 'Yahoo' };
  assert.deepEqual(keepLastGood(empty, prev), { ...prev, stale: true });
});

test('no fresh row and no previous row is a blank, not a fabricated zero', () => {
  assert.equal(keepLastGood(null, null), null);
  assert.equal(keepLastGood({ price: null }, { price: null }), null);
});

test('buildRegimeRow needs enough history to compute the windows', () => {
  const spec = REGIME_BOARD.find((s) => s.id === 'vix');
  assert.equal(buildRegimeRow(spec, { '2026-11-01': 20, '2026-11-02': 21 }, 'Yahoo'), null);
});

test('buildRegimeRow carries the price, as-of date and source', () => {
  const spec = REGIME_BOARD.find((s) => s.id === 'vix');
  const map = { '2026-11-01': 20, '2026-11-02': 21, '2026-11-03': 22, '2026-11-04': 23, '2026-11-05': 24, '2026-11-06': 25.643 };
  const row = buildRegimeRow(spec, map, 'FRED');
  assert.equal(row.price, 25.64);
  assert.equal(row.asOf, '2026-11-06');
  assert.equal(row.source, 'FRED');
  assert.equal(row.deltas.d1, 6.85);
});

test('a rate row uses percentage-point deltas, not percent', () => {
  const spec = REGIME_BOARD.find((s) => s.id === 'us10y');
  const map = { '2026-11-01': 4.70, '2026-11-02': 4.72, '2026-11-03': 4.75, '2026-11-04': 4.80, '2026-11-05': 4.84 };
  const row = buildRegimeRow(spec, map, 'FRED');
  assert.equal(row.deltas.d1, 0.04);
  assert.equal(row.rate, undefined); // the flag lives on the board spec, not the computed row
});

// The seed is the third fallback: if Yahoo and FRED are both down when the process starts, the board
// must still paint. It is refreshed by companies-daily, so a stale seed is a real alarm.
test('the committed regime seed covers every board row and is recent', () => {
  const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'regime-seed.json'), 'utf8'));
  assert.ok(Date.now() - Date.parse(seed.updated) < 14 * 864e5, 'regime seed is older than 14 days');
  const byId = new Map((seed.rows || []).map((r) => [r.id, r]));
  for (const s of REGIME_BOARD) {
    const row = byId.get(s.id);
    assert.ok(row && row.price != null, `${s.id} is missing from the regime seed`);
    assert.ok(row.asOf, `${s.id} has no as-of date`);
  }
});
