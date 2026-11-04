// Hong Kong ratio maths — pure, fixture-based, no network.
//
// The extra thing this market has to get right is the two currencies: the price is HKD, the statement
// can be in CNY or USD, and a ratio that mixes the two is not a ratio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHongKong } from '../scripts/derive-hongkong.mjs';

const fx = { rate: 7.8, rates: { HKD: 7.8, CNY: 6.5, USD: 1 } };
const base = {
  code: '0700', ticker: '0700', name: 'TENCENT', nameEn: 'Tencent Holdings', sector: 'Communication Services',
  price: 100, shares: 1e9, marketCap: 1e11, reportCurrency: 'HKD',
  ttm: { revenue: 5e10, operatingProfit: 2e10, netIncome: 1e10, operatingCashFlow: 1.5e10, investingCashFlow: -5e9, dividendPerShare: 1 },
  latest: { equity: 4e10, assets: 1e11, liabilities: 6e10 },
  annual: [
    { end: '2021-12-31', revenue: 2e10, operatingProfit: 6e9, netIncome: 3e9, equity: 2.5e10, assets: 6e10, eps: 3 },
    { end: '2022-12-31', revenue: 3e10, operatingProfit: 9e9, netIncome: 5e9, equity: 3e10, assets: 7e10, eps: 5 },
    { end: '2023-12-31', revenue: 3.5e10, operatingProfit: 1.1e10, netIncome: 6e9, equity: 3.4e10, assets: 8e10, eps: 6 },
    { end: '2024-12-31', revenue: 4e10, operatingProfit: 1.5e10, netIncome: 8e9, equity: 3.7e10, assets: 9e10, eps: 8 },
    { end: '2025-12-31', revenue: 4.5e10, operatingProfit: 1.8e10, netIncome: 9e9, equity: 4e10, assets: 1e11, eps: 9 },
  ],
  quarters: [{ d: '2026-06-30', revenue: 1.4e10, operatingProfit: 6e9, netIncome: 3e9 }],
  yearEnd: { 2021: 45, 2022: 60, 2023: 72, 2024: 88, 2025: 99 },
};

test('a HKD reporter divides the HKD cap by HKD earnings', () => {
  const [c] = deriveHongKong({ companies: [base], fx });
  assert.equal(c.pe, 10);              // 1e11 / 1e10
  assert.equal(c.pb, 2.5);             // 1e11 / 4e10
  assert.equal(c.roe, 25);             // 1e10 / 4e10
  assert.equal(c.opMargin, 40);
  assert.equal(c.netMargin, 20);
  assert.equal(c.fcf, 1e10);
  assert.equal(c.fcfYield, 10);
  assert.equal(c.dividendYield, 1);    // HK$1 on an HK$100 price
  assert.equal(c.peBasis, 'TTM');
  assert.equal(c.marketCapUsd, Math.round(1e11 / 7.8));
  assert.equal(c.history.length, 5);
  assert.equal(c.quarters.length, 1);
});

test('free cash flow uses the vendor FCF, not CFO + all investing flow', () => {
  const [c] = deriveHongKong({ companies: [{ ...base, ttm: { ...base.ttm, freeCashFlow: 1.2e10, capitalExpenditure: -2e9 } }], fx });
  assert.equal(c.fcf, 1.2e10);
  assert.equal(c.fcfYield, 12);
});

test('without a vendor FCF, free cash flow is CFO minus capex', () => {
  const [c] = deriveHongKong({ companies: [{ ...base, ttm: { ...base.ttm, capitalExpenditure: -3e9 } }], fx });
  assert.equal(c.fcf, 1.2e10);   // 1.5e10 − 3e9, not 1.5e10 + (−5e9)
});

test('dividend yield uses the annual DPS, not a trailing column that prints half a year', () => {
  const annual = base.annual.map((r, i) => (i === base.annual.length - 1 ? { ...r, dividendPerShare: 0.4 } : r));
  const [c] = deriveHongKong({ companies: [{ ...base, ttm: { ...base.ttm, dividendPerShare: 0.8 }, annual }], fx });
  assert.equal(c.dividendYield, 0.4);
  assert.equal(c.dividendYieldBasis, 'FY');
});

test('market cap uses current shares while the diluted filing count stays visible', () => {
  const [c] = deriveHongKong({ companies: [{ ...base, marketCap: undefined, sharesCurrent: 1.2e9 }], fx });
  assert.equal(c.marketCap, 1.2e11);
  assert.equal(c.shares, 1e9);
  assert.equal(c.sharesCurrent, 1.2e9);
  assert.equal(c.pe, 12);
});

test('a CNY reporter is valued in CNY, not in HKD', () => {
  const cny = { ...base, reportCurrency: 'CNY' };
  const [c] = deriveHongKong({ companies: [cny], fx });
  const cnyPerHkd = fx.rates.CNY / fx.rates.HKD;   // 0.8333 — CNY per HKD, the direction the cap needs
  assert.equal(c.pe, +(1e11 * cnyPerHkd / 1e10).toFixed(2));   // 8.33
  assert.equal(c.pb, +(1e11 * cnyPerHkd / 4e10).toFixed(2));   // 2.08
  assert.equal(c.roe, 25, 'ROE does not see the FX rate: both sides are CNY');
  assert.equal(c.marketCap, 1e11, 'the screen still shows the HKD cap');
  assert.equal(c.dividendYield, 1.2);  // CNY 1 × (HKD 7.8 / CNY 6.5) = HK$1.20 on an HK$100 price
});

test('without an FX table a foreign reporter gets blanks, not a wrong ratio', () => {
  const [c] = deriveHongKong({ companies: [{ ...base, reportCurrency: 'CNY' }], fx: null });
  assert.equal(c.pe, null);
  assert.equal(c.pb, null);
  assert.equal(c.fcfYield, null);
  assert.equal(c.dividendYield, null);
  assert.equal(c.roe, 25, 'the currency-free ratios still work');
});

test('a loss is no P/E, and negative equity is no ROE or P/B', () => {
  const [c] = deriveHongKong({
    companies: [{ ...base, ttm: { ...base.ttm, netIncome: -1e9 }, latest: { equity: -5e9 } }],
    fx,
  });
  assert.equal(c.pe, null);
  assert.equal(c.roe, null);
  assert.equal(c.pb, null);
});

test('a P/E built from a rounding artefact is not published', () => {
  const [c] = deriveHongKong({ companies: [{ ...base, ttm: { ...base.ttm, netIncome: 1 } }], fx });
  assert.equal(c.pe, null);
});

test('the five-year P/E band converts the price into the statement currency', () => {
  const [c] = deriveHongKong({ companies: [{ ...base, reportCurrency: 'CNY' }], fx });
  assert.ok(c.bands && c.bands.pe);
  assert.equal(c.bands.pe.n >= 3, true);
  assert.ok(c.bands.pe.min <= c.bands.pe.median && c.bands.pe.median <= c.bands.pe.max);
  assert.ok(c.bands.pe.percentile >= 0 && c.bands.pe.percentile <= 100);
});

test('missing statements stay blank rather than becoming zero', () => {
  const [c] = deriveHongKong({ companies: [{ ...base, ttm: {}, latest: {}, annual: [], quarters: [] }], fx });
  assert.equal(c.pe, null);
  assert.equal(c.pb, null);
  assert.equal(c.roe, null);
  assert.equal(c.opMargin, null);
  assert.equal(c.netMargin, null);
  assert.equal(c.history.length, 0);
});

// A bank's "free cash flow" is deposits and the loan book moving, not cash the business generated.
// The ratios do not exist for a balance-sheet financial, so they are marked and blanked rather than
// shipped as a huge negative number the company page would print as if it were real.
test('a bank or insurer gets no operating margin or free cash flow', () => {
  const bank = {
    ...base, sector: 'Financials', industry: 'Banks - Diversified',
    ttm: { ...base.ttm, operatingProfit: null, operatingCashFlow: -2e11, investingCashFlow: -1e11 },
  };
  const insurer = { ...base, sector: 'Financials', industry: 'Insurance - Life' };
  const [b, i] = deriveHongKong({ companies: [bank, insurer], fx });
  for (const c of [b, i]) {
    assert.equal(c.opMargin, null);
    assert.equal(c.fcf, null);
    assert.equal(c.fcfYield, null);
    assert.deepEqual(c.naRatios, ['opMargin', 'operatingProfit', 'fcf', 'fcfYield', 'operatingCashFlow']);
  }
  assert.equal(b.netMargin, 20, 'net margin still describes a bank');
  assert.equal(b.pb, 2.5, 'book value still describes a bank');
});

test('a fee-based financial keeps its operating ratios', () => {
  const broker = { ...base, sector: 'Financials', industry: 'Capital Markets' };
  const [c] = deriveHongKong({ companies: [broker], fx });
  assert.equal(c.opMargin, 40);
  assert.equal(c.fcf, 1e10);
  assert.equal(c.naRatios, undefined);
});
