// Fetch an English name, a written business description and the sector/industry for every ASX
// company.
//
// The same source and extractor the Japan, Korea, Taiwan and Hong Kong profile fetchers use:
// stockanalysis.com's server-rendered company pages. The page title gives the English display name,
// the profile paragraphs give the description, and the field table gives the GICS sector and industry.
// Curated entries in data/australia-profiles.json win over a fetch.
//
//   node scripts/fetch-australia-profiles.mjs            all companies without an entry
//   node scripts/fetch-australia-profiles.mjs --limit=50 smoke test
//   node scripts/fetch-australia-profiles.mjs --force    refetch everything

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, AU_CACHE, saProfile, saUsProfile, US_CROSS } from './asx.mjs';
import { getCached } from './stockanalysis.mjs';
import { extractBrands } from '../src/brand-extract.js';

const FILE = join(ROOT, 'data', 'australia.json');
const OUT = join(ROOT, 'data', 'australia-profiles.json');
const CACHE = join(AU_CACHE, 'profiles');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const TOP = Number((process.argv.find((x) => x.startsWith('--top=')) || '').split('=')[1] || 0);
const UNCLASSIFIED = process.argv.includes('--unclassified');
const FORCE = process.argv.includes('--force');
const TTL = 30 * 864e5;
mkdirSync(CACHE, { recursive: true });

const text = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function field(html, label) {
  const m = new RegExp(`>${label}</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(html);
  return m ? text(m[1]) || null : null;
}

export function extractProfile(html) {
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '';
  const name = text(title)
    .replace(/\s*\([A-Z]{2,6}:[^)]*\).*$/i, '')
    .replace(/\s*\([A-Z.]{1,6}\).*$/i, '')
    .replace(/\s*Company Profile.*$/i, '')
    .replace(/\s*Stock Price.*$/i, '')
    .trim();
  const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
  const paras = box ? [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1])) : [];
  const desc = paras.join(' ');
  if (!name || desc.length < 60) return null;
  const first = (desc.match(/^.*?[.。](?=\s|$)/) || [desc])[0];
  const brandInfo = extractBrands(desc);
  return {
    name,
    legal: first.length > 140 ? first.slice(0, 137) + '…' : first,
    desc: shorten(desc),
    sector: field(html, 'Sector'),
    industry: field(html, 'Industry'),
    brands: brandInfo.brands,
    brandQuote: brandInfo.quote,
  };
}
function shorten(t, max = 300) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return i > 80 ? cut.slice(0, i + 1) : `${cut.replace(/[,;\s]+\S*$/, '')}…`;
}

const au = JSON.parse(readFileSync(FILE, 'utf8'));
const book = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { entries: {} };
book.entries = book.entries || {};
// `--unclassified` fetches only the rows the CSV could not classify (the "Not Applic" / "Class Pend"
// ~250), which is what the sector rule actually needs; `--top=N` fetches the N largest by cap, which is
// what a reader is most likely to open. Neither changes the shape of the file.
let pool = au.companies;
if (UNCLASSIFIED) pool = pool.filter((c) => c.sectorSource === 'other' || c.sectorSource === 'profile-gics-sector');
if (TOP) pool = [...au.companies].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, TOP);
const todo = pool.filter((c) => FORCE || !(book.entries[c.code] && book.entries[c.code].desc));
const list = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`${list.length} companies to fetch (${Object.keys(book.entries).length} already have an entry)`);

let ok = 0, miss = 0, fail = 0;
for (let i = 0; i < list.length; i++) {
  const c = list[i];
  const cross = US_CROSS[c.code];
  const f = join(CACHE, `${cross ? `us-${cross.ticker}` : c.code}.json`);
  let got = null;
  try {
    const html = await getCached(cross ? saUsProfile(cross.ticker) : saProfile(c.code), f, { ttlMs: FORCE ? 0 : TTL, fresh: FORCE, timeout: 25000, retries: 3 });
    if (html) got = extractProfile(html);
  } catch (e) {
    // Throttling is not a missing page. Go quiet for a minute so the next company has a chance,
    // rather than sprinting through the rest of the market recording failures.
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
