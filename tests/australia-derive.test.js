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
  ttmEnd: '2026-06-30',
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
  assert.equal(c.fcfBasis, 'TTM');
  assert.equal(c.fcfYield, 10);
  assert.equal(c.fcfMargin, 20);       // 1e8 / 5e8
  assert.equal(c.cashConversion, 1);   // 1e8 / 1e8
  assert.equal(c.dividendYield, 5);    // A$0.50 on an A$10 price
  assert.equal(c.peBasis, 'TTM');
  assert.equal(c.netIncomeTTM, 1e8, 'the trailing profit the P/E is built on');
  assert.equal(c.netIncomeTTMAsOf, '2026-06-30');
  assert.equal(c.ttmFromFY, undefined, 'a real trailing figure is not labelled as a fiscal year');
  assert.equal(c.currency, 'AUD');
  assert.equal(c.marketCapUsd, Math.round(1e9 / 1.5));
  assert.equal(c.history.length, 5);
  assert.equal(c.quarters.length, 1);
});

test('a fiscal-year cash flow is labelled FY, not TTM', () => {
  const annual = base.annual.map((r) => ({ ...r, operatingCashFlow: 1.5e8, investingCashFlow: -5e7 }));
  const c = derive({ ...base, ttm: { revenue: 5e8, netIncome: 1e8, dividendPerShare: 0.5 }, annual });
  assert.equal(c.fcf, 1e8);
  assert.equal(c.fcfBasis, 'FY');
  assert.equal(c.fcfMargin, 20);
});

test('free cash flow uses the vendor FCF, not CFO + all investing flow', () => {
  const c = derive({ ...base, ttm: { ...base.ttm, freeCashFlow: 1.2e8, capitalExpenditure: -2e7 } });
  assert.equal(c.fcf, 1.2e8);
  assert.equal(c.fcfYield, 12);
});

test('without a vendor FCF, free cash flow is CFO minus capex', () => {
  const c = derive({ ...base, ttm: { ...base.ttm, capitalExpenditure: -3e7 } });
  assert.equal(c.fcf, 1.2e8);   // 1.5e8 − 3e7, not 1.5e8 + (−5e7)
});

test('dividend yield uses the annual DPS, not a trailing column that prints half a year', () => {
  const annual = base.annual.map((r, i) => (i === base.annual.length - 1 ? { ...r, dividendPerShare: 0.4 } : r));
  const c = derive({ ...base, ttm: { ...base.ttm, dividendPerShare: 0.8 }, annual });
  assert.equal(c.dividendYield, 4);   // A$0.40, not the 0.80 trailing column
  assert.equal(c.dividendYieldBasis, 'FY');
});

test('market cap uses current shares while the diluted filing count stays visible', () => {
  const c = derive({ ...base, marketCap: undefined, sharesCurrent: 1.2e8 });
  assert.equal(c.marketCap, 1.2e9);   // A$10 × 120m current
  assert.equal(c.shares, 1e8, 'the diluted filing count is still published');
  assert.equal(c.sharesCurrent, 1.2e8);
  assert.equal(c.sharesBasis, 'current (vendor)');
  assert.equal(c.pe, 12);             // 1.2e9 / 1e8
});

test('a vendor yield overrides the filed DPS conversion', () => {
  const c = derive({ ...base, vendorDividendYield: 6 });
  assert.equal(c.dividendYield, 6);
  assert.equal(c.dividendYieldBasis, 'vendor');
});

test('total equity is kept for vendor reconciliation, while P/B and ROE use common equity', () => {
  const c = derive({ ...base, latest: { equity: 5e8, equityCommon: 4e8 } });
  assert.equal(c.pb, 2.5);        // 1e9 ÷ 4e8 common
  assert.equal(c.pbTotal, 2);     // 1e9 ÷ 5e8 total
  assert.equal(c.roe, 25);        // 1e8 ÷ 4e8 common
  assert.equal(c.roeTotal, 20);   // 1e8 ÷ 5e8 total
  assert.equal(c.roeFY, 22.5);    // FY net income 9e7 ÷ FY equity 4e8
  assert.equal(c.roePriorFY, 21.6); // prior FY 8e7 ÷ 3.7e8
});

test('a cross-listing share-count note survives the derivation', () => {
  const c = derive({ ...base, sharesBasis: 'filing × 10 (CDI ratio)' });
  assert.equal(c.sharesBasis, 'filing × 10 (CDI ratio)');
});

test('a loss has no cash conversion, because the ratio would read as a multiple of nothing', () => {
  const c = derive({ ...base, ttm: { ...base.ttm, netIncome: -1e8 } });
  assert.equal(c.cashConversion, null);
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

test('a fiscal-year fallback is labelled, not passed off as trailing', () => {
  const c = derive({ ...base, ttm: {}, ttmEnd: null });
  assert.equal(c.peBasis, 'FY');
  assert.equal(c.netIncomeTTM, 9e7, 'the latest annual profit');
  assert.equal(c.netIncomeTTMAsOf, '2025-06-30');
  assert.equal(c.ttmFromFY, true, 'a reader can tell four quarters from a year');
});

test('a loss is no P/E, and negative equity is no ROE or P/B', () => {  const c = derive({ ...base, ttm: { ...base.ttm, netIncome: -1e8 }, latest: { equity: -5e8 } });
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

test('P/B and ROE use common equity, not total equity with minorities', () => {
  const c = derive({ ...base, latest: { equity: 5e8, equityCommon: 4e8 } });
  assert.equal(c.pb, 2.5, 'market cap ÷ common equity');   // 1e9 / 4e8
  assert.equal(c.roe, 25, 'profit ÷ common equity');       // 1e8 / 4e8
  assert.equal(c.history.at(-1).q, 4e8, 'the record carries that year’s total equity');
});

test('the five-year band uses the fiscal-year-end price when the build provides it', () => {
  const annual = base.annual.map((r) => ({ ...r, px: 10 }));
  const c = derive({ ...base, annual, yearEnd: { 2021: 45, 2022: 60, 2023: 72, 2024: 88, 2025: 99 } });
  assert.ok(c.bands && c.bands.pe);
  assert.equal(c.bands.pe.min, 10);       // the current 10× is the cheapest point in the set
  assert.equal(c.bands.pe.n, 6);          // five fiscal years + the current P/E
});

test('the five-year record carries each year’s own equity, not the latest', () => {
  const out = derive({ ...base, annual: base.annual.map((r, i) => ({ ...r, equity: 1e8 * (i + 1), equityCommon: 0.8e8 * (i + 1) })) });
  assert.equal(out.history.length, 5);
  assert.equal(out.history[0].q, 1e8);
  assert.equal(out.history.at(-1).q, 5e8);
  assert.equal(out.history[0].ec, 0.8e8);
  assert.equal(out.history.at(-1).ec, 4e8);
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
