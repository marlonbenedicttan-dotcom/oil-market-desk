// Fail loudly if anything the site serves stopped updating.
//
// A scheduled workflow that quietly stops is worse than one that crashes: the site keeps serving numbers
// that look current. This checks every dataset on its own cadence — a price session is late after one
// missed trading day, an annual IMF snapshot is not — and it reads the price dates themselves, because a
// build can rewrite `updated` without bringing a new quote. It also asks the live site whether the
// commodity feeds are current, because those are fetched at request time and never appear in the repo.
//
//   node scripts/check-freshness.mjs
//   MAX_AGE_HOURS=12 node scripts/check-freshness.mjs      # tighten the three market files
//   MARKET_URL=http://localhost:4173 node scripts/check-freshness.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionStats, sessionsBehind, buildGapStale, buildGapHours } from './price-freshness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = process.env.MARKET_URL || 'https://oil-market-desk.onrender.com';
const DAY = 864e5;
const now = Date.now();

// Hours a dataset may lag before it counts as stale. Each limit is the longest scheduled gap plus a
// session: companies-daily runs Tue–Sat 08:00 UTC, so Saturday→Tuesday is 96h; Taiwan runs Mon–Fri
// (72h) and the Hong Kong/Australia/India/Indonesia/Brazil/South Africa jobs run Mon–Fri (72h). A flat
// 36h was reporting every scheduled weekend gap as a stopped job. The dedicated check still catches a
// genuinely missed run: a Tuesday failure leaves Wednesday >108h old.
const DATASETS = [
  ['US prices & fundamentals', 'companies.json', 72],
  ['Japan', 'japan.json', 72],
  ['Korea', 'korea.json', 72],
  ['Taiwan', 'taiwan.json', 84],
  ['Hong Kong', 'hongkong.json', 84],
  ['Australia', 'australia.json', 84],
  ['India', 'india.json', 84],
  ['Indonesia', 'indonesia.json', 84],
  ['Brazil', 'brazil.json', 84],
  ['South Africa', 'southafrica.json', 84],
  ['US filing tracker', 'filings-state.json', 36],
  ['Calendar events', 'events.json', 72],
  ['Valuation history', 'valuation.json', 24 * 10],
];

const rows = [];
const add = (label, ok, msg, kind = 'data') => rows.push({ label, ok, msg, kind });

for (const [label, file, maxH] of DATASETS) {
  const limit = Number(process.env.MAX_AGE_HOURS) && /prices|Japan|Korea|Taiwan|Hong Kong|Australia|India|Indonesia|Brazil|South Africa|filing/.test(label)
    ? Number(process.env.MAX_AGE_HOURS) : maxH;
  try {
    const d = JSON.parse(readFileSync(join(ROOT, 'data', file), 'utf8'));
    const t = Date.parse(d.updated || d.fetched || '');
    if (!Number.isFinite(t)) { add(label, false, 'no updated timestamp'); continue; }
    const h = (now - t) / 36e5;
    add(label, h <= limit, `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z · ${h.toFixed(1)}h old · limit ${limit}h`);
  } catch (e) { add(label, false, `unreadable: ${e.message}`); }
}

// `updated` only proves the job ran. These ask the prices themselves: which session the market is on,
// and how many lines are still behind it. South Africa rewrote its file nightly for days while every
// quote stayed on the same session, and Australia ships ~20% of the ASX a session behind every day —
// both passed the timestamp check above.
const PRICE_MARKETS = [
  ['US prices', 'companies.json'],
  ['Japan prices', 'japan.json'],
  ['Korea prices', 'korea.json'],
  ['Taiwan prices', 'taiwan.json'],
  ['Hong Kong prices', 'hongkong.json'],
  ['Australia prices', 'australia.json'],
  ['India prices', 'india.json'],
  ['Indonesia prices', 'indonesia.json'],
  ['Brazil prices', 'brazil.json'],
  ['South Africa prices', 'southafrica.json'],
];
const today = new Date(now).toISOString().slice(0, 10);
for (const [label, file] of PRICE_MARKETS) {
  try {
    const d = JSON.parse(readFileSync(join(ROOT, 'data', file), 'utf8'));
    const s = sessionStats(Array.isArray(d.companies) ? d.companies : []);
    if (!s.session) { add(label, false, 'no priced company'); continue; }
    const lag = sessionsBehind(s.session, today);
    const buildH = Number.isFinite(Date.parse(d.updated)) ? (now - Date.parse(d.updated)) / 36e5 : null;
    // A build can run every night and still carry yesterday's (or last week's) prices. That is what
    // happened when a fundamentals-only pass rewrote `updated`: the file looked fresh while every
    // quote was days old. Compare the session age with the build age; more than 60h apart means the
    // build did not bring a new session.
    const staleGap = buildGapStale(s.session, d.updated, now);
    // Two different lags, two different owners:
    //   missed    — we have no bar for the session: a partial fetch, and ours to fix.
    //   no close  — the source sent the bar but not the close: nothing a retry can do. Those rows are
    //               reported but skipped, so a lagging exchange cannot paint the whole monitor red.
    // Holidays are not modelled, so a shut market can read one session old; a fresh build with that
    // one-session lag is still allowed. A lag plus a much newer build is not: the build should have
    // carried the missing session.
    const ours = lag <= 1 && !staleGap && s.behindShare <= 0.10;
    const source = s.noCloseShare > 0.50;
    add(label, ours,
      `session ${s.session} · ${lag} session${lag === 1 ? '' : 's'} old · ${s.behind} missed (${(s.behindShare * 100).toFixed(1)}%)`
        + ` · ${s.noClose} no close yet (${(s.noCloseShare * 100).toFixed(1)}%)`
        + (buildH == null ? ' · no build timestamp' : ` · build ${buildH.toFixed(1)}h old`)
        + (staleGap ? ` · prices ${buildGapHours(s.session, d.updated, now).toFixed(0)}h older than the build` : ''),
      ours && source ? 'skip' : 'data');
  } catch (e) { add(label, false, `unreadable: ${e.message}`); }
}

// The two upstream snapshots are not on a clock, so age is the wrong question. The IMF publishes a WEO
// vintage about twice a year and the PSD balance once a month, and both fetchers now leave the file
// untouched when nothing moved — so `updated` is the last real change, not the last run. An age limit
// would cry wolf between vintages and stay quiet the one time a vintage was wrong. Ask about content:
// is the snapshot on the year it should be, and does the coverage still hold?
const expectYear = new Date(now).getUTCFullYear() - 1;
try {
  const m = JSON.parse(readFileSync(join(ROOT, 'data', 'macro.json'), 'utf8'));
  const ids = Object.keys(m.countries || {});
  // One year of slack: in early January the previous year's balance has not always been revised in yet.
  add('Macro vintage (IMF)', m.maxYear >= expectYear - 1,
    `maxYear ${m.maxYear} (expect ${expectYear}) · ${ids.length} countries · updated ${String(m.updated).slice(0, 10)}`);
  // A country whose newest figure predates maxYear is serving an older year. The app backfills some of
  // these from the World Bank at request time; this row is here so the gap is never invisible.
  const lag = Object.keys(m.gaps || {});
  add('Macro coverage gaps', true,
    lag.length ? `${lag.length} countries lag maxYear: ${lag.slice(0, 6).join(', ')}${lag.length > 6 ? '…' : ''} (backfilled live)` : 'every country reaches maxYear',
    'skip');
} catch (e) { add('Macro vintage (IMF)', false, `unreadable: ${e.message}`); }

// USDA feeds the crop tightness score at 0.5 weight. It had no check at all while a LaunchAgent on a
// laptop owned it, so a stopped job looked exactly like a quiet one.
try {
  const u = JSON.parse(readFileSync(join(ROOT, 'data', 'usda.json'), 'utf8'));
  const cs = Object.entries(u.commodities || {});
  const newest = cs.map(([, c]) => c.marketYear).filter(Boolean).sort().pop();
  // The fetcher maps 10 commodities; fewer means a download or parse silently lost one.
  add('USDA vintage (PSD)', cs.length >= 10,
    `${cs.length} commodities · newest market year ${newest ?? 'none'} · updated ${String(u.updated).slice(0, 10)}`);
} catch (e) { add('USDA vintage (PSD)', false, `unreadable: ${e.message}`); }


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
