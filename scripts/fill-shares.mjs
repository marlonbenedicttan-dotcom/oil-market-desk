// Fill share counts for large companies the frames missed, from the company's own XBRL cover page.
// Multiple contexts (share classes) are summed only when they are comparable in size; Berkshire's
// A/B classes differ 1,500x in price, so summing them would be wrong — those stay unpriced.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '--limit=400').split('=')[1]);
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => !c.shares && c.revenue).slice(0, LIMIT);
console.log(`${todo.length} companies without a share count`);
let last = 0, done = 0;
for (const c of todo) {
  const wait = Math.max(0, 170 - (Date.now() - last)); if (wait) await sleep(wait); last = Date.now();
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(c.cik).padStart(10, '0')}/dei/EntityCommonStockSharesOutstanding.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const j = await res.json();
    const rows = (j.units && (j.units.shares || j.units['shares/shares'])) || [];
    if (!Array.isArray(rows) || !rows.length) continue;
    const latest = rows.reduce((a, b) => (String(a.end) > String(b.end) ? a : b));
    const sameEnd = rows.filter((r) => r.end === latest.end).map((r) => r.val).filter((v) => v > 0);
    if (!sameEnd.length) continue;
    const min = Math.min(...sameEnd), max = Math.max(...sameEnd);
    if (sameEnd.length > 1 && max / min > 20) continue;      // classes priced very differently: skip
    c.shares = sameEnd.reduce((a, b) => a + b, 0);
    done++;
  } catch {}
}
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data)); renameSync(FILE + '.tmp', FILE);
console.log(`filled ${done}`);
