// Refuse to publish a build that lost companies, statements, chart history or price freshness.
//
// The build writes before the workflow commits. A rate-limited Yahoo run returns a one-point series for
// most codes; a throttled stockanalysis run drops a company's statements; and the HKEX report is
// occasionally posted incomplete. Any of those would ship a smaller market that still looks current,
// so compare the new file with the version in git and fail before the workflow stages anything.
//
// The price checks are the same idea applied to quotes. A failed symbol fetch silently reuses the last
// cached series, so a market can keep its size and its statements while a quarter of its prices stay on
// an older session — and one bad cache can even move a price date BACKWARDS. Both are caught here.
//
//   node scripts/audit-market-refresh.mjs au
//   node scripts/audit-market-refresh.mjs hk
//   node scripts/audit-market-refresh.mjs          # every guarded market
//
// The one write it makes is a repair: a company whose build went backwards is put back to the newer
// record already in HEAD, so a stale cache can never un-publish a quote. Exit 1 means "do not publish".

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { barDateOf, companyKey, priceDateOf, sessionStats } from './price-freshness.mjs';

const MARKETS = {
  au: {
    label: 'Australia',
    file: 'data/australia.json',
    details: 'data/australia-companies',
    // The ASX universe moves by a handful of listings a week; 3% is already hundreds of names.
    minCompanies: 0.97,
    // ~20–28% of the ASX has no bar at all for a given session: microcaps that did not trade. Yahoo
    // never prints a bar for them, so this can only be a wide limit — the jump check (a partial fetch
    // moves the cohort) and the daily session-age monitor are what catch a real failure here.
    maxBehind: 0.35, maxJump: 0.09,
  },
  hk: {
    label: 'Hong Kong',
    file: 'data/hongkong.json',
    details: 'data/hongkong-companies',
    // The HKEX report carries ~1,900 main-board companies and the incomplete 2026-11-03 page lost 7.7%.
    minCompanies: 0.98,
    // Lines the statement pass could not rebuild keep their previous record (see restoreMissing),
    // so a normal build carries ~3–8% on an older session; 15% is a real loss of coverage.
    maxBehind: 0.15, maxJump: 0.06,
  },
  in: {
    label: 'India',
    file: 'data/india.json',
    details: 'data/india-companies',
    // The Total Market index is reconstituted twice a year; a handful of names change, not fifty.
    minCompanies: 0.95,
    // India has published 0% behind on every build so far — there is no slack to give it.
    maxBehind: 0.03, maxJump: 0.03,
  },
  id: {
    label: 'Indonesia',
    file: 'data/indonesia.json',
    details: 'data/indonesia-companies',
    // The IDX list moves by a handful of listings a month; a 3% drop means a throttled crawl, not delistings.
    minCompanies: 0.97,
    // 0% on a clean run; the 2026-11-09 build left 3.7% with no bar, which is what this catches.
    maxBehind: 0.10, maxJump: 0.05,
  },
  br: {
    label: 'Brazil',
    file: 'data/brazil.json',
    details: 'data/brazil-companies',
    // B3 adds/delists a handful a quarter; a 3% drop is a throttled class-selection pass.
    minCompanies: 0.97,
    maxBehind: 0.06, maxJump: 0.03,
  },
  za: {
    label: 'South Africa',
    file: 'data/southafrica.json',
    details: 'data/southafrica-companies',
    // The JSE list moves by a handful a quarter; a 3% drop is a throttled statement pass.
    minCompanies: 0.97,
    maxBehind: 0.06, maxJump: 0.03,
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

// A build that re-applies an older cached series overwrites a quote that was already published. Rather
// than ship the older price (or block a whole market over one symbol), keep the previous record: it is
// internally consistent — price, date, market cap and ratios all agree — and the build simply did not
// refresh that line today. The market file and the per-company detail are restored together.
// A resumable build re-fetches what it can and silently omits what it could not: a throttled
// stockanalysis pass dropped 58 Hong Kong companies on 2026-11-10 and 186 the day before, and the
// count guard then refused every evening's publish. Keep the previous record for a company the build
// could not rebuild — it is one day old, not gone — but only while that is a minority of the market,
// so a real collapse still fails.
function restoreMissingCompanies(spec, now, rows, was) {
  const have = new Set(rows.map(companyKey));
  const missing = was.filter((c) => c && companyKey(c) && !have.has(companyKey(c)));
  if (!missing.length || missing.length > was.length * 0.10) return [];
  rows.push(...missing);
  writeFileSync(spec.file, JSON.stringify(now));
  return missing.map(companyKey);
}

function restoreNewerPrices(spec, now, rows, was) {
  const prev = new Map(was.map((c) => [companyKey(c), c]));
  const restored = [];
  for (let i = 0; i < rows.length; i++) {
    const before = prev.get(companyKey(rows[i]));
    const d = priceDateOf(rows[i]);
    const p = before && priceDateOf(before);
    if (!(d && p && d < p)) continue;
    restored.push(`${companyKey(rows[i])} ${d}→${p}`);
    rows[i] = before;
    if (!spec.details) continue;
    const file = `${spec.details}/${companyKey(before)}.json`;
    try {
      writeFileSync(file, execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    } catch { /* no detail file for this code */ }
  }
  if (restored.length) writeFileSync(spec.file, JSON.stringify(now));
  return restored;
}

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
  const restored = restoreNewerPrices(spec, now, rows, was);
  const kept = restoreMissingCompanies(spec, now, rows, was);
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

  // Anything still going backwards here means the restore above could not apply, which is a real failure.
  const wasByKey = new Map(was.map((c) => [companyKey(c), c]));
  const regressed = rows.filter((c) => {
    const prev = wasByKey.get(companyKey(c));
    const d = priceDateOf(c);
    const p = prev && priceDateOf(prev);
    return d && p && d < p;
  });
  check(
    'no company price went backwards',
    regressed.length === 0,
    regressed.length
      ? `${regressed.length}: ${regressed.slice(0, 5).map((c) => `${companyKey(c)} ${priceDateOf(c)} < ${priceDateOf(wasByKey.get(companyKey(c)))}`).join(', ')}${regressed.length > 5 ? '…' : ''}`
      : restored.length
        ? `${restored.length} kept from HEAD: ${restored.slice(0, 5).join(', ')}${restored.length > 5 ? '…' : ''}`
        : 'none',
  );

  // A partial fetch keeps the market's size and statements, so only the price dates reveal it: most
  // lines move to the new session, the ones whose Yahoo request failed stay behind.
  // A carried company was not fetched this run (the source omitted it), so it cannot count as a
  // missed quote. The company/priced checks still see it; only the freshness denominator excludes it.
  const nowPrices = sessionStats(rows.filter((c) => !c.carried));
  const wasPrices = sessionStats(was.filter((c) => !c.carried));
  // The first build after bar dates were introduced has nothing comparable in HEAD: it carries close
  // dates only, so its "behind" count measures something else and the jump would be an artefact.
  const comparable = was.some((c) => c && c.priceBar);
  const jump = comparable ? nowPrices.behindShare - wasPrices.behindShare : 0;
  const partial = nowPrices.behindShare > spec.maxBehind || jump > spec.maxJump;
  check(
    'companies with a bar for the latest session',
    !partial,
    `${nowPrices.onSession}/${nowPrices.total} on ${nowPrices.session} · ${(nowPrices.behindShare * 100).toFixed(1)}% missed`
      + ` · ${(nowPrices.noCloseShare * 100).toFixed(1)}% no close yet`
      + ` (limit ${(spec.maxBehind * 100).toFixed(0)}%, `
      + (comparable ? `+${(spec.maxJump * 100).toFixed(0)}pt on HEAD's ${(wasPrices.behindShare * 100).toFixed(1)}%)` : 'first build with bar dates)'),
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
  if (restored.length) {
    console.log(`kept ${restored.length} newer price${restored.length === 1 ? '' : 's'} from HEAD — the build re-applied an older cached series: ${restored.join(', ')}`);
  }
  if (kept.length) {
    console.log(`kept ${kept.length} compan${kept.length === 1 ? 'y' : 'ies'} from HEAD — the build could not rebuild them this run: ${kept.slice(0, 8).join(', ')}${kept.length > 8 ? '…' : ''}`);
  }
  for (const c of checks) console.log(`${c.ok ? 'ok   ' : 'FAIL '} ${c.label.padEnd(44)} ${c.detail}`);

  // Below the failure line but still wrong: a fifth of the ASX sitting on an older session every day is
  // how this problem hid for so long. Say it out loud on every build so it cannot become background.
  if (nowPrices.behindShare > 0.02) {
    const stragglers = rows.filter((c) => barDateOf(c) && barDateOf(c) < nowPrices.session);
    const byDate = {};
    for (const c of stragglers) byDate[barDateOf(c)] = (byDate[barDateOf(c)] || 0) + 1;
    console.log(`warn  ${Math.round(nowPrices.behindShare * 100)}% of ${spec.label} lines have no bar for ${nowPrices.session}`
      + ` — the fetch missed them (${Object.entries(byDate).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d}:${n}`).join(' ')})`);
    console.log(`      e.g. ${stragglers.slice(0, 8).map((c) => `${companyKey(c)} ${barDateOf(c)}`).join(', ')}`);
  }
  // Different problem, different owner: the exchange or Yahoo has not published a close for the session
  // the bar belongs to. No amount of retrying fixes it; the source has to catch up.
  if (nowPrices.noCloseShare > 0.10) {
    console.log(`warn  ${Math.round(nowPrices.noCloseShare * 100)}% of ${spec.label} lines have a bar for ${nowPrices.session}`
      + ` but no close yet — the source has not published this session (last usable close ${nowPrices.close})`);
  }

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
