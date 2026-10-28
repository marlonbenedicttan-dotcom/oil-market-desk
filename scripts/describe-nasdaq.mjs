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
      if (!j?.data) return null;
      return { desc: j.data.CompanyDescription?.value || null, name: j.data.CompanyName?.value || null };
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

// Trim to two sentences, the same shape as the 10-K descriptions.
function tidy(text) {
  let t = String(text).replace(/\s+/g, ' ').trim();
  t = t.replace(/^(The Company|Company Description)[:\s-]*/i, '');
  // "U.S. Bancorp" is one sentence, not two: re-join splits that follow a known abbreviation.
  const ABBR = /\b(U\.S|U\.K|Inc|Corp|Co|Ltd|Mr|Ms|Dr|No|St|vs|etc)\.$/i;
  const sentences = [];
  let buf = '';
  for (const part of t.split(/(?<=[.!?])\s+/)) {
    buf = buf ? `${buf} ${part}` : part;
    if (!ABBR.test(buf)) { if (buf.length > 25) sentences.push(buf); buf = ''; }
  }
  if (buf && buf.length > 25) sentences.push(buf);
  if (!sentences.length) return null;
  let out = sentences.slice(0, 2).join(' ');
  if (out.length > 320) out = out.slice(0, 317).replace(/[,;\s]+\S*$/, '') + '…';
  return out;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
// --bad re-does descriptions that survived the 10-K pass but start mid-sentence ("(“AI”) into the
// real world…"), which is worse than no description at all.
const BAD = process.argv.includes('--bad');
// A description that survived the 10-K pass can still be table-of-contents residue:
// "Mine Safety Disclosures 31 PART II Item 5. Market for Registrant's Common Equity".
const RESIDUE = /(Item\s+\d+[A-Z]?\.|PART\s+I{1,3}\b|Mine Safety Disclosures|Table of Contents|FORM 10-K|^General\s+\w+\s+of\s+Business|^Market for Registrant)/i;
const isBad = (d) => !/^[A-Z0-9"“]/.test(d) || RESIDUE.test(d);
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const todo = data.companies.filter((c) => c.marketCap && c.ticker
  && (onlySet ? onlySet.has(c.ticker) : BAD ? (c.description && isBad(c.description)) : !c.description));
console.log(`${todo.length} companies without a description`);

let done = 0;
const failed = [];
for (const c of todo) {
  const p = await profile(c.ticker);
  let d = p?.desc ? tidy(p.desc) : null;
  // Nasdaq writes the profile as a continuation of the name — "Walmart Inc. (Nasdaq: WMT) is a …" —
  // so a bare parenthetical is the tail of that sentence. Put the name back in front of it.
  if (d) {
    const nm = p.name || c.name || '';
    d = d.replace(/^\([^)]*\)\s*/, '');
    if (/^,\s*is\b/i.test(d)) d = `${nm}${d.replace(/^,\s*is\b/i, ' is')}`;
    else if (/^,\s*/.test(d)) d = `${nm}${d}`;
    else if (/^[a-z]/.test(d) && !d.toLowerCase().startsWith(nm.toLowerCase())) d = `${nm} ${d}`;
  }
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
