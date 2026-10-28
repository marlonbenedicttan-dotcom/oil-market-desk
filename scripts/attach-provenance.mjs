// Attach the exact filing behind each company's headline figures.
//
// "Latest annual 10-K" is not provenance — it is a description. This stores the accession number, the
// form, the period, the filing date and the direct document URL, so any number on the page can be
// traced to the document it came from in one click.
//
//   node scripts/attach-provenance.mjs
//   node scripts/attach-provenance.mjs --only=AAPL,MSFT

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.cik && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())));
console.log(`${todo.length} companies`);

let ok = 0;
let i = 0;
async function worker() {
  while (i < todo.length) {
    const c = todo[i++];
    try {
      const res = await fetch(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`, {
        headers: { 'User-Agent': UA },
      });
      if (!res.ok) { await sleep(250); continue; }
      const j = await res.json();
      const r = j?.filings?.recent;
      if (!r) continue;
      let best = null;
      for (let k = 0; k < (r.form || []).length; k++) {
        const form = r.form[k];
        if (form !== '10-K' && form !== '10-Q') continue;
        const filed = r.filingDate[k];
        if (!best || filed > best.filed) {
          best = {
            form,
            filed,
            period: r.reportDate?.[k] || null,
            accn: r.accessionNumber[k],
            doc: r.primaryDocument[k],
          };
        }
      }
      if (!best) continue;
      const accn = String(best.accn).replace(/-/g, '');
      c.lastFiling = {
        form: best.form,
        filed: best.filed,
        period: best.period,
        accn: best.accn,
        url: best.doc ? `https://www.sec.gov/Archives/edgar/data/${c.cik}/${accn}/${best.doc}` : null,
      };
      ok++;
    } catch { /* leave the previous value */ }
    await sleep(120);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

console.log(`filing attached to ${ok} companies`);
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
