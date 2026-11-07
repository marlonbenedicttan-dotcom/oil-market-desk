// Review the curated Indonesia prune: has any removed company become publishable again?
//
//   node scripts/review-indonesia-prune.mjs
//
// Read-only. Re-reads the cached statement pages for the 95 pruned codes and re-tests the reason each
// was removed. A company is a candidate only when the original data-quality reason no longer holds
// (positive equity, a usable P/E, a TTM that has appeared or is current, a resolved share count). A
// size/liquidity reason (nano-cap, shell, frozen) is reported but not auto-reinstated: that is a policy
// decision, not a data change.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCached, parseSaTable, rowOf, periodFromTitle } from './stockanalysis.mjs';
import { saPage, ID_SA } from './idx.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const prune = read('indonesia-prune.json');
const market = read('indonesia.json');
const shares = read('indonesia-shares.json').entries || {};
const session = Date.parse(market.session || market.updated);
const DAY = 864e5;
const t = (v) => (v == null ? '—' : (v / 1e12).toFixed(2) + 'T');

const num = (v) => (v == null ? null : v * 1e6);
const getTable = async (code, page) => {
  const f = join(ID_SA, `${code}-${page}.json`);
  const html = await getCached(saPage(code, page), f, { ttlMs: 7 * DAY, retries: 3, timeout: 30000 });
  return html ? parseSaTable(html) : null;
};
const ttmOf = (tab, labels) => {
  if (!tab) return { v: null, end: null, hasTTM: false };
  const col = tab.cols.find((c) => c.id === 'TTM');
  if (!col) return { v: null, end: null, hasTTM: false };
  const row = rowOf(tab, labels);
  return { v: row ? num(row.values[col.id]) : null, end: periodFromTitle(col.title), hasTTM: true };
};
const latestOf = (tab, labels) => {
  if (!tab) return null;
  const col = tab.cols.find((c) => c.id === 'TTM') || tab.cols[0];
  const row = rowOf(tab, labels);
  return row && col ? num(row.values[col.id]) : null;
};
const priceOf = (code) => {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'data', 'cache', 'idx', 'yahoo', `${code}.JK.json`), 'utf8'));
    const s = JSON.parse(j.text);
    return s.length ? s[s.length - 1].c : null;
  } catch { return null; }
};
const flatOf = (code) => {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'data', 'cache', 'idx', 'yahoo', `${code}.JK.json`), 'utf8'));
    const s = JSON.parse(j.text).slice(-250);
    if (s.length < 2) return null;
    let same = 0;
    for (let i = 1; i < s.length; i++) if (s[i].c === s[i - 1].c) same++;
    return Math.round((same / (s.length - 1)) * 100);
  } catch { return null; }
};

const candidates = [];
const sizeOnly = [];
let checked = 0;
for (const [code, meta] of Object.entries(prune.entries || {})) {
  checked++;
  const reason = String(meta.reason || '');
  const price = priceOf(code);
  const s = shares[code] || {};
  const sharesForCap = s.shares > 0 ? s.shares : null;
  const cap = price && sharesForCap ? price * sharesForCap : null;
  const [inc, bal] = await Promise.all([getTable(code, 'income-statement'), getTable(code, 'balance-sheet')]);
  const ni = ttmOf(inc, ['Net Income to Common', 'Net Income']);
  const rev = ttmOf(inc, ['Revenue', 'Total Revenue', 'Operating Revenue']);
  const equity = latestOf(bal, ['Total Common Equity', 'Total Stockholders Equity', 'Stockholders Equity', 'Common Equity', 'Total Equity', "Shareholders' Equity"]);
  const age = ni.end ? Math.round((session - Date.parse(ni.end)) / DAY) : null;
  const pe = cap && ni.v > 0 ? cap / ni.v : null;
  const gap = cap && s.marketCap > 0 ? Math.abs(cap / s.marketCap - 1) * 100 : null;
  const flat = flatOf(code);

  let why = null;
  if (/negative equity/i.test(reason) && equity > 0) why = `equity now ${t(equity)}`;
  else if (/P\/E withheld/i.test(reason) && pe != null && pe >= 0.5 && pe <= 500) why = `P/E now ${pe.toFixed(2)}×`;
  else if (/no TTM/i.test(reason) && ni.hasTTM && ni.v != null) why = `TTM now ${ni.end}`;
  else if (/TTM 402/i.test(reason) && age != null && age <= 365) why = `TTM is now ${age} days old`;
  else if (/share-count gap/i.test(reason) && gap != null && gap < 10) why = `share gap now ${gap.toFixed(1)}%`;
  else if (/nano-cap|shell-like|frozen/i.test(reason)) {
    sizeOnly.push(`${code} ${t(cap)} · ${reason}${flat != null ? ` · flat ${flat}%` : ''}`);
    continue;
  }
  if (why) candidates.push(`${code} ${t(cap)} · ${reason} · ${why}`);
}
console.log(`checked ${checked} pruned codes`);
console.log(candidates.length ? '\nCANDIDATES FOR REINSTATEMENT:' : '\nno data-quality candidate for reinstatement');
for (const c of candidates) console.log('  ' + c);
console.log(`\n${sizeOnly.length} size/liquidity removals are a policy decision, not a data change:`);
for (const c of sizeOnly.slice(0, 15)) console.log('  ' + c);
if (sizeOnly.length > 15) console.log(`  … ${sizeOnly.length - 15} more`);
