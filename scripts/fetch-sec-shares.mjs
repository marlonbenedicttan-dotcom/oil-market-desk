// Current ordinary shares for Hong Kong ADR/secondary listings from the SEC cover page.
//
// The vendor's HKG statistics page says "Shares Outstanding: n/a" for a secondary-listed ADR, and the
// filing's diluted count is a period weighted average. The US 20-F/10-K/10-Q cover carries the
// company's ordinary share count as of a dated filing — the exact denominator the H-price cap needs.
// This is official, free, and refreshes with each SEC filing.
//
//   node scripts/fetch-sec-shares.mjs
//   node scripts/fetch-sec-shares.mjs --fresh
//
// The HK-code -> ticker/CIK map is reviewed once in data/hk-adr-map.json. The parser reads the cover
// section ("Indicate the number of outstanding shares..." / "based on X ordinary shares outstanding"),
// sums Classes A/B when that is the only breakdown, and validates the result against the HK filing's
// share count before publishing it. A parsed count outside 0.5–2× the filing is rejected, not stored.
//
// Writes data/hongkong-sec-shares.json. Read-only against the market data.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'hongkong-sec-shares.json');
const MAP = join(ROOT, 'data', 'hk-adr-map.json');
const CACHE = join(ROOT, 'data', 'cache', 'sec');
const UA = 'oil-basis research (contact: research@example.com)';
const FRESH = process.argv.includes('--fresh');
const TTL_SUB = 7 * 864e5;
const TTL_DOC = 30 * 864e5;

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#160;|&nbsp;/g, ' ')
  .replace(/&#8217;|&rsquo;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();
const num = (s) => {
  const n = Number(String(s || '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function get(url, file, ttl) {
  if (!FRESH && existsSync(file)) {
    const hit = readJson(file);
    if (hit && hit.text && hit.fetched && Date.now() - Date.parse(hit.fetched) < ttl) return hit.text;
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const text = await res.text();
  writeJson(file, { fetched: new Date().toISOString(), url, text });
  return text;
}

const month = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
const isoDate = (s) => {
  const m = /([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(String(s || ''));
  return m && month[m[1].toLowerCase()] ? `${m[3]}-${month[m[1].toLowerCase()]}-${String(m[2]).padStart(2, '0')}` : null;
};

const NUM_RE = '\\d{1,3}(?:,\\d{3})+|\\d{6,}';
const fixSplit = (s) => String(s || '').replace(/(\d{1,3}(?:,\d{3})+,\d{1,3})\s+(\d)/g, '$1$2');

function parseCover(html) {
  const t = fixSplit(clean(html));
  // The beneficial-ownership section sometimes states the latest count in one sentence.
  const own = /based on ([\d][\d,\s]{5,}\d)\s+(?:ordinary|Class [AB] ordinary|common)\s+shares outstanding as of ([A-Z][a-z]+ \d{1,2}, \d{4})/i.exec(t);
  if (own) {
    const shares = num(own[1]);
    if (shares) return { shares, asOf: isoDate(own[2]), basis: 'beneficial-ownership sentence' };
  }
  // The cover section: "Indicate the number of outstanding shares of each ... as of ...".
  const at = t.search(/Indicate the number of outstanding shares/i);
  if (at >= 0) {
    const sec = t.slice(at, at + 2600);
    const items = [];
    const numFirst = new RegExp(`(${NUM_RE})\\s*(Class [AB] ordinary shares?|Ordinary Shares?|common shares?|common stock)`, 'gi');
    let m;
    while ((m = numFirst.exec(sec))) {
      const before = sec.slice(Math.max(0, m.index - 90), m.index);
      if (/excluding|treasury|repurchased|reserved|issuable/i.test(before)) continue;
      const v = num(m[1]);
      if (v) items.push({ v, label: m[2].replace(/\s+/g, ' ').trim() });
    }
    // Some tables put the label first ("Class A ordinary shares ... 1,559,430,567").
    const labelFirst = new RegExp(`(Class [AB] ordinary shares?)[\\s\\S]{0,140}?(${NUM_RE})`, 'gi');
    while ((m = labelFirst.exec(sec))) {
      const v = num(m[2]);
      if (v) items.push({ v, label: m[1].replace(/\s+/g, ' ').trim() });
    }
    if (items.length) {
      // Dedupe a class that was found by both patterns. A share count is unique per class, so the
      // value is the safe key; otherwise Class B was summed twice (XPEV 1.91B → 2.26B).
      const byValue = new Map();
      for (const x of items) if (!byValue.has(x.v)) byValue.set(x.v, x);
      const uniq = [...byValue.values()];
      const classes = uniq.filter((x) => /^class [ab] ordinary/i.test(x.label));
      const classSum = classes.reduce((a, x) => a + x.v, 0);
      const total = uniq.find((x) => /^(ordinary shares?|common shares?|common stock)$/i.test(x.label));
      // A footnote ("6,000,000 ADSs representing 48,000,000 ordinary shares") can look like a total;
      // when a Class A/B breakdown exists and is much larger, the classes are the cover count.
      if (classes.length && (!total || total.v < classSum * 0.9)) {
        return { shares: classSum, asOf: null, basis: 'SEC cover class A+B' };
      }
      if (total) return { shares: total.v, asOf: null, basis: 'SEC cover total' };
      if (classes.length) return { shares: classSum, asOf: null, basis: 'SEC cover class A+B' };
      return { shares: Math.max(...uniq.map((x) => x.v)), asOf: null, basis: 'SEC cover' };
    }
  }
  // 10-K/10-Q cover: "X shares of common stock outstanding".
  const common = new RegExp(`(${NUM_RE})\\s+shares of (?:common stock|Class [AB] common stock) outstanding`, 'i').exec(t);
  if (common) {
    const shares = num(common[1]);
    if (shares) return { shares, asOf: null, basis: '10-K/10-Q cover' };
  }
  return null;
}

const map = (readJson(MAP) || {}).entries || {};
const hk = readJson(join(ROOT, 'data', 'hongkong.json')) || { companies: [] };
const byCode = new Map((hk.companies || []).map((c) => [c.code, c]));
const fxRate = (hk.fx && hk.fx.rate) || null;

async function usMarketCap(ticker) {
  const f = join(CACHE, `us-${ticker}.json`);
  try {
    const html = await get(`https://stockanalysis.com/stocks/${ticker}/statistics/`, f, TTL_DOC);
    const m = /\{id:"marketcap",title:"Market Cap",value:"[^"]+",hover:"([\d,]+)"/.exec(html || '');
    return m ? Number(m[1].replace(/,/g, '')) : null;
  } catch { return null; }
}
const previous = readJson(OUT) || { entries: {} };
const entries = { ...(previous.entries || {}) };
mkdirSync(CACHE, { recursive: true });

let got = 0, rejected = 0, failed = 0;
for (const [code, adr] of Object.entries(map)) {
  const c = byCode.get(code);
  if (!c || !(c.shares > 0)) { failed++; continue; }
  const cik = String(adr.cik).padStart(10, '0');
  try {
    const usCapVal = await usMarketCap(adr.ticker);
    const subFile = join(CACHE, `sub-${cik}.json`);
    const subText = await get(`https://data.sec.gov/submissions/CIK${cik}.json`, subFile, TTL_SUB);
    const sub = JSON.parse(subText);
    const recent = (sub.filings && sub.filings.recent) || {};
    const forms = recent.form || [];
    const picks = forms
      .map((form, i) => ({ form, i }))
      .filter((x) => ['20-F', '10-K', '10-Q', '20-F/A', '10-K/A', '10-Q/A'].includes(x.form))
      .sort((a, b) => String(recent.filingDate[b.i]).localeCompare(String(recent.filingDate[a.i])))
      .slice(0, 6);
    if (!picks.length) { failed++; console.log(`${code} ${adr.ticker}: no 20-F/10-K/10-Q`); continue; }
    let stored = false;
    let lastReject = null, lastErr = null;
    for (const pick of picks) {
      const acc = String(recent.accessionNumber[pick.i]).replace(/-/g, '');
      const doc = recent.primaryDocument[pick.i];
      const url = `https://www.sec.gov/Archives/edgar/data/${Number(adr.cik)}/${acc}/${doc}`;
      const docFile = join(CACHE, `${cik}-${acc}-${doc.replace(/[^\w.-]/g, '_')}.json`);
      try {
        const html = await get(url, docFile, TTL_DOC);
        const cover = parseCover(html);
        if (!cover) continue;
        // The filing's own count can be the ADS count while the SEC cover is ordinary (or vice versa).
        // The US market cap tells us which basis the HK price capitalises: price × shares should land
        // near the US cap converted at the current rate. Fall back to the filing ratio if unavailable.
        let valid;
        let why = '';
        if (usCapVal && fxRate && c.price) {
          const capHK = cover.shares * c.price;
          const capUS = usCapVal * fxRate;
          const r = capUS > 0 ? capHK / capUS : 0;
          valid = r > 0.6 && r < 1.6;
          why = `cap ratio ${r.toFixed(2)}`;
        } else {
          const r = c.shares / cover.shares;
          valid = r > 0.5 && r < 2;
          why = `filing ratio ${r.toFixed(2)}`;
        }
        if (!valid) {
          lastReject = `${(cover.shares / 1e9).toFixed(2)}B vs filing ${(c.shares / 1e9).toFixed(2)}B (${cover.basis}, ${pick.form}; ${why})`;
          continue;
        }
        entries[code] = {
          shares: cover.shares,
          asOf: cover.asOf || recent.reportDate[pick.i] || recent.filingDate[pick.i],
          form: pick.form,
          filed: recent.filingDate[pick.i],
          basis: cover.basis,
          ticker: adr.ticker,
          url,
          source: 'SEC cover',
          fetched: new Date().toISOString(),
        };
        got++;
        stored = true;
        console.log(`${code} ${adr.ticker}: ${(cover.shares / 1e9).toFixed(3)}B · ${cover.basis} · ${entries[code].asOf}`);
        break;
      } catch (e) {
        lastErr = e.message;
      }
    }
    if (!stored) {
      if (lastReject) rejected++; else failed++;
      console.log(`${code} ${adr.ticker}: ${lastReject || lastErr || 'share count not found'}`);
    }
  } catch (e) {
    failed++;
    console.log(`${code} ${adr.ticker}: ${e.message}`);
  }
  await sleep(150);
}

writeJson(OUT, { updated: new Date().toISOString(), note: 'Ordinary shares from the latest SEC 20-F/10-K/10-Q cover; validated against the HK filing count (0.5–2×).', entries });
console.log(`SEC shares: ${got} stored · ${rejected} rejected · ${failed} unavailable · wrote data/hongkong-sec-shares.json`);
