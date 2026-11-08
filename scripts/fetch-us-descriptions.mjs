// Fetch a written company profile for every US company, the same way Japan, Korea and India are
// described: stockanalysis.com's server-rendered company page, not the 10-K's legal "Item 1" text and
// not Nasdaq's short marketing blurb.
//
// Precedence on the page is curated → fetched profile → filing/Nasdaq fallback. The fetched text lives
// in a committed store (data/us-profiles.json), so a CI rebuild with no local cache still has profiles.
//
//   node scripts/fetch-us-descriptions.mjs                     every company without a stored profile
//   node scripts/fetch-us-descriptions.mjs --only-missing --limit=25
//   node scripts/fetch-us-descriptions.mjs --force             refetch every page
//   node scripts/fetch-us-descriptions.mjs --dry-run

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const STORE = join(ROOT, 'data', 'us-profiles.json');
const CACHE = join(ROOT, 'data', 'cache', 'us-profiles');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const ONLY_MISSING = process.argv.includes('--only-missing');
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extract = (html) => {
  const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
  if (!box) return null;
  const paras = [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' '));
  const text = paras.join(' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return text.length > 60 ? text : null;
};
const shorten = (t, max = 320) => {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return i > 90 ? cut.slice(0, i + 1) : `${cut.replace(/[,;\s]+\S*$/, '')}\u2026`;
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let store = {};
try { store = JSON.parse(readFileSync(STORE, 'utf8')).profiles || {}; } catch { /* first run */ }

async function one(c) {
  const f = join(CACHE, `${c.ticker}.json`);
  if (!FORCE && existsSync(f)) {
    try { const t = JSON.parse(readFileSync(f, 'utf8')).text; if (t) return t; } catch { /* refetch */ }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://stockanalysis.com/stocks/${encodeURIComponent(c.ticker)}/company/`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20000),
      });
      // stockanalysis throttles hard: back off instead of burning the run on 429s.
      if (res.status === 429) { await sleep(20000 + attempt * 15000); continue; }
      if (!res.ok) return null;
      const text = extract(await res.text());
      if (text) { writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), source: 'stockanalysis.com', text })); return text; }
      return null;
    } catch { await sleep(600 * (attempt + 1)); }
  }
  return null;
}

const queue = data.companies.filter((c) => c.ticker
  && (!onlySet || onlySet.has(String(c.ticker).toUpperCase()))
  && (FORCE || !(ONLY_MISSING && store[c.ticker])));
const list = LIMIT ? queue.slice(0, LIMIT) : queue;
console.log(`${list.length} companies to describe (${Object.keys(store).length} already stored)`);
if (DRY) {
  for (const c of list.slice(0, 25)) console.log(`  ${c.ticker} ${c.name}`);
  if (list.length > 25) console.log(`  … ${list.length - 25} more`);
  process.exit(0);
}
if (!list.length) { console.log('nothing new — no file written'); process.exit(0); }

let ok = 0, fail = 0, at = 0;
const pool = Array.from({ length: 3 }, async () => {
  while (at < list.length) {
    const c = list[at++];
    const text = await one(c);
    if (text) {
      c.description = shorten(text);
      c.descSource = 'profile';
      c.descSourceName = 'stockanalysis.com';
      store[c.ticker] = c.description;
      ok++;
    } else fail++;
    if ((ok + fail) % 50 === 0) console.log(`  ${ok + fail}/${list.length} · ${ok} found`);
    await sleep(140);
  }
});
await Promise.all(pool);

writeFileSync(STORE, JSON.stringify({
  updated: new Date().toISOString().slice(0, 10),
  note: 'Fetched US company profiles from stockanalysis.com, keyed by ticker.',
  profiles: store,
}));
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`profiles: ${ok} fetched · ${fail} without a page · ${Object.keys(store).length} stored`);
