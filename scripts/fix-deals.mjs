// Clean the deal store: classify by the filer's SEC SIC code, drop non-company targets, merge duplicates.
//
//   node scripts/fix-deals.mjs --dry
//   node scripts/fix-deals.mjs
//
// Sector tagging from headline words put 31 deals in "Other". The filing's own SIC code is the right
// answer, and the CIK is already in the filing URL we stored.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIC_SECTOR, isGenericTarget, nameKey } from '../src/deals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'deals-store.json');
const SIC_CACHE = join(ROOT, 'data', '.sic-cache.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = JSON.parse(readFileSync(STORE, 'utf8'));
const sicCache = (() => { try { return JSON.parse(readFileSync(SIC_CACHE, 'utf8')); } catch { return {}; } })();

const cikOf = (url) => {
  const m = /\/Archives\/edgar\/data\/(\d+)\//.exec(String(url || ''));
  return m ? String(Number(m[1])) : null;
};

let last = 0;
async function sicFor(cik) {
  if (sicCache[cik] !== undefined) return sicCache[cik];
  const wait = Math.max(0, 180 - (Date.now() - last));
  if (wait) await sleep(wait);
  last = Date.now();
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) { sicCache[cik] = null; return null; }
    const j = await res.json();
    sicCache[cik] = j.sic || null;
    return sicCache[cik];
  } catch { sicCache[cik] = null; return null; }
}

const before = store.deals.length;
let retagged = 0, dropped = 0;

// 1. drop objects masquerading as companies, self-deals, and headline fragments
const fragment = (v) => !v || /\$|\b(offers?|weigh|weighs|in talks|reportedly|said to)\b/i.test(v) || /[\u2013\u2014-]\s*$/.test(v) || /\b(special project delivery|and previous|unknown)\b/i.test(v);
store.deals = store.deals.filter((d) => {
  if (!d.target) { dropped++; return false; }
  if (isGenericTarget(d.target)) { dropped++; return false; }
  if (nameKey(d.target) === nameKey(d.acquirer)) { dropped++; return false; }   // "Pacira -> Pacira"
  if (fragment(d.target) || fragment(d.acquirer)) { dropped++; return false; }
  if (!d.acquirer && !d.value) { dropped++; return false; }                     // nothing to show
  return true;
});

// 2. sector from the filer's SIC
const ciks = [...new Set(store.deals.map((d) => cikOf(d.url)).filter(Boolean))];
console.log(`lookup SIC for ${ciks.length} filers…`);
for (const cik of ciks) {
  const sic = await sicFor(cik);
  if (!sic) continue;
  const sector = SIC_SECTOR(sic);
  if (sector === 'Other') continue;
  for (const d of store.deals) {
    if (cikOf(d.url) !== cik) continue;
    if (d.sector !== sector) { d.sector = sector; retagged++; }
  }
}

// 3. merge duplicates: same target token -> keep the row with a value, else the one with more events
const byKey = new Map();
for (const d of store.deals) {
  const k = nameKey(d.target) || (d.key || '');
  if (!k) continue;
  const prev = byKey.get(k);
  if (!prev) { byKey.set(k, d); continue; }
  const better = (a, b) => ((a.value ? 1 : 0) - (b.value ? 1 : 0)) || ((a.events?.length || 0) - (b.events?.length || 0));
  if (better(d, prev) > 0) byKey.set(k, d);
}
const merged = [...byKey.values()];
const dupes = store.deals.length - merged.length;
store.deals = merged;

store.updated = new Date().toISOString();
store.deals.sort((a, b) => ((a.lastSeen || a.date) < (b.lastSeen || b.date) ? 1 : -1));

const counts = {};
for (const d of store.deals) counts[d.sector || 'Other'] = (counts[d.sector || 'Other'] || 0) + 1;
console.log(`deals ${before} → ${store.deals.length} · retagged ${retagged} · dropped ${dropped} · duplicates merged ${dupes}`);
console.log('sectors:', Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));

if (!DRY) {
  writeFileSync(STORE, JSON.stringify(store));
  writeFileSync(SIC_CACHE, JSON.stringify(sicCache));
  console.log('written');
}
