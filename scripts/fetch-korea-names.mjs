// English names for the KOSPI universe, from OpenFIGI (Bloomberg's open symbology).
//
// DART carries `corp_name_eng`, but its API was rate-limiting us and the cached records predate the field.
// OpenFIGI answers the same question in batches of 25 tickers, so the whole market is 33 requests.
//
//   node scripts/fetch-korea-names.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'korea-universe.json');
const BATCH = 10;            // OpenFIGI rejects 25 without a key — 10 is the working size
const GAP = 6500;            // and 10 requests a minute
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "SAMSUNG ELECTRONICS CO LTD" reads badly in a table; title-case it and keep the legal suffix.
const tidy = (s) => {
  if (!s) return null;
  const small = new Set(['of', 'and', 'the', 'for', 'co', 'ltd', 'inc']);
  return s.toLowerCase().split(/\s+/).map((w, i) => {
    if (i > 0 && small.has(w)) return w === 'co' || w === 'ltd' || w === 'inc' ? w.toUpperCase() : w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ').replace(/\bCo\b/g, 'Co').trim();
};

const book = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = book.companies.filter((c) => !c.nameEn);
console.log(`${todo.length} companies need an English name`);

let filled = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const slice = todo.slice(i, i + BATCH);
  const body = slice.map((c) => ({ idType: 'TICKER', idValue: c.ticker, exchCode: 'KS' }));
  try {
    const res = await fetch('https://api.openfigi.com/v3/mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) { await sleep(30000); i -= BATCH; continue; }
    const rows = await res.json();
    rows.forEach((r, k) => {
      const name = r?.data?.[0]?.name;
      if (name && slice[k]) { slice[k].nameEn = tidy(name); filled++; }
    });
  } catch (e) { console.log(`  batch ${i / BATCH + 1}: ${e.message}`); }
  await sleep(GAP);
  if ((i / BATCH + 1) % 5 === 0) console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length} · ${filled} named`);
}

book.updated = new Date().toISOString().slice(0, 10);
writeFileSync(FILE, JSON.stringify(book, null, 1));
console.log(`${filled} names added · ${book.companies.filter((c) => c.nameEn).length}/${book.companies.length} have an English name`);
console.log(book.companies.slice(0, 4).map((c) => `  ${c.ticker} ${c.nameEn || c.name}`).join('\n'));
