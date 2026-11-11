// Recover missing quarters from the filing's XBRL instance.
//
// A 10-Q can carry the current quarter as a YTD figure, or a quarter only via a dimensional/custom
// context. companyfacts misses both. This walks the last few 10-Q/10-K instances, extracts
// consolidated 3-month and YTD facts, differences YTD periods that share a start date, and fills the
// quarter table before TTM reconciliation.
//
//   node scripts/refresh-us-instance-income.mjs --limit=25
//   node scripts/refresh-us-instance-income.mjs --only=DUK,SO,NEE

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CACHE = join(ROOT, 'data', 'cache', 'instances');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) || '').split('=')[1];
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '').split('=')[1] || 0);
const onlySet = ONLY ? new Set(ONLY.split(',').map((x) => x.trim().toUpperCase())) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(readFileSync(FILE, 'utf8'));
mkdirSync(CACHE, { recursive: true });

const REV = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'RegulatedAndUnregulatedOperatingRevenue', 'OperatingRevenues', 'RevenuesNetOfInterestExpense'];
const NI = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic', 'NetIncomeLossAttributableToParent'];
const DAY = 864e5;
const dur = (f) => f.start && f.end ? (Date.parse(f.end) - Date.parse(f.start)) / DAY : 0;
const lastQ = (c) => (c.quarters || []).slice(-1)[0]?.end || null;
const fundamental = (c) => /^(10-[KQ])/.test(String(c.lastFiling?.form || ''));
const stale = (c) => c.lastFiling?.period && fundamental(c) && (!lastQ(c) || c.lastFiling.period > lastQ(c) || (c.netIncomeTTMAsOf && c.lastFiling.period > c.netIncomeTTMAsOf));

async function get(url, text = false) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 403) { await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) { await sleep(800 * (i + 1)); continue; }
      return text ? res.text() : res.json();
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}

function parse(xml) {
  const ctx = new Map();
  let m;
  const re = /<context\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/context>/g;
  while ((m = re.exec(xml))) {
    const b = m[2];
    const end = /<endDate>([^<]+)<\/endDate>/.exec(b)?.[1] || null;
    const start = /<startDate>([^<]+)<\/startDate>/.exec(b)?.[1] || null;
    ctx.set(m[1], { start, end, segment: /<segment\b/.test(b) });
  }
  const facts = [];
  for (const tags of [REV, NI]) {
    for (const tag of tags) {
      const reF = new RegExp(`<(?:us-gaap|ifrs-full):${tag}\\b[^>]*contextRef="([^"]+)"[^>]*>([^<]+)<`, 'g');
      let f;
      while ((f = reF.exec(xml))) {
        const val = Number(f[2].trim());
        if (!Number.isFinite(val)) continue;
        const c = ctx.get(f[1]);
        if (!c || c.segment || !c.end) continue;
        facts.push({ tag, val, start: c.start, end: c.end });
      }
    }
  }
  return facts;
}

function concept(facts, tags, end) {
  // Direct 3-month fact wins.
  for (const tag of tags) {
    const hit = facts.find((f) => f.tag === tag && f.end === end && dur(f) >= 75 && dur(f) <= 110);
    if (hit) return hit.val;
  }
  // Otherwise difference the current YTD from the previous YTD with the same start.
  for (const tag of tags) {
    const cur = facts.find((f) => f.tag === tag && f.end === end && dur(f) >= 150 && dur(f) <= 300);
    if (!cur) continue;
    const prev = facts
      .filter((f) => f.tag === tag && f.start === cur.start && f.end < cur.end && dur(f) >= 150 && dur(f) <= 300)
      .sort((a, b) => b.end.localeCompare(a.end))[0];
    if (prev) return cur.val - prev.val;
  }
  return null;
}

const candidates = data.companies.filter((c) => c.cik && c.lastFiling?.url && fundamental(c) && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase())) && (onlySet || stale(c)));
const todo = LIMIT ? candidates.slice(0, LIMIT) : candidates;
console.log(`${todo.length} candidates`);
let updated = 0;
for (const c of todo) {
  const subs = await get(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`);
  const recent = subs?.filings?.recent;
  if (!recent) continue;
  const filings = [];
  for (let i = 0; i < (recent.form || []).length && filings.length < 6; i++) {
    if (!/^10-[KQ]$/.test(recent.form[i])) continue;
    filings.push({ form: recent.form[i], date: recent.filingDate[i], acc: recent.accessionNumber[i], period: recent.reportDate[i] });
  }
  const facts = [];
  for (const f of filings) {
    const acc = f.acc.replace(/-/g, '');
    const idx = await get(`https://www.sec.gov/Archives/edgar/data/${c.cik}/${acc}/index.json`);
    const name = (idx?.directory?.item || []).map((x) => x.name).find((n) => /_htm\.xml$/i.test(n));
    if (!name) continue;
    const cache = join(CACHE, `${c.cik}-${acc}.xml`);
    let xml = null;
    if (existsSync(cache)) { try { xml = readFileSync(cache, 'utf8'); } catch { /* refetch */ } }
    if (!xml) { xml = await get(`https://www.sec.gov/Archives/edgar/data/${c.cik}/${acc}/${name}`, true); if (xml) writeFileSync(cache, xml); }
    if (xml) facts.push(...parse(xml));
    await sleep(160);
  }
  if (!facts.length) continue;
  const byEnd = new Map();
  for (const f of facts) {
    if (!byEnd.has(f.end)) byEnd.set(f.end, { end: f.end });
  }
  const qmap = new Map((c.quarters || []).map((q) => [q.end, q]));
  const lastEnd = lastQ(c);
  let added = 0, filled = 0;
  for (const end of [...byEnd.keys()].sort()) {
    if (lastEnd && end <= lastEnd) continue; // historical gaps belong to a separate backfill pass
    const revenue = concept(facts, REV, end);
    const netIncome = concept(facts, NI, end);
    if (revenue == null && netIncome == null) continue;
    const prev = qmap.get(end);
    if (!prev) {
      qmap.set(end, { end, revenue, netIncome, operatingIncome: null, opBasis: null, margin: null, netMargin: revenue && netIncome != null ? +((netIncome / revenue) * 100).toFixed(1) : null, derived: 'instance' });
      added++;
    } else {
      if (prev.revenue == null && revenue != null) { prev.revenue = revenue; filled++; }
      if (prev.netIncome == null && netIncome != null) { prev.netIncome = netIncome; filled++; }
      if (prev.revenue != null && prev.operatingIncome != null) {
        const m = +((prev.operatingIncome / prev.revenue) * 100).toFixed(1);
        if (prev.margin !== m) { prev.margin = m; filled++; }
      }
      if (prev.revenue != null && prev.netIncome != null) {
        const m = +((prev.netIncome / prev.revenue) * 100).toFixed(1);
        if (prev.netMargin !== m) { prev.netMargin = m; filled++; }
      }
    }
  }
  if (added || filled) {
    c.quarters = [...qmap.values()].sort((a, b) => a.end.localeCompare(b.end));
    updated++;
    console.log(`${c.ticker}: +${added} quarters, filled ${filled}`);
  }
  await sleep(160);
}
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`updated ${updated} companies`);
