// NSE helpers for the India build.
//
// The universe is the NIFTY 500 constituent file: a keyless CSV from niftyindices.com with the company
// name, the NSE industry, the NSE symbol, the trading series and the ISIN. It is the only free file that
// carries both a complete large/mid-cap universe and a sector on the same row, so unlike Australia there
// is no "Not Applic" fallback to resolve.
//
// Two things are specific to this market:
//   - Symbols carry '&' and '-' ("M&M", "BAJAJ-AUTO", "J&KBANK"). stockanalysis spells both as '_' in
//     the slug, Yahoo wants the raw symbol percent-encoded. Getting this wrong silently drops exactly
//     the companies whose names an analyst searches for.
//   - The NSE industry is a macro sector (20 values), not a GICS industry group. It is published as the
//     sector, and the profile's GICS industry is used only to tell a bank from an insurer.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCached } from './stockanalysis.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'cache');
export const IN_CACHE = join(CACHE, 'nse');
export const IN_SA = join(CACHE, 'india-sa');
mkdirSync(IN_CACHE, { recursive: true });
mkdirSync(IN_SA, { recursive: true });

// niftyindices serves the constituent list; the NSE archive holds the same symbols in a bigger file
// (2,600 listed) if the index file ever moves. The build uses the index file and counts the universe.
export const NIFTY500_URL = 'https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv';
export const NSE_ALL_URL = 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';

function csvFields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Company Name,Industry,Symbol,Series,ISIN Code
export function parseNifty500(text) {
  const rows = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let started = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!started) {
      if (/^"?Company Name"?\s*,/i.test(line)) started = true;
      continue;
    }
    const f = csvFields(line);
    if (f.length < 5) continue;
    const name = f[0].replace(/\s+/g, ' ').trim();
    const industry = f[1].replace(/\s+/g, ' ').trim();
    const code = f[2].trim().toUpperCase();
    const series = f[3].trim().toUpperCase();
    const isin = f[4].trim();
    if (!code || !name) continue;
    rows.push({ code, name, industry, series, isin });
  }
  return rows;
}

// EQ is the ordinary line, BE the trade-to-trade line. RR is a REIT/InvIT unit and is not a company;
// anything else (SM/ST) is a small-platform listing the index file does not carry.
export const isOrdinaryLine = (series) => /^(EQ|BE)$/.test(String(series || '').trim().toUpperCase());

export async function nifty500({ fresh = false, ttlMs = 24 * 3600e3 } = {}) {
  const f = join(IN_CACHE, 'ind_nifty500list.json');
  const text = await getCached(NIFTY500_URL, f, { fresh, ttlMs, timeout: 45000, retries: 4 });
  if (!text) throw new Error('NIFTY 500 CSV returned nothing');
  const rows = parseNifty500(text);
  if (!rows.length) throw new Error('NIFTY 500 CSV parsed to zero rows');
  return { rows, fetched: new Date().toISOString() };
}

// NSE symbols are upper case and already unique; no padding step, but the accessor keeps the shared
// build shape readable.
export const pad = (code) => String(code || '').trim().toUpperCase();

// stockanalysis writes '&' and '-' as '_' in the slug: M&M → M_M, BAJAJ-AUTO → BAJAJ_AUTO.
export const saSlug = (code) => pad(code).replace(/[&-]/g, '_');
export const saPage = (code, page = '', quarterly = false) =>
  `https://stockanalysis.com/quote/nse/${saSlug(code)}/financials/${page}/${quarterly ? '?p=quarterly' : ''}`;
export const saProfile = (code) => `https://stockanalysis.com/quote/nse/${saSlug(code)}/company/`;

// Yahoo wants the exchange's own symbol, percent-encoded: M&M.NS is M%26M.NS on the wire.
export const yaSymbol = (code) => `${encodeURIComponent(pad(code))}.NS`;

// The NIFTY 50 is the index the market page is anchored on; ^NSEI is the same series Yahoo publishes.
export const INDEX_SYMBOL = '^NSEI';

// Financial Services is the NSE macro sector. It holds banks, NBFCs, insurers, AMCs, brokers and the
// exchanges, which are four different businesses: the sector-wide rule withholds free cash flow from
// all of them, and the industry tells a bank from an insurer.
export const isFinancialSector = (sector) => /^Financial Services$/i.test(String(sector || '').trim());

// Bank-like: a lender's revenue is interest income, it reports no operating-profit line, and its cash
// flow statement is loans and deposits rather than free cash flow.
const LENDER_INDUSTRY = /bank|nbfc|non[- ]banking|housing finance|microfinance|consumer finance|financial institution|credit services|mortgage/i;
export const isBankLike = (c = {}) => {
  const sector = String(c.sector || '').trim();
  const industry = String(c.industry || '').trim();
  // An insurer is never a lender, even when the vendor omits the operating line.
  if (isInsurer(industry)) return false;
  if (LENDER_INDUSTRY.test(industry)) return true;
  if (!isFinancialSector(sector)) return false;
  const ttm = c.ttm || (c.reports && c.reports.ttm) || {};
  // A financial with no operating-profit line and no industry label is a lender until proven otherwise.
  return ttm.operatingProfit == null;
};

// Insurers report an operating line and keep their margin; their investing cash flow is the investment
// portfolio, so free cash flow is withheld for the sector as a whole (the US/Japan/HK/AU rule).
export const isInsurer = (industry) => /insurance|reinsurance/i.test(String(industry || ''));
