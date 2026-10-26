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

// The newest quarterly report in the universe is the reference point for "current". A TTM built from
// quarters that stopped years ago (Mastercard's tag ends in 2014) is not a trailing figure.
const newestTTM = Math.max(0, ...data.companies.map((c) => Date.parse(c.netIncomeTTMAsOf || '')).filter(Number.isFinite));

let fixed = 0;
for (const c of data.companies) {
  if (c.netIncomeTTMAsOf && newestTTM && newestTTM - Date.parse(c.netIncomeTTMAsOf) > 500 * 86400000) {
    c.netIncomeTTM = null;
    c.netIncomeTTMAsOf = null;
  }
  if (c.nasdaqSector && NASDAQ_SECTOR[c.nasdaqSector]) c.sector = NASDAQ_SECTOR[c.nasdaqSector];
  const foreign = c.state && !US_STATES.has(String(c.state).toUpperCase());
  if (foreign) {
    const ratio = ADR_RATIO[c.ticker];
    if (ratio && c.shares) c.shares = Math.round(c.shares / ratio);
    else { c.shares = null; c.adrNA = true; }
  }
  const before = JSON.stringify([c.marketCap, c.pe, c.pb, c.ev, c.evEbitda, c.currentRatio, c.debtEquity]);

  if (c.shares != null && c.shares < MIN_SHARES) c.shares = null;
  // A dual-class company's XBRL share count covers one class, so price x shares cannot reproduce the
  // cap. Derive the total from the two authoritative numbers and mark it, rather than leave a count
  // that contradicts the market cap.
  if (c.marketCap && c.price && c.shares && Math.abs(c.price * c.shares - c.marketCap) / c.marketCap > 0.10) {
    c.shares = Math.round(c.marketCap / c.price);
    c.sharesDerived = true;
  }
  if (c.revenue != null && c.revenue < 0) c.revenue = null;

  // Market cap comes from Nasdaq where available (it already handles classes, ADRs and buybacks);
  // price × shares is only the fallback for names Nasdaq doesn't cover.
  if (c.marketCapSource !== 'nasdaq') c.marketCap = c.price != null && c.shares != null ? Math.round(c.price * c.shares) : null;
  if (c.marketCap != null && (c.marketCap <= 0 || c.marketCap < 1e6)) c.marketCap = null;

  // A net income larger than revenue means the two figures are not the same scope. Banks are the
  // systematic case: their "revenue" tag is often net interest income, so a margin is meaningless.
  // A net income of a few thousand dollars against billions of revenue is a broken tag (partial
  // period or wrong unit), not a company having a bad year.
  if (c.revenue && c.netIncome != null && Math.abs(c.netIncome) < c.revenue * 0.001) c.netIncome = null;
  if (c.revenue && c.netIncomeTTM != null && Math.abs(c.netIncomeTTM) < c.revenue * 0.001) c.netIncomeTTM = null;
  // A profit cannot exceed revenue, but a loss can: a company with collapsing sales and a write-down
  // can lose more than it earns. Only cap profits, and only reject losses beyond 3x revenue.
  if (c.revenue != null && c.netIncome != null
      && (c.netIncome > c.revenue * 1.2 || c.netIncome < c.revenue * -3 || c.sector === 'Financials')) {
    if (c.sector === 'Financials') c.marginNA = true;
    else c.netIncome = null;
  }


  // P/E on the authoritative market cap ÷ net income: consistent with the cap, and immune to
  // per-share class/ADR mismatches.
  // Prefer TTM earnings (same four quarters as the EPS), fall back to the fiscal year.
  // A TTM from stale quarters is worse than the fiscal year: if the two disagree by more than 5x,
  // the quarterly series is out of date or a component, so fall back to the audited annual figure.
  if (c.netIncomeTTM != null && c.netIncome > 0
      && (c.netIncomeTTM / c.netIncome < 0.2 || c.netIncomeTTM / c.netIncome > 5)) c.netIncomeTTM = null;
  const earn = c.netIncomeTTM > 0 ? c.netIncomeTTM : (c.netIncome > 0 ? c.netIncome : null);
  const pe = c.marketCap && earn ? +(c.marketCap / earn).toFixed(1) : null;
  c.pe = pe != null && pe <= MAX_PE && pe >= 0.5 ? pe : null;
  c.peBasis = c.pe == null ? null : (c.netIncomeTTM > 0 ? 'TTM' : 'FY');

  // A quarterly figure cannot produce an annual P/E (it would understate it four-fold).
  if (c.quarterly) { c.pe = null; c.peBasis = null; }

  c.pb = c.marketCap && c.equity > 0 ? +(c.marketCap / c.equity).toFixed(1) : null;
  if (c.pb != null && c.pb > 100) c.pb = null;

  // Debt cannot exceed total assets. Where a tag says it does, the tag is measuring something else
  // (a gross figure or a subsidiary's obligation); showing it would imply impossible leverage.
  if (c.debt != null && c.assets != null && c.debt > c.assets) { c.debt = null; c.debtNA = true; }

  // EV needs net debt. When a company tags neither debt nor cash, EV would silently equal market cap,
  // so mark it rather than present a guess as a measurement.
  c.evApprox = c.debt == null && c.cash == null;
  c.ev = c.marketCap != null ? c.marketCap + (c.debt || 0) - (c.cash || 0) : null;
  // Operating income from a decade ago is not operating income. KLA's tag last filed in 2014, which
  // made EV/EBITDA look like 166x on a 2014 profit.
  if (c.opIncEnd && newestTTM && newestTTM - Date.parse(c.opIncEnd) > 730 * 86400000) { c.opInc = null; c.opIncStale = true; }
  const opInc = c.opInc ?? [...(c.series || [])].reverse().find((x) => x.opInc != null)?.opInc ?? null;
  const ebitda = opInc != null ? opInc + (c.da || 0) : null;
  // EBITDA is not a bank metric: deposits are operating liabilities and interest is the business.
  c.evEbitda = c.ev && ebitda > 0 && c.sector !== 'Financials' ? +(c.ev / ebitda).toFixed(1) : null;
  if (c.evEbitda != null && c.evEbitda > 200) c.evEbitda = null;

  c.currentRatio = c.currentAssets != null && c.currentLiabilities > 0 ? +(c.currentAssets / c.currentLiabilities).toFixed(2) : null;
  if (c.currentRatio != null && c.currentRatio > MAX_CR) c.currentRatio = null;

  c.debtEquity = c.debt != null && c.equity > 0 ? +(c.debt / c.equity).toFixed(2) : null;
  if (c.debtEquity != null && c.debtEquity > MAX_DE) c.debtEquity = null;

  if (JSON.stringify([c.marketCap, c.pe, c.pb, c.ev, c.evEbitda, c.currentRatio, c.debtEquity]) !== before) fixed++;
}

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
const priced = data.companies.filter((c) => c.marketCap).length;
console.log(`recomputed ${data.companies.length} companies · ${fixed} changed · ${priced} priced`);
