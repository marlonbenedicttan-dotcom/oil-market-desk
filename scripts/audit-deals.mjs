import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGenericTarget, nameKey } from '../src/deals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'deals-store.json');
const CACHE = join(ROOT, 'data', '.doc-heads');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DRY = process.argv.includes('--dry');
mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

let last = 0;
async function get(url, asText = false) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 170 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.status === 403 || res.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!res.ok) return null;
      return asText ? res.text() : res.json();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

// The document is about this deal if the headline/lead names an acquisition AND the target.
function aboutDeal(head, target) {
  // Real deals do get announced inside earnings releases, so give the document some room: a deal verb
  // in the first 2,500 characters and the target named within 4,000.
  if (!/\b(acquire|acquisition|merger|takeover|to buy|buys)\b/i.test(head.slice(0, 2500))) return false;
  const key = nameKey(target);
  if (!key) return false;
  return head.slice(0, 4000).toLowerCase().includes(key);
}

const store = JSON.parse(readFileSync(STORE, 'utf8'));
const before = store.deals.length;
let kept = 0, dropped = 0, unfetched = 0;
const survivors = [];
const sample = [];

for (const d of store.deals) {
  if (!/\/Archives\/edgar\/data\//.test(d.url || '')) { survivors.push(d); kept++; continue; }
  const acc = (/\/data\/(\d+)\/(\d+)\//.exec(d.url) || [])[2] || String(Math.random());
  const file = join(CACHE, acc + '.txt');
  let head;
  if (existsSync(file)) head = readFileSync(file, 'utf8');
  else {
    const body = await get(d.url, true);
    if (!body) { unfetched++; survivors.push(d); kept++; continue; }   // network hiccup: keep, retry next run
    head = textOf(body).slice(0, 4000);
    try { writeFileSync(file, head); } catch {}
  }
  if (aboutDeal(head, d.target)) { survivors.push(d); kept++; }
  else {
    dropped++;
    if (sample.length < 8) sample.push(`${d.date} ${d.acquirer} → ${d.target} :: ${head.slice(0, 90).replace(/\s+/g, ' ')}`);
  }
}

store.deals = survivors;
store.updated = new Date().toISOString();
const priced = survivors.filter((x) => x.value).length;
console.log(`deals ${before} → ${survivors.length} · kept ${kept} · dropped ${dropped} · unfetched ${unfetched}`);
console.log(`priced ${priced} (${Math.round((priced / survivors.length) * 100)}%)`);
for (const s of sample) console.log('  dropped:', s);

if (!DRY) { writeFileSync(STORE + '.tmp', JSON.stringify(store)); renameSync(STORE + '.tmp', STORE); console.log('written'); }
