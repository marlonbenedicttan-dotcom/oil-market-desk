// Attach the curated theme lists to the Japan dataset. Rule-based themes (banks, TSE reform) are
// computed in the client from live data, so only the written lists live here.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'japan.json');
const THEMES = join(ROOT, 'data', 'japan-themes.json');

const jp = JSON.parse(readFileSync(FILE, 'utf8'));
const book = JSON.parse(readFileSync(THEMES, 'utf8'));
const have = new Set(jp.companies.map((c) => c.code));
let dropped = 0;
const themes = (book.themes || []).map((t) => {
  const codes = (t.codes || []).filter((code) => {
    if (have.has(code)) return true;
    dropped++;
    return false;
  });
  return { id: t.id, label: t.label, kind: t.kind, note: t.note, codes };
});
jp.themes = themes;
writeFileSync(FILE + '.tmp', JSON.stringify(jp));
renameSync(FILE + '.tmp', FILE);
console.log(`${themes.length} curated themes · ${themes.map((t) => `${t.label} ${t.codes.length}`).join(' · ')}${dropped ? ` · ${dropped} unknown codes dropped` : ''}`);
