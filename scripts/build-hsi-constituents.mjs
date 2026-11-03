// Pin the Hang Seng Index constituent list.
//
// The market overview is anchored on the index, not on "every company we happen to hold": the HKEX
// main board has 2,060 lines and we cover 1,604, so a market cap or median P/E computed over our set
// would quietly be a different number from the one a reader sees on any terminal. The constituents are
// therefore committed as a dated snapshot (the same pattern as data/macro.json), sourced from the
// public index table, and the overview aggregates over the members we hold.
//
//   node scripts/build-hsi-constituents.mjs
//
// Output: data/hongkong-hsi.json

import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './hkex.mjs';

const OUT = join(ROOT, 'data', 'hongkong-hsi.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const res = await fetch('https://en.wikipedia.org/wiki/Hang_Seng_Index', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
if (!res.ok) { console.error(`wikipedia -> HTTP ${res.status}`); process.exit(1); }
const html = await res.text();
const text = html.replace(/<[^>]+>/g, ' ').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ');

const codes = [...new Set([...text.matchAll(/SEHK ?: ?(\d{1,5})/g)]
  .map((m) => Number(m[1]))
  .filter((n) => n >= 1 && n <= 9999)
  // The page also mentions ETFs and leveraged products in the same "SEHK : code" form; they are not
  // index constituents, and they fall in the same product ranges the universe excludes.
  .filter((n) => !(n >= 2800 && n <= 3199) && !(n >= 7200 && n <= 7599)))]
  .sort((a, b) => a - b)
  .map((n) => String(n).padStart(4, '0'));

if (codes.length < 60) { console.error(`only ${codes.length} codes parsed — refusing to write a short index`); process.exit(1); }

writeFileSync(`${OUT}.tmp`, JSON.stringify({
  updated: new Date().toISOString().slice(0, 10),
  source: 'Hang Seng Index constituents (public index table)',
  count: codes.length,
  codes,
}, null, 1));
renameSync(`${OUT}.tmp`, OUT);
console.log(`wrote ${codes.length} constituents to data/hongkong-hsi.json`);
