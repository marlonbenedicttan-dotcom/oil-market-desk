// Fetch an English name and a written business description for every Taiwan company.
//
// The same source and extractor the Japan and Korea profile fetchers use: stockanalysis.com's
// server-rendered company pages. The page title gives the English display name; the profile
// paragraphs give the description. Curated entries in data/taiwan-profiles.json win over a fetch.
//
//   node scripts/fetch-taiwan-profiles.mjs            all companies without an entry
//   node scripts/fetch-taiwan-profiles.mjs --limit=50 smoke test
//   node scripts/fetch-taiwan-profiles.mjs --force    refetch everything

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBrands } from '../src/brand-extract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'taiwan.json');
const OUT = join(ROOT, 'data', 'taiwan-profiles.json');
const CACHE = join(ROOT, 'data', 'cache', 'taiwan-profiles');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const FORCE = process.argv.includes('--force');
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extract(html) {
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '';
  const name = title.replace(/\s*\(TPE:[^)]*\).*$/i, '').replace(/\s*Company Profile.*$/i, '').trim();
  const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
  const paras = box ? [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ')) : [];
  const text = paras.join(' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  if (!name || text.length < 60) return null;
  const first = (text.match(/^.*?[.。](?=\s|$)/) || [text])[0];
  const brandInfo = extractBrands(text);
  return { name, legal: first.length > 140 ? first.slice(0, 137) + '…' : first, desc: shorten(text), brands: brandInfo.brands, brandQuote: brandInfo.quote };
}
function shorten(t, max = 300) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return i > 80 ? cut.slice(0, i + 1) : `${cut.replace(/[,;\s]+\S*$/, '')}…`;
}

const tw = JSON.parse(readFileSync(FILE, 'utf8'));
const book = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { entries: {} };
book.entries = book.entries || {};
const todo = tw.companies.filter((c) => FORCE || !(book.entries[c.code] && book.entries[c.code].desc));
const list = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`${list.length} companies to fetch (${Object.keys(book.entries).length} already have an entry)`);

let ok = 0, miss = 0, fail = 0;
for (let i = 0; i < list.length; i++) {
  const c = list[i];
  const f = join(CACHE, `${c.code}.json`);
  let got = null;
  if (!FORCE && existsSync(f)) { try { got = JSON.parse(readFileSync(f, 'utf8')); } catch { /* refetch */ } }
  if (!got) {
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        const res = await fetch(`https://stockanalysis.com/quote/tpe/${c.code}/company/`, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 429) { await sleep(4000 * (attempt + 1)); continue; }
        if (!res.ok) break;
        got = extract(await res.text());
      } catch { await sleep(700); }
    }
  }
  if (got) {
    book.entries[c.code] = { ...got, fetched: new Date().toISOString(), source: 'stockanalysis.com' };
    writeFileSync(f, JSON.stringify(book.entries[c.code]));
    ok++;
  } else if (c.abbr) { miss++; } else { fail++; }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${list.length}`);
  await sleep(220);
}

book.updated = new Date().toISOString();
writeFileSync(`${OUT}.tmp`, JSON.stringify(book, null, 0));
renameSync(`${OUT}.tmp`, OUT);
console.log(`fetched ${ok} · ${miss} without a page (English abbreviation kept) · ${fail} with neither`);
