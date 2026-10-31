// Attach descriptions and brand chips to the Korea dataset.
//
// The build rewrites korea.json from scratch, so this runs after it — otherwise a rebuild silently
// drops every description, which is exactly what happened once.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'korea.json');
const BRANDS = join(ROOT, 'data', 'korea-brands.json');
const CACHE = join(ROOT, 'data', 'cache', 'korea-profiles');
const STORE = join(ROOT, 'data', 'korea-profiles.json');

const shorten = (t, max = 300) => {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return i > 80 ? cut.slice(0, i + 1) : `${cut.replace(/[,;\s]+\S*$/, '')}\u2026`;
};
const won = (v) => {
  if (v == null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a >= 1e12) return `\u20a9${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e8) return `\u20a9${(v / 1e8).toFixed(1)}B`;
  return `\u20a9${Math.round(v / 1e4)}\ub9cc`;
};

// Profiles live in a committed file so a CI rebuild — which has no local cache — keeps them.
let stored = {};
try { stored = JSON.parse(readFileSync(STORE, 'utf8')).profiles || {}; } catch { /* none yet */ }

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const brands = JSON.parse(readFileSync(BRANDS, 'utf8')).brands || {};
let fetched = 0, generated = 0;
for (const c of data.companies) {
  c.brands = brands[c.ticker] || [];
  const f = join(CACHE, `${c.ticker}.json`);
  let text = stored[c.ticker] || null;
  if (!text && existsSync(f)) { try { text = JSON.parse(readFileSync(f, 'utf8')).text; } catch { /* none */ } }
  if (text) {
    c.description = shorten(text);
    c.descSource = 'profile';
    c.descSourceName = 'stockanalysis.com';
    fetched++;
  } else if (/REIT/i.test(c.nameEn || c.name || '')) {
    // A REIT is a different animal: it owns property, collects rent and must distribute most of its
    // taxable income. Saying that is accurate without guessing at a portfolio we cannot see.
    c.description = `${c.nameEn || c.name} is a Korean real estate investment trust listed on KOSPI. It earns rent from a property portfolio and is required to distribute most of its taxable income to shareholders, which is why REITs usually carry a higher yield than the market.`;
    c.descSource = 'generated';
    generated++;
  } else {
    const last = (c.history || []).slice(-1)[0];
    c.description = `${c.nameEn || c.name} is a KOSPI-listed company${last && last.s ? ` with ${won(last.s)} of revenue` : ''}. No company profile was available, so this line is generated from the filing data.`;
    c.descSource = 'generated';
    generated++;
  }
}
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`${fetched} fetched · ${generated} generated · ${Object.keys(brands).length} brand sets`);
