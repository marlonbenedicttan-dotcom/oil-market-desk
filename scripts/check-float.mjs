// Cross-check market cap against an independent official number: the 10-K cover page's "aggregate
// market value of common equity held by non-affiliates" (EntityPublicFloat). Float is normally 40-100%
// of market cap, so a ratio far outside that band means our share count or price is wrong.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(readFileSync(FILE, 'utf8'));
let last = 0, got = 0;
for (const c of data.companies) {
  const wait = Math.max(0, 170 - (Date.now() - last)); if (wait) await sleep(wait); last = Date.now();
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(c.cik).padStart(10, '0')}/dei/EntityPublicFloat.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const j = await res.json();
    const rows = (j.units && j.units.USD) || [];
    if (!Array.isArray(rows) || !rows.length) continue;
    const latest = rows.reduce((a, b) => (String(a.end) > String(b.end) ? a : b));
    c.publicFloat = latest.val; c.floatAsOf = latest.end; got++;
  } catch {}
}
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data)); renameSync(FILE + '.tmp', FILE);
console.log(`public float found for ${got} companies`);
