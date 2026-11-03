// Australia ratio maths — pure, fixture-based, no network.
//
// The extra thing this market has to get right is the two currencies: the price is AUD, but BHP and
// RIO report in USD (and a few issuers in EUR/GBP). A ratio that mixes the two is not a ratio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveListing } from '../scripts/derive-listing.mjs';
import { deriveHongKong } from '../scripts/derive-hongkong.mjs';

const fx = { rate: 1.5, rates: { AUD: 1.5, USD: 1, EUR: 0.9, GBP: 0.8 } };
const base = {
  code: 'BHP', ticker: 'BHP', name: 'BHP GROUP LIMITED', nameEn: 'BHP Group', sector: 'Materials',
  price: 10, shares: 1e8, marketCap: 1e9, reportCurrency: 'AUD',
  ttm: { revenue: 5e8, operatingProfit: 2e8, netIncome: 1e8, operatingCashFlow: 1.5e8, investingCashFlow: -5e7, dividendPerShare: 0.5 },
  latest: { equity: 4e8, assets: 1e9, liabilities: 6e8 },
  annual: [
    { end: '2021-06-30', revenue: 2e8, operatingProfit: 6e7, netIncome: 3e7, equity: 2.5e8, assets: 6e8, eps: 0.3 },
    { end: '2022-06-30', revenue: 3e8, operatingProfit: 9e7, netIncome: 5e7, equity: 3e8, assets: 7e8, eps: 0.5 },
    { end: '2023-06-30', revenue: 3.5e8, operatingProfit: 1.1e8, netIncome: 6e7, equity: 3.4e8, assets: 8e8, eps: 0.6 },
    { end: '2024-06-30', revenue: 4e8, operatingProfit: 1.5e8, netIncome: 8e7, equity: 3.7e8, assets: 9e8, eps: 0.8 },
    { end: '2025-06-30', revenue: 4.5e8, operatingProfit: 1.8e8, netIncome: 9e7, equity: 4e8, assets: 1e9, eps: 0.9 },
  ],
  quarters: [{ d: '2026-06-30', revenue: 1.4e8, operatingProfit: 6e7, netIncome: 3e7 }],
  yearEnd: { 2021: 4.5, 2022: 6, 2023: 7.2, 2024: 8.8, 2025: 9.9 },
};

const derive = (c, f = fx) => deriveListing({ companies: [c], fx: f, baseCurrency: 'AUD' })[0];

test('an AUD reporter divides the AUD cap by AUD earnings', () => {
  const c = derive(base);
  assert.equal(c.pe, 10);              // 1e9 / 1e8
  assert.equal(c.pb, 2.5);             // 1e9 / 4e8
  assert.equal(c.roe, 25);             // 1e8 / 4e8
  assert.equal(c.opMargin, 40);
  assert.equal(c.netMargin, 20);
  assert.equal(c.fcf, 1e8);
  assert.equal(c.fcfYield, 10);
  assert.equal(c.dividendYield, 5);    // A$0.50 on an A$10 price
  assert.equal(c.peBasis, 'TTM');
  assert.equal(c.currency, 'AUD');
  assert.equal(c.marketCapUsd, Math.round(1e9 / 1.5));
  assert.equal(c.history.length, 5);
  assert.equal(c.quarters.length, 1);
});

test('a USD reporter is valued in USD, not in AUD', () => {
  const c = derive({ ...base, reportCurrency: 'USD' });
  const usdPerAud = fx.rates.USD / fx.rates.AUD;   // 0.6667 — the direction the cap needs
  assert.equal(c.pe, +(1e9 * usdPerAud / 1e8).toFixed(2));   // 6.67
  assert.equal(c.pb, +(1e9 * usdPerAud / 4e8).toFixed(2));   // 1.67
  assert.equal(c.roe, 25, 'ROE does not see the FX rate: both sides are USD');
  assert.equal(c.marketCap, 1e9, 'the screen still shows the AUD cap');
  assert.equal(c.dividendYield, 7.5);  // US$0.50 × (AUD 1.5 / USD 1) = A$0.75 on an A$10 price
});

test('an EUR reporter uses the EUR cross, not the USD one', () => {
  const c = derive({ ...base, reportCurrency: 'EUR' });
  const eurPerAud = fx.rates.EUR / fx.rates.AUD;
  assert.equal(c.pe, +(1e9 * eurPerAud / 1e8).toFixed(2));
});

test('without an FX table a foreign reporter gets blanks, not a wrong ratio', () => {
  const c = derive({ ...base, reportCurrency: 'USD' }, null);
  assert.equal(c.pe, null);
  assert.equal(c.pb, null);
  assert.equal(c.fcfYield, null);
  assert.equal(c.dividendYield, null);
  assert.equal(c.roe, 25, 'the currency-free ratios still work');
});

test('a loss is no P/E, and negative equity is no ROE or P/B', () => {
  const c = derive({ ...base, ttm: { ...base.ttm, netIncome: -1e8 }, latest: { equity: -5e8 } });
  assert.equal(c.pe, null);
  assert.equal(c.roe, null);
  assert.equal(c.pb, null);
});

test('a P/E built from a rounding artefact is not published', () => {
  const c = derive({ ...base, ttm: { ...base.ttm, netIncome: 1 } });
  assert.equal(c.pe, null);
});

test('the five-year P/E band converts the price into the statement currency', () => {
  const c = derive({ ...base, reportCurrency: 'USD' });
  assert.ok(c.bands && c.bands.pe);
  assert.equal(c.bands.pe.n >= 3, true);
  assert.ok(c.bands.pe.min <= c.bands.pe.median && c.bands.pe.median <= c.bands.pe.max);
  assert.ok(c.bands.pe.percentile >= 0 && c.bands.pe.percentile <= 100);
});

test('missing statements stay blank rather than becoming zero', () => {
  const c = derive({ ...base, ttm: {}, latest: {}, annual: [], quarters: [] });
  assert.equal(c.pe, null);
  assert.equal(c.pb, null);
  assert.equal(c.roe, null);
  assert.equal(c.opMargin, null);
  assert.equal(c.netMargin, null);
  assert.equal(c.history.length, 0);
});

test('Hong Kong still derives through the shared engine', () => {
  const [c] = deriveHongKong({ companies: [{ ...base, currency: 'HKD', reportCurrency: 'HKD' }], fx: { rate: 7.8, rates: { HKD: 7.8 } } });
  assert.equal(c.currency, 'HKD');
  assert.equal(c.pe, 10);
});
