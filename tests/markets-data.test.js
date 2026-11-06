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

test('prices are current and not a half-finished refresh', () => {
  // The quote endpoint rolls over symbol by symbol, so a file built during the rollover can hold two
  // adjacent sessions; a dormant name can sit further back. What must not happen is a cohort left on
  // an older date (a half-finished refresh), or a file built on last week's session.
  const check = (rows, field, label) => {
    const days = rows.map((c) => c[field]).filter(Boolean);
    assert.ok(days.length, `${label}: prices are dated`);
    const counts = new Map();
    for (const d of days) counts.set(d, (counts.get(d) || 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const [modal, modalCount] = ranked[0];
    const spread = ranked.map(([d, n]) => `${d}×${n}`).join(' ');
    const age = (Date.now() - Date.parse(modal)) / 864e5;
    assert.ok(age <= 4, `${label}: built on ${modal}, ${age.toFixed(1)} days old — ${spread}`);
    assert.ok(modalCount / days.length >= 0.5, `${label}: no session dominates — ${spread}`);
    // One day apart is the rollover. Further back is a straggler, and a real cohort of them means the
    // refresh stopped halfway.
    const stragglers = ranked.slice(1)
      .filter(([d]) => Math.abs(Date.parse(d) - Date.parse(modal)) > 864e5)
      .reduce((a, [, n]) => a + n, 0);
    assert.ok(stragglers / days.length <= 0.01, `${label}: ${stragglers} prices more than a session behind ${modal} — ${spread}`);
  };
  check(listedUs, 'priceAsOf', 'US');
  check(listedJp, 'priceDate', 'Japan');
  check(listedKr, 'priceDate', 'Korea');
});
