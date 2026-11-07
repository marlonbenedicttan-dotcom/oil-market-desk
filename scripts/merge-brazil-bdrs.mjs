// Merge the curated BDR lens into the domestic Brazil build.
//
//   node scripts/merge-brazil-bdrs.mjs
//
// The domestic build remains the source for the 303 domestic companies and all domestic aggregates.
// BDRs are appended as a separate lens: global company caps, underlying statements and BDR prices.
// They are excluded from totalCap, sector medians, breadth and the domestic trading-quality counts.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './b3.mjs';
import { readJson, writeJson } from './stockanalysis.mjs';
import { brazilList } from '../src/project.js';

const BR = join(ROOT, 'data', 'brazil.json');
const BDR = join(ROOT, 'data', 'brazil-bdr-data.json');
const LIST = join(ROOT, 'data', 'brazil-list.json');
const THEMES = join(ROOT, 'data', 'brazil-themes.json');
const DETAIL = join(ROOT, 'data', 'brazil-companies');
const PROFILES = join(ROOT, 'data', 'brazil-profiles.json');
const SERIES = join(ROOT, 'data', 'brazil-series');
const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

const br = readJson(BR);
const bdrDoc = readJson(BDR);
if (!br || !Array.isArray(br.companies) || !br.companies.length) throw new Error('the domestic Brazil build is missing — run build-brazil.mjs first');
if (!bdrDoc || !Array.isArray(bdrDoc.companies) || !bdrDoc.companies.length) throw new Error('the BDR build is missing — run build-brazil-bdrs.mjs first');

const domestic = br.companies.filter((c) => !c.bdr);
const bdr = bdrDoc.companies.filter((c) => c.bdr);
const all = [...domestic, ...bdr];
// Remove the BDRs that were in the previous lens but are not in the curated LatAm set now.
const prevBdr = br.companies.filter((c) => c.bdr);
const newBdrCodes = new Set(bdr.map((c) => c.code));
const staleBdr = prevBdr.filter((c) => !newBdrCodes.has(c.code));

const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
};
const bdrCap = bdr.reduce((a, c) => a + (c.marketCap || 0), 0);
const bdrGroups = bdr.reduce((a, c) => { a[c.bdrGroup || 'global'] = (a[c.bdrGroup || 'global'] || 0) + 1; return a; }, {});
const bdrReportCurrencies = [...new Set(bdr.map((c) => c.reportCurrency).filter(Boolean))].sort();
const bdrSummary = {
  bdrs: bdr.length,
  bdrCap,
  bdrGroups,
  bdrReportCurrencies,
  bdrPe: median(bdr.map((c) => c.pe)),
  bdrPb: median(bdr.map((c) => c.pb)),
  bdrRoe: median(bdr.map((c) => c.roe)),
  bdrYield: median(bdr.map((c) => c.dividendYield)),
  bdrNoRecentTrading: bdr.filter((c) => c.noRecentTrading).length,
  bdrShortHistory: bdr.filter((c) => c.shortHistory).length,
  bdrTtmStale: bdr.filter((c) => c.ttmStale).length,
  bdrThinTrading: bdr.filter((c) => c.thinTrading).length,
  bdrFinancial: bdr.filter((c) => c.financial).length,
  bdrBankLike: bdr.filter((c) => c.bankLike).length,
};

const market = {
  ...br.market,
  companies: domestic.length,       // domestic only
  listed: all.length,               // domestic + BDRs
  ...bdrSummary,
};
const audit = {
  ...br.audit,
  companies: all.length,
  domesticCompanies: domestic.length,
  bdrCompanies: bdr.length,
  includedBdrs: bdr.length,
  excludedBdrs: Math.max(0, (br.audit.excludedBdr || 0) - bdr.length),
  bdrCap,
  bdrGroups,
  bdrReportCurrencies,
  bdrPe: bdrSummary.bdrPe,
  bdrPb: bdrSummary.bdrPb,
  bdrRoe: bdrSummary.bdrRoe,
  bdrYield: bdrSummary.bdrYield,
  bdrNoRecentTrading: bdrSummary.bdrNoRecentTrading,
  bdrShortHistory: bdrSummary.bdrShortHistory,
  bdrTtmStale: bdrSummary.bdrTtmStale,
  bdrThinTrading: bdrSummary.bdrThinTrading,
  bdrCodes: bdr.map((c) => c.code),
  bdrDropped: (bdrDoc.audit && bdrDoc.audit.droppedCodes) || [],
};

const themesDoc = readJson(THEMES) || { themes: [] };
const known = new Set(all.map((c) => c.code));
const themes = (themesDoc.themes || []).map((t) => ({
  ...t,
  tickers: (t.tickers || []).filter((code) => known.has(code)),
})).filter((t) => t.tickers.length);

const session = all.map((c) => c.priceDate).filter(Boolean).sort().pop() || br.session || null;
const doc = {
  ...br,
  updated: new Date().toISOString(),
  universe: `B3 · ${domestic.length} domestic + ${bdr.length} BDRs`,
  session,
  market,
  audit,
  themes,
  companies: all,
};
writeJson(`${BR}.tmp`, doc);
// writeJson writes the exact object; rename via fs for atomicity
import { renameSync } from 'node:fs';
renameSync(`${BR}.tmp`, BR);

const list = brazilList(doc);
writeFileSync(`${LIST}.tmp`, JSON.stringify(list));
renameSync(`${LIST}.tmp`, LIST);

mkdirSync(DETAIL, { recursive: true });
for (const c of bdr) writeFileSync(join(DETAIL, `${c.code}.json`), JSON.stringify(c));
for (const c of staleBdr) { try { rmSync(join(DETAIL, `${c.code}.json`), { force: true }); } catch { /* already gone */ } }
if (staleBdr.length) {
  const staleCodes = new Set(staleBdr.map((c) => c.code));
  const book = readJson(PROFILES) || { entries: {} };
  if (book.entries) {
    for (const code of staleCodes) delete book.entries[code];
    book.updated = new Date().toISOString();
    writeFileSync(`${PROFILES}.tmp`, JSON.stringify(book));
    renameSync(`${PROFILES}.tmp`, PROFILES);
  }
  const buckets = new Set([...staleCodes].map((code) => String(code).slice(0, 1).toUpperCase()));
  for (const b of buckets) {
    const f = join(SERIES, `${b}.json`);
    if (!existsSync(f)) continue;
    const obj = JSON.parse(readFileSync(f, 'utf8'));
    for (const code of staleCodes) { if (obj.daily) delete obj.daily[code]; if (obj.weekly) delete obj.weekly[code]; }
    writeJson(`${f}.tmp`, { updated: new Date().toISOString(), ...obj });
    renameSync(`${f}.tmp`, f);
  }
}
console.log(`${staleBdr.length} old BDRs removed from the lens${staleBdr.length ? `: ${staleBdr.map((c) => c.code).join(', ')}` : ''}`);

// Merge the BDR price series into the existing buckets. Domestic daily is the last 400 sessions;
// weekly keeps the five-year chart. Match the domestic shape exactly.
if (bdrDoc.series && Object.keys(bdrDoc.series).length) {
  const buckets = new Map();
  for (const [code, s] of Object.entries(bdrDoc.series)) {
    const b = String(code).slice(0, 1).toUpperCase();
    if (!/^[A-Z0-9]$/.test(b) || !Array.isArray(s) || s.length < 2) continue;
    let obj = buckets.get(b);
    if (!obj) {
      const f = join(SERIES, `${b}.json`);
      obj = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { daily: {}, weekly: {} };
      buckets.set(b, obj);
    }
    obj.daily = obj.daily || {};
    obj.weekly = obj.weekly || {};
    obj.daily[code] = s.slice(-400);
    const w = [];
    for (let i = s.length - 1; i >= 0; i -= 5) w.push(s[i]);
    obj.weekly[code] = w.reverse();
  }
  const stamp = new Date().toISOString();
  for (const [b, obj] of buckets) {
    const f = join(SERIES, `${b}.json`);
    writeJson(`${f}.tmp`, { updated: stamp, ...obj });
    renameSync(`${f}.tmp`, f);
  }
}

// Charts and brands read the merged list/data.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'br'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'attach-market-brands.mjs'), 'br'], { stdio: 'inherit' }); }
catch (e) { console.log(`  brands: ${e.message}`); }

console.log(`${domestic.length} domestic + ${bdr.length} BDRs (${bdrGroups.brazil || 0} Brazil/LatAm) · global caps, not summed into the domestic total`);
console.log(`market ${market.companies} domestic · ${market.listed} listed · domestic cap R$${(market.totalCap / 1e12).toFixed(2)}T · BDR caps R$${(bdrCap / 1e12).toFixed(1)}T (global)`);
