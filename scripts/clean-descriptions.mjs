// Clean the company descriptions.
//
// The 10-K Item 1 text arrives with heading residue ("GENERAL At Pentair…", "Overview IDEX…"), legal
// boilerplate ("The terms 'we', 'us', 'our' … mean …"), and many descriptions never name the company at
// all ("Our corporate purpose is…" — which company?). Nasdaq's profiles are cleaner but sometimes
// describe a foundation rather than the business.
//
// This strips the residue, drops a leading legal-terms sentence, and prefixes the company name when the
// text does not identify it. It never invents content.
//
//   node scripts/clean-descriptions.mjs --dry

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const DRY = process.argv.includes('--dry');

const HEADING = /^(?:(?:general|overview|business|item\s*\d+[a-z]?\.?|part\s+i{1,3})\s*[:.\-–]?\s*)+/i;
const LEGAL = /^The terms\s+[^.]{0,120}?\b(?:mean|refer to|are used)\b[^.]*\.\s*/i;
const RESIDUE = /(Item\s+\d+[A-Z]?\.|PART\s+I{1,3}\b|Mine Safety Disclosures|Table of Contents|Market for Registrant|Market for .{0,80}Common Equity|Issuer Purchases of Equity)/i;

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let stripped = 0;
let prefixed = 0;
let dropped = 0;

for (const c of data.companies) {
  let d = c.description;
  if (!d) continue;
  const before = d;

  // heading residue
  const noHead = d.replace(HEADING, '');
  if (noHead !== d && noHead.length > 60) { d = noHead; stripped++; }

  // legal-terms opening
  const noLegal = d.replace(LEGAL, '');
  if (noLegal !== d && noLegal.length > 80) { d = noLegal; dropped++; }

  // still table-of-contents? drop it entirely; the Nasdaq pass will refill.
  if (RESIDUE.test(d)) { c.description = null; continue; }

  d = d.replace(/\s+/g, ' ').trim();
  d = d.replace(/^[,;:\-\s]+/, '');
  if (d) d = d[0].toUpperCase() + d.slice(1);

  // name the company if the text never does
  const words = String(c.name || '').split(/\s+/).filter((w) => !/^(the|a|an|of|and|&)$/i.test(w));
  const key = (words[0] || '').replace(/[,.]/g, '');
  if (key && key.length >= 3 && !d.slice(0, 160).toLowerCase().includes(key.toLowerCase())) {
    const short = c.name.replace(/\s+(Inc\.?|Corp\.?|Corporation|Company|Co\.?|plc|Ltd\.?|Holdings?)$/i, '').replace(/[,\s]+$/, '');
    d = `${short} — ${d}`;
    prefixed++;
  }

  if (d && !/[.!?]$/.test(d)) d = d.replace(/[,;:\s]+$/, '') + '.';
  if (d !== before) c.description = d;
}

console.log(`${stripped} headings stripped · ${dropped} legal openings dropped · ${prefixed} prefixed with the company name`);
if (!DRY) {
  data.updated = new Date().toISOString();
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
  console.log('written');
}
