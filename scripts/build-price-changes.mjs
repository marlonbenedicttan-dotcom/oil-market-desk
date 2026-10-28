// Price change over today, six months and year-to-date.
//
// The daily closes are already cached for the valuation bands, so these are computed from the same data
// with no extra requests. "Today" is the last two closes in the series — the most recent trading day.
//
//   node scripts/build-price-changes.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CHARTS = join(ROOT, 'data', 'cache', 'charts');
const DAY = 86400000;

const toIso = (mdY) => {
  const [m, d, y] = String(mdY).split('/').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const near = (rows, target) => {
  let best = null;
  for (const [d, v] of rows) {
    const t = Date.parse(toIso(d));
    const diff = Math.abs(t - target) / DAY;
    if (diff > 12) continue;
    if (!best || diff < best.diff) best = { v, diff, iso: toIso(d) };
  }
  return best;
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let built = 0;
for (const c of data.companies) {
  if (!c.ticker) continue;
  let rows;
  try { rows = JSON.parse(readFileSync(join(CHARTS, `${c.ticker}.json`), 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length < 2) continue;

  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const lastIso = toIso(last[0]);
  const lastT = Date.parse(lastIso);

  const d1 = prev[1] ? ((last[1] / prev[1]) - 1) * 100 : null;
  const six = near(rows, lastT - 182 * DAY);
  const d6m = six ? ((last[1] / six.v) - 1) * 100 : null;
  // Year-to-date: the last close of the previous calendar year.
  const jan1 = Date.parse(`${new Date(lastIso).getUTCFullYear()}-01-01`);
  const ytdBase = near(rows, jan1 - 5 * DAY);
  const dYtd = ytdBase ? ((last[1] / ytdBase.v) - 1) * 100 : null;

  c.priceAsOf = lastIso;
  c.price = +Number(last[1]).toFixed(4);
  c.chg1d = d1 == null ? null : +d1.toFixed(2);
  c.chg6m = d6m == null ? null : +d6m.toFixed(2);
  c.chgYtd = dYtd == null ? null : +dYtd.toFixed(2);
  built++;
}

console.log(`price changes for ${built} companies`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
