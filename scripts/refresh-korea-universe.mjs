// Fill gaps in the KOSPI universe: any listed filer whose company.json call failed (the rate-limit
// window) never got a market class, so it silently dropped out of the index. This refetches only those.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'cache', 'dart');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const KEY = process.env.DART_API_KEY;
if (!KEY) throw new Error('DART_API_KEY is not set');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const book = JSON.parse(readFileSync(join(CACHE, 'corp.json'), 'utf8'));
// Keep the English names we already resolved (OpenFIGI); the DART info cache predates that field.
const prev = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'korea-universe.json'), 'utf8')).companies || []; }
  catch { return []; }
})();
const prevName = new Map(prev.map((c) => [c.ticker, c.nameEn]));
const listed = book.rows.filter((r) => String(r.stock || '').trim());
const missing = listed.filter((r) => !existsSync(join(CACHE, `info-${r.corp}.json`)));
console.log(`${listed.length} listed · ${missing.length} without a market class`);

let fixed = 0;
for (let i = 0; i < missing.length; i++) {
  const r = missing[i];
  try {
    const res = await fetch(`https://opendart.fss.or.kr/api/company.json?crtfc_key=${KEY}&corp_code=${r.corp}`, { headers: { 'User-Agent': UA } });
    if (res.status === 429) { await sleep(5000); i--; continue; }
    const j = await res.json();
    if (j.corp_cls) {
      writeFileSync(join(CACHE, `info-${r.corp}.json`), JSON.stringify({
        v: 2, fetched: new Date().toISOString(), cls: j.corp_cls,
        industry: j.induty_code || null, name: j.stock_name || null, nameEn: j.corp_name_eng || null,
      }));
      fixed++;
    }
  } catch { /* next */ }
  await sleep(400);
  if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${missing.length} · ${fixed} filled`);
}

// Rebuild the universe from every info file we now hold.
const out = [];
for (const r of listed) {
  const f = join(CACHE, `info-${r.corp}.json`);
  if (!existsSync(f)) continue;
  let d;
  try { d = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
  if (d.cls !== 'Y') continue;
  let shares = null;
  const sf = join(CACHE, `shares-${r.corp}.json`);
  if (existsSync(sf)) { try { shares = JSON.parse(readFileSync(sf, 'utf8')).shares; } catch { /* none */ } }
  out.push({ code: r.corp, ticker: r.stock.trim(), name: r.name, nameEn: d.nameEn || prevName.get(r.stock.trim()) || null, industry: d.industry || null, shares });
}
out.sort((a, b) => a.ticker.localeCompare(b.ticker));

// Names the symbology source gets wrong, corrected by hand.
const FIX = {
  '007310': 'OTTOGI CORP',
  '000040': 'KR MOTORS CO LTD',
  '001470': 'SAMBU ENGINEERING & CONSTRUCTION CO LTD',
  '009900': 'MYOUNG SHIN INDUSTRIAL CO LTD',
};
for (const c of out) if (FIX[c.ticker]) c.nameEn = FIX[c.ticker];

writeFileSync(join(ROOT, 'data', 'korea-universe.json'), JSON.stringify({
  updated: new Date().toISOString().slice(0, 10),
  note: 'KOSPI universe from DART: corp_cls Y, with share counts. Committed so CI does not rescan 4,000 filers.',
  companies: out,
}, null, 1));
console.log(`universe: ${out.length} KOSPI companies (${out.filter((c) => c.shares).length} with shares)`);
console.log(out.filter((c) => ['122870', '007310'].includes(c.ticker)).map((c) => `  ${c.ticker} ${c.nameEn || c.name}`).join('\n'));
