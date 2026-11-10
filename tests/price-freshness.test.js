// Price freshness — the session a market is on, how many lines are behind it, and how old that is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceDateOf, companyKey, sessionStats, sessionsBehind } from '../scripts/price-freshness.mjs';

const c = (priceDate, extra = {}) => ({ code: priceDate, price: 1, priceDate, ...extra });

test('the session is the most common date, not the newest one', () => {
  // One company quoting a Sunday (a real Yahoo artifact in Australia) must not make the market look
  // current — 2026-11-08 is newer than 2026-11-06 but only one line carries it.
  const s = sessionStats([
    c('2026-11-06'), c('2026-11-06'), c('2026-11-06'),
    c('2026-11-05'),
    c('2026-11-08'),
  ]);
  assert.equal(s.session, '2026-11-06');
  assert.equal(s.total, 5);
  assert.equal(s.onSession, 3);
  assert.equal(s.behind, 1, 'the 11-05 line is behind the session');
  assert.equal(s.ahead, 1, 'the Sunday print is ahead of it, and is not a stale quote');
  assert.equal(s.behindShare, 1 / 5);
});

test('a tie goes to the later date — a market moving forward, never back', () => {
  const s = sessionStats([c('2026-11-06'), c('2026-11-09')]);
  assert.equal(s.session, '2026-11-09');
  assert.equal(s.behind, 1);
});

test('priceAsOf is the US spelling of priceDate', () => {
  assert.equal(priceDateOf({ priceAsOf: '2026-11-06' }), '2026-11-06');
  assert.equal(priceDateOf({ priceDate: '2026-11-09', priceAsOf: '2026-11-06' }), '2026-11-09');
  assert.equal(priceDateOf({ price: 1 }), null);
});

test('companies without a date are ignored, not counted as behind', () => {
  const s = sessionStats([c('2026-11-09'), { price: 2 }, { price: 3, priceDate: null }]);
  assert.equal(s.total, 1);
  assert.equal(s.behind, 0);
});

test('an empty market has no session', () => {
  const s = sessionStats([]);
  assert.equal(s.session, null);
  assert.equal(s.total, 0);
  assert.equal(s.behindShare, 0);
  assert.equal(sessionStats(undefined).session, null);
});

test('a market where every line moved has nothing behind', () => {
  const s = sessionStats([c('2026-11-09'), c('2026-11-09'), c('2026-11-09')]);
  assert.equal(s.behind, 0);
  assert.equal(s.behindShare, 0);
});

test('sessions behind counts trading days after the session, not calendar days', () => {
  // Fri 6 Nov -> Mon 9 Nov: only the weekend in between, nothing has been missed yet.
  assert.equal(sessionsBehind('2026-11-06', '2026-11-09'), 0);
  // Fri 6 Nov -> Tue 10 Nov: Monday's session is missing.
  assert.equal(sessionsBehind('2026-11-06', '2026-11-10'), 1);
  // Fri 6 Nov -> Thu 12 Nov: Monday, Tuesday and Wednesday are missing.
  assert.equal(sessionsBehind('2026-11-06', '2026-11-12'), 3);
  // Same day, or a date in the past, is never negative.
  assert.equal(sessionsBehind('2026-11-09', '2026-11-09'), 0);
  assert.equal(sessionsBehind('2026-11-10', '2026-11-09'), 0);
  assert.equal(sessionsBehind(null, '2026-11-09'), null);
});

test('the company key survives every market spelling', () => {
  assert.equal(companyKey({ code: 'BHP' }), 'BHP');
  assert.equal(companyKey({ ticker: 'AAPL' }), 'AAPL');
  assert.equal(companyKey({ cik: 320193 }), '320193');
  assert.equal(companyKey({}), '');
});
