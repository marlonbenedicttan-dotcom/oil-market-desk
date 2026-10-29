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
const MAX_PE = 2000;   // a genuine 450x P/E (Tesla on thin GAAP earnings) is data, not an error
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
  // A fiscal-year figure is current for its own period even when the company has not filed since; only a
  // trailing figure built from old quarters is stale.
  if (c.netIncomeTTMAsOf && newestTTM && !c.ttmFromFY && newestTTM - Date.parse(c.netIncomeTTMAsOf) > 500 * 86400000) {
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
  // Revenue is now a consistent total for every sector, so a bank's net margin is computable. Only
  // reject a margin when profit exceeds revenue — the two figures are then different scopes.
  c.marginNA = false;
  if (c.revenue != null && c.netIncome != null
      && (c.netIncome > c.revenue * 1.2 || c.netIncome < c.revenue * -3)) {
    c.marginNA = true;
    if (c.sector !== 'Financials') c.netIncome = null;
  }


  // P/E on the authoritative market cap ÷ net income: consistent with the cap, and immune to
  // per-share class/ADR mismatches.
  // Prefer TTM earnings (same four quarters as the EPS), fall back to the fiscal year.
  // A TTM from stale quarters is worse than the fiscal year: if the two disagree by more than 5x,
  // the quarterly series is out of date or a component, so fall back to the audited annual figure.
  // A trailing figure that swings from a profit to a loss (or triples) can be real — an impairment or a
  // recovery. Judge it against revenue, not against last year: earnings above revenue is the actual
  // impossibility.
  if (c.netIncomeTTM != null && c.revenue
      && (c.netIncomeTTM > c.revenue * 1.2 || c.netIncomeTTM < c.revenue * -3)) c.netIncomeTTM = null;
  const earn = c.netIncomeTTM > 0 ? c.netIncomeTTM : (c.netIncome > 0 ? c.netIncome : null);
  const pe = c.marketCap && earn ? +(c.marketCap / earn).toFixed(1) : null;
  c.pe = pe != null && pe <= MAX_PE && pe >= 0.5 ? pe : null;
  c.peBasis = c.pe == null ? null : (c.netIncomeTTM > 0 ? 'TTM' : 'FY');

  // A quarterly figure cannot produce an annual P/E (it would understate it four-fold).
  if (c.quarterly) { c.pe = null; c.peBasis = null; }

  c.pb = c.marketCap && c.equity > 0 ? +(c.marketCap / c.equity).toFixed(1) : null;
  if (c.pb != null && c.pb > 200) c.pb = null;

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
  // Prefer the trailing EBITDA where we have it; fall back to the fiscal-year figure.
  const ebitda = c.ebitdaTTM != null ? c.ebitdaTTM : (opInc != null ? opInc + (c.da || 0) : null);
  // EBITDA is not a bank metric: deposits are operating liabilities and interest is the business.
  // EBITDA is not a bank metric, but a conglomerate classified as Financials (Berkshire) operates real
  // assets and reports capex — for those the ratio is meaningful.
  const bankLike = c.sector === 'Financials' && c.fcf == null;
  c.evEbitda = c.ev && ebitda > 0 && !bankLike ? +(c.ev / ebitda).toFixed(1) : null;
  if (c.evEbitda != null && c.evEbitda > 500) c.evEbitda = null;

  // Cash-based ratios, on a trailing basis where the quarters allow it. FCF is the check on earnings:
  // profit that never becomes cash is not profit.
  const fcf = c.fcfTTM != null ? c.fcfTTM : c.fcf;
  c.fcfBasis = fcf == null ? null : (c.fcfTTM != null ? 'TTM' : 'FY');
  c.fcfYield = fcf != null && c.marketCap > 0 ? +((fcf / c.marketCap) * 100).toFixed(2) : null;
  if (c.fcfYield != null && Math.abs(c.fcfYield) > 100) c.fcfYield = null;
  c.fcfMargin = fcf != null && c.revenue > 0 ? +((fcf / c.revenue) * 100).toFixed(1) : null;
  if (c.fcfMargin != null && Math.abs(c.fcfMargin) > 100) c.fcfMargin = null;
  const cashEarn = c.netIncomeTTM > 0 ? c.netIncomeTTM : (c.netIncome > 0 ? c.netIncome : null);
  c.cashConversion = fcf != null && cashEarn ? +(fcf / cashEarn).toFixed(2) : null;
  if (c.cashConversion != null && Math.abs(c.cashConversion) > 5) c.cashConversion = null;
  c.netDebtToFcf = fcf > 0 && c.debt != null ? +((c.debt - (c.cash || 0)) / fcf).toFixed(1) : null;
  if (c.netDebtToFcf != null && (c.netDebtToFcf < -20 || c.netDebtToFcf > 100)) c.netDebtToFcf = null;

  // --- growth and quality ---------------------------------------------------
  const hist = (c.series || []).slice().sort((x, y) => x.fy - y.fy);
  // Some filers never tag EPS (Berkshire, Visa, Monster). Net income ÷ shares is the same number and
  // lets the growth series exist at all.
  if (c.shares) {
    for (const s of hist) {
      if (!(s.eps > 0) && s.netIncome != null) s.eps = +(s.netIncome / c.shares).toFixed(2);
    }
    if (!(c.eps > 0) && c.netIncome != null) c.eps = +(c.netIncome / c.shares).toFixed(2);
  }
  const first = hist[0];
  const last = hist[hist.length - 1];
  const span = first && last ? last.fy - first.fy : 0;
  const cagr = (a0, b0) => (a0 > 0 && b0 > 0 && span >= 2 ? +(((b0 / a0) ** (1 / span) - 1) * 100).toFixed(1) : null);
  c.revenueCagr = cagr(first?.revenue, last?.revenue);
  c.epsCagr = cagr(first?.eps, last?.eps);
  c.cagrYears = span >= 2 ? span : null;
  // Say why a growth rate is absent rather than leaving a dash: a loss at either end makes it meaningless.
  c.cagrNA = c.revenueCagr == null ? (span < 2 ? 'history too short' : 'loss at either end') : null;
  c.epsCagrNA = c.epsCagr == null ? (span < 2 ? 'history too short' : 'a loss in the first or last year') : null;
  c.marginDelta = first?.revenue && last?.revenue && first.netIncome != null && last.netIncome != null
    ? +(((last.netIncome / last.revenue) - (first.netIncome / first.revenue)) * 100).toFixed(1) : null;

  // Return on capital: net income ÷ (equity + debt − cash). Approximate, and only where the inputs exist.
  const invested = c.equity != null ? c.equity + (c.debt || 0) - (c.cash || 0) : null;
  const roicEarn = c.netIncomeTTM != null ? c.netIncomeTTM : c.netIncome;
  c.roicBasis = roicEarn == null ? null : (c.netIncomeTTM != null ? 'TTM' : 'FY');
  c.roic = invested > 0 && roicEarn != null ? +((roicEarn / invested) * 100).toFixed(1) : null;
  if (c.roic != null && (c.roic < -100 || c.roic > 200)) c.roic = null;

  const ebitdaQ = c.ebitdaTTM != null ? c.ebitdaTTM : (c.opInc != null ? c.opInc + (c.da || 0) : null);
  c.netDebtEbitdaBasis = ebitdaQ == null ? null : (c.ebitdaTTM != null ? 'TTM' : 'FY');
  c.netDebtEbitda = c.debt != null && ebitdaQ > 0 ? +(((c.debt - (c.cash || 0)) / ebitdaQ)).toFixed(1) : null;
  if (c.netDebtEbitda != null && (c.netDebtEbitda < -20 || c.netDebtEbitda > 50)) c.netDebtEbitda = null;

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
