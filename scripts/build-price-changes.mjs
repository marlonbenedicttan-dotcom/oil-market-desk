// Price change over today, six months and year-to-date.
//
// The daily closes are already cached for the valuation bands, so these are computed from the same data
// with no extra requests. "Today" is the last two closes in the series — the most recent trading day.
//
//   node scripts/build-price-changes.mjs

import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The chart is the only source for the 6M and YTD windows, so a stale one is a wrong number. Refresh
// anything older than a session instead of trusting whatever is on disk.
async function chartFor(ticker) {
  const f = join(CHARTS, `${ticker}.json`);
  if (existsSync(f)) {
    try {
      if (Date.now() - statSync(f).mtimeMs < 18 * 3600e3) {
        const rows = JSON.parse(readFileSync(f, 'utf8'));
        if (Array.isArray(rows) && rows.length > 1) return rows;
      }
    } catch { /* refetch */ }
  }
  const sym = String(ticker).replace('-', '.');
  try {
    const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/chart?assetclass=stocks&fromdate=2019-01-01&todate=${new Date().toISOString().slice(0, 10)}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const rows = j?.data?.chart;
    if (!Array.isArray(rows) || !rows.length) return null;
    const slim = rows.map((r) => [r.z?.dateTime, r.y]).filter((x) => x[0] && x[1] != null);
    writeFileSync(f, JSON.stringify(slim));
    return slim;
  } catch { return null; }
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let built = 0;
for (const c of data.companies) {
  if (!c.ticker) continue;
  const rows = await chartFor(c.ticker);
  if (!Array.isArray(rows) || rows.length < 2) continue;
  await sleep(60);

  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const lastIso = toIso(last[0]);
  const lastT = Date.parse(lastIso);

  const six = near(rows, lastT - 182 * DAY);
  // Year-to-date: the last close of the previous calendar year.
  const jan1 = Date.parse(`${new Date(lastIso).getUTCFullYear()}-01-01`);
  const ytdBase = near(rows, jan1 - 5 * DAY);

  // Price, its date and the daily change belong to refresh-prices (the live quote). This script only
  // supplies the two windows that need history, and uses the live price as the numerator.
  const px = c.price != null ? c.price : Number(last[1]);
  c.chg6m = six ? +(((px / six.v) - 1) * 100).toFixed(2) : null;
  c.chgYtd = ytdBase ? +(((px / ytdBase.v) - 1) * 100).toFixed(2) : null;
  built++;
}

console.log(`price changes for ${built} companies`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
