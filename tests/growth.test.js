// Growth rates are shared by the US and Japan pages, so the rules are tested once here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { growthRates, fromJapanHistory } from '../src/growth.js';

// A flat share count means no split: buybacks and small issuance are not adjustments.
const sh = (year, revenue, eps) => ({ year, revenue, eps, shares: 1000 });

test('a five-year record gives a compound annual rate over the span, not the number of rows', () => {
  // 100 → 121.550625 over four years is exactly 5.0% a year.
  const g = growthRates([
    sh(2026, 121.550625, 12.1550625),
    sh(2022, 100, 10),
    sh(2023, 110, 10.5),
    sh(2024, 115, 11),
    sh(2025, 120, 11.5),
  ]);
  assert.equal(g.revenueCagr, 5);
  assert.equal(g.epsCagr, 5);
  assert.equal(g.cagrYears, 4);
  assert.equal(g.cagrNA, null);
  assert.equal(g.epsCagrNA, null);
  assert.equal(g.epsSplitAdjusted, false);
  assert.equal(g.epsSplitUnverified, false);
});

test('a loss at either end has no CAGR, and the change is shown instead', () => {
  const g = growthRates([
    sh(2022, 100, -2),
    sh(2023, 110, 0),
    sh(2024, 120, 1),
    sh(2025, 130, 2),
    sh(2026, 140, 3),
  ]);
  assert.equal(g.epsCagr, null);
  assert.equal(g.epsCagrNA, 'a loss in the first or last year');
  assert.deepEqual(g.epsChange, { from: -2, to: 3, years: 4, fromFy: 2022, toFy: 2026 });
});

test('fewer than two years of span is "history too short", never a number', () => {
  const g = growthRates([sh(2025, 100, 10), sh(2026, 120, 12)]);
  assert.equal(g.revenueCagr, null);
  assert.equal(g.cagrYears, null);
  assert.equal(g.cagrNA, 'history too short');
  assert.equal(g.epsChange, undefined);
});

test('zero or missing revenue is not treated as growth', () => {
  const g = growthRates([sh(2022, 0, 1), sh(2026, 100, 2)]);
  assert.equal(g.revenueCagr, null);
  assert.equal(g.cagrNA, 'revenue was not positive in both years');
});

test('Japan history maps y/s/e/sh and keeps a missing year out of the window', () => {
  const rows = fromJapanHistory([
    { y: '2022-03-31', s: 100, e: -5, sh: 1000 },
    { y: null, s: 999, e: 999, sh: 1 },
    { y: '2026-03-31', s: 140, e: 9, sh: 1000 },
  ]);
  assert.deepEqual(rows, [
    { year: 2022, revenue: 100, eps: -5, shares: 1000 },
    { year: null, revenue: 999, eps: 999, shares: 1 },
    { year: 2026, revenue: 140, eps: 9, shares: 1000 },
  ]);
  const g = growthRates(rows);
  assert.equal(g.cagrYears, 4);
  assert.equal(g.revenueCagr, 8.8);
  assert.equal(g.epsChange.to, 9);
});

test('a later split is adjusted out of the EPS series using average shares', () => {
  // Fast Retailing: a 3-for-1 split between FY2022 and FY2023. Raw EPS looks like −9.8% a year;
  // on the latest share basis it is +18.7%.
  const g = growthRates([
    { year: 2022, revenue: 2301122, eps: 2675.3, shares: 102170095 },
    { year: 2023, revenue: 2766557, eps: 966.09, shares: 306628124 },
    { year: 2024, revenue: 3103836, eps: 1212.88, shares: 306707010 },
    { year: 2025, revenue: 3400539, eps: 1411.44, shares: 306786602 },
    { year: 2026, revenue: 3963389, eps: 1768.08, shares: 306840049 },
  ]);
  assert.equal(g.epsSplitAdjusted, true);
  assert.equal(g.epsSplitUnverified, false);
  assert.equal(g.epsCagr, 18.7);
  assert.ok(g.epsCagr > 0, 'the split must not be published as a profit collapse');
});

test('without share counts the split check is flagged and the EPS figure withheld', () => {
  const g = growthRates([
    { year: 2022, revenue: 100, eps: 10 },
    { year: 2026, revenue: 200, eps: 20 },
  ]);
  assert.equal(g.epsCagr, null);
  assert.equal(g.epsCagrNA, 'share counts are missing, so splits cannot be adjusted for');
  assert.equal(g.epsChange, undefined);
  assert.equal(g.epsSplitAdjusted, false);
  assert.equal(g.epsSplitUnverified, true);
  assert.equal(g.revenueCagr, 18.9, 'revenue growth is still safe');
});
