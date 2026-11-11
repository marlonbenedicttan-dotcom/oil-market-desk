// Recover consolidated debt from a filing's XBRL instance when companyfacts omits dimensional facts.
//
// Ford is the example: its debt is tagged per segment (Automotive / Ford Credit), so the us-gaap
// companyfacts API has no consolidated DebtCurrent/LongTermDebt fact and the frames pass cannot see
// it. The instance XML has the segment facts and their contexts; this sums the latest period's
// contexts when no undimensioned total exists.
//
//   node scripts/refresh-us-instance-debt.mjs --only=F
//   node scripts/refresh-us-instance-debt.mjs --limit=25

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

const TAGS = ['DebtCurrent', 'LongTermDebtCurrent', 'LongTermDebtNoncurrent', 'LongTermDebt',
  'LongTermDebtAndCapitalLeaseObligations', 'DebtAndCapitalLeaseObligations', 'ShortTermBorrowings', 'CommercialPaper'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function get(url, asText = false) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: asText ? 'application/xml,text/xml,*/*' : 'application/json' } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 403) { await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) { await sleep(900 * (i + 1)); continue; }
      return asText ? res.text() : res.json();
    } catch { await sleep(900 * (i + 1)); }
  }
  return null;
}

function parseInstance(xml) {
  const context = new Map();
  let m;
  const re = /<context\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/context>/g;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const instant = /<instant>([^<]+)<\/instant>/.exec(body)?.[1] || null;
    const segment = /<segment\b/.test(body);
    const dimNames = [...body.matchAll(/<xbrldi:explicitMember\b[^>]*dimension="([^"]+)"/g)].map((x) => x[1]);
    const dims = dimNames.length;
    context.set(m[1], { instant, segment, dims, dimNames });
  }
  const facts = [];
  for (const tag of TAGS) {
    const reFact = new RegExp(`<(?:us-gaap|ifrs-full):${esc(tag)}\\b[^>]*contextRef="([^"]+)"[^>]*>([^<]+)<`, 'g');
    let f;
    while ((f = reFact.exec(xml))) {
      const raw = f[2].trim();
      if (!/^-?\d+(\.\d+)?$/.test(raw)) continue;
      const ctx = context.get(f[1]);
      if (!ctx?.instant) continue;
      facts.push({ tag, val: Number(raw), instant: ctx.instant, segment: ctx.segment, dims: ctx.dims, dimNames: ctx.dimNames, ctx: f[1] });
    }
  }
  if (!facts.length) return null;
  const latest = facts.map((f) => f.instant).sort().at(-1);
  const at = facts.filter((f) => f.instant === latest);
  // If the filer tagged a consolidated (undimensioned) fact, use it; otherwise the segment contexts
  // partition the company and their sum is the consolidated balance.
  const noSeg = at.filter((f) => !f.segment);
  // Prefer a consolidated fact. If there is none, use the least-dimensional segment contexts:
  // Ford has Automotive and Ford Credit at one segment dimension, plus debt-by-type breakdowns at
  // two dimensions. Summing the breakdowns as well double-counted Ford to $306B.
  const use = noSeg.length ? noSeg : (() => {
    // Prefer the business/geographic segment axis. Other one-dimensional contexts (VIE consolidation,
    // debt type) are subsets of a segment; including them double-counts Ford Credit.
    const primary = at.filter((f) => f.dims === 1 && /StatementBusinessSegmentsAxis|StatementGeographicalAxis/.test(f.dimNames[0] || ''));
    if (primary.length) return primary;
    const minDims = Math.min(...at.map((f) => f.dims));
    return at.filter((f) => f.dims === minDims);
  })();
  // One group per XBRL context. Grouping by a segment boolean collapsed Automotive and Ford Credit
  // into one row and undercounted Ford by ~$140B.
  const groups = new Map();
  for (const f of use) {
    const key = f.ctx;
    const g = groups.get(key) || {};
    // The highest-priority fact for a tag wins (latest filing value); values are already latest.
    if (g[f.tag] == null) g[f.tag] = f.val;
    groups.set(key, g);
  }
  let total = 0, parts = 0;
  for (const g of groups.values()) {
    let long = g.LongTermDebtAndCapitalLeaseObligations ?? g.DebtAndCapitalLeaseObligations ?? g.LongTermDebtNoncurrent;
    let cur = g.DebtCurrent ?? g.LongTermDebtCurrent ?? 0;
    let d = long != null ? long + cur : (g.LongTermDebt ?? (cur || null));
    if (d != null && d > 0) { total += d; parts++; }
  }
  return parts ? { total, end: latest, parts, segmentOnly: !noSeg.length } : null;
}

const candidates = data.companies.filter((c) => c.cik && c.lastFiling?.url && (!onlySet || onlySet.has(String(c.ticker || '').toUpperCase()))
  && (/^10-[KQ]/.test(c.lastFiling.form || ''))
  && (onlySet || (c.debt == null && (c.assets || 0) > 5e9) || (c.debtEnd && c.lastFiling.period > c.debtEnd)));
const todo = LIMIT ? candidates.slice(0, LIMIT) : candidates;
console.log(`${todo.length} candidates`);

let updated = 0;
for (const c of todo) {
  const url = c.lastFiling.url;
  const dir = url.replace(/\/[^/]+$/, '');
  const idx = await get(`${dir}/index.json`);
  const xmlName = (idx?.directory?.item || []).map((x) => x.name).find((n) => /_htm\.xml$/i.test(n));
  if (!xmlName) continue;
  const accn = (c.lastFiling.url.match(/\/(\d{18})\//) || [])[1] || 'x';
  const cache = join(CACHE, `${c.cik}-${accn}.xml`);
  let xml = null;
  if (existsSync(cache)) { try { xml = readFileSync(cache, 'utf8'); } catch { /* refetch */ } }
  if (!xml) {
    xml = await get(`${dir}/${xmlName}`, true);
    if (xml) writeFileSync(cache, xml);
  }
  if (!xml) continue;
  const parsed = parseInstance(xml);
  if (!parsed) continue;
  if (parsed.total > 0 && (!c.assets || parsed.total < c.assets * 2)) {
    c.debt = +parsed.total;
    c.debtEnd = parsed.end;
    c.debtSource = parsed.segmentOnly ? 'instance · segment sum' : 'instance · consolidated';
    delete c.debtNA;
    updated++;
    console.log(`${c.ticker}: ${(parsed.total / 1e9).toFixed(3)}B ${parsed.end} (${parsed.parts} parts${parsed.segmentOnly ? ', segment sum' : ''})`);
  }
  await sleep(180);
}
data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`updated ${updated} companies`);
