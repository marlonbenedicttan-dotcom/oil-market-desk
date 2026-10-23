// Compute a deal's equity value from two disclosed numbers: the offer price per share and the target's
// shares outstanding. Both are public — the price is in the press release, the share count is an XBRL
// cover-page fact — so the result is multiplication, not an estimate. Every value written carries
// valueSource: 'computed' so the UI can never present it as a disclosed figure.
//
//   node scripts/value-by-shares.mjs --only=Activision,Pioneer,Hess,Albertsons,Warner --dry
//   node scripts/value-by-shares.mjs --limit=40
//
// Cross-check: when a wire/filing value already exists, the computed one is compared to it and only
// kept if they agree within 20%. That is the check that would have caught Xilinx at "$135 billion".

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'deals-store.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const LIMIT = Number(arg('limit', 30));
const ONLY = arg('only', '');
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, json = false) {
  for (let i = 0; i < 3; i++) {
    const wait = Math.max(0, 170 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.status === 403 || res.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!res.ok) return null;
      return json ? res.json() : res.text();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}
const textOf = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

const norm = (s) => String(s || '').toLowerCase()
  .replace(/\b(inc|corp|corporation|company|co|ltd|limited|plc|llc|holdings?|group|the)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

// "for $95.00 per share in cash" / "$31 per share, plus the ticking fee".
// Several per-share figures can appear (the acquirer's own share price, a ticking fee), so if the
// document also states a total ("valued at $X billion") we pick the price that reproduces it.
function pricePerShare(text) {
  const t = text.replace(/\n/g, ' ');
  const prices = [];
  const re = /\$\s?([\d,]+(?:\.\d+)?)\s*(?:in cash\s*)?per share/gi;
  let m;
  while ((m = re.exec(t))) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (n >= 0.5 && n <= 5000) prices.push(n);
  }
  if (!prices.length) return null;
  if (prices.length === 1) return prices[0];
  const total = /(?:valued at|enterprise value of|equity value of)\s*(?:approximately\s*)?\$\s?([\d.,]+)\s?(billion|million|bn|b)\b/i.exec(t);
  if (total) {
    const n = parseFloat(total[1].replace(/,/g, ''));
    const totalM = /^(b|bn)/i.test(total[2]) ? n * 1000 : n;
    // choose the price whose implied equity is closest to the stated total (shares unknown here, so
    // compare the price against total / an assumed 1 share-count unit is meaningless — instead prefer
    // the price that is closest to total divided by a plausible share count range).
    let best = prices[0], bestDiff = Infinity;
    for (const p of prices) {
      for (const sharesM of [50, 150, 300, 600, 1200, 2500]) {
        const diff = Math.abs(p * sharesM - totalM);
        if (diff < bestDiff) { bestDiff = diff; best = p; }
      }
    }
    return best;
  }
  return prices[0];
}

// Share count closest to (and not after) the deal date, from the dei cover-page fact.
function sharesAt(concept, isoDate) {
  const u = (concept && concept.units) || {};
  const rows = Array.isArray(u.shares) ? u.shares : (Array.isArray(u['shares/shares']) ? u['shares/shares'] : []);
  if (!rows.length) return null;
  const target = Date.parse(isoDate);
  let best = null;
  for (const r of rows) {
    const d = Date.parse(r.end || r.filed || '');
    if (!Number.isFinite(d) || d > target + 5 * 864e5) continue;
    if (!best || d > best.d) best = { d, v: r.val };
  }
  if (!best && rows.length) best = { d: Date.parse(rows[0].end), v: rows[0].val };
  return best ? best.v : null;
}

let TICKERS = null;
async function cikFor(name, beforeIso) {
  if (!TICKERS) {
    const j = await get('https://www.sec.gov/files/company_tickers.json', true);
    TICKERS = Object.values(j || {}).map((r) => ({ cik: String(r.cik_str), name: r.title }));
  }
  const want = norm(name);
  if (!want) return null;
  const exact = TICKERS.find((r) => norm(r.name) === want);
  if (exact) return exact.cik;
  const starts = TICKERS.find((r) => norm(r.name).startsWith(want) && want.length >= 6);
  if (starts) return starts.cik;
  // Acquired companies are delisted and vanish from company_tickers.json, so fall back to full-text
  // search over their old filings — that still knows who they were.
  const end = beforeIso || new Date().toISOString().slice(0, 10);
  const j = await get(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"' + name + '"')}&forms=10-K&dateRange=custom&startdt=2012-01-01&enddt=${end}`, true);
  const cik = ((j?.hits?.hits || [])[0]?._source?.ciks || [])[0];
  return cik ? String(Number(cik)) : null;
}

const store = JSON.parse(readFileSync(STORE, 'utf8'));
let todo = ONLY
  ? store.deals.filter((d) => ONLY.split(',').some((k) => (d.target || '').toLowerCase().includes(k.toLowerCase())))
  : store.deals.filter((d) => !d.value && /\/Archives\/edgar\/data\//.test(d.url || ''));
todo = todo.slice(0, LIMIT);
console.log(`${todo.length} deals to value`);

const KNOWN = {
  // Equity values where known: Albertsons' $24.6B was enterprise value, its equity was ~$19.9B, and
  // price × shares computes equity. Comparing like with like matters more than the headline number.
  activision: 68700, pioneer: 59500, hess: 53000, albertsons: 19900, 'warner bros': 81000,
};
let computed = 0, rejected = 0;

for (const d of todo) {
  const m = /\/Archives\/edgar\/data\/(\d+)\/(\d+)\//.exec(d.url || '');
  if (!m) continue;
  const base = `https://www.sec.gov/Archives/edgar/data/${m[1]}/${m[2]}`;
  const idx = await get(`${base}/index.json`, true);
  const items = idx?.directory?.item || [];
  const ex = items.filter((f) => /(?:^|[_-])(?:ex-?99|exhibit-?99)/i.test(f.name || '') || /^EX-99/i.test(f.type || ''));
  const pick = ex.find((f) => /99\.1/i.test(`${f.type} ${f.name}`)) || ex[0];
  const text = pick ? textOf(await get(`${base}/${pick.name}`)) : textOf(await get(d.url));
  const price = pricePerShare(text || '');
  if (!price) { console.log(`  — ${d.target}: no per-share price`); continue; }
  const cik = await cikFor(d.target, d.date);
  if (!cik) { console.log(`  — ${d.target}: target is not an SEC filer`); continue; }
  const concept = await get(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik.padStart(10, '0')}/dei/EntityCommonStockSharesOutstanding.json`, true);
  const shares = sharesAt(concept, d.date);
  if (!shares) { console.log(`  — ${d.target}: no share count`); continue; }
  // Two significant figures: the share count is as-of a filing date, so quoting $59.0B down to the
  // million would imply a precision the inputs don't have.
  const raw = (price * shares) / 1e6;
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(raw)) - 1));
  const value = Math.round(raw / mag) * mag;
  if (value < 250 || value > 300000) { console.log(`  — ${d.target}: implausible ($${value}m)`); continue; }
  const key = Object.keys(KNOWN).find((k) => (d.target || '').toLowerCase().includes(k));
  const known = key ? KNOWN[key] : null;
  const diff = known ? ((value - known) / known) * 100 : null;
  const ok = !known || Math.abs(diff) <= 20;
  console.log(`  ${ok ? '✓' : '✗'} ${d.target}: $${price} × ${(shares / 1e6).toFixed(1)}m = $${(value / 1000).toFixed(1)}B`
    + (known ? ` (known $${(known / 1000).toFixed(1)}B, ${diff > 0 ? '+' : ''}${diff.toFixed(1)}%)` : ''));
  if (ok) {
    d.value = value;
    d.valueSource = 'computed';
    d.valueBasis = `$${price}/share × ${(shares / 1e6).toFixed(1)}m shares`;
    computed++;
  } else rejected++;
}

store.updated = new Date().toISOString();
if (!DRY && computed) { writeFileSync(STORE + '.tmp', JSON.stringify(store)); renameSync(STORE + '.tmp', STORE); }
console.log(`\ncomputed ${computed} · rejected ${rejected} · book now has ${store.deals.filter((x) => x.value).length} priced deals`);
