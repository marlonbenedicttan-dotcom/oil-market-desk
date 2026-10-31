// Fetch a written description for every KOSPI company, the way the Japan descriptions were fetched.
// Curated brand chips are attached separately from data/korea-brands.json.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'korea.json');
const BRANDS = join(ROOT, 'data', 'korea-brands.json');
const CACHE = join(ROOT, 'data', 'cache', 'korea-profiles');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extract = (html) => {
  const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
  if (!box) return null;
  const paras = [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' '));
  const text = paras.join(' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return text.length > 60 ? text : null;
};
const shorten = (t, max = 300) => {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return i > 80 ? cut.slice(0, i + 1) : `${cut.replace(/[,;\s]+\S*$/, '')}\u2026`;
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const brands = JSON.parse(readFileSync(BRANDS, 'utf8')).brands || {};

async function one(c) {
  const f = join(CACHE, `${c.ticker}.json`);
  if (existsSync(f)) { try { const t = JSON.parse(readFileSync(f, 'utf8')).text; if (t) return t; } catch { /* refetch */ } }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://stockanalysis.com/quote/krx/${c.ticker}/company/`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429) { await sleep(3000); continue; }
      if (!res.ok) return null;
      const text = extract(await res.text());
      if (text) { writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), text })); return text; }
      return null;
    } catch { await sleep(500); }
  }
  return null;
}

let ok = 0, fail = 0, at = 0;
const pool = Array.from({ length: 4 }, async () => {
  while (at < data.companies.length) {
    const c = data.companies[at++];
    const text = await one(c);
    if (text) { c.description = shorten(text); c.descSource = 'profile'; c.descSourceName = 'stockanalysis.com'; ok++; }
    else fail++;
    c.brands = brands[c.ticker] || [];
    if ((ok + fail) % 100 === 0) console.log(`  ${ok + fail}/${data.companies.length} · ${ok} found`);
    await sleep(120);
  }
});
await Promise.all(pool);
// Ten companies have no profile page; give them a factual line rather than a blank.
const won = (v) => {
  if (v == null || !Number.isFinite(v)) return null;
  const a2 = Math.abs(v);
  if (a2 >= 1e12) return `₩${(v / 1e12).toFixed(2)}T`;
  if (a2 >= 1e8) return `₩${(v / 1e8).toFixed(1)}B`;
  return `₩${Math.round(v / 1e4)}만`;
};
for (const c of data.companies) {
  if (c.description) continue;
  const rev = c.history && c.history.length ? c.history[c.history.length - 1].s : null;
  c.description = `${c.nameEn || c.name} is a KOSPI-listed company${rev ? ` with ${won(rev)} of revenue` : ''}. No company profile was available, so this line is generated from the filing data.`;
  c.descSource = 'generated';
}
// Keep a committed copy: the cache is gitignored and CI would rebuild without it.
const store = {};
for (const c of data.companies) if (c.descSource === 'profile' && c.description) store[c.ticker] = c.description;
writeFileSync(join(ROOT, 'data', 'korea-profiles.json'), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), note: 'Fetched Korean company profiles from stockanalysis.com, keyed by ticker.', profiles: store }));
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`${ok} descriptions · ${fail} missing · ${Object.keys(brands).length} with brand chips`);
