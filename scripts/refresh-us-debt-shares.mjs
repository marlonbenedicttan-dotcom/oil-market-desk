// Refresh US total debt, cash and current shares from SEC XBRL frames.
//
// The old weekly frames pass read one calendar frame for a single debt tag, so a company whose debt
// lives in a component (or whose latest filing is a 10-Q) could keep an old figure forever — Ford was
// showing $291M against a balance sheet of $292B. This reads the last two years of quarter-end frames,
// picks each company's latest instant at or before its latest filing, and combines the debt components.
//
//   node scripts/refresh-us-debt-shares.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;
const data = JSON.parse(readFileSync(FILE, 'utf8'));

async function get(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 403) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) { await sleep(1000 * (i + 1)); continue; }
      return res.json();
    } catch { await sleep(1000 * (i + 1)); }
  }
  return null;
}

const thisYear = new Date().getUTCFullYear();
const frames = [];
for (const y of [thisYear - 1, thisYear]) for (const q of [1, 2, 3, 4]) frames.push(`CY${y}Q${q}I`);

const TAG = {
  ltd: 'LongTermDebt',
  ltdn: 'LongTermDebtNoncurrent',
  dc: 'DebtCurrent',
  st: 'ShortTermBorrowings',
  cp: 'CommercialPaper',
  cash: 'CashAndCashEquivalentsAtCarryingValue',
};
const maps = Object.fromEntries(Object.keys(TAG).map((k) => [k, new Map()]));
for (const [key, tag] of Object.entries(TAG)) {
  for (const frame of frames) {
    const j = await get(`https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/${frame}.json`);
    for (const r of j?.data || []) {
      if (r.cik == null || r.val == null || !r.end) continue;
      const old = maps[key].get(String(r.cik));
      if (!old || r.end > old.end) maps[key].set(String(r.cik), { val: r.val, end: r.end });
    }
    await sleep(250);
  }
  console.log(`${tag}: ${maps[key].size}`);
}

if (!maps.ltd.size && !maps.ltdn.size && !maps.dc.size) {
  console.error('SEC debt frames unavailable — refusing to rewrite debt');
  process.exit(1);
}

const shares = new Map();
for (const frame of frames) {
  const j = await get(`https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/${frame}.json`);
  for (const r of j?.data || []) {
    if (r.cik == null || !(r.val > 0) || !r.end) continue;
    const old = shares.get(String(r.cik));
    if (!old || r.end > old.end) shares.set(String(r.cik), { val: r.val, end: r.end });
  }
  await sleep(100);
}
console.log(`shares: ${shares.size}`);

let debtChanged = 0, cashChanged = 0, sharesChanged = 0, cleared = 0;
for (const c of data.companies || []) {
  const key = String(c.cik);
  const last = c.lastFiling?.period ? Date.parse(c.lastFiling.period) : null;
  const within = (row, days = 200) => row && (!last || Math.abs(Date.parse(row.end) - last) <= days * DAY);
  const pick = (m) => { const r = m.get(key); return within(r) ? r : null; };
  const ltd = pick(maps.ltd), ltdn = pick(maps.ltdn), dc = pick(maps.dc), st = pick(maps.st), cp = pick(maps.cp);
  let debt = null, debtEnd = null;
  if (ltdn && dc) { debt = ltdn.val + dc.val; debtEnd = [ltdn.end, dc.end].sort().at(-1); }
  else if (ltd && (!debtEnd || ltd.end >= debtEnd)) { debt = ltd.val; debtEnd = ltd.end; }
  else if (ltdn) { debt = ltdn.val + (st?.val || 0) + (cp?.val || 0); debtEnd = ltdn.end; }
  else if (dc) { debt = dc.val; debtEnd = dc.end; }
  else if (st || cp) { debt = (st?.val || 0) + (cp?.val || 0); debtEnd = (st || cp).end; }

  if (debt != null && debt >= 0 && (!c.debtEnd || debtEnd >= c.debtEnd)) {
    if (c.debt !== debt) debtChanged++;
    c.debt = debt; c.debtEnd = debtEnd;
    delete c.debtNA;
  } else if (debt == null && c.debt != null && last && (!c.debtEnd || Date.parse(c.debtEnd) < last)
      && c.assets > 0 && c.debt < c.assets * 0.01 && c.marketCap > c.debt * 10) {
    // The current filing has no total-debt tag and the stored figure is a tiny component (Ford:
    // $291M against $292B assets). Blanking it is honest; printing it makes EV and D/E nonsense.
    c.debt = null; c.debtEnd = c.lastFiling.period;
    c.debtNA = 'no current total-debt tag in the latest filing';
    cleared++;
  }

  const cash = pick(maps.cash);
  if (cash && (!c.cashEnd || cash.end >= c.cashEnd)) {
    if (c.cash !== cash.val) cashChanged++;
    c.cash = cash.val; c.cashEnd = cash.end;
  }

  const sh = shares.get(key);
  if (sh && (!last || Math.abs(Date.parse(sh.end) - last) <= 200 * DAY)) {
    if (c.sharesCurrent !== sh.val) sharesChanged++;
    c.sharesCurrent = sh.val;
    c.sharesEnd = sh.end;
  }
}

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log(`debt ${debtChanged} · cash ${cashChanged} · shares ${sharesChanged} · debt cleared ${cleared}`);
