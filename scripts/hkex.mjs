// HKEX helpers for the Hong Kong build.
//
// The exchange publishes a daily quotation report as one plain-text page per session, keyless:
// every listed security with its previous close, its closing price, the session's high and low, and
// the shares traded. That is the universe and the day's official tape; the English statements come
// from stockanalysis.com's HKG pages, the same source the Japan, Korea and Taiwan builds use.
//
// The report has no security-type column, so the universe is filtered in two passes: the code and the
// name remove structured products, ETFs and trusts, and a company without a statement page (an ETF
// always is one) never enters the dataset.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UA, sleep, getCached, readJson, writeJson } from './stockanalysis.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'cache');
export const HK_CACHE = join(CACHE, 'hkex');
export const HK_SA = join(CACHE, 'hongkong-sa');
mkdirSync(HK_CACHE, { recursive: true });
mkdirSync(HK_SA, { recursive: true });

const DAY = 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const yymmdd = (isoDate) => String(isoDate).replace(/-/g, '').slice(2);

// The report's file name is the session date: 2026-10-30 → d261030e.htm.
export const dailyUrl = (isoDate) => `https://www.hkex.com.hk/eng/stat/smstat/dayquot/d${yymmdd(isoDate)}e.htm`;

// Walk back from today until a session file exists. The exchange posts the report after the close, so
// on a trading morning the newest file is yesterday's; weekends and holidays 404.
export async function latestDaily({ days = 12, fresh = false } = {}) {
  for (let i = 0; i < days; i++) {
    const d = iso(Date.now() - i * DAY);
    const f = join(HK_CACHE, `daily-${d}.json`);
    if (!fresh && existsSync(f)) {
      const hit = readJson(f);
      if (hit && hit.text) return { date: d, text: hit.text };
    }
    try {
      const res = await fetch(dailyUrl(d), {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) { await sleep(400); continue; }
      const text = await res.text();
      if (!/NAME OF STOCK/.test(text)) { await sleep(400); continue; }
      writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), text }));
      return { date: d, text };
    } catch { await sleep(600); }
  }
  return null;
}

export function readDaily(dateIso) {
  const hit = readJson(join(HK_CACHE, `daily-${dateIso}.json`));
  return hit && hit.text ? hit.text : null;
}

// --- the quotation table -------------------------------------------------------------------------
// Two fixed-width lines per security:
//   "     1 CKH HOLDINGS     HKD   65.45    66.20    66.20            8,117,147"
//   "                              66.20    66.15    64.65          534,037,708"
//   columns: code, name, currency, prev close | closing, ask | bid, high | low, shares | turnover
const NUM = String.raw`[\d,]+(?:\.\d+)?`;
// A '#' can sit immediately after the code ("  2608#SUNSHINE 100"): the exchange's marker on the
// line, not part of either field. Suspended and halted lines carry no prices at all, so they get their
// own single-line shape — without it they were not parsed, and the "quoted lines" count understated
// the market by a few hundred.
const L1 = new RegExp(String.raw`^(\*?)\s*(\d{1,5})(#?)\s*(.{1,22}?)\s{2,}(HKD|RMB|USD|CNH)\s+(${NUM})\s+([\d.,-]+)\s+([\d.,-]+)\s+([\d,]+)\s*$`);
const L1S = new RegExp(String.raw`^(\*?)\s*(\d{1,5})(#?)\s*(.{1,22}?)\s{2,}(HKD|RMB|USD|CNH)\s+TRADING (?:SUSPENDED|HALTED)\s*$`);
const L2 = new RegExp(String.raw`^\s+(${NUM}|-)\s+(${NUM}|-)\s+(${NUM}|-)\s+(${NUM}|-)\s*$`);

const clean = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const n = (v) => {
  const s = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (!s || s === '-') return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};

// Only the QUOTATIONS section — the report repeats "CODE NAME" headers for the sales-record tables.
const quotationsSection = (text) => {
  const h = String(text || '');
  const a = h.indexOf('name = "quotations"');
  const b = h.indexOf('name = "sales_all"');
  return a > 0 && b > a ? h.slice(a, b) : h;
};

export function parseQuotations(text) {
  const lines = quotationsSection(text).split(/\r?\n/);
  const rows = [];
  let pending = null;
  for (const line of lines) {
    const ms = L1S.exec(line);
    if (ms) {
      rows.push({
        flag: (ms[1] || '') + (ms[3] || ''), hkexCode: ms[2], name: clean(ms[4]), currency: ms[5],
        suspended: true, prevClose: null, close: null, bid: null, low: null,
        sharesTraded: null, turnover: null,
      });
      continue;
    }
    const m = L1.exec(line);
    if (m) {
      pending = {
        flag: (m[1] || '') + (m[3] || ''), hkexCode: m[2], name: clean(m[4]), currency: m[5],
        suspended: false,
        prevClose: n(m[6]),
        sharesTraded: n(m[9]),
      };
      continue;
    }
    const m2 = L2.exec(line);
    if (m2 && pending) {
      pending.close = n(m2[1]);
      pending.bid = n(m2[2]);
      pending.low = n(m2[3]);
      pending.turnover = n(m2[4]);
      rows.push(pending);
      pending = null;
    }
  }
  // A truncated page (no second line) still yields a row, with no price.
  if (pending) rows.push({ ...pending, close: null, bid: null, low: null, turnover: null });
  return rows.filter((r) => r.hkexCode);
}

// Main-board equities only. GEM (8000–8999) and the RMB counters of dual-counter securities (5-digit)
// are dropped by the code ceiling; warrants and CBBCs are 5-digit codes with an issuer prefix in the
// name; ETFs, REITs and debt carry it in the name. Anything left still has to survive the statement
// fetch, which is what actually removes the ETFs whose names do not say ETF (ISHARES A50 and friends).
const NOT_A_COMPANY = /\b(ETF|TRACKER|REIT|BOND|NOTE|RIGHTS|WARRANT|CBBC|TRUST|FUND)\b|#|@/i;
export function isCompanyRow(r) {
  const code = Number(r.hkexCode);
  // 1–9999 is the main board; 8000–8999 is GEM, a separate board with its own smaller companies.
  if (!Number.isFinite(code) || code < 1 || code > 9999) return false;
  if (code >= 8000 && code <= 8999) return false;
  // The exchange's ETF and leveraged/inverse product ranges. Their names often do not say "ETF"
  // (CSOP HS TECH, XL2CSOPHYNIX), and they have no company statements, so they would otherwise sit in
  // the audit as companies we could not fetch.
  if (code >= 2800 && code <= 3199) return false;
  if (code >= 7200 && code <= 7599) return false;
  if (r.suspended || !(r.close > 0)) return false;
  if (r.currency !== 'HKD') return false;
  return !NOT_A_COMPANY.test(r.name);
}

// The four-digit code stockanalysis and Yahoo use: 700 → 0700 (Yahoo: 0700.HK).
export const pad4 = (code) => String(code).replace(/^0+/, '').padStart(4, '0');

export const saPage = (code, page, quarterly = false) =>
  `https://stockanalysis.com/quote/hkg/${pad4(code)}/financials/${page}/${quarterly ? '?p=quarterly' : ''}`;
export const saProfile = (code) => `https://stockanalysis.com/quote/hkg/${pad4(code)}/company/`;

// The five-year band divides a Hong Kong price by a statement EPS. When the company reports in CNY or
// USD those are different currencies, so the ratio needs the build's rate.
export const yahooSymbol = (code) => `${pad4(code)}.HK`;
