// Read the latest consolidated balance-sheet instants from a filing's XBRL instance.
//
// This is the fallback for companies whose 10-Q is newer than the companyfacts/companyconcept
// balance sheet: YTD-only, dimensional or custom-tagged facts never reach the frames API.
//
//   node scripts/refresh-us-instance-balance.mjs --limit=25
//   node scripts/refresh-us-instance-balance.mjs --only=F,DUK,SO

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CACHE = join(ROOT, 'data', 'cache', 'instances');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(readFileSync(FILE, 'utf8'));
mkdirSync(CACHE, { recursive: true });

const TAGS = ['Assets', 'StockholdersEquity', 'AssetsCurrent', 'LiabilitiesCurrent', 'CashAndCashEquivalentsAtCarryingValue'];
const lastQ = (c) => (c.quarters || []).slice(-1)[0]?.end || null;
const fundamental = (c) => /^(10-[KQ]|20-F|40-F)/.test(String(c.lastFiling?.form || ''));
const stale = (c) => c.lastFiling?.period && fundamental(c) && (
  (lastQ(c) && c.lastFiling.period > lastQ(c))
  || (c.assetsEnd && c.lastFiling.period > c.assetsEnd)
  || (c.equityEnd && c.lastFiling.period > c.equityEnd)
  || (c.currentAssets == null && c.assetsEnd && c.lastFiling.period > c.assetsEnd)
);

async function get(url, text = false) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 403) { await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) { await sleep(800 * (i + 1)); continue; }
      return text ? res.text() : res.json();
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

function parse(xml) {
  const contexts = new Map();
  let m;
  const re = /<context\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/context>/g;
  while ((m = re.exec(xml))) {
    const b = m[2];
    contexts.set(m[1], {
      instant: /<instant>([^<]+)<\/instant>/.exec(b)?.[1] || null,
      segment: /<segment\b/.test(b),
    });
  }
  const latest = new Map();
  for (const tag of TAGS) {
    const reF = new RegExp(`<(?:us-gaap|ifrs-full):${tag}\\b[^>]*contextRef="([^"]+)"[^>]*>([^<]+)<`, 'g');
    let f;
    while ((f = reF.exec(xml))) {
      const val = Number(f[2].trim());
      if (!Number.isFinite(val)) continue;
      const ctx = contexts.get(f[1]);
      if (!ctx?.instant || ctx.segment) continue; // consolidated balance only
      const old = latest.get(tag);
      if (!old || ctx.instant > old.end) latest.set(tag, { val, end: ctx.instant });
    }
  }
  if (!latest.size) return null;
  const end = [...latest.values()].map((x) => x.end).sort().at(-1);
  const pick = (tag) => (latest.get(tag)?.end === end ? latest.get(tag).val : null);
  return { end, assets: pick('Assets'), equity: pick('StockholdersEquity'), currentAssets: pick('AssetsCurrent'), currentLiabilities: pick('LiabilitiesCurrent'), cash: pick('CashAndCashEquivalentsAtCarryingValue') };
}

const candidates = data.companies.filter((c) => c.cik && c.lastFiling?.url && fundamental(c) && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())) && (onlySet || stale(c)));
const todo = LIMIT ? candidates.slice(0, LIMIT) : candidates;
console.log(`${todo.length} candidates`);
let updated = 0;
for (const c of todo) {
  const url = c.lastFiling.url;
  const dir = url.replace(/\/[^/]+$/, '');
  const idx = await get(`${dir}/index.json`);
  const xmlName = (idx?.directory?.item || []).map((x) => x.name).find((n) => /_htm\.xml$/i.test(n));
  if (!xmlName) continue;
  const accn = (url.match(/\/(\d{18})\//) || [])[1] || 'x';
  const cache = join(CACHE, `${c.cik}-${accn}.xml`);
  let xml = null;
  if (existsSync(cache)) { try { xml = readFileSync(cache, 'utf8'); } catch { /* refetch */ } }
  if (!xml) { xml = await get(`${dir}/${xmlName}`, true); if (xml) writeFileSync(cache, xml); }
  if (!xml) continue;
  const b = parse(xml);
  if (!b) continue;
  let changed = false;
  if (b.assets > 0 && (!c.assetsEnd || b.end > c.assetsEnd)) { c.assets = b.assets; c.assetsEnd = b.end; changed = true; }
  if (b.equity != null && (!c.equityEnd || b.end > c.equityEnd)) { c.equity = b.equity; c.equityEnd = b.end; changed = true; }
  if (b.currentAssets > 0) c.currentAssets = b.currentAssets;
  if (b.currentLiabilities > 0) c.currentLiabilities = b.currentLiabilities;
  if (b.cash > 0) { c.cash = b.cash; c.cashEnd = b.end; }
  if (changed) { updated++; console.log(`${c.ticker}: ${b.end} assets ${b.assets == null ? '—' : (b.assets / 1e9).toFixed(2) + 'B'} equity ${b.equity == null ? '—' : (b.equity / 1e9).toFixed(2) + 'B'}`); }
  await sleep(180);
}
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`updated ${updated} companies`);
