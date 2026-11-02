// Korean ratio maths, verified against fixtures before any live data exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuartersKr, ttmKr, deriveKorea } from '../scripts/derive-korea.mjs';

// Figures in won, at a scale where the ratios are realistic: 45bn revenue, 5bn net profit.
const B = 1e9;
const reports = [
  { report: 'q1', end: '2025-03-31', revenue: 10 * B, operatingProfit: 2 * B, netIncome: 1.2 * B, equity: 50 * B, assets: 120 * B },
  { report: 'h1', end: '2025-06-30', revenue: 12 * B, operatingProfit: 2.4 * B, netIncome: 1.4 * B },
  { report: 'q3', end: '2025-09-30', revenue: 11 * B, operatingProfit: 2.2 * B, netIncome: 1.3 * B },
  { report: 'annual', end: '2025-12-31', revenue: 45 * B, operatingProfit: 9 * B, netIncome: 5 * B, equity: 50 * B, assets: 120 * B, operatingCashFlow: 9 * B, investingCashFlow: -3 * B },
];

test('DART interim figures are already standalone quarters; Q4 is the annual less the first three', () => {
  const q = buildQuartersKr(reports);
  assert.deepEqual(q.map((x) => x.revenue / B), [10, 12, 11, 12]);
  assert.deepEqual(q.map((x) => x.operatingProfit / B), [2, 2.4, 2.2, 2.4]);
  assert.deepEqual(q.map((x) => x.netIncome / B), [1.2, 1.4, 1.3, 1.1]);
  assert.deepEqual(q.map((x) => x.d), ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31']);
  assert.equal(q[3].q, 'Q4');
});

test('TTM is the last four standalone quarters', () => {
  const t = ttmKr(buildQuartersKr(reports));
  assert.equal(t.revenue, 45 * B);
  assert.equal(t.operatingProfit, 9 * B);
  assert.equal(t.netIncome, 5 * B);
  assert.equal(t.basis, 'TTM');
});

test('a gap in the quarter series falls back to the fiscal year', () => {
  // Q1 2026 is missing, so these four rows would cover fifteen months, not twelve.
  const t = ttmKr([
    { d: '2025-06-30', revenue: 1, netIncome: 1 },
    { d: '2025-09-30', revenue: 1, netIncome: 1 },
    { d: '2025-12-31', revenue: 1, netIncome: 1 },
    { d: '2026-09-30', revenue: 1, netIncome: 1 },
  ]);
  assert.equal(t.basis, 'FY');
  assert.equal(t.netIncome, null);
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

test('a bank with no revenue line still gets its quarters and TTM profit', () => {
  const bank = [
    { report: 'q1', end: '2025-03-31', netIncome: 1 * B, equity: 50 * B },
    { report: 'h1', end: '2025-06-30', netIncome: 1.1 * B },
    { report: 'q3', end: '2025-09-30', netIncome: 1.2 * B },
    { report: 'annual', end: '2025-12-31', netIncome: 4.5 * B, equity: 50 * B },
  ];
  const q = buildQuartersKr(bank);
  assert.deepEqual(q.map((x) => x.netIncome / B), [1, 1.1, 1.2, 1.2]);
  assert.equal(ttmKr(q).netIncome, 4.5 * B);
  const [c] = deriveKorea({ companies: [{ ticker: '105560', name: 'Bank', price: 50000, shares: 2e6, reports: bank }] });
  assert.equal(c.peBasis, 'TTM');
  assert.equal(c.netMargin, null, 'no revenue line means no margin, not a fiscal-year revenue denominator');
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
