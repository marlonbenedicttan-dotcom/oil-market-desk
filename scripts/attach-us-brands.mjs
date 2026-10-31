// Attach the curated consumer brands to each US company.
//
// Runs after any rebuild of companies.json, which rewrites the file from filings and knows nothing
// about brands. Same pattern as Japan and Korea: the list is curated, the script only merges it in.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const BRANDS = join(ROOT, 'data', 'us-brands.json');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const brands = JSON.parse(readFileSync(BRANDS, 'utf8')).brands || {};

let attached = 0, unknown = [];
const seen = new Set();
for (const c of data.companies) {
  if (!c.ticker) continue;
  const b = brands[c.ticker];
  if (!b) continue;
  seen.add(c.ticker);
  c.brands = b;
  attached++;
}
// A ticker in the brand file that no company carries is a typo or a delisting — say so rather than
// letting it rot silently.
for (const t of Object.keys(brands)) if (!seen.has(t)) unknown.push(t);

writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`brands attached to ${attached} companies · ${unknown.length} unmatched: ${unknown.join(' ') || 'none'}`);
