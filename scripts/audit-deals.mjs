// Deal-store audit: can anything wrong reach the M&A brief?
//
// The brief only shows deals whose announcement or status change is fresh, so the store's integrity is
// what keeps old or malformed rows off it. This checks parties, dates, duplicates, event order and the
// freshness gate itself.
//
//   node scripts/audit-deals.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = JSON.parse(readFileSync(join(ROOT, 'data', 'deals-store.json'), 'utf8'));
const deals = store.deals || [];
const TODAY = new Date().toISOString().slice(0, 10);
const issues = [];

const GENERIC = /^(?:a |an |the )?(?:competitor|rival|peer|company|firm|startup|buyer|seller|target|entity|business|group|partner|operator|provider|maker|manufacturer)$/i;
const RESIDUE = /(Item\s+\d+[A-Z]?\.|PART\s+I{1,3}\b|Mine Safety Disclosures|Table of Contents)/i;

console.log(`DEAL AUDIT · ${deals.length} deals · ${deals.filter((d) => d.value).length} priced · updated ${String(store.updated || '').slice(0, 10)}\n`);

// --- parties ---------------------------------------------------------------
const noParty = deals.filter((d) => !d.target && !d.acquirer);
if (noParty.length) issues.push(`${noParty.length} deals with neither party named`);

const generic = deals.filter((d) => d.target && GENERIC.test(String(d.target).trim()));
if (generic.length) issues.push(`${generic.length} generic targets: ${generic.slice(0, 5).map((d) => d.target).join(' ')}`);

const prose = deals.filter((d) => (d.target && RESIDUE.test(d.target)) || (d.acquirer && RESIDUE.test(d.acquirer)));
if (prose.length) issues.push(`${prose.length} party names look like prose`);

const selfDeal = deals.filter((d) => d.target && d.acquirer && String(d.target).toLowerCase() === String(d.acquirer).toLowerCase());
if (selfDeal.length) issues.push(`${selfDeal.length} deals where acquirer = target`);

// --- dates -----------------------------------------------------------------
const future = deals.filter((d) => (d.date || '') > TODAY || (d.lastSeen || '') > TODAY);
if (future.length) issues.push(`${future.length} deals dated in the future: ${future.slice(0, 5).map((d) => `${d.target} ${d.date}`).join(' ')}`);

const ancient = deals.filter((d) => d.date && d.date < '2020-01-01');
if (ancient.length) issues.push(`${ancient.length} deals dated before 2020`);

const backwards = deals.filter((d) => d.date && d.lastSeen && d.lastSeen < d.date);
if (backwards.length) issues.push(`${backwards.length} deals last seen before they were announced`);

// --- events ----------------------------------------------------------------
let badEvents = 0;
for (const d of deals) {
  const evs = d.events || [];
  if (!evs.length) continue;
  const dates = evs.map((e) => e.date).filter(Boolean);
  const sorted = [...dates].sort();
  if (dates.join() !== sorted.join()) badEvents++;
  if (evs.some((e) => e.date && e.date > TODAY)) badEvents++;
}
if (badEvents) issues.push(`${badEvents} deals with out-of-order or future events`);

// --- duplicates ------------------------------------------------------------
const keys = new Map();
for (const d of deals) {
  const k = d.key || `${d.target}|${d.acquirer}`;
  keys.set(k, (keys.get(k) || 0) + 1);
}
const dupes = [...keys.entries()].filter(([, n]) => n > 1);
if (dupes.length) issues.push(`${dupes.length} duplicate deal keys`);

// --- what the brief would show --------------------------------------------
const freshFrom = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
const brief = deals.filter((d) => {
  const ev = (d.events || [])[(d.events || []).length - 1] || null;
  return (d.date && d.date >= freshFrom) || (ev && ev.status && ev.status !== 'announced' && (ev.date || '') >= freshFrom);
});
console.log(`brief-eligible (fresh in the last 2 days): ${brief.length}`);
for (const d of brief.slice(0, 6)) console.log(`  ${d.date} ${d.acquirer || '—'} → ${d.target || '—'} (${d.status}, ${d.value ? '$' + d.value + 'm' : 'no value'})`);
if (brief.some((d) => !d.target && !d.acquirer)) issues.push('a brief-eligible deal has no party named');

// --- results ---------------------------------------------------------------
console.log(`\n${issues.length} deal issues`);
for (const i of issues.slice(0, 20)) console.log('  ' + i);
if (issues.length > 20) console.log(`  … ${issues.length - 20} more`);
