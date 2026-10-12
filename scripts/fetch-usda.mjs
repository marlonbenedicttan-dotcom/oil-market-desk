// Snapshot fetcher — pulls the official USDA PSD (FAS) supply & demand balance and writes a
// small data/usda.json for the app to serve.
//
// Source: USDA Foreign Agricultural Service, "PSD Online" bulk CSV downloads (keyless).
//   https://apps.fas.usda.gov/psdonline/downloads/psd_<set>_csv.zip
// Metric: the classic tightness number — STOCKS-TO-USE for the United States:
//   stocks-to-use = ending stocks ÷ (domestic consumption + exports), by MARKET YEAR.
//   Low stocks-to-use = tight, high = ample. (We use the US balance: it is unambiguous — the
//   PSD bulk has no "World" row and summing countries risks double-counting aggregates.)
//
// Why a snapshot: the CSVs are large (tens of MB) and updated only monthly; we fetch once
// (weekly, via scripts/snapshot-and-push.sh on the user's Mac) and commit the tiny result.
// Re-run: node scripts/fetch-usda.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'usda.json');
const BASE = 'https://apps.fas.usda.gov/psdonline/downloads';
const SETS = ['grains_pulses', 'oilseeds', 'dairy', 'livestock'];

// our benchmark id -> [PSD commodity code, human label]
const MAP = {
  corn: ['0440000', 'Corn'], wheat: ['0410000', 'Wheat'], soybean: ['2222000', 'Soybeans'],
  soymeal: ['0813100', 'Soybean meal'], soyoil: ['4232000', 'Soybean oil'],
  butter: ['0230000', 'Butter'], cheese: ['0240000', 'Cheese'], nfdm: ['0224200', 'Nonfat dry milk'],
  cattle: ['0111000', 'Beef & veal'], hogs: ['0113000', 'Pork'],
};
const US = 'US';

const splitCsvLine = (line) => {
  // Minimal RFC-4180 split: handles quoted fields with commas/newlines are not expected here
  // (PSD descriptions are plain), so a simple quote-aware split is enough.
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
};

async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (marlons-watchtower snapshot)' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  const codes = new Map(Object.values(MAP).map(([c, l]) => [c, l]));
  // accumulators: code -> market year -> { end, cons, exp }
  const acc = {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usda-'));
  for (const set of SETS) {
    const zip = path.join(tmp, `${set}.zip`);
    const bytes = await download(`${BASE}/psd_${set}_csv.zip`, zip);
    let csv;
    try { csv = execFileSync('unzip', ['-p', zip], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8'); }
    catch (e) { console.warn(`  ! could not unzip ${set}: ${e.message}`); continue; }
    const lines = csv.split('\n');
    const hdr = splitCsvLine(lines[0]);
    const ix = Object.fromEntries(hdr.map((h, i) => [h.trim(), i]));
    let n = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const f = splitCsvLine(line);
      const code = f[ix.Commodity_Code];
      if (!codes.has(code) || f[ix.Country_Code] !== US) continue;
      const attr = f[ix.Attribute_Description];
      if (attr !== 'Ending Stocks' && attr !== 'Domestic Consumption' && attr !== 'Exports') continue;
      const year = f[ix.Market_Year];
      const val = Number(f[ix.Value]);
      if (!year || !isFinite(val)) continue;
      const slot = ((acc[code] ||= {})[year] ||= { end: null, cons: null, exp: null });
      if (attr === 'Ending Stocks') slot.end = val;
      else if (attr === 'Domestic Consumption') slot.cons = val;
      else slot.exp = val;
      n++;
    }
    console.log(`  ${set}: ${bytes.toLocaleString()} bytes, ${n} US rows used`);
  }

  const commodities = {};
  for (const [id, [code, label]] of Object.entries(MAP)) {
    const years = acc[code];
    if (!years) { console.warn(`  ! no US data for ${id} (${code})`); continue; }
    const history = Object.entries(years)
      .map(([y, s]) => ({ year: +y, stocksToUse: (s.cons + s.exp) > 0 && s.end != null ? s.end / (s.cons + s.exp) : null }))
      .filter((h) => h.stocksToUse != null && h.stocksToUse >= 0)
      .sort((a, b) => a.year - b.year)
      .slice(-30);
    if (!history.length) { console.warn(`  ! no stocks-to-use for ${id}`); continue; }
    const last = history[history.length - 1];
    const yy = (n) => String(n % 100).padStart(2, '0');
    commodities[id] = {
      code, label,
      marketYear: last.year,
      yearLabel: `${last.year}/${yy(last.year + 1)}`,
      stocksToUse: +last.stocksToUse.toFixed(4),
      history: history.map((h) => ({ year: h.year, stocksToUse: +h.stocksToUse.toFixed(4) })),
    };
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  const out = {
    updated: new Date().toISOString(),
    source: 'USDA PSD (FAS) — US balance',
    metric: 'stocks-to-use = ending stocks / (domestic consumption + exports), by market year',
    commodities,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`wrote ${OUT}: ${Object.keys(commodities).length} commodities`);
  for (const [id, c] of Object.entries(commodities)) console.log(`  ${id.padEnd(8)} ${c.yearLabel}  stocks-to-use ${(c.stocksToUse * 100).toFixed(1)}%  (${c.history.length}y history)`);
}

main().catch((e) => { console.error('fetch-usda failed:', e.message); process.exit(1); });
