// The headline trailing profit must be the four quarters shown beside it, and the market cap must be
// the count the market actually lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTtm, quartersContiguous } from '../src/lib.js';
import { deriveKorea, saneReports } from '../scripts/derive-korea.mjs';

const q = (ends, ni) => ends.map((end, i) => ({ end, netIncome: ni[i] }));

test('four consecutive quarters are contiguous; a hole or a stray end is not', () => {
  assert.equal(quartersContiguous(q(['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'], [1, 1, 1, 1])), true);
  assert.equal(quartersContiguous(q(['2025-03-31', '2025-06-30', '2026-03-31', '2026-06-30'], [1, 1, 1, 1])), false);
  assert.equal(quartersContiguous(q(['2025-01-31', '2025-05-01', '2025-08-01', '2025-11-01'], [1, 1, 1, 1])), true, '52/53-week calendars');
  assert.equal(quartersContiguous([]), true);
});

test('a newer quarter window replaces a stale fiscal-year headline', () => {
  const rows = [{
    ticker: 'GOOGL', netIncomeTTM: 132.17e9, netIncomeTTMAsOf: '2025-12-31', ttmFromFY: true, ttmRejected: 'outlier',
    quarters: q(['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'], [40e9, 45e9, 50e9, 60e9]),
  }];
  const stat = reconcileTtm(rows);
  assert.equal(stat.adopted, 1);
  assert.equal(rows[0].netIncomeTTM, 195e9);
  assert.equal(rows[0].netIncomeTTMAsOf, '2026-06-30');
  assert.equal(rows[0].ttmFromFY, false);
  assert.equal(rows[0].ttmRejected, null, 'a measured sum is not an outlier');
  assert.equal(rows[0].ttmFromQuarters, true);
});

test('an older quarter table does not pull a newer headline backwards', () => {
  const rows = [{
    ticker: 'COST', netIncomeTTM: 9.226e9, netIncomeTTMAsOf: '2026-08-30',
    quarters: q(['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'], [2e9, 2e9, 2e9, 2.1e9]),
  }];
  const stat = reconcileTtm(rows);
  assert.equal(stat.adopted, 0);
  assert.equal(rows[0].netIncomeTTM, 9.226e9);
  assert.equal(rows[0].ttmQuarterGap, true, 'flagged so the audit can see the table is behind');
});

test('the same window with a different tag is taken from the quarters', () => {
  const rows = [{
    ticker: 'MRK', netIncomeTTM: 18.254e9, netIncomeTTMAsOf: '2026-06-30',
    quarters: q(['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'], [5e9, 3e9, -4.24e9, -1.335e9]),
  }];
  reconcileTtm(rows);
  assert.equal(rows[0].netIncomeTTM, 2.425e9);
});

test('a quarter filed in the wrong unit is dropped, not published', () => {
  const rows = [
    { report: 'annual', end: '2025-12-31', revenue: 633e9, netIncome: -0.65e9 },
    { report: 'q1', end: '2026-03-31', revenue: 189e9, netIncome: 3.5e9 },
    { report: 'h1', end: '2026-06-30', revenue: 253e12, netIncome: 14.5e12 },   // 253 trillion: wrong unit
  ];
  const kept = saneReports(rows);
  assert.equal(kept.length, 2);
  assert.ok(!kept.some((r) => r.report === 'h1'));
});

test('a Korean P/E that rounds to zero is missing, not 0.00', () => {
  const B = 1e9;
  const reports = [
    { report: 'q1', end: '2025-03-31', revenue: 10 * B, netIncome: 1 * B },
    { report: 'h1', end: '2025-06-30', revenue: 20 * B, netIncome: 2 * B },
    { report: 'q3', end: '2025-09-30', revenue: 30 * B, netIncome: 3 * B },
    { report: 'annual', end: '2025-12-31', revenue: 40 * B, netIncome: 4 * B, equity: 50 * B },
  ];
  const [c] = deriveKorea({ companies: [{ ticker: '000000', name: 'Tiny cap', price: 1, shares: 1e6, reports }] });
  assert.equal(c.pe, null, 'a ₩1m cap against ₩4bn of profit is not a P/E of 0.00');
});
