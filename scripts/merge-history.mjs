// Keep every filing period the platform has ever published — the record must grow, not follow the vendor.
//
// Each market build rebuilds its period table from the vendor page (stockanalysis, TWSE, J-Quants, DART)
// and that page is a rolling window: five fiscal years today, still five next year. A year that scrolls
// off the page would disappear from the company page forever, so the history could never pass five years
// no matter how long the site runs.
//
// This step runs after a build and before the commit. It compares the freshly built file with the version
// in git, merges the periods by date (the new build wins on a duplicate, anything older is kept), and
// rewrites the per-company detail file so the company page sees the same record.
//
//   node scripts/merge-history.mjs au
//   node scripts/merge-history.mjs jp kr tw hk au
//   node scripts/merge-history.mjs --dry-run          # what would be kept
//
// It is idempotent and silent: a run where the new file already holds every period writes nothing.
// The US keeps its quarter table here too. Its annual/growth series is still built separately from SEC
// XBRL; this only preserves quarters that were already published, and only once they are older than the
// build's current window. A quarter the build rejected never enters the committed file, so it cannot be
// resurrected by the merge.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePeriods } from '../src/lib.js';
import { growthRates, fromJapanHistory, growthFromAnnuals, marginDeltaFromAnnuals, growthFromUsSeries } from '../src/growth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

// Each market keeps its periods in a different shape, and the date field is not the same everywhere:
// Japan calls it `y`, a Hong Kong half-year calls it `d`, the rest call it `end`.
// Annual figures and the quarterly table both grow: a quarter that scrolls off the vendor's page is
// kept here, so a site that runs for twenty years shows twenty years of quarters, not the last eight.
const MARKETS = {
  jp: {
    file: 'japan.json', detail: 'japan-companies',
    tables: (c) => [['history', c.history, 'y'], ['quarters', c.quarters, 'd']],
  },
  kr: {
    file: 'korea.json', detail: 'korea-companies',
    tables: (c) => [['reports', c.reports, 'end'], ['quarters', c.quarters, 'd']],
  },
  tw: {
    file: 'taiwan.json',
    detail: 'taiwan-companies',
    tables: (c) => [
      ['reports.annual', c.reports && c.reports.annual, 'end'],
      ['reports.quarters', c.reports && c.reports.quarters, 'd'],
      ['quarters', c.quarters, 'd'],
    ],
  },
  hk: {
    file: 'hongkong.json',
    detail: 'hongkong-companies',
    tables: (c) => [
      ['reports.annual', c.reports && c.reports.annual, 'end'],
      ['reports.quarters', c.reports && c.reports.quarters, 'd'],
      ['quarters', c.quarters, 'd'],
    ],
  },
  au: {
    file: 'australia.json',
    detail: 'australia-companies',
    tables: (c) => [
      ['reports.annual', c.reports && c.reports.annual, 'end'],
      ['reports.quarters', c.reports && c.reports.quarters, 'd'],
      ['quarters', c.quarters, 'd'],
    ],
  },
  in: {
    file: 'india.json',
    detail: 'india-companies',
    tables: (c) => [
      ['reports.annual', c.reports && c.reports.annual, 'end'],
      ['reports.quarters', c.reports && c.reports.quarters, 'd'],
      ['quarters', c.quarters, 'd'],
    ],
  },
  id: {
    file: 'indonesia.json',
    detail: 'indonesia-companies',
    tables: (c) => [
      ['reports.annual', c.reports && c.reports.annual, 'end'],
      ['reports.quarters', c.reports && c.reports.quarters, 'd'],
      ['quarters', c.quarters, 'd'],
    ],
  },
  // The US has no per-company detail directory: the whole record lives in companies.json. Its
  // annual table is `series` (numeric fiscal year), so growth follows the merged record too.
  us: {
    file: 'companies.json', detail: null,
    tables: (c) => [['series', c.series, 'fy'], ['quarters', c.quarters, 'end']],
  },
};

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = requested.length ? requested : Object.keys(MARKETS);
const unknown = ids.filter((id) => !MARKETS[id]);
if (unknown.length) {
  console.error(`unknown market: ${unknown.join(', ')} — use ${Object.keys(MARKETS).join(', ')}`);
  process.exit(2);
}

const codeOf = (c) => c.code || c.cik || c.ticker;

// The annual table each market's growth fields are rebuilt from after older periods are merged.
const annualsFor = (id, c) => {
  if (id === 'kr') return (c.reports || []).filter((r) => r && r.report === 'annual' && r.end);
  if (id === 'tw' || id === 'hk' || id === 'au' || id === 'in' || id === 'id') return (c.reports && c.reports.annual) || [];
  return null;
};
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const setPath = (obj, path, value) => {
  const parts = path.split('.');
  const last = parts.pop();
  const box = parts.reduce((o, k) => (o == null ? o : o[k]), obj);
  if (box) box[last] = value;
};

let totalChanged = 0;

for (const id of ids) {
  const spec = MARKETS[id];
  const file = join(ROOT, 'data', spec.file);
  const now = JSON.parse(readFileSync(file, 'utf8'));
  let before = null;
  try {
    before = JSON.parse(execFileSync('git', ['show', `HEAD:data/${spec.file}`], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    }));
  } catch {
    console.log(`${id}: no previous ${spec.file} in HEAD — nothing to compare`);
    continue;
  }

  const prevBy = new Map((before.companies || []).map((c) => [codeOf(c), c]));
  const gained = [];
  for (const c of now.companies || []) {
    const p = prevBy.get(codeOf(c));
    if (!p) continue;
    let added = 0;
    for (const [path, arr, key] of spec.tables(c)) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const prevArr = getPath(p, path);
      if (!Array.isArray(prevArr) || !prevArr.length) continue;
      const merged = mergePeriods(prevArr, arr, key);
      if (merged.length > arr.length) {
        added += merged.length - arr.length;
        setPath(c, path, merged);
      }
    }
    if (added) {
      gained.push(`${codeOf(c)} +${added}`);
      // Growth must follow the merged record for every market that publishes it. The build only sees
      // the vendor's rolling five years, so without this the table could hold ten years while the
      // CAGR stayed a four-year number forever. Recompute only when a company actually gained periods.
      if (id === 'us' && Array.isArray(c.series)) {
        Object.assign(c, growthFromUsSeries(c.series, c.shares));
      } else if (id === 'jp' && Array.isArray(c.history)) {
        Object.assign(c, growthRates(fromJapanHistory(c.history)));
      } else {
        const annuals = annualsFor(id, c);
        if (Array.isArray(annuals) && annuals.length) {
          // Taiwan's vendor tables carry no per-year EPS, so its build synthesises one from net
          // income over the current share count (derive-taiwan.mjs). The other markets publish EPS
          // as filed. Handing them c.shares as a fallback would invent a rate their builder never
          // computes — 9973 read 69% "EPS CAGR" off two reported years and net income before them.
          const growth = id === 'tw' ? growthFromAnnuals(annuals, c.shares) : growthFromAnnuals(annuals);
          Object.assign(c, growth, { marginDelta: marginDeltaFromAnnuals(annuals) });
        }
      }
      if (!DRY && spec.detail) {
        const detail = join(ROOT, 'data', spec.detail, `${codeOf(c)}.json`);
        if (existsSync(detail)) writeFileSync(detail, JSON.stringify(c));
      }
    }
  }

  if (!gained.length) {
    console.log(`${id}: complete — every period already committed is present`);
    continue;
  }
  totalChanged += gained.length;
  console.log(`${id}: ${gained.length} companies gained history · ${gained.slice(0, 6).join(' ')}${gained.length > 6 ? ' …' : ''}`);
  if (!DRY) {
    writeFileSync(`${file}.tmp`, JSON.stringify(now));
    renameSync(`${file}.tmp`, file);
  }
}

console.log(DRY ? `\ndry run — ${totalChanged} companies would gain history` : totalChanged ? `\n${totalChanged} companies now carry their full filing history` : '\nnothing to merge');
