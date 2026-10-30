// Themes are rules plus curated additions, not a typed list.
//
//   members = (companies whose industry is in the theme's list  ∪  curated tickers)  −  exclusions
//
// A hand-written list always misses someone (Sandisk was missing from AI). The industry rule keeps the
// membership current, the curated list catches what the taxonomy misfiles, and the audit script reports
// anything that looks like a member but is not.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const THEMES = join(ROOT, 'data', 'us-themes.json');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const book = JSON.parse(readFileSync(THEMES, 'utf8'));
const byTicker = new Map(data.companies.map((c) => [c.ticker, c]));

data.themes = (book.themes || []).map((t) => {
  const members = new Set();
  for (const c of data.companies) {
    if (t.industries && t.industries.includes(c.industry)) members.add(c.ticker);
  }
  for (const x of t.tickers || []) if (byTicker.has(x)) members.add(x);
  for (const x of t.exclude || []) members.delete(x);
  return {
    id: t.id, label: t.label, kind: 'curated',
    industries: t.industries || [], anchors: t.anchors || [], note: t.note,
    tickers: [...members].filter((x) => byTicker.has(x)).sort(),
  };
});

writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(data.themes.map((t) => `${t.label} ${t.tickers.length}`).join(' · '));
