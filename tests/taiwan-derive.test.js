// Taiwan ratio maths — pure, fixture-based, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTaiwan } from '../scripts/derive-taiwan.mjs';

const base = {
  code: '2330', ticker: '2330', name: '台積電', nameEn: 'TSMC', sector: 'Semiconductors',
  price: 100, shares: 1e9, marketCap: 1e11,
  ttm: { revenue: 5e10, operatingProfit: 2e10, netIncome: 1e10, operatingCashFlow: 1.5e10, investingCashFlow: -5e9 },
  latest: { equity: 4e10, assets: 1e11, liabilities: 6e10 },
  annual: [
    { end: '2021-12-31', revenue: 2e10, operatingProfit: 6e9, netIncome: 3e9, equity: 2.5e10, assets: 6e10, eps: 3 },
    { end: '2022-12-31', revenue: 3e10, operatingProfit: 9e9, netIncome: 5e9, equity: 3e10, assets: 7e10, eps: 5 },
    { end: '2023-12-31', revenue: 3.5e10, operatingProfit: 1.1e10, netIncome: 6e9, equity: 3.4e10, assets: 8e10, eps: 6 },
    { end: '2024-12-31', revenue: 4e10, operatingProfit: 1.5e10, netIncome: 8e9, equity: 3.7e10, assets: 9e10, eps: 8 },
    { end: '2025-12-31', revenue: 4.5e10, operatingProfit: 1.8e10, netIncome: 9e9, equity: 4e10, assets: 1e11, eps: 9 },
  ],
  quarters: [{ d: '2026-09-30', revenue: 1.4e10, operatingProfit: 6e9, netIncome: 3e9 }],
  yearEnd: { 2021: 45, 2022: 60, 2023: 72, 2024: 88, 2025: 99 },
};

test('TTM ratios use market cap, TTM profit and the latest balance sheet', () => {
  const [c] = deriveTaiwan({ companies: [base], fx: 32 });
  assert.equal(c.pe, 10);              // 1e11 / 1e10
  assert.equal(c.pb, 2.5);             // 1e11 / 4e10
  assert.equal(c.roe, 25);             // 1e10 / 4e10
  assert.equal(c.opMargin, 40);        // 2e10 / 5e10
  assert.equal(c.netMargin, 20);       // 1e10 / 5e10
  assert.equal(c.fcf, 1e10);           // 1.5e10 - 5e9
  assert.equal(c.fcfYield, 10);        // 1e10 / 1e11
  assert.equal(c.peBasis, 'TTM');
  assert.equal(c.marketCapUsd, Math.round(1e11 / 32));
  assert.equal(c.history.length, 5);
  assert.equal(c.quarters.length, 1);
});

test('a loss is no P/E, and negative equity is no ROE or P/B', () => {
  const [c] = deriveTaiwan({
    companies: [{ ...base, ttm: { ...base.ttm, netIncome: -1e9 }, latest: { equity: -5e9 } }],
  });
  assert.equal(c.pe, null);
  assert.equal(c.roe, null);
  assert.equal(c.pb, null);
});

test('a P/E built from a rounding artefact is not published', () => {
  const [c] = deriveTaiwan({ companies: [{ ...base, ttm: { ...base.ttm, netIncome: 1 } }] });
  assert.equal(c.pe, null);
});

test('the five-year P/E band uses year-end price over diluted EPS', () => {
  const [c] = deriveTaiwan({ companies: [base] });
  assert.ok(c.bands && c.bands.pe);
  assert.equal(c.bands.pe.n >= 3, true);
  assert.ok(c.bands.pe.min <= c.bands.pe.median && c.bands.pe.median <= c.bands.pe.max);
  assert.ok(c.bands.pe.percentile >= 0 && c.bands.pe.percentile <= 100);
});

test('missing statements stay blank rather than becoming zero', () => {
  const [c] = deriveTaiwan({ companies: [{ ...base, ttm: {}, latest: {}, annual: [], quarters: [] }] });
  assert.equal(c.pe, null);
  assert.equal(c.pb, null);
  assert.equal(c.roe, null);
  assert.equal(c.opMargin, null);
  assert.equal(c.netMargin, null);
  assert.equal(c.history.length, 0);
});
