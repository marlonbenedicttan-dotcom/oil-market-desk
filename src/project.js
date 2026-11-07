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
  'buybacks', 'cash', 'priceAsOf', 'brands', 'noFilings', 'spTier',
];

export const projectUs = (c) => {
  const o = {};
  // Emit every field the filter bars can read, even when the value is absent. Omitting an undefined
  // key made a filter silently match nothing once a company lacked that field (the projection contract
  // is the set of keys, not this sample's values).
  for (const k of US_LIST_FIELDS) o[k] = c[k] ?? null;
  if (c.verification && c.verification.status) o.verification = { status: c.verification.status };
  return o;
};

// Growth fields shared by the HK/AU/KR projections. The company page and the screener both read
// them, so they must survive the compact list artifact (the same contract that `tests/filters.test.js`
// enforces for the filter fields).
const growthFields = (c) => ({
  revenueCagr: c.revenueCagr ?? null,
  epsCagr: c.epsCagr ?? null,
  cagrYears: c.cagrYears ?? null,
  cagrNA: c.cagrNA || null,
  epsCagrNA: c.epsCagrNA || null,
  epsChange: c.epsChange || null,
  marginDelta: c.marginDelta ?? null,
  epsTTM: c.epsTTM ?? null,
  epsTTMBasis: c.epsTTMBasis || null,
  ...(c.epsSplitAdjusted ? { epsSplitAdjusted: true } : {}),
  ...(c.epsSplitUnverified ? { epsSplitUnverified: true } : {}),
});

// Only what the list, the screens and the search actually read. Everything else (margins beyond the
// operating one, free-cash-flow yield, USD cap, share counts) lives on the company page, which loads the
// full record from /api/korea/company. Trimming this cut the Korea payload by about a quarter.
export const projectKr = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null, sector: c.sector || null,
  brands: c.brands && c.brands.length ? c.brands : null,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
  pe: c.pe, pb: c.pb, roe: c.roe, opMargin: c.opMargin,
  ...growthFields(c),
  // CHEAP VS ITSELF reads the five-year P/E percentile; without it the preset matches nothing.
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
});

// The whole /api/korea payload. Kept next to projectKr so the compact list artifact that the server
// serves is built from exactly the same shape the UI expects — a build step and the endpoint can
// never drift apart.
export const koreaList = (kr) => ({
  updated: kr.updated, universe: kr.universe, currency: kr.currency, fx: kr.fx,
  market: kr.market, index: kr.index, themes: kr.themes || [],
  companies: (kr.companies || []).map(projectKr),
});

// Taiwan ships the same fields the Korea list does, plus the official exchange dividend yield, which
// the Taiwan screener's YIELD filter reads.
export const projectTw = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null, sector: c.sector || null,
  brands: c.brands && c.brands.length ? c.brands : null,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
  pe: c.pe, pb: c.pb, roe: c.roe, opMargin: c.opMargin,
  dividendYield: c.dividendYield ?? null,
  ...growthFields(c),
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
});

export const taiwanList = (tw) => ({
  updated: tw.updated, universe: tw.universe, currency: tw.currency, fx: tw.fx,
  market: tw.market, index: tw.index, themes: tw.themes || [], audit: tw.audit || null,
  companies: (tw.companies || []).map(projectTw),
});

// Hong Kong ships the Taiwan field set. The dividend yield is computed from the filing's dividend per
// share (HKEX publishes no per-stock yield table), and the statement currency rides along so a company
// page can say why its ratios were computed in CNY while its price is in HKD.
export const projectHk = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null, sector: c.sector || null,
  brands: c.brands && c.brands.length ? c.brands : null,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
  pe: c.pe, pb: c.pb, roe: c.roe, opMargin: c.opMargin,
  dividendYield: c.dividendYield ?? null,
  reportCurrency: c.reportCurrency || null,
  ...growthFields(c),
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
});

export const hongkongList = (hk) => ({
  updated: hk.updated, universe: hk.universe, currency: hk.currency, fx: hk.fx,
  market: hk.market, index: hk.index, themes: hk.themes || [], audit: hk.audit || null,
  session: hk.session || null, hsi: hk.hsi || null,
  companies: (hk.companies || []).map(projectHk),
});

// Australia ships the same shape as Hong Kong: the statement currency matters because BHP and RIO
// report in USD while the listing trades in AUD, so the screener and the company page can say which
// currency the ratios were computed in.
export const projectAu = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null, sector: c.sector || null,
  brands: c.brands && c.brands.length ? c.brands : null,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
  pe: c.pe, pb: c.pb, roe: c.roe, opMargin: c.opMargin,
  // The trailing profit the P/E is built on. It rides in the list so a screen or a search result can
  // read it without opening the company; `ttmFromFY` says when it is the fiscal year, not four quarters.
  netIncomeTTM: c.netIncomeTTM ?? null,
  netIncomeTTMAsOf: c.netIncomeTTMAsOf || null,
  ttmFromFY: c.ttmFromFY || undefined,
  // The company page's cash-flow ratios; the screener's FCF YLD column reads this one.
  fcfYield: c.fcfYield ?? null,
  dividendYield: c.dividendYield ?? null,
  reportCurrency: c.reportCurrency || null,
  ...growthFields(c),
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
});

export const australiaList = (au) => ({
  updated: au.updated, universe: au.universe, currency: au.currency, fx: au.fx,
  market: au.market, index: au.index, themes: au.themes || [], audit: au.audit || null,
  session: au.session || null,
  companies: (au.companies || []).map(projectAu),
});

// India ships the same shape as Australia. The statement currency is carried because the NIFTY 500
// includes a handful of issuers that report outside INR (a dual-listed ADR, an USD-reporting subsidiary),
// and a rupee cap over a dollar profit is not a P/E.
export const projectIn = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null, sector: c.sector || null,
  brands: c.brands && c.brands.length ? c.brands : null,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
  pe: c.pe, pb: c.pb, roe: c.roe, opMargin: c.opMargin,
  netIncomeTTM: c.netIncomeTTM ?? null,
  netIncomeTTMAsOf: c.netIncomeTTMAsOf || null,
  ttmFromFY: c.ttmFromFY || undefined,
  fcfYield: c.fcfYield ?? null,
  dividendYield: c.dividendYield ?? null,
  reportCurrency: c.reportCurrency || null,
  ...growthFields(c),
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
});

export const indiaList = (ind) => ({
  updated: ind.updated, universe: ind.universe, currency: ind.currency, fx: ind.fx,
  market: ind.market, index: ind.index, themes: ind.themes || [], audit: ind.audit || null,
  session: ind.session || null, indexName: ind.indexName || 'NIFTY 50',
  companies: (ind.companies || []).map(projectIn),
});

// Indonesia ships the same shape as India. The report currency matters: IDX requires a rupiah filing,
// but a few issuers report in USD, and a rupiah cap over a dollar profit is not a P/E.
export const projectId = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null, sector: c.sector || null,
  brands: c.brands && c.brands.length ? c.brands : null,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
  pe: c.pe, pb: c.pb, roe: c.roe, opMargin: c.opMargin,
  netIncomeTTM: c.netIncomeTTM ?? null,
  netIncomeTTMAsOf: c.netIncomeTTMAsOf || null,
  ttmFromFY: c.ttmFromFY || undefined,
  fcfYield: c.fcfYield ?? null,
  dividendYield: c.dividendYield ?? null,
  reportCurrency: c.reportCurrency || null,
  hsc: c.hsc ? { asOf: c.hsc.asOf, rank: c.hsc.rank ?? null } : null,
  noRecentTrading: !!c.noRecentTrading,
  shortHistory: !!c.shortHistory,
  ttmStale: !!c.ttmStale,
  thinTrading: !!c.thinTrading,
  ttmAgeDays: c.ttmAgeDays ?? null,
  avgValue30: c.avgValue30 ?? null,
  flatPct: c.flatPct ?? null,
  ...growthFields(c),
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
});

export const indonesiaList = (ind) => ({
  updated: ind.updated, universe: ind.universe, currency: ind.currency, fx: ind.fx,
  market: ind.market, index: ind.index, themes: ind.themes || [], audit: ind.audit || null,
  session: ind.session || null, indexName: ind.indexName || 'IDX Composite',
  companies: (ind.companies || []).map(projectId),
});

// Brazil ships the Indonesia shape, plus the share class and the company-cap/class-price note. The
// vendor's market cap is the company total repeated on every class line; the build keeps one class per
// issuer, so the cap is not price × class shares.
export const projectBr = (c) => ({
  code: c.code, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null, sector: c.sector || null,
  brands: c.brands && c.brands.length ? c.brands : null,
  price: c.price, priceDate: c.priceDate, marketCap: c.marketCap,
  vendorCap: c.vendorCap ?? null,
  shareClass: c.shareClass || null, multiClass: !!c.multiClass,
  bdr: !!c.bdr, bdrUnderlying: c.bdrUnderlying || null, bdrGroup: c.bdrGroup || null, bdrNote: c.bdrNote || null,
  chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
  pe: c.pe, pb: c.pb, roe: c.roe, opMargin: c.opMargin,
  netIncomeTTM: c.netIncomeTTM ?? null,
  netIncomeTTMAsOf: c.netIncomeTTMAsOf || null,
  ttmFromFY: c.ttmFromFY || undefined,
  fcfYield: c.fcfYield ?? null,
  dividendYield: c.dividendYield ?? null,
  reportCurrency: c.reportCurrency || null,
  noRecentTrading: !!c.noRecentTrading,
  shortHistory: !!c.shortHistory,
  ttmStale: !!c.ttmStale,
  thinTrading: !!c.thinTrading,
  ttmAgeDays: c.ttmAgeDays ?? null,
  avgValue30: c.avgValue30 ?? null,
  flatPct: c.flatPct ?? null,
  ...growthFields(c),
  bands: c.bands && c.bands.pe ? { pe: { percentile: c.bands.pe.percentile } } : null,
});

export const brazilList = (br) => ({
  updated: br.updated, universe: br.universe, currency: br.currency, fx: br.fx,
  market: br.market, index: br.index, themes: br.themes || [], audit: br.audit || null,
  session: br.session || null, indexName: br.indexName || 'Ibovespa',
  companies: (br.companies || []).map(projectBr),
});

export const projectJp = (c) => ({  code: c.code, ticker: c.ticker, name: c.name, nameJa: c.nameJa, sector: c.sector, size: c.size,
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

// The whole /api/japan payload, built once at build time. Parsing the 5.5 MB source to project the
// list cost ~40 ms and ~50 MB of JS objects on the free instance — and the first search or peer lookup
// paid it even on a US page, blocking the chart behind it.
export const japanList = (jp) => ({
  updated: jp.updated, universe: jp.universe, currency: jp.currency, fx: jp.fx, market: jp.market,
  topix: jp.topix || null, themes: jp.themes || [],
  companies: (jp.companies || []).map(projectJp),
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
  tw: ['sector', 'marketCap', 'pe', 'pb', 'roe', 'dividendYield', 'bands', 'chgYtd', 'priceDate', 'brands'],
  hk: ['sector', 'marketCap', 'pe', 'pb', 'roe', 'dividendYield', 'bands', 'chgYtd', 'priceDate', 'brands'],
  au: ['sector', 'marketCap', 'pe', 'pb', 'roe', 'dividendYield', 'bands', 'chgYtd', 'priceDate', 'brands'],
  in: ['sector', 'marketCap', 'pe', 'pb', 'roe', 'dividendYield', 'bands', 'chgYtd', 'priceDate', 'brands'],
  id: ['sector', 'marketCap', 'pe', 'pb', 'roe', 'dividendYield', 'bands', 'chgYtd', 'priceDate', 'brands', 'hsc', 'noRecentTrading', 'thinTrading'],
  br: ['sector', 'marketCap', 'pe', 'pb', 'roe', 'dividendYield', 'bands', 'chgYtd', 'priceDate', 'brands', 'noRecentTrading', 'thinTrading', 'bdr', 'bdrGroup'],
};
