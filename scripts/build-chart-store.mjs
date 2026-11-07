// Build the per-market chart store the company pages read.
//
//   node scripts/build-chart-store.mjs            # every market
//   node scripts/build-chart-store.mjs tw hk      # named markets
//
// Each market gets two files:
//   data/charts/<market>.ndjson   one line per company: { k, p: [[dateIndex, close], ...] }
//   data/charts/<market>.idx.json { dates, keys: { CODE: [byteOffset, byteLength] } }
//
// The server reads the requested company's line only, so a chart never parses a whole market. The
// store is written from the same artifacts the old chart endpoints used, so the prices cannot drift.
// The build scripts call this after they rewrite their series; if it is missing or a code is absent,
// the server falls back to the old (slower) reader rather than showing no chart.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combineSeries, pointsFromColumns } from '../src/charts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'charts');
const DATA = (f) => join(ROOT, 'data', f);

const readJSON = (f) => JSON.parse(readFileSync(f, 'utf8'));

// A source's own build stamp, read from its first 256 bytes. The server compares it with the stamp
// in the chart index: if a data build rewrote the series but not the store, the server falls back to
// the old reader instead of publishing a stale chart.
function fileStamp(f) {
  let fd;
  try {
    fd = openSync(f, 'r');
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
    return m ? m[1] : null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

function firstBucket(dirName) {
  try {
    const f = readdirSync(DATA(dirName)).filter((x) => x.endsWith('.json')).sort()[0];
    return f ? join(DATA(dirName), f) : null;
  } catch { return null; }
}

function sourceStamp(id) {
  if (id === 'kr') return fileStamp(DATA('korea.json'));
  if (id === 'jp') return fileStamp(DATA('japan-series.json'));
  if (id === 'us') return fileStamp(DATA('us-charts.json'));
  const dir = { tw: 'taiwan-series', hk: 'hongkong-series', au: 'australia-series', in: 'india-series', id: 'indonesia-series', br: 'brazil-series' }[id];
  const first = dir ? firstBucket(dir) : null;
  return first ? fileStamp(first) : null;
}

// Every market reduces to the same intermediate shape: a primary key, its points (oldest first), and
// any aliases that must resolve to the same line (a Tokyo 4-digit ticker vs its 5-digit code, a
// Korean 6-digit ticker vs its 8-digit DART code).
function eachUs(add) {
  const d = readJSON(DATA('us-charts.json'));
  for (const [ticker, arr] of Object.entries(d.series || {})) {
    if (!/^[A-Za-z0-9.\-^]{1,12}$/.test(ticker)) continue;
    const points = (arr || []).filter((r) => Array.isArray(r) && r[0] && r[1] != null)
      .map(([date, close]) => ({ d: date, c: +close }));
    if (points.length > 1) add(ticker.toUpperCase(), points, points.length ? ticker : null);
  }
}

function eachJp(add) {
  const f = DATA('japan-series.json');
  if (!existsSync(f)) return;
  const j = readJSON(f);
  const daily = j.daily || {}, weekly = j.weekly || {};
  const codes = new Set([...Object.keys(daily.series || {}), ...Object.keys(weekly.series || {})]);
  for (const code of codes) {
    const d = pointsFromColumns(daily.dates || [], (daily.series || {})[code]);
    const w = pointsFromColumns(weekly.dates || [], (weekly.series || {})[code]);
    const points = combineSeries(d, w);
    if (points.length < 2) continue;
    // The UI and the compare box use both 7203 (ticker) and 72030 (code). Both must hit this line.
    add(code, points, /^\d{5}$/.test(code) ? code.slice(0, 4) : null);
  }
}

function eachKr(add) {
  const f = DATA('korea.json');
  if (!existsSync(f)) return;
  const j = readJSON(f);
  for (const c of j.companies || []) {
    const points = combineSeries((c.series || []).map((p) => ({ d: p.d, c: +p.c })), []);
    if (points.length < 2) continue;
    add(c.ticker, points, c.code || null);
  }
}

// Taiwan, Hong Kong and Australia already ship daily + weekly in one-character or two-digit buckets.
// Read them all once here and regroup per company, so a chart request never has to touch a bucket.
function eachBucketed(dirName, add) {
  const dir = DATA(dirName);
  if (!existsSync(dir)) return;
  const daily = new Map(), weekly = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let j;
    try { j = readJSON(join(dir, f)); } catch { continue; }
    for (const [code, arr] of Object.entries(j.daily || {})) daily.set(code, arr);
    for (const [code, arr] of Object.entries(j.weekly || {})) weekly.set(code, arr);
  }
  for (const code of new Set([...daily.keys(), ...weekly.keys()])) {
    const points = combineSeries(daily.get(code), weekly.get(code));
    if (points.length < 2) continue;
    add(code, points, code.toUpperCase() === code ? null : code.toUpperCase());
  }
}

const MARKETS = {
  us: { label: 'United States', write: eachUs },
  jp: { label: 'Japan', write: eachJp },
  kr: { label: 'Korea', write: eachKr },
  tw: { label: 'Taiwan', write: (add) => eachBucketed('taiwan-series', add) },
  hk: { label: 'Hong Kong', write: (add) => eachBucketed('hongkong-series', add) },
  au: { label: 'Australia', write: (add) => eachBucketed('australia-series', add) },
  in: { label: 'India', write: (add) => eachBucketed('india-series', add) },
  id: { label: 'Indonesia', write: (add) => eachBucketed('indonesia-series', add) },
  br: { label: 'Brazil', write: (add) => eachBucketed('brazil-series', add) },
};

function build(id) {
  const spec = MARKETS[id];
  if (!spec) throw new Error(`unknown market: ${id}`);
  const entries = [];              // { primary, points, aliases: [key], }
  const seen = new Set();
  const add = (key, points, alias) => {
    const primary = String(key || '').toUpperCase();
    if (!primary || seen.has(primary)) return;
    seen.add(primary);
    const aliases = [...new Set([primary, String(alias || '').toUpperCase()].filter(Boolean))];
    entries.push({ primary, points, aliases });
  };
  spec.write(add);

  // One date table per market: mostly shared, and an index is much smaller than repeating the date
  // string on every point of every company.
  const dateSet = new Set();
  for (const e of entries) for (const p of e.points) dateSet.add(p.d);
  const dates = [...dateSet].sort();
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  entries.sort((a, b) => (a.primary < b.primary ? -1 : a.primary > b.primary ? 1 : 0));
  const chunks = [];
  const keys = {};
  let offset = 0;
  let through = null;
  for (const e of entries) {
    const p = e.points.map((pt) => [dateIndex.get(pt.d), pt.c]);
    const line = `${JSON.stringify({ k: e.primary, p })}\n`;
    const len = Buffer.byteLength(line);
    chunks.push(line);
    for (const key of e.aliases) keys[key] = [offset, len];
    const last = e.points[e.points.length - 1].d;
    if (!through || last > through) through = last;
    offset += len;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const body = chunks.join('');
  const ndjson = join(OUT_DIR, `${id}.ndjson`);
  const idxFile = join(OUT_DIR, `${id}.idx.json`);
  writeFileSync(`${ndjson}.tmp`, body);
  renameSync(`${ndjson}.tmp`, ndjson);
  const idx = {
    v: 1,
    market: id,
    built: new Date().toISOString(),
    source: sourceStamp(id),
    through,
    dates,
    keys,
  };
  writeFileSync(`${idxFile}.tmp`, JSON.stringify(idx));
  renameSync(`${idxFile}.tmp`, idxFile);
  console.log(`${id}: ${entries.length} series · ${Object.keys(keys).length} keys · through ${through || '—'} · ${(Buffer.byteLength(body) / 1048576).toFixed(1)} MB`);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const todo = args.length ? args : Object.keys(MARKETS);
for (const id of todo) {
  try { build(id); } catch (e) { console.error(`${id}: ${e.message}`); }
}
