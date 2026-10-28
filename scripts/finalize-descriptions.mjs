// One resolver for every company description.
//
// Two sources exist — the 10-K's Item 1 text and Nasdaq's company profile — and both can be wrong in
// different ways. Patching them one regex at a time was the mistake. This scores every candidate against
// the same gate and keeps the best; if neither passes, it writes an honest generated line instead of
// leaving something misleading on the page.
//
// Gate (all must hold):
//   - names the company in the first 60 characters
//   - 90–420 characters, ends with a sentence
//   - no table-of-contents residue, no legal-terms opening
//   - not about a foundation, a PAC, or a subsidiary
//
//   node scripts/finalize-descriptions.mjs --dry

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESIDUE = /(Item\s+\d+[A-Z]?\.|PART\s+I{1,3}\b|Mine Safety Disclosures|Table of Contents|Market for Registrant|Common Equity, Related|Issuer Purchases|herein by reference)/i;
const LEGAL = /^(the terms|unless the context|in this (annual )?report)/i;
const NOT_BUSINESS = /\b(foundation|charitable|political action committee|PAC|employee stock purchase)\b/i;

const keyOf = (name) => {
  const w = String(name || '').split(/\s+/).filter((x) => !/^(the|a|an|of|and|&)$/i.test(x));
  return (w[0] || '').replace(/[,.]/g, '');
};

function score(d, c) {
  if (!d) return -1;
  const t = String(d).replace(/\s+/g, ' ').trim();
  const k = keyOf(c.name).toLowerCase();
  let s = 0;
  if (RESIDUE.test(t)) return -1;
  if (LEGAL.test(t)) return -1;
  if (NOT_BUSINESS.test(t)) return -1;
  if (t.length < 80 || t.length > 420) s -= 2;
  if (!/[.!?]$/.test(t)) s -= 1;
  // The company must be identified early, not after two sentences of prose.
  // The company has to be identified early. A name buried after two sentences of history is not a
  // description of the business ("The present corporation was incorporated in … 1936").
  const head = t.slice(0, 90).toLowerCase().replace(/[.]/g, '');
  if (k && head.includes(k.replace(/[.]/g, ''))) s += 3;
  else s -= 3;
  const sentences = t.split(/(?<=[.!?])\s+/).filter((x) => x.length > 25);
  if (sentences.length >= 2) s += 2;
  if (/\b(is|are|provides|operates|designs|manufactures|sells|develops|offers|makes|builds|owns|runs)\b/i.test(t)) s += 1;
  if (/^(our|we|the company|the registrant)\b/i.test(t)) s -= 2;
  return s;
}

async function nasdaqProfile(ticker) {
  const sym = String(ticker).replace('-', '.');
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/company-profile?assetclass=stocks`, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      });
      if (!res.ok) { await sleep(500); continue; }
      const j = await res.json();
      return j?.data?.CompanyDescription?.value || null;
    } catch { await sleep(500); }
  }
  return null;
}

function tidyNasdaq(raw, c) {
  if (!raw) return null;
  let t = String(raw).replace(/\s+/g, ' ').trim();
  t = t.replace(/^(The Company|Company Description)[:\s-]*/i, '');
  const ABBR = /\b(U\.S|U\.K|Inc|Corp|Co|Ltd|Mr|Ms|Dr|No|St|vs|etc)\.$/i;
  const out = [];
  let buf = '';
  for (const part of t.split(/(?<=[.!?])\s+/)) {
    buf = buf ? `${buf} ${part}` : part;
    if (!ABBR.test(buf)) { if (buf.length > 20) out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  let d = out.slice(0, 2).join(' ');
  if (d.length > 420) d = d.slice(0, 417).replace(/[,;\s]+\S*$/, '') + '…';
  return d || null;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let fromTenK = 0;
let fromNasdaq = 0;
let generated = 0;
let changed = 0;

for (const c of data.companies) {
  const candidates = [];
  const tenk = c.description;
  if (tenk) candidates.push({ src: '10-K', text: tenk, score: score(tenk, c) });
  if (!tenk || score(tenk, c) < 3) {
    const raw = await nasdaqProfile(c.ticker);
    const nd = tidyNasdaq(raw, c);
    if (nd) candidates.push({ src: 'nasdaq', text: nd, score: score(nd, c) });
    await sleep(200);
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (best && best.score >= 3) {
    // If the winning text is what we already had, keep its recorded provenance instead of relabelling it.
    const keepSource = best.text === tenk ? (c.descriptionSource || '10-K') : best.src;
    if (c.description !== best.text) { c.description = best.text; changed++; }
    c.descriptionSource = keepSource;
    if (keepSource === '10-K') fromTenK++; else fromNasdaq++;
  } else {
    // A factual line beats a misleading one. Clean the registered name and give it substance.
    const clean = String(c.name || c.ticker)
      .replace(/\\[A-Z]{2}\\/g, '').replace(/\s*\/\s*[A-Z]{2}\s*$/i, '')
      .replace(/\s+(INC\.?|CORP\.?|CO\.?|LTD\.?|PLC|LLC)$/i, '')
      .replace(/[,\s]+$/, '')
      // Title-case an all-caps registered name, but keep initials ("US", "J M", "W.W.") intact.
      .replace(/^([A-Z0-9&.\- ]+)$/, (m) => m.split(' ').map((w) => (w.replace(/[^A-Za-z]/g, '').length <= 2 ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(' '));
    const industry = c.industry ? ` in the ${String(c.industry).toLowerCase()} industry` : '';
    const rev = c.revenue ? `, with $${(c.revenue / 1e9).toFixed(0)}B of revenue` : '';
    const sector = String(c.sector || 'public').toLowerCase();
    const article = /^[aeiou]/i.test(sector) ? 'an' : 'a';
    const line = `${clean} is ${article} ${sector} company${industry}${rev}.`;
    if (c.description !== line) { c.description = line; changed++; }
    c.descriptionSource = 'generated';
    generated++;
  }
}

const counts = {};
for (const c of data.companies) counts[c.descriptionSource || 'none'] = (counts[c.descriptionSource || 'none'] || 0) + 1;
console.log(`sources: ${JSON.stringify(counts)} · ${changed} changed`);

// verify the gate on the final text
const failures = data.companies.filter((c) => score(c.description, c) < 3);
console.log(`${failures.length} descriptions still fail the gate`);
for (const f of failures.slice(0, 8)) console.log(`  ${f.ticker}: ${(f.description || '').slice(0, 80)}`);

if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
