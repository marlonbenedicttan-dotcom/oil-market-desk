// Fill the optional pages for the companies a reader is most likely to open.
//
// The tail is built in --fast mode (income + balance only): every number the market needs, at half the
// requests. The cash-flow page adds the CFO/CFI split and the quarterly page adds the report-period
// table — worth fetching for the largest companies, not for 800 illiquid ones.
//
//   node scripts/hongkong-polish.mjs --top=400
//
// Writes pages into the same cache the build reads; nothing else changes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, HK_SA } from './hkex.mjs';
import { getCached, sleep } from './stockanalysis.mjs';

const arg = (k, d) => (process.argv.find((x) => x.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const TOP = Number(arg('top', 400)) || 400;
const GAP = Number(arg('gap', 900)) || 900;

const hk = JSON.parse(readFileSync(join(ROOT, 'data', 'hongkong.json'), 'utf8'));
const CROSS = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'data', 'hongkong-crosslist.json'), 'utf8')).entries || {}; } catch { return {}; } })();
const listing = (code) => (CROSS[code] ? `${CROSS[code].exchange}/${CROSS[code].code}` : `hkg/${code}`);
const key = (code, p, q) => `${CROSS[code] ? `${CROSS[code].exchange}-${CROSS[code].code}` : code}-${p}${q ? '-q' : ''}`;

const list = [...hk.companies].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, TOP);
console.log(`polishing ${list.length} companies (cash flow + quarterly)`);
let done = 0, got = 0;
for (const c of list) {
  for (const [p, q] of [['cash-flow-statement', false], ['income-statement', true]]) {
    const f = join(HK_SA, `${key(c.code, p, q)}.json`);
    try {
      const html = await getCached(`https://stockanalysis.com/quote/${listing(c.code)}/financials/${p}/${q ? '?p=quarterly' : ''}`, f, { ttlMs: 7 * 864e5, retries: 4, timeout: 25000 });
      if (html && /Financials in millions [A-Z]{3}/.test(html)) got++;
    } catch { /* throttled: the next run picks it up */ }
    await sleep(GAP);
  }
  if (++done % 25 === 0) console.log(`  ${done}/${list.length} companies · ${got} pages`);
}
console.log(`done · ${got} pages fetched`);
