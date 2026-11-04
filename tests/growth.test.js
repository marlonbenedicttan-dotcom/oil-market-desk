// Growth rates are shared by the US and Japan pages, so the rules are tested once here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { growthRates, fromJapanHistory, growthFromAnnuals, marginDeltaFromAnnuals, growthFromUsSeries } from '../src/growth.js';

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

test('an EPS that was not reported at an end is named, not called a loss', () => {
  const g = growthRates([
    { year: 2022, revenue: 100, eps: null, shares: 1000 },
    { year: 2026, revenue: 200, eps: 20, shares: 1000 },
  ]);
  assert.equal(g.epsCagr, null);
  assert.equal(g.epsCagrNA, 'EPS was not reported in the first or last year');
  assert.equal(g.epsChange, undefined);
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

test('the CAGR follows a longer merged record, not a fixed five years', () => {
  // merge-history adds back the fiscal years that scrolled off the vendor's page; the span must grow
  // with them instead of the rate staying a four-year number forever.
  const g = growthRates([
    sh(2021, 90, 9),
    sh(2022, 100, 10),
    sh(2023, 110, 10.5),
    sh(2024, 115, 11),
    sh(2025, 120, 11.5),
    sh(2026, 121.550625, 12.1550625),
  ]);
  assert.equal(g.cagrYears, 5);
  assert.equal(g.revenueCagr, 6.2);
  assert.equal(g.epsCagr, 6.2);
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

test('annual statements use the per-year share count to adjust for a split', () => {
  const g = growthFromAnnuals([
    { end: '2022-12-31', revenue: 100, eps: 10, shares: 1000 },
    { end: '2023-12-31', revenue: 110, eps: 5.5, shares: 2000 }, // 2-for-1 split
    { end: '2024-12-31', revenue: 121, eps: 6.05, shares: 2000 },
    { end: '2025-12-31', revenue: 133.1, eps: 6.655, shares: 2000 },
    { end: '2026-12-31', revenue: 146.41, eps: 7.3205, shares: 2000 },
  ]);
  assert.equal(g.cagrYears, 4);
  assert.equal(g.revenueCagr, 10);
  assert.equal(g.epsCagr, 10);
  assert.equal(g.epsSplitAdjusted, true);
});

test('annual statements without a share column derive it from net income ÷ EPS', () => {
  const g = growthFromAnnuals([
    { end: '2022-12-31', revenue: 100, netIncome: 10, eps: 10 },
    { end: '2023-12-31', revenue: 110, netIncome: 11.5, eps: 5.75 }, // 2-for-1 split
    { end: '2024-12-31', revenue: 121, netIncome: 12.65, eps: 6.325 },
  ]);
  assert.equal(g.cagrYears, 2);
  assert.equal(g.epsCagr, 12.5);
  assert.equal(g.epsSplitAdjusted, true);
});

test('net margin change uses the same annual window as the CAGR', () => {
  assert.equal(marginDeltaFromAnnuals([
    { end: '2022-12-31', revenue: 100, netIncome: 10 },
    { end: '2026-12-31', revenue: 200, netIncome: 30 },
  ]), 5);
  assert.equal(marginDeltaFromAnnuals([{ end: '2026-12-31', revenue: 100, netIncome: 10 }]), null);
});

test('US annual growth follows the merged series with as-filed EPS', () => {
  const series = [
    { fy: 2021, revenue: 100, netIncome: 10, eps: 1 },
    { fy: 2022, revenue: 110, netIncome: 11, eps: 1.1 },
    { fy: 2023, revenue: 121, netIncome: 12.1, eps: 1.21 },
    { fy: 2024, revenue: 133.1, netIncome: 13.31, eps: 1.331 },
    { fy: 2025, revenue: 146.41, netIncome: 14.641, eps: 1.4641 },
    { fy: 2026, revenue: 161.051, netIncome: 16.1051, eps: 1.61051 },
  ];
  const g = growthFromUsSeries(series, 10);
  assert.equal(g.cagrYears, 5);
  assert.equal(g.revenueCagr, 10);
  assert.equal(g.epsCagr, 10);
  assert.equal(g.marginDelta, 0);
});

test('US series fills a missing EPS from net income and reports a loss move', () => {
  const g = growthFromUsSeries([
    { fy: 2022, revenue: 100, netIncome: -10, eps: null },
    { fy: 2023, revenue: 110, netIncome: 5, eps: null },
    { fy: 2024, revenue: 121, netIncome: 15, eps: null },
    { fy: 2025, revenue: 133.1, netIncome: 20, eps: null },
    { fy: 2026, revenue: 146.41, netIncome: 25, eps: null },
  ], 1000);
  assert.equal(g.epsCagr, null);
  assert.equal(g.epsCagrNA, 'a loss in the first or last year');
  assert.equal(g.epsChange.from, -0.01);
  assert.equal(g.epsChange.to, 0.03);
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
