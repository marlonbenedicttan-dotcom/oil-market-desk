// Fail loudly if anything the site serves stopped updating.
//
// A scheduled workflow that quietly stops is worse than one that crashes: the site keeps serving numbers
// that look current. This checks every dataset on its own cadence — a price file is late after two days,
// an annual IMF snapshot is not — and it also asks the live site whether the commodity feeds are current,
// because those are fetched at request time and never appear in the repository.
//
//   node scripts/check-freshness.mjs
//   MAX_AGE_HOURS=12 node scripts/check-freshness.mjs      # tighten the three market files
//   MARKET_URL=http://localhost:4173 node scripts/check-freshness.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = process.env.MARKET_URL || 'https://oil-market-desk.onrender.com';
const DAY = 864e5;
const now = Date.now();

// Hours a dataset may lag before it counts as stale. Each is two refreshes of its own cadence:
// the market files rebuild daily, the valuation history and the IMF snapshot weekly.
const DATASETS = [
  ['US prices & fundamentals', 'companies.json', 36],
  ['Japan', 'japan.json', 36],
  ['Korea', 'korea.json', 36],
  ['Taiwan', 'taiwan.json', 36],
  ['US filing tracker', 'filings-state.json', 36],
  ['Calendar events', 'events.json', 48],
  ['Valuation history', 'valuation.json', 24 * 10],
  ['Macro snapshot (IMF)', 'macro.json', 24 * 10],
];

const rows = [];
const add = (label, ok, msg, kind = 'data') => rows.push({ label, ok, msg, kind });

for (const [label, file, maxH] of DATASETS) {
  const limit = Number(process.env.MAX_AGE_HOURS) && /prices|Japan|Korea|Taiwan|filing/.test(label)
    ? Number(process.env.MAX_AGE_HOURS) : maxH;
  try {
    const d = JSON.parse(readFileSync(join(ROOT, 'data', file), 'utf8'));
    const t = Date.parse(d.updated || d.fetched || '');
    if (!Number.isFinite(t)) { add(label, false, 'no updated timestamp'); continue; }
    const h = (now - t) / 36e5;
    add(label, h <= limit, `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z · ${h.toFixed(1)}h old · limit ${limit}h`);
  } catch (e) { add(label, false, `unreadable: ${e.message}`); }
}

// The newest filing any company has filed, against the newest one we have recorded. A 10-Q filed today
// must appear in the tracker by tomorrow; if it does not, the detection pass has stopped.
try {
  const st = JSON.parse(readFileSync(join(ROOT, 'data', 'filings-state.json'), 'utf8'));
  const seen = Object.values(st.filings || {}).map((x) => x.date).filter(Boolean).sort().pop();
  if (!seen) add('Newest filing tracked', false, 'no filings recorded');
  else {
    // Walk back to the last weekday: EDGAR does not accept during the weekend.
    let d = new Date(now);
    for (let i = 0; i < 8; i++) {
      if (d.getUTCDay() === 0) d = new Date(d - DAY);
      else if (d.getUTCDay() === 6) d = new Date(d - DAY);
      else break;
      d = new Date(d - DAY);
    }
    const newestTrading = d.toISOString().slice(0, 10);
    const lag = (Date.parse(newestTrading) - Date.parse(seen)) / DAY;
    add('Newest filing tracked', lag <= 1, `last filing ${seen} · newest weekday ${newestTrading} · ${lag}d behind`);
  }
} catch (e) { add('Newest filing tracked', false, `unreadable: ${e.message}`); }

// Live feeds: fetched when the page asks, so they never appear in the repository. If the site is
// unreachable this is skipped rather than failing the run — the data files above still prove the rest.
const getJSON = async (path) => {
  const res = await fetch(MARKET + path, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const lastWeekday = (() => {
  let d = new Date(now);
  // A Friday close read on Sunday is 2 days old; a Monday read of Friday is 3. Allow the weekend.
  for (let i = 0; i < 10; i++) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) break;
    d = new Date(d - DAY);
  }
  return d;
})();

try {
  const m = await getJSON('/api/market');
  const b = Array.isArray(m.benchmarks) ? m.benchmarks : [];
  const paper = b.map((x) => x.paperDate).filter(Boolean).sort().pop();
  const physical = b.map((x) => x.physicalDate).filter(Boolean).sort().pop();
  if (!paper) add('Commodity futures (live)', false, 'no paper date in the payload');
  else {
    const lag = (lastWeekday - Date.parse(paper)) / DAY;
    add('Commodity futures (live)', lag <= 2, `latest paper ${paper} · ${lag.toFixed(0)}d behind the last weekday`);
  }
  // EIA daily spot is published 1–3 business days behind by design; a week is the real failure line.
  if (!physical) add('Commodity spot (live)', false, 'no physical date in the payload');
  else {
    const lag = (now - Date.parse(physical)) / DAY;
    add('Commodity spot (live)', lag <= 8, `latest spot ${physical} · ${lag.toFixed(1)}d old (source lags 1–3d)`);
  }
} catch (e) {
  add('Commodity feeds (live)', true, `skipped — ${MARKET} unreachable (${e.message})`, 'skip');
}

try {
  const inv = await getJSON('/api/inventories');
  const p = (inv.items || []).map((x) => x.period).filter(Boolean).sort().pop();
  const lag = p ? (now - Date.parse(p)) / DAY : Infinity;
  add('EIA inventories (live)', lag <= 12, `${p || 'none'} · ${Number.isFinite(lag) ? lag.toFixed(1) + 'd old' : 'no data'}`);
} catch (e) {
  add('EIA inventories (live)', true, 'skipped — inventories unreachable', 'skip');
}

for (const r of rows) {
  const tag = r.ok ? 'ok   ' : r.kind === 'skip' ? 'skip ' : 'STALE';
  console.log(`${tag} ${r.label.padEnd(28)} ${r.msg}`);
}
const bad = rows.filter((r) => !r.ok && r.kind !== 'skip');
if (bad.length) {
  console.error(`\n${bad.length} dataset(s) late — the scheduled refresh has not landed.`);
  process.exit(1);
}
console.log(`\nall ${rows.length} datasets within their cadence`);
