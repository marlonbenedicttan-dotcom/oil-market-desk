// The symbology source caps English names at 30 characters, so a handful read "SAMSUNG LIFE INSURANCE CO LT".
// DART publishes the full English name with the company record; this refetches only the ones that look cut off.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'cache', 'dart');
const FILE = join(ROOT, 'data', 'korea-universe.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const KEY = process.env.DART_API_KEY;
if (!KEY) throw new Error('DART_API_KEY is not set');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A trailing fragment of a word is the tell: "CO LT", "& OFFS", "SECURITIES C", "CONSTRUC".
const FRAGMENT = /(?:^|\s)(LT|C|INS|OFFS|CONST|CONSTRUC|COR|SOLUTIO|ENGIN|INVESTME|DEVELOPME|TECHNOLOG|ELECTRON|INDUSTRIE|SECURITIE|COMMUNICATIO|ENTERTAINME|INTERNATIONA|MANAGEME|PHARMACEUTICA|MATERIA|CHEMICA)$/;
const suspect = (name) => name.length >= 28 || FRAGMENT.test(name);

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const targets = data.companies.filter((c) => c.nameEn && suspect(c.nameEn.trim()));
console.log(`${data.companies.length} companies · ${targets.length} names look cut off`);

const clean = (s) => s.replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim().toUpperCase();
let fixed = 0, kept = 0;
for (let i = 0; i < targets.length; i++) {
  const c = targets[i];
  const f = join(CACHE, `info-${c.code}.json`);
  let eng = null;
  try {
    const res = await fetch(`https://opendart.fss.or.kr/api/company.json?crtfc_key=${KEY}&corp_code=${c.code}`, { headers: { 'User-Agent': UA } });
    if (res.status === 429) { await sleep(5000); i--; continue; }
    const j = await res.json();
    eng = j.corp_name_eng || null;
    if (eng && existsSync(f)) {
      // Remember it so a later refresh keeps the full name.
      const cached = JSON.parse(readFileSync(f, 'utf8'));
      cached.v = 2; cached.nameEn = eng;
      writeFileSync(f, JSON.stringify(cached));
    }
  } catch { /* keep the old name */ }
  await sleep(450);
  const next = eng ? clean(eng) : null;
  if (next && next.length > c.nameEn.trim().length) { c.nameEn = next; fixed++; }
  else kept++;
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${targets.length} · ${fixed} extended`);
}

data.updated = new Date().toISOString().slice(0, 10);
writeFileSync(FILE, JSON.stringify(data, null, 1));
console.log(`extended ${fixed}, left ${kept}`);
console.log(targets.slice(0, 6).map((c) => `  ${c.ticker} ${c.nameEn}`).join('\n'));
