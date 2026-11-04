// Attach the curated consumer brands to the Taiwan, Hong Kong and Australia datasets.
//
// Every build rewrites its market file from filings and knows nothing about brands, so this runs after
// the build and merges the hand-curated maps back in — source dataset, compact list artifact and (for
// Hong Kong and Australia) the per-company detail files the company page reads.
//
//   node scripts/attach-market-brands.mjs          all three markets
//   node scripts/attach-market-brands.mjs tw hk   a subset
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeBrands } from '../src/brand-extract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'brand-groups.json'), 'utf8')).groups || {}; }
  catch { return {}; }
})();

const MARKETS = {
  tw: {
    label: 'Taiwan',
    source: join(ROOT, 'data', 'taiwan.json'),
    list: join(ROOT, 'data', 'taiwan-list.json'),
    brands: join(ROOT, 'data', 'taiwan-brands.json'),
    detail: join(ROOT, 'data', 'taiwan-companies'),
  },
  hk: {
    label: 'Hong Kong',
    source: join(ROOT, 'data', 'hongkong.json'),
    list: join(ROOT, 'data', 'hongkong-list.json'),
    brands: join(ROOT, 'data', 'hongkong-brands.json'),
    profiles: join(ROOT, 'data', 'hongkong-profiles.json'),
    detail: join(ROOT, 'data', 'hongkong-companies'),
  },
  au: {
    label: 'Australia',
    source: join(ROOT, 'data', 'australia.json'),
    list: join(ROOT, 'data', 'australia-list.json'),
    brands: join(ROOT, 'data', 'australia-brands.json'),
    detail: join(ROOT, 'data', 'australia-companies'),
  },
};

const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
};

// Merge one map into one company array. Returns how many companies took a brand set, which tickers
// were actually seen (so a typo or a delisting does not rot silently) and how many records changed.
function merge(companies, brands) {
  let attached = 0;
  let changed = 0;
  const seen = new Set();
  for (const c of companies) {
    if (!c.ticker) continue;
    const b = brands[c.ticker];
    if (b && b.length) {
      seen.add(c.ticker);
      attached++;
      if (JSON.stringify(c.brands) !== JSON.stringify(b)) {
        c.brands = b;
        changed++;
      }
    } else if (c.brands !== undefined) {
      // The curated file is the source of truth: a brand removed there must disappear here too.
      delete c.brands;
      changed++;
    }
  }
  return { attached, seen, changed };
}

const picked = process.argv.slice(2).filter((id) => MARKETS[id]);
const ids = picked.length ? picked : Object.keys(MARKETS);

for (const id of ids) {
  const m = MARKETS[id];
  if (!existsSync(m.source)) {
    console.log(`${m.label}: source missing — skipped`);
    continue;
  }
  const curated = JSON.parse(readFileSync(m.brands, 'utf8')).brands || {};
  // The profile fetcher writes the brands it read from the business description. Merge them after the
  // curated seed: a human spelling wins, and the description adds the brands the seed missed.
  const auto = {};
  if (m.profiles && existsSync(m.profiles)) {
    const profiles = JSON.parse(readFileSync(m.profiles, 'utf8'));
    for (const [code, entry] of Object.entries(profiles.entries || {})) {
      if (entry && Array.isArray(entry.brands) && entry.brands.length) auto[code] = entry.brands;
    }
  }
  const brands = {};
  for (const t of new Set([...Object.keys(curated), ...Object.keys(auto)])) {
    const merged = mergeBrands([curated[t], auto[t]], GROUPS);
    if (merged.length) brands[t] = merged;
  }
  const data = JSON.parse(readFileSync(m.source, 'utf8'));

  const { attached, seen, changed } = merge(data.companies || [], brands);
  if (changed) writeJson(m.source, data);

  // The search index reads the compact list artifact, not the 20 MB source. Keep its `updated` stamp
  // untouched: the server compares it with the source to decide whether the artifact is still valid.
  if (existsSync(m.list)) {
    const list = JSON.parse(readFileSync(m.list, 'utf8'));
    const listMerge = merge(list.companies || [], brands);
    if (listMerge.changed) writeJson(m.list, list);
  }

  // Company pages for Hong Kong and Australia read a per-company file; Taiwan serves the full record.
  let details = 0;
  if (m.detail && existsSync(m.detail)) {
    for (const file of readdirSync(m.detail)) {
      if (!file.endsWith('.json')) continue;
      const detail = JSON.parse(readFileSync(join(m.detail, file), 'utf8'));
      const b = brands[detail.ticker];
      if (b && b.length) {
        if (JSON.stringify(detail.brands) === JSON.stringify(b)) continue;
        detail.brands = b;
      } else if (detail.brands !== undefined) {
        delete detail.brands;
      } else {
        continue;
      }
      writeJson(join(m.detail, file), detail);
      if (b && b.length) details++;
    }
  }

  const unknown = Object.keys(curated).filter((t) => !seen.has(t));
  console.log(`${m.label}: ${attached} brand sets${details ? ` · ${details} detail files` : ''}`
    + `${Object.keys(auto).length ? ` · ${Object.keys(auto).length} profile brand sets` : ''}`
    + ` · ${unknown.length} unmatched: ${unknown.join(' ') || 'none'}`);
}
