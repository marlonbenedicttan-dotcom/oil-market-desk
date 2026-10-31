// Attach the fetched US company profiles to companies.json.
//
// Same shape as Japan and Korea: the text lives in a committed file, so a rebuild in CI — which has no
// local cache — still has real profiles instead of falling back to filing fragments.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const STORE = join(ROOT, 'data', 'us-profiles.json');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let profiles = {};
try { profiles = JSON.parse(readFileSync(STORE, 'utf8')).profiles || {}; } catch { /* none yet */ }

let attached = 0;
for (const c of data.companies) {
  // Curated text wins: it was written for this page and is not a scraped paragraph.
  const text = c.descSource === 'curated' ? c.description : (c.ticker ? profiles[c.ticker] : null);
  if (!text) continue;
  c.description = text;
  c.descSource = 'profile';
  c.descSourceName = 'stockanalysis.com';
  attached++;
}

writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`profiles attached to ${attached} companies`);
