// Theme audit: is a theme still complete?
//
// A typed list always misses someone. This checks two things every run:
//   1. Anchors — names that must be in the theme. Missing anchor = failure.
//   2. Candidates — companies whose own description says they are in this business but who are not
//      in the theme. Not a failure, but a list to review: this is how Sandisk gets caught.
//
//   node scripts/audit-themes.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const KEYWORDS = {
  ai: /semiconductor|wafer|lithograph|foundry|\bNAND\b|\bDRAM\b|\bGPU\b|AI accelerator|chip ?maker|chip designer|build-up film|memory chips?/i,
  defence: /defence|defense|military|missile|radar|aerospace|aircraft|submarine|naval|munitions|fighter|intelligence community|national security|government agenc|surveillance|counterterrorism|DoD/i,
  power: /nuclear|electric utility|power generation|power grid|electricity generat|independent power/i,
};

function audit(label, companies, themes, keyOf, nameOf) {
  let failures = 0;
  console.log(`\n${label}`);
  for (const t of themes) {
    const members = new Set(keyOf(t));
    const anchors = t.anchors || [];
    const missing = anchors.filter((a) => !members.has(a));
    const kw = KEYWORDS[t.id];
    const candidates = kw
      ? companies
        .filter((c) => !members.has(nameOf(c)) && kw.test(c.description || ''))
        .map((c) => nameOf(c))
      : [];
    const flag = missing.length ? 'FAIL' : 'ok  ';
    console.log(`  ${flag} ${t.label.padEnd(20)} ${String(members.size).padStart(4)} members · ${missing.length ? `missing anchors: ${missing.join(', ')}` : 'anchors present'}${candidates.length ? ` · ${candidates.length} candidates to review` : ''}`);
    if (candidates.length) console.log(`         ${candidates.slice(0, 14).join(' ')}${candidates.length > 14 ? ' …' : ''}`);
    failures += missing.length;
  }
  return failures;
}

const us = JSON.parse(readFileSync(join(ROOT, 'data', 'companies.json'), 'utf8'));
const jp = JSON.parse(readFileSync(join(ROOT, 'data', 'japan.json'), 'utf8'));

let fails = 0;
fails += audit('US', us.companies.filter((c) => !c.shareClass), us.themes || [], (t) => t.tickers, (c) => c.ticker);
fails += audit('JAPAN', jp.companies, jp.themes || [], (t) => t.codes, (c) => c.code);

console.log(fails ? `\n${fails} anchor failures` : '\nall anchors present');
process.exit(fails ? 1 : 0);
