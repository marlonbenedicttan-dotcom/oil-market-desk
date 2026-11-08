// Refresh the emergency seed for the macro backdrop.
//
//   node scripts/build-regime-seed.mjs
//
// The server keeps a last-good row in memory and on disk. This seed is the third layer: it is
// committed, so a deploy that lands while Yahoo and FRED are both unavailable still paints the board
// with real values and their as-of dates instead of eight dashes. A failed symbol keeps yesterday's
// seed row; a run that fetches nothing at all does not advance `updated`.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIME_BOARD, buildRegimeRow } from '../src/regime.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'regime-seed.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (oil-basis)' };
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function yahooMap(symbol, range = '2y', interval = '1d') {
  const res = await fetch(`${YF}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, { headers: UA });
  if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
  const r = (await res.json()).chart?.result?.[0];
  if (!r) throw new Error(`Yahoo ${symbol} no result`);
  const out = {};
  (r.timestamp || []).forEach((t, i) => {
    const c = (r.indicators?.quote?.[0]?.close || [])[i];
    if (c != null) out[new Date(t * 1000).toISOString().slice(0, 10)] = c;
  });
  return out;
}

async function fredMap(id, days = 3 * 366) {
  const cosd = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, { headers: UA });
  if (!res.ok) throw new Error(`FRED ${id} ${res.status}`);
  const text = await res.text();
  if (!/^(DATE|observation_date),/i.test(text.trimStart().slice(0, 40))) throw new Error(`FRED ${id} not CSV`);
  const out = {};
  for (const line of text.trim().split('\n').slice(1)) {
    const [d, v] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !v || v === '.') continue;
    const n = parseFloat(v);
    if (Number.isFinite(n)) out[d] = n;
  }
  return out;
}

async function fetchSeries(s) {
  if (s.fred) {
    try { const map = await fredMap(s.fred); if (Object.keys(map).length >= 5) return { map, source: 'FRED' }; } catch {}
  } else {
    try { const map = await yahooMap(s.sym); if (Object.keys(map).length >= 5) return { map, source: 'Yahoo' }; } catch {}
  }
  if (s.altSym) {
    try {
      let map = await yahooMap(s.altSym);
      if (Object.values(map).some((v) => v > 20)) map = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v / 10]));
      if (Object.keys(map).length >= 5) return { map, source: 'Yahoo' };
    } catch {}
  }
  if (s.fallbackFred) {
    try { const map = await fredMap(s.fallbackFred); if (Object.keys(map).length >= 5) return { map, source: 'FRED' }; } catch {}
  }
  return null;
}

let previous = [];
try { previous = JSON.parse(readFileSync(OUT, 'utf8')).rows || []; } catch {}
const prevById = new Map(previous.map((r) => [r.id, r]));
const rows = [];
let fresh = 0;
for (const s of REGIME_BOARD) {
  const got = await fetchSeries(s);
  const row = got ? buildRegimeRow(s, got.map, got.source) : null;
  if (row) { rows.push(row); fresh++; }
  else if (prevById.has(s.id)) rows.push(prevById.get(s.id));
  console.log(`${s.id.padEnd(6)} ${row ? `${row.price} @ ${row.asOf} · ${row.source}` : prevById.has(s.id) ? `kept ${prevById.get(s.id).asOf}` : '— no data'}`);
}
if (!fresh) {
  console.log('no fresh sources — keeping the committed seed untouched');
  process.exit(0);
}
const body = JSON.stringify({
  updated: new Date().toISOString(),
  note: 'Emergency last-good seed for the macro backdrop. Refreshed by companies-daily; rows older than 14 days are ignored.',
  rows,
}, null, 0);
writeFileSync(`${OUT}.tmp`, body);
renameSync(`${OUT}.tmp`, OUT);
console.log(`wrote ${rows.length} rows (${fresh} fresh) to data/regime-seed.json`);
