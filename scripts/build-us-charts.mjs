// Build the US price series the company chart reads, so the chart never depends on a live Yahoo call.
//
// The chart used to be fetched from Yahoo at request time. Yahoo rate-limits this host, and one month and
// six months came back with a single point for every company — the graph simply did not draw. The daily
// closes are already cached from Nasdaq for the valuation windows, so the chart is built from those and
// committed: ~500 points per ticker (daily for the last year, weekly before that), about 2 MB in total.
//
//   node scripts/build-us-charts.mjs
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CHARTS = join(ROOT, 'data', 'cache', 'charts');
const OUT = join(ROOT, 'data', 'us-charts.json');
const DAY = 86400000;

const toIso = (mdY) => {
  const [m, d, y] = String(mdY).split('/').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const out = {};
let built = 0, skipped = 0;
for (const c of data.companies) {
  if (!c.ticker) continue;
  const f = join(CHARTS, `${c.ticker}.json`);
  if (!existsSync(f)) { skipped++; continue; }
  let rows;
  try { rows = JSON.parse(readFileSync(f, 'utf8')); } catch { skipped++; continue; }
  if (!Array.isArray(rows) || rows.length < 5) { skipped++; continue; }

  const dated = rows
    .filter((r) => Array.isArray(r) && r[0] && r[1] != null)
    .map((r) => [toIso(r[0]), +r[1]])
    .sort((a, b) => a[0].localeCompare(b[0]));

  // Daily for the last 400 days, weekly before that — enough for every range the page offers.
  const cutoff = new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10);
  const kept = [];
  let lastWeekly = null;
  for (const [d, v] of dated) {
    if (d >= cutoff) { kept.push([d, v]); lastWeekly = null; continue; }
    if (!lastWeekly || Date.parse(d) - Date.parse(lastWeekly) >= 6.5 * DAY) { kept.push([d, v]); lastWeekly = d; }
    else kept[kept.length - 1] = [d, v];   // keep the last close of the week
  }
  out[c.ticker] = kept;
  built++;
}

writeFileSync(OUT + '.tmp', JSON.stringify({ updated: new Date().toISOString().slice(0, 10), series: out }));
renameSync(OUT + '.tmp', OUT);
const size = JSON.stringify(out).length;
console.log(`charts for ${built} companies · ${skipped} without a cache · ${(size / 1024 / 1024).toFixed(1)} MB`);
