// Backfill the deal store from GDELT's news archive.
//
// Google News' RSS ignores date ranges, so nothing older than a few days can ever enter the store.
// GDELT does keep an archive and answers by date window, which is what makes a real book possible.
//
//   node scripts/backfill-deals.mjs --from=2025-09 --to=2025-11 --dry
//   node scripts/backfill-deals.mjs --from=2024-01
//
// GDELT allows one request every ~5s; the walker waits 6s between calls and splits a month into weeks
// when it hits the 250-record cap, so nothing is silently truncated.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDealTitle, eventStatus, dealSector, mergeEvent, validName } from '../src/deals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_FILE = join(ROOT, 'data', 'deals-store.json');
const PROGRESS_FILE = join(ROOT, 'data', '.gdelt-progress.json');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const FROM = arg('from', '2024-01');
const TO = arg('to', new Date().toISOString().slice(0, 7));
const DRY = process.argv.includes('--dry');
const MAXREC = 250;

// GDELT only accepts parentheses around OR'd terms, and one group per query — "(a OR b) (c)" is rejected.
const QUERY = '(acquisition OR merger OR takeover) billion';
const OK_DOMAIN = /(^|\.)(reuters\.com|bloomberg\.com|ft\.com|wsj\.com|cnbc\.com|apnews\.com|barrons\.com|marketwatch\.com|nytimes\.com|forbes\.com|fortune\.com|axios\.com|businessinsider\.com|theguardian\.com|bbc\.co\.uk|bbc\.com|scmp\.com|nikkei\.com|economictimes\.indiatimes\.com|livemint\.com|cnn\.com|foxbusiness\.com|telegraph\.co\.uk|politico\.com|law360\.com|theinformation\.com|semianalysis\.com)$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}000000`;
// GDELT tokenises headlines ("$9 . 7 Billion", "OxyChem ?"), so undo that before parsing.
const cleanTitle = (t) => String(t || '')
  .replace(/\s+([.,:;!?%])/g, '$1').replace(/([$(\[])\s+/g, '$1')
  .replace(/\s+-\s+[^-]{2,30}$/, '')
  .replace(/\s{2,}/g, ' ').trim();

async function gdelt(start, end) {
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
    + `?query=${encodeURIComponent(QUERY)}&mode=artlist&maxrecords=${MAXREC}`
    + `&startdatetime=${stamp(start)}&enddatetime=${stamp(end)}&format=json&sort=date`;
  // GDELT throttles globally and opens windows unpredictably. Wait it out rather than give up:
  // exponential backoff with jitter, up to ~8 minutes per attempt, 10 attempts per window.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 503) {
        const wait = Math.min(480000, 20000 * 2 ** attempt) + Math.floor(Math.random() * 8000);
        console.log(`    429 — waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/10)`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) { await sleep(15000); continue; }
      const j = await res.json();
      return j.articles || [];
    } catch { await sleep(10000); }
  }
  return null;
}

const store = (() => { try { const j = JSON.parse(readFileSync(STORE_FILE, 'utf8')); return Array.isArray(j.deals) ? j : { deals: [] }; } catch { return { deals: [] }; } })();
const progress = (() => { try { return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')); } catch { return { done: [] }; } })();
const save = () => {
  store.deals.sort((a, b) => ((a.lastSeen || a.date) < (b.lastSeen || b.date) ? 1 : -1));
  store.updated = new Date().toISOString();
  if (!DRY) {
    // Write through a temp file so a kill mid-write cannot corrupt the book.
    writeFileSync(STORE_FILE + '.tmp', JSON.stringify(store));
    renameSync(STORE_FILE + '.tmp', STORE_FILE);
    writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
  }
};
const before = store.deals.length;
let added = 0, kept = 0, calls = 0;

async function walk(start, end) {
  const arts = await gdelt(start, end);
  calls++;
  if (!arts) { console.log(`  ! ${start.toISOString().slice(0, 10)} → failed`); return; }
  if (arts.length >= MAXREC) {
    // Hit the cap: split into two halves and recurse, so a busy month is not truncated.
    const mid = new Date((start.getTime() + end.getTime()) / 2);
    if (mid > start && mid < end && (end - start) > 36e5 * 24 * 3) {
      await walk(start, mid); await sleep(6000);
      await walk(mid, end);
      return;
    }
  }
  for (const a of arts) {
    if (!OK_DOMAIN.test(a.domain || '')) continue;
    const title = cleanTitle(a.title);
    if (!title || !/\b(acquire|acquisition|merger|takeover|to buy|buys)\b/i.test(title)) continue;
    const p = parseDealTitle(title);
    if (!p.acquirer && !p.target) continue;
    const date = String(a.seendate || '').slice(0, 4) + '-' + String(a.seendate || '').slice(4, 6) + '-' + String(a.seendate || '').slice(6, 8);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ev = {
      date, status: eventStatus(title), title, source: a.domain, url: a.url,
      acquirer: p.acquirer && validName(p.acquirer) ? p.acquirer : null,
      target: p.target && validName(p.target) ? p.target : null,
      value: p.value || null, sector: dealSector(title),
    };
    if (mergeEvent(store, ev)) { added++; if (DRY) console.log(`  + ${date} ${ev.acquirer || '?'} → ${ev.target || '?'} ${ev.value ? '$' + ev.value + 'm' : ''} [${a.domain}]`); }
    else kept++;
  }
}

const [fy, fm] = FROM.split('-').map(Number);
const [ty, tm] = TO.split('-').map(Number);
for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (m = 1, y++) : m++) {
  const key = `${y}-${pad(m)}`;
  if (progress.done.includes(key)) { continue; }
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  process.stdout.write(`${key} … `);
  await walk(start, end);
  progress.done.push(key);
  save();
  console.log(`${store.deals.length} deals (saved)`);
  await sleep(12000);
}

store.deals.sort((a, b) => ((a.lastSeen || a.date) < (b.lastSeen || b.date) ? 1 : -1));
store.updated = new Date().toISOString();
if (!DRY) writeFileSync(STORE_FILE, JSON.stringify(store));
console.log(`\n${calls} requests · ${added} new deals · ${kept} duplicates · ${before} → ${store.deals.length}`);
