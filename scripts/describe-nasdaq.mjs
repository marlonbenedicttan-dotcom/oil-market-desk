// Second description source: Nasdaq's company profile.
//
// The 10-K Item 1 pass is the primary source, but ~90 companies fail it — the primary document is a
// wrapper, Item 1 is in an exhibit, or the opening text trips the boilerplate filter. Nasdaq publishes
// a "Company Description" per listing, which is the exchange's own summary, so it is a trusted
// substitute rather than something written here.
//
//   node scripts/describe-nasdaq.mjs --dry
//   node scripts/describe-nasdaq.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function profile(ticker) {
  const sym = String(ticker).replace('-', '.');
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/company-profile?assetclass=stocks`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) { await sleep(600 * (i + 1)); continue; }
      const j = await res.json();
      return j?.data?.CompanyDescription?.value || null;
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

// Trim to two sentences, the same shape as the 10-K descriptions.
function tidy(text) {
  let t = String(text).replace(/\s+/g, ' ').trim();
  t = t.replace(/^(The Company|Company Description)[:\s-]*/i, '');
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.length > 25);
  if (!sentences.length) return null;
  let out = sentences.slice(0, 2).join(' ');
  if (out.length > 320) out = out.slice(0, 317).replace(/[,;\s]+\S*$/, '') + '…';
  return out;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => !c.description && c.marketCap && c.ticker);
console.log(`${todo.length} companies without a description`);

let done = 0;
const failed = [];
for (const c of todo) {
  const raw = await profile(c.ticker);
  const d = raw ? tidy(raw) : null;
  if (d && !/^(n\/?a|null|undefined)$/i.test(d)) {
    c.description = d;
    c.descriptionSource = 'nasdaq';
    done++;
    if (DRY) console.log(`  ${c.ticker}: ${d.slice(0, 100)}…`);
  } else {
    failed.push(c.ticker);
  }
  if (done && done % 20 === 0) console.log(`  ${done} described`);
  await sleep(220);
}

console.log(`described ${done} of ${todo.length}`);
if (failed.length) console.log('still without a description:', failed.join(' '));

if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
