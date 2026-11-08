// JSE helpers for the South Africa build.
//
// The universe is stockanalysis.com's Johannesburg exchange list (258 lines). It is one page, carries
// the ticker, company name and headline market cap in rand, and quotes every line under `/quote/jse/`.
//
// Two things are specific to this market:
//   - Six lines are foreign-domiciled issuers whose JSE line is a secondary listing (CFR, PRX, ANH, ANG,
//     BTI, GLN). The JSE quote page carries the price but no statements, so the build reads the
//     underlying listing's statements and keeps the JSE line price and the global company cap.
//   - Four lines are excluded by decision: BHG (BHP) and S32 (South32) belong to the Australia market,
//     INP duplicates INL (Investec's two lines, one issuer), and AGL, MNP and QLT have no free statement
//     page. They are named and counted, never estimated.
//
// The licensed JSE market-data API is not used: it needs a paid key. The keyless path is the vendor's
// JSE pages for statements/profiles, Yahoo `.JO` for prices and the JSE All Share `^J203.JO`.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getCached } from './stockanalysis.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ZA_CACHE = join(ROOT, 'data', 'cache', 'jse');
export const ZA_SA = join(ROOT, 'data', 'cache', 'southafrica-sa');
mkdirSync(ZA_CACHE, { recursive: true });
mkdirSync(ZA_SA, { recursive: true });

export const listUrl = (page) => `https://stockanalysis.com/list/johannesburg-stock-exchange/${page > 1 ? `?page=${page}` : ''}`;
export const PAGE_SIZE = 500;
export const MAX_PAGES = 2;

export const pad = (code) => String(code || '').trim().toUpperCase();

// Named exclusions. Two are Australian (BHP/South32), one duplicates another issuer line (INP/INL),
// three have no free statement page, seven are duplicate share classes of an issuer that is already
// built, and one is a bank note rather than an operating company.
export const EXCLUDED = new Map([
  ['BHG', 'BHP Group — the Australian listing (BHP) is in the Australia market'],
  ['S32', 'South32 — the Australian listing (S32) is in the Australia market'],
  ['INP', 'Investec plc — duplicate issuer; the INL line is kept'],
  ['AGL', 'Anglo American Platinum — no free statement page'],
  ['MNP', 'Mondi plc — no free statement page'],
  ['QLT', 'Quilter — no free statement page'],
  // Duplicate classes of an issuer that is already built on another line. The JSE quotes them as
  // separate lines; counting both would double the company in the market totals.
  ['SOLBE1', 'Sasol B-BBEE class — SOL is the same issuer'],
  ['FTB', 'Fairvest B class — FTA is the same issuer'],
  ['EMN', 'eMedia N ordinary — EMH is the same issuer'],
  ['RTO', 'Rex Trueform N ordinary — RTN is the same issuer'],
  ['AON', 'African & Overseas N ordinary — AOO is the same issuer'],
  ['BRN', 'Brimstone A class — BRT is the same issuer'],
  ['NY1', 'Ninety One duplicate line — N91 is the same issuer'],
  ['FDETNQ', 'FirstRand Bank note — not an operating company'],
]);

// Foreign-domiciled issuers whose JSE line is secondary. The JSE page is a price stub; statements and
// profile come from the primary listing. `exchange: 'stocks'` is the stockanalysis US path.
export const SECONDARY = {
  CFR: { exchange: 'swx', ticker: 'cfr', market: 'SIX Swiss Exchange', country: 'Switzerland', name: 'Richemont' },
  PRX: { exchange: 'ams', ticker: 'prx', market: 'Euronext Amsterdam', country: 'Netherlands', name: 'Prosus' },
  ANH: { exchange: 'ebr', ticker: 'abi', market: 'Euronext Brussels', country: 'Belgium', name: 'AB InBev' },
  ANG: { exchange: 'stocks', ticker: 'au', market: 'NYSE', country: 'United States (ADR)', name: 'AngloGold Ashanti' },
  BTI: { exchange: 'stocks', ticker: 'bti', market: 'NYSE', country: 'United States (ADR)', name: 'British American Tobacco' },
  GLN: { exchange: 'lon', ticker: 'glen', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Glencore' },
  // The remaining foreign-domiciled JSE lines: the JSE quote page exists but carries no statements, so
  // the primary listing supplies them. These were found by the build's "no statement page" audit.
  SRE: { exchange: 'lon', ticker: 'sre', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Sirius Real Estate' },
  SHC: { exchange: 'lon', ticker: 'shc', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Shaftesbury Capital' },
  PHP: { exchange: 'lon', ticker: 'php', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Primary Health Properties' },
  HMN: { exchange: 'lon', ticker: 'hmso', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Hammerson' },
  SRI: { exchange: 'lon', ticker: 'supr', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Supermarket Income REIT' },
  SCD: { exchange: 'lon', ticker: 'sere', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Schroder European REIT' },
  GTC: { exchange: 'wse', ticker: 'gtc', market: 'Warsaw Stock Exchange', country: 'Poland', name: 'Globe Trade Centre' },
  APH: { exchange: 'tsxv', ticker: 'afm', market: 'TSX Venture Exchange', country: 'Canada', name: 'Alphamin Resources' },
  AII: { exchange: 'tsx', ticker: 'aim', market: 'Toronto Stock Exchange', country: 'Canada', name: 'Aimia' },
  PAN: { exchange: 'lon', ticker: 'paf', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Pan African Resources' },
  SDL: { exchange: 'asx', ticker: 'spd', market: 'Australian Securities Exchange', country: 'Australia', name: 'Southern Palladium' },
  ORN: { exchange: 'asx', ticker: 'orn', market: 'Australian Securities Exchange', country: 'Australia', name: 'Orion Minerals' },
  GCT: { exchange: 'ise', ticker: 'grp', market: 'Euronext Dublin', country: 'Ireland', name: 'Greencoat Renewables' },
  N91: { exchange: 'lon', ticker: 'n91', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Ninety One' },
  BYI: { exchange: 'lon', ticker: 'byit', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Bytes Technology' },
  CNP: { exchange: 'lon', ticker: 'can', market: 'London Stock Exchange', country: 'United Kingdom', name: 'Canal+' },
  MCZ: { exchange: 'asx', ticker: 'mcm', market: 'Australian Securities Exchange', country: 'Australia', name: 'MC Mining' },
  EPS: { exchange: 'tsx', ticker: 'elr', market: 'Toronto Stock Exchange', country: 'Canada', name: 'Eastern Platinum' },
};

export const isSecondary = (code) => !!SECONDARY[pad(code)];
export const secondaryOf = (code) => SECONDARY[pad(code)] || null;

const baseOf = (b) => (b.exchange === 'stocks'
  ? `https://stockanalysis.com/stocks/${b.ticker}/`
  : `https://stockanalysis.com/quote/${b.exchange}/${b.ticker}/`);
export const sourcePage = (code, page = '', quarterly = false, trailing = false) => {
  const s = secondaryOf(code);
  if (s) return `${baseOf(s)}financials/${page}/${quarterly ? '?p=quarterly' : trailing ? '?p=trailing' : ''}`;
  return saPage(code, page, quarterly, trailing);
};
export const sourceProfile = (code) => {
  const s = secondaryOf(code);
  return s ? `${baseOf(s)}company/` : saProfile(code);
};
export const sourceStats = (code) => {
  const s = secondaryOf(code);
  return s ? `${baseOf(s)}statistics/` : saStats(code);
};

export const saSlug = (code) => pad(code);
export const saPage = (code, page = '', quarterly = false, trailing = false) =>
  `https://stockanalysis.com/quote/jse/${saSlug(code)}/financials/${page}/${quarterly ? '?p=quarterly' : trailing ? '?p=trailing' : ''}`;
export const saProfile = (code) => `https://stockanalysis.com/quote/jse/${saSlug(code)}/company/`;
export const saStats = (code) => `https://stockanalysis.com/quote/jse/${saSlug(code)}/statistics/`;

// Yahoo wants the JSE ticker plus the Johannesburg suffix: NPN.JO.
export const yaSymbol = (code) => `${encodeURIComponent(pad(code))}.JO`;

// The JSE All Share is the broad market index the page is anchored on.
export const INDEX_SYMBOL = '^J203.JO';
export const INDEX_NAME = 'JSE All Share';

export const isFinancialSector = (sector) => /^Financials$/i.test(String(sector || '').trim());
const LENDER_INDUSTRY = /bank|financ|credit|capital markets|investment|broker|insurance|assurance|leasing|holding/i;
export const isInsurer = (industry) => /insurance|reinsurance|assurance/i.test(String(industry || ''));
export const isBankLike = (c = {}) => {
  const industry = String(c.industry || '').trim();
  if (isInsurer(industry)) return false;
  if (LENDER_INDUSTRY.test(industry)) return true;
  if (!isFinancialSector(c.sector)) return false;
  const ttm = c.ttm || (c.reports && c.reports.ttm) || {};
  return ttm.operatingProfit == null;
};

export function parseCap(text) {
  const m = /^([\d.,]+)\s*([KMBT])$/i.exec(String(text || '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()];
  return mult ? Math.round(n * mult) : null;
}

// rank · symbol · company · market cap · price · change. The cap is the company total in rand.
export function parseListPage(html) {
  const rows = [];
  for (const tr of String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const m = /href="\/quote\/jse\/([A-Z0-9]+)\/"/.exec(tr[1]);
    if (!m) continue;
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const code = m[1].toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(code)) continue;
    const px = Number(String(cells[4] || '').replace(/,/g, ''));
    rows.push({ code, name: cells[2] || null, vendorCap: parseCap(cells[3]), vendorPrice: Number.isFinite(px) && px > 0 ? px : null });
  }
  return rows;
}

const SNAPSHOT = join(ROOT, 'data', 'southafrica-universe.json');

export function readUniverseSnapshot() {
  try {
    const j = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    return Array.isArray(j.rows) && j.rows.length ? j : null;
  } catch { return null; }
}

export function writeUniverseSnapshot(rows, extra = {}) {
  const out = {
    updated: new Date().toISOString(),
    source: 'stockanalysis.com/list/johannesburg-stock-exchange',
    note: 'Committed JSE universe snapshot. Foreign-domiciled lines use their primary exchange for statements; 14 lines are excluded by decision (BHG and S32 are in the Australia market, INP duplicates INL, AGL/MNP/QLT have no free statement page, seven lines are duplicate share classes, and FDETNQ is a bank note).',
    count: rows.length,
    rows,
    ...extra,
  };
  writeFileSync(SNAPSHOT, `${JSON.stringify(out)}\n`);
  return out;
}

export async function jseUniverse({ fresh = false, ttlMs = 6 * 3600e3 } = {}) {
  const rows = [];
  let pages = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const text = await getCached(listUrl(p), join(ZA_CACHE, `list-${p}.json`), {
      fresh, ttlMs, timeout: 45000, retries: 4,
    });
    if (!text) break;
    const page = parseListPage(text);
    pages = p;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.code)) seen.set(r.code, r);
  const all = [...seen.values()];
  if (!all.length) throw new Error('the JSE exchange list parsed to zero rows');
  const excluded = all.filter((r) => EXCLUDED.has(r.code));
  const companies = all.filter((r) => !EXCLUDED.has(r.code));
  return {
    rows: companies,
    all,
    excluded,
    quoted: all.length,
    secondary: companies.filter((r) => isSecondary(r.code)).length,
    pages,
    fetched: new Date().toISOString(),
  };
}
