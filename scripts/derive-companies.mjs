// Recompute every derived field from its primitives, with guards. One place, so nothing can go stale.
//
//   node scripts/derive-companies.mjs
//
// Guards exist because a ratio can be arithmetically right and still meaningless:
//   - P/E on an EPS of one cent is noise, not valuation.
//   - A margin above 100% means the revenue and net-income tags belong to different scopes.
//   - A debt/equity of 127 means equity is a rounding error, not leverage.
//   - A share count of 1 is a broken cover-page fact, not a company.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const data = JSON.parse(readFileSync(FILE, 'utf8'));

const MIN_EPS = 0.05;          // below this a P/E is noise
const MIN_SHARES = 1e5;        // a company with 100k shares is a broken fact
const MAX_PE = 400;
const MAX_DE = 20;
const MAX_CR = 50;

// Foreign private issuers list ORDINARY shares on the cover page, but the quoted price is per ADR.
// Multiplying them directly inflates market cap by the ADR ratio (Alibaba: 8 ordinary per ADS -> $1.9T
// instead of ~$240B). Convert where the ratio is known; otherwise mark the company rather than guess.
const US_STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU').split(' '));
const ADR_RATIO = { BABA: 8, TSM: 5, JD: 2, PDD: 4, BIDU: 8, NTES: 5, TCOM: 1, BZ: 1, YUMC: 1 };

// The exchange's own sector beats SIC codes, which put Apple in Industrials and Amazon in Other.
const NASDAQ_SECTOR = {
  'Technology': 'Technology', 'Health Care': 'Healthcare', 'Consumer Discretionary': 'Consumer',
  'Consumer Staples': 'Consumer', 'Finance': 'Financials', 'Industrials': 'Industrials', 'Energy': 'Energy',
  'Materials': 'Materials', 'Utilities': 'Utilities', 'Real Estate': 'Real estate',
  'Telecommunications': 'Telecom', 'Communication Services': 'Media',
};

let fixed = 0;
for (const c of data.companies) {
  if (c.nasdaqSector && NASDAQ_SECTOR[c.nasdaqSector]) c.sector = NASDAQ_SECTOR[c.nasdaqSector];
  const foreign = c.state && !US_STATES.has(String(c.state).toUpperCase());
  if (foreign) {
    const ratio = ADR_RATIO[c.ticker];
    if (ratio && c.shares) c.shares = Math.round(c.shares / ratio);
    else { c.shares = null; c.adrNA = true; }
  }
  const before = JSON.stringify([c.marketCap, c.pe, c.pb, c.ev, c.evEbitda, c.currentRatio, c.debtEquity]);

  if (c.shares != null && c.shares < MIN_SHARES) c.shares = null;
  if (c.revenue != null && c.revenue < 0) c.revenue = null;

  // Market cap comes from Nasdaq where available (it already handles classes, ADRs and buybacks);
  // price × shares is only the fallback for names Nasdaq doesn't cover.
  if (c.marketCapSource !== 'nasdaq') c.marketCap = c.price != null && c.shares != null ? Math.round(c.price * c.shares) : null;
  if (c.marketCap != null && (c.marketCap <= 0 || c.marketCap < 1e6)) c.marketCap = null;

  // P/E on the authoritative market cap ÷ net income: consistent with the cap, and immune to
  // per-share class/ADR mismatches.
  // Prefer TTM earnings (same four quarters as the EPS), fall back to the fiscal year.
  const earn = c.netIncomeTTM > 0 ? c.netIncomeTTM : (c.netIncome > 0 ? c.netIncome : null);
  const pe = c.marketCap && earn ? +(c.marketCap / earn).toFixed(1) : null;
  c.pe = pe != null && pe <= MAX_PE && pe >= 0.5 ? pe : null;
  c.peBasis = c.pe == null ? null : (c.netIncomeTTM > 0 ? 'TTM' : 'FY');

  c.pb = c.marketCap && c.equity > 0 ? +(c.marketCap / c.equity).toFixed(1) : null;
  if (c.pb != null && c.pb > 100) c.pb = null;

  c.ev = c.marketCap != null ? c.marketCap + (c.debt || 0) - (c.cash || 0) : null;
  const opInc = c.opInc ?? [...(c.series || [])].reverse().find((x) => x.opInc != null)?.opInc ?? null;
  const ebitda = opInc != null ? opInc + (c.da || 0) : null;
  c.evEbitda = c.ev && ebitda > 0 ? +(c.ev / ebitda).toFixed(1) : null;
  if (c.evEbitda != null && c.evEbitda > 200) c.evEbitda = null;

  c.currentRatio = c.currentAssets != null && c.currentLiabilities > 0 ? +(c.currentAssets / c.currentLiabilities).toFixed(2) : null;
  if (c.currentRatio != null && c.currentRatio > MAX_CR) c.currentRatio = null;

  c.debtEquity = c.debt != null && c.equity > 0 ? +(c.debt / c.equity).toFixed(2) : null;
  if (c.debtEquity != null && c.debtEquity > MAX_DE) c.debtEquity = null;

  // A net income larger than revenue means the two figures are not the same scope. Banks are the
  // systematic case: their "revenue" tag is often net interest income, so a margin is meaningless.
  // A net income of a few thousand dollars against billions of revenue is a broken tag (partial
  // period or wrong unit), not a company having a bad year.
  if (c.revenue && c.netIncome != null && Math.abs(c.netIncome) < c.revenue * 0.001) c.netIncome = null;
  if (c.revenue && c.netIncomeTTM != null && Math.abs(c.netIncomeTTM) < c.revenue * 0.001) c.netIncomeTTM = null;
  if (c.revenue != null && c.netIncome != null && (Math.abs(c.netIncome) > c.revenue * 1.2 || c.sector === 'Financials')) {
    if (c.sector === 'Financials') c.marginNA = true;
    else c.netIncome = null;
  }

  if (JSON.stringify([c.marketCap, c.pe, c.pb, c.ev, c.evEbitda, c.currentRatio, c.debtEquity]) !== before) fixed++;
}

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
const priced = data.companies.filter((c) => c.marketCap).length;
console.log(`recomputed ${data.companies.length} companies · ${fixed} changed · ${priced} priced`);
