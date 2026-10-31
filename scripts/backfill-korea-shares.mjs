// Fill in the share counts the first universe scan missed.
//
// A company with no share count is dropped by build-korea before it ever reaches the statement fetch,
// so a failed stockTotqySttus call silently removes the company from the site — Kia, Hyundai Steel and
// HMM were all missing for this reason. This asks DART again for just those.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'cache', 'dart');
const FILE = join(ROOT, 'data', 'korea-universe.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const KEY = process.env.DART_API_KEY;
if (!KEY) throw new Error('DART_API_KEY is not set');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : null; };

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => !c.shares);
console.log(`${data.companies.length} companies · ${todo.length} without a share count`);

let filled = 0;
for (const c of todo) {
  const url = `https://opendart.fss.or.kr/api/stockTotqySttus.json?crtfc_key=${KEY}&corp_code=${c.code}&bsns_year=${new Date().getFullYear() - 1}&reprt_code=11011`;
  let shares = null;
  for (let i = 0; i < 3 && shares == null; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429) { await sleep(5000); continue; }
      const j = await res.json();
      const rows = j.list || [];
      // Common, preferred and a 합계 total row — summing all three double counts.
      const total = rows.find((r) => String(r.se || '').includes('합계'));
      const parts = rows.filter((r) => /보통주|우선주/.test(String(r.se || '')));
      shares = total ? num(total.now_to_isu_stock_totqy)
        : (parts.reduce((a, r) => a + (num(r.now_to_isu_stock_totqy) || 0), 0) || null);
      if (shares) writeFileSync(join(CACHE, `shares-${c.code}.json`), JSON.stringify({ fetched: new Date().toISOString(), shares }));
    } catch { await sleep(1500); }
  }
  if (shares) { c.shares = shares; filled++; console.log(`  ${c.ticker} ${c.nameEn || c.name} · ${shares.toLocaleString('en-US')}`); }
  else console.log(`  ${c.ticker} ${c.nameEn || c.name} · still none (fund, or DART has no table)`);
  await sleep(400);
}

data.updated = new Date().toISOString().slice(0, 10);
writeFileSync(FILE, JSON.stringify(data, null, 1));
console.log(`filled ${filled} of ${todo.length}`);
