// Attach the curated US theme lists to the company dataset.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const THEMES = join(ROOT, 'data', 'us-themes.json');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const book = JSON.parse(readFileSync(THEMES, 'utf8'));
const have = new Set(data.companies.map((c) => c.ticker));
let dropped = 0;
data.themes = (book.themes || []).map((t) => {
  const tickers = (t.tickers || []).filter((x) => {
    if (have.has(x)) return true;
    dropped++;
    return false;
  });
  return { id: t.id, label: t.label, kind: t.kind, note: t.note, tickers };
});
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`${data.themes.length} themes · ${data.themes.map((t) => `${t.label} ${t.tickers.length}`).join(' · ')}${dropped ? ` · ${dropped} dropped` : ''}`);
