// Detect new annual or quarterly filings since the last refresh.
//
// The daily job does not need to re-read 500 filing indexes; it needs to know which companies filed
// something new. This compares the latest 10-K/10-Q accession for each CIK with the stored state and
// writes the list of tickers that changed.
//
//   node scripts/detect-new-filings.mjs
//   node scripts/detect-new-filings.mjs --all     # report every company (first run)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const STATE = join(ROOT, 'data', 'filings-state.json');
const OUT = join(ROOT, 'data', 'filings-changed.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const ALL = process.argv.includes('--all');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { filings: {} };
const prev = state.filings || {};

const todo = data.companies.filter((c) => c.cik);
console.log(`${todo.length} companies · ${Object.keys(prev).length} known filings`);

const changed = [];
let checked = 0;
let failed = 0;
let i = 0;

async function worker() {
  while (i < todo.length) {
    const c = todo[i++];
    const cik = String(c.cik).padStart(10, '0');
    try {
      const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': UA } });
      if (!res.ok) { failed++; await sleep(300); continue; }
      const j = await res.json();
      const r = j?.filings?.recent;
      if (!r) { failed++; continue; }
      let latest = null;
      for (let k = 0; k < (r.form || []).length; k++) {
        const form = r.form[k];
        if (form !== '10-K' && form !== '10-Q') continue;
        const date = r.filingDate[k];
        if (!latest || date > latest.date) latest = { acc: r.accessionNumber[k], form, date };
      }
      checked++;
      if (!latest) continue;
      const old = prev[String(c.cik)];
      const isNew = !old || old.acc !== latest.acc;
      if (isNew) changed.push({ ticker: c.ticker, cik: c.cik, ...latest, was: old?.acc || null });
      prev[String(c.cik)] = latest;
    } catch { failed++; }
    await sleep(120);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

state.filings = prev;
state.updated = new Date().toISOString();
writeFileSync(STATE, JSON.stringify(state, null, 0));

const list = ALL ? todo.map((c) => c.ticker) : changed.map((c) => c.ticker);
writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), tickers: list, details: changed }, null, 1));

console.log(`checked ${checked} · failed ${failed} · new filings ${changed.length}`);
for (const c of changed.slice(0, 20)) console.log(`  ${c.ticker}: ${c.form} ${c.date} (${c.acc})`);
if (changed.length > 20) console.log(`  … ${changed.length - 20} more`);
