// Fill SIC industry for companies that don't have it, largest first (one submissions call each).
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIC_SECTOR } from '../src/deals.js';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '--limit=800').split('=')[1]);
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => !c.sic).slice(0, LIMIT);
console.log(`${todo.length} companies without SIC`);
let last = 0, done = 0;
for (const c of todo) {
  const wait = Math.max(0, 170 - (Date.now() - last)); if (wait) await sleep(wait); last = Date.now();
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const j = await res.json();
    if (j.sic) { c.sic = j.sic; c.sector = SIC_SECTOR(j.sic); c.industry = j.sicDescription || null; c.state = j.stateOfIncorporation || null; done++; }
  } catch {}
  if (done && done % 100 === 0) console.log(`  ${done} tagged`);
}
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data)); renameSync(FILE + '.tmp', FILE);
console.log(`tagged ${done}`);
