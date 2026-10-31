// Re-read the listed share count for every Korean company from DART.
//
// The stock-total table has three numbers that look alike and are not:
//   now_to_isu_stock_totqy  everything ever issued (includes retired shares)
//   istc_totqy              issued now
//   distb_stock_co          listed now — issued minus retired minus treasury
// Only the last one is the count the market capitalises. Using the first made Samsung 8.98B instead of
// 5.83B and SK Hynix 5.72B instead of 0.70B, which inflated every Korean market cap built from it.
//
// The count is the common line: the common quote does not price the preferred line. The total issued
// count is kept alongside for reference.
//
//   DART_API_KEY=... node scripts/refresh-korea-shares.mjs
//   DART_API_KEY=... node scripts/refresh-korea-shares.mjs --limit=20

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'korea-universe.json');
const CACHE = join(ROOT, 'data', 'cache', 'dart');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const KEY = process.env.DART_API_KEY;
if (!KEY) throw new Error('DART_API_KEY is not set');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
mkdirSync(CACHE, { recursive: true });

const listed = (r) => {
  const d = num(r?.distb_stock_co);
  if (d) return d;
  const i = num(r?.istc_totqy);
  const t = num(r?.tesstk_co);
  return i ? i - (t || 0) : null;
};

async function table(corp, year) {
  const url = `https://opendart.fss.or.kr/api/stockTotqySttus.json?crtfc_key=${KEY}&corp_code=${corp}&bsns_year=${year}&reprt_code=11011`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429) { await sleep(4000 * (i + 1)); continue; }
      const j = await res.json();
      if (j.status === '000' && (j.list || []).length) return j.list;
      if (j.status === '013') return null;          // no table for this filer
      await sleep(800);
    } catch { await sleep(1200); }
  }
  return null;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.code).slice(0, LIMIT);
console.log(`${data.companies.length} companies · refreshing ${todo.length}`);

const year = new Date().getFullYear() - 1;
let updated = 0, failed = 0, filled = 0;
const changes = [];

for (let i = 0; i < todo.length; i++) {
  const c = todo[i];
  let rows = await table(c.code, year);
  if (!rows) rows = await table(c.code, year - 1);
  if (!rows) { failed++; await sleep(150); continue; }

  const common = rows.find((r) => String(r.se || '').includes('보통주'));
  const total = rows.find((r) => String(r.se || '').includes('합계'));
  const shares = listed(common) || listed(total) || null;
  const sharesIssued = num(total?.istc_totqy) || num(common?.istc_totqy) || null;
  if (!shares) { failed++; await sleep(150); continue; }

  if (c.shares && Math.abs(shares - c.shares) / c.shares > 0.01) changes.push([c.ticker, c.name, c.shares, shares]);
  if (!c.shares) filled++;
  c.shares = shares;
  c.sharesIssued = sharesIssued;
  writeFileSync(join(CACHE, `shares-${c.code}.json`), JSON.stringify({ fetched: new Date().toISOString(), shares, sharesIssued }));
  updated++;
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${todo.length} · ${updated} updated · ${failed} failed`);
  await sleep(200);
}

data.updated = new Date().toISOString().slice(0, 10);
writeFileSync(FILE, JSON.stringify(data, null, 1));
console.log(`updated ${updated} · filled ${filled} · failed ${failed}`);
changes.sort((a, b) => Math.abs(b[2] / b[3] - 1) - Math.abs(a[2] / a[3] - 1));
console.log(`largest corrections (${changes.length} moved >1%):`);
for (const [t, n, was, now] of changes.slice(0, 12)) {
  console.log(`  ${t} ${String(n).slice(0, 18).padEnd(18)} ${was.toLocaleString('en-US')} → ${now.toLocaleString('en-US')} (${(was / now).toFixed(1)}x)`);
}
