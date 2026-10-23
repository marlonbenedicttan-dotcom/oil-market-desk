// Fill in missing deal values from the company's own press release (EX-99.1).
//
//   node scripts/enrich-values.mjs --limit=50 --dry
//   node scripts/enrich-values.mjs
//
// Strict on purpose: only phrases that state the consideration ("valued at $9.7 billion",
// "purchase price of $2.4 billion"), and only amounts that are plausible for a deal. A filing that
// never states a price stays blank rather than inheriting a number from revenue or market cap.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'deals-store.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const LIMIT = Number(arg('limit', 9999));
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, json = false) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 170 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.status === 403 || res.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!res.ok) return null;
      return json ? res.json() : res.text();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}
const textOf = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

function valueFrom(text) {
  const t = text.replace(/\n/g, ' ');
  // Two shapes: an explicit "valued at / purchase price of $X", or a deal verb near a price
  // ("will acquire X for $2.4 billion"). The second needs the verb within the same clause.
  const explicit = /(?:valued at|purchase price of|aggregate consideration of|merger consideration of|transaction value of|consideration of)\s*(?:approximately\s*)?\$\s?([\d.,]+)\s?(billion|million|bn|mm|b|m)\b/gi;
  let m;
  while ((m = explicit.exec(t))) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const usdM = /^(b|bn)/i.test(m[2]) ? n * 1000 : n;
    if (usdM >= 250 && usdM <= 300000) return Math.round(usdM);
  }
  const near = /[^.]{0,160}?\b(?:acquire|acquires|acquisition of|merger with|purchase of|buy)\b[^.]{0,120}?\$\s?([\d.,]+)\s?(billion|million|bn|mm|b|m)\b/gi;
  while ((m = near.exec(t))) {
    const clause = m[0].toLowerCase();
    if (/revenue|sales|market cap|backlog|assets under|annual|run-rate/.test(clause)) continue;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const usdM = /^(b|bn)/i.test(m[2]) ? n * 1000 : n;
    if (usdM >= 250 && usdM <= 300000) return Math.round(usdM);
  }
  return null;
}

const store = JSON.parse(readFileSync(STORE, 'utf8'));
const todo = store.deals.filter((d) => !d.value && /\/Archives\/edgar\/data\//.test(d.url || '')).slice(0, LIMIT);
console.log(`${todo.length} deals without a value`);
let filled = 0, tried = 0;

for (const d of todo) {
  const m = /\/Archives\/edgar\/data\/(\d+)\/(\d+)\//.exec(d.url);
  if (!m) continue;
  tried++;
  const base = `https://www.sec.gov/Archives/edgar/data/${m[1]}/${m[2]}`;
  const idx = await get(`${base}/index.json`, true);
  const items = idx?.directory?.item || [];
  const ex = items.filter((f) => /(?:^|[_-])(?:ex-?99|exhibit-?99)/i.test(f.name || '') || /^EX-99/i.test(f.type || ''));
  const pick = ex.find((f) => /99\.1/i.test(`${f.type} ${f.name}`)) || ex[0];
  let text = '';
  if (pick) text = textOf(await get(`${base}/${pick.name}`));
  if (!text) text = textOf(await get(d.url));
  const v = valueFrom(text);
  if (v) { d.value = v; filled++; if (DRY) console.log(`  + ${d.date} ${d.acquirer} → ${d.target}: $${v}m`); }
  if (tried % 25 === 0) {
    console.log(`  ${tried}/${todo.length} · filled ${filled}`);
    if (!DRY) { writeFileSync(STORE + '.tmp', JSON.stringify(store)); renameSync(STORE + '.tmp', STORE); }
  }
}

store.updated = new Date().toISOString();
if (!DRY) { writeFileSync(STORE + '.tmp', JSON.stringify(store)); renameSync(STORE + '.tmp', STORE); }
console.log(`tried ${tried} · filled ${filled} · book now has ${store.deals.filter((x) => x.value).length} priced deals`);
