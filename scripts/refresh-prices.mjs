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
//   node scripts/refresh-prices.mjs --session=2026-11-05   (backfill one close)
//   node scripts/refresh-prices.mjs --no-wait      (single pass, no historical fallback)

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const NO_WAIT = process.argv.includes('--no-wait');
const SESSION = (process.argv.find((x) => x.startsWith('--session=')) || '').split('=')[1] || null;
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

const expected = SESSION || expectedSession();
if (!/^\d{4}-\d{2}-\d{2}$/.test(expected)) throw new Error(`bad --session value: ${expected}`);

// Only a quote that belongs to the close we are publishing is usable. A premarket quote (tomorrow) or
// a prior session is skipped; the historical endpoint below knows the expected close.
async function refresh(list) {
  let ok = 0, fail = 0, skipped = 0, i = 0;
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
        let quoteDate = null;
        if (pd.lastTradeTimestamp) {
          // "Oct 29, 2026" parses as local midnight; in a UTC+8 timezone that becomes the 28th in UTC.
          const t = Date.parse(`${pd.lastTradeTimestamp} UTC`);
          if (Number.isFinite(t)) quoteDate = new Date(t).toISOString().slice(0, 10);
        }
        // A premarket quote is tomorrow's session, not the close we are publishing. A quote from an
        // earlier session is stale. Either way, leave it for the historical close lookup.
        if (quoteDate !== expected) { skipped++; await sleep(120); continue; }
        c.price = +px.toFixed(4);
        c.priceAt = new Date().toISOString();
        // The quote carries its own daily change and the session it belongs to. Deriving either from a
        // cached chart is what made "today" two days old.
        const pct = num(String(pd.percentageChange || '').replace('%', ''));
        if (pct != null) c.chg1d = +pct.toFixed(2);
        c.priceAsOf = expected;
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
  return { ok, fail, skipped };
}

// Nasdaq's historical table is the fallback for the many tickers whose quote endpoint still serves the
// prior session (or a premarket print) when the job runs. It publishes the expected close, so the
// snapshot is never a day old even if the live quote is.
const usDate = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
async function historical(c) {
  const sym = String(c.ticker).replace('-', '.');
  const from = new Date(Date.parse(`${expected}T00:00:00Z`) - 10 * 864e5).toISOString().slice(0, 10);
  try {
    const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=stocks&fromdate=${from}&todate=${expected}&limit=20`, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) return false;
    const j = await res.json();
    const rows = (j?.data?.tradesTable?.rows || [])
      .map((r) => ({ date: usDate(r.date), close: num(r.close) }))
      .filter((r) => r.date && r.close != null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const at = rows.find((r) => r.date === expected);
    if (!at) return false;
    const prev = rows.filter((r) => r.date < expected).at(-1);
    c.price = +at.close.toFixed(4);
    c.priceAsOf = expected;
    c.priceAt = new Date().toISOString();
    if (prev && prev.close > 0) c.chg1d = +(((at.close / prev.close) - 1) * 100).toFixed(2);
    if (c.marketCapSource !== 'nasdaq' && c.shares) {
      c.marketCap = Math.round(c.price * c.shares);
      c.sharesDerived = true;
    }
    return true;
  } catch { return false; }
}
async function fillHistory(list) {
  let ok = 0, fail = 0, i = 0;
  async function worker() {
    while (i < list.length) {
      const c = list[i++];
      if (await historical(c)) ok++; else fail++;
      await sleep(140);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { ok, fail };
}

const first = await refresh(todo);
console.log(`prices refreshed: ${first.ok} · skipped ${first.skipped} · failed ${first.fail}`);

// The quote endpoint often serves the prior session for most tickers for hours after the close (only a
// few roll over immediately). Fill those from the historical table instead of waiting ten minutes and
// hoping; the historical row is the authoritative close for the session we are publishing.
const stale = todo.filter((c) => (c.priceAsOf || '') < expected);
console.log(`session: expected ${expected} · ${todo.length - stale.length} on it · ${stale.length} need the historical close`);
if (!NO_WAIT && stale.length) {
  const h = await fillHistory(stale);
  console.log(`historical close: ${h.ok} filled · ${h.fail} failed`);
}
const still = todo.filter((c) => (c.priceAsOf || '') < expected).length;
if (still) console.log(`warning: ${still} quotes are still behind ${expected} (no historical close published)`);

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
