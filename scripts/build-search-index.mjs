// Build the global company search index and the country index series.
//
// This is a pure transform of the committed market artifacts — no network. Run it after any market
// refresh; the scheduled search-index job does exactly that.
//
//   node scripts/build-search-index.mjs
//   node scripts/build-search-index.mjs --check

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = (f) => join(ROOT, 'data', f);
const read = (f) => JSON.parse(readFileSync(DATA(f), 'utf8'));
const round = (n, d = 0) => (Number.isFinite(n) ? +n.toFixed(d) : null);

const MARKETS = {
  us: { label: 'United States', flag: '🇺🇸', currency: 'USD', exchange: 'US', indexSymbol: '^SP1500', indexLabel: 'S&P 1500' },
  jp: { label: 'Japan', flag: '🇯🇵', currency: 'JPY', exchange: 'TSE Prime', indexSymbol: 'TOPIX', indexLabel: 'TOPIX' },
  kr: { label: 'Korea', flag: '🇰🇷', currency: 'KRW', exchange: 'KOSPI', indexSymbol: 'KOSPI', indexLabel: 'KOSPI' },
  tw: { label: 'Taiwan', flag: '🇹🇼', currency: 'TWD', exchange: 'TWSE', indexSymbol: 'TAIEX', indexLabel: 'TAIEX' },
  hk: { label: 'Hong Kong', flag: '🇭🇰', currency: 'HKD', exchange: 'HKEX', indexSymbol: 'HSI', indexLabel: 'Hang Seng' },
  au: { label: 'Australia', flag: '🇦🇺', currency: 'AUD', exchange: 'ASX', indexSymbol: 'XJO', indexLabel: 'S&P/ASX 200' },
  in: { label: 'India', flag: '🇮🇳', currency: 'INR', exchange: 'NSE', indexSymbol: 'NIFTY', indexLabel: 'NIFTY 50' },
  id: { label: 'Indonesia', flag: '🇮🇩', currency: 'IDR', exchange: 'IDX', indexSymbol: 'IDX', indexLabel: 'IDX Composite' },
  br: { label: 'Brazil', flag: '🇧🇷', currency: 'BRL', exchange: 'B3', indexSymbol: 'IBOV', indexLabel: 'Ibovespa' },
  za: { label: 'South Africa', flag: '🇿🇦', currency: 'ZAR', exchange: 'JSE', indexSymbol: 'JSE', indexLabel: 'JSE All Share' },
};

// Common names that are not the registered name. Resolved after the entries exist; a missing ticker
// is skipped, never guessed.
const GLOBAL_ALIASES = {
  google: ['us', 'GOOGL'], alphabet: ['us', 'GOOGL'], youtube: ['us', 'GOOGL'],
  facebook: ['us', 'META'], instagram: ['us', 'META'], whatsapp: ['us', 'META'],
  berkshire: ['us', 'BRK-B'], 'berkshire hathaway': ['us', 'BRK-B'],
  toyota: ['jp', '7203'], sony: ['jp', '6758'], softbank: ['jp', '9984'], honda: ['jp', '7267'],
  keyence: ['jp', '6861'], 'tokyo electron': ['jp', '8035'], fastretailing: ['jp', '9983'],
  samsung: ['kr', '005930'], 'samsung electronics': ['kr', '005930'], 'sk hynix': ['kr', '000660'],
  hyundai: ['kr', '005380'], lg: ['kr', '003550'], naver: ['kr', '035420'], kakao: ['kr', '035720'],
  tsmc: ['tw', '2330'], 'taiwan semiconductor': ['tw', '2330'], foxconn: ['tw', '2317'],
  tencent: ['hk', '0700'], alibaba: ['hk', '9988'], meituan: ['hk', '3690'], 'hong kong exchange': ['hk', '0388'],
  bhp: ['au', 'BHP'], cba: ['au', 'CBA'], 'commonwealth bank': ['au', 'CBA'], 'rio tinto': ['au', 'RIO'],
  reliance: ['in', 'RELIANCE'], infosys: ['in', 'INFY'], hdfc: ['in', 'HDFCBANK'], tcs: ['in', 'TCS'],
  bbca: ['id', 'BBCA'], 'bank central asia': ['id', 'BBCA'], telkom: ['id', 'TLKM'],
  nubank: ['br', 'ROXO34'], 'nu holdings': ['br', 'ROXO34'], petrobras: ['br', 'PETR4'],
  vale: ['br', 'VALE3'], itau: ['br', 'ITUB4'], ambev: ['br', 'ABEV3'],
  naspers: ['za', 'NPN'], firstrand: ['za', 'FSR'], mtn: ['za', 'MTN'], sasol: ['za', 'SOL'],
};

const listFiles = {
  jp: 'japan-list.json', kr: 'korea-list.json', tw: 'taiwan-list.json', hk: 'hongkong-list.json',
  au: 'australia-list.json', in: 'india-list.json', id: 'indonesia-list.json', br: 'brazil-list.json',
  za: 'southafrica-list.json',
};

const fxRate = (list) => (Number(list.fx?.rate) > 0 ? Number(list.fx.rate) : 1);
const capUsdOf = (c, fx) => (Number(c.marketCapUsd) > 0 ? Number(c.marketCapUsd) : (Number(c.marketCap) > 0 ? Number(c.marketCap) / fx : 0));
const brandList = (c) => Array.isArray(c.brands) ? c.brands : (c.brands && typeof c.brands === 'object' ? Object.values(c.brands) : []);
const uniq = (arr) => [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))];

function baseAliases(c, extra = []) {
  return uniq([
    ...brandList(c), c.nameJa, c.nameFull, c.nameEn, c.ticker, c.code,
    c.secondaryTicker, c.bdrUnderlying, c.bdrTicker, c.bdrNote, ...extra,
  ]);
}

function listingOf(market, c, { capUsd, securityType = 'common', label = null, link = true } = {}) {
  return {
    market, ticker: c.ticker || c.code, code: c.code || c.ticker,
    exchange: MARKETS[market].exchange, currency: MARKETS[market].currency,
    price: c.price ?? null, capLocal: c.marketCap ?? null, capUsd: round(capUsd),
    securityType, label, link,
  };
}

function usEntries(companies) {
  const canonical = new Map();
  for (const c of companies) {
    if (c.shareClass) continue;
    if (!canonical.has(String(c.cik))) canonical.set(String(c.cik), c);
  }
  // A CIK that only has class rows still needs one head entry.
  for (const c of companies) if (!canonical.has(String(c.cik))) canonical.set(String(c.cik), c);

  const entries = [];
  for (const [cik, c] of canonical) {
    const tier = c.spTier;
    const [indexSymbol, indexLabel] = tier === 'sp500' ? ['^GSPC', 'S&P 500']
      : tier === 'sp400' ? ['^SP400', 'S&P 400']
        : tier === 'sp600' ? ['^SP600', 'S&P 600'] : ['^SP1500', 'S&P 1500'];
    const listings = [listingOf('us', c, { capUsd: c.marketCap, securityType: 'common', label: null })];
    for (const s of companies) {
      if (String(s.cik) !== cik || !s.shareClass) continue;
      listings.push(listingOf('us', s, { capUsd: s.marketCap, securityType: 'shareClass', label: s.ticker }));
    }
    entries.push({
      market: 'us', id: cik, ticker: c.ticker, code: c.ticker, name: c.name, nameEn: c.name, nameLocal: null,
      aliases: baseAliases(c), issuerKey: `us:${cik}`,
      sector: c.sector || null, industry: c.industry || null,
      exchange: 'US', currency: 'USD',
      capLocal: c.marketCap ?? null, capUsd: round(c.marketCap),
      price: c.price ?? null, priceDate: c.priceAsOf || null, pe: c.pe ?? null, roe: c.roe ?? null,
      ytd: c.chgYtd ?? null, securityType: 'common', primary: true,
      noFilings: !!c.noFilings, listings,
      indexSymbol, indexLabel,
    });
  }
  return entries;
}

function marketEntries(market, list) {
  const fx = fxRate(list);
  const entries = [];
  const byIssuer = new Map();
  for (const c of list.companies || []) {
    const isBdr = market === 'br' && !!c.bdr;
    const issuerKey = isBdr ? `br-bdr:${c.bdrUnderlying || c.code}` : `${market}:${c.code}`;
    const capUsd = capUsdOf(c, fx);
    if (isBdr && byIssuer.has(issuerKey)) {
      byIssuer.get(issuerKey).listings.push(listingOf(market, c, { capUsd, securityType: 'BDR', label: c.bdrUnderlying || null }));
      continue;
    }
    const listings = [listingOf(market, c, { capUsd, securityType: isBdr ? 'BDR' : 'common', label: isBdr ? (c.bdrUnderlying || 'BDR') : null })];
    if (c.secondaryTicker && c.secondaryExchange) {
      listings.push({
        market: null, ticker: c.secondaryTicker, code: c.secondaryTicker,
        exchange: c.secondaryExchange, currency: null, price: null, capLocal: null, capUsd: null,
        securityType: 'secondary', label: `${c.secondaryExchange}: ${c.secondaryTicker}`, link: false,
      });
    }
    const e = {
      market, id: c.code, ticker: c.ticker || c.code, code: c.code,
      name: c.name || c.nameFull || c.code, nameEn: c.nameEn || c.nameFull || c.name,
      nameLocal: c.nameJa || (c.nameEn && c.name !== c.nameEn && /[^\x00-\x7F]/.test(c.name) ? c.name : null),
      aliases: baseAliases(c), issuerKey,
      sector: c.sector || null, industry: c.industry || null,
      exchange: MARKETS[market].exchange, currency: MARKETS[market].currency,
      capLocal: c.marketCap ?? null, capUsd: round(capUsd),
      price: c.price ?? null, priceDate: c.priceDate || null, pe: c.pe ?? null, roe: c.roe ?? null,
      ytd: c.chgYtd ?? null,
      securityType: isBdr ? 'BDR' : 'common', primary: true,
      underlying: isBdr ? (c.bdrUnderlying || null) : (c.secondaryTicker ? `${c.secondaryExchange}: ${c.secondaryTicker}` : null),
      listings,
      indexSymbol: isBdr ? 'IBOV' : MARKETS[market].indexSymbol,
      indexLabel: isBdr ? 'Ibovespa' : MARKETS[market].indexLabel,
    };
    entries.push(e);
    byIssuer.set(issuerKey, e);
  }
  return entries;
}

function pointsOf(series) {
  return (series || [])
    .map((p) => Array.isArray(p) ? [String(p[0]), Number(p[1])] : [String(p.d), Number(p.c)])
    .filter(([d, c]) => d && Number.isFinite(c));
}

function usMarketIndices() {
  const charts = read('us-charts.json').series || {};
  const out = {};
  for (const [sym, label] of [['^SP1500', 'S&P 1500'], ['^GSPC', 'S&P 500'], ['^SP400', 'S&P 400'], ['^SP600', 'S&P 600']]) {
    const pts = (charts[sym] || []).map(([d, c]) => [String(d), Number(c)]).filter(([d, c]) => d && Number.isFinite(c));
    if (!pts.length) continue;
    const last = pts[pts.length - 1];
    const prev = pts.length > 1 ? pts[pts.length - 2][1] : null;
    const year = last[0].slice(0, 4);
    const firstYtd = pts.find(([d]) => d.startsWith(year));
    out[sym] = {
      label, symbol: sym, level: round(last[1], 2), date: last[0],
      pct1d: prev ? round(((last[1] / prev) - 1) * 100, 2) : null,
      pctYtd: firstYtd && firstYtd[1] ? round(((last[1] / firstYtd[1]) - 1) * 100, 2) : null,
      points: pts,
    };
  }
  return out;
}

function listMarketIndex(market, list) {
  const idx = market === 'jp' ? list.topix : list.index;
  if (!idx) return null;
  const pts = pointsOf(idx.series);
  const last = pts.length ? pts[pts.length - 1] : null;
  const cfg = MARKETS[market];
  return {
    [cfg.indexSymbol]: {
      label: cfg.indexLabel, symbol: cfg.indexSymbol,
      level: round(idx.level ?? last?.[1], 2), date: idx.date || last?.[0] || null,
      pct1d: idx.chg1d ?? null, pctYtd: idx.chgYtd ?? null, points: pts,
    },
  };
}

const entries = [
  ...usEntries(read('companies.json').companies || []),
];
for (const [market, file] of Object.entries(listFiles)) entries.push(...marketEntries(market, read(file)));

// Resolve global aliases against the built entries. A missing ticker is skipped, never guessed.
const byRef = new Map();
for (const e of entries) {
  for (const t of [e.ticker, e.code, e.id, ...(e.listings || []).flatMap((l) => [l.ticker, l.code])]) {
    if (t != null) byRef.set(`${e.market}:${String(t).toUpperCase()}`, e);
  }
}
for (const [alias, [market, ticker]] of Object.entries(GLOBAL_ALIASES)) {
  const e = byRef.get(`${market}:${String(ticker).toUpperCase()}`);
  if (e) e.aliases.push(alias);
}
for (const e of entries) e.aliases = uniq(e.aliases).filter((a) => a.toLowerCase() !== String(e.name).toLowerCase());

// Market index series: one file the search page and the company market-context strip can read.
const marketCounts = {};
for (const e of entries) marketCounts[e.market] = (marketCounts[e.market] || 0) + 1;
const marketsIndex = {};
for (const [market, cfg] of Object.entries(MARKETS)) {
  const list = market === 'us' ? null : read(listFiles[market]);
  const indices = market === 'us' ? usMarketIndices() : listMarketIndex(market, list);
  marketsIndex[market] = {
    label: cfg.label, flag: cfg.flag, currency: cfg.currency, exchange: cfg.exchange,
    default: cfg.indexSymbol, count: marketCounts[market] || 0, indices: indices || {},
  };
}

const search = {
  updated: new Date().toISOString().slice(0, 10),
  markets: Object.fromEntries(Object.entries(MARKETS).map(([id, m]) => [id, {
    label: m.label, flag: m.flag, currency: m.currency, exchange: m.exchange,
    indexSymbol: m.indexSymbol, indexLabel: m.indexLabel, count: marketCounts[id] || 0,
  }])),
  entries,
};
const indices = { updated: search.updated, markets: marketsIndex };

writeFileSync(DATA('search-index.json'), JSON.stringify(search));
writeFileSync(DATA('market-index.json'), JSON.stringify(indices));

const size = (s) => (Buffer.byteLength(s) / 1048576).toFixed(2);
console.log(`search index: ${entries.length} companies across ${Object.keys(MARKETS).length} markets · ${size(JSON.stringify(search))} MB`);
console.log(`market index: ${Object.values(marketsIndex).reduce((a, m) => a + Object.keys(m.indices).length, 0)} indices · ${size(JSON.stringify(indices))} MB`);
const sample = (q) => {
  // lazy import to keep the build self-contained; the ranking lives in one place
  return import('../src/search.js').then(({ searchEntries }) => {
    const r = searchEntries(entries, q, { limit: 3 });
    console.log(`  "${q}" → ${r.results.map((x) => `${x.market}:${x.ticker} ${x.name}`).join(' | ') || '(none)'}`);
  });
};
for (const q of ['toyota', '7203', 'samsung', '005930', 'tsmc', '2330', 'nubank', 'petr4', 'bhp', 'reliance', 'bbca', 'apple', 'bank of america']) await sample(q);
