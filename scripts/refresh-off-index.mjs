// Off-index coverage: the large caps that are listed but are not in any of the index universes this
// desk builds from (S&P 1500, TOPIX, KOSPI, …). They are real public companies with real quotes and
// real filings — they are simply not index members yet, so nothing in the ten-market build reaches
// them.
//
// The list is curated (a ticker and its listing facts), the market data is fetched, and the output is
// committed. Nothing here is estimated: a price comes from Nasdaq, the listing date and IPO price
// come from the 424B4 prospectus, and a ratio the filings cannot support stays null.
//
//   node scripts/refresh-off-index.mjs             # refresh prices, caps and series
//   node scripts/refresh-off-index.mjs --dry       # print, write nothing

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'off-index.json');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const SEC_UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Curated facts. `listedAt`, `ipoPrice` and `why` do not come from a price feed: they come from the
// listing prospectus and the exchange notice, so they live here and are not overwritten by a refresh.
const BASE = [
  {
    ticker: 'SPCX', cik: '1181412', name: 'SpaceX', legalName: 'Space Exploration Technologies Corp.',
    aliases: ['x', 'spacex', 'starlink', 'starship', 'falcon'],
    listedAt: '2026-06-12', ipoPrice: 135, exchange: 'NASDAQ',
    why: 'Listed 12 Jun 2026 · not an index constituent yet',
  },
  {
    ticker: 'ANT', cik: '2130357', name: 'Anthropic', legalName: 'Anthropic, PBC',
    aliases: ['claude', 'anthropic', 'claude ai', 'claude code'],
    listedAt: '2026-11-19', ipoPrice: 83, exchange: 'NASDAQ',
    why: 'Listed 19 Nov 2026 · not an index constituent yet',
  },
  {
    ticker: 'CBRS', cik: '2021728', name: 'Cerebras Systems', legalName: 'Cerebras Systems Inc.',
    aliases: ['cerebras', 'cerebras systems', 'wafer scale'],
    listedAt: '2026-05-14', ipoPrice: 185, exchange: 'NASDAQ',
    why: 'Listed 14 May 2026 · not an index constituent yet',
  },
  {
    ticker: 'CRWV', cik: '1769628', name: 'CoreWeave', legalName: 'CoreWeave, Inc.',
    aliases: ['coreweave', 'core weave'],
    listedAt: '2025-03-28', ipoPrice: 40, exchange: 'NASDAQ',
    why: 'Listed 28 Mar 2025 · not an index constituent yet',
  },
  {
    ticker: 'CRCL', cik: '1876042', name: 'Circle Internet Group', legalName: 'Circle Internet Group, Inc.',
    aliases: ['circle', 'usdc', 'circle internet'],
    listedAt: '2025-06-05', ipoPrice: 31, exchange: 'NYSE',
    why: 'Listed 05 Jun 2025 · not an index constituent yet',
  },
  {
    ticker: 'CHYM', cik: '1795586', name: 'Chime Financial', legalName: 'Chime Financial, Inc.',
    aliases: ['chime', 'chime financial'],
    listedAt: '2025-06-12', ipoPrice: 27, exchange: 'NASDAQ',
    why: 'Listed 12 Jun 2025 · not an index constituent yet',
  },
  {
    ticker: 'FIG', cik: '1579878', name: 'Figma', legalName: 'Figma, Inc.',
    aliases: ['figma', 'figjam'],
    listedAt: '2025-07-31', ipoPrice: 33, exchange: 'NYSE',
    why: 'Listed 31 Jul 2025 · not an index constituent yet',
  },
];

// Nasdaq's sector vocabulary folded into the same buckets the rest of the desk uses
// (kept in step with scripts/complete-us-universe.mjs).
const NASDAQ_SECTOR = {
  Technology: 'Technology', 'Health Care': 'Healthcare', 'Consumer Discretionary': 'Consumer',
  'Consumer Staples': 'Consumer', Finance: 'Financials', Industrials: 'Industrials', Energy: 'Energy',
  Materials: 'Materials', Utilities: 'Utilities', 'Real Estate': 'Real estate',
  Telecommunications: 'Telecom', 'Communication Services': 'Media',
};
const sectorOf = (s) => NASDAQ_SECTOR[s] || 'Other';
const num = (v) => Number(String(v == null ? '' : v).replace(/[$,%\s,]/g, '')) || null;

// EDGAR payloads are the document itself (no `data` envelope), unlike the Nasdaq ones.
async function getRawJSON(url, headers = UA, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { ...headers, Accept: 'application/json, text/plain, */*' } });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(700 * (i + 1));
  }
  return null;
}

async function getJSON(url, headers = UA, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' } });
      if (res.ok) {
        const j = await res.json();
        if (j && j.data) return j.data;
      }
    } catch { /* retry */ }
    await sleep(700 * (i + 1));
  }
  return null;
}

async function quote(ticker) {
  const sym = ticker.replace('-', '.');
  const [summary, info] = await Promise.all([
    getJSON(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`),
    getJSON(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`),
  ]);
  const s = (summary && summary.summaryData) || {};
  const p = (info && info.primaryData) || {};
  const infoHiLo = String(((info && info.keyStats) || {}).fiftyTwoWeekHighLow?.value || '').match(/([\d.,]+)\s*-\s*([\d.,]+)/);
  const sumHiLo = String(s.FiftTwoWeekHighLow?.value || '').match(/([\d.,]+)\s*\/\s*([\d.,]+)/);
  return {
    price: num(p.lastSalePrice) || num(s.PreviousClose?.value),
    prevClose: num(s.PreviousClose?.value),
    chg1d: num(p.percentageChange),
    cap: num(s.MarketCap?.value),
    sector: s.Sector?.value || null,
    industry: s.Industry?.value || null,
    wk52Low: (infoHiLo ? num(infoHiLo[1]) : sumHiLo ? num(sumHiLo[2]) : null),
    wk52High: (infoHiLo ? num(infoHiLo[2]) : sumHiLo ? num(sumHiLo[1]) : null),
  };
}

// One year of daily closes. Used for the company page chart and for the first close after listing
// (which is what "since IPO" is measured against when the prospectus price and the tape disagree).
async function history(ticker, from) {
  const sym = ticker.replace('-', '.');
  const today = new Date().toISOString().slice(0, 10);
  const d = await getJSON(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=stocks&fromdate=${from}&todate=${today}&limit=9999`);
  const rows = ((d || {}).tradesTable || {}).rows || [];
  return rows
    .map((r) => {
      const [m, dd, y] = String(r.date || '').split('/');
      return [y && `${y}-${m}-${dd}`, num(r.close)];
    })
    .filter(([date, close]) => date && close != null)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Filings — the same EDGAR XBRL the index members are built from. A TTM is only produced when the
// arithmetic closes (last 10-K + the current year to date − the same period a year earlier); when
// there is no annual report yet the latest 10-Q is shown on its own, labelled by its period, and the
// ratios that need a year of earnings stay null rather than becoming a number that means nothing.
// ---------------------------------------------------------------------------------------------
const SEC_DAY = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const CONCEPTS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  assets: ['Assets'],
};

function conceptRows(gaap, names, instant = false) {
  const out = [];
  for (const n of names) {
    const f = gaap[n];
    if (!f) continue;
    const unit = Object.keys(f.units).find((u) => u === 'USD') || Object.keys(f.units)[0];
    for (const r of f.units[unit] || []) {
      if (r.form !== '10-K' && r.form !== '10-Q') continue;
      if (instant ? r.start : !r.start) continue;
      out.push({ ...r, concept: n });
    }
  }
  return out;
}
const dedupePeriods = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.start || ''}|${r.end}`;
    const prev = m.get(k);
    if (!prev || (r.filed || '') > (prev.filed || '')) m.set(k, r);
  }
  return [...m.values()];
};
const fiscalYearOf = (rows) => rows
  .filter((r) => r.form === '10-K' && SEC_DAY(r.start, r.end) >= 340 && SEC_DAY(r.start, r.end) <= 380)
  .sort((a, b) => (a.end < b.end ? 1 : -1))[0] || null;
const shiftYear = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCFullYear(x.getUTCFullYear() - 1); return x.toISOString().slice(0, 10); };

async function filings(cik, capUsd) {
  const id = String(cik).padStart(10, '0');
  const cf = await getRawJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`, { 'User-Agent': SEC_UA });
  await sleep(250);
  const gaap = cf?.facts?.['us-gaap'] || {};
  const out = { basis: null, ttm: null, latest: null, fy: null, equity: null, assets: null, latestFiling: null, revenueCagr: null };

  // Latest 10-K / 10-Q metadata (form, period, filed, link) — this is what "a new filing shows up" means.
  const sub = await getRawJSON(`https://data.sec.gov/submissions/CIK${id}.json`, { 'User-Agent': SEC_UA });
  await sleep(250);
  const rec = sub?.filings?.recent || {};
  for (let i = 0; i < (rec.form || []).length; i++) {
    if (!/^10-[KQ]$/.test(rec.form[i])) continue;
    const acc = String(rec.accessionNumber?.[i] || '').replace(/-/g, '');
    out.latestFiling = {
      form: rec.form[i], filed: rec.filingDate?.[i] || null, period: rec.reportDate?.[i] || null,
      url: acc && rec.primaryDocument?.[i] ? `https://www.sec.gov/Archives/edgar/data/${id}/${acc}/${rec.primaryDocument[i]}` : null,
    };
    break;
  }

  // Quarterly figures: the filings are cumulative (Q1, H1, 9M, FY), so a quarter is the step between
  // two consecutive periods inside the same fiscal year. The deltas are kept only when the step is
  // genuinely a quarter long, and EPS follows the same periods.
  // Quarterly figures. A filing reports cumulative periods (Q1, H1, 9M, FY) and sometimes the
  // standalone quarter as well. A quarter is either tagged as one, or the step between two periods
  // that share a start (YTD progression) or an end (YTD minus the quarter inside it). Deltas are kept
  // only when the step is genuinely a quarter long, and EPS uses tagged quarters only — diluted EPS
  // is not additive across quarters, so subtracting it would invent a number.
  const quarterParts = (rows) => {
    const reported = new Map();
    const derived = new Map();
    const facts = rows.filter((r) => SEC_DAY(r.start, r.end) <= 380);
    for (const r of facts) {
      const d = SEC_DAY(r.start, r.end);
      if (d < 60 || d > 110) continue;
      const prev = reported.get(r.end);
      if (!prev || (r.filed || '') > (prev.filed || '')) reported.set(r.end, r);
    }
    for (const a of facts) {
      for (const b of facts) {
        if (a === b) continue;
        let from, to, val;
        if (a.start === b.start && a.end < b.end) { from = a.end; to = b.end; val = b.val - a.val; }
        else if (a.end === b.end && a.start < b.start) {
          // The YTD minus the quarter inside it is the earlier part of the year: it ends the day
          // before that quarter starts, not on its start date.
          from = a.start; to = new Date(Date.parse(b.start) - 864e5).toISOString().slice(0, 10); val = a.val - b.val;
        } else continue;
        if (SEC_DAY(from, to) < 60 || SEC_DAY(from, to) > 110) continue;
        if (!derived.has(to)) derived.set(to, { start: from, end: to, val });
      }
    }
    return { reported, derived };
  };
  const revAll = dedupePeriods(conceptRows(gaap, CONCEPTS.revenue));
  const niAll = dedupePeriods(conceptRows(gaap, CONCEPTS.netIncome));
  const equityRows = conceptRows(gaap, CONCEPTS.equity, true).sort((a, b) => (a.end < b.end ? 1 : -1));
  const assetRows = conceptRows(gaap, CONCEPTS.assets, true).sort((a, b) => (a.end < b.end ? 1 : -1));
  out.equity = equityRows[0] ? equityRows[0].val : null;
  out.assets = assetRows[0] ? assetRows[0].val : null;
  if (!revAll.length || !niAll.length) return out;

  // The primary revenue line is the concept with the largest annual figure; mixing concepts within
  // one company double-counts (a component line next to the total).
  const byConcept = {};
  for (const r of revAll) (byConcept[r.concept] = byConcept[r.concept] || []).push(r);
  const best = Object.entries(byConcept).map(([c, rows]) => {
    const fy = fiscalYearOf(rows);
    return { rows, size: fy ? fy.val : Math.max(...rows.map((r) => r.val)) };
  }).sort((a, b) => b.size - a.size)[0];
  const rev = dedupePeriods(best.rows);
  const end = rev.reduce((a, r) => (!a || r.end > a ? r.end : a), null);
  const longestTo = (rows, e) => rows.filter((r) => r.end === e).sort((a, b) => (a.start < b.start ? -1 : 1))[0] || null;
  const ytd = longestTo(rev, end);
  const ytdNi = longestTo(niAll, end);
  const fy = fiscalYearOf(rev);
  const fyNi = fiscalYearOf(niAll);
  const prev = ytd ? rev.find((r) => r.start === shiftYear(ytd.start) && r.end === shiftYear(ytd.end)) : null;
  const prevNi = ytdNi ? niAll.find((r) => r.start === shiftYear(ytdNi.start) && r.end === shiftYear(ytdNi.end)) : null;
  const ttmRev = fy && ytd && prev && ytd.end > fy.end ? fy.val + ytd.val - prev.val : (fy && ytd && ytd.end <= fy.end ? fy.val : null);
  const ttmNi = fyNi && ytdNi && prevNi && ytdNi.end > fyNi.end ? fyNi.val + ytdNi.val - prevNi.val : (fyNi && ytdNi && ytdNi.end <= fyNi.end ? fyNi.val : null);

  const epsRows = dedupePeriods(conceptRows(gaap, ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']));
  const rq = quarterParts(rev);
  const nq = quarterParts(niAll);
  const eq = quarterParts(epsRows);
  const pick = (parts, end) => parts.reported.get(end) || parts.derived.get(end) || null;
  // A derived quarter can land a day or two from the tagged one; the tagged quarter wins.
  const near = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5) <= 6;
  const reportedEnds = [...rq.reported.keys(), ...nq.reported.keys()];
  const derivedEnds = [...rq.derived.keys(), ...nq.derived.keys()].filter((e) => !reportedEnds.some((r) => near(r, e)));
  const ends = [...new Set(reportedEnds.concat(derivedEnds))].sort();
  // Fiscal label for each quarter (fy end + Q1..Q4), taken from the reported 10-K's own period end,
  // so the matrix on the page groups and labels periods exactly as the index members' does. A
  // January year-end company (Figma) is the reason this has to be computed, not assumed.
  const fyEndMonth = fy ? Number(String(fy.end).slice(5, 7)) : 12;
  const fiscalOf = (end) => {
    const m = Number(String(end).slice(5, 7));
    const y = Number(String(end).slice(0, 4));
    if (fyEndMonth === 12) return { fy: y, q: Math.ceil(m / 3) };
    const q = Math.floor((((m - fyEndMonth + 12) % 12) - 1) / 3) + 1;
    return { fy: m > fyEndMonth ? y + 1 : y, q: Math.max(1, Math.min(4, q)) };
  };
  out.quarters = ends.map((end) => {
    const rv = pick(rq, end);
    const nv = pick(nq, end);
    const ev = eq.reported.get(end) || null;
    const f = fiscalOf(end);
    return { end, fy: f.fy, q: f.q, revenue: rv ? rv.val : null, netIncome: nv ? nv.val : null, eps: ev ? ev.val : null };
  }).filter((q) => q.revenue != null || q.netIncome != null).slice(-8);
  out.fy = fy ? { end: fy.end, revenue: fy.val, netIncome: fyNi ? fyNi.val : null } : null;
  out.latest = ytd ? { start: ytd.start, end: ytd.end, revenue: ytd.val, netIncome: ytdNi ? ytdNi.val : null } : null;
  // The prior-year comparable is stored too, so the TTM can be re-derived by an auditor (and by this
  // desk's own audit script) instead of being a number only the build understands.
  out.prior = prev ? { start: prev.start, end: prev.end, revenue: prev.val, netIncome: prevNi ? prevNi.val : null } : null;
  if (ttmRev != null) {
    out.basis = 'TTM';
    out.ttm = { end, revenue: ttmRev, netIncome: ttmNi, equity: out.equity, assets: out.assets };
  }
  const years = [...new Set(rev.filter((r) => r.form === '10-K').map((r) => r.end))].sort()
    .map((e) => rev.find((r) => r.end === e && r.form === '10-K')).filter((r) => r && r.val > 0);
  if (years.length >= 3) {
    const a = years[0], b = years[years.length - 1];
    const n = SEC_DAY(a.end, b.end) / 365.25;
    if (n >= 2 && n <= 6) out.revenueCagr = +((Math.pow(b.val / a.val, 1 / n) - 1) * 100).toFixed(1);
  }
  // Ratios only where the inputs exist: no TTM earnings means no P/E, no ROE and no margin.
  if (out.ttm && capUsd) {
    const ni = out.ttm.netIncome;
    out.pe = ni != null && ni > 0 ? +(capUsd / ni).toFixed(1) : null;
    out.roe = ni != null && out.equity > 0 ? +((ni / out.equity) * 100).toFixed(1) : null;
    out.netMargin = ni != null && out.ttm.revenue > 0 ? +((ni / out.ttm.revenue) * 100).toFixed(1) : null;
  }
  return out;
}

// A written profile. The index members are described from stockanalysis.com's company page (not the
// 10-K's legal "Item 1" text, and not Nasdaq's marketing blurb), so a new listing gets the same
// treatment; when that page does not exist yet, the vendor's own description is labelled as such
// rather than leaving the page blank.
async function profile(ticker) {
  try {
    const res = await fetch(`https://stockanalysis.com/stocks/${String(ticker).toLowerCase()}/company/`, {
      headers: { 'User-Agent': UA }, redirect: 'follow',
    });
    if (res.ok) {
      const html = await res.text();
      const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
      if (box) {
        const paras = [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' '));
        const text = paras.join(' ')
          .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ').trim();
        if (text.length > 120) return { description: text, descriptionSource: 'stockanalysis.com' };
      }
    }
  } catch { /* fall through to the vendor blurb */ }
  const d = await getJSON(`https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/company-profile?assetclass=stocks`);
  const text = (((d || {}).CompanyDescription || {}).value || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? { description: text, descriptionSource: 'nasdaq' } : { description: null, descriptionSource: null };
}

const prev = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { companies: [] };
const prevBy = new Map((prev.companies || []).map((c) => [c.ticker, c]));
const out = [];

for (const base of BASE) {
  const q = await quote(base.ticker);
  await sleep(400);   // Nasdaq throttles a burst of seven names; space the calls out
  // The profile does not depend on the quote, so it is fetched before the guard: a throttled Nasdaq
  // call must not also cost the reader their description.
  const prof = await profile(base.ticker);
  if (!q || !q.price || !q.cap || !q.sector) {
    // Never write a half row because a vendor blinked: without a price, a cap and a sector the row
    // would claim a $0 company. Keep the previous one (with the fresh profile) and say so.
    const kept = prevBy.get(base.ticker);
    if (kept) out.push({ ...kept, ...prof });
    console.warn(`${base.ticker}: incomplete quote (${Object.entries({ price: q && q.price, cap: q && q.cap, sector: q && q.sector }).filter(([, v]) => !v).map(([k]) => k).join(',')}) — kept the previous row`);
    continue;
  }
  // From the listing date (capped at three years), so the company page can draw a chart over the whole
  // life of the listing and `firstClose` really is the first close, not the first close in a window.
  const floor = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
  const from = base.listedAt < floor ? floor : base.listedAt;
  const series = await history(base.ticker, from);
  const firstClose = series.length ? series[0][1] : null;
  // Everything is quoted off the tape's own last close, not a live intraday tick: the price, the
  // market cap, the 52-week range and the return all describe the same session, so the file can be
  // audited at any hour and the row cannot disagree with its own series. The index pages work the
  // same way (a dated close), and the page labels it "as of".
  const lastBar = series.length ? series[series.length - 1] : null;
  const prevBar = series.length > 1 ? series[series.length - 2] : null;
  const price = lastBar ? lastBar[1] : q.price;
  const priceDate = lastBar ? lastBar[0] : new Date().toISOString().slice(0, 10);
  // The vendor's cap is live; scale it to the close we store so cap = price × shares exactly.
  const shares = q.price && q.cap ? q.cap / q.price : null;
  const capUsd = shares && price ? Math.round(price * shares) : q.cap;
  const wkLow = q.wk52Low == null ? null : Math.min(q.wk52Low, price);
  const wkHigh = q.wk52High == null ? null : Math.max(q.wk52High, price);
  const year = new Date().getUTCFullYear();
  const priorYearEnd = [...series].reverse().find(([d]) => d < `${year}-01-01`);
  out.push({
    ...base,
    market: 'us',
    currency: 'USD',
    price,
    priceDate,
    prevClose: prevBar ? prevBar[1] : q.prevClose,
    chg1d: prevBar ? +(((price / prevBar[1]) - 1) * 100).toFixed(2) : q.chg1d,
    capUsd,
    shares: shares ? Math.round(shares) : null,
    sector: sectorOf(q.sector),
    nasdaqSector: q.sector,
    industry: q.industry,
    wk52Low: wkLow,
    wk52High: wkHigh,
    firstClose,
    // A loss-making company has no trailing P/E, and a company that listed this year has no full-year
    // return. Both stay null rather than becoming a number that means nothing.
    pe: null,
    roe: null,
    ytd: priorYearEnd ? +(((price / priorYearEnd[1]) - 1) * 100).toFixed(2) : null,
    vsIpo: base.ipoPrice ? +(((price / base.ipoPrice) - 1) * 100).toFixed(2) : null,
    series,
  });
  const fin = await filings(base.cik, capUsd);
  const row = out[out.length - 1] || {};
  row.description = prof.description;
  row.descriptionSource = prof.descriptionSource;
  row.financials = fin;
  row.pe = fin.pe == null ? null : fin.pe;
  row.roe = fin.roe == null ? null : fin.roe;
  row.netMargin = fin.netMargin == null ? null : fin.netMargin;
  row.revenueCagr = fin.revenueCagr == null ? null : fin.revenueCagr;
  console.log(`${base.ticker.padEnd(5)} $${price} · ${(capUsd / 1e9).toFixed(0)}B · ${series.length} closes · vs IPO ${(((price / base.ipoPrice) - 1) * 100).toFixed(1)}% · ${fin.basis || 'no annual report'}${fin.pe ? ' · P/E ' + fin.pe : ''}${fin.latestFiling ? ' · ' + fin.latestFiling.form + ' ' + fin.latestFiling.filed : ''} · ${prof.description ? prof.description.length + ' chars' : 'no profile'}`);
}

const payload = {
  updated: new Date().toISOString(),
  source: 'Nasdaq quote + historical (delayed); listing dates and IPO prices from the 424B4 prospectus',
  note: 'Listed but not index members. Kept out of the index totals on purpose — a company with a day of trading history would skew breadth, the median P/E and the sector split.',
  companies: out,
};

if (DRY) {
  console.log(JSON.stringify(payload.companies.map(({ series, ...c }) => c), null, 1));
} else {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, FILE);
  console.log(`wrote ${FILE} · ${out.length} companies`);
}
