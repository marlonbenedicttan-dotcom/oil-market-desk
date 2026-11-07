// B3 helpers for the Brazil build.
//
// The universe is stockanalysis.com's Brazil exchange list. It carries every listed line, including
// 790+ BDRs (foreign companies' Brazilian depositary receipts) and the FIIs (real-estate funds), so the
// list has to be filtered before it is a company universe:
//   - a BDR ends in 31–39 (AAPL34, GOGL35, XPBR31); it is not a Brazilian operating company.
//   - an FII/fund is identified by its name (Fundo / FII / Fiagro / FIDC / ETF).
//   - what remains is ON (3), PN (4-8), UNIT (11/55) and the letter-B classes (MRSA3B).
//
// The vendor covers ONE class per issuer (PETR4 is covered; PETR3 is 404), and its market cap is the
// COMPANY total, repeated on every class line. So the build groups by base, picks the class with a
// statement page (largest first), and keeps the company cap on that one line. Never sum the classes.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getCached } from './stockanalysis.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BR_CACHE = join(ROOT, 'data', 'cache', 'b3');
export const BR_SA = join(ROOT, 'data', 'cache', 'brazil-sa');
mkdirSync(BR_CACHE, { recursive: true });
mkdirSync(BR_SA, { recursive: true });

export const listUrl = (page) => `https://stockanalysis.com/list/brazil-stock-exchange/${page > 1 ? `?page=${page}` : ''}`;
export const PAGE_SIZE = 500;
export const MAX_PAGES = 4;

export const pad = (code) => String(code || '').trim().toUpperCase();
// BDRs end in 31–39; a real B3 ordinary/preferred/unit does not.
export const isBdr = (code) => /3[1-9]$/.test(pad(code));
// A fund, not an operating company. "Imobiliária" alone is a real-estate company, so only the fund
// markers are matched.
export const isFundName = (name) => /\b(fundo|fii|fiagro|fidc|etf|ishares)\b|fundo de investimento/i.test(String(name || ''));
export const classOf = (code) => {
  const c = pad(code);
  const m = /(\d{1,2})(B?)$/.exec(c);
  return m ? `${m[1]}${m[2]}` : null;
};
export const baseOf = (code) => pad(code).replace(/\d{1,2}B?$/, '');
export const isOrdinaryLine = (code, name) => /\d/.test(pad(code)) && !isBdr(code) && !isFundName(name);

export function classLabel(code) {
  const c = classOf(code);
  if (!c) return null;
  const n = c.replace('B', '');
  if (c.endsWith('B')) return `class ${c}`;
  if (n === '3') return 'ON';
  if (n === '4') return 'PN';
  if (n === '5') return 'PNA';
  if (n === '6') return 'PNB';
  if (n === '7') return 'PNC';
  if (n === '8') return 'PND';
  if (n === '11' || n === '55') return 'UNIT';
  return `class ${c}`;
}

export const saSlug = (code) => pad(code);
export const saPage = (code, page = '', quarterly = false) =>
  `https://stockanalysis.com/quote/bvmf/${saSlug(code)}/financials/${page}/${quarterly ? '?p=quarterly' : ''}`;
export const saProfile = (code) => `https://stockanalysis.com/quote/bvmf/${saSlug(code)}/company/`;
export const yaSymbol = (code) => `${encodeURIComponent(pad(code))}.SA`;
export const INDEX_SYMBOL = '^BVSP';

export function parseCap(text) {
  const m = /^([\d.,]+)\s*([KMBT])$/i.exec(String(text || '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()];
  return mult ? Math.round(n * mult) : null;
}

export function parseListPage(html) {
  const rows = [];
  for (const tr of String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const m = /href="\/quote\/bvmf\/([A-Z0-9]+)\/"/.exec(tr[1]);
    if (!m) continue;
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const code = m[1].toUpperCase();
    if (!/\d/.test(code)) continue;
    rows.push({ code, name: cells[2] || null, vendorCap: parseCap(cells[3]) });
  }
  return rows;
}

const SNAPSHOT = join(ROOT, 'data', 'brazil-universe.json');

export function readUniverseSnapshot() {
  try {
    const j = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    return Array.isArray(j.rows) && j.rows.length ? j : null;
  } catch { return null; }
}

export function writeUniverseSnapshot(rows, extra = {}) {
  const out = {
    updated: new Date().toISOString(),
    source: 'stockanalysis.com/list/brazil-stock-exchange',
    note: 'Committed B3 universe snapshot. BDRs (31–39) and FII/funds are excluded; a class line is kept only as a candidate — the build picks the one class per issuer that has a statement page.',
    count: rows.length,
    rows,
    ...extra,
  };
  writeFileSync(SNAPSHOT, `${JSON.stringify(out)}\n`);
  return out;
}

export async function b3Universe({ fresh = false, ttlMs = 6 * 3600e3 } = {}) {
  const rows = [];
  let pages = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const text = await getCached(listUrl(p), join(BR_CACHE, `list-${p}.json`), {
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
  if (!all.length) throw new Error('the B3 exchange list parsed to zero rows');
  const bdr = all.filter((r) => isBdr(r.code));
  const funds = all.filter((r) => !isBdr(r.code) && isFundName(r.name));
  const companies = all.filter((r) => isOrdinaryLine(r.code, r.name));
  return {
    rows: companies,
    excludedBdr: bdr.length,
    excludedFunds: funds.length,
    quoted: all.length,
    pages,
    fetched: new Date().toISOString(),
  };
}

// GICS sector; the vendor profile is the only free sector source for B3.
export const isFinancialSector = (sector) => /^Financials$/i.test(String(sector || '').trim());
const LENDER_INDUSTRY = /bank|banco|finance|credit|capital markets|investment|broker|insurance|segur|leasing|holding/i;
export const isInsurer = (industry) => /insurance|reinsurance|seguros|previdência/i.test(String(industry || ''));
export const isBankLike = (c = {}) => {
  const industry = String(c.industry || '').trim();
  if (isInsurer(industry)) return false;
  if (LENDER_INDUSTRY.test(industry)) return true;
  if (!isFinancialSector(c.sector)) return false;
  const ttm = c.ttm || (c.reports && c.reports.ttm) || {};
  return ttm.operatingProfit == null;
};
