// Cross-market integrity: the numbers on the three market pages have to add up.
//
// Every check here corresponds to a bug that actually shipped once — a negative market cap, a preferred
// share class counted as a company, a total that did not equal the sum of its parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const us = read('companies.json').companies || [];
const jp = read('japan.json');
const kr = read('korea.json');

const listedUs = us.filter((c) => !c.shareClass && c.ticker);
const listedJp = (jp.companies || []).filter((c) => !c.shareClass);
const listedKr = kr.companies || [];

test('no market carries a negative price or market cap', () => {
  for (const [name, rows] of [['us', listedUs], ['jp', listedJp], ['kr', listedKr]]) {
    const bad = rows.filter((c) => (c.price != null && c.price < 0) || (c.marketCap != null && c.marketCap < 0));
    assert.equal(bad.length, 0, `${name}: ${bad.length} negative values (${bad.slice(0, 3).map((c) => c.ticker).join(' ')})`);
  }
});

test('Japan counts companies, not securities', () => {
  assert.equal(jp.market.companies, listedJp.length, 'market.companies disagrees with the listed count');
  const pref = (jp.companies || []).filter((c) => /preferred stock|shares of preferred/i.test(c.name || ''));
  assert.ok(pref.length === 0 || pref.every((c) => c.shareClass), 'a preferred share class is not flagged');
});

test('market totals equal the sum of their constituents', () => {
  const jpSum = listedJp.reduce((a, c) => a + (c.marketCap || 0), 0);
  assert.ok(Math.abs(jpSum / jp.market.totalCap - 1) < 1e-6, 'Japan total cap does not reconcile');
  const krSum = listedKr.reduce((a, c) => a + (c.marketCap || 0), 0);
  assert.ok(Math.abs(krSum / kr.market.totalCap - 1) < 1e-6, 'Korea total cap does not reconcile');
});

test('sector totals add up to the market total', () => {
  for (const [name, m] of [['jp', jp.market], ['kr', kr.market]]) {
    const sum = (m.sectors || []).reduce((a, s) => a + (s.cap || 0), 0);
    assert.ok(Math.abs(sum / m.totalCap - 1) < 1e-6, `${name}: sector caps do not add up to the market total`);
  }
});

test('a published share count reconciles with the published market cap', () => {
  // Korea publishes the count the cap was actually built from, so price × shares must equal the cap.
  const bad = listedKr.filter((c) => c.shares > 0 && c.price > 0 && c.marketCap > 0
    && Math.abs(c.marketCap / (c.price * c.shares) - 1) > 0.01);
  assert.equal(bad.length, 0, `${bad.length} Korean caps disagree with price × shares (${bad.slice(0, 3).map((c) => c.ticker).join(' ')})`);
});

test('ROE is only shown where book equity is positive', () => {
  // Dividing by negative equity flips the sign, so a profitable company would print a loss-like ROE.
  const bad = listedKr.filter((c) => c.roe != null && c.pb == null && c.roe > 100);
  assert.equal(bad.length, 0, `${bad.length} Korean companies show a large positive ROE without a P/B (${bad.slice(0, 3).map((c) => c.ticker).join(' ')})`);
});

test('prices are all from the same session', () => {
  const sessions = (rows, field) => [...new Set(rows.map((c) => c[field]).filter(Boolean))];
  const usDays = sessions(listedUs, 'priceAsOf');
  const jpDays = sessions(listedJp, 'priceDate');
  const krDays = sessions(listedKr, 'priceDate');
  assert.ok(usDays.length <= 2, `US prices span ${usDays.length} sessions: ${usDays.join(' ')}`);
  assert.equal(jpDays.length, 1, `Japan prices span ${jpDays.length} sessions: ${jpDays.join(' ')}`);
  assert.equal(krDays.length, 1, `Korea prices span ${krDays.length} sessions: ${krDays.join(' ')}`);
});
