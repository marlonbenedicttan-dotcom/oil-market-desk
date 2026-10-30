// Korean ratio maths, verified against fixtures before any live data exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuartersKr, ttmKr, deriveKorea } from '../scripts/derive-korea.mjs';

// Figures in won, at a scale where the ratios are realistic: 40bn revenue, 5bn net profit.
const B = 1e9;
const reports = [
  { report: 'q1', end: '2025-03-31', revenue: 10 * B, operatingProfit: 2 * B, netIncome: 1.2 * B, equity: 50 * B, assets: 120 * B },
  { report: 'h1', end: '2025-06-30', revenue: 20 * B, operatingProfit: 4 * B, netIncome: 2.4 * B },
  { report: 'q3', end: '2025-09-30', revenue: 30 * B, operatingProfit: 6 * B, netIncome: 3.6 * B },
  { report: 'annual', end: '2025-12-31', revenue: 40 * B, operatingProfit: 8 * B, netIncome: 5 * B, equity: 50 * B, assets: 120 * B, operatingCashFlow: 9 * B, investingCashFlow: -3 * B },
];

test('cumulative Korean figures become standalone quarters, with the annual as Q4', () => {
  const q = buildQuartersKr(reports);
  assert.deepEqual(q.map((x) => x.revenue / B), [10, 10, 10, 10]);
  assert.deepEqual(q.map((x) => x.netIncome / B), [1.2, 1.2, 1.2, 1.4]);
  assert.deepEqual(q.map((x) => x.d), ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31']);
  assert.equal(q[3].q, 'Q4');
});

test('TTM is the last four standalone quarters', () => {
  const t = ttmKr(buildQuartersKr(reports));
  assert.equal(t.revenue, 40 * B);
  assert.equal(t.netIncome, 5 * B);
  assert.equal(t.basis, 'TTM');
});

test('ratios come from market cap, and P/E uses TTM earnings', () => {
  // 2m shares at ₩50,000 = ₩100bn cap; TTM profit ₩5bn → P/E 20; equity ₩50bn → P/B 2.
  const [c] = deriveKorea({ companies: [{ ticker: '005930', name: 'Test', price: 50000, shares: 2e6, reports }], fx: 1400 });
  assert.equal(c.marketCap, 1e11);
  assert.equal(c.marketCapUsd, Math.round(1e11 / 1400));
  assert.equal(c.pe, 20);
  assert.equal(c.peBasis, 'TTM');
  assert.equal(c.pb, 2);
  assert.equal(c.roe, 10);
  assert.equal(c.opMargin, 20);
  assert.equal(c.fcf, 6 * B, 'operating plus investing cash flow');
});

test('a loss-maker has no P/E but keeps the negative earnings', () => {
  const loss = [{ report: 'annual', end: '2025-12-31', revenue: 100, operatingProfit: -5, netIncome: -9, equity: 50, assets: 200, operatingCashFlow: 3, investingCashFlow: -2 }];
  const [c] = deriveKorea({ companies: [{ ticker: 'X', price: 10, shares: 10, reports: loss }] });
  assert.equal(c.pe, null);
  assert.equal(c.roe, +((-9 / 50) * 100).toFixed(1));
  assert.equal(c.peBasis, 'FY');
});

test('a young company with fewer than four quarters falls back to the fiscal year', () => {
  const partial = [{ report: 'annual', end: '2025-12-31', revenue: 80 * B, operatingProfit: 8 * B, netIncome: 6 * B, equity: 40 * B, assets: 120 * B, operatingCashFlow: 9 * B, investingCashFlow: -4 * B }];
  const [c] = deriveKorea({ companies: [{ ticker: 'Y', price: 50000, shares: 2e6, reports: partial }] });
  assert.equal(c.peBasis, 'FY');
  assert.equal(c.pe, +(1e11 / (6 * B)).toFixed(2));
});
