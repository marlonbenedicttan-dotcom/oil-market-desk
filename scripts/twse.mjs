// TWSE / stockanalysis helpers for the Taiwan build.
//
// The exchange's own OpenAPI gives the universe, daily prices and the official P/E / P/B / yield for
// every listed stock, keyless. The English statements come from the same stockanalysis.com pages the
// Japan and Korea profile fetchers already use; they are server-rendered and cover every TPE code.
//
// No runtime dependency: plain fetch, a disk cache and two small parsers.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CACHE = join(ROOT, 'data', 'cache');
export const SA_CACHE = join(CACHE, 'taiwan-sa');
export const TW_CACHE = join(CACHE, 'twse');
mkdirSync(SA_CACHE, { recursive: true });
mkdirSync(TW_CACHE, { recursive: true });

export const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
export const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));

// A disk-cached GET. `fresh` skips the cache; `ttlMs` keeps a recently fetched page. A 429 backs off
// and retries, because both stockanalysis and TWSE throttle bursts.
export async function getCached(url, file, { ttlMs = 0, fresh = false, timeout = 30000, retries = 3 } = {}) {
  if (!fresh && ttlMs > 0 && existsSync(file)) {
    try {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      if (hit && hit.fetched && Date.now() - Date.parse(hit.fetched) < ttlMs) return hit.text;
    } catch { /* refetch */ }
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429) { await sleep(4000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      const text = await res.text();
      writeFileSync(file, JSON.stringify({ fetched: new Date().toISOString(), text }));
      return text;
    } catch (e) {
      if (attempt === retries - 1) {
        // A transient DNS/feed failure must not discard a warm build: fall back to the last bytes.
        try {
          const hit = JSON.parse(readFileSync(file, 'utf8'));
          if (hit && hit.text) return hit.text;
        } catch { /* no cache */ }
        throw e;
      }
      await sleep(800 * (attempt + 1));
    }
  }
  return null;
}

// --- TWSE ---------------------------------------------------------------------------------------
export const TWSE = {
  master: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
  valuation: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  dayAll: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  dayCsv: (ymd) => `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date=${ymd}&response=json`,
};

// TWSE dates arrive as ROC: 1151030 is 2026-10-30 (ROC year + 1911).
export function rocToIso(v) {
  const s = String(v || '').trim();
  if (s.length !== 7) return null;
  const y = Number(s.slice(0, 3)) + 1911;
  return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
}

// The all-stock daily file is CSV even with response=json. The first line is the header; each row is
// quoted. We only need code and close.
export function parseDayCsv(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || !line.startsWith('"')) continue;
    const cells = line.split('","').map((x) => x.replace(/^"|"$/g, ''));
    const date = rocToIso(cells[0]);
    const code = cells[1];
    const close = Number(String(cells[8] || '').replace(/,/g, ''));
    if (date && /^\d{4}$/.test(code || '') && Number.isFinite(close) && close > 0) rows.push({ d: date, code, c: close });
  }
  return rows;
}

// --- stockanalysis financial tables -------------------------------------------------------------
const ENT = (s) => String(s || '')
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

// --- sectors ------------------------------------------------------------------------------------
// TWSE industry codes, 2007 classification (plus the newer 35-38 groups).
export const TW_SECTORS = {
  '01': 'Cement', '02': 'Food & Beverage', '03': 'Plastics', '04': 'Textiles',
  '05': 'Electric Machinery', '06': 'Electrical Cable', '08': 'Glass & Ceramics',
  '09': 'Paper & Packaging', '10': 'Steel & Metals', '11': 'Rubber',
  '12': 'Automobiles', '13': 'Electronics', '14': 'Construction',
  '15': 'Shipping & Transport', '16': 'Travel & Leisure', '17': 'Financials',
  '18': 'Trade & Retail', '19': 'Conglomerates', '20': 'Other',
  '21': 'Chemicals', '22': 'Biotech & Medical', '23': 'Oil, Gas & Power',
  '24': 'Semiconductors', '25': 'Computers & Peripherals', '26': 'Optoelectronics',
  '27': 'Communications', '28': 'Electronic Components', '29': 'Electronics Distribution',
  '30': 'Information Services', '31': 'Other Electronics', '32': 'Culture & Creative',
  '33': 'Agricultural Biotech', '35': 'Green Energy', '36': 'Digital & Cloud',
  '37': 'Sports & Leisure', '38': 'Household Goods',
};
export const sectorOf = (code) => TW_SECTORS[String(code || '').padStart(2, '0')] || 'Other';
