// Complete the US universe: turn every index member into one honest row.
//
// The frames build produces one row per CIK, so a dual-class company appears once and a recent
// listing with no annual XBRL at all appears not at all. This pass reconciles the dataset against the
// S&P 1500 membership file:
//
//   • a second share class (GOOG, FOX, NWS, …) is cloned from its sibling's filings and gets its own
//     Nasdaq price and market cap, marked `shareClass` so totals never double-count the company;
//   • a member with a CIK but no usable annual frame (a 2026 IPO, a spin-off) becomes a `noFilings`
//     row with a real quote and description, labelled on the page rather than silently missing;
//   • anything we cannot source is recorded in `universe.absent` with the reason, never invented.
//
//   node scripts/complete-us-universe.mjs
//   node scripts/complete-us-universe.mjs --dry

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHoldings, fetchSecTickers, noFilingsReason, normalizeTicker } from './us-universe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nasdaq's sector vocabulary folded into the eleven buckets the rest of the app uses. Kept in step
// with scripts/derive-companies.mjs so a noFilings row carries the same sector as a filed one.
const NASDAQ_SECTOR = {
  Technology: 'Technology', 'Health Care': 'Healthcare', 'Consumer Discretionary': 'Consumer',
  'Consumer Staples': 'Consumer', Finance: 'Financials', Industrials: 'Industrials', Energy: 'Energy',
  Materials: 'Materials', Utilities: 'Utilities', 'Real Estate': 'Real estate',
  Telecommunications: 'Telecom', 'Communication Services': 'Media',
};
const sectorOf = (s) => NASDAQ_SECTOR[s] || 'Other';

async function quote(ticker) {
  const sym = String(ticker).replace('-', '.');
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      });
      if (!res.ok) { await sleep(600 * (i + 1)); continue; }
      const j = await res.json();
      const d = j?.data;
      if (!d) return null;
      const s = d.summaryData || {};
      let price = Number(String(d.primaryData?.lastSalePrice || '').replace(/[$,]/g, '')) || null;
      if (!price) {
        // The summary endpoint returns a null primaryData for some share classes; the quote info
        // endpoint still carries the last sale.
        try {
          const r2 = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`, {
            headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
          });
          const j2 = await r2.json();
          price = Number(String(j2?.data?.primaryData?.lastSalePrice || '').replace(/[$,]/g, '')) || null;
        } catch { /* leave null */ }
      }
      const cap = Number(String(s.MarketCap?.value || '').replace(/[$,]/g, '')) || null;
      return {
        price, cap,
        sector: s.Sector?.value || null,
        industry: s.Industry?.value || null,
        yield: Number(String(s.Yield?.value || '').replace('%', '')) || null,
      };
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

async function profile(ticker) {
  try {
    const res = await fetch(`https://api.nasdaq.com/api/company/${ticker}/company-profile?assetclass=stocks`, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    });
    const j = await res.json();
    return j?.data?.CompanyDescription?.value || null;
  } catch { return null; }
}

const members = await fetchHoldings();
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const sec = await fetchSecTickers();
const present = new Set(data.companies.map((c) => normalizeTicker(c.ticker)));
const reasons = new Map();
const added = [];

for (const m of members) {
  if (present.has(m.ticker)) continue;
  const s = sec.get(m.ticker);
  if (!s) { reasons.set(m.ticker, 'no SEC CIK'); continue; }

  // A second class shares its sibling's CIK and filings.
  const sibling = data.companies.find((c) => String(c.cik) === s.cik && !c.shareClass)
    || data.companies.find((c) => String(c.cik) === s.cik);
  const q = await quote(m.ticker);
  if (!q?.cap) { reasons.set(m.ticker, 'no Nasdaq quote'); continue; }

  if (sibling) {
    const row = JSON.parse(JSON.stringify(sibling));
    Object.assign(row, {
      ticker: m.ticker,
      name: s.title || sibling.name,
      indexName: m.name,
      indexWeight: m.weight,
      price: q.price,
      marketCap: Math.round(q.cap),
      marketCapSource: 'nasdaq',
      dividendYield: q.yield ?? sibling.dividendYield ?? null,
      nasdaqSector: q.sector || sibling.nasdaqSector,
      sector: q.sector ? sectorOf(q.sector) : sibling.sector,
      industry: q.industry || sibling.industry,
      shareClass: true,
      shareClassOf: sibling.ticker,
    });
    row.shares = q.price ? Math.round(q.cap / q.price) : row.shares;
    row.sharesDerived = true;
    data.companies.push(row);
    added.push(m.ticker);
  } else {
    // A member with a CIK but no annual frame: a real listing, just not one with a 10-K in the
    // five-year window. Publish the identity and the quote, label the missing statements clearly.
    const desc = await profile(m.ticker);
    const sector = q.sector ? sectorOf(q.sector) : 'Other';
    data.companies.push({
      cik: s.cik,
      ticker: m.ticker,
      name: s.title || m.name,
      indexName: m.name,
      indexWeight: m.weight,
      sector,
      industry: q.industry || null,
      nasdaqSector: q.sector || null,
      price: q.price,
      marketCap: Math.round(q.cap),
      marketCapSource: 'nasdaq',
      shares: q.price ? Math.round(q.cap / q.price) : null,
      sharesDerived: true,
      dividendYield: q.yield ?? null,
      description: desc ? String(desc).replace(/\s+/g, ' ').trim().slice(0, 300) : null,
      descriptionSource: desc ? 'nasdaq' : null,
      descSource: desc ? 'nasdaq' : null,
      noFilings: true,        // no annual XBRL in the window: statements are absent, not estimated
      noFilingsReason: await noFilingsReason(s.cik, sector),
    });
    added.push(m.ticker);
  }
  present.add(m.ticker);
  await sleep(180);
}

// A bulk quote failure must not leave a company published with no market cap: every existing row
// meets that bar, so a new one does too. One retry here, then disclose it as absent instead of
// publishing a half-empty page.
for (const c of [...data.companies]) {
  if (c.marketCap) continue;
  const q = c.ticker ? await quote(c.ticker) : null;
  if (q?.cap) {
    c.price = c.price ?? q.price;
    c.marketCap = Math.round(q.cap);
    c.marketCapSource = 'nasdaq';
    c.nasdaqSector = c.nasdaqSector || q.sector || null;
    c.industry = c.industry || q.industry || null;
    c.dividendYield = c.dividendYield ?? q.yield ?? null;
  } else {
    reasons.set(normalizeTicker(c.ticker), 'no priced quote');
    data.companies = data.companies.filter((x) => x !== c);
  }
  await sleep(120);
}

// Recompute the accounting so the audit compares like with like. `present` is only the fast skip
// list; the final set is what actually survived every pass.
const kept = data.companies.length;
const companies = new Set(data.companies.filter((c) => c.cik).map((c) => String(c.cik))).size;
const finalTickers = new Set(data.companies.map((c) => normalizeTicker(c.ticker)));
data.universe = {
  ...(data.universe || {}),
  kept,
  companies,
  absent: members
    .filter((m) => !finalTickers.has(m.ticker))
    .map((m) => ({ ticker: m.ticker, name: m.name, reason: reasons.get(m.ticker) || 'not resolved' })),
};
data.count = kept;
data.updated = new Date().toISOString();

console.log(`${added.length} added: ${added.join(' ') || '(none)'}`);
console.log(`${kept} securities · ${companies} companies · ${data.universe.absent.length} absent`);
if (data.universe.absent.length) {
  for (const a of data.universe.absent) console.log(`  ${a.ticker}: ${a.reason}`);
}
if (!DRY) { writeFileSync(FILE + '.tmp', JSON.stringify(data)); renameSync(FILE + '.tmp', FILE); console.log('written'); }
