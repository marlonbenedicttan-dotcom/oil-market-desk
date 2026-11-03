// Split the big Japan/Korea/Taiwan datasets into one small file per company.
//
//   node scripts/build-company-details.mjs        # every market below
//   node scripts/build-company-details.mjs jp kr  # named markets
//
// The company page needs one record. Reading it out of japan.json (5 MB), korea.json (28 MB) or
// taiwan.json (5 MB) made the first open of every company parse the whole market on the free
// instance — Korea was the worst, because 24 MB of its 28 MB is five years of daily closes that the
// detail page never draws (the chart comes from data/charts). Hong Kong and Australia already serve
// per-company files, so this brings the other three to the same shape.
//
// Each market gets:
//   data/<market>-companies/<code>.json   the detail record (and one file per alias, e.g. 7203 → 72030)
//   data/<market>-companies/_stamp.json   { v, updated, count } — the source build stamp
//
// The stamp is the `updated` field already at the front of the source file. The server only serves a
// detail file when it matches the current source, so a build that rewrote the market but not these
// files falls back to the old reader instead of publishing stale numbers. Korea's per-company `series`
// is dropped: the detail page reads quarters/history, and charts are served from data/charts.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = (f) => join(ROOT, 'data', f);

// `keys` is the primary lookup order; every distinct value becomes a file so a request for either the
// exchange code or the trading ticker is answered without parsing the market.
const MARKETS = {
  jp: {
    source: 'japan.json',
    dir: 'japan-companies',
    keys: (c) => [c.code, c.ticker],
    trim: (c) => c,
  },
  kr: {
    source: 'korea.json',
    dir: 'korea-companies',
    keys: (c) => [c.code, c.ticker],
    trim: ({ series, ...rest }) => rest,
  },
  tw: {
    source: 'taiwan.json',
    dir: 'taiwan-companies',
    keys: (c) => [c.code, c.ticker],
    trim: (c) => c,
  },
};

const safeKey = (k) => {
  const s = String(k || '').trim();
  return /^[A-Za-z0-9._-]{1,16}$/.test(s) && !s.startsWith('_') ? s : null;
};

function build(id) {
  const spec = MARKETS[id];
  if (!spec) throw new Error(`unknown market: ${id}`);
  const srcFile = DATA(spec.source);
  const src = JSON.parse(readFileSync(srcFile, 'utf8'));
  const companies = src.companies || [];
  const dir = DATA(spec.dir);
  mkdirSync(dir, { recursive: true });

  const keep = new Set();
  let written = 0;
  let unchanged = 0;
  for (const raw of companies) {
    const c = spec.trim(raw);
    const body = JSON.stringify(c);
    for (const k of new Set(spec.keys(c))) {
      const key = safeKey(k);
      if (!key) continue;
      keep.add(`${key}.json`);
      const file = join(dir, `${key}.json`);
      // Compare before writing: a daily rebuild should only touch the companies that actually changed,
      // not rewrite every file (and every commit) in the directory.
      let prev = null;
      try { prev = readFileSync(file, 'utf8'); } catch { /* new company */ }
      if (prev === body) { unchanged++; continue; }
      writeFileSync(`${file}.tmp`, body);
      renameSync(`${file}.tmp`, file);
      written++;
    }
  }

  // Drop companies that left the index, so the directory cannot answer for a delisted code.
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === '_stamp.json') continue;
    if (keep.has(f)) continue;
    rmSync(join(dir, f), { force: true });
    removed++;
  }

  const stamp = JSON.stringify({ v: 1, market: id, updated: src.updated || null, count: companies.length });
  const stampFile = join(dir, '_stamp.json');
  let prevStamp = null;
  try { prevStamp = readFileSync(stampFile, 'utf8'); } catch { /* first build */ }
  if (prevStamp !== stamp) {
    writeFileSync(`${stampFile}.tmp`, stamp);
    renameSync(`${stampFile}.tmp`, stampFile);
  }

  console.log(`${id}: ${companies.length} companies · ${keep.size} files · ${written} updated · ${unchanged} unchanged · ${removed} removed · source ${src.updated || '—'}`);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const todo = args.length ? args : Object.keys(MARKETS);
for (const id of todo) {
  try { build(id); } catch (e) { console.error(`${id}: ${e.message}`); }
}
