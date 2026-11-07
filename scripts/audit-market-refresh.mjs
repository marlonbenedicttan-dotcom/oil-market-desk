// Refuse to publish a Hong Kong or Australia build that lost companies, statements or chart history.
//
// The build writes before the workflow commits. A rate-limited Yahoo run returns a one-point series for
// most codes; a throttled stockanalysis run drops a company's statements; and the HKEX report is
// occasionally posted incomplete. Any of those would ship a smaller market that still looks current,
// so compare the new file with the version in git and fail before the workflow stages anything.
//
//   node scripts/audit-market-refresh.mjs au
//   node scripts/audit-market-refresh.mjs hk
//   node scripts/audit-market-refresh.mjs          # both
//
// Read-only. Exit 1 means "do not publish this build".

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MARKETS = {
  au: {
    label: 'Australia',
    file: 'data/australia.json',
    // The ASX universe moves by a handful of listings a week; 3% is already hundreds of names.
    minCompanies: 0.97,
  },
  hk: {
    label: 'Hong Kong',
    file: 'data/hongkong.json',
    // The HKEX report carries ~1,900 main-board companies and the incomplete 2026-11-03 page lost 7.7%.
    minCompanies: 0.98,
  },
  in: {
    label: 'India',
    file: 'data/india.json',
    // The NIFTY 500 is reconstituted twice a year; a handful of names change, not fifty.
    minCompanies: 0.95,
  },
  id: {
    label: 'Indonesia',
    file: 'data/indonesia.json',
    // The IDX list moves by a handful of listings a month; a 3% drop means a throttled crawl, not delistings.
    minCompanies: 0.97,
  },
  br: {
    label: 'Brazil',
    file: 'data/brazil.json',
    // B3 adds/delists a handful a quarter; a 3% drop is a throttled class-selection pass.
    minCompanies: 0.97,
  },
};

const requested = (process.argv[2] || '').toLowerCase();
if (requested && !MARKETS[requested]) {
  console.error('usage: node scripts/audit-market-refresh.mjs [au|hk|in|id|br]');
  process.exit(2);
}

const count = (list, fn) => list.filter(fn).length;
const latestPrice = (list) => list.map((c) => c.priceDate).filter(Boolean).sort().pop() || null;
const totalCap = (d) => (d.market && d.market.totalCap) || 0;

function run(id) {
  const spec = MARKETS[id];
  const now = JSON.parse(readFileSync(spec.file, 'utf8'));
  let before = null;
  try {
    before = JSON.parse(execFileSync('git', ['show', `HEAD:${spec.file}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch {
    console.log(`${spec.label}: no previous ${spec.file} in HEAD — first build, nothing to compare`);
    return 0;
  }

  const rows = Array.isArray(now.companies) ? now.companies : [];
  const was = Array.isArray(before.companies) ? before.companies : [];
  const priced = (list) => count(list, (c) => c.price > 0);
  const withPe = (list) => count(list, (c) => c.pe != null);
  const withHistory = (list) => count(list, (c) => c.chg6m != null || c.chg1y != null);

  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok, detail });

  check(
    'companies',
    rows.length >= was.length * spec.minCompanies,
    `${rows.length} now · ${was.length} in HEAD · floor ${Math.floor(was.length * spec.minCompanies)} (${Math.round(spec.minCompanies * 100)}%)`,
  );
  check('priced companies', priced(rows) >= priced(was) * 0.98, `${priced(rows)} now · ${priced(was)} in HEAD`);
  check(
    'companies with a P/E (statement coverage)',
    withPe(rows) >= withPe(was) * 0.85,
    `${withPe(rows)} now · ${withPe(was)} in HEAD`,
  );
  check(
    'companies with a 6M/1Y return (chart history)',
    withHistory(rows) >= withHistory(was) * 0.75,
    `${withHistory(rows)} now · ${withHistory(was)} in HEAD`,
  );
  check(
    'throttled this run',
    !(now.audit && now.audit.throttled > 0),
    `${(now.audit && now.audit.throttled) || 0} companies — a throttle is not a missing page; rerun to fill it`,
  );
  check(
    'latest price session',
    !latestPrice(was) || (latestPrice(rows) || '') >= latestPrice(was),
    `${latestPrice(rows) || 'none'} now · ${latestPrice(was) || 'none'} in HEAD (never goes backwards)`,
  );
  check(
    'total market cap',
    !totalCap(before) || totalCap(now) >= totalCap(before) * 0.7,
    `${Math.round(totalCap(now) / 1e9)}B now · ${Math.round(totalCap(before) / 1e9)}B in HEAD`,
  );
  if (id === 'hk') {
    check(
      'HKEX session',
      !before.session || !now.session || String(now.session) >= String(before.session),
      `${now.session || 'none'} now · ${before.session || 'none'} in HEAD`,
    );
  }

  console.log(`\n${spec.label}`);
  for (const c of checks) console.log(`${c.ok ? 'ok   ' : 'FAIL '} ${c.label.padEnd(44)} ${c.detail}`);

  if (checks.some((c) => !c.ok)) {
    console.error(`\nrefusing to publish a collapsed ${spec.label} build — keeping the previous dataset`);
    console.error('Nothing was staged. Rerun the workflow; the cache makes the second pass fill the tail.');
    return 1;
  }
  console.log(`${spec.label} build is complete enough to publish`);
  return 0;
}

const ids = requested ? [requested] : Object.keys(MARKETS);
process.exit(ids.map(run).some((code) => code !== 0) ? 1 : 0);
