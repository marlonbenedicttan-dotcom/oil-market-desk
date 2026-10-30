// Fetch a written business description for every Japanese company.
//
// J-Quants has no description field, and writing 1,500 profiles from memory would be invention. The
// company-profile pages on stockanalysis.com are server-rendered and cover every TSE code, so the
// description is fetched rather than guessed. Curated entries still win where they exist.
//
//   node scripts/fetch-japan-profiles.mjs            all companies without a curated entry
//   node scripts/fetch-japan-profiles.mjs --limit=50 smoke test
//   node scripts/fetch-japan-profiles.mjs --force    refetch everything

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'japan.json');
const DESC = join(ROOT, 'data', 'japan-descriptions.json');
const CACHE = join(ROOT, 'data', 'cache', 'profiles');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const FORCE = process.argv.includes('--force');
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
const curated = new Set(Object.keys(JSON.parse(readFileSync(DESC, 'utf8')).entries || {}));
const todo = jp.companies.filter((c) => FORCE || !curated.has(c.code));
const list = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`${list.length} companies to fetch (${curated.size} already curated)`);

let ok = 0, miss = 0, fail = 0;
const profiles = new Map();
for (let i = 0; i < list.length; i++) {
  const c = list[i];
  const short = String(c.code).slice(0, 4);
  const f = join(CACHE, `${short}.json`);
  let text = null;
  if (!FORCE && existsSync(f)) {
    try { text = JSON.parse(readFileSync(f, 'utf8')).text; } catch { /* refetch */ }
  }
  if (!text) {
    try {
      const res = await fetch(`https://stockanalysis.com/quote/tyo/${short}/company/`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
      if (res.status === 429) { await sleep(8000); i--; continue; }
      if (res.ok) {
        text = extract(await res.text());
        if (text) writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), code: short, text }));
      }
    } catch { /* counted below */ }
    await sleep(450);
  }
  if (text) { profiles.set(c.code, shorten(text)); ok++; } else if (existsSync(f)) { miss++; } else { fail++; }
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${list.length} · ${ok} found · ${fail} failed`);
}

// Merge: curated > fetched profile > generated line (left to the other script).
for (const c of jp.companies) {
  const text = profiles.get(c.code);
  if (!text || curated.has(c.code)) continue;
  c.description = text;
  c.brands = [];
  c.descSource = 'profile';
  c.descSourceName = 'stockanalysis.com';
  c.descReviewed = new Date().toISOString().slice(0, 10);
}
// Keep a committed copy too: the cache is gitignored and would vanish in CI.
const store = {};
for (const c of jp.companies) {
  const t = profiles.get(c.code);
  if (t) store[String(c.code).slice(0, 4)] = t;
}
writeFileSync(join(ROOT, 'data', 'japan-profiles.json'), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), note: 'Fetched company profiles from stockanalysis.com, keyed by 4-digit TSE code.', profiles: store }));
writeFileSync(FILE + '.tmp', JSON.stringify(jp));
renameSync(FILE + '.tmp', FILE);
console.log(`fetched ${ok} · already cached ${miss} · failed ${fail}`);
