// Split the suite into code tests (blocking) and data tests (a data-quality warning).
//
// A market refresh can legitimately fail a data assertion while the code is fine. Letting that turn
// into a red GitHub run is what generated the failure emails. CI runs the code half normally and the
// data half with continue-on-error; the market workflow still refuses to publish the data if the data
// half fails.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = new Set([
  'companies-data.test.js', 'markets-data.test.js', 'filters.test.js',
  'japan-list.test.js', 'matrix.test.js',
  'australia-data.test.js', 'brazil-data.test.js', 'hongkong-data.test.js', 'india-data.test.js',
  'indonesia-data.test.js', 'korea-data.test.js', 'southafrica-data.test.js', 'taiwan-data.test.js',
]);
// API tests start a live server and can wait on an upstream feed. They are useful, but a cold
// screen call must not decide whether a market refresh may publish its data.
const API = new Set(['api.test.js']);
const mode = ['data', 'api'].includes(process.argv[2]) ? process.argv[2] : 'code';
const files = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js')).sort();
const selected = files.filter((f) => (mode === 'api' ? API.has(f) : API.has(f) ? false : mode === 'data' ? DATA.has(f) : !DATA.has(f))).map((f) => join('tests', f));
if (!selected.length) { console.error('no tests selected'); process.exit(2); }
const run = spawnSync(process.execPath, ['--test', ...selected], { cwd: ROOT, stdio: 'inherit' });
process.exit(run.status ?? 1);
