// Narrow the all-filer company dataset to the US index universe.
//
// Membership comes from the ETF's own published holdings file (SPTM = S&P 1500), so it is the
// index's authoritative list rather than a scrape. Everything else in the dataset is filtered out.
// Members with no usable SEC row are recorded in `universe.absent` — they are never invented.
//
//   node scripts/filter-us-universe.mjs --dry
//   node scripts/filter-us-universe.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHoldings, fetchSecTickers, normalizeTicker, UNIVERSE } from './us-universe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');

const members = await fetchHoldings();
const byTicker = new Map(members.map((m) => [m.ticker, m]));
const sec = await fetchSecTickers();
console.log(`${members.length} ${UNIVERSE.name} constituents from ${UNIVERSE.etf} holdings`);

// A company can be in the index under a different class than the frames build chose (UA vs UAA,
// BRK-A vs BRK-B). Keep the CIK's filings by mapping every index member to its CIK and letting a
// row follow its CIK onto the index ticker, rather than dropping it and losing five years of filings.
const holdingsByCik = new Map();
for (const m of members) {
  const s = sec.get(m.ticker);
  if (!s) continue;
  if (!holdingsByCik.has(s.cik)) holdingsByCik.set(s.cik, []);
  holdingsByCik.get(s.cik).push(m);
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const before = data.companies.length;
const kept = [];
const used = new Set();
for (const c of data.companies) {
  const t = normalizeTicker(c.ticker);
  const own = byTicker.get(t);
  // A direct ticker match only counts when the row is the registrant the SEC maps that ticker to.
  // A name-matched sibling can carry the same ticker under an old CIK (DTE was the live case: the
  // stale CIK won the ticker and five years of the wrong filings came with it).
  const wantCik = own ? sec.get(t)?.cik : null;
  if (own && !used.has(t) && (!wantCik || String(c.cik) === wantCik)) {
    c.ticker = t;
    c.indexWeight = own.weight;
    c.indexName = own.name;
    kept.push(c);
    used.add(t);
    continue;
  }
  // The row's own ticker is not an index member, but its CIK is: put it on the first unused index
  // ticker for that CIK. This is a rename of the same company, not a new listing.
  const target = (holdingsByCik.get(String(c.cik)) || []).find((m) => !used.has(m.ticker));
  if (!target) continue;
  c.ticker = target.ticker;
  c.indexWeight = target.weight;
  c.indexName = target.name;
  kept.push(c);
  used.add(target.ticker);
}

const absent = members
  .filter((m) => !used.has(m.ticker))
  .map((m) => ({ ticker: m.ticker, name: m.name, reason: 'no SEC filing row in the dataset' }));

data.companies = kept;
data.count = kept.length;
data.universe = {
  name: UNIVERSE.name,
  source: UNIVERSE.source,
  index: UNIVERSE.index,
  asOf: new Date().toISOString().slice(0, 10),
  members: members.length,
  kept: kept.length,
  absent,
};
data.updated = new Date().toISOString();

console.log(`companies ${before} → ${kept.length} · absent member rows: ${absent.length}`);
if (absent.length) console.log('  absent:', absent.slice(0, 20).map((a) => a.ticker).join(', ') + (absent.length > 20 ? ' …' : ''));
if (!DRY) { writeFileSync(FILE + '.tmp', JSON.stringify(data)); renameSync(FILE + '.tmp', FILE); console.log('written'); }
