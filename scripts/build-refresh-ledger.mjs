// Build a per-company freshness ledger and a repair queue.
//
//   node scripts/build-refresh-ledger.mjs
//
// The market refresh already updates published data. This ledger answers the harder question: for
// every covered company, did the source have a newer statement period than the one we published?
//   fresh    published period is current
//   repair   source has a newer period -> queued for the next targeted rebuild
//   stale    no source comparison is available, and the published period is >450 days old
//   inactive no recent quote, so "stale" would be misleading (suspended / delisted / no price)
//   unknown  no statement period at all
//
// It uses only local caches; it never changes market data and never calls a vendor.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, latestPeriod, dartPeriodEnd, ageDays } from '../src/refresh-ledger.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const TODAY = new Date().toISOString().slice(0, 10);
const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const MARKETS = [
  { id: 'us', label: 'US', file: 'companies.json' },
  { id: 'japan', label: 'Japan', dir: 'japan-companies', source: 'jquants' },
  { id: 'korea', label: 'Korea', dir: 'korea-companies', source: 'dart' },
  { id: 'taiwan', label: 'Taiwan', dir: 'taiwan-companies' },
  { id: 'hongkong', label: 'Hong Kong', dir: 'hongkong-companies' },
  { id: 'australia', label: 'Australia', dir: 'australia-companies' },
  { id: 'india', label: 'India', dir: 'india-companies' },
  { id: 'indonesia', label: 'Indonesia', dir: 'indonesia-companies' },
  { id: 'brazil', label: 'Brazil', dir: 'brazil-companies' },
  { id: 'southafrica', label: 'South Africa', dir: 'southafrica-companies' },
];

const japanSource = (c) => {
  const f = join(DATA, 'cache', 'jquants', `fins-${c.code}.json`);
  const rows = read(f)?.rows;
  if (!Array.isArray(rows)) return null;
  const actual = rows.filter((r) => {
    if (!['1Q', '2Q', '3Q', 'FY'].includes(r.CurPerType)) return false;
    const d = String(r.CurPerEn || '').slice(0, 10);
    if (!d || d > TODAY) return false;
    return [r.Sales, r.NCSales, r.NP, r.NCNP].some((v) => num(v) != null);
  });
  return actual.map((r) => String(r.CurPerEn).slice(0, 10)).sort().at(-1) || null;
};

const koreaSource = (c) => {
  const dir = join(DATA, 'cache', 'dart');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(`fin-${c.code}-`) && f.endsWith('.json'));
  let latest = null;
  for (const f of files) {
    const parts = f.replace(/^fin-/, '').replace(/\.json$/, '').split('-');
    const period = dartPeriodEnd(parts[1], parts[2]);
    if (!period || period > TODAY) continue;
    const j = read(join(dir, f));
    // A quarterly filing can contain only a balance sheet (some small filers do). Do not mark it as
    // a newer statement unless it actually carries an income-statement row.
    const usable = (j?.rows || []).some((r) => r.sj_div === 'IS'
      && num(r.thstrm_amount) != null
      && /매출|영업이익|당기순/.test(r.account_nm || ''));
    if (usable && (!latest || period > latest)) latest = period;
  }
  return latest;
};

const rowsFor = (m) => {
  if (m.file) {
    const root = read(join(DATA, m.file));
    const companies = root?.companies || [];
    // US company rows do not carry a priceDate; the file-level updated stamp is the refresh date.
    const updated = String(root?.updated || '').slice(0, 10) || null;
    return companies.map((c) => ({ id: c.ticker || c.code || c.name, c, mtime: null, updated }));
  }
  const dir = join(DATA, m.dir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const file = join(dir, f);
    const c = read(file);
    if (!c) return null;
    let mtime = null;
    try { mtime = statSync(file).mtime.toISOString(); } catch { /* ignore */ }
    return { id: c.ticker || c.code || f.replace(/\.json$/, ''), c, mtime };
  }).filter(Boolean);
};

const ledger = { updated: new Date().toISOString(), today: TODAY, markets: {}, totals: {}, companies: [] };
const queue = { updated: ledger.updated, entries: [] };
for (const m of MARKETS) {
  const stat = { companies: 0, fresh: 0, repair: 0, stale: 0, inactive: 0, unknown: 0, sourceAware: Boolean(m.source) };
  const entries = [];
  for (const row of rowsFor(m)) {
    const c = row.c;
    const published = latestPeriod(c);
    const sourceLatest = m.source === 'jquants' ? japanSource(c)
      : m.source === 'dart' ? koreaSource(c) : null;
    const priceDate = c.priceDate || row.updated || null;
    const cls = classify({ published, sourceLatest, priceDate, today: TODAY });
    entries.push({
      market: m.id,
      id: row.id,
      name: c.name || null,
      status: cls.status,
      published,
      sourceLatest,
      publishedAgeDays: cls.publishedAge,
      priceAgeDays: cls.priceAge,
      priceDate,
      lastAttempt: row.mtime,
      source: m.source || null,
    });
  }
  // Detail directories contain both the exchange code and the ticker alias (Japan 7157/71570).
  // Keep the best record for each ticker so the ledger counts companies, not files.
  const best = new Map();
  for (const e of entries) {
    const prev = best.get(e.id);
    if (!prev || String(e.sourceLatest || e.published || '') > String(prev.sourceLatest || prev.published || '')) best.set(e.id, e);
  }
  for (const entry of best.values()) {
    stat.companies++;
    stat[entry.status]++;
    ledger.companies.push(entry);
    if (entry.status === 'repair') queue.entries.push(entry);
  }
  ledger.markets[m.id] = stat;
  console.log(`${m.label.padEnd(12)} companies ${String(stat.companies).padStart(5)} · fresh ${String(stat.fresh).padStart(5)} · repair ${String(stat.repair).padStart(4)} · stale ${String(stat.stale).padStart(3)} · inactive ${String(stat.inactive).padStart(3)} · unknown ${String(stat.unknown).padStart(3)}`);
}
ledger.totals = Object.values(ledger.markets).reduce((a, s) => {
  for (const k of ['companies', 'fresh', 'repair', 'stale', 'inactive', 'unknown']) a[k] = (a[k] || 0) + s[k];
  return a;
}, {});
writeFileSync(join(DATA, 'refresh-ledger.json'), JSON.stringify(ledger));
writeFileSync(join(DATA, 'refresh-queue.json'), JSON.stringify(queue));
console.log(`\nledger: ${ledger.totals.companies} companies · ${ledger.totals.repair} repair · ${ledger.totals.stale} stale · ${ledger.totals.inactive} inactive · ${ledger.totals.unknown} unknown`);
console.log(`queue: data/refresh-queue.json (${queue.entries.length})`);
