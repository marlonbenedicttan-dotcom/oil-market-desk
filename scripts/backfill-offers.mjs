// Build a priced deal book from tender offers (SC TO-T) instead of 8-Ks.
//
// An 8-K acquisition often states no price. A tender offer states one by law: the bidder must put the
// offer per share on the cover page. That is the difference between a book that is 16% priced and one
// that is mostly priced.
//
//   node scripts/backfill-offers.mjs --from=2024-01 --to=2026-10 --dry --max=20
//
// For each SC TO-T: acquirer = the filer (the bidder files the tender offer), target = the "Subject
// Company" on the cover page, price = "$X per share". Equity value = price × shares outstanding (XBRL),
// the same method validated against five known deals.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEvent, dealSector } from '../src/deals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_FILE = join(ROOT, 'data', 'deals-store.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const FROM = arg('from', '2024-01');
const TO = arg('to', new Date().toISOString().slice(0, 7));
const MAX = Number(arg('max', 99999));
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
let last = 0;
async function get(url, json = false) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 170 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.status === 403 || res.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!res.ok) return null;
      return json ? res.json() : res.text();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}
const textOf = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|tr|h\d|li|td|th)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[,.;:]+$/, '').trim().slice(0, 70);

// Cover page: "Subject Company: Theseus Pharmaceuticals, Inc." (Commission File No…)
function subjectOf(text) {
  // The cover page puts the issuer's name on the line ABOVE "(Name of Subject Company (Issuer))".
  const lines = text.slice(0, 12000).split('\n').map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => /\(Name of Subject Company/i.test(l));
  if (i > 0) {
    const above = clean(lines[i - 1].replace(/\(.*$/, ''));
    if (above && above.length >= 3) return above;
  }
  const m = /Subject Compan(?:y|ies)\s*[:\-]?\s*([A-Z][A-Za-z0-9&'’.,\- ]{2,70}?)(?=\s*(?:\(|,?\s*(?:Commission|File|CUSIP|Address|Telephone))|[.;]|$)/.exec(text.slice(0, 9000));
  return m ? clean(m[1]) : null;
}
// The filer of an SC TO-T is often a merger subsidiary; the real acquirer is the parent named on the
// cover page. Take the name above "(Parent of Offeror)" — falling back to the co-offeror.
function bidderOf(text) {
  // Flat match: the cover page is a table, so "NAME (Name of Filing Persons (Parent of Offeror))" can
  // land on one line no matter how the cells break.
  const flat = text.slice(0, 12000).replace(/\s+/g, ' ');
  const m = /([A-Z][A-Z0-9 &'’.,\-]{2,60}?)\s*\(Name of Filing Persons \(Parent of Offeror\)\)/i.exec(flat)
    || /([A-Z][A-Z0-9 &'’.,\-]{2,60}?)\s*\(Name of Filing Persons \(Co-Offeror 1\)\)/i.exec(flat);
  return m ? clean(m[1]) : null;
}
function priceOf(text) {
  const t = text.slice(0, 20000);
  const re = /\$\s?([\d,]+(?:\.\d+)?)\s*(?:in cash\s*)?per share/gi;
  let m;
  while ((m = re.exec(t))) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (n < 0.5 || n > 5000) continue;
    // "$0.0001 per share" is the par value on the cover, never the offer.
    if (/par value|par\s+\$/i.test(t.slice(Math.max(0, m.index - 60), m.index))) continue;
    return n;
  }
  return null;
}
const norm = (s) => String(s || '').toLowerCase().replace(/\b(inc|corp|corporation|company|co|ltd|limited|plc|llc|holdings?|group|the)\b/g, '').replace(/[^a-z0-9]/g, '');

function sharesAt(concept, isoDate) {
  const u = (concept && concept.units) || {};
  const rows = Array.isArray(u.shares) ? u.shares : [];
  if (!rows.length) return null;
  const target = Date.parse(isoDate);
  let best = null;
  for (const r of rows) {
    const d = Date.parse(r.end || '');
    if (!Number.isFinite(d) || d > target + 5 * 864e5) continue;
    if (!best || d > best.d) best = { d, v: r.val };
  }
  return best ? best.v : null;
}

let TICKERS = null;
async function cikFor(name) {
  if (!TICKERS) {
    const j = await get('https://www.sec.gov/files/company_tickers.json', true);
    TICKERS = Object.values(j || {}).map((r) => ({ cik: String(r.cik_str), name: r.title }));
  }
  const want = norm(name);
  if (!want) return null;
  const exact = TICKERS.find((r) => norm(r.name) === want);
  if (exact) return exact.cik;
  const starts = TICKERS.find((r) => norm(r.name).startsWith(want) && want.length >= 6);
  return starts ? starts.cik : null;
}

const store = (() => { try { const j = JSON.parse(readFileSync(STORE_FILE, 'utf8')); return Array.isArray(j.deals) ? j : { deals: [] }; } catch { return { deals: [] }; } })();
const before = store.deals.length;
let fetched = 0, added = 0;

async function month(y, m) {
  const start = `${y}-${pad(m)}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const url = 'https://efts.sec.gov/LATEST/search-index?q=' + encodeURIComponent('"Subject Company" "per share"')
    + `&forms=SC+TO-T&dateRange=custom&startdt=${start}&enddt=${end}`;
  const j = await get(url, true);
  const hits = j?.hits?.hits || [];
  process.stdout.write(`${y}-${pad(m)}: ${hits.length} offers → `);
  const seen = new Set();
  for (const h of hits) {
    if (fetched >= MAX) break;
    const s = h._source || {};
    const [acc, doc] = String(h._id || '').split(':');
    const cik = Number((s.ciks || [])[0] || 0);
    const date = s.file_date;
    if (!acc || !cik || !doc || !date) continue;
    const filer = clean(String((s.display_names || [''])[0]).replace(/\s*\(.*$/, ''));
    fetched++;
    const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}`;
    // The search hit is often an exhibit (the offer to purchase), not the cover page. The cover page is
    // the "sctot" document — that is where Subject Company and the price live.
    const idx = await get(`${base}/index.json`, true);
    const items = idx?.directory?.item || [];
    const main = items.find((f) => /sctot|sctota|sc?to-?t|tender/i.test(f.name || ''))
      || items.find((f) => /\.htm$/i.test(f.name || '') && !/^ex|_ex/i.test(f.name || ''));
    const text = textOf(await get(`${base}/${main ? main.name : doc}`));
    if (!text) continue;
    const target = subjectOf(text);
    const price = priceOf(text);
    if (process.env.DBG) console.log(`\n  DBG ${date} | ${filer} | target=${JSON.stringify(target)} | price=${price} | head=${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    if (!target || !price) continue;
    if (seen.has(norm(target))) continue;
    seen.add(norm(target));
    const tCik = await cikFor(target);
    let shares = null;
    if (tCik) {
      const concept = await get(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(tCik).padStart(10, '0')}/dei/EntityCommonStockSharesOutstanding.json`, true);
      shares = sharesAt(concept, date);
    }
    const raw = shares ? (price * shares) / 1e6 : null;
    const mag = raw ? Math.pow(10, Math.max(0, Math.floor(Math.log10(raw)) - 1)) : 1;
    const value = raw ? Math.round(raw / mag) * mag : null;
    const bidder = bidderOf(text) || filer;
    const ev = {
      date, status: 'announced', title: `${bidder} to acquire ${target} — $${price}/share tender offer`,
      source: 'SEC SC TO-T', url: `${base}/${doc}`,
      acquirer: bidder || null, target, value,
      ...(value ? { valueSource: 'computed', valueBasis: `$${price}/share × ${(shares / 1e6).toFixed(1)}m shares` } : {}),
      sector: dealSector(`${bidder} ${target}`),
    };
    if (mergeEvent(store, ev)) { added++; if (DRY) console.log(`  + ${date} ${bidder} → ${target} $${price}/sh ${value ? '$' + value + 'm' : ''}`); }
  }
  console.log(`${store.deals.length} deals`);
  if (!DRY) { writeFileSync(STORE_FILE + '.tmp', JSON.stringify(store)); renameSync(STORE_FILE + '.tmp', STORE_FILE); }
}

const [fy, fm] = FROM.split('-').map(Number);
const [ty, tm] = TO.split('-').map(Number);
for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (m = 1, y++) : m++) {
  await month(y, m);
  await sleep(400);
}

store.deals.sort((a, b) => ((a.lastSeen || a.date) < (b.lastSeen || b.date) ? 1 : -1));
store.updated = new Date().toISOString();
if (!DRY) { writeFileSync(STORE_FILE + '.tmp', JSON.stringify(store)); renameSync(STORE_FILE + '.tmp', STORE_FILE); }
console.log(`\noffers read ${fetched} · added ${added} · ${before} → ${store.deals.length} · priced ${store.deals.filter((x) => x.value).length}`);
