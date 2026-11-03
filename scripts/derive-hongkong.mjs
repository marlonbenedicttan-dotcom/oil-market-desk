// Hong Kong ratio derivation.
//
// The maths (including the statement-currency conversion) now lives in the shared derive-listing
// engine, because Australia has the same trap: BHP and RIO report in USD while their listing trades in
// AUD. This module stays as the Hong Kong entry point so the build and the tests keep one import.

import { deriveListing } from './derive-listing.mjs';

// Banks, insurers and other balance-sheet lenders do not have an industrial operating margin or a
// free-cash-flow yield: their cash "flow" is mostly the loan book and the float moving. Fee-based
// financials — exchanges, brokers, asset managers — run an operating business and keep the ratios.
const BALANCE_SHEET_FINANCIAL = /^(Banks\b|Insurance\s*-|Mortgage Finance|Credit Services|Financial - Credit Services)/;

export const deriveHongKong = ({ companies, fx = null }) => {
  const out = deriveListing({ companies, fx, baseCurrency: 'HKD' });
  for (const c of out) {
    if (c.sector !== 'Financials' || !BALANCE_SHEET_FINANCIAL.test(c.industry || '')) continue;
    // Publish why the tile is absent, not a blank. The company page applies the same rule.
    c.naRatios = ['opMargin', 'operatingProfit', 'fcf', 'fcfYield', 'operatingCashFlow'];
    c.opMargin = null;
    c.fcf = null;
    c.fcfYield = null;
  }
  return out;
};
