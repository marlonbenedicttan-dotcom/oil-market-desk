import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, latestPeriod, dartPeriodEnd, ageDays } from '../src/refresh-ledger.js';

test('freshness classifies a newer source period as a repair queue item', () => {
  assert.equal(classify({ published: '2026-06-30', sourceLatest: '2026-09-30', priceDate: '2026-11-10', today: '2026-11-11' }).status, 'repair');
  assert.equal(classify({ published: '2026-09-30', sourceLatest: '2026-09-30', priceDate: '2026-11-10', today: '2026-11-11' }).status, 'fresh');
});

test('a stale period is only stale while the quote is still current', () => {
  const old = classify({ published: '2023-03-31', sourceLatest: null, priceDate: '2026-11-10', today: '2026-11-11' });
  assert.equal(old.status, 'stale');
  const inactive = classify({ published: '2023-03-31', sourceLatest: null, priceDate: '2025-01-01', today: '2026-11-11' });
  assert.equal(inactive.status, 'inactive', 'a suspended/delisted line is not marked as a broken feed');
});

test('the latest period prefers the newest quarter and falls back to the summary end', () => {
  assert.equal(latestPeriod({ quarters: [{ d: '2026-03-31' }, { end: '2026-06-30' }] }), '2026-06-30');
  assert.equal(latestPeriod({ ttmEnd: '2026-06-30' }), '2026-06-30');
  assert.equal(latestPeriod({}), null);
});

test('DART report codes map to the expected period end', () => {
  assert.equal(dartPeriodEnd('2026', '11013'), '2026-03-31');
  assert.equal(dartPeriodEnd('2026', '11012'), '2026-06-30');
  assert.equal(dartPeriodEnd('2026', '11014'), '2026-09-30');
  assert.equal(dartPeriodEnd('2026', '11011'), '2026-12-31');
  assert.equal(dartPeriodEnd('2026', '99999'), null);
});

test('age is measured against the UTC calendar day', () => {
  assert.equal(ageDays('2026-11-10', '2026-11-11'), 1);
  assert.equal(ageDays(null, '2026-11-11'), null);
});
