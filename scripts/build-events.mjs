// Company events for the calendar: expected earnings, recent deals, restatements.
//
// Earnings dates are estimated from each company's own reporting habit — the gap between its quarter end
// and the day it filed — not from a generic "+30 days". Every event carries a basis: `expected` (derived
// from cadence) or `confirmed` (it happened).
//
//   node scripts/build-events.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DEALS = join(ROOT, 'data', 'deals-store.json');
const OUT = join(ROOT, 'data', 'events.json');
const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const today = Date.now();
const horizon = today + 120 * DAY;
const recent = today - 30 * DAY;

const events = [];
let estimated = 0;

for (const c of data.companies) {
  if (!c.ticker || c.shareClass) continue;
  const lf = c.lastFiling;
  if (!lf?.period || !lf?.filed) continue;

  const period = Date.parse(lf.period);
  const filed = Date.parse(lf.filed);
  if (!Number.isFinite(period) || !Number.isFinite(filed)) continue;

  // The company's own lag, clamped to a sane range so one odd filing cannot skew the estimate.
  const lag = Math.min(60, Math.max(18, Math.round((filed - period) / DAY)));
  let nextEnd = period + 91 * DAY;
  let expected = nextEnd + lag * DAY;
  // If that date is already past, the next quarter is the one after.
  while (expected < today - 7 * DAY) { nextEnd += 91 * DAY; expected = nextEnd + lag * DAY; }
  if (expected > horizon) continue;

  const days = Math.round((expected - today) / DAY);
  c.nextReport = { date: iso(expected), lag, basis: 'expected' };
  events.push({
    date: iso(expected),
    kind: 'earnings',
    ticker: c.ticker,
    name: c.name,
    label: `${c.ticker} · ${lf.form === '10-K' ? 'Q1' : 'quarterly'} report expected`,
    detail: `period ends ${iso(nextEnd)} · filed ${lag} days after quarter end, historically`,
    basis: 'expected',
    weight: c.indexWeight || 0,
    days,
  });
  estimated++;
}

// Deals and restatements are facts, not estimates.
try {
  const store = JSON.parse(readFileSync(DEALS, 'utf8'));
  for (const d of (store.deals || [])) {
    const t = Date.parse(d.date);
    if (!Number.isFinite(t) || t < recent || t > today + 7 * DAY) continue;
    events.push({
      date: iso(t), kind: 'deal', ticker: null,
      label: `${d.acquirer || '—'} → ${d.target || '—'}`,
      detail: `${d.status || 'announced'}${d.value ? ` · $${d.value}m` : ''}`,
      basis: 'confirmed', weight: 0, days: Math.round((t - today) / DAY),
    });
  }
} catch { /* no store */ }

for (const c of data.companies) {
  const r = c.restatement;
  if (!r?.filed) continue;
  const t = Date.parse(r.filed);
  if (!Number.isFinite(t) || t < recent) continue;
  events.push({
    date: iso(t), kind: 'restatement', ticker: c.ticker, name: c.name,
    label: `${c.ticker} · ${r.form} restated ${Object.keys(r.changes || {}).join(', ')}`,
    detail: 'amended filing', basis: 'confirmed', weight: c.indexWeight || 0,
    days: Math.round((t - today) / DAY),
  });
}

events.sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), events }, null, 1));
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);

console.log(`${estimated} expected earnings dates · ${events.length} events total`);
console.log(events.filter((e) => e.days >= 0 && e.days <= 14).slice(0, 8).map((e) => `  ${e.date} ${e.label}`).join('\n'));
