// Fetch a written business description for every Japanese company.
//
// J-Quants has no description field, and writing 1,500 profiles from memory would be invention. The
// company-profile pages on stockanalysis.com are server-rendered and cover every TSE code, so the
// description is fetched rather than guessed. Curated entries still win where they exist.
//
//   node scripts/fetch-japan-profiles.mjs            every company without a profile yet
//   node scripts/fetch-japan-profiles.mjs --limit=50 smoke test
//   node scripts/fetch-japan-profiles.mjs --force    refetch everything
//   node scripts/fetch-japan-profiles.mjs --dry-run  print the work list and exit
//
// The store is merged, never replaced: a listed company that already has a fetched profile is skipped,
// so a daily run costs nothing on a normal day and only fetches a newly listed company.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'japan.json');
const DESC = join(ROOT, 'data', 'japan-descriptions.json');
const STORE = join(ROOT, 'data', 'japan-profiles.json');
const CACHE = join(ROOT, 'data', 'cache', 'profiles');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');
const short = (code) => String(code).slice(0, 4);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page puts the profile in consecutive <p> tags inside one container.
function extract(html) {
  const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
  if (!box) return null;
  const paras = [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' '));
  if (!paras.length) return null;
  const text = paras.join(' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return text.length > 60 ? text : null;
}

// Two sentences is a card, not an article. Cut at a sentence boundary so it never ends mid-clause.
function shorten(text, max = 300) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return i > 80 ? cut.slice(0, i + 1) : `${cut.replace(/[,;\s]+\S*$/, '')}…`;
}

const jp = JSON.parse(readFileSync(FILE, 'utf8'));
// Curated descriptions are keyed by the 5-digit TSE code ("13320"); the fetched store is keyed by the
// 4-digit code ("1301"). Both mean "already covered" — without the second set every run re-fetched
// ~1,000 companies that already had a profile.
const curated = new Set(Object.keys(JSON.parse(readFileSync(DESC, 'utf8')).entries || {}));
let prev = {};
try { prev = JSON.parse(readFileSync(STORE, 'utf8')).profiles || {}; } catch { /* first run */ }
const covered = (code) => curated.has(code) || Object.prototype.hasOwnProperty.call(prev, short(code));
const todo = jp.companies.filter((c) => FORCE || !covered(c.code));
const list = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`${list.length} companies to fetch (${curated.size} curated · ${Object.keys(prev).length} profiled · ${jp.companies.length} listed)`);
if (DRY) {
  for (const c of list.slice(0, 20)) console.log(`  ${c.code} ${c.name || ''}`);
  if (list.length > 20) console.log(`  … ${list.length - 20} more`);
  process.exit(0);
}
// A no-op run must not rewrite the data files, or every workflow run produces a diff.
if (!list.length) { console.log('nothing new — no file written'); process.exit(0); }

let ok = 0, miss = 0, fail = 0;
// Merged, not replaced: the store is the durable copy (the cache is gitignored and empty in CI).
const profiles = new Map(Object.entries(prev));
for (let i = 0; i < list.length; i++) {
  const c = list[i];
  const f = join(CACHE, `${short(c.code)}.json`);
  let text = null;
  if (!FORCE && existsSync(f)) {
    try { text = JSON.parse(readFileSync(f, 'utf8')).text; } catch { /* refetch */ }
  }
  if (!text) {
    try {
      const res = await fetch(`https://stockanalysis.com/quote/tyo/${short(c.code)}/company/`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
      if (res.status === 429) { await sleep(8000); i--; continue; }
      if (res.ok) {
        text = extract(await res.text());
        if (text) writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), code: short(c.code), text }));
      }
    } catch { /* counted below */ }
    await sleep(450);
  }
  if (text) { profiles.set(short(c.code), shorten(text)); ok++; } else if (existsSync(f)) { miss++; } else { fail++; }
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${list.length} · ${ok} found · ${fail} failed`);
}

// Merge: curated > fetched profile > generated line (left to the other script). Only the companies this
// run touched are written back, so a run with one new listing does not rewrite 1,500 descriptions.
for (const c of list) {
  const text = profiles.get(short(c.code));
  if (!text || curated.has(c.code)) continue;
  c.description = text;
  c.brands = [];
  c.descSource = 'profile';
  c.descSourceName = 'stockanalysis.com';
  c.descReviewed = new Date().toISOString().slice(0, 10);
}
// Keep a committed copy too: the cache is gitignored and would vanish in CI.
const store = Object.fromEntries(profiles);
writeFileSync(STORE, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), note: 'Fetched company profiles from stockanalysis.com, keyed by 4-digit TSE code.', profiles: store }));
writeFileSync(FILE + '.tmp', JSON.stringify(jp));
renameSync(`${FILE}.tmp`, FILE);
console.log(`fetched ${ok} · already cached ${miss} · failed ${fail}`);
