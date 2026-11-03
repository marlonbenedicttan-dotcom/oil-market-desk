// Make the price history grow instead of slide.
//
// Every market build downloads a fixed window — five years for Japan, Korea, Taiwan, Hong Kong and
// Australia, ten for the US — and writes it over the stored series. The chart would still show five
// years in 2036, however long the site runs. This step runs after the build and keeps the points that
// are older than the window the source still covers, so the series accumulates.
//
// Only the long-tail series is touched (the weekly/compacted one). The recent daily bars stay exactly
// what the source returned, because that is what the price and the returns are read from.
//
//   node scripts/merge-series.mjs us jp kr tw hk au
//   node scripts/merge-series.mjs --dry-run
//
// Charts are served from data/charts/<market>.ndjson, so the index for every market that changed is
// rebuilt at the end. A run where nothing scrolled off writes nothing.

import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSeriesPoints } from '../src/lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = (f) => join(ROOT, 'data', f);
const DRY = process.argv.includes('--dry-run');

const head = (path) => {
  try {
    return JSON.parse(execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  } catch { return null; }
};
const gained = (before, after) => after.length - before.length;
const isPoint = (x) => x && typeof x.d === 'string' && Number.isFinite(x.c) && x.c > 0;

const report = [];
const note = (id, companies, points) => { if (companies) report.push(`${id}: ${companies} companies kept ${points} extra sessions`); };

// --- US: one compacted [date, close] array per ticker --------------------------------------------
function us(dry) {
  const file = 'us-charts.json';
  const now = JSON.parse(readFileSync(DATA(file), 'utf8'));
  const before = head(`data/${file}`);
  if (!before || !before.series) return;
  let companies = 0, points = 0;
  for (const [ticker, arr] of Object.entries(now.series || {})) {
    const prev = (before.series || {})[ticker];
    if (!Array.isArray(prev) || !Array.isArray(arr)) continue;
    const merged = mergeSeriesPoints(
      prev.map(([d, c]) => ({ d, c: +c })),
      arr.map(([d, c]) => ({ d, c: +c })),
    );
    const add = gained(arr, merged);
    if (add > 0) { companies++; points += add; now.series[ticker] = merged.map((x) => [x.d, x.c]); }
  }
  if (!companies) return;
  note('us', companies, points);
  if (!dry) { writeFileSync(DATA(`${file}.tmp`), JSON.stringify(now)); renameSync(DATA(`${file}.tmp`), DATA(file)); }
}

// --- Korea: one {d,c} array per company inside the market file ------------------------------------
function kr(dry) {
  const file = 'korea.json';
  const now = JSON.parse(readFileSync(DATA(file), 'utf8'));
  const before = head(`data/${file}`);
  if (!before) return;
  const prevBy = new Map((before.companies || []).map((c) => [c.ticker, c.series]));
  let companies = 0, points = 0;
  for (const c of now.companies || []) {
    const prev = prevBy.get(c.ticker);
    if (!Array.isArray(prev) || !Array.isArray(c.series)) continue;
    const merged = mergeSeriesPoints(prev, c.series);
    const add = gained(c.series, merged);
    if (add > 0) { companies++; points += add; c.series = merged; }
  }
  if (!companies) return;
  note('kr', companies, points);
  if (!dry) { writeFileSync(DATA(`${file}.tmp`), JSON.stringify(now)); renameSync(DATA(`${file}.tmp`), DATA(file)); }
}

// --- Japan: shared date axis, one column per code -------------------------------------------------
function jp(dry) {
  const file = 'japan-series.json';
  const now = JSON.parse(readFileSync(DATA(file), 'utf8'));
  const before = head(`data/${file}`);
  if (!before || !before.weekly) return;
  const prevW = before.weekly, nextW = now.weekly || { dates: [], series: {} };
  const codes = new Set([...Object.keys(prevW.series || {}), ...Object.keys(nextW.series || {})]);
  const merged = new Map();
  let companies = 0, points = 0;
  for (const code of codes) {
    const pts = (dates, cols) => (dates || []).map((d, i) => ({ d, c: (cols[code] || [])[i] })).filter(isPoint);
    const prev = pts(prevW.dates, prevW.series);
    const next = pts(nextW.dates, nextW.series);
    if (!next.length) { if (prev.length) merged.set(code, prev); continue; }
    const out = mergeSeriesPoints(prev, next);
    const add = gained(next, out);
    if (add > 0) { companies++; points += add; }
    merged.set(code, out);
  }
  if (!companies) return;
  note('jp', companies, points);
  if (dry) return;
  // One axis for the market: the union of every code's dates, oldest first. A code with no bar on a
  // date keeps a null, which is how the file already stores a listing that started later.
  const dates = [...new Set([...merged.values()].flatMap((rows) => rows.map((r) => r.d)))].sort();
  const series = {};
  for (const [code, rows] of merged) {
    const byDate = new Map(rows.map((r) => [r.d, r.c]));
    series[code] = dates.map((d) => (byDate.has(d) ? byDate.get(d) : null));
  }
  now.weekly = { dates, series };
  writeFileSync(DATA(`${file}.tmp`), JSON.stringify(now)); renameSync(DATA(`${file}.tmp`), DATA(file));
}

// --- Taiwan, Hong Kong, Australia: bucketed daily + weekly, no shared axis -------------------------
function bucket(id, dirName, dry) {
  const dir = DATA(dirName);
  if (!existsSync(dir)) return;
  let companies = 0, points = 0, touched = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const now = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const before = head(`data/${dirName}/${f}`);
    if (!before || !before.weekly) continue;
    let changed = false;
    for (const [code, arr] of Object.entries(now.weekly || {})) {
      const prev = before.weekly[code];
      if (!Array.isArray(prev) || !Array.isArray(arr)) continue;
      const merged = mergeSeriesPoints(prev, arr);
      const add = gained(arr, merged);
      if (add > 0) { companies++; points += add; now.weekly[code] = merged; changed = true; }
    }
    if (changed) {
      touched++;
      if (!dry) { writeFileSync(join(dir, `${f}.tmp`), JSON.stringify(now)); renameSync(join(dir, `${f}.tmp`), join(dir, f)); }
    }
  }
  if (companies) note(id, companies, points);
}

const TASKS = {
  us: (dry) => us(dry),
  jp: (dry) => jp(dry),
  kr: (dry) => kr(dry),
  tw: (dry) => bucket('tw', 'taiwan-series', dry),
  hk: (dry) => bucket('hk', 'hongkong-series', dry),
  au: (dry) => bucket('au', 'australia-series', dry),
};

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = requested.length ? requested : Object.keys(TASKS);
const unknown = ids.filter((id) => !TASKS[id]);
if (unknown.length) {
  console.error(`unknown market: ${unknown.join(', ')} — use ${Object.keys(TASKS).join(', ')}`);
  process.exit(2);
}

for (const id of ids) TASKS[id](DRY);

if (!report.length) {
  console.log(DRY ? 'dry run — nothing has scrolled off yet' : 'nothing to merge');
} else {
  for (const line of report) console.log(line);
  if (DRY) {
    console.log('\ndry run — nothing written');
  } else {
    // The chart files are a copy of this data; rebuild the index for every market that changed.
    for (const id of ids) {
      const changed = report.some((r) => r.startsWith(`${id}:`));
      if (!changed) continue;
      try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), id], { stdio: 'inherit' }); }
      catch (e) { console.log(`chart store ${id}: ${e.message}`); }
    }
  }
}
