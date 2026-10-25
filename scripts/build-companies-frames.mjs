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
const concepts = { revenue: {}, revenue2: {}, netIncome: {}, assets: {}, equity: {}, gross: {}, opInc: {}, eps: {}, shares: {} };
const TAGS = {
  revenue: 'Revenues',
  revenue2: 'RevenueFromContractWithCustomerExcludingAssessedTax',
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
const meta = {};
for (const r of Object.values(tickers || {})) meta[r.cik_str] = { ticker: r.ticker, title: r.title };

// keep SIC where the previous build already knew it
let sicByCik = {};
try {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  for (const c of prev.companies || []) if (c.sic) sicByCik[c.cik] = { sic: c.sic, sector: c.sector, industry: c.industry, state: c.state };
} catch {}

const ciks = new Set([...Object.keys(concepts.revenue), ...Object.keys(concepts.revenue2), ...Object.keys(concepts.assets)]);
const companies = [];
for (const cik of ciks) {
  const rev = { ...(concepts.revenue[cik] || {}), ...(concepts.revenue2[cik] || {}) };
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
  const latest = series[series.length - 1];
  const first = series[0];
  const name = meta[cik]?.title || concepts.revenue[cik]?.name || concepts.revenue2[cik]?.name || concepts.assets[cik]?.name || `CIK ${cik}`;
  const prevSic = sicByCik[cik];
  companies.push({
    cik, ticker: meta[cik]?.ticker || null, name,
    sic: prevSic?.sic || null, sector: prevSic?.sector || 'Other', industry: prevSic?.industry || null, state: prevSic?.state || null,
    fiscal: latest.fy, revenue: latest.revenue, netIncome: latest.netIncome, assets: latest.assets,
    equity: latest.equity, gross: latest.gross, opInc: latest.opInc, eps: latest.eps,
    shares: (sharesByCik[cik] || {})[latest.fy] || null,
    growth: first.revenue && latest.revenue ? ((latest.revenue - first.revenue) / Math.abs(first.revenue)) * 100 : null,
    years: series.length,
    series,
  });
}

companies.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
writeFileSync(OUT + '.tmp', JSON.stringify({ updated: new Date().toISOString(), count: companies.length, years, companies }));
renameSync(OUT + '.tmp', OUT);
console.log(`wrote ${companies.length} companies · ${companies.filter((c) => c.series.length >= 2).length} with multi-year series`);
