// Mark preferred share classes in an already-built japan.json and redo the market aggregates.
//
// build-japan.mjs now does this itself; this exists so the committed file can be corrected without a
// J-Quants key, and it is idempotent if the build already ran.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'japan.json');
const jp = JSON.parse(readFileSync(FILE, 'utf8'));
const rows = jp.companies || [];

let marked = 0;
for (const c of rows) {
  const isClass = /preferred stock|shares of preferred/i.test(c.name || '');
  if (isClass && !c.shareClass) marked++;
  c.shareClass = isClass;
  if (isClass && c.code) c.ticker = String(c.code);   // keep it unique against the common line
}
const listed = rows.filter((c) => !c.shareClass);
const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
};
const m = jp.market || {};
const bySector = new Map();
for (const c of listed) {
  if (!bySector.has(c.sector)) bySector.set(c.sector, []);
  bySector.get(c.sector).push(c);
}
jp.market = {
  ...m,
  companies: listed.length,
  totalCap: listed.reduce((a, c) => a + (c.marketCap || 0), 0),
  medianPe: median(listed.map((c) => c.pe)),
  medianPb: median(listed.map((c) => c.pb)),
  medianRoe: median(listed.map((c) => c.roe)),
  medianYield: median(listed.map((c) => (c.dividend ? c.dividend.yield : null))),
  belowBook: listed.filter((c) => c.pb != null && c.pb < 1).length,
  advancing: listed.filter((c) => c.chg1d != null && c.chg1d > 0).length,
  declining: listed.filter((c) => c.chg1d != null && c.chg1d < 0).length,
  upYtd: listed.filter((c) => c.chgYtd != null && c.chgYtd > 0).length,
  sectors: [...bySector].map(([name, list]) => ({
    name, count: list.length,
    cap: list.reduce((a, c) => a + (c.marketCap || 0), 0),
    pe: median(list.map((c) => c.pe)),
    pb: median(list.map((c) => c.pb)),
    roe: median(list.map((c) => c.roe)),
    yield: median(list.map((c) => (c.dividend ? c.dividend.yield : null))),
    chgYtd: median(list.map((c) => c.chgYtd)),
  })).sort((a, b) => b.cap - a.cap),
};

writeFileSync(FILE + '.tmp', JSON.stringify(jp));
renameSync(FILE + '.tmp', FILE);
console.log(`marked ${marked} new share classes · ${listed.length} companies · total cap ${(jp.market.totalCap / 1e12).toFixed(2)}T`);
