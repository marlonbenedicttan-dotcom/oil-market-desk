// Refresh the last sale price for every company, from the exchange's own quote endpoint.
//
// The dataset stores a price snapshot, and every ratio is computed from the market cap. A price that is
// a week old makes P/E a week old, so the daily refresh starts here.
//
// The quote endpoint lags: a run a few hours after the 16:00 ET close can still return the *previous*
// session. That shipped a full day of stale 1D moves once, so the refresh now checks the session it got
// and goes back for the rest if it is a day behind.
//
//   node scripts/refresh-prices.mjs
//   node scripts/refresh-prices.mjs --only=AAPL,MSFT
//   node scripts/refresh-prices.mjs --no-wait      (single pass, no session retry)

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const NO_WAIT = process.argv.includes('--no-wait');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.ticker && (!onlySet || onlySet.has(c.ticker.toUpperCase())));
console.log(`${todo.length} tickers`);

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// The most recent session the quote endpoint should be able to serve: a weekday whose 21:00 UTC
// settlement has passed. Holidays are not modelled — a holiday costs one wasted retry, which is cheap.
function expectedSession(now = Date.now()) {
  const t = new Date(now - 3600e3);
  let d = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  if (t.getUTCHours() < 21) d -= 86400e3; // today's close is not settled yet
  for (let i = 0; i < 7; i++) {
    const day = new Date(d).getUTCDay();
    if (day !== 0 && day !== 6) break;
    d -= 86400e3;
  }
  return new Date(d).toISOString().slice(0, 10);
}

async function refresh(list) {
  let ok = 0, fail = 0, i = 0;
  async function worker() {
    while (i < list.length) {
      const c = list[i++];
      const sym = String(c.ticker).replace('-', '.');
      try {
        const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`, {
          headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        if (!res.ok) { fail++; await sleep(250); continue; }
        const j = await res.json();
        const pd = j?.data?.primaryData || {};
        const px = num(pd.lastSalePrice);
        if (!px) { fail++; await sleep(250); continue; }
        c.price = +px.toFixed(4);
        c.priceAt = new Date().toISOString();
        // The quote carries its own daily change and the session it belongs to. Deriving either from a
        // cached chart is what made "today" two days old.
        const pct = num(String(pd.percentageChange || '').replace('%', ''));
        if (pct != null) c.chg1d = +pct.toFixed(2);
        if (pd.lastTradeTimestamp) {
          // "Oct 29, 2026" parses as local midnight; in a UTC+8 timezone that becomes the 28th in UTC.
          const t = Date.parse(`${pd.lastTradeTimestamp} UTC`);
          if (Number.isFinite(t)) c.priceAsOf = new Date(t).toISOString().slice(0, 10);
        }
        // A Nasdaq-sourced cap stays authoritative; anything else is price × shares.
        if (c.marketCapSource !== 'nasdaq' && c.shares) {
          c.marketCap = Math.round(c.price * c.shares);
          c.sharesDerived = true;
        }
        ok++;
      } catch { fail++; }
      await sleep(120);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { ok, fail };
}

const first = await refresh(todo);
console.log(`prices refreshed: ${first.ok} · failed ${first.fail}`);

// If the endpoint is still serving the prior session, wait for it to roll over rather than shipping a
// day-old "1D" as if it were today's move.
const expected = expectedSession();
const newest = todo.reduce((m, c) => (c.priceAsOf && c.priceAsOf > m ? c.priceAsOf : m), '');
console.log(`session: expected ${expected} · newest quote ${newest || 'none'}`);

if (!NO_WAIT && newest && newest < expected) {
  const GAP = 10 * 60e3;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const stale = todo.filter((c) => (c.priceAsOf || '') < expected);
    if (!stale.length) break;
    console.log(`  ${stale.length} quotes are behind ${expected} — retry ${attempt}/6 in 10 min`);
    await sleep(GAP);
    const r = await refresh(stale);
    const now = stale.reduce((m, c) => (c.priceAsOf && c.priceAsOf > m ? c.priceAsOf : m), '');
    console.log(`  retry ${attempt}: ${r.ok} refreshed · newest ${now || 'none'}`);
    if (now >= expected) break;
  }
  const still = todo.filter((c) => (c.priceAsOf || '') < expected).length;
  if (still) console.log(`warning: ${still} quotes are still behind ${expected} (holiday, or the endpoint is late)`);
}

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
