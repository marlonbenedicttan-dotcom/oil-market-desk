// Second-source reconciliation: our SEC-derived numbers against Nasdaq's own financial tables.
//
// The audit checks arithmetic (market cap ÷ net income) using the net income we already stored, so a
// wrong input passes it. This compares the *inputs* against an independent publisher. Where the two
// disagree by more than a few percent, one of them is wrong — or the two use different definitions,
// which is a decision to make and label rather than a bug to chase.
//
// Nasdaq's tables are in thousands of dollars. Values are cached per ticker so a rerun is cheap.
//
//   node scripts/reconcile-nasdaq.mjs
//   node scripts/reconcile-nasdaq.mjs --limit=50

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const OUT = join(ROOT, 'data', 'reconciliation.json');
const CACHE = join(ROOT, 'data', 'cache', 'nasdaq-financials');
const LIMIT = Number((process.argv.find((x) => x.startsWith('--limit=')) || '--limit=0').split('=')[1]) || Infinity;
mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function financials(ticker) {
  const file = join(CACHE, `${ticker}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* refetch */ }
  }
  const sym = String(ticker).replace('-', '.');
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/financials?frequency=1`, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      if (!j?.data) return null;
      writeFileSync(file, JSON.stringify(j));
      return j;
    } catch { await sleep(900 * (i + 1)); }
  }
  return null;
}

const num = (s) => {
  if (s == null) return null;
  const raw = String(s).replace(/[$,()\s]/g, '');
  if (!raw) return null;              // an empty cell is not zero
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Nasdaq prints parentheses for negatives in some tables.
  return String(s).includes('(') ? -n : n;
};

const row = (table, re) => (table?.rows || []).find((r) => re.test(String(r.value1 || '')));
const thousands = (v) => (v == null ? null : v * 1000);

function readTable(j) {
  const inc = j?.data?.incomeStatementTable;
  const bal = j?.data?.balanceSheetTable;
  const period = inc?.headers?.value2 || null;
  const rev = thousands(num(row(inc, /^total revenue/i)?.value2));
  // Ours is parent-attributable net income and parent stockholders' equity, so compare against the
  // same lines. Nasdaq's "Net Income" and "Total Equity" include noncontrolling interests.
  const ni = thousands(num(row(inc, /net income applicable to common/i)?.value2))
    ?? thousands(num(row(inc, /^net income$/i)?.value2));
  const assets = thousands(num(row(bal, /^total assets/i)?.value2));
  const equity = thousands(num(row(bal, /^stock holders equity$/i)?.value2))
    ?? thousands(num(row(bal, /^total equity$/i)?.value2));
  return { period, rev, ni, assets, equity };
}

// A bank's "total revenue" means net interest income plus fees at one publisher and gross interest
// income at another. When revenue is the only line that differs at a financial, it is a definition,
// not an error.
const onlyRevenue = (fields, abs) => Object.entries(fields)
  .filter(([k, v]) => v != null && v > 0.10 && (abs[k] || 0) > 5e8)
  .every(([k]) => k === 'revenue');

const rel = (a, b) => {
  if (a == null || b == null || a === 0 || b === 0) return null;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const todo = data.companies.filter((c) => c.ticker).slice(0, LIMIT);
console.log(`reconciling ${todo.length} companies against Nasdaq`);

const out = [];
let done = 0;
for (const c of todo) {
  const j = await financials(c.ticker);
  done++;
  if (done % 50 === 0) console.log(`  … ${done}`);
  if (!j) { out.push({ ticker: c.ticker, status: 'no-nasdaq-data' }); continue; }

  const n = readTable(j);
  // Only compare like with like: a period a year apart is not a disagreement.
  // Compare by period end date when we have it: a June fiscal year makes the year number ambiguous.
  const ourEnd = c.netIncomeEnd ? Date.parse(c.netIncomeEnd) : null;
  const theirEnd = n.period ? Date.parse(n.period) : null;
  const sameYear = ourEnd && theirEnd
    ? Math.abs(ourEnd - theirEnd) < 120 * 86400000
    : true;

  const fields = {
    revenue: rel(c.revenue, n.rev),
    netIncome: rel(c.netIncome, n.ni),
    assets: rel(c.assets, n.assets),
    equity: rel(c.equity, n.equity),
  };
  const worst = Math.max(...Object.values(fields).filter((v) => v != null), 0);
  // Percentage noise on a small balance-sheet line is not a data error. Materiality is absolute.
  const abs = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    abs[k] = Math.abs((c[k === 'netIncome' ? 'netIncome' : k] || 0) - (n[k] || 0));
  }
  const worstAbs = Math.max(0, ...Object.values(abs));

  out.push({
    ticker: c.ticker,
    sector: c.sector,
    period: n.period,
    sameYear,
    our: { revenue: c.revenue, netIncome: c.netIncome, assets: c.assets, equity: c.equity, marketCap: c.marketCap, price: c.price, shares: c.shares },
    nasdaq: { revenue: n.rev, netIncome: n.ni, assets: n.assets, equity: n.equity },
    diff: fields,
    abs,
    worst: sameYear ? worst : null,
    status: !sameYear ? 'period-mismatch'
      : worst > 0.10 && worstAbs > 5e8
        ? (c.sector === 'Financials' && onlyRevenue(fields, abs) ? 'definition' : 'diverge')
        : worst > 0.10 ? 'diverge-immaterial'
          : worst > 0.02 ? 'close' : 'match',
  });
  await sleep(180);
}

const usable = out.filter((r) => r.worst != null);
const bucket = (s) => out.filter((r) => r.status === s).length;
const STATES = ['match', 'close', 'diverge', 'diverge-immaterial', 'definition', 'period-mismatch', 'no-nasdaq-data'];
const diverging = usable.filter((r) => r.status === 'diverge').sort((a, b) => b.worst - a.worst);

// Group by cause: a bank's "total revenue" excludes items SEC's Revenues includes, so those are a
// definition question. Everything else is either a share-class artefact or unexplained.
const cause = (r) => {
  if (r.sector === 'Financials') return 'bank/insurer revenue definition';
  // Dual-class companies: price x shares cannot reproduce the cap, so a per-share comparison drifts.
  const { marketCap, price, shares } = r.our;
  if (marketCap && price && shares && Math.abs(price * shares - marketCap) / marketCap > 0.10) return 'share class';
  return 'unexplained';
};
const causes = {};
for (const r of diverging) {
  const k = cause(r);
  causes[k] = causes[k] || [];
  causes[k].push(r.ticker);
}

console.log(`\nmatched ${bucket('match')} · close ${bucket('close')} · diverge ${bucket('diverge')} · definition ${bucket('definition')} · immaterial ${bucket('diverge-immaterial')} · period-mismatch ${bucket('period-mismatch')} · no-data ${bucket('no-nasdaq-data')}`);
console.log(`of ${usable.length} comparable companies, ${((bucket('match') + bucket('close')) / usable.length * 100).toFixed(1)}% agree within 10%`);

console.log('\nby cause:');
for (const [k, v] of Object.entries(causes)) console.log(`  ${k.padEnd(34)} ${v.length}  ${v.slice(0, 8).join(' ')}`);

console.log('\nlargest divergences (relative difference):');
for (const r of diverging.slice(0, 15)) {
  const f = Object.entries(r.diff).filter(([, v]) => v != null && v > 0.10)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(' · ');
  console.log(`  ${r.ticker.padEnd(6)} ${f}`);
}

writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), summary: { usable: usable.length, ...Object.fromEntries(STATES.map((s) => [s, bucket(s)])) }, companies: out }, null, 1));
console.log(`\nwrote ${OUT}`);
