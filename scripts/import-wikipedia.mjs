// Import acquisitions from Wikipedia's per-company "List of mergers and acquisitions by X" pages.
//
// These tables are community-maintained, cited to press releases, and cover the modern period —
// Microsoft alone has 281 rows with a Value (USD) column. Licence is CC BY-SA, so the source is
// recorded on every row and linked in the UI.
//
//   node scripts/import-wikipedia.mjs --dry
//   node scripts/import-wikipedia.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEvent, dealSector } from '../src/deals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_FILE = join(ROOT, 'data', 'deals-store.json');
const UA = 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DRY = process.argv.includes('--dry');
const MAX = Number((process.argv.find((x) => x.startsWith('--max=')) || '--max=999').split('=')[1]);

// Titles taken from Wikipedia's own search for "List of mergers and acquisitions by", plus the
// "List of acquisitions by X" variants the search returns.
const PAGES = [
  'List of mergers and acquisitions by Microsoft', 'List of mergers and acquisitions by Alphabet',
  'List of mergers and acquisitions by Amazon', 'List of mergers and acquisitions by Meta Platforms',
  'List of mergers and acquisitions by Apple', 'List of mergers and acquisitions by Intel',
  'List of mergers and acquisitions by IBM', 'List of mergers and acquisitions by Yahoo',
  'List of mergers and acquisitions by Twitter, Inc.', 'List of mergers and acquisitions by Gen Digital',
  'List of mergers and acquisitions by BlackBerry', 'List of mergers and acquisitions by Embracer Group',
  'List of mergers and acquisitions by GoDaddy', 'List of mergers and acquisitions by Citrix',
  'List of mergers and acquisitions by SAP', 'List of mergers and acquisitions by Computer Associates',
  'List of acquisitions by Disney', 'List of acquisitions by Adobe', 'List of Dell ownership activities',
  'List of mergers and acquisitions by Microsoft', 'List of mergers and acquisitions by Cisco',
  'List of mergers and acquisitions by Oracle', 'List of mergers and acquisitions by Salesforce',
  'List of mergers and acquisitions by Nvidia', 'List of mergers and acquisitions by Broadcom',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || '')
  .replace(/<sup[\s\S]*?<\/sup>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#160;/g, ' ')
  .replace(/\[\s*\d+\s*\]/g, ' ')
  .replace(/\s+/g, ' ').trim();

// "$1,500,000" -> 1.5 ($m); "$68.7 billion" -> 68700; "—" -> null
function money(s) {
  const t = strip(s);
  if (!t || /^[—–-]+$/.test(t) || /undisclosed|unknown|n\/a/i.test(t)) return null;
  const m = /\$?\s?([\d,.]+)\s*(billion|million|bn|mm|b|m)?\b/i.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  let usdM;
  if (unit.startsWith('b')) usdM = n * 1000;
  else if (unit.startsWith('m')) usdM = n;
  else usdM = n / 1e6;                 // raw dollars
  return usdM >= 1 ? Math.round(usdM) : null;
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
function isoDate(s) {
  const t = strip(s);
  let m = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(t);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /([A-Za-z]+)\s+(\d{4})/.exec(t);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-01`;
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[0];
  m = /(\d{4})/.exec(t);
  if (m) return `${m[1]}-01-01`;
  return null;
}

async function pageHtml(title) {
  const page = /^List of/i.test(title) ? title : `List of mergers and acquisitions by ${title}`;
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page.replace(/ /g, '_'))}&prop=text&format=json&formatversion=2&redirects=1`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.parse?.text || null;
}

const store = (() => { try { const j = JSON.parse(readFileSync(STORE_FILE, 'utf8')); return Array.isArray(j.deals) ? j : { deals: [] }; } catch { return { deals: [] }; } })();
const before = store.deals.length;
let pages = 0, rows = 0, added = 0, priced = 0;

for (const title of PAGES.slice(0, MAX)) {
  const pageTitle = /^List of/i.test(title) ? title : `List of mergers and acquisitions by ${title}`;
  const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`;
  const html = await pageHtml(title);
  if (!html) { console.log(`— ${title}: no page`); await sleep(300); continue; }
  pages++;
  const acquirer = title.replace(/_/g, ' ').replace(/\s*\(.*\)$/, '')
    .replace(/^List of (?:mergers and )?acquisitions by\s+/i, '')
    .replace(/^List of .*? by\s+/i, '');
  const tables = [...html.matchAll(/<table[^>]*wikitable[\s\S]*?<\/table>/g)].map((m) => m[0]);
  let best = null;
  for (const t of tables) {
    const head = (/<tr[\s\S]*?<\/tr>/.exec(t) || [''])[0];
    const cells = [...head.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => strip(m[1]).toLowerCase());
    const hasCompany = cells.some((c) => c.includes('company') || c.includes('target') || c.includes('acquired'));
    const hasValue = cells.some((c) => c.includes('value') || c.includes('price') || c.includes('amount'));
    if (hasCompany && hasValue) {
      const n = (t.match(/<tr/g) || []).length;
      if (!best || n > best.n) best = { t, cells, n };
    }
  }
  if (!best) { console.log(`— ${title}: no acquisition table`); await sleep(300); continue; }
  const idxCompany = best.cells.findIndex((c) => c.includes('company') || c.includes('target') || c.includes('acquired'));
  const idxDate = best.cells.findIndex((c) => c.includes('date') || c.includes('year'));
  const idxValue = best.cells.findIndex((c) => c.includes('value') || c.includes('price') || c.includes('amount'));
  const trs = [...best.t.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => m[0]).slice(1);
  for (const tr of trs) {
    const cells = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => strip(m[1]));
    if (cells.length <= Math.max(idxCompany, idxDate, idxValue)) continue;
    const target = cells[idxCompany];
    const date = isoDate(cells[idxDate]);
    if (!target || !date || /^total$/i.test(target)) continue;
    rows++;
    const value = money(cells[idxValue]);
    const ev = {
      date, status: date < new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10) ? 'closed' : 'announced',
      title: `${acquirer} to acquire ${target}`, source: 'Wikipedia',
      url: pageUrl,
      acquirer, target, value, sector: dealSector(`${acquirer} ${target}`),
      ...(value ? { valueSource: 'wikipedia', valueBasis: 'Wikipedia deal table' } : {}),
    };
    if (mergeEvent(store, ev)) { added++; if (value) priced++; if (DRY && value && value >= 1000) console.log(`  + ${date} ${acquirer} → ${target} $${(value / 1000).toFixed(1)}B`); }
  }
  console.log(`${title}: ${trs.length} rows · book ${store.deals.length}`);
  await sleep(300);
}

store.deals.sort((a, b) => ((a.lastSeen || a.date) < (b.lastSeen || b.date) ? 1 : -1));
store.updated = new Date().toISOString();
if (!DRY) { writeFileSync(STORE_FILE + '.tmp', JSON.stringify(store)); renameSync(STORE_FILE + '.tmp', STORE_FILE); }
console.log(`\n${pages} pages · ${rows} rows read · ${added} deals added (${priced} priced) · ${before} → ${store.deals.length}`);
