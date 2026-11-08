// Refresh the emergency seed for the HOME risk & correlation board.
//
//   node scripts/build-risk-seed.mjs
//
// The seed stores the actual daily series, not just the rendered metrics: the server must be able to
// recompute the correlation matrix from it when Yahoo is unavailable. It is refreshed daily by
// companies-daily; a failed instrument keeps yesterday's map, and a run that fetches nothing does not
// advance `updated`.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RISK_SERIES } from '../src/risk.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'risk-seed.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (oil-basis)' };
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function yahooMap(symbol, range = '1y', interval = '1d') {
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

async function fredMap(id, days = 400) {
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
    if (s.altSym) {
      try {
        let map = await yahooMap(s.altSym);
        if (Object.values(map).some((v) => v > 20)) map = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v / 10]));
        if (Object.keys(map).length >= 5) return { map, source: 'Yahoo' };
      } catch {}
    }
    return null;
  }
  try { const map = await yahooMap(s.sym); if (Object.keys(map).length >= 5) return { map, source: 'Yahoo' }; } catch {}
  if (s.fallbackFred) {
    try { const map = await fredMap(s.fallbackFred); if (Object.keys(map).length >= 5) return { map, source: 'FRED' }; } catch {}
  }
  return null;
}

let previous = {};
try { previous = JSON.parse(readFileSync(OUT, 'utf8')).series || {}; } catch {}
const series = {};
let fresh = 0;
for (const s of RISK_SERIES) {
  const got = await fetchSeries(s);
  if (got && Object.keys(got.map).length >= 5) {
    series[s.key] = { source: got.source, map: got.map };
    fresh++;
    console.log(`${s.key.padEnd(6)} ${Object.keys(got.map).length} points · ${got.source}`);
  } else if (previous[s.key]) {
    series[s.key] = previous[s.key];
    console.log(`${s.key.padEnd(6)} kept ${Object.keys(previous[s.key].map || {}).length} points from the committed seed`);
  } else {
    console.log(`${s.key.padEnd(6)} — no data`);
  }
}
if (!fresh) {
  console.log('no fresh sources — keeping the committed risk seed untouched');
  process.exit(0);
}
const body = JSON.stringify({
  updated: new Date().toISOString(),
  note: 'Emergency daily series for the HOME risk board. Refreshed by companies-daily; maps older than 14 days are ignored.',
  series,
});
writeFileSync(`${OUT}.tmp`, body);
renameSync(`${OUT}.tmp`, OUT);
console.log(`wrote ${Object.keys(series).length} series (${fresh} fresh) to data/risk-seed.json`);
