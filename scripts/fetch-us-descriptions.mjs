// Fetch a written company profile for every US company, the same way Japan and Korea are described.
//
// The 10-K "Item 1" text is what a lawyer wrote, not what a reader wants: fragments ("Originally
// organized as Caterpillar Tractor Co."), legal-terms openings, and half-sentences. A profile written
// about the company reads like a profile. Precedence is curated → fetched → filing text.
//
//   node scripts/fetch-us-descriptions.mjs
//   node scripts/fetch-us-descriptions.mjs --only=AAPL,MSFT
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const STORE = join(ROOT, 'data', 'us-profiles.json');
const CACHE = join(ROOT, 'data', 'cache', 'us-profiles');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
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
const todo = data.companies.filter((c) => c.ticker && (!onlySet || onlySet.has(c.ticker.toUpperCase())));

// Nasdaq publishes a written company description next to the quote we already use. It is the better
// source here: no extra host, no throttle, and the text reads like a profile rather than a filing.
async function fromNasdaq(ticker) {
  const sym = String(ticker).replace('-', '.');
  try {
    const res = await fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/company-profile`, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const v = j && j.data && j.data.CompanyDescription && j.data.CompanyDescription.value;
    const text = String(v || '').replace(/\s+/g, ' ').trim();
    return text.length > 60 ? text : null;
  } catch { return null; }
}

async function one(c) {
  const f = join(CACHE, `${c.ticker}.json`);
  if (existsSync(f)) { try { const t = JSON.parse(readFileSync(f, 'utf8')).text; if (t) return t; } catch { /* refetch */ } }
  const nasdaq = await fromNasdaq(c.ticker);
  if (nasdaq) { writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), source: 'nasdaq', text: nasdaq })); return nasdaq; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://stockanalysis.com/stocks/${encodeURIComponent(c.ticker)}/company/`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20000),
      });
      // stockanalysis throttles hard: back off properly instead of burning the whole run on 429s.
      if (res.status === 429) { await sleep(20000 + attempt * 15000); continue; }
      if (!res.ok) return null;
      const text = extract(await res.text());
      if (text) { writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), text })); return text; }
      return null;
    } catch { await sleep(600); }
  }
  return null;
}

let ok = 0, fail = 0, at = 0;
const pool = Array.from({ length: 3 }, async () => {
  while (at < todo.length) {
    const c = todo[at++];
    const text = await one(c);
    if (text) {
      c.description = shorten(text);
      c.descSource = 'profile';
      c.descSourceName = 'stockanalysis.com';
      ok++;
    } else fail++;
    if ((ok + fail) % 50 === 0) console.log(`  ${ok + fail}/${todo.length} · ${ok} found`);
    await sleep(140);
  }
});
await Promise.all(pool);

// A committed store: CI rebuilds have no local cache, and that is exactly how Korea lost its profiles.
let store = {};
try { store = JSON.parse(readFileSync(STORE, 'utf8')).profiles || {}; } catch { /* first run */ }
for (const c of data.companies) if (c.descSource === 'profile' && c.description) store[c.ticker] = c.description;
writeFileSync(STORE, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), note: 'Fetched US company profiles from stockanalysis.com, keyed by ticker.', profiles: store }));

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`profiles: ${ok} fetched · ${fail} without a page · ${Object.keys(store).length} stored`);
