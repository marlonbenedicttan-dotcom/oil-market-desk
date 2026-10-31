// Fetch the prior fiscal year's Q1 / H1 / Q3 statements for every Korean company.
//
// A TTM needs four reported quarters. `build-korea` only fetched the current year's interims, so the
// TTM could never be built and every Korean P/E fell back to the last fiscal year. With last year's
// three cumulative reports in hand, Q3 and Q4 fall out as differences (the annual report is Q4) and
// the four most recent standalone quarters are available.
//
// Writes the same cache shape `build-korea` reads: data/cache/dart/fin-{corp}-{year}-{report}.json
//
//   DART_API_KEY=... node scripts/refresh-korea-quarters.mjs
//   DART_API_KEY=... node scripts/refresh-korea-quarters.mjs --limit=20

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTS } from './dart.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'cache', 'dart');
const KEY = process.env.DART_API_KEY;
if (!KEY) throw new Error('DART_API_KEY is not set');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const YEAR = Number((process.argv.find((x) => x.startsWith('--year=')) || '').split('=')[1]) || new Date().getFullYear() - 1;
const GAP = Number((process.argv.find((x) => x.startsWith('--gap=')) || '').split('=')[1]) || 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(CACHE, { recursive: true });

const uni = JSON.parse(readFileSync(join(ROOT, 'data', 'korea-universe.json'), 'utf8'));
const todo = [...new Set(uni.companies.map((c) => c.code).filter(Boolean))].slice(0, LIMIT);
console.log(`${todo.length} filers · fiscal ${YEAR} · Q1/H1/Q3`);

const jobs = [];
for (const corp of todo) {
  for (const report of [REPORTS.q1, REPORTS.h1, REPORTS.q3]) {
    const f = join(CACHE, `fin-${corp}-${YEAR}-${report}.json`);
    let fresh = false;
    try {
      const hit = JSON.parse(readFileSync(f, 'utf8'));
      fresh = hit && Date.parse(hit.fetched) > Date.now() - 7 * 864e5;
    } catch { /* fetch */ }
    if (!fresh) jobs.push({ corp, report, f });
  }
}
console.log(`${jobs.length} requests to make (${todo.length * 3 - jobs.length} already fresh)`);

let done = 0, ok = 0, empty = 0, failed = 0;
for (const { corp, report, f } of jobs) {
  let rows = null;
  for (let attempt = 0; attempt < 4 && rows == null; attempt++) {
    try {
      const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${KEY}&corp_code=${corp}&bsns_year=${YEAR}&reprt_code=${report}&fs_div=CFS`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.status === 429) { await sleep(8000 * (attempt + 1)); continue; }
      const j = await res.json();
      if (j.status === '013' || j.status === '014') { rows = []; break; }
      if (j.status === '000') { rows = j.list || []; break; }
      await sleep(1500);
    } catch { await sleep(1500); }
  }
  if (rows == null) failed++;
  else if (!rows.length) empty++;
  else { ok++; writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), rows })); }
  done++;
  if (done % 100 === 0) console.log(`  ${done}/${jobs.length} · ${ok} saved · ${empty} empty · ${failed} failed`);
  await sleep(GAP);
}
console.log(`done · ${ok} saved · ${empty} empty · ${failed} failed`);
