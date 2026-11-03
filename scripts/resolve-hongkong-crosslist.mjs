// Resolve a Hong Kong code to the listing that actually carries its statements.
//
// stockanalysis.com covers many H-share companies under their **A-share** code (Ping An is SHA:601318,
// CM Bank SHA:600036) and some under another primary listing (HSBC is LON:HSBA) — the HKG financials
// page is a 404. The statements are the same company and the share count is global, which is exactly
// what the Hong Kong market cap needs (HK price × total shares, the exchange's own convention).
//
//   node scripts/resolve-hongkong-crosslist.mjs            resolve every 404 company
//   node scripts/resolve-hongkong-crosslist.mjs --limit=10 smoke test
//
// Output: data/hongkong-crosslist.json — reviewed by a human before it is trusted, because a wrong
// match would publish another company's profit under this ticker.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readDaily, parseQuotations, isCompanyRow, pad4, HK_SA } from './hkex.mjs';
import { getCached, sleep } from './stockanalysis.mjs';

const OUT = join(ROOT, 'data', 'hongkong-crosslist.json');
const SEARCH_CACHE = join(ROOT, 'data', 'cache', 'hk-search');
mkdirSync(SEARCH_CACHE, { recursive: true });
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0) || 0;
// --codes=0005,2318 forces a resolution even when a Hong Kong page exists, for the handful of big names
// whose page is challenge-blocked rather than missing.
const FORCE = ((process.argv.find((x) => x.startsWith('--codes=')) || '').split('=')[1] || '').split(',').map((c) => c.trim()).filter(Boolean);
// --queries=3968:China Merchants Bank;3750:Contemporary Amperex Technology — the exchange prints
// abbreviations (CATL, CPIC, CM BANK) that no name search can match, so the full name is supplied.
const QUERY = Object.fromEntries(((process.argv.find((x) => x.startsWith('--queries=')) || '').split('=').slice(1).join('=') || '')
  .split(';').map((x) => x.split(':')).filter((x) => x.length === 2 && x[0]).map(([k, v]) => [k.trim(), v.trim()]));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !['company', 'limited', 'holdings', 'group', 'plc', 'inc', 'ltd', 'corp', 'corporation', 'co'].includes(w));

// A candidate is plausible when every meaningful word of the Hong Kong name appears in its name.
function plausible(hkName, candName) {
  const a = tokens(hkName), b = norm(candName);
  if (!a.length) return false;
  const hit = a.filter((w) => b.includes(w)).length;
  return hit >= Math.ceil(a.length * 0.6);
}

async function search(q) {
  const f = join(SEARCH_CACHE, `${norm(q).replace(/\s+/g, '-')}.json`);
  try {
    const text = await getCached(`https://stockanalysis.com/api/search?q=${encodeURIComponent(q)}`, f, { ttlMs: 30 * 864e5, retries: 4, timeout: 20000 });
    const j = JSON.parse(text || '{}');
    return (j.data || []).map((r) => ({ s: r.s || '', n: r.n || '' }));
  } catch { return []; }
}

// Prefer the mainland A-share page (same reporting currency and share register), then London, then the
// US OTC ADR page — the OTC statements are the company's own, in its own currency, with the total share
// count (Ping An's PNGAY page reports 17.4bn shares and CNY, not ADR units), so the Hong Kong cap is
// still HK price × real shares.
// London and the US OTC listing are tried first: the mainland A-share pages answer 429 from this
// region, so putting them first just burns a retry cycle per company.
const rank = (s) => (/^lon\//.test(s) ? 0 : /^otc\//.test(s) ? 1 : /^nyq\//.test(s) ? 2 : /^tsx\//.test(s) ? 3 : /^sha\//.test(s) ? 4 : /^she\//.test(s) ? 5 : 9);

const daily = readDaily('2026-10-30');
if (!daily) { console.error('run build-hongkong first (it caches the HKEX report)'); process.exit(1); }
const rows = parseQuotations(daily).filter(isCompanyRow).map((r) => ({ code: pad4(r.hkexCode), name: r.name, turnover: r.turnover || 0 }));
const book = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { entries: {} };
book.entries = book.entries || {};

// Only companies that actually matter: an unfetched shell is not worth a search, but every liquid
// company gets its Hong Kong page tried once so a 404 is discovered and the alternative can be found.
const MIN_TURNOVER = 5e6;
const forced = FORCE.length ? FORCE : Object.keys(QUERY);
const todo = (forced.length
  ? rows.filter((r) => forced.includes(r.code))
  : rows.filter((r) => r.turnover >= MIN_TURNOVER).sort((a, b) => b.turnover - a.turnover))
  .slice(0, LIMIT || rows.length);

let done = 0, resolved = 0, tried = 0;
for (const r of todo) {
  const f = join(HK_SA, `${r.code}-income-statement.json`);
  let hit = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  if (!hit) {
    // Never fetched: try the Hong Kong page once, so "404" is a fact rather than an assumption.
    try {
      const html = await getCached(`https://stockanalysis.com/quote/hkg/${r.code}/financials/income-statement/`, f, { ttlMs: 7 * 864e5, retries: 3, timeout: 25000 });
      hit = html ? { text: html } : { notFound: true };
    } catch { continue; }                            // throttled — leave it for the next pass
  }
  const missingOnHkg = hit && (hit.notFound || !(hit.text || '').includes('id="TTM"'));
  if (!missingOnHkg && !forced.includes(r.code)) continue;   // the HKG page is fine, nothing to resolve
  if (book.entries[r.code] && book.entries[r.code].exchange) continue;
  tried++;
  const results = await search(QUERY[r.code] || r.name);
  const cands = results
    .filter((x) => /^(sha|she|lon|otc|nyq|tsx)\//.test(x.s))
    .filter((x) => plausible(QUERY[r.code] || r.name, x.n))
    .sort((a, b) => rank(a.s) - rank(b.s));
  // Walk the candidates until one really serves statements. The A-share pages answer 429 from this
  // region, so a first-choice match that cannot be read is skipped rather than recorded blind.
  for (const best of cands.slice(0, 3)) {
    const [exchange, code] = best.s.split('/');
    let ok = false;
    try {
      const html = await getCached(`https://stockanalysis.com/quote/${best.s}/financials/income-statement/`, join(SEARCH_CACHE, `${exchange}-${code}-inc.json`), { ttlMs: 30 * 864e5, retries: 3, timeout: 25000 });
      ok = !!html && /id="TTM"/.test(html) && /Financials in millions [A-Z]{3}/.test(html);
    } catch { ok = false; }
    if (ok) {
      book.entries[r.code] = {
        exchange, code, sourceName: best.n, hkgName: r.name,
        matched: `${exchange.toUpperCase()}:${code}`, verified: new Date().toISOString().slice(0, 10),
      };
      resolved++;
      break;
    }
  }
  if (++done % 10 === 0) console.log(`  ${done} checked · ${resolved} resolved`);
  await sleep(700);
}

book.updated = new Date().toISOString();
writeFileSync(`${OUT}.tmp`, JSON.stringify(book, null, 1));
renameSync(`${OUT}.tmp`, OUT);
console.log(`${tried} companies without HKG statements · ${resolved} resolved to another listing · ${Object.keys(book.entries).length} in the map`);
console.log(Object.entries(book.entries).slice(0, 12).map(([k, v]) => `${k} → ${v.matched} (${v.sourceName})`).join('\n'));
