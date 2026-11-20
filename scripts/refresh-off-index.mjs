// Off-index coverage: the large caps that are listed but are not in any of the index universes this
// desk builds from (S&P 1500, TOPIX, KOSPI, …). They are real public companies with real quotes and
// real filings — they are simply not index members yet, so nothing in the ten-market build reaches
// them.
//
// The list is curated (a ticker and its listing facts), the market data is fetched, and the output is
// committed. Nothing here is estimated: a price comes from Nasdaq, the listing date and IPO price
// come from the 424B4 prospectus, and a ratio the filings cannot support stays null.
//
//   node scripts/refresh-off-index.mjs             # refresh prices, caps and series
//   node scripts/refresh-off-index.mjs --dry       # print, write nothing

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'off-index.json');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Curated facts. `listedAt`, `ipoPrice` and `why` do not come from a price feed: they come from the
// listing prospectus and the exchange notice, so they live here and are not overwritten by a refresh.
const BASE = [
  {
    ticker: 'SPCX', cik: '1181412', name: 'SpaceX', legalName: 'Space Exploration Technologies Corp.',
    listedAt: '2026-06-12', ipoPrice: 135,
    why: 'Listed 12 Jun 2026 · not an index constituent yet',
  },
  {
    ticker: 'ANT', cik: '2130357', name: 'Anthropic', legalName: 'Anthropic, PBC',
    listedAt: '2026-11-19', ipoPrice: 83,
    why: 'Listed 19 Nov 2026 · not an index constituent yet',
  },
  {
    ticker: 'CBRS', cik: '2021728', name: 'Cerebras Systems', legalName: 'Cerebras Systems Inc.',
    listedAt: '2026-05-14', ipoPrice: 185,
    why: 'Listed 14 May 2026 · not an index constituent yet',
  },
  {
    ticker: 'CRWV', cik: '1769628', name: 'CoreWeave', legalName: 'CoreWeave, Inc.',
    listedAt: '2025-03-28', ipoPrice: 40,
    why: 'Listed 28 Mar 2025 · not an index constituent yet',
  },
];

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

async function getJSON(url, tries = 3) {
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

const prev = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { companies: [] };
const prevBy = new Map((prev.companies || []).map((c) => [c.ticker, c]));
const out = [];

for (const base of BASE) {
  const q = await quote(base.ticker);
  if (!q || !q.price) {
    // Never drop a name because a vendor blinked: keep yesterday's row and say so.
    const kept = prevBy.get(base.ticker);
    if (kept) out.push(kept);
    console.warn(`${base.ticker}: no quote — kept the previous row`);
    continue;
  }
  // From the listing date (capped at three years), so the company page can draw a chart over the whole
  // life of the listing and `firstClose` really is the first close, not the first close in a window.
  const floor = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
  const from = base.listedAt < floor ? floor : base.listedAt;
  const series = await history(base.ticker, from);
  const firstClose = series.length ? series[0][1] : null;
  const year = new Date().getUTCFullYear();
  const priorYearEnd = [...series].reverse().find(([d]) => d < `${year}-01-01`);
  out.push({
    ...base,
    market: 'us',
    exchange: 'NASDAQ',
    price: q.price,
    priceDate: new Date().toISOString().slice(0, 10),
    prevClose: q.prevClose,
    chg1d: q.chg1d,
    capUsd: q.cap,
    sector: sectorOf(q.sector),
    nasdaqSector: q.sector,
    industry: q.industry,
    wk52Low: q.wk52Low,
    wk52High: q.wk52High,
    firstClose,
    // A loss-making company has no trailing P/E, and a company that listed this year has no full-year
    // return. Both stay null rather than becoming a number that means nothing.
    pe: null,
    roe: null,
    ytd: priorYearEnd ? +(((q.price / priorYearEnd[1]) - 1) * 100).toFixed(2) : null,
    vsIpo: base.ipoPrice ? +(((q.price / base.ipoPrice) - 1) * 100).toFixed(2) : null,
    series,
  });
  console.log(`${base.ticker.padEnd(5)} $${q.price} · ${(q.cap / 1e9).toFixed(0)}B · ${series.length} closes · vs IPO ${(((q.price / base.ipoPrice) - 1) * 100).toFixed(1)}%`);
}

const payload = {
  updated: new Date().toISOString(),
  source: 'Nasdaq quote + historical (delayed); listing dates and IPO prices from the 424B4 prospectus',
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
