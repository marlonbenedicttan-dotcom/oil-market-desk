// Build the Korea dataset: every KOSPI company.
//
//   node scripts/build-korea.mjs                 full run (~950 companies)
//   node scripts/build-korea.mjs --limit=15      smoke test
//
// Sources: DART (FSS) for statements, share counts and market class; Yahoo for prices.
// KOSPI is `corp_cls === 'Y'` in DART — the same field that carries the share count, so one call per
// filer answers both questions.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDartClient, mapAccounts, REPORTS, num } from './dart.mjs';
import { deriveKorea } from './derive-korea.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'korea.json');
const CACHE = join(ROOT, 'data', 'cache', 'dart');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
// --codes=00126380,00164779 builds just those, which is how a smoke test should work: the corp list is
// ordered by code, so its first few hundred entries are all SPACs and REITs.
const CODES = (process.argv.find((x) => x.startsWith('--codes=')) || '').split('=')[1];
const YEARS = Number((process.argv.find((x) => x.startsWith('--years=')) || '').split('=')[1] || 5);
const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';

// DART tolerates a handful of parallel requests; one at a time made a 4,000-filer scan take 80 minutes.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let at = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (at < items.length) {
      const i = at++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));

const api = makeDartClient();

// --- 1. every listed filer ---------------------------------------------------------------------
console.log('corp codes…');
let book = readJson(join(CACHE, 'corp.json'));
if (!book || Date.parse(book.fetched) < Date.now() - 7 * DAY) {
  book = { fetched: new Date().toISOString(), rows: await api.corpCodes() };
  writeJson(join(CACHE, 'corp.json'), book);
}
// A committed universe means CI does not have to rescan 4,000 filers — that scan is what tripped
// DART's rate limiter.
const universeFile = readJson(join(ROOT, 'data', 'korea-universe.json'));
if (universeFile && universeFile.companies && universeFile.companies.length) {
  console.log(`universe: ${universeFile.companies.length} KOSPI companies from data/korea-universe.json`);
  const norm = universeFile.companies
    .filter((c) => c.shares)
    .map((c) => ({ corp: c.code, stock: c.ticker, name: c.name, nameEn: c.nameEn, industry: c.industry, shares: c.shares }));
  const picked = CODES ? norm.filter((c) => CODES.split(',').includes(c.corp)) : norm;
  globalThis.__kospi = LIMIT ? picked.slice(0, LIMIT) : picked;
}
const listed = book.rows.filter((r) => String(r.stock || '').trim());
console.log(`  ${book.rows.length} filers · ${listed.length} with a stock code`);

// --- 2. market class and shares (one call per filer, cached) ------------------------------------
console.log('shares + market class…');
// company.json carries the market class and industry code for every filer, whatever year it filed.
const infoOf = async (corp) => {
  const f = join(CACHE, `info-${corp}.json`);
  const hit = readJson(f);
  if (hit && hit.v === 2 && Date.parse(hit.fetched) > Date.now() - 30 * DAY) return hit;
  const url = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${process.env.DART_API_KEY}&corp_code=${corp}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429) { await sleep(4000); continue; }
      const j = await res.json();
      const out = {
        v: 2,
        fetched: new Date().toISOString(),
        cls: j.corp_cls || null,
        industry: j.induty_code || null,
        name: j.stock_name || null,
        nameEn: j.corp_name_eng || null,
      };
      writeJson(f, out);
      await sleep(150);
      return out;
    } catch { await sleep(1000); }
  }
  await sleep(150);
  return hit || { cls: null, industry: null };
};

// Shares come from the stock-total table, summed across common and preferred.
const sharesOf = async (corp) => {
  const f = join(CACHE, `shares-${corp}.json`);
  const hit = readJson(f);
  if (hit && hit.shares && Date.parse(hit.fetched) > Date.now() - 30 * DAY) return hit;
  const url = `https://opendart.fss.or.kr/api/stockTotqySttus.json?crtfc_key=${process.env.DART_API_KEY}&corp_code=${corp}&bsns_year=${new Date().getFullYear() - 1}&reprt_code=11011`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429) { await sleep(4000); continue; }
      const j = await res.json();
      const rows = j.list || [];
      // The table carries common, preferred AND a 합계 (total) row — summing all three double counts.
      const total = rows.find((r) => String(r.se || '').includes('합계'));
      const parts = rows.filter((r) => /보통주|우선주/.test(String(r.se || '')));
      const shares = total
        ? num(total.now_to_isu_stock_totqy)
        : (parts.reduce((a, r) => a + (num(r.now_to_isu_stock_totqy) || 0), 0) || null);
      const out = { fetched: new Date().toISOString(), shares };
      writeJson(f, out);
      await sleep(150);
      return out;
    } catch { await sleep(1000); }
  }
  await sleep(150);
  return hit || { shares: null };
};

// A smoke test should not scan 4,000 filers first — cap the scan, not just the output.
const scan = CODES ? listed.filter((r) => CODES.split(',').includes(r.corp)) : listed;
let scanned = 0;
const found = globalThis.__kospi ? [] : await pool(scan, 3, async (c) => {
  const info = await infoOf(c.corp);
  scanned++;
  if (scanned % 250 === 0) console.log(`  ${scanned}/${scan.length}`);
  if (info.cls !== 'Y') return null;
  const sh = await sharesOf(c.corp);
  return sh.shares ? { ...c, shares: sh.shares, industry: info.industry, nameEn: c.nameEn || info.nameEn } : null;
});
const kospi = globalThis.__kospi || found.filter(Boolean);
console.log(`  ${kospi.length} KOSPI companies`);
const universe = LIMIT ? kospi.slice(0, LIMIT) : kospi;

// --- 3. prices ----------------------------------------------------------------------------------
console.log('prices…');
// Korean daily prices come from Naver Finance: free, no key, and not rate-limited the way Yahoo is
// from this machine. The response is a JS array literal with a header row.
async function chart(ticker) {
  const f = join(CACHE, `px-${ticker}.json`);
  const hit = readJson(f);
  if (hit && Date.parse(hit.fetched) > Date.now() - 18 * 3600e3) return hit.rows;
  const start = iso(Date.now() - 5 * 365 * DAY).replace(/-/g, '');
  const end = iso(Date.now()).replace(/-/g, '');
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${ticker}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.naver.com/' } });
      if (res.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!res.ok) return null;
      const text = await res.text();
      const json = text.replace(/'/g, '"').replace(/,\s*]/g, ']');
      const rows = JSON.parse(json);
      const out = rows.slice(1)
        .filter((r) => Array.isArray(r) && r[0] && r[4] != null)
        .map((r) => ({ d: `${r[0].slice(0, 4)}-${r[0].slice(4, 6)}-${r[0].slice(6, 8)}`, c: Number(r[4]) }))
        .filter((p) => Number.isFinite(p.c));
      if (!out.length) return null;
      writeJson(f, { fetched: new Date().toISOString(), rows: out });
      await sleep(120);
      return out;
    } catch { await sleep(800); }
  }
  return null;
}

const priced = await pool(universe, 4, async (c) => {
  const rows = await chart(c.stock.trim());
  if (!rows || rows.length < 20) return null;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const six = rows[Math.max(0, rows.length - 126)];
  const jan1 = rows.find((p) => p.d >= `${new Date().getUTCFullYear()}-01-01`);
  return {
    ...c,
    ticker: c.stock.trim(),
    price: last.c,
    priceDate: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan1 ? +(((last.c / jan1.c) - 1) * 100).toFixed(2) : null,
    series: rows.slice(-260).map((p) => ({ d: p.d, c: p.c })),
  };
});
const withPrices = priced.filter(Boolean);
console.log(`  ${withPrices.length} with prices`);

// --- 4. financial statements --------------------------------------------------------------------
console.log('financials…');
const thisYear = new Date().getFullYear();
const years = Array.from({ length: YEARS }, (_, k) => thisYear - 1 - k);

async function statements(corp, year, report) {
  const f = join(CACHE, `fin-${corp}-${year}-${report}.json`);
  const hit = readJson(f);
  if (hit && Date.parse(hit.fetched) > Date.now() - 7 * DAY) return hit.rows;
  try {
    const rows = await api.singleAccounts(corp, year, report);
    writeJson(f, { fetched: new Date().toISOString(), rows });
    return rows;
  } catch { return []; }
}

const collected = await pool(withPrices, 2, async (c) => {
  const reports = [];
  for (const y of years) {
    const rows = await statements(c.corp, y, REPORTS.annual);
    if (!rows.length) continue;
    const m = mapAccounts(rows);
    const end = (rows.find((r) => r.thstrm_dt) || {}).thstrm_dt || `${y}-12-31`;
    reports.push({ report: 'annual', end: end.slice(0, 10).replace(/\./g, '-'), ...m });
  }
  // The current year's quarters, for a TTM figure that is not a year old.
  // Quarterly filings carry the period NAME but no date field (thstrm_dt is null), so the end date is
  // derived from the report code: Q1 ends 31 March, H1 30 June, Q3 30 September.
  const QUARTER_END = { q1: '03-31', h1: '06-30', q3: '09-30' };
  for (const [k, code] of [['q1', REPORTS.q1], ['h1', REPORTS.h1], ['q3', REPORTS.q3]]) {
    const rows = await statements(c.corp, thisYear, code);
    if (!rows.length) continue;
    const m = mapAccounts(rows);
    const raw = (rows.find((r) => r.thstrm_dt) || {}).thstrm_dt;
    const end = raw ? raw.slice(0, 10).replace(/\./g, '-') : `${thisYear}-${QUARTER_END[k]}`;
    reports.push({ report: k, end, ...m });
  }
  if (!reports.length) return null;
  return {
    code: c.corp, ticker: c.ticker, name: c.name, nameEn: c.nameEn || null,
    price: c.price, priceDate: c.priceDate,
    chg1d: c.chg1d, chg6m: c.chg6m, chgYtd: c.chgYtd,
    series: c.series, shares: c.shares, reports,
  };
});
const companies = collected.filter(Boolean);
console.log(`  ${companies.length} with statements`);

// --- 5. derive and write ------------------------------------------------------------------------
let fx = null;
try {
  // ECB reference rates via Frankfurter: free, no key, and not rate-limited like Yahoo.
  const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=KRW');
  const j = await r.json();
  fx = j?.rates?.KRW ?? null;
} catch { fx = null; }

const out = deriveKorea({ companies, fx });
if (!out.length) {
  console.log('no companies built — keeping the existing file');
  process.exit(1);
}

// The index itself, from the same Naver feed the prices come from.
async function indexSeries(symbol) {
  const start = iso(Date.now() - 400 * DAY).replace(/-/g, '');
  const end = iso(Date.now()).replace(/-/g, '');
  try {
    const res = await fetch(`https://api.finance.naver.com/siseJson.naver?symbol=${symbol}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`, { headers: { 'User-Agent': UA, Referer: 'https://finance.naver.com/' } });
    const text = await res.text();
    const rows = JSON.parse(text.replace(/'/g, '"').replace(/,\s*]/g, ']'));
    return rows.slice(1).filter((r) => Array.isArray(r) && r[0] && r[4] != null)
      .map((r) => ({ d: `${r[0].slice(0, 4)}-${r[0].slice(4, 6)}-${r[0].slice(6, 8)}`, c: Number(r[4]) }));
  } catch { return []; }
}
const kospiIdx = await indexSeries('KOSPI');
const idx = kospiIdx.length ? (() => {
  const last = kospiIdx[kospiIdx.length - 1];
  const prev = kospiIdx[kospiIdx.length - 2];
  const six = kospiIdx[Math.max(0, kospiIdx.length - 126)];
  const jan1 = kospiIdx.find((p) => p.d >= `${new Date().getUTCFullYear()}-01-01`);
  return {
    level: last.c, date: last.d,
    chg1d: prev ? +(((last.c / prev.c) - 1) * 100).toFixed(2) : null,
    chg6m: six ? +(((last.c / six.c) - 1) * 100).toFixed(2) : null,
    chgYtd: jan1 ? +(((last.c / jan1.c) - 1) * 100).toFixed(2) : null,
    series: kospiIdx.slice(-260),
  };
})() : null;

const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
};
const market = {
  companies: out.length,
  totalCap: out.reduce((a, c) => a + (c.marketCap || 0), 0),
  medianPe: median(out.map((c) => c.pe)),
  medianPb: median(out.map((c) => c.pb)),
  medianRoe: median(out.map((c) => c.roe)),
  belowBook: out.filter((c) => c.pb != null && c.pb < 1).length,
  advancing: out.filter((c) => (c.chg1d || 0) > 0).length,
  declining: out.filter((c) => (c.chg1d || 0) < 0).length,
  upYtd: out.filter((c) => (c.chgYtd || 0) > 0).length,
};

const themeBook = readJson(join(ROOT, 'data', 'korea-themes.json')) || { themes: [] };
const have = new Set(out.map((c) => c.ticker));
const themes = (themeBook.themes || []).map((t) => ({
  id: t.id, label: t.label, kind: t.kind, note: t.note,
  tickers: (t.tickers || []).filter((x) => have.has(x)),
}));
out.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
writeJson(OUT, {
  updated: new Date().toISOString(),
  universe: `KOSPI · ${out.length} companies`,
  currency: 'KRW',
  fx: { pair: 'USDKRW', rate: fx, date: iso(Date.now()) },
  market, index: idx, themes,
  companies: out,
});
console.log(`${out.length} companies · ${out.filter((c) => c.pe != null).length} with P/E · FX ${fx}`);
console.log(out.slice(0, 5).map((c) => `  ${c.ticker} ${c.name} · ₩${Math.round(c.price)} · P/E ${c.pe ?? '—'} · P/B ${c.pb ?? '—'}`).join('\n'));
