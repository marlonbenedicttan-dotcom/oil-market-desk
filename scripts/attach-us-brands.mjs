// Attach the curated consumer brands to each US company.
//
// Runs after any rebuild of companies.json, which rewrites the file from filings and knows nothing
// about brands. Same pattern as Japan and Korea: the list is curated, the script only merges it in.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBrands, mergeBrands } from '../src/brand-extract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const BRANDS = join(ROOT, 'data', 'us-brands.json');
const PROFILES = join(ROOT, 'data', 'us-profiles.json');
const GROUPS = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'brand-groups.json'), 'utf8')).groups || {}; }
  catch { return {}; }
})();

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const brands = JSON.parse(readFileSync(BRANDS, 'utf8')).brands || {};
const profiles = JSON.parse(readFileSync(PROFILES, 'utf8')).profiles || {};
const auto = {};
for (const [ticker, text] of Object.entries(profiles)) {
  const found = extractBrands(text).brands;
  if (found.length) auto[ticker] = found;
}

let attached = 0, unknown = [];
const seen = new Set();
for (const c of data.companies) {
  if (!c.ticker) continue;
  const merged = mergeBrands([brands[c.ticker], auto[c.ticker]], GROUPS);
  if (!merged.length) {
    if (c.brands !== undefined) delete c.brands;
    continue;
  }
  seen.add(c.ticker);
  c.brands = merged;
  attached++;
}
// A ticker in the brand file that no company carries is a typo or a delisting — say so rather than
// letting it rot silently.
for (const t of Object.keys(brands)) if (!seen.has(t)) unknown.push(t);

writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`brands attached to ${attached} companies · ${unknown.length} unmatched: ${unknown.join(' ') || 'none'}`);
