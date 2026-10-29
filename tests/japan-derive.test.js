// Japan derivation, tested against a fixture so the maths is verified before any API key exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveJapan, num } from '../scripts/derive-japan.mjs';

const series = (last, n = 140) => {
  const out = [];
  const start = Date.parse('2026-01-05T00:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push({ d: new Date(start + i * 864e5).toISOString().slice(0, 10), c: 1000 + i });
  }
  return out;
};

const fins = new Map([
  ['72030', [
    { CurPerType: 'FY', CurPerEn: '2025-03-31', Sales: '45000000000000', OP: '5400000000000',
      NP: '4900000000000', EPS: '370.5', BPS: '1800', TA: '90000000000000', Eq: '24000000000000',
      CFO: '3900000000000', CFI: '-3500000000000', DiscDate: '2025-05-10' },
    { CurPerType: 'FY', CurPerEn: '2026-03-31', Sales: '48000000000000', OP: '6000000000000',
      NP: '5200000000000', EPS: '393.1', BPS: '1950', TA: '95000000000000', Eq: '26000000000000',
      CFO: '4200000000000', CFI: '-3600000000000', DiscDate: '2026-05-12',
      FNP: '5600000000000', FEPS: '423.3', FSales: '50000000000000', FOP: '6500000000000', CurFYEn: '2027-03-31' },
  ]],
  ['99990', [
    { CurPerType: 'FY', CurPerEn: '2026-03-31', Sales: '100000000000', OP: '-2000000000',
      NP: '-3000000000', EPS: '-12.5', BPS: '400', TA: '200000000000', Eq: '80000000000',
      CFO: '-1000000000', CFI: '-2000000000', DiscDate: '2026-05-12' },
  ]],
]);

const ranked = [
  { code: '72030', ticker: '7203', name: 'Toyota Motor Corporation', sector: 'Transportation Equipment', cap: 40e12 },
  { code: '99990', ticker: '9999', name: 'Loss Maker Inc.', sector: 'Machinery', cap: 5e10 },
];

const map = new Map();
for (const r of ranked) map.set(r.code, series(r.code));
// The last close is the last point of the series.
const out = deriveJapan({ ranked, fins, series: map, nextByCode: new Map([['72030', { date: '2026-11-05', quarter: '第２四半期', basis: 'scheduled' }]]), fx: 150 });
const t = out.find((c) => c.code === '72030');
const l = out.find((c) => c.code === '99990');

test('uses the newest fiscal year, not the first with data', () => {
  assert.equal(t.period, '2026-03-31');
  assert.equal(t.sales, 48e12);
  assert.equal(t.np, 5.2e12);
});

test('valuation ratios derive from market cap', () => {
  assert.equal(t.pe, +(40e12 / 5.2e12).toFixed(2));
  assert.equal(t.pb, +(40e12 / 26e12).toFixed(2));
  assert.equal(t.roe, +((5.2e12 / 26e12) * 100).toFixed(1));
  assert.equal(t.opMargin, +((6e12 / 48e12) * 100).toFixed(1));
});

test('free cash flow is operating plus investing cash flow', () => {
  assert.equal(t.fcf, 4.2e12 - 3.6e12);
  assert.equal(t.fcfYield, +(((4.2e12 - 3.6e12) / 40e12) * 100).toFixed(2));
});

test('forward P/E comes from the company forecast and is labelled as such', () => {
  assert.equal(t.forwardPe, +(40e12 / 5.6e12).toFixed(1));
  assert.equal(t.guidance.basis, 'company guidance, not consensus');
  assert.equal(t.guidance.fy, '2027-03-31');
});

test('a loss-maker has no P/E and keeps its negative earnings', () => {
  assert.equal(l.pe, null);
  assert.equal(l.np, -3e9);
  assert.equal(l.opMargin, -2);
});

test('empty strings are missing values, never zero', () => {
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num('0'), 0);
  assert.equal(num('12.5'), 12.5);
});

test('the earnings date is carried through as scheduled', () => {
  assert.equal(t.earnings.date, '2026-11-05');
  assert.equal(t.earnings.basis, 'scheduled');
});

test('currency is yen and the USD equivalent uses the FX rate', () => {
  assert.equal(t.currency, 'JPY');
  assert.equal(t.marketCapUsd, Math.round(40e12 / 150));
});

test('the exchange\u2019s TTM ratios are published over our fiscal-year ones', () => {
  const v = new Map([['72030', { PER: 8.81, PBR: 0.98, ROE: 0.1223, FwdPER: 11.21, EPS: 349.33, BPS: 3150.6, MktCap: 36437322 }]]);
  const out = deriveJapan({ ranked, fins, series: map, val: v, fx: 150 });
  const t = out.find((c) => c.code === '72030');
  assert.equal(t.pe, 8.81);
  assert.equal(t.peBasis, 'TTM');
  assert.equal(t.pb, 0.98);
  assert.equal(t.roe, 12.2);
  assert.equal(t.forwardPe, 11.2);
  assert.equal(t.marketCap, 36437322 * 1e6, 'cap comes from the exchange, ex-treasury');
  assert.equal(t.eps, 349.33);
});

test('P/B rebuilt from the filing is cross-checked against the exchange', () => {
  // Our equity says 40e12 / 26e12 = 1.54. The exchange says 1.54 → agree.
  const agree = new Map([['72030', { PER: 8.81, PBR: 1.538, ROE: 0.1223, MktCap: 40e6 }]]);
  assert.equal(deriveJapan({ ranked, fins, series: map, val: agree }).find((c) => c.code === '72030').verification.status, 'verified');

  // A P/B 20% away is recorded as a dispute with both numbers, never silently replaced.
  const disagree = new Map([['72030', { PER: 8.81, PBR: 1.2, ROE: 0.1223, MktCap: 40e6 }]]);
  const v = deriveJapan({ ranked, fins, series: map, val: disagree }).find((c) => c.code === '72030').verification;
  assert.equal(v.status, 'disputed');
  assert.ok(v.fields.equity.ours > v.fields.equity.alt);
});

test('cumulative year-to-date figures become standalone quarters', async () => {
  const { buildQuarters } = await import('../scripts/derive-japan.mjs');
  const rows = [
    { CurPerType: '1Q', CurFYEn: '2026-03-31', CurPerEn: '2025-06-30', DiscDate: '2025-08-01', Sales: '100', OP: '10', NP: '7' },
    { CurPerType: '2Q', CurFYEn: '2026-03-31', CurPerEn: '2025-09-30', DiscDate: '2025-11-01', Sales: '210', OP: '22', NP: '15' },
    { CurPerType: '3Q', CurFYEn: '2026-03-31', CurPerEn: '2025-12-31', DiscDate: '2026-02-01', Sales: '330', OP: '36', NP: '24' },
    { CurPerType: 'FY', CurFYEn: '2026-03-31', CurPerEn: '2026-03-31', DiscDate: '2026-05-01', Sales: '450', OP: '50', NP: '34' },
  ];
  const q = buildQuarters(rows);
  assert.deepEqual(q.map((x) => x.sales), [100, 110, 120, 120]);
  assert.deepEqual(q.map((x) => x.op), [10, 12, 14, 14]);
  assert.deepEqual(q.map((x) => x.d), ['2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31']);
});

test('guidance is compared with the first forecast of that year, not a late revision', async () => {
  const { guidanceVsDelivered } = await import('../scripts/derive-japan.mjs');
  const rows = [
    { CurPerType: '1Q', CurFYEn: '2026-03-31', DiscDate: '2025-08-01', FNP: '500' },
    { CurPerType: '3Q', CurFYEn: '2026-03-31', DiscDate: '2026-02-01', FNP: '550' },   // revised up
    { CurPerType: 'FY', CurFYEn: '2026-03-31', DiscDate: '2026-05-01', NP: '560' },
  ];
  const g = guidanceVsDelivered(rows);
  assert.equal(g.forecast, 500);
  assert.equal(g.actual, 560);
  assert.equal(g.deltaPct, 12);
  assert.equal(g.basis, 'first forecast published that fiscal year');
});
