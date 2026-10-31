// The list projections for /api/companies, /api/japan and /api/korea.
//
// These live in their own module because they are a contract with the UI: a filter can only read a
// field that survives projection. A Korean screen once read `bands` and `payoutYield` from the full
// dataset while the list endpoint shipped neither, so the filter matched nothing and looked broken.
// tests/filters.test.js now checks every field the filter bars read against these projections.

export const US_LIST_FIELDS = [
  'cik', 'ticker', 'name', 'sector', 'industry', 'indexName', 'shareClass', 'price', 'chg1d', 'chg6m',
  'chgYtd', 'pe', 'pb', 'evEbitda', 'roe', 'marketCap', 'revenue', 'netIncome', 'netIncomeTTM', 'marginNA',
  'fcfYield', 'fcfNA', 'revenueCagr', 'roic', 'adrNA', 'dividendYield', 'indexWeight', 'sic',
  'buybacks', 'cash', 'priceAsOf', 'brands', 'noFilings',
];

export const projectUs = (c) => {
  const o = {};
  for (const k of US_LIST_FIELDS) if (c[k] !== undefined) o[k] = c[k];
  if (c.verification && c.verification.status) o.verification = { status: c.verification.status };
  return o;
};

// Only what the list, the screens and the search actually read. Everything else (margins beyond the
// operating one, free-cash-flow yield, USD cap, share counts) lives on the company page, which loads the
// full record from /api/korea/company. Trimming this cut the Korea payload by about a quarter.
export const projectKr = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null, sector: c.sector || null,
  brands: c.brands && c.brands.length ? c.brands : null,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
  pe: c.pe, pb: c.pb, roe: c.roe, opMargin: c.opMargin,
  // CHEAP VS ITSELF reads the five-year P/E percentile; without it the preset matches nothing.
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
});

export const projectJp = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameJa: c.nameJa, sector: c.sector, size: c.size,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd, chgYtdBasis: c.chgYtdBasis,
  pe: c.pe, pb: c.pb, roe: c.roe, np: c.np,
  dividend: c.dividend ? { yield: c.dividend.yield } : null,
  cash: c.cash,
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
  brands: c.brands && c.brands.length ? c.brands : null,
  // Without this flag the client cannot tell a preferred line from a company, and the list shows both.
  shareClass: c.shareClass ? true : undefined,
});

// Every field the filter bars in public/app.js read, per market. Keep this in step with the UI: the
// test fails when a filter reads something the projection does not ship.
export const FILTER_FIELDS = {
  us: [
    'sector', 'marketCap', 'pe', 'revenue', 'netIncome', 'roic', 'revenueCagr',
    'dividendYield', 'buybacks', 'verification', 'priceAsOf', 'brands',
  ],
  jp: ['sector', 'marketCap', 'pe', 'pb', 'roe', 'dividend', 'cash', 'bands', 'chgYtd', 'priceDate', 'brands'],
  kr: ['sector', 'marketCap', 'pe', 'pb', 'roe', 'bands', 'chgYtd', 'priceDate', 'brands'],
};
