// Shared stockanalysis.com helpers: a disk-cached GET and the statement-table parser.
//
// Japan, Korea and Taiwan all read their English statements from the same server-rendered pages, so the
// parser, the number cleaner and the cache live here instead of being copied per market. The Taiwan
// module used to own them; it now re-exports these so nothing that already imports it breaks.
//
// No runtime dependency: plain fetch, a disk cache and two small parsers.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
export const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));

// A disk-cached GET. `fresh` skips the cache; `ttlMs` keeps a recently fetched page.
//
// Throttling is global, not per request. When stockanalysis answers 429/403, EVERY worker parks on the
// same clock: retrying from eight workers at once is what keeps the challenge alive, and it turns a
// slow build into a build that quietly records good pages as missing. A 404 is different — that page
// really does not exist — and it is cached as a miss so a rebuild does not ask again.
let parkUntil = 0;
let strikes = 0;                 // consecutive push-backs, reset by any successful response
export const throttleParked = () => Math.max(0, parkUntil - Date.now());

export async function getCached(url, file, { ttlMs = 0, fresh = false, timeout = 30000, retries = 6 } = {}) {
  if (!fresh && existsSync(file)) {
    try {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      if (hit && hit.notFound) return null;
      if (ttlMs > 0 && hit && hit.fetched && Date.now() - Date.parse(hit.fetched) < ttlMs) return hit.text;
    } catch { /* refetch */ }
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    const wait = parkUntil - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 30000));
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 404) {
        writeFileSync(file, JSON.stringify({ fetched: new Date().toISOString(), notFound: true, text: '' }));
        return null;
      }
      // 403 here is Cloudflare's challenge, not a missing page: it clears after a cooldown.
      if (res.status === 429 || res.status === 403) {
        // One or two push-backs: short waits, because the bucket refills fast and a long sleep throws
        // away the requests that would have succeeded in between. Three in a row means we are being
        // blocked, and hammering is exactly what keeps the block alive — so go quiet for 90 seconds.
        strikes++;
        const wait = strikes >= 3 ? 90000 : 2500 * strikes;
        parkUntil = Math.max(parkUntil, Date.now() + wait);
        continue;
      }
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      const text = await res.text();
      strikes = 0;
      writeFileSync(file, JSON.stringify({ fetched: new Date().toISOString(), text }));
      return text;
    } catch (e) {
      if (attempt === retries - 1) {
        // A transient DNS/feed failure must not discard a warm build: fall back to the last bytes.
        try {
          const hit = JSON.parse(readFileSync(file, 'utf8'));
          if (hit && hit.text) return hit.text;
          if (hit && hit.notFound) return null;
        } catch { /* no cache */ }
        throw e;
      }
      await sleep(800 * (attempt + 1));
    }
  }
  // Still parked after the last attempt: this is throttling, not a missing page. Throw a typed error
  // the caller can tell apart, and do NOT cache a miss — the next run must ask again rather than trust
  // a page we never actually read.
  const err = new Error(`throttled: ${url}`);
  err.throttled = true;
  throw err;
}

// --- stockanalysis financial tables -------------------------------------------------------------
export const ENT = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

export function num(v) {
  let s = String(v == null ? '' : v).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (!s || s === '—' || s === '-' || s === 'N/A') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,%\s]/g, '');
  if (!s || !/^-?\d/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

// One financial page → { cols: [{ id, label }], rows: [{ label, values: { colId: number } }] }.
// The header ids are the period ends ("2025-12-31") or "TTM"; quarterly pages use the same ids.
export function parseSaTable(html) {
  const h = String(html || '');
  const cols = [];
  const thead = (/<thead[\s\S]*?<\/thead>/.exec(h) || [])[0] || '';
  for (const m of thead.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)) {
    const attrs = m[1];
    const id = (/id="([^"]+)"/.exec(attrs) || [])[1];
    const title = (/title="([^"]*)"/.exec(attrs) || [])[1] || '';
    const label = ENT(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (id && id !== 'header-title' && !cols.some((c) => c.id === id)) cols.push({ id, label, title });
  }
  const rows = [];
  for (const tr of h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (tds.length < 2) continue;
    const label = ENT(tds[0].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const values = {};
    // The first <td> is the label; the rest line up with the header columns. Growth rows have one
    // fewer cell in some layouts, so stop at the header count rather than shifting.
    for (let i = 0; i < cols.length; i++) values[cols[i].id] = num(tds[i + 1]);
    rows.push({ label, values });
  }
  return { cols, rows };
}

export const rowOf = (table, labels) => {
  const want = Array.isArray(labels) ? labels : [labels];
  for (const label of want) {
    const hit = table.rows.find((r) => r.label === label);
    if (hit) return hit;
  }
  return null;
};

// "Trailing twelve month period ending Sep 30, 2026" / "Sep 30, 2026" → "2026-09-30".
export function periodFromTitle(title) {
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(String(title || ''));
  if (!m) return null;
  const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return `${m[3]}-${MON[m[1]] || '01'}-${String(m[2]).padStart(2, '0')}`;
}

// "Financials in millions CNY." → CNY. The statement currency decides which currency the ratios are
// computed in: a Hong Kong listing that reports in CNY must not have its HKD market cap divided by a
// CNY profit.
export function statementCurrency(html, fallback = null) {
  const m = /Financials in millions ([A-Z]{3})/.exec(String(html || '')) || /\bMillions ([A-Z]{3})\b/.exec(String(html || ''));
  return m ? m[1] : fallback;
}
