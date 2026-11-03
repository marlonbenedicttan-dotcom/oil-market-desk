// ASX helpers for the Australia build.
//
// The exchange publishes a keyless CSV of every listed company: its name, its three-character ASX code
// and its GICS industry group. That file is the universe — there is no free all-stock daily quotation
// file for ASX, so prices come from Yahoo, exactly as Japan and Korea do. English statements, the
// diluted share count, the dividend per share and the profile come from stockanalysis.com's ASX pages,
// the same server-rendered source the other four markets use.
//
// Two things are specific to this market:
//   - ASX codes are already three characters ("BHP", "14D", "A2M"), so there is no padding step.
//   - The CSV's sector column is a GICS industry group (27 values) and 300 rows carry the literal
//     "Not Applic". That is a real value, not a missing one: the profile's GICS sector resolves it,
//     and only then does the company fall back to "Other".

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCached } from './stockanalysis.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'cache');
export const AU_CACHE = join(CACHE, 'asx');
export const AU_SA = join(CACHE, 'australia-sa');
mkdirSync(AU_CACHE, { recursive: true });
mkdirSync(AU_SA, { recursive: true });

export const CSV_URL = 'https://www.asx.com.au/asx/research/ASXListedCompanies.csv';
export const NOT_APPLIC = 'Not Applic';

// The CSV is UTF-8 with a BOM and two preamble lines: a dated banner, then the header row.
export function parseAsxCsv(text) {
  const rows = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let started = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!started) {
      if (/^"?Company name"?\s*,\s*"?ASX code"?/i.test(line)) started = true;
      continue;
    }
    const fields = csvFields(line);
    if (fields.length < 3) continue;
    const name = fields[0].replace(/\s+/g, ' ').trim();
    const code = fields[1].trim().toUpperCase();
    const gicsIndustryGroup = fields[2].replace(/\s+/g, ' ').trim() || NOT_APPLIC;
    // The file is companies only, and every ASX code is exactly three characters. Anything else is a
    // header artefact, not a listing.
    if (!/^[A-Z0-9]{3}$/.test(code) || !name) continue;
    rows.push({ code, name, gicsIndustryGroup });
  }
  return rows;
}

// A tiny quoted-CSV splitter. Company names contain commas and the odd escaped quote, so a plain
// split(',') would shift the code and the sector.
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

export async function asxCsv({ fresh = false, ttlMs = 24 * 3600e3 } = {}) {
  const f = join(AU_CACHE, 'ASXListedCompanies.json');
  const text = await getCached(CSV_URL, f, { fresh, ttlMs, timeout: 45000, retries: 4 });
  if (!text) throw new Error('ASX listed-companies CSV returned nothing');
  const rows = parseAsxCsv(text);
  if (!rows.length) throw new Error('ASX listed-companies CSV parsed to zero rows');
  const banner = (/^ASX listed companies as at (.+)$/m.exec(text.replace(/^\uFEFF/, '')) || [])[1] || null;
  return { rows, banner, fetched: new Date().toISOString() };
}

// The CSV is titled "listed companies", but it also carries ETFs, listed investment companies, and the
// securitisation trusts behind bank debt. Those are not companies and must not enter the dataset. The
// statement fetch removes most of them on its own (an ETF has no financials page), but a LIC or a trust
// does have reports, so the obvious ones are filtered by name first and counted, never silently.
const NON_COMPANY = /\bETF\b|\bEXCHANGE[- ]TRADED\b|\bINDEX FUND\b|\bINVESTMENT (FUND|COMPANY|TRUST)\b|\bBETASHARES\b|\bISHARES\b|\bVANECK\b|\bSPDR\b|\bGLOBAL X\b|\bABS TRUST\b|\bSERIES \d{2,4}\b|IN RESPECT OF SERIES|\bDEBENTURE\b|\bBONDS?\b|\bFUND\b|\bINVESTMENT TRUST\b|\bINCOME TRUST\b|\bMULTI-STRATEGY\b|\bEQUITY INCOME\b|\bOPPORTUNITIES COMPANY\b|\bINVESTMENT COMPANY\b/i;
export const isFundLine = (name) => NON_COMPANY.test(String(name || ''));

// "Not Applic" and "Class Pend" are real CSV values, but neither is a sector: the first is the
// exchange declining to classify, the second is a classification still pending. Both are resolved from
// the profile, then "Other".
export const isNotApplic = (csvGroup) => String(csvGroup || '').trim() === NOT_APPLIC;
export const isUnclassified = (csvGroup) => /^(Not Applic|Class Pend)$/i.test(String(csvGroup || '').trim());

// The sector rule: the CSV's finer GICS industry group wins; an unclassified row is resolved from the
// profile's GICS sector; a company with neither is "Other", never a blank.
export const sectorOf = (csvGroup, profileSector) => {
  const group = String(csvGroup || '').trim();
  if (group && !isUnclassified(group)) return group;
  const sector = String(profileSector || '').trim();
  return sector || 'Other';
};

// ASX codes are already three characters and case-sensitive only in the sense that the exchange uses
// upper case. pad() exists so the shared build shape reads the same as the other markets.
export const pad = (code) => String(code || '').trim().toUpperCase();

// Banks and insurers are not one business. GICS files banks under "Banks"; the diversified financials
// (Macquarie, AMP) sit in "Financial Services" with a "Financial Conglomerates" industry, and a few
// investment banks / lenders land in "Capital Markets" or "Credit Services" but, like a bank, report
// no operating-profit line. That blank line is the tell: the vendor prints net interest income as
// revenue, so an operating margin does not exist and the cash-flow statement is loans and deposits,
// not free cash flow. Insurers keep both, exactly as the US page keeps margins for insurers and only
// suppresses the ratios that do not exist for banks.
export const FINANCIAL_SECTORS = new Set(['Banks', 'Insurance', 'Financial Services', 'Financials']);
export const isFinancialSector = (sector) => FINANCIAL_SECTORS.has(String(sector || '').trim());
export const isBankLike = (c = {}) => {
  const sector = String(c.sector || '').trim();
  const industry = String(c.industry || '').trim();
  if (sector === 'Banks') return true;
  if (/^(Financial Conglomerates?|Consumer Finance|Mortgage Finance)$/i.test(industry)) return true;
  const ttm = c.ttm || (c.reports && c.reports.ttm) || {};
  return /^(Capital Markets|Credit Services)$/i.test(industry) && ttm.operatingProfit == null;
};

export const saPage = (code, page = '', trailing = false) =>
  `https://stockanalysis.com/quote/asx/${pad(code)}/financials/${page}/${trailing ? '?p=trailing' : ''}`;
export const saProfile = (code) => `https://stockanalysis.com/quote/asx/${pad(code)}/company/`;

// A handful of ASX lines are CDIs or the Australian leg of a dual-listed group; stockanalysis has no
// ASX financials page for them, but the same company files under its primary US listing. The ratio is
// ASX CDIs per global ordinary share, so market cap = ASX price × (global diluted shares × ratio).
//   RMD  — ResMed Inc., NYSE: RMD; Yahoo names the ASX line "RESMED CDI 10:1".
//   AMC  — Amcor plc, NYSE: AMCR; "AMCOR PLC CDI 1:1".
//   RIO  — Rio Tinto Group, NYSE: RIO; the ASX FPO line is 1:1 with the group's ordinary shares.
// A company not in this map and without an ASX page is excluded and counted, never guessed.
export const US_CROSS = {
  RMD: { ticker: 'rmd', ratio: 10, note: 'ResMed Inc. · NYSE: RMD · ASX CDIs 10:1' },
  AMC: { ticker: 'amcr', ratio: 1, note: 'Amcor plc · NYSE: AMCR · ASX CDIs 1:1' },
  RIO: { ticker: 'rio', ratio: 1, note: 'Rio Tinto Group · NYSE: RIO · ASX FPO 1:1' },
};
export const saUsPage = (ticker, page = '', quarterly = false) =>
  `https://stockanalysis.com/stocks/${String(ticker).toLowerCase()}/financials/${page}/${quarterly ? '?p=quarterly' : ''}`;
export const saUsProfile = (ticker) => `https://stockanalysis.com/stocks/${String(ticker).toLowerCase()}/company/`;

// Yahoo's ASX suffix. Prices are five years of split-adjusted daily closes.
export const yaSymbol = (code) => `${pad(code)}.AX`;
