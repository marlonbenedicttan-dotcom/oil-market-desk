// Regression tests for the company dataset.
//
// These encode the *classes* of bug that were found and fixed, not exact numbers, so a new filing can
// update the data without breaking the suite — but the specific failures cannot come back silently.
//
//   node --test tests/companies-data.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../data/companies.json', import.meta.url), 'utf8'));
const by = Object.fromEntries(data.companies.filter((c) => c.ticker).map((c) => [c.ticker, c]));

test('universe is 503 securities across 500 companies', () => {
  assert.equal(data.companies.length, 503);
  assert.equal(new Set(data.companies.filter((c) => c.cik).map((c) => c.cik)).size, 500);
});

test('every row has the identity fields the UI needs', () => {
  for (const c of data.companies) {
    assert.ok(c.ticker, 'ticker');
    assert.ok(c.cik, `cik for ${c.ticker}`);
    assert.ok(c.sector, `sector for ${c.ticker}`);
    assert.ok(c.price > 0, `price for ${c.ticker}`);
    assert.ok(c.marketCap > 0, `market cap for ${c.ticker}`);
  }
});

test('a fiscal year is not mistaken for a quarter (Ford FY2025 loss)', () => {
  const f = by.F;
  assert.ok(f, 'F present');
  assert.ok(f.netIncome < 0, `Ford FY2025 must be a loss, got ${f.netIncome}`);
  assert.ok(f.netIncome > -2e10, 'Ford loss is not absurd');
});

test('revenue is a total, not a component (MetLife)', () => {
  const met = by.MET;
  assert.ok(met.revenue > 5e10, `MetLife revenue must exceed $50B, got ${met.revenue}`);
});

test('a tag that stopped being used does not keep its old value (Broadcom)', () => {
  const avgo = by.AVGO;
  assert.ok(avgo.netIncome > 1.5e10, `Broadcom earnings must exceed $15B, got ${avgo.netIncome}`);
  assert.ok(avgo.pe == null || avgo.pe < 100, `Broadcom P/E must not be the 260x artifact, got ${avgo.pe}`);
});

test('the CIK maps to the live registrant (DTE)', () => {
  assert.equal(String(by.DTE.cik), '936340');
});

test('balance sheet belongs to the earnings year (AutoZone)', () => {
  const azo = by.AZO;
  assert.ok(azo.assets > 2e10, `AutoZone assets must exceed $20B, got ${azo.assets}`);
});

test('share classes share a CIK but not a market cap', () => {
  for (const [cls, sib] of [['GOOG', 'GOOGL'], ['FOX', 'FOXA'], ['NWS', 'NWSA']]) {
    const a = by[cls], b = by[sib];
    assert.ok(a && b, `${cls}/${sib} present`);
    assert.equal(a.cik, b.cik, `${cls} shares the CIK of ${sib}`);
    assert.ok(a.shareClass, `${cls} is marked as a share class`);
    assert.notEqual(a.marketCap, b.marketCap, `${cls} has its own market cap`);
  }
});

test('a TTM figure is plausible against revenue', () => {
  // A profit can turn into a loss (impairment) — that is real. Earnings above revenue are not, and a
  // loss beyond three times revenue means the tags belong to different scopes.
  for (const c of data.companies) {
    if (c.netIncomeTTM == null || !c.revenue) continue;
    assert.ok(c.netIncomeTTM <= c.revenue * 1.2, `${c.ticker}: TTM above revenue`);
    assert.ok(c.netIncomeTTM >= c.revenue * -3, `${c.ticker}: TTM loss beyond 3x revenue`);
  }
});

test('P/E on TTM always has a TTM figure behind it', () => {
  for (const c of data.companies) {
    if (c.peBasis === 'TTM') assert.ok(c.netIncomeTTM != null, `${c.ticker}: TTM P/E without TTM earnings`);
    if (c.pe != null) assert.ok(c.pe > 0 && c.pe < 2000, `${c.ticker}: P/E ${c.pe}`);
  }
});

test('no company has revenue above its own assets by an absurd factor', () => {
  for (const c of data.companies) {
    if (!c.revenue || !c.assets) continue;
    assert.ok(c.revenue < c.assets * 20, `${c.ticker}: revenue ${c.revenue} vs assets ${c.assets}`);
  }
});

test('descriptions are sentences, not table-of-contents residue', () => {
  const residue = /(Item\s+\d+[A-Z]?\.|PART\s+I{1,3}\b|Mine Safety Disclosures|Table of Contents|Market for Registrant)/i;
  for (const c of data.companies) {
    if (!c.description) continue;
    assert.ok(!residue.test(c.description), `${c.ticker}: ${c.description.slice(0, 60)}`);
    assert.ok(/^[A-Za-z0-9"“]/.test(c.description), `${c.ticker}: starts with punctuation`);
  }
});

test('a company with no annual report is flagged, not faked', () => {
  const vy = by.VYLR;
  assert.ok(vy.noFilings, 'VYLR is marked noFilings');
  assert.ok(vy.revenue == null, 'VYLR has no revenue');
});

test('a restatement keeps both figures and the amended one wins', () => {
  for (const c of data.companies) {
    if (!c.restatement) continue;
    const changes = c.restatement.changes || {};
    assert.ok(Object.keys(changes).length > 0, `${c.ticker}: restatement with no change recorded`);
    assert.ok(c.restatement.filed, `${c.ticker}: restatement without a filing date`);
    for (const [f, v] of Object.entries(changes)) {
      assert.equal(c[f], v.now, `${c.ticker}: ${f} should hold the amended value`);
    }
  }
});

test('free cash flow is cash, not a second earnings figure', () => {
  for (const c of data.companies) {
    if (c.fcf == null) continue;
    assert.ok(c.operatingCashFlow != null, `${c.ticker}: FCF without operating cash flow`);
    assert.ok(c.fcf <= c.operatingCashFlow + 1, `${c.ticker}: FCF above operating cash flow`);
    if (c.revenue) assert.ok(Math.abs(c.fcf) <= c.revenue * 2, `${c.ticker}: FCF implausible vs revenue`);
  }
  assert.ok(by.AAPL.fcf > 5e10, 'Apple free cash flow should exceed $50B');
});

test('banks have no free cash flow but do have a margin', () => {
  assert.ok(by.JPM.fcfNA, 'JPM FCF is marked n/a');
  assert.equal(by.JPM.fcf, null, 'JPM FCF is null');
  assert.notEqual(by.AXP.marginNA, true, 'Amex margin is computable');
});

test('the quarterly series is chronological, capped at eight, and never empty', () => {
  for (const c of data.companies) {
    const q = c.quarters || [];
    if (!q.length) continue;
    assert.ok(q.length <= 8, `${c.ticker}: ${q.length} quarters`);
    const ends = q.map((x) => x.end);
    assert.deepEqual(ends, [...ends].sort(), `${c.ticker}: quarters out of order`);
    for (const x of q) assert.ok(x.revenue != null || x.netIncome != null, `${c.ticker}: empty quarter ${x.end}`);
  }
});

test('a valuation band is ordered and its percentile is in range', () => {
  for (const c of data.companies) {
    const h = c.peHistory;
    if (!h) continue;
    assert.ok(h.min <= h.median && h.median <= h.max, `${c.ticker}: band ${h.min}/${h.median}/${h.max}`);
    if (h.percentile != null) assert.ok(h.percentile >= 0 && h.percentile <= 100, `${c.ticker}: percentile ${h.percentile}`);
    for (const y of h.years) assert.ok(y.pe > 0, `${c.ticker}: FY${y.fy} P/E ${y.pe}`);
  }
});

test('the index valuation carries a current P/E and a history', () => {
  const v = JSON.parse(readFileSync(new URL('../data/valuation.json', import.meta.url), 'utf8'));
  assert.ok(v.index.pe > 5 && v.index.pe < 100, `index P/E ${v.index.pe}`);
  assert.ok(v.index.years.length >= 3, 'at least three years of history');
  assert.ok(v.index.min <= v.index.max);
});

test('the index weights sum to about 100', () => {
  const sum = data.companies.reduce((a, c) => a + (c.indexWeight || 0), 0);
  assert.ok(sum > 99 && sum < 101, `weights sum to ${sum}`);
});
