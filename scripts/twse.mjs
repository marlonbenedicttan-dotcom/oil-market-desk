// TWSE / stockanalysis helpers for the Taiwan build.
//
// The exchange's own OpenAPI gives the universe, daily prices and the official P/E / P/B / yield for
// every listed stock, keyless. The English statements come from the same stockanalysis.com pages the
// Japan and Korea profile fetchers already use; they are server-rendered and cover every TPE code.
//
// No runtime dependency: plain fetch, a disk cache and two small parsers.

import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UA, sleep, readJson, writeJson, getCached, ENT, num, parseSaTable, rowOf, periodFromTitle } from './stockanalysis.mjs';

// The stockanalysis helpers are shared with the Hong Kong build; re-exported so the Taiwan scripts
// that already import them from here keep working.
export { UA, sleep, readJson, writeJson, getCached, ENT, num, parseSaTable, rowOf, periodFromTitle };

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CACHE = join(ROOT, 'data', 'cache');
export const SA_CACHE = join(CACHE, 'taiwan-sa');
export const TW_CACHE = join(CACHE, 'twse');
mkdirSync(SA_CACHE, { recursive: true });
mkdirSync(TW_CACHE, { recursive: true });

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
