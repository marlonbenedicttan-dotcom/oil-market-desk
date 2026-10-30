// Fail loudly if the datasets stopped updating.
//
// A scheduled workflow that quietly stops is worse than one that crashes: the site keeps serving numbers
// that look current. This runs on its own schedule and exits non-zero when either market is stale.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_HOURS = Number(process.env.MAX_AGE_HOURS || 36);

const check = (label, file) => {
  try {
    const d = JSON.parse(readFileSync(join(ROOT, 'data', file), 'utf8'));
    const t = Date.parse(d.updated || '');
    if (!Number.isFinite(t)) return { label, ok: false, msg: 'no updated timestamp' };
    const h = (Date.now() - t) / 3600e3;
    return { label, ok: h <= MAX_HOURS, msg: `${d.updated.slice(0, 16).replace('T', ' ')}Z · ${h.toFixed(1)}h old` };
  } catch (e) { return { label, ok: false, msg: `unreadable: ${e.message}` }; }
};

const rows = [check('US', 'companies.json'), check('Japan', 'japan.json')];
for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'STALE'} ${r.label.padEnd(6)} ${r.msg}`);
const bad = rows.filter((r) => !r.ok);
if (bad.length) {
  console.error(`\n${bad.length} dataset(s) older than ${MAX_HOURS}h — the nightly refresh has not landed.`);
  process.exit(1);
}
console.log(`\nboth datasets within ${MAX_HOURS}h`);
