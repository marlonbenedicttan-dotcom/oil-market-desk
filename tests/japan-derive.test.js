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
