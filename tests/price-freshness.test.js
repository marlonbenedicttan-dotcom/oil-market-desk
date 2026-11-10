// Price freshness — the session a market is on, how many lines are behind it, and how old that is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceDateOf, barDateOf, companyKey, sessionStats, sessionsBehind, buildGapHours, buildGapStale } from '../scripts/price-freshness.mjs';

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

test('a bar with no close is the source lagging, not a missed refresh', () => {
  // The Austraian case: Yahoo printed 2026-11-09 for this line but left the close null. We did fetch
  // the session, so the guard must not call it a failed refresh — it is a close the source owes us.
  const s = sessionStats([
    { code: 'A', priceDate: '2026-11-06', priceBar: '2026-11-09' },
    { code: 'B', priceDate: '2026-11-09', priceBar: '2026-11-09' },
    { code: 'C', priceDate: '2026-11-06', priceBar: '2026-11-06' },
  ]);
  assert.equal(s.session, '2026-11-09');
  assert.equal(s.behind, 1, 'only C has no bar for the session');
  assert.equal(s.noClose, 1, 'A has the bar without a close');
  assert.equal(s.behindShare, 1 / 3);
  assert.equal(s.noCloseShare, 1 / 3);
});

test('a build without bar dates still measures against the close date', () => {
  const s = sessionStats([{ code: 'A', priceDate: '2026-11-06' }, { code: 'B', priceDate: '2026-11-09' }]);
  assert.equal(s.session, '2026-11-09');
  assert.equal(s.behind, 1);
  assert.equal(barDateOf({ priceBar: '2026-11-09', priceDate: '2026-11-06' }), '2026-11-09');
  assert.equal(barDateOf({ priceDate: '2026-11-06' }), '2026-11-06');
});

test('a fresh build carrying an old session is stale, however new the file is', () => {
  // The US case on 2026-11-10: the file was rewritten at 09:11 with fundamentals but every price
  // stayed on 6 Nov. Session was ~105h older than the build.
  const now = Date.parse('2026-11-10T10:00:00Z');
  assert.ok(buildGapHours('2026-11-06', '2026-11-10T09:11:00Z', now) > 60);
  assert.equal(buildGapStale('2026-11-06', '2026-11-10T09:11:00Z', now), true);
});

test('an after-close build is not a stale build', () => {
  // A 21:00 close written up at 22:00 leaves the session's midnight 22h behind the build; that is
  // normal and must not fail the monitor.
  const now = Date.parse('2026-11-10T22:30:00Z');
  assert.ok(buildGapHours('2026-11-10', '2026-11-10T22:00:00Z', now) < 60);
  assert.equal(buildGapStale('2026-11-10', '2026-11-10T22:00:00Z', now), false);
});

test('a missing session or build timestamp is not guessed', () => {
  assert.equal(buildGapHours(null, '2026-11-10T09:00:00Z'), null);
  assert.equal(buildGapStale('2026-11-06', null), false);
});
