// Hong Kong ratio derivation.
//
// The maths (including the statement-currency conversion) now lives in the shared derive-listing
// engine, because Australia has the same trap: BHP and RIO report in USD while their listing trades in
// AUD. This module stays as the Hong Kong entry point so the build and the tests keep one import.

import { deriveListing } from './derive-listing.mjs';

export const deriveHongKong = ({ companies, fx = null }) =>
  deriveListing({ companies, fx, baseCurrency: 'HKD' });
