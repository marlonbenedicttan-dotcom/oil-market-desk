// Backfill US deals from SEC EDGAR full-text search, month by month.
//
// EDGAR gives reliable IDENTITY (filer, date, filing link) and unreliable ECONOMICS (values live in
// prose). So this script only asserts what the filing says: who filed, who they said they were buying,
// and the date. A value is recorded only when the filing states it in an unambiguous phrase; otherwise
// the deal is stored with no value rather than a guess.
//
//   node scripts/backfill-edgar.mjs --from=2024-01 --to=2024-03 --dry
//   node scripts/backfill-edgar.mjs --from=2024-01
//
// SEC asks for a descriptive User-Agent with contact details (SEC_UA to override) and ~10 req/s max;
// this walks at ~6/s and caches nothing, because every filing is visited once.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEvent, dealSector } from '../src/deals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_FILE = join(ROOT, 'data', 'deals-store.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const FROM = arg('from', '2024-01');
const TO = arg('to', new Date().toISOString().slice(0, 7));
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
let last = 0;
async function get(url, json = false) {
  for (let i = 0; i < 4; i++) {
    const wait = Math.max(0, 165 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.status === 403 || res.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) return null;
      return json ? res.json() : res.text();
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

const textOf = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[,.;:]+$/, '')
  .replace(/\s*\((?:the\s+)?["“]?(?:company|parent|buyer|seller)["”]?\)$/i, '').trim().slice(0, 60);

// "entered into an Agreement and Plan of Merger … with X" / "acquired X" — conservative on purpose.
function targetFrom(text) {
  const t = text.replace(/\n/g, ' ');
  const pats = [
    /Agreement and Plan of Merger[^.]{0,160}?\bwith\s+([A-Z][\w&'’.,\- ]{2,60}?)(?=\s*[,.;(]|\s+(?:and|pursuant|whereby|for|through|via|in exchange)\b)/,
    /(?:acquired|acquire)\s+(?:all of the outstanding[^.]{0,60}?of\s+)?([A-Z][\w&'’.,\- ]{2,60}?)(?=\s*[,.;(]|\s+(?:for|in|pursuant|through|via)\b)/,
    /acquisition of\s+([A-Z][\w&'’.,\- ]{2,60}?)(?=\s*[,.;(]|\s+(?:for|by|from|through|via)\b)/,
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (m) {
      const name = cleanName(m[1]);
      if (name && name.split(' ').length <= 6
        && !/^(the|this|such|its|their|equity interests|shares|all)\b/i.test(name)
        && !/\b(through|via|pursuant|exchange)\b/i.test(name)) return name;
    }
  }
  return null;
}

function valueFrom(text) {
  const t = text.replace(/\n/g, ' ');
  const re = /(?:purchase price|aggregate consideration|merger consideration|transaction value|valued at)[^.$]{0,60}\$\s?([\d.,]+)\s?(billion|million|bn|mm)\b/gi;
  const m = re.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const usdM = /^b/i.test(m[2]) ? n * 1000 : n;
  return usdM >= 250 && usdM <= 300000 ? Math.round(usdM) : null;
}

const store = (() => { try { const j = JSON.parse(readFileSync(STORE_FILE, 'utf8')); return Array.isArray(j.deals) ? j : { deals: [] }; } catch { return { deals: [] }; } })();
const before = store.deals.length;
let filings = 0, added = 0;

async function month(y, m) {
  const start = `${y}-${pad(m)}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const url = 'https://efts.sec.gov/LATEST/search-index?q=' + encodeURIComponent('"has agreed to acquire"')
    + `&forms=8-K&dateRange=custom&startdt=${start}&enddt=${end}`;
  const j = await get(url, true);
  const hits = j?.hits?.hits || [];
  process.stdout.write(`${y}-${pad(m)}: ${hits.length} filings → `);
  for (const h of hits) {
    const acc = String(h._id || '').split(':')[0];
    const doc = String(h._id || '').split(':')[1];
    const cik = Number((h._source.ciks || [])[0] || 0);
    const date = h._source.file_date;
    const filer = cleanName(String((h._source.display_names || [''])[0]).replace(/\s*\(.*$/, ''));
    if (!acc || !cik || !doc || !date) continue;
    filings++;
    const body = await get(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${doc}`);
    if (!body) continue;
    const text = textOf(body);
    const target = targetFrom(text);
    if (!target) continue;
    // Reject the filing company "acquiring" itself, and generic objects that are not companies.
    const keyOf = (v) => { const t = String(v || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4); return t.sort((x, y) => y.length - x.length)[0] || ''; };
    if (keyOf(target) === keyOf(filer)) continue;
    if (/^(fixed shares|shares|equity|interests|common stock|membership interests|assets|business)\b/i.test(target)) continue;
    const value = valueFrom(text);
    const ev = {
      date, status: 'announced', title: `${filer} to acquire ${target}`, source: 'SEC 8-K',
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${doc}`,
      acquirer: filer, target, value, sector: dealSector(`${filer} ${target} ${text.slice(0, 400)}`),
    };
    if (mergeEvent(store, ev)) { added++; if (DRY) console.log(`  + ${date} ${filer} → ${target} ${value ? '$' + value + 'm' : ''}`); }
  }
  console.log(`${store.deals.length} deals`);
}

const [fy, fm] = FROM.split('-').map(Number);
const [ty, tm] = TO.split('-').map(Number);
for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (m = 1, y++) : m++) {
  await month(y, m);
  await sleep(500);
}

store.deals.sort((a, b) => ((a.lastSeen || a.date) < (b.lastSeen || b.date) ? 1 : -1));
store.updated = new Date().toISOString();
if (!DRY) writeFileSync(STORE_FILE, JSON.stringify(store));
console.log(`\n${filings} filings read · ${added} deals added · ${before} → ${store.deals.length}`);
