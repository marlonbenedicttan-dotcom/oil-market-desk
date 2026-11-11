// US data-quality ledger. Counts are evidence, not thresholds: every list is written to
// data/us-quality.json so the repair queue is inspectable.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'companies.json'), 'utf8'));
const isFin = (c) => c.sector === 'Financials' || /^(60|6199)/.test(String(c.sic || ''));
const lastQ = (c) => (c.quarters || []).slice(-1)[0]?.end || null;
const fundamental = (c) => /^(10-[KQ]|20-F|40-F)/.test(String(c.lastFiling?.form || ''));
const list = (rows) => rows.slice(0, 200).map((c) => ({
  ticker: c.ticker, name: c.name, form: c.lastFiling?.form || null,
  filing: c.lastFiling?.period || null, quarter: lastQ(c),
  ttm: c.netIncomeTTMAsOf || null, assets: c.assetsEnd || null, equity: c.equityEnd || null,
  debt: c.debt == null ? null : c.debt, debtNA: c.debtNA || null,
}));

const incompleteReason = (c) => {
  const q = c.quarters || [];
  if (!q.length) return 'no-quarter-history';
  // Pre-revenue biotechs and some REITs legitimately have no revenue line; a missing revenue cell
  // there is not an incomplete series.
  const annualRev = c.revenue ?? c.revenueTTM ?? null;
  if (annualRev == null || annualRev < 5e7) return 'pre-revenue-or-no-revenue';
  return 'missing-quarter';
};
const short = data.companies.filter((c) => {
  if (isFin(c)) return false;
  const q = c.quarters || [];
  if (q.length < 8) return false;
  return q.slice(-8).filter((x) => x.revenue != null).length < 8;
});
const shortReasons = {};
for (const c of short) shortReasons[incompleteReason(c)] = (shortReasons[incompleteReason(c)] || 0) + 1;
const stale = data.companies.filter((c) => c.lastFiling?.period && fundamental(c) && (
  (lastQ(c) && c.lastFiling.period > lastQ(c))
  || (c.netIncomeTTMAsOf && c.lastFiling.period > c.netIncomeTTMAsOf)
  || (c.assetsEnd && c.lastFiling.period > c.assetsEnd)
  || (c.equityEnd && c.lastFiling.period > c.equityEnd)
  || (c.debtEnd && c.lastFiling.period > c.debtEnd)
));
const noDebt = data.companies.filter((c) => c.debt == null);
const byStatus = {};
for (const c of data.companies) {
  const s = c.verification?.status || 'none';
  byStatus[s] = (byStatus[s] || 0) + 1;
}

const out = {
  generated: new Date().toISOString(),
  companies: data.companies.length,
  incompleteQuarters: short.length,
  incompleteByReason: shortReasons,
  incompleteList: list(short),
  stale: stale.length,
  staleByField: {
    quarter: stale.filter((c) => lastQ(c) && c.lastFiling.period > lastQ(c)).length,
    ttm: stale.filter((c) => c.netIncomeTTMAsOf && c.lastFiling.period > c.netIncomeTTMAsOf).length,
    assets: stale.filter((c) => c.assetsEnd && c.lastFiling.period > c.assetsEnd).length,
    equity: stale.filter((c) => c.equityEnd && c.lastFiling.period > c.equityEnd).length,
    debt: stale.filter((c) => c.debtEnd && c.lastFiling.period > c.debtEnd).length,
  },
  noDebt: { total: noDebt.length, financials: noDebt.filter(isFin).length, nonFinancials: noDebt.filter((c) => !isFin(c)).length },
  verification: byStatus,
  derivedQ4Companies: data.companies.filter((c) => c.quartersSource?.derivedQ4?.length).length,
  derivedQ4Rows: data.companies.reduce((a, c) => a + (c.quartersSource?.derivedQ4?.length || 0), 0),
  lists: { incompleteQuarters: list(short), stale: list(stale), noDebtNonFinancial: list(noDebt.filter((c) => !isFin(c))) },
};
writeFileSync(join(ROOT, 'data', 'us-quality.json'), JSON.stringify(out, null, 1));
console.log(`US quality · ${out.companies} companies · incomplete ${out.incompleteQuarters} · stale ${out.stale} · no debt ${out.noDebt.total} (${out.noDebt.financials} financial) · derived Q4 ${out.derivedQ4Companies}`);
console.log('verification:', Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · '));
