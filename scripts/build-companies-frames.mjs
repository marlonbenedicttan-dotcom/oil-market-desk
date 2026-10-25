// Build a 5-year company dataset for EVERY SEC filer using XBRL frames.
//
// Per-company requests would be ~40,000 for 10k companies. The frames API returns one cross-section
// per concept per year (2,000+ filers in a single call), so five years of revenue, net income and
// assets costs about 30 requests in total.
//
//   node scripts/build-companies-frames.mjs --years=5

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIC_SECTOR } from '../src/deals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const YEARS = Number((process.argv.find((x) => x.startsWith('--years=')) || '--years=5').split('=')[1]);
const thisYear = new Date().getUTCFullYear();
const years = Array.from({ length: YEARS }, (_, i) => thisYear - i);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 170 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 403 || res.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!res.ok) return null;
      return res.json();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

// concept -> { cik: { year: value } }
const concepts = { revenue: {}, revenue2: {}, revenue3: {}, netIncome: {}, assets: {}, equity: {}, gross: {}, opInc: {}, eps: {}, shares: {} };
const TAGS = {
  revenue: 'Revenues',
  revenue2: 'RevenueFromContractWithCustomerExcludingAssessedTax',
  revenue3: 'SalesRevenueNet',
  netIncome: 'NetIncomeLoss',
  assets: 'Assets',
  equity: 'StockholdersEquity',
  gross: 'GrossProfit',
  opInc: 'OperatingIncomeLoss',
  eps: 'EarningsPerShareDiluted',
};
// Instant concepts (balance sheet) use a quarter-end frame, not the annual one.
const INSTANT = new Set(['assets', 'equity']);

for (const y of years) {
  for (const [key, tag] of Object.entries(TAGS)) {
    const uom = key === 'eps' ? 'USD-per-shares' : 'USD';
    const frame = INSTANT.has(key) ? `CY${y}Q4I` : `CY${y}`;
    const j = await get(`https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/${uom}/${frame}.json`);
    const rows = j?.data || [];
    for (const r of rows) {
      if (r.cik == null || r.val == null) continue;
      (concepts[key][r.cik] = concepts[key][r.cik] || {})[y] = r.val;
      if (!concepts[key][r.cik].name) concepts[key][r.cik].name = r.entityName;
    }
    process.stdout.write(`${y} ${key}:${rows.length} `);
    await sleep(120);
  }
  console.log('');
}

// Balance-sheet inputs for EV and liquidity ratios, plus quarterly EPS for a trailing-twelve-month P/E.
const extra = { debt: {}, cash: {}, da: {}, ca: {}, cl: {}, qeps: {} };
for (const [key, tag] of [['debt', 'LongTermDebtNoncurrent'], ['cash', 'CashAndCashEquivalentsAtCarryingValue'],
  ['ca', 'AssetsCurrent'], ['cl', 'LiabilitiesCurrent']]) {
  const j = await get(`https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/CY${thisYear - 1}Q4I.json`);
  for (const r of j?.data || []) if (r.cik != null && r.val != null) extra[key][r.cik] = r.val;
  await sleep(120);
}
{
  const j = await get(`https://data.sec.gov/api/xbrl/frames/us-gaap/DepreciationDepletionAndAmortization/USD/CY${thisYear - 1}.json`);
  for (const r of j?.data || []) if (r.cik != null && r.val != null) extra.da[r.cik] = r.val;
  await sleep(120);
}
// Six recent calendar quarters of diluted EPS -> sum the latest four (TTM) when it agrees with the FY figure.
const quarters = [];
for (const y of [thisYear - 1, thisYear - 2]) for (const q of [1, 2, 3, 4]) quarters.push(`CY${y}Q${q}`);
const qni = {};   // quarterly net income, same frames as the EPS so TTM is period-consistent
for (const frame of quarters.slice(-6)) {
  const j = await get(`https://data.sec.gov/api/xbrl/frames/us-gaap/EarningsPerShareDiluted/USD-per-shares/${frame}.json`);
  for (const r of j?.data || []) {
    if (r.cik == null || r.val == null) continue;
    (extra.qeps[r.cik] = extra.qeps[r.cik] || {})[frame] = r.val;
  }
  const jn = await get(`https://data.sec.gov/api/xbrl/frames/us-gaap/NetIncomeLoss/USD/${frame}.json`);
  for (const r of jn?.data || []) {
    if (r.cik == null || r.val == null) continue;
    (qni[r.cik] = qni[r.cik] || {})[frame] = r.val;
  }
  await sleep(120);
}
const ttm = (map) => {
  const q = map || {};
  const keys = Object.keys(q).sort().slice(-4);
  return keys.length === 4 ? keys.reduce((a2, k) => a2 + q[k], 0) : null;
};

// shares outstanding (dei) — needed for market cap = price x shares
const sharesByCik = {};
for (const y of years) {
  const j = await get(`https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/CY${y}Q4I.json`);
  for (const r of j?.data || []) {
    if (r.cik == null || r.val == null) continue;
    (sharesByCik[r.cik] = sharesByCik[r.cik] || {})[y] = r.val;
  }
  process.stdout.write(`shares ${y}:${(j?.data || []).length} `);
  await sleep(120);
}
console.log('');

// names + tickers for every filer
const tickers = await get('https://www.sec.gov/files/company_tickers.json');
// A CIK can map to several tickers (share classes, preferreds). company_tickers.json is ordered, so a
// naive "last one wins" picked JPM-PM and GOOGM. Prefer common stock: no dash, no -P preferred suffix.
const tickScore = (t) => (/[-.]/.test(t) ? (/-P/i.test(t) ? 4 : 2) : 0) + (t.length > 5 ? 1 : 0);
const meta = {};
for (const r of Object.values(tickers || {})) {
  const cik = String(r.cik_str);
  const cur = meta[cik];
  if (!cur || tickScore(r.ticker) < tickScore(cur.ticker)) meta[cik] = { ticker: r.ticker, title: r.title };
}
// A CIK with no ticker of its own may still be the operating company whose ticker sits on a sibling
// CIK (Exxon Mobil Corporation vs "ExxonMobil Holdings Corp"). Match on the normalised name.
const normName = (x) => String(x || '').toLowerCase().replace(/\b(inc|corp|corporation|company|co|ltd|limited|plc|llc|holdings?|group|the)\b/g, '').replace(/[^a-z0-9]/g, '');
const byName = {};
for (const [cik, m] of Object.entries(meta)) {
  const k = normName(m.title);
  if (k && !byName[k]) byName[k] = m;
}

// Diluted share count as a fallback where the cover page has none.
const sharesAlt = {};
{
  const j = await get(`https://data.sec.gov/api/xbrl/frames/us-gaap/WeightedAverageNumberOfDilutedSharesOutstanding/shares/CY${thisYear - 1}.json`);
  for (const r of j?.data || []) if (r.cik != null && r.val != null) sharesAlt[r.cik] = r.val;
  await sleep(120);
}

// keep SIC where the previous build already knew it
let sicByCik = {};
try {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  for (const c of prev.companies || []) if (c.sic) sicByCik[c.cik] = { sic: c.sic, sector: c.sector, industry: c.industry, state: c.state };
} catch {}

const ciks = new Set([...Object.keys(concepts.revenue), ...Object.keys(concepts.revenue2), ...Object.keys(concepts.assets)]);
const companies = [];
for (const cik of ciks) {
  const rev = { ...(concepts.revenue3[cik] || {}), ...(concepts.revenue[cik] || {}), ...(concepts.revenue2[cik] || {}) };
  const ni = concepts.netIncome[cik] || {};
  const assets = concepts.assets[cik] || {};
  const equity = concepts.equity[cik] || {};
  const gross = concepts.gross[cik] || {};
  const opInc = concepts.opInc[cik] || {};
  const eps = concepts.eps[cik] || {};
  const series = years.map((y) => ({
    fy: y, revenue: rev[y] ?? null, netIncome: ni[y] ?? null, assets: assets[y] ?? null,
    equity: equity[y] ?? null, gross: gross[y] ?? null, opInc: opInc[y] ?? null, eps: eps[y] ?? null,
  }))
    .filter((s) => s.revenue != null || s.netIncome != null || s.assets != null)
    .sort((a, b) => a.fy - b.fy);
  if (!series.length) continue;
  // Headline figures take the latest NON-NULL value of each metric. Using the last row of the series
  // meant a year with only assets reported blanked out revenue and net income (and dropped the company
  // out of pricing entirely).
  const pick = (key) => { for (let i = series.length - 1; i >= 0; i--) if (series[i][key] != null) return { val: series[i][key], fy: series[i].fy }; return null; };
  const revPick = pick('revenue'), niPick = pick('netIncome'), asPick = pick('assets'), eqPick = pick('equity'), epPick = pick('eps');
  const latest = { fy: Math.max(...[revPick, niPick, asPick, eqPick, epPick].filter(Boolean).map((x) => x.fy), 0) };
  const first = series[0];
  const name = meta[cik]?.title || concepts.revenue[cik]?.name || concepts.revenue2[cik]?.name || concepts.revenue3[cik]?.name || concepts.assets[cik]?.name || `CIK ${cik}`;
  const prevSic = sicByCik[cik];
  companies.push({
    cik, ticker: meta[cik]?.ticker || byName[normName(name)]?.ticker || null, name,
    sic: prevSic?.sic || null, sector: prevSic?.sector || 'Other', industry: prevSic?.industry || null, state: prevSic?.state || null,
    debt: extra.debt[cik] ?? null, cash: extra.cash[cik] ?? null, da: extra.da[cik] ?? null,
    currentAssets: extra.ca[cik] ?? null, currentLiabilities: extra.cl[cik] ?? null,
    netIncomeTTM: ttm(qni[cik]),
    epsTTM: (() => {
      const q = extra.qeps[cik];
      if (!q) return null;
      const keys = Object.keys(q).sort().slice(-4);
      if (keys.length < 4) return null;
      const sum = keys.reduce((a2, k) => a2 + q[k], 0);
      // Guard: a calendar-quarter sum that disagrees wildly with the fiscal-year EPS is not TTM.
      const fyEps = epPick?.val;
      if (fyEps != null && fyEps !== 0 && Math.abs(sum - fyEps) / Math.abs(fyEps) > 0.6) return null;
      return +sum.toFixed(2);
    })(),
    fiscal: latest.fy, revenue: revPick?.val ?? null, netIncome: niPick?.val ?? null, assets: asPick?.val ?? null,
    equity: eqPick?.val ?? null, eps: epPick?.val ?? null,
    fyRevenue: revPick?.fy ?? null, fyNetIncome: niPick?.fy ?? null, fyAssets: asPick?.fy ?? null,
    // Shares from the newest year that actually reported them (a fiscal year that has not closed yet
    // has no cover-page count, which left MSFT unpriced).
    shares: (() => {
      const sh = sharesByCik[cik] || {};
      const y = Object.keys(sh).map(Number).filter((n) => n <= latest.fy).sort((a2, b2) => b2 - a2)[0];
      return (y ? sh[y] : null) || sharesAlt[cik] || null;
    })(),
    growth: first.revenue && latest.revenue ? ((latest.revenue - first.revenue) / Math.abs(first.revenue)) * 100 : null,
    years: series.length,
    series,
  });
}

companies.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
writeFileSync(OUT + '.tmp', JSON.stringify({ updated: new Date().toISOString(), count: companies.length, years, companies }));
renameSync(OUT + '.tmp', OUT);
console.log(`wrote ${companies.length} companies · ${companies.filter((c) => c.series.length >= 2).length} with multi-year series`);
