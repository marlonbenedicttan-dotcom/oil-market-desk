// Add a short "what the company does" line from its own 10-K, Item 1 (Business).
//
// The SIC description is a category ("Services-Prepackaged Software"), not a description. The 10-K's
// opening paragraph is the company describing itself, which is exactly what we want — primary source,
// no editorialising. Truncated to two sentences.
//
//   node scripts/describe-companies.mjs --limit=5 --dry
//   node scripts/describe-companies.mjs --limit=300

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '--limit=300').split('=')[1]);
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, text = false) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 170 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.status === 403 || res.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!res.ok) return null;
      return text ? res.text() : res.json();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}
const textOf = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

function describe(text) {
  const t = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');
  const re = /Item\s*1\.?\s*Business/gi;
  let m, body = null;
  while ((m = re.exec(t))) {
    const after = t.slice(m.index, m.index + 1500);
    // A table-of-contents hit reads "Item 1. Business 32 Item 1A. Risk Factors 45" — page numbers.
    if (/Business\s+\d{1,3}\s+Item/i.test(after.slice(0, 260))) continue;
    if (after.length < 200) continue;
    body = after;
    break;
  }
  if (!body) return null;
  body = body.replace(/^Item\s*1\.?\s*Business[^.]{0,60}[.:]?/i, '').trim();
  const sentences = body.split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    // Start on a real sentence: a fragment left over from the heading ("ted herein by reference…")
    // begins lowercase and is dropped.
    .filter((s) => s.length > 40 && s.length < 420 && /^[A-Z\u201c(]/.test(s) && !/^(Item|page|table of contents)\b/i.test(s));
  if (!sentences.length) return null;
  return sentences.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim().slice(0, 320);
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => !c.description && c.marketCap).slice(0, LIMIT);
console.log(`${todo.length} companies to describe`);

let done = 0;
for (const c of todo) {
  const sub = await get(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`);
  const rec = sub?.filings?.recent;
  if (!rec) continue;
  const idx = (rec.form || []).findIndex((f) => f === '10-K');
  if (idx < 0) continue;
  const acc = rec.accessionNumber[idx].replace(/-/g, '');
  const doc = rec.primaryDocument[idx];
  const body = await get(`https://www.sec.gov/Archives/edgar/data/${c.cik}/${acc}/${doc}`, true);
  if (!body) continue;
  let d = describe(textOf(body));
  // Reject boilerplate that is not a description of the business.
  if (d && /forward-looking|fiscal year|Item 1A|table of contents|herein by reference|risk factors/i.test(d)) d = null;
  if (d) d = d.replace(/^[^A-Za-z\u201c(]+/, '').trim();
  if (d) { c.description = d; done++; if (DRY) console.log(`  ${c.ticker || c.name}: ${d.slice(0, 110)}…`); }
  if (done && done % 25 === 0) console.log(`  ${done} described`);
  await sleep(150);
}

data.updated = new Date().toISOString();
if (!DRY) { writeFileSync(FILE + '.tmp', JSON.stringify(data)); renameSync(FILE + '.tmp', FILE); }
console.log(`described ${done} of ${todo.length}`);
