// Carry forward companies that a partial market refresh omitted.
//
// A daily build reads its universe from an exchange page, a vendor list or a rate-limited crawl. When
// that source is incomplete (the HKEX report is posted in stages, Yahoo throttles a run, a statement
// page 404s once), the build writes a smaller market. The pre-publish audit correctly refuses to ship
// it — but the previous dataset stays frozen, and the workflow turns red every day.
//
// This step merges the previous committed records, detail files and chart series back into the new
// build for every code the refresh did not return. The new data for the codes it did return is kept;
// the carried codes keep their last good record and are marked `carried` until a complete build
// refreshes them. The audit then sees the same universe and can publish the fresh prices.
//
//   node scripts/merge-market-refresh.mjs au
//   node scripts/merge-market-refresh.mjs hk br
//
// Run after the build and merge-history/merge-series, before audit-market-refresh.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = (p) => join(ROOT, 'data', p);
const gitShow = (path) => {
  try {
    return JSON.parse(execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  } catch { return null; }
};
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v)); };

const MARKETS = {
  au: { label: 'Australia', file: 'australia.json', details: 'australia-companies', series: 'australia-series', list: 'australia-list.json', project: 'australiaList' },
  br: { label: 'Brazil', file: 'brazil.json', details: 'brazil-companies', series: 'brazil-series', list: 'brazil-list.json', project: 'brazilList' },
  in: { label: 'India', file: 'india.json', details: 'india-companies', series: 'india-series', list: 'india-list.json', project: 'indiaList' },
  id: { label: 'Indonesia', file: 'indonesia.json', details: 'indonesia-companies', series: 'indonesia-series', list: 'indonesia-list.json', project: 'indonesiaList' },
  hk: { label: 'Hong Kong', file: 'hongkong.json', details: 'hongkong-companies', series: 'hongkong-series', list: 'hongkong-list.json', project: 'hongkongList' },
  za: { label: 'South Africa', file: 'southafrica.json', details: 'southafrica-companies', series: 'southafrica-series', list: 'southafrica-list.json', project: 'southafricaList' },
};

const ids = process.argv.slice(2).filter((x) => !x.startsWith('-'));
if (!ids.length || ids.some((id) => !MARKETS[id])) {
  console.error(`usage: node scripts/merge-market-refresh.mjs ${Object.keys(MARKETS).join('|')}`);
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
for (const id of ids) {
  const spec = MARKETS[id];
  const now = readJson(DATA(spec.file));
  const before = gitShow(`data/${spec.file}`);
  if (!now || !before) { console.log(`${spec.label}: no current/previous market file — skip`); continue; }
  const nowRows = Array.isArray(now.companies) ? now.companies : [];
  const wasRows = Array.isArray(before.companies) ? before.companies : [];
  const have = new Set(nowRows.map((c) => c.code));
  const missing = wasRows.filter((c) => c.code && !have.has(c.code));
  if (!missing.length) { console.log(`${spec.label}: no companies missing (${nowRows.length})`); continue; }

  // Records: keep the last good company record. It is internally consistent (price, date, cap, ratios).
  for (const c of missing) nowRows.push({ ...c, carried: true, carriedAt: today });
  now.companies = nowRows;
  if (now.market && typeof now.market.companies === 'number') now.market.companies = nowRows.length;
  // A carried company adds its cap to the market. The audit compares the published total with the
  // sum of the rows, so leaving the build's pre-carry total makes a valid carry fail (HK 10 Nov).
  if (now.market && typeof now.market.totalCap === 'number') {
    now.market.totalCap = nowRows.reduce((sum, c) => sum + (c.marketCap || 0), 0);
  }
  writeJson(DATA(spec.file), now);

  // Detail pages: the builder deletes the directory before writing, so restore the omitted codes.
  let restored = 0;
  for (const c of missing) {
    const rel = `data/${spec.details}/${c.code}.json`;
    const target = DATA(`${spec.details}/${c.code}.json`);
    if (existsSync(target)) continue;
    try {
      const text = execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      restored++;
    } catch { /* the previous build had no detail file for this code */ }
  }

  // Charts: the builder overwrites each bucket with the codes it fetched. Copy the omitted codes back
  // from the same bucket in HEAD so their company page still draws its history.
  const bucketDir = DATA(spec.series);
  let series = 0;
  try {
    const files = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', `HEAD:data/${spec.series}`], { encoding: 'utf8' }).split('\n').filter(Boolean).map((p) => p.split('/').pop()));
    for (const f of files) {
      const old = gitShow(`data/${spec.series}/${f}`);
      if (!old) continue;
      const cur = readJson(join(bucketDir, f)) || { daily: {}, weekly: {} };
      cur.daily = cur.daily || {}; cur.weekly = cur.weekly || {};
      let changed = false;
      for (const code of missing.map((c) => c.code)) {
        if (old.daily && old.daily[code] && !cur.daily[code]) { cur.daily[code] = old.daily[code]; changed = true; }
        if (old.weekly && old.weekly[code] && !cur.weekly[code]) { cur.weekly[code] = old.weekly[code]; changed = true; }
      }
      if (changed) { writeJson(join(bucketDir, f), cur); series++; }
    }
  } catch { /* no committed series directory */ }

  // Rebuild the list projection and chart index so the restored codes are visible everywhere.
  try {
    const mod = await import('../src/project.js');
    const list = mod[spec.project](readJson(DATA(spec.file)));
    writeJson(DATA(spec.list), list);
  } catch (e) { console.log(`  ${spec.label} list rebuild: ${e.message}`); }
  try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), id], { stdio: 'inherit' }); }
  catch (e) { console.log(`  ${spec.label} chart store: ${e.message}`); }

  console.log(`${spec.label}: carried ${missing.length} compan${missing.length === 1 ? 'y' : 'ies'} missing from the refresh · restored ${restored} detail files · ${series} series buckets`);
  if (missing.length <= 8) console.log(`  ${missing.map((c) => c.code).join(' ')}`);
}
