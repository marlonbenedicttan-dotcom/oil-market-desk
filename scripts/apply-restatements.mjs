// Re-apply every restatement we have already detected.
//
// A rebuild rewrites each field from the original 10-K facts, which silently reverts an amendment: the
// `restatement` record survived, the corrected value did not, and TSLA's equity went back to the
// pre-amendment figure. This runs after any rebuild and is a no-op when nothing was restated.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let applied = 0, changed = 0;
for (const c of data.companies) {
  const changes = c.restatement && c.restatement.changes;
  if (!changes) continue;
  applied++;
  for (const [field, v] of Object.entries(changes)) {
    if (v && v.now != null && c[field] !== v.now) { c[field] = v.now; changed++; }
  }
}
if (changed) {
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
}
console.log(`${applied} recorded restatements · ${changed} values restored`);
