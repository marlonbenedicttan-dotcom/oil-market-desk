// Fetch the English name, description and GICS sector/industry for every B3 company.
//
//   node scripts/fetch-brazil-profiles.mjs            all companies without an entry
//   node scripts/fetch-brazil-profiles.mjs --limit=50 smoke test
//   node scripts/fetch-brazil-profiles.mjs --force    refetch everything

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, BR_CACHE, saProfile } from './b3.mjs';
import { getCached } from './stockanalysis.mjs';
import { extractProfile } from './profile.mjs';

const FILE = join(ROOT, 'data', 'brazil.json');
const OUT = join(ROOT, 'data', 'brazil-profiles.json');
const CACHE = join(BR_CACHE, 'profiles');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const TOP = Number((process.argv.find((x) => x.startsWith('--top=')) || '').split('=')[1] || 0);
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');
const TTL = 30 * 864e5;
mkdirSync(CACHE, { recursive: true });

const br = JSON.parse(readFileSync(FILE, 'utf8'));
const book = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { entries: {} };
book.entries = book.entries || {};
const pool = TOP ? [...br.companies].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, TOP) : br.companies;
const todo = pool.filter((c) => FORCE || !(book.entries[c.code] && book.entries[c.code].desc));
const list = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`${list.length} companies to fetch (${Object.keys(book.entries).length} already have an entry)`);
if (DRY) {
  for (const c of list.slice(0, 20)) console.log(`  ${c.code} ${c.name || ''}`);
  if (list.length > 20) console.log(`  … ${list.length - 20} more`);
  process.exit(0);
}
if (!list.length) { console.log('nothing new — no file written'); process.exit(0); }

let ok = 0, miss = 0, fail = 0;
for (let i = 0; i < list.length; i++) {
  const c = list[i];
  const f = join(CACHE, `${String(c.code).replace(/[^\w-]/g, '_')}.json`);
  let got = null;
  try {
    const html = await getCached(saProfile(c.code), f, { ttlMs: FORCE ? 0 : TTL, fresh: FORCE, timeout: 25000, retries: 3 });
    if (html) got = extractProfile(html);
  } catch (e) {
    fail++;
    if (e && e.throttled) await new Promise((r) => setTimeout(r, 60000));
    continue;
  }
  if (got) {
    book.entries[c.code] = { ...got, fetched: new Date().toISOString(), source: 'stockanalysis.com' };
    ok++;
  } else { miss++; }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${list.length}`);
  await new Promise((r) => setTimeout(r, 220));
}

book.updated = new Date().toISOString();
writeFileSync(`${OUT}.tmp`, JSON.stringify(book, null, 0));
renameSync(`${OUT}.tmp`, OUT);
console.log(`fetched ${ok} · ${miss} without a page · ${fail} throttled/error`);
