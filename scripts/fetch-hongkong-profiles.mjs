// Fetch an English name, a written business description and the sector/industry for every Hong Kong
// company.
//
// The same source and extractor the Japan, Korea and Taiwan profile fetchers use: stockanalysis.com's
// server-rendered company pages. The page title gives the English display name, the profile
// paragraphs give the description, and the field table gives the sector (GICS) and the industry.
// Curated entries in data/hongkong-profiles.json win over a fetch.
//
//   node scripts/fetch-hongkong-profiles.mjs            all companies without an entry
//   node scripts/fetch-hongkong-profiles.mjs --limit=50 smoke test
//   node scripts/fetch-hongkong-profiles.mjs --force    refetch everything

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, saProfile } from './hkex.mjs';
import { getCached, readJson } from './stockanalysis.mjs';

const FILE = join(ROOT, 'data', 'hongkong.json');
const CROSS = (readJson(join(ROOT, 'data', 'hongkong-crosslist.json')) || { entries: {} }).entries || {};
const profileUrl = (code) => `https://stockanalysis.com/quote/${CROSS[code] ? `${CROSS[code].exchange}/${CROSS[code].code}` : `hkg/${code}`}/company/`;
const OUT = join(ROOT, 'data', 'hongkong-profiles.json');
const CACHE = join(ROOT, 'data', 'cache', 'hongkong-profiles');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const FORCE = process.argv.includes('--force');
const WORKERS = Number((process.argv.find((x) => x.startsWith('--workers=')) || '').split('=')[1] || 1) || 1;
const GAP = Number((process.argv.find((x) => x.startsWith('--gap=')) || '').split('=')[1] || 180) || 0;
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const text = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function field(html, label) {
  const m = new RegExp(`>${label}</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(html);
  return m ? text(m[1]) || null : null;
}

function extract(html) {
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '';
  const name = text(title)
    .replace(/\s*\(HKG:[^)]*\).*$/i, '')
    .replace(/\s*Company Profile.*$/i, '')
    .replace(/\s*Stock Price.*$/i, '')
    .trim();
  const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
  const paras = box ? [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1])) : [];
  const desc = paras.join(' ');
  if (!name || desc.length < 60) return null;
  const first = (desc.match(/^.*?[.。](?=\s|$)/) || [desc])[0];
  return {
    name,
    legal: first.length > 140 ? first.slice(0, 137) + '…' : first,
    desc: shorten(desc),
    sector: field(html, 'Sector'),
    industry: field(html, 'Industry'),
  };
}
function shorten(t, max = 300) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return i > 80 ? cut.slice(0, i + 1) : `${cut.replace(/[,;\s]+\S*$/, '')}…`;
}

const hk = JSON.parse(readFileSync(FILE, 'utf8'));
const book = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { entries: {} };
book.entries = book.entries || {};
const todo = hk.companies.filter((c) => FORCE || !(book.entries[c.code] && book.entries[c.code].desc));
const list = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`${list.length} companies to fetch (${Object.keys(book.entries).length} already have an entry)`);

let ok = 0, miss = 0, faile = 0, throttled = 0, done = 0;
async function one(c) {
  done++;
  const f = join(CACHE, `${c.code}.json`);
  let got = null;
  // The shared cached GET parks every request on a 429/403 and retries; a page that is genuinely gone
  // comes back null and is cached as a miss, so it is never mistaken for a company without a profile.
  try {
    const html = await getCached(profileUrl(c.code), f, { ttlMs: FORCE ? 0 : 30 * 864e5, retries: 6, timeout: 25000 });
    if (html) {
      got = extract(html);
      // A challenge page has no profile paragraphs. It is not a company without a description — it is
      // a page we never read, so the cache entry is dropped and the company is retried next run.
      if (!got) {
        try { unlinkSync(f); } catch { /* already gone */ }
        if (!/HKG:/.test(html)) throttled++; else miss++;
      }
    } else miss++;
  } catch (e) {
    if (e && e.throttled) throttled++;
    else faile++;
  }
  if (got) {
    book.entries[c.code] = { ...got, fetched: new Date().toISOString(), source: 'stockanalysis.com' };
    ok++;
  }
  if (done % 25 === 0) console.log(`  ${done}/${list.length} · ${ok} fetched`);
  await sleep(GAP);
}
let cursor = 0;
const workers = Array.from({ length: Math.min(WORKERS, list.length) }, async () => {
  while (cursor < list.length) { const c = list[cursor++]; await one(c); }
});
await Promise.all(workers);

book.updated = new Date().toISOString();
writeFileSync(`${OUT}.tmp`, JSON.stringify(book, null, 0));
renameSync(`${OUT}.tmp`, OUT);
console.log(`fetched ${ok} · ${miss} without a page · ${throttled} throttled (rerun to fill) · ${faile} failed`);
