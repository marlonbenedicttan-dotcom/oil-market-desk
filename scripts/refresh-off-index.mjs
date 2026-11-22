// Off-index coverage: the large caps that are listed but are not in any of the index universes this
// desk builds from (S&P 1500, TOPIX, KOSPI, …). They are real public companies with real quotes and
// real filings — they are simply not index members yet, so nothing in the ten-market build reaches
// them.
//
// The list is curated (a ticker and its listing facts), the market data is fetched, and the output is
// committed. Nothing here is estimated: a price comes from Nasdaq, the listing date and IPO price
// come from the 424B4 prospectus, the statements come from SEC XBRL, and the pre-first-10-Q periods
// (the S-1 years a new listing already has) come from stockanalysis.com. A ratio the record cannot
// support stays null.
//
//   node scripts/refresh-off-index.mjs             # refresh prices, caps and series
//   node scripts/refresh-off-index.mjs --dry       # print, write nothing

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSaTable, rowOf } from './stockanalysis.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'off-index.json');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const SEC_UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Curated facts. `listedAt`, `ipoPrice` and `why` do not come from a price feed: they come from the
// listing prospectus and the exchange notice, so they live here and are not overwritten by a refresh.
const BASE = [
  {
    ticker: 'SPCX', cik: '1181412', name: 'SpaceX', legalName: 'Space Exploration Technologies Corp.',
    // xAI acquired X (Twitter) in March 2025 and SpaceX acquired xAI in February 2026, so X, Twitter
    // and Grok are SpaceX divisions now — and the combined company rebranded as SpaceXAI in July 2026.
    brands: ['Starlink', 'X', 'Twitter', 'Grok', 'Starship', 'Falcon 9', 'Dragon'],
    aliases: ['x', 'spacex', 'spacexai', 'starlink', 'starship', 'falcon', 'twitter', 'tweet', 'grok', 'xai'],
    listedAt: '2026-06-12', ipoPrice: 135, exchange: 'NASDAQ',
    why: 'Listed 12 Jun 2026 · not an index constituent yet',
  },
  {
    ticker: 'ANT', cik: '2130357', name: 'Anthropic', legalName: 'Anthropic, PBC',
    brands: ['Claude', 'Claude Code', 'Claude API', 'Claude Pro', 'Claude Max', 'Claude Sonnet', 'Claude Opus', 'Claude Haiku'],
    aliases: ['claude', 'anthropic', 'claude ai', 'claude code', 'sonnet', 'opus', 'haiku'],
    listedAt: '2026-11-19', ipoPrice: 83, exchange: 'NASDAQ',
    why: 'Listed 19 Nov 2026 · not an index constituent yet',
  },
  {
    ticker: 'CBRS', cik: '2021728', name: 'Cerebras Systems', legalName: 'Cerebras Systems Inc.',
    brands: ['Cerebras', 'Cerebras Inference', 'Wafer-Scale Engine', 'WSE', 'Condor Galaxy'],
    aliases: ['cerebras', 'cerebras systems', 'wafer scale', 'wse'],
    listedAt: '2026-05-14', ipoPrice: 185, exchange: 'NASDAQ',
    why: 'Listed 14 May 2026 · not an index constituent yet',
  },
  {
    ticker: 'CRWV', cik: '1769628', name: 'CoreWeave', legalName: 'CoreWeave, Inc.',
    brands: ['CoreWeave', 'CoreWeave Cloud', 'CoreWeave Kubernetes Service', 'CKS'],
    aliases: ['coreweave', 'core weave'],
    listedAt: '2025-03-28', ipoPrice: 40, exchange: 'NASDAQ',
    why: 'Listed 28 Mar 2025 · not an index constituent yet',
  },
  {
    ticker: 'CRCL', cik: '1876042', name: 'Circle Internet Group', legalName: 'Circle Internet Group, Inc.',
    brands: ['Circle', 'USDC', 'EURC', 'Circle Payments Network', 'CCTP'],
    aliases: ['circle', 'usdc', 'eurc', 'circle internet', 'cctp'],
    listedAt: '2025-06-05', ipoPrice: 31, exchange: 'NYSE',
    why: 'Listed 05 Jun 2025 · not an index constituent yet',
  },
  {
    ticker: 'CHYM', cik: '1795586', name: 'Chime Financial', legalName: 'Chime Financial, Inc.',
    brands: ['Chime', 'SpotMe', 'MyPay', 'Chime Card'],
    aliases: ['chime', 'chime financial', 'spotme', 'mypay'],
    listedAt: '2025-06-12', ipoPrice: 27, exchange: 'NASDAQ',
    why: 'Listed 12 Jun 2025 · not an index constituent yet',
  },
  {
    ticker: 'FIG', cik: '1579878', name: 'Figma', legalName: 'Figma, Inc.',
    brands: ['Figma', 'FigJam', 'Figma Slides', 'Figma Make', 'Dev Mode'],
    aliases: ['figma', 'figjam', 'figma slides', 'dev mode'],
    listedAt: '2025-07-31', ipoPrice: 33, exchange: 'NYSE',
    why: 'Listed 31 Jul 2025 · not an index constituent yet',
  },
  {
    ticker: 'BSP', cik: '2004711', name: 'Bending Spoons', legalName: 'Bending Spoons S.p.A.',
    brands: ['AOL', 'Brightcove', 'Eventbrite', 'Evernote', 'Harvest', 'Komoot', 'Remini', 'StreamYard', 'Vimeo', 'WeTransfer', 'Tractive'],
    aliases: ['bending spoons', 'bsp', 'evernote', 'aol', 'brightcove', 'eventbrite', 'harvest', 'komoot', 'remini', 'streamyard', 'vimeo', 'wetransfer', 'tractive'],
    listedAt: '2026-07-01', ipoPrice: 29, exchange: 'NASDAQ',
    why: 'Listed 01 Jul 2026 · not an index constituent yet',
  },
  {
    ticker: 'KLAR', cik: '2003292', name: 'Klarna Group', legalName: 'Klarna Group plc',
    brands: ['Klarna', 'Klarna Card', 'Klarna App', 'Pay in Full', 'Pay Later', 'Fair Financing', 'Klarna Checkout'],
    aliases: ['klarna', 'klarna group', 'pay later', 'bnpl', 'klarna card', 'klarna checkout'],
    listedAt: '2025-09-10', ipoPrice: 40, exchange: 'NYSE',
    why: 'Listed 10 Sep 2025 · not an index constituent yet',
  },
  {
    ticker: 'FIGR', cik: '2064124', name: 'Figure Technology Solutions', legalName: 'Figure Technology Solutions, Inc.',
    brands: ['Figure', 'Figure Connect', 'Figure Markets', 'Provenance Blockchain', 'Figure Lending'],
    aliases: ['figure', 'figure technology', 'figure markets', 'figure connect', 'provenance', 'provenance blockchain'],
    listedAt: '2025-09-11', ipoPrice: 25, exchange: 'NASDAQ',
    why: 'Listed 11 Sep 2025 · not an index constituent yet',
  },
  {
    ticker: 'NTSK', cik: '2063196', name: 'Netskope', legalName: 'Netskope, Inc.',
    brands: ['Netskope', 'Netskope One', 'NewEdge', 'CASB', 'Secure Web Gateway', 'Private Access', 'DLP'],
    aliases: ['netskope', 'netskope one', 'newedge', 'sase', 'casb', 'cloud security', 'zero trust'],
    listedAt: '2025-09-18', ipoPrice: 19, exchange: 'NASDAQ',
    why: 'Listed 18 Sep 2025 · not an index constituent yet',
  },
  {
    ticker: 'OURA', cik: '2133022', name: 'Oura', legalName: 'Oura Inc.', preIpo: true,
    brands: ['Oura Ring', 'Oura Ring 4', 'Oura App', 'Oura Membership', 'Oura Advisor'],
    aliases: ['oura', 'oura ring', 'smart ring', 'oura app', 'oura membership'],
    listedAt: null, ipoPrice: null, exchange: 'NASDAQ', priceRange: [40, 44],
    sector: 'Consumer', nasdaqSector: 'Consumer Discretionary', industry: 'Wearable Technology',
    description: 'Oura Inc. designs, manufactures and sells smart rings and a membership-based health platform. The Oura Ring tracks sleep, readiness, activity, heart rate and temperature, and the Oura App turns those signals into daily scores, insights and health guidance. The company sells hardware and subscriptions in the United States and internationally.',
    descriptionSource: 'sec-s1',
    why: 'IPO filed 21 Sep 2026 · not trading yet',
  },
  {
    ticker: 'NSCL', cik: '2110365', name: 'Nscale', legalName: 'Nscale plc', preIpo: true,
    brands: ['Nscale', 'Nscale Cloud', 'Nscale Compute', 'Nscale AI'],
    aliases: ['nscale', 'nscale plc', 'nscale cloud', 'gpu cloud', 'ai data centers'],
    listedAt: null, ipoPrice: null, exchange: 'NYSE', priceRange: null,
    sector: 'Technology', nasdaqSector: 'Technology', industry: 'AI Data Centers',
    description: 'Nscale plc designs, builds and operates AI data centres and provides GPU cloud compute for AI training, inference and high-performance workloads. It offers large-scale, power-efficient compute capacity and related services to AI labs, enterprises and cloud providers.',
    descriptionSource: 'sec-s1',
    why: 'IPO filed 12 Nov 2026 · not trading yet',
  },
];

// Pre-IPO companies: the S-1/A carries the audited annual and interim statements, but there is no
// tape yet. The row keeps the same financial shape (periods, TTM, annual record, ratios) and has
// null quote fields until the IPO prices; the refresh below promotes it to a normal listed row on
// the first close. Values are from the S-1/A prospectus, in USD.
const PRE_IPO = {
  OURA: {
    periodBasis: 'quarter',
    financials: {
      basis: 'TTM',
      ttm: { end: '2026-09-30', revenue: 1424793000, netIncome: 59207000, equity: -1617734000, assets: 1063188000 },
      latest: { start: '2026-01-01', end: '2026-09-30', revenue: 1214506000, netIncome: 60768000, source: 'sec-s1' },
      prior: { start: '2025-01-01', end: '2025-09-30', revenue: 697569000, netIncome: 1573000, source: 'sec-s1' },
      fy: { end: '2025-12-31', revenue: 907856000, netIncome: 12000, source: 'sec-s1' },
      assets: 1063188000, equity: -1617734000, balanceEnd: '2026-06-30',
      quarters: [
        { end: '2025-03-31', fy: 2025, q: 1, revenue: 232595000, netIncome: 12567000, source: 'sec-s1' },
        { end: '2025-06-30', fy: 2025, q: 2, revenue: 234290000, netIncome: 3007000, source: 'sec-s1' },
        { end: '2025-09-30', fy: 2025, q: 3, revenue: 230684000, netIncome: -14001000, source: 'sec-s1' },
        { end: '2025-12-31', fy: 2025, q: 4, revenue: 210287000, netIncome: -1561000, source: 'sec-s1' },
        { end: '2026-03-31', fy: 2026, q: 1, revenue: 354815000, netIncome: 9807000, source: 'sec-s1' },
        { end: '2026-06-30', fy: 2026, q: 2, revenue: 408724000, netIncome: -9966000, source: 'sec-s1' },
        { end: '2026-09-30', fy: 2026, q: 3, revenue: 450967000, netIncome: 60927000, source: 'sec-s1' },
      ],
      annual: [
        { end: '2024-12-31', revenue: 406751000, netIncome: 3649000, source: 'sec-s1' },
        { end: '2025-12-31', revenue: 907856000, netIncome: 12000, source: 'sec-s1' },
      ],
      pe: null, roe: null, netMargin: 4.2, revenueCagr: null, revenueGrowth: 123.2, growthYears: 1,
      source: 'SEC S-1/A (pre-IPO)', quartersSource: 'SEC S-1/A (pre-IPO)',
      latestFiling: { form: 'S-1/A', filed: '2026-09-21', period: null, url: 'https://www.sec.gov/Archives/edgar/data/2133022/000119312526396051/d119865ds1a.htm' },
    },
  },
  NSCL: {
    periodBasis: 'half',
    financials: {
      basis: 'TTM',
      ttm: { end: '2026-06-30', revenue: 163200000, netIncome: -1413000000, equity: 4792200000, assets: 17252000000 },
      latest: { start: '2026-01-01', end: '2026-06-30', revenue: 140600000, netIncome: -1020100000, source: 'sec-s1' },
      prior: { start: '2025-01-01', end: '2025-06-30', revenue: 10400000, netIncome: -368900000, source: 'sec-s1' },
      fy: { end: '2025-12-31', revenue: 33000000, netIncome: -761800000, source: 'sec-s1' },
      assets: 17252000000, equity: 4792200000, balanceEnd: '2026-06-30',
      quarters: [
        { end: '2025-06-30', fy: 2025, q: 1, revenue: 10400000, netIncome: -368900000, source: 'sec-s1' },
        { end: '2025-12-31', fy: 2025, q: 2, revenue: 22600000, netIncome: -392900000, source: 'sec-s1', derived: true },
        { end: '2026-06-30', fy: 2026, q: 1, revenue: 140600000, netIncome: -1020100000, source: 'sec-s1' },
      ],
      annual: [
        { end: '2024-12-31', revenue: 19100000, netIncome: -78200000, source: 'sec-s1' },
        { end: '2025-12-31', revenue: 33000000, netIncome: -761800000, source: 'sec-s1' },
      ],
      pe: null, roe: -29.5, netMargin: -866, revenueCagr: null, revenueGrowth: 72.8, growthYears: 1,
      source: 'SEC S-1/A (pre-IPO)', quartersSource: 'SEC S-1/A (pre-IPO)',
      latestFiling: { form: 'S-1/A', filed: '2026-11-12', period: null, url: 'https://www.sec.gov/Archives/edgar/data/2110365/000119312526458722/ck0002110365-20261112.htm' },
    },
  },
};

// Nasdaq's sector vocabulary folded into the same buckets the rest of the desk uses
// (kept in step with scripts/complete-us-universe.mjs).
const NASDAQ_SECTOR = {
  Technology: 'Technology', 'Health Care': 'Healthcare', 'Consumer Discretionary': 'Consumer',
  'Consumer Staples': 'Consumer', Finance: 'Financials', Industrials: 'Industrials', Energy: 'Energy',
  Materials: 'Materials', Utilities: 'Utilities', 'Real Estate': 'Real estate',
  Telecommunications: 'Telecom', 'Communication Services': 'Media',
};
const sectorOf = (s) => NASDAQ_SECTOR[s] || 'Other';
const num = (v) => Number(String(v == null ? '' : v).replace(/[$,%\s,]/g, '')) || null;

// EDGAR payloads are the document itself (no `data` envelope), unlike the Nasdaq ones.
async function getRawJSON(url, headers = UA, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { ...headers, Accept: 'application/json, text/plain, */*' } });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(700 * (i + 1));
  }
  return null;
}

async function getJSON(url, headers = UA, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' } });
      if (res.ok) {
        const j = await res.json();
        if (j && j.data) return j.data;
      }
    } catch { /* retry */ }
    await sleep(700 * (i + 1));
  }
  return null;
}

async function quote(ticker) {
  const sym = ticker.replace('-', '.');
  const [summary, info] = await Promise.all([
    getJSON(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`),
    getJSON(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`),
  ]);
  const s = (summary && summary.summaryData) || {};
  const p = (info && info.primaryData) || {};
  const infoHiLo = String(((info && info.keyStats) || {}).fiftyTwoWeekHighLow?.value || '').match(/([\d.,]+)\s*-\s*([\d.,]+)/);
  const sumHiLo = String(s.FiftTwoWeekHighLow?.value || '').match(/([\d.,]+)\s*\/\s*([\d.,]+)/);
  return {
    price: num(p.lastSalePrice) || num(s.PreviousClose?.value),
    prevClose: num(s.PreviousClose?.value),
    chg1d: num(p.percentageChange),
    cap: num(s.MarketCap?.value),
    sector: s.Sector?.value || null,
    industry: s.Industry?.value || null,
    wk52Low: (infoHiLo ? num(infoHiLo[1]) : sumHiLo ? num(sumHiLo[2]) : null),
    wk52High: (infoHiLo ? num(infoHiLo[2]) : sumHiLo ? num(sumHiLo[1]) : null),
  };
}

// One year of daily closes. Used for the company page chart and for the first close after listing
// (which is what "since IPO" is measured against when the prospectus price and the tape disagree).
async function history(ticker, from) {
  const sym = ticker.replace('-', '.');
  const today = new Date().toISOString().slice(0, 10);
  const d = await getJSON(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=stocks&fromdate=${from}&todate=${today}&limit=9999`);
  const rows = ((d || {}).tradesTable || {}).rows || [];
  return rows
    .map((r) => {
      const [m, dd, y] = String(r.date || '').split('/');
      return [y && `${y}-${m}-${dd}`, num(r.close)];
    })
    .filter(([date, close]) => date && close != null)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Historical statements — the same source the index members' descriptions come from. EDGAR's XBRL
// starts at the first 10-Q/10-K, so a company that listed this year has no pre-IPO years there even
// when the S-1 carried audited financials. stockanalysis.com keeps those periods, so it fills only
// the gaps: SEC-tagged values always win, a vendor value is used only where EDGAR has none, and the
// provenance is stored with the row.
// ---------------------------------------------------------------------------------------------
async function getHTML(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return await res.text();
      if (res.status !== 404 && res.status !== 403 && res.status !== 429) break;
    } catch { /* retry */ }
    await sleep(900 * (i + 1));
  }
  return null;
}

// The statement tables are published in millions (US listings), so a vendor number is scaled to the
// dollars EDGAR uses before it is compared with or added to a filing. Millions is also the fallback:
// the page's own caption is the only thing that changes it.
function saScale(html) {
  if (/in millions/i.test(html)) return 1e6;
  if (/in thousands/i.test(html)) return 1e3;
  return 1e6;
}
const SA_PERIOD = /^\d{4}-\d{2}-\d{2}$/;
const saCols = (table) => table.cols.map((c) => c.id).filter((id) => SA_PERIOD.test(id));
function saRow(table, labels, scale = 1) {
  const row = rowOf(table, labels);
  if (!row) return {};
  const out = {};
  for (const [end, value] of Object.entries(row.values)) {
    out[end] = value == null ? null : +(value * scale).toFixed(0);
  }
  return out;
}
function saPerShare(table, labels) {
  const row = rowOf(table, labels);
  return row ? { ...row.values } : {};
}

async function vendorStatements(ticker) {
  const base = `https://stockanalysis.com/stocks/${String(ticker).toLowerCase()}/financials/`;
  const [qHtml, aHtml, bHtml] = await Promise.all([
    getHTML(`${base}?p=quarterly`),
    getHTML(base),
    getHTML(`${base}balance-sheet/?p=quarterly`),
  ]);
  if (!qHtml && !aHtml && !bHtml) return null;
  const quarterly = qHtml ? parseSaTable(qHtml) : { cols: [], rows: [] };
  const annual = aHtml ? parseSaTable(aHtml) : { cols: [], rows: [] };
  const balance = bHtml ? parseSaTable(bHtml) : { cols: [], rows: [] };
  const qScale = qHtml ? saScale(qHtml) : 1e6;
  const aScale = aHtml ? saScale(aHtml) : 1e6;
  const bScale = bHtml ? saScale(bHtml) : 1e6;

  const qRev = saRow(quarterly, ['Revenue'], qScale);
  const qNi = saRow(quarterly, ['Net Income'], qScale);
  const qEps = saPerShare(quarterly, ['Earnings Per Share', 'EPS (Diluted)', 'EPS']);
  const quarters = saCols(quarterly)
    .map((end) => ({ end, revenue: qRev[end] ?? null, netIncome: qNi[end] ?? null, eps: qEps[end] ?? null }))
    .filter((q) => q.revenue != null || q.netIncome != null);

  const aRev = saRow(annual, ['Revenue'], aScale);
  const aNi = saRow(annual, ['Net Income'], aScale);
  const aEps = saPerShare(annual, ['Earnings Per Share', 'EPS (Diluted)', 'EPS']);
  const annuals = saCols(annual)
    .map((end) => ({ end, revenue: aRev[end] ?? null, netIncome: aNi[end] ?? null, eps: aEps[end] ?? null }))
    .filter((a) => a.revenue != null || a.netIncome != null);

  const bAssets = saRow(balance, ['Total Assets'], bScale);
  const bEquity = saRow(balance, ["Shareholders' Equity", 'Total Equity'], bScale);
  const balanceEnd = saCols(balance).find((end) => bAssets[end] != null || bEquity[end] != null) || null;
  return {
    quarters,
    annuals,
    assets: balanceEnd ? bAssets[balanceEnd] ?? null : null,
    equity: balanceEnd ? bEquity[balanceEnd] ?? null : null,
    balanceEnd,
  };
}

// ---------------------------------------------------------------------------------------------
// Filings — the same EDGAR XBRL the index members are built from. A TTM is only produced when the
// arithmetic closes (last 10-K + the current year to date − the same period a year earlier); when
// there is no annual report yet the latest 10-Q is shown on its own, labelled by its period, and the
// ratios that need a year of earnings stay null rather than becoming a number that means nothing.
// ---------------------------------------------------------------------------------------------
const SEC_DAY = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const CONCEPTS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  assets: ['Assets'],
};

function conceptRows(gaap, names, instant = false) {
  const out = [];
  for (const n of names) {
    const f = gaap[n];
    if (!f) continue;
    const unit = Object.keys(f.units).find((u) => u === 'USD') || Object.keys(f.units)[0];
    for (const r of f.units[unit] || []) {
      if (r.form !== '10-K' && r.form !== '10-Q') continue;
      if (instant ? r.start : !r.start) continue;
      out.push({ ...r, concept: n });
    }
  }
  return out;
}
const dedupePeriods = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.start || ''}|${r.end}`;
    const prev = m.get(k);
    if (!prev || (r.filed || '') > (prev.filed || '')) m.set(k, r);
  }
  return [...m.values()];
};
const fiscalYearOf = (rows) => rows
  .filter((r) => r.form === '10-K' && SEC_DAY(r.start, r.end) >= 340 && SEC_DAY(r.start, r.end) <= 380)
  .sort((a, b) => (a.end < b.end ? 1 : -1))[0] || null;
const shiftYear = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCFullYear(x.getUTCFullYear() - 1); return x.toISOString().slice(0, 10); };

async function filings(cik, capUsd) {
  const id = String(cik).padStart(10, '0');
  const cf = await getRawJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`, { 'User-Agent': SEC_UA });
  await sleep(250);
  const gaap = cf?.facts?.['us-gaap'] || {};
  const out = { basis: null, ttm: null, latest: null, fy: null, equity: null, assets: null, latestFiling: null, revenueCagr: null };

  // Latest periodic filing metadata (form, period, filed, link) — this is what "a new filing shows
  // up" means. Domestic issuers file 10-K/10-Q; a foreign private issuer files 20-F and 6-K. A 6-K
  // is often an announcement, so prefer the one whose report date is a period end.
  const sub = await getRawJSON(`https://data.sec.gov/submissions/CIK${id}.json`, { 'User-Agent': SEC_UA });
  await sleep(250);
  const rec = sub?.filings?.recent || {};
  let fallbackFiling = null;
  for (let i = 0; i < (rec.form || []).length; i++) {
    const form = rec.form[i];
    if (!/^(10-[KQ]|20-F|6-K)$/.test(form)) continue;
    const acc = String(rec.accessionNumber?.[i] || '').replace(/-/g, '');
    const filed = rec.filingDate?.[i] || null;
    const period = rec.reportDate?.[i] || null;
    const filing = {
      form, filed, period,
      url: acc && rec.primaryDocument?.[i] ? `https://www.sec.gov/Archives/edgar/data/${id}/${acc}/${rec.primaryDocument[i]}` : null,
    };
    if (form !== '6-K') { out.latestFiling = filing; break; }
    if (period && filed && Math.abs(Date.parse(period) - Date.parse(filed)) > 7 * 864e5) {
      out.latestFiling = filing;
      break;
    }
    if (!fallbackFiling) fallbackFiling = filing;
  }
  if (!out.latestFiling) out.latestFiling = fallbackFiling;

  // Quarterly figures: the filings are cumulative (Q1, H1, 9M, FY), so a quarter is the step between
  // two consecutive periods inside the same fiscal year. The deltas are kept only when the step is
  // genuinely a quarter long, and EPS follows the same periods.
  // Quarterly figures. A filing reports cumulative periods (Q1, H1, 9M, FY) and sometimes the
  // standalone quarter as well. A quarter is either tagged as one, or the step between two periods
  // that share a start (YTD progression) or an end (YTD minus the quarter inside it). Deltas are kept
  // only when the step is genuinely a quarter long, and EPS uses tagged quarters only — diluted EPS
  // is not additive across quarters, so subtracting it would invent a number.
  const quarterParts = (rows) => {
    const reported = new Map();
    const derived = new Map();
    const facts = rows.filter((r) => SEC_DAY(r.start, r.end) <= 380);
    for (const r of facts) {
      const d = SEC_DAY(r.start, r.end);
      if (d < 60 || d > 110) continue;
      const prev = reported.get(r.end);
      if (!prev || (r.filed || '') > (prev.filed || '')) reported.set(r.end, r);
    }
    for (const a of facts) {
      for (const b of facts) {
        if (a === b) continue;
        let from, to, val;
        if (a.start === b.start && a.end < b.end) { from = a.end; to = b.end; val = b.val - a.val; }
        else if (a.end === b.end && a.start < b.start) {
          // The YTD minus the quarter inside it is the earlier part of the year: it ends the day
          // before that quarter starts, not on its start date.
          from = a.start; to = new Date(Date.parse(b.start) - 864e5).toISOString().slice(0, 10); val = a.val - b.val;
        } else continue;
        if (SEC_DAY(from, to) < 60 || SEC_DAY(from, to) > 110) continue;
        if (!derived.has(to)) derived.set(to, { start: from, end: to, val });
      }
    }
    return { reported, derived };
  };
  const revAll = dedupePeriods(conceptRows(gaap, CONCEPTS.revenue));
  const niAll = dedupePeriods(conceptRows(gaap, CONCEPTS.netIncome));
  const equityRows = conceptRows(gaap, CONCEPTS.equity, true).sort((a, b) => (a.end < b.end ? 1 : -1));
  const assetRows = conceptRows(gaap, CONCEPTS.assets, true).sort((a, b) => (a.end < b.end ? 1 : -1));
  out.equity = equityRows[0] ? equityRows[0].val : null;
  out.assets = assetRows[0] ? assetRows[0].val : null;
  if (!revAll.length || !niAll.length) return out;

  // The primary revenue line is the concept with the largest annual figure; mixing concepts within
  // one company double-counts (a component line next to the total).
  const byConcept = {};
  for (const r of revAll) (byConcept[r.concept] = byConcept[r.concept] || []).push(r);
  const best = Object.entries(byConcept).map(([c, rows]) => {
    const fy = fiscalYearOf(rows);
    return { rows, size: fy ? fy.val : Math.max(...rows.map((r) => r.val)) };
  }).sort((a, b) => b.size - a.size)[0];
  const rev = dedupePeriods(best.rows);
  const end = rev.reduce((a, r) => (!a || r.end > a ? r.end : a), null);
  const longestTo = (rows, e) => rows.filter((r) => r.end === e).sort((a, b) => (a.start < b.start ? -1 : 1))[0] || null;
  const ytd = longestTo(rev, end);
  const ytdNi = longestTo(niAll, end);
  const fy = fiscalYearOf(rev);
  const fyNi = fiscalYearOf(niAll);
  const prev = ytd ? rev.find((r) => r.start === shiftYear(ytd.start) && r.end === shiftYear(ytd.end)) : null;
  const prevNi = ytdNi ? niAll.find((r) => r.start === shiftYear(ytdNi.start) && r.end === shiftYear(ytdNi.end)) : null;
  const ttmRev = fy && ytd && prev && ytd.end > fy.end ? fy.val + ytd.val - prev.val : (fy && ytd && ytd.end <= fy.end ? fy.val : null);
  const ttmNi = fyNi && ytdNi && prevNi && ytdNi.end > fyNi.end ? fyNi.val + ytdNi.val - prevNi.val : (fyNi && ytdNi && ytdNi.end <= fyNi.end ? fyNi.val : null);

  const epsRows = dedupePeriods(conceptRows(gaap, ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']));
  const rq = quarterParts(rev);
  const nq = quarterParts(niAll);
  const eq = quarterParts(epsRows);
  const pick = (parts, end) => parts.reported.get(end) || parts.derived.get(end) || null;
  // A derived quarter can land a day or two from the tagged one; the tagged quarter wins.
  const near = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5) <= 6;
  const reportedEnds = [...rq.reported.keys(), ...nq.reported.keys()];
  const derivedEnds = [...rq.derived.keys(), ...nq.derived.keys()].filter((e) => !reportedEnds.some((r) => near(r, e)));
  const ends = [...new Set(reportedEnds.concat(derivedEnds))].sort();
  // Fiscal label for each quarter (fy end + Q1..Q4), taken from the reported 10-K's own period end,
  // so the matrix on the page groups and labels periods exactly as the index members' does. A
  // January year-end company (Figma) is the reason this has to be computed, not assumed.
  const fyEndMonth = fy ? Number(String(fy.end).slice(5, 7)) : 12;
  const fiscalOf = (end) => {
    const m = Number(String(end).slice(5, 7));
    const y = Number(String(end).slice(0, 4));
    if (fyEndMonth === 12) return { fy: y, q: Math.ceil(m / 3) };
    const q = Math.floor((((m - fyEndMonth + 12) % 12) - 1) / 3) + 1;
    return { fy: m > fyEndMonth ? y + 1 : y, q: Math.max(1, Math.min(4, q)) };
  };
  out.quarters = ends.map((end) => {
    const rv = pick(rq, end);
    const nv = pick(nq, end);
    const ev = eq.reported.get(end) || null;
    const f = fiscalOf(end);
    return { end, fy: f.fy, q: f.q, revenue: rv ? rv.val : null, netIncome: nv ? nv.val : null, eps: ev ? ev.val : null };
  }).filter((q) => q.revenue != null || q.netIncome != null).slice(-20);
  // The annual record is kept alongside the quarters: the matrix can reconcile a fiscal year to its
  // 10-K, and a growth rate can be computed without re-reading EDGAR.
  const annualAt = (rows, end) => rows.find((r) => r.end === end && r.form === '10-K'
    && SEC_DAY(r.start, r.end) >= 340 && SEC_DAY(r.start, r.end) <= 380) || null;
  const annualEnds = [...new Set(rev.filter((r) => r.form === '10-K').map((r) => r.end))].sort().slice(-5);
  out.annual = annualEnds.map((end) => {
    const rv = annualAt(rev, end);
    const nv = annualAt(niAll, end);
    const ev = annualAt(epsRows, end);
    return {
      end,
      revenue: rv ? rv.val : null,
      netIncome: nv ? nv.val : null,
      eps: ev ? ev.val : null,
      source: 'sec',
    };
  }).filter((a) => a.revenue != null || a.netIncome != null);
  out.fy = fy ? { end: fy.end, revenue: fy.val, netIncome: fyNi ? fyNi.val : null } : null;
  out.latest = ytd ? { start: ytd.start, end: ytd.end, revenue: ytd.val, netIncome: ytdNi ? ytdNi.val : null } : null;
  // The prior-year comparable is stored too, so the TTM can be re-derived by an auditor (and by this
  // desk's own audit script) instead of being a number only the build understands.
  out.prior = prev ? { start: prev.start, end: prev.end, revenue: prev.val, netIncome: prevNi ? prevNi.val : null } : null;
  if (ttmRev != null) {
    out.basis = 'TTM';
    out.ttm = { end, revenue: ttmRev, netIncome: ttmNi, equity: out.equity, assets: out.assets };
  }
  const years = [...new Set(rev.filter((r) => r.form === '10-K').map((r) => r.end))].sort()
    .map((e) => rev.find((r) => r.end === e && r.form === '10-K')).filter((r) => r && r.val > 0);
  if (years.length >= 3) {
    const a = years[0], b = years[years.length - 1];
    const n = SEC_DAY(a.end, b.end) / 365.25;
    if (n >= 2 && n <= 6) out.revenueCagr = +((Math.pow(b.val / a.val, 1 / n) - 1) * 100).toFixed(1);
  }
  // Ratios only where the inputs exist: no TTM earnings means no P/E, no ROE and no margin.
  if (out.ttm && capUsd) {
    const ni = out.ttm.netIncome;
    out.pe = ni != null && ni > 0 ? +(capUsd / ni).toFixed(1) : null;
    out.roe = ni != null && out.equity > 0 ? +((ni / out.equity) * 100).toFixed(1) : null;
    out.netMargin = ni != null && out.ttm.revenue > 0 ? +((ni / out.ttm.revenue) * 100).toFixed(1) : null;
  }
  return out;
}

// Merge the filed record with the vendor's pre-IPO history. The rules are deliberately one-way:
// an EDGAR-tagged value is never replaced, the vendor only fills a period or a blank that EDGAR does
// not have, and the arithmetic that produces a TTM is the same FY + YTD − prior YTD the audit checks.
function mergeFinancials(sec, vendor, capUsd) {
  const out = { ...sec };
  let usedVendor = false;
  const secQuarters = (sec.quarters || []).map((q) => ({ ...q, source: 'sec' }));
  const annualByYear = new Map();
  for (const a of sec.annual || []) annualByYear.set(Number(String(a.end).slice(0, 4)), { ...a, source: 'sec' });
  for (const a of vendor?.annuals || []) {
    const year = Number(String(a.end).slice(0, 4));
    if (!annualByYear.has(year)) { annualByYear.set(year, { ...a, source: a.source || 'vendor' }); usedVendor = true; }
  }
  const annuals = [...annualByYear.values()].sort((a, b) => a.end.localeCompare(b.end));

  // The fiscal-year end is the 10-K's own month when there is one, otherwise the latest annual column.
  const fyEndMonth = sec.fy?.end ? Number(String(sec.fy.end).slice(5, 7))
    : annuals.length ? Number(String(annuals[annuals.length - 1].end).slice(5, 7)) : 12;
  const fiscalOf = (end) => {
    const m = Number(String(end).slice(5, 7));
    const y = Number(String(end).slice(0, 4));
    if (fyEndMonth === 12) return { fy: y, q: Math.ceil(m / 3) };
    const q = Math.floor((((m - fyEndMonth + 12) % 12) - 1) / 3) + 1;
    return { fy: m > fyEndMonth ? y + 1 : y, q: Math.max(1, Math.min(4, q)) };
  };
  const fyStart = (fy) => (fyEndMonth === 12
    ? `${fy}-01-01`
    : `${fy - 1}-${String(fyEndMonth + 1).padStart(2, '0')}-01`);

  // A vendor period is only a candidate when it is next to the filed record. Before the first 10-Q,
  // the S-1 still has the year the company listed in and the one before it; older private-company
  // periods (and a pre-IPO half-year feed that repeats the same number in Q1 and Q2) are not turned
  // into quarters.
  const firstSec = secQuarters[0]?.end;
  let vendorQuarters = (vendor?.quarters || []).map((q) => ({ ...q, source: q.source || 'vendor' }));
  if (firstSec) vendorQuarters = vendorQuarters.filter((q) => q.end >= shiftYear(firstSec));
  else {
    const years = [...new Set(vendorQuarters.map((q) => fiscalOf(q.end).fy))].sort((a, b) => b - a);
    const keep = new Set(years.slice(0, 3));
    vendorQuarters = vendorQuarters.filter((q) => keep.has(fiscalOf(q.end).fy));
  }

  const byEnd = new Map();
  for (const q of secQuarters) byEnd.set(q.end, q);
  for (const q of vendorQuarters) {
    const same = [...byEnd.values()].find((x) => Math.abs((Date.parse(x.end) - Date.parse(q.end)) / 864e5) <= 6);
    if (same) {
      // A tagged quarter can leave a line blank (a concept the filing does not tag, or EPS). The
      // vendor fills only that blank; a value EDGAR did tag is never replaced.
      let filled = false;
      if (same.revenue == null && q.revenue != null) { same.revenue = q.revenue; filled = true; }
      if (same.netIncome == null && q.netIncome != null) { same.netIncome = q.netIncome; filled = true; }
      if (same.eps == null && q.eps != null) { same.eps = q.eps; filled = true; }
      if (filled) { same.source = 'sec+vendor'; usedVendor = true; }
      continue;
    }
    byEnd.set(q.end, q);
    usedVendor = true;
  }

  // Label every period before the derivation below: a vendor period arrives with a date but no
  // fiscal Q, and the Q4 subtraction has to know which quarter is missing.
  for (const q of byEnd.values()) {
    const f = fiscalOf(q.end);
    if (q.fy == null) q.fy = f.fy;
    if (q.q == null) q.q = f.q;
  }

  // Keep a vendor-only fiscal year only when it is complete or it is the current year. This drops
  // Cerebras's pre-IPO Q1/Q2 pair, which is one half-year repeated rather than two quarters.
  const secYears = new Set(secQuarters.map((q) => fiscalOf(q.end).fy));
  const allYears = [...new Set([...byEnd.values()].map((q) => fiscalOf(q.end).fy))];
  const latestYear = Math.max(...allYears, ...annuals.map((a) => Number(String(a.end).slice(0, 4))));
  const keepYear = (year) => {
    if (secYears.has(year) || year === latestYear) return true;
    const qs = [...byEnd.values()].filter((q) => fiscalOf(q.end).fy === year);
    if (qs.filter((q) => q.revenue != null && q.netIncome != null).length >= 4) return true;
    // A pre-IPO year with an annual record and three quarters is kept so the Q4 can be derived below.
    return qs.length >= 3 && annuals.some((a) => Number(String(a.end).slice(0, 4)) === year);
  };
  for (const end of [...byEnd.keys()]) if (!keepYear(fiscalOf(end).fy)) byEnd.delete(end);

  // A fiscal year with an annual record and exactly three quarters can be completed by subtraction:
  // the missing quarter is the annual less the three periods. This is how SpaceX and Cerebras get
  // the Q4 their first 10-Q does not carry. EPS is left blank because per-share figures are not additive.
  for (const a of annuals) {
    const year = Number(String(a.end).slice(0, 4));
    const qs = [...byEnd.values()].filter((q) => fiscalOf(q.end).fy === year);
    if (qs.length !== 3) continue;
    const missing = [1, 2, 3, 4].find((q) => !qs.some((x) => x.q === q));
    if (!missing || qs.some((q) => q.revenue == null || q.netIncome == null)) continue;
    if (a.revenue == null || a.netIncome == null) continue;
    const revenue = a.revenue - qs.reduce((s, q) => s + q.revenue, 0);
    const netIncome = a.netIncome - qs.reduce((s, q) => s + q.netIncome, 0);
    if (revenue < 0) continue;
    const priorSame = [...byEnd.values()].find((q) => fiscalOf(q.end).fy === year - 1 && q.q === missing);
    let end = priorSame ? shiftYear(priorSame.end) : a.end;
    if (missing !== 4) {
      const d = new Date(a.end + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() - (4 - missing) * 3);
      end = d.toISOString().slice(0, 10);
    }
    byEnd.set(end, { end, fy: year, q: missing, revenue, netIncome, eps: null, derived: true, source: 'derived' });
  }

  const quarters = [...byEnd.values()].map((q) => {
    const f = q.fy && q.q ? { fy: q.fy, q: q.q } : fiscalOf(q.end);
    return { ...q, fy: f.fy, q: f.q, source: q.source || 'vendor' };
  }).sort((a, b) => a.end.localeCompare(b.end));
  out.quarters = quarters;
  out.annual = annuals;

  // Annual record: the last 10-K wins, otherwise the latest vendor year that ends before the quarter.
  const lastEnd = quarters[quarters.length - 1]?.end || null;
  const fyRow = (sec.fy ? { ...sec.fy, source: 'sec' } : null)
    || [...annuals].reverse().find((a) => !lastEnd || a.end < lastEnd)
    || null;
  out.fy = fyRow ? { end: fyRow.end, revenue: fyRow.revenue, netIncome: fyRow.netIncome, source: fyRow.source || 'vendor' } : null;

  // Current year to date: the filing's own YTD, otherwise the sum of the current fiscal year's quarters.
  let latest = sec.latest ? { ...sec.latest, source: 'sec' } : null;
  if (!latest && lastEnd) {
    const f = fiscalOf(lastEnd);
    const qs = quarters.filter((q) => fiscalOf(q.end).fy === f.fy);
    if (qs.length) {
      latest = {
        start: fyStart(f.fy), end: lastEnd,
        revenue: qs.every((q) => q.revenue != null) ? qs.reduce((s, q) => s + q.revenue, 0) : null,
        netIncome: qs.every((q) => q.netIncome != null) ? qs.reduce((s, q) => s + q.netIncome, 0) : null,
        source: 'vendor',
      };
    }
  }
  out.latest = latest;
  // The same period a year earlier is what turns the year to date into a trailing twelve months.
  let prior = sec.prior ? { ...sec.prior, source: 'sec' } : null;
  if (!prior && latest && lastEnd) {
    const f = fiscalOf(lastEnd);
    const same = quarters.filter((q) => fiscalOf(q.end).fy === f.fy - 1 && fiscalOf(q.end).q <= f.q);
    if (same.length === f.q) {
      prior = {
        start: fyStart(f.fy - 1), end: shiftYear(latest.end),
        revenue: same.every((q) => q.revenue != null) ? same.reduce((s, q) => s + q.revenue, 0) : null,
        netIncome: same.every((q) => q.netIncome != null) ? same.reduce((s, q) => s + q.netIncome, 0) : null,
        source: 'vendor',
      };
    }
  }
  out.prior = prior;

  // Balance-sheet lines: EDGAR first; the vendor fills only a line EDGAR did not tag.
  if (out.assets == null && vendor?.assets != null) { out.assets = vendor.assets; usedVendor = true; }
  if (out.equity == null && vendor?.equity != null) { out.equity = vendor.equity; usedVendor = true; }

  let ttmRev = null, ttmNi = null, ttmEnd = lastEnd;
  if (out.fy && latest && prior) {
    if (latest.end > out.fy.end) {
      ttmRev = out.fy.revenue != null && latest.revenue != null && prior.revenue != null
        ? out.fy.revenue + latest.revenue - prior.revenue : null;
      ttmNi = out.fy.netIncome != null && latest.netIncome != null && prior.netIncome != null
        ? out.fy.netIncome + latest.netIncome - prior.netIncome : null;
    } else {
      ttmRev = out.fy.revenue;
      ttmNi = out.fy.netIncome;
    }
    ttmEnd = latest.end;
  }
  // A company with no annual report can still have four contiguous quarters; only then is their sum a TTM.
  if (ttmRev == null && quarters.length >= 4) {
    const last4 = quarters.slice(-4);
    const span = (Date.parse(last4[3].end) - Date.parse(last4[0].end)) / (864e5 * 30.44);
    if (last4.every((q) => q.revenue != null) && Math.abs(span - 9) <= 2) {
      ttmRev = last4.reduce((s, q) => s + q.revenue, 0);
      ttmNi = last4.every((q) => q.netIncome != null) ? last4.reduce((s, q) => s + q.netIncome, 0) : null;
      ttmEnd = last4[3].end;
    }
  }
  out.basis = ttmRev != null ? 'TTM' : (latest ? 'PERIOD' : null);
  out.ttm = ttmRev != null
    ? { end: ttmEnd, revenue: ttmRev, netIncome: ttmNi, equity: out.equity, assets: out.assets }
    : null;

  // Growth keeps the filed three-year rate where one exists; a company with only pre-IPO vendor years
  // gets the same two-year window the other new listings use, rather than a rate over a longer history.
  out.revenueCagr = sec.revenueCagr ?? null;
  if (out.revenueCagr == null) {
    const positive = annuals.filter((a) => a.revenue > 0).slice(-3);
    if (positive.length === 3) {
      const a = positive[0], b = positive[2];
      const n = SEC_DAY(a.end, b.end) / 365.25;
      if (n >= 2 && n <= 3.5) out.revenueCagr = +((Math.pow(b.revenue / a.revenue, 1 / n) - 1) * 100).toFixed(1);
    }
  }

  const ni = out.ttm?.netIncome;
  out.pe = ni != null && ni > 0 && capUsd ? +(capUsd / ni).toFixed(1) : null;
  out.roe = ni != null && out.equity > 0 ? +((ni / out.equity) * 100).toFixed(1) : null;
  out.netMargin = ni != null && out.ttm.revenue > 0 ? +((ni / out.ttm.revenue) * 100).toFixed(1) : null;
  // A foreign private issuer can have a 6-K without any XBRL in companyfacts, so the source label
  // follows the statement record rather than the filing form.
  const hasSecXbrl = !!(sec.quarters?.length || sec.annual?.length || sec.fy || sec.latest);
  out.source = hasSecXbrl
    ? (usedVendor ? 'SEC XBRL + stockanalysis.com' : 'SEC XBRL')
    : (sec.latestFiling ? 'stockanalysis.com (6-K/F-1, USD)' : 'stockanalysis.com (S-1/prospectus)');
  out.quartersSource = out.source;
  return out;
}

// A pre-IPO row becomes a listed row on its first close. The listing date is the first tape bar and
// the IPO price is the 424B4 cover, so the promotion uses the same primary sources as the audit.
async function ipoPriceFrom424B4(cik, listedAt) {  if (!listedAt) return null;
  const id = String(cik).padStart(10, '0');
  const sub = await getRawJSON(`https://data.sec.gov/submissions/CIK${id}.json`, { 'User-Agent': SEC_UA });
  await sleep(250);
  const rec = sub?.filings?.recent || {};
  for (let i = 0; i < (rec.form || []).length; i++) {
    if (rec.form[i] !== '424B4') continue;
    const filed = rec.filingDate?.[i] || '';
    if (!filed || Math.abs((Date.parse(filed) - Date.parse(listedAt)) / 864e5) > 20) continue;
    const acc = String(rec.accessionNumber?.[i] || '').replace(/-/g, '');
    const doc = rec.primaryDocument?.[i] || '';
    if (!acc || !doc) continue;
    try {
      const res = await fetch(`https://www.sec.gov/Archives/edgar/data/${id}/${acc}/${doc}`, { headers: { 'User-Agent': SEC_UA } });
      if (!res.ok) return null;
      const html = await res.text();
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
      const cover = /initial public offering price (?:is|of)\s*\$([0-9]{1,3}(?:\.[0-9]{2})?)/i.exec(text);
      const perShare = /\$([0-9]{1,3}\.[0-9]{2})\s*per\s+(?:ordinary |common )?share/i.exec(text);
      const price = Number((cover && cover[1]) || (perShare && perShare[1]));
      return Number.isFinite(price) ? price : null;
    } catch { return null; }
  }
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const listedLabel = (d) => {
  const x = new Date(d + 'T00:00:00Z');
  return `${String(x.getUTCDate()).padStart(2, '0')} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};

// The pre-IPO row has the same statement shape as a listed one, but no tape: price, cap, 52-week
// range and returns stay null instead of becoming zero or a made-up valuation.
function preIpoRow(base, kept, prof) {
  const p = PRE_IPO[base.ticker];
  if (!p) return null;
  const fin = p.financials;
  return {
    ...(kept || {}), ...base,
    market: 'us', currency: 'USD', status: 'pre-ipo', preIpo: true,
    price: null, priceDate: null, prevClose: null, chg1d: null, chg6m: null,
    capUsd: null, shares: null, wk52Low: null, wk52High: null, firstClose: null,
    pe: null, roe: fin.roe ?? null, ytd: null, vsIpo: null, series: [],
    description: base.description || prof?.description || kept?.description || null,
    descriptionSource: base.descriptionSource || prof?.descriptionSource || kept?.descriptionSource || null,
    financials: { ...fin, preIpo: true, periodBasis: p.periodBasis },
    netMargin: fin.netMargin ?? null,
    revenueCagr: fin.revenueCagr ?? null,
    revenueGrowth: fin.revenueGrowth ?? null,
    growthYears: fin.growthYears ?? null,
    periodBasis: p.periodBasis,
    sector: base.sector || kept?.sector || 'Other',
    nasdaqSector: base.nasdaqSector || kept?.nasdaqSector || null,
    industry: base.industry || kept?.industry || null,
    exchange: base.exchange || kept?.exchange || null,
    priceRange: base.priceRange || null,
    why: base.why,
  };
}

// A written profile. The index members are described from stockanalysis.com's company page (not the
// 10-K's legal "Item 1" text, and not Nasdaq's marketing blurb), so a new listing gets the same
// treatment; when that page does not exist yet, the vendor's own description is labelled as such
// rather than leaving the page blank.
async function profile(ticker) {
  try {
    const res = await fetch(`https://stockanalysis.com/stocks/${String(ticker).toLowerCase()}/company/`, {
      headers: { 'User-Agent': UA }, redirect: 'follow',
    });
    if (res.ok) {
      const html = await res.text();
      const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
      if (box) {
        const paras = [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' '));
        const text = paras.join(' ')
          .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ').trim();
        if (text.length > 120) return { description: text, descriptionSource: 'stockanalysis.com' };
      }
    }
  } catch { /* fall through to the vendor blurb */ }
  const d = await getJSON(`https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/company-profile?assetclass=stocks`);
  const text = (((d || {}).CompanyDescription || {}).value || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? { description: text, descriptionSource: 'nasdaq' } : { description: null, descriptionSource: null };
}

const prev = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { companies: [] };
const prevBy = new Map((prev.companies || []).map((c) => [c.ticker, c]));
const out = [];

for (const entry of BASE) {
  const base = { ...entry };
  const kept = prevBy.get(base.ticker);
  const q = await quote(base.ticker);
  await sleep(400);   // Nasdaq throttles a burst of seven names; space the calls out
  // The profile does not depend on the quote, so it is fetched before the guard: a throttled Nasdaq
  // call must not also cost the reader their description.
  const prof = await profile(base.ticker);

  // A filed but not-yet-trading issuer keeps its S-1 financials and null quote fields. On the first
  // close it is promoted below, with the listing date from the tape and the IPO price from the 424B4.
  if (base.preIpo && (!q || !q.price || !q.cap)) {
    const row = preIpoRow(base, kept, prof);
    if (!row) {
      console.warn(`${base.ticker}: pre-IPO row has no S-1 financials — skipped`);
      continue;
    }
    out.push(row);
    const ttm = row.financials.ttm;
    console.log(`${base.ticker.padEnd(5)} pre-IPO · ${ttm ? 'TTM rev ' + (ttm.revenue / 1e9).toFixed(2) + 'B' : 'no TTM'} · ${row.financials.quarters.length} periods · ${row.financials.source} · ${row.description ? row.description.length + ' chars' : 'no profile'}`);
    continue;
  }
  if (base.preIpo) {
    const floor = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
    const first = await history(base.ticker, floor);
    if (!first.length) {
      const row = preIpoRow(base, kept, prof);
      if (row) { out.push(row); console.log(`${base.ticker.padEnd(5)} pre-IPO · no tape yet · ${row.financials.source}`); }
      continue;
    }
    base.listedAt = first[0]?.[0] || null;
    base.ipoPrice = await ipoPriceFrom424B4(base.cik, base.listedAt);
    base.preIpo = false;
    delete base.status;
    base.why = base.listedAt ? `Listed ${listedLabel(base.listedAt)} · not an index constituent yet` : base.why;
    console.log(`${base.ticker}: IPO priced — promoted to a listed row (${base.listedAt}, IPO $${base.ipoPrice})`);
  }

  const curated = {
    ticker: base.ticker, cik: base.cik, name: base.name, legalName: base.legalName,
    listedAt: base.listedAt, ipoPrice: base.ipoPrice, exchange: base.exchange, why: base.why,
    brands: base.brands || [], aliases: base.aliases || [],
  };
  let row;
  if (!q || !q.price || !q.cap || (!q.sector && !base.sector)) {
    // Never write a half row because a vendor blinked: without a price, a cap and a sector the row
    // would claim a $0 company. Keep the previous one (with the fresh profile) and say so. The
    // filings are still refreshed below, so a new 10-Q lands even when Nasdaq is throttled.
    if (!kept) {
      console.warn(`${base.ticker}: no quote and no previous row — skipped`);
      continue;
    }
    row = { ...kept, ...curated, ...prof };
    console.warn(`${base.ticker}: incomplete quote (${Object.entries({ price: q && q.price, cap: q && q.cap, sector: q && q.sector }).filter(([, v]) => !v).map(([k]) => k).join(',')}) — kept the previous row`);
  } else {
    // From the listing date (capped at three years), so the company page can draw a chart over the whole
    // life of the listing and `firstClose` really is the first close, not the first close in a window.
    const floor = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
    const from = base.listedAt < floor ? floor : base.listedAt;
    const fresh = await history(base.ticker, from);
    // A failed history call is not a reason to lose yesterday's chart: keep the last good series and
    // quote the row off its final close so the price and the tape cannot disagree.
    const series = fresh.length ? fresh : (kept?.series || []);
    const lastBar = series.length ? series[series.length - 1] : null;
    const prevBar = series.length > 1 ? series[series.length - 2] : null;
    const price = lastBar ? lastBar[1] : q.price;
    const priceDate = lastBar ? lastBar[0] : new Date().toISOString().slice(0, 10);
    // The vendor's cap is live; scale it to the close we store so cap = price × shares exactly.
    const shares = q.price && q.cap ? q.cap / q.price : null;
    const capUsd = shares && price ? Math.round(price * shares) : q.cap;
    const lastDate = lastBar ? lastBar[0] : null;
    const dayBack = (days) => (lastDate ? new Date(Date.parse(lastDate) - days * 864e5).toISOString().slice(0, 10) : null);
    const window52 = lastDate ? series.filter(([d]) => d >= dayBack(365)) : [];
    const tapeLow = window52.length ? Math.min(...window52.map(([, v]) => v)) : null;
    const tapeHigh = window52.length ? Math.max(...window52.map(([, v]) => v)) : null;
    const wkLow = (q.wk52Low ?? tapeLow) == null ? null : Math.min(q.wk52Low ?? tapeLow, price);
    const wkHigh = (q.wk52High ?? tapeHigh) == null ? null : Math.max(q.wk52High ?? tapeHigh, price);
    const year = new Date().getUTCFullYear();
    const priorYearEnd = [...series].reverse().find(([d]) => d < `${year}-01-01`);
    const sixmAgo = lastDate ? [...series].reverse().find(([d]) => d <= dayBack(182)) : null;
    row = {
      ...base,
      market: 'us',
      currency: 'USD',
      price,
      priceDate,
      prevClose: prevBar ? prevBar[1] : q.prevClose,
      chg1d: prevBar ? +(((price / prevBar[1]) - 1) * 100).toFixed(2) : q.chg1d,
      chg6m: sixmAgo && sixmAgo[1] > 0 ? +(((price / sixmAgo[1]) - 1) * 100).toFixed(2) : null,
      capUsd,
      shares: shares ? Math.round(shares) : null,
      sector: q.sector ? sectorOf(q.sector) : (base.sector || 'Other'),
      nasdaqSector: q.sector || base.nasdaqSector || null,
      industry: q.industry || base.industry || null,
      wk52Low: wkLow,
      wk52High: wkHigh,
      firstClose: series.length ? series[0][1] : null,
      // A loss-making company has no trailing P/E, and a company that listed this year has no full-year
      // return. Both stay null rather than becoming a number that means nothing.
      pe: null,
      roe: null,
      ytd: priorYearEnd ? +(((price / priorYearEnd[1]) - 1) * 100).toFixed(2) : null,
      vsIpo: base.ipoPrice ? +(((price / base.ipoPrice) - 1) * 100).toFixed(2) : null,
      series,
    };
  }

  // Same evening as a 10-Q lands for an index member: re-read EDGAR, then fill the pre-first-10-Q
  // years from the vendor. The merge keeps every SEC-tagged value and only adds what EDGAR lacks.
  // The previous committed history is a last-resort backstop, so a vendor outage cannot blank a page
  // that already had its quarters and TTM.
  const secFin = await filings(base.cik, row.capUsd);
  const vendor = await vendorStatements(base.ticker);
  await sleep(300);
  const fallback = kept?.financials ? {
    quarters: kept.financials.quarters || [],
    annuals: kept.financials.annual || [],
    assets: kept.financials.assets ?? null,
    equity: kept.financials.equity ?? null,
  } : null;
  const backfill = vendor ? {
    ...vendor,
    quarters: [...(vendor.quarters || []), ...(fallback?.quarters || [])],
    annuals: [...(vendor.annuals || []), ...(fallback?.annuals || [])],
    assets: vendor.assets ?? fallback?.assets ?? null,
    equity: vendor.equity ?? fallback?.equity ?? null,
  } : fallback;
  const fin = mergeFinancials(secFin, backfill, row.capUsd);
  row.description = prof.description || row.description || null;
  row.descriptionSource = prof.descriptionSource || row.descriptionSource || null;
  row.financials = fin;
  row.pe = fin.pe == null ? null : fin.pe;
  row.roe = fin.roe == null ? null : fin.roe;
  row.netMargin = fin.netMargin == null ? null : fin.netMargin;
  row.revenueCagr = fin.revenueCagr == null ? null : fin.revenueCagr;
  out.push(row);
  console.log(`${base.ticker.padEnd(5)} $${row.price} · ${(row.capUsd / 1e9).toFixed(0)}B · ${row.series.length} closes · vs IPO ${row.vsIpo?.toFixed(1)}% · ${fin.basis || 'no annual report'}${fin.ttm ? ' · TTM rev ' + (fin.ttm.revenue / 1e9).toFixed(1) + 'B' : ''}${fin.pe ? ' · P/E ' + fin.pe : ''} · ${fin.quarters.length} quarters · ${fin.source}${fin.latestFiling ? ' · ' + fin.latestFiling.form + ' ' + fin.latestFiling.filed : ''} · ${prof.description ? prof.description.length + ' chars' : 'no profile'}`);
}

const payload = {
  updated: new Date().toISOString(),
  source: 'Nasdaq quote + historical (delayed); listing dates and IPO prices from the 424B4 prospectus; statements from SEC XBRL where filed, with 6-K/F-1 and pre-IPO periods from stockanalysis.com',
  note: 'Listed but not index members. Kept out of the index totals on purpose — a company with a day of trading history would skew breadth, the median P/E and the sector split.',
  companies: out,
};

if (DRY) {
  console.log(JSON.stringify(payload.companies.map(({ series, ...c }) => c), null, 1));
} else {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, FILE);
  console.log(`wrote ${FILE} · ${out.length} companies`);
}
