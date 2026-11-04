// Re-derive the Korea ratios and growth fields from the committed annual/interim reports.
//
// The full `build-korea.mjs` needs a DART key and re-fetches every filing. When only the maths change
// (a ratio definition, a growth window), the reports already in `data/korea.json` are enough — this
// keeps the operation offline and repeatable.
//
//   node scripts/rederive-korea.mjs
//
// Read-only against the source; rewrites data/korea.json in place.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deriveKorea } from './derive-korea.mjs';
import { koreaList } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'korea.json');
const LIST = join(ROOT, 'data', 'korea-list.json');
const data = JSON.parse(readFileSync(OUT, 'utf8'));
const fx = typeof data.fx === 'number' ? data.fx : (data.fx && data.fx.rate) || null;
if (!Array.isArray(data.companies) || !data.companies.length) {
  console.error('data/korea.json has no companies');
  process.exit(1);
}

let out = deriveKorea({ companies: data.companies, fx });
out.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));

// A company whose newest report is over 450 days old is not a current market quote for ratios.
const STALE_DAYS = 450;
const asOf = new Date();
const stale = out.filter((c) => {
  const end = (c.reports || []).filter((r) => r.end).map((r) => r.end).sort().at(-1);
  return end && (asOf - new Date(end)) / 864e5 > STALE_DAYS;
});
const staleTickers = new Set(stale.map((c) => c.ticker));
out = out.filter((c) => !staleTickers.has(c.ticker));

const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
};
const market = {
  companies: out.length,
  totalCap: out.reduce((a, c) => a + (c.marketCap || 0), 0),
  medianPe: median(out.map((c) => c.pe)),
  medianPb: median(out.map((c) => c.pb)),
  medianRoe: median(out.map((c) => c.roe)),
  belowBook: out.filter((c) => c.pb != null && c.pb < 1).length,
  advancing: out.filter((c) => (c.chg1d || 0) > 0).length,
  declining: out.filter((c) => (c.chg1d || 0) < 0).length,
  upYtd: out.filter((c) => (c.chgYtd || 0) > 0).length,
  sectors: [...out.reduce((m, c) => m.set(c.sector, [...(m.get(c.sector) || []), c]), new Map())]
    .map(([name, list]) => ({
      name, count: list.length,
      cap: list.reduce((a, c) => a + (c.marketCap || 0), 0),
      pe: median(list.map((c) => c.pe)),
      pb: median(list.map((c) => c.pb)),
      roe: median(list.map((c) => c.roe)),
      payout: median(list.map((c) => c.payoutYield)),
      chgYtd: median(list.map((c) => c.chgYtd)),
    }))
    .sort((a, b) => b.cap - a.cap),
};
const next = {
  ...data,
  updated: new Date().toISOString(),
  market,
  audit: {
    ...(data.audit || {}),
    stale: Math.max(stale.length, data.audit?.stale || 0),
    staleCodes: stale.length ? stale.map((c) => ({ ticker: c.ticker, name: c.name, end: (c.reports || []).filter((r) => r.end).map((r) => r.end).sort().at(-1) })) : (data.audit?.staleCodes || []),
  },
  companies: out,
};
writeFileSync(OUT, JSON.stringify(next));
writeFileSync(LIST, JSON.stringify(koreaList(next)));
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-company-details.mjs'), 'kr'], { stdio: 'inherit' });
console.log(`${out.length} Korean companies re-derived from the committed reports`);
