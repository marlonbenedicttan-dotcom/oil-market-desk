// The Japan list artifact is what /api/japan, the search index and the peer index read. These checks
// make sure it is the projection of the current source, not a stale copy that would silently hide a
// company or serve an old market cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, '..', 'data', f), 'utf8'));
const jp = read('japan.json');
const list = read('japan-list.json');

test('the Japan list artifact is the projection of the current source', () => {
  assert.equal(list.updated, jp.updated, 'the list was built from a different japan.json');
  assert.equal(list.companies.length, jp.companies.length);
  assert.equal(list.fx && list.fx.rate, jp.fx && jp.fx.rate);
  assert.deepEqual(list.market, jp.market);
});

test('every Japan company in the source is in the list with the same identity and cap', () => {
  const byTicker = new Map(list.companies.map((c) => [c.ticker, c]));
  for (const c of jp.companies) {
    const l = byTicker.get(c.ticker);
    assert.ok(l, `${c.ticker} is missing from japan-list.json`);
    assert.equal(l.name, c.name, `${c.ticker} name`);
    assert.equal(l.marketCap, c.marketCap, `${c.ticker} market cap`);
  }
});

test('the list ships the fields search and peers read', () => {
  for (const c of list.companies) {
    assert.ok(c.ticker && c.name, `${c.ticker || '?'} has a ticker and a name`);
    assert.ok('nameJa' in c && 'sector' in c && 'marketCap' in c);
  }
});

test('the Japan list carries market flows and the exchange calendar', () => {
  assert.ok(list.flow && list.flow.section === 'TSEPrime', 'the TSE Prime investor-flow panel is missing');
  assert.ok(Array.isArray(list.flow.weeks) && list.flow.weeks.length >= 4, 'the flow history is too short');
  assert.ok(list.flow.w4 && Number.isFinite(list.flow.w4.foreign), 'the four-week foreign flow is missing');
  assert.ok(list.calendar && list.calendar.nextSession, 'the exchange calendar is missing');
  assert.match(list.calendar.nextSession.d, /^\d{4}-\d{2}-\d{2}$/);
});
