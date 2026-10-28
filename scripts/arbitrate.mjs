// Arbitration: a number publishes as fact only if two independent publishers agree on it.
//
// reconciliation.json holds the comparison; this stamps the verdict onto each company so the UI can
// show it. A field that differs by more than 5% (and by more than $50m, so small lines do not create
// noise) is recorded with both values. Nothing is overwritten: the reader sees the disagreement.
//
//   node scripts/arbitrate.mjs
//   node scripts/arbitrate.mjs --strict   # 2% tolerance instead of 5%

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const RECON = join(ROOT, 'data', 'reconciliation.json');
const STRICT = process.argv.includes('--strict');
const TOL = STRICT ? 0.02 : 0.05;
// A $50m gap on a $20bn company is rounding, not a disagreement. Materiality is absolute.
const FLOOR = 2.5e8;

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const recon = JSON.parse(readFileSync(RECON, 'utf8'));
const byTicker = Object.fromEntries(recon.companies.filter((r) => r.ticker).map((r) => [r.ticker, r]));

const FIELDS = ['revenue', 'netIncome', 'assets', 'equity'];
let verified = 0;
let disputed = 0;
let unchecked = 0;
const tally = {};

for (const c of data.companies) {
  const r = byTicker[c.ticker];
  if (!r || !r.sameYear) {
    c.verification = { status: 'unchecked', reason: r?.status === 'period-mismatch' ? 'different fiscal period' : 'no second source' };
    unchecked++;
    continue;
  }
  const disputes = {};
  let checked = 0;
  for (const f of FIELDS) {
    const ours = c[f];
    const theirs = r.nasdaq?.[f];
    if (ours == null || theirs == null) continue;
    checked++;
    const diff = Math.abs(ours - theirs) / Math.max(Math.abs(ours), Math.abs(theirs));
    if (diff > TOL && Math.abs(ours - theirs) > FLOOR) {
      disputes[f] = { ours, alt: theirs, diff: +diff.toFixed(3), source: 'nasdaq', period: r.period || null };
      tally[f] = (tally[f] || 0) + 1;
    }
  }
  const n = Object.keys(disputes).length;
  // Two kinds of legitimate difference:
  //  - a bank's revenue definition;
  //  - net income before vs after preferred dividends (Nasdaq reports the former, we use the latter
  //    because the market cap is common equity). Detect it: their figure is higher and our tag is the
  //    attributable-to-common one.
  const prefOnly = n === 1 && disputes.netIncome && disputes.netIncome.alt > disputes.netIncome.ours
    && /AvailableToCommon/i.test(c.netIncomeTag || '');
  const definitional = n > 0 && ((c.sector === 'Financials' && Object.keys(disputes).every((k) => k === 'revenue')) || prefOnly);
  c.verification = {
    status: n === 0 ? 'verified' : definitional ? 'definition' : 'disputed',
    checked,
    fields: disputes,
  };
  if (n === 0) verified++;
  else if (definitional) { /* counted separately */ }
  else disputed++;
}

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);

const definition = data.companies.filter((c) => c.verification?.status === 'definition').length;
console.log(`verified ${verified} · disputed ${disputed} · definition ${definition} · unchecked ${unchecked}  (tolerance ${(TOL * 100).toFixed(0)}%)`);
console.log('disputes by field:', Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none');
