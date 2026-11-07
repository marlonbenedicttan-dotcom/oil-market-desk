// IDX helpers for the Indonesia build.
//
// The exchange's own site (idx.co.id) blocks this network at the edge: every path — the JSON APIs, the
// static PDFs, the HTML pages — answers a Cloudflare "Sorry, you have been blocked" 403, and a headless
// browser gets the same page because it is an IP rule, not a JavaScript challenge. So the universe comes
// from the same keyless source the statements do: stockanalysis.com's Indonesia exchange list, which
// carries every listed line with its ticker, company name and market cap, in pages of 500.
//
// Two things are specific to this market:
//   - The list is alphabetical by ticker and its first 500 rows are NOT the largest 500; the whole list
//     is paged until a short page, so a micro-cap is never silently dropped.
//   - Three of the 915 rows are not companies (two listed REITs and one mutual fund). They are named and
//     excluded rather than fetched, because a fund has no operating company behind the statement page.
//     Anything else without a statement page is dropped by the build and counted, never estimated.
//
// Symbols are four characters with no punctuation, so the stockanalysis slug and the Yahoo symbol are
// the ticker itself; only the Yahoo suffix differs (.JK).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getCached } from './stockanalysis.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ID_CACHE = join(ROOT, 'data', 'cache', 'idx');
export const ID_SA = join(ROOT, 'data', 'cache', 'indonesia-sa');
mkdirSync(ID_CACHE, { recursive: true });
mkdirSync(ID_SA, { recursive: true });

// The list is paged at 500 rows. Seven pages is a hard ceiling so a broken paginator cannot loop.
export const listUrl = (page) => `https://stockanalysis.com/list/indonesia-stock-exchange/${page > 1 ? `?page=${page}` : ''}`;
export const PAGE_SIZE = 500;
export const MAX_PAGES = 7;

// The only non-companies on the vendor's list: two listed real-estate funds and one mutual fund.
// XSPI / XCIS are REITs (Dana Investasi Real Estat / DIRE); XBGS is a gold equity fund with no cap.
export const NON_COMPANIES = new Set(['XSPI', 'XCIS', 'XBGS']);

// IDX codes are four upper-case letters/digits ("BBCA", "AADI", "GULA"). Keeping the filter loose enough
// for a digit is deliberate — the exchange has used them — but strict enough that a table artefact is not
// treated as a listing.
export const isOrdinaryLine = (code) => /^[A-Z0-9]{4}$/.test(String(code || '').trim().toUpperCase());

export const pad = (code) => String(code || '').trim().toUpperCase();

// stockanalysis spells the IDX ticker exactly as the exchange does; no slug rewrite is needed.
export const saSlug = (code) => pad(code);
export const saPage = (code, page = '', quarterly = false) =>
  `https://stockanalysis.com/quote/idx/${saSlug(code)}/financials/${page}/${quarterly ? '?p=quarterly' : ''}`;
export const saProfile = (code) => `https://stockanalysis.com/quote/idx/${saSlug(code)}/company/`;

// Yahoo wants the IDX ticker plus the Jakarta suffix: BBCA.JK.
export const yaSymbol = (code) => `${encodeURIComponent(pad(code))}.JK`;

// The index the market page is anchored on. ^JKSE is the IDX Composite and is already wired into the
// MACRO tab, where it is live and current — so the companies page uses the same verified series.
export const INDEX_SYMBOL = '^JKSE';

// GICS sector. The vendor profile is the only free sector source for IDX (the exchange list carries no
// industry column), so the eleven GICS sectors are published as the market's sectors.
export const isFinancialSector = (sector) => /^Financials$/i.test(String(sector || '').trim());

// Bank-like: a lender's revenue is interest income, it reports no operating-profit line, and its cash
// flow statement is loans and deposits rather than free cash flow. Indonesian "multi-finance" companies
// and securities houses behave the same way for a ratio table, so they follow the lender rule.
const LENDER_INDUSTRY = /bank|financ|credit|mortgage|consumer finance|capital markets|securities|investment|leasing|multi[- ]?finance/i;
export const isInsurer = (industry) => /insurance|reinsurance/i.test(String(industry || ''));
export const isBankLike = (c = {}) => {
  const industry = String(c.industry || '').trim();
  if (isInsurer(industry)) return false;
  if (LENDER_INDUSTRY.test(industry)) return true;
  if (!isFinancialSector(c.sector)) return false;
  const ttm = c.ttm || (c.reports && c.reports.ttm) || {};
  return ttm.operatingProfit == null;
};

// One list row → { code, name, vendorCap }. The table's cells are rank · symbol · company · market cap
// · price · change · revenue, and the market cap is a display string ("638.78T", "-").
export function parseListPage(html) {
  const rows = [];
  for (const tr of String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const m = /href="\/quote\/idx\/([A-Z0-9]+)\/"/.exec(tr[1]);
    if (!m) continue;
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const code = m[1].toUpperCase();
    if (!isOrdinaryLine(code)) continue;
    rows.push({ code, name: cells[2] || null, vendorCap: parseCap(cells[3]) });
  }
  return rows;
}

// "638.78T" → 638.78e12 rupiah; "-" / "" → null. The value is the vendor's headline cap, kept only as a
// cross-check in the audit — never used to compute a ratio.
export function parseCap(text) {
  const m = /^([\d.,]+)\s*([KMBT])$/i.exec(String(text || '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()];
  return mult ? Math.round(n * mult) : null;
}

// The committed snapshot: the last universe we actually read. A live failure must not empty the market,
// and the daily job needs a list even if the vendor is briefly unreachable.
const SNAPSHOT = join(ROOT, 'data', 'indonesia-universe.json');

export function readUniverseSnapshot() {
  try {
    const j = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    return Array.isArray(j.rows) && j.rows.length ? j : null;
  } catch { return null; }
}

export function writeUniverseSnapshot(rows, extra = {}) {
  const out = {
    updated: new Date().toISOString(),
    source: 'stockanalysis.com/list/indonesia-stock-exchange',
    note: 'Committed universe snapshot. IDX blocks the deploy network at the edge (Cloudflare 403 on every path), so the exchange list is read from the same vendor as the statements and pinned here for a failed fetch.',
    count: rows.length,
    rows,
    ...extra,
  };
  writeFileSync(SNAPSHOT, `${JSON.stringify(out)}\n`);
  return out;
}

// Read every page of the exchange list. A page shorter than 500 is the last one. Throttling throws from
// getCached; the caller falls back to the snapshot rather than shrinking the market.
export async function idxUniverse({ fresh = false, ttlMs = 6 * 3600e3 } = {}) {
  const rows = [];
  let pages = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const text = await getCached(listUrl(p), join(ID_CACHE, `list-${p}.json`), {
      fresh, ttlMs, timeout: 45000, retries: 4,
    });
    if (!text) break;
    const page = parseListPage(text);
    pages = p;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  // The same ticker cannot appear twice; if the vendor repeats a row, keep the first.
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.code)) seen.set(r.code, r);
  const all = [...seen.values()];
  if (!all.length) throw new Error('the IDX exchange list parsed to zero rows');
  const companies = all.filter((r) => !NON_COMPANIES.has(r.code));
  return {
    rows: companies,
    excluded: all.filter((r) => NON_COMPANIES.has(r.code)),
    quoted: all.length,
    pages,
    fetched: new Date().toISOString(),
  };
}
