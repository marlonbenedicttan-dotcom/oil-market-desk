import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relValueAt, buildRelValueRow, relValueZone, ordinal } from '../src/lib.js';

// A small date series helper: n consecutive days from 2025-01-01.
const days = (n, start = Date.UTC(2025, 0, 1)) => Array.from({ length: n }, (_, i) => new Date(start + i * 864e5).toISOString().slice(0, 10));

test('relValueAt handles a same-unit difference', () => {
  assert.equal(relValueAt({ kind: 'diff', a: 'a', b: 'b' }, { a: 103.5, b: 96 }), 7.5);
});

test('relValueAt converts the second leg before subtracting', () => {
  // Palm is $/t; soyoil is ¢/lb. 50 ¢/lb × 22.0462 = $1,102.31/t.
  const v = relValueAt({ kind: 'diff', a: 'palm', b: 'soyoil', bf: 22.0462 }, { palm: 4000, soyoil: 50 });
  assert.ok(Math.abs(v - 2897.69) < 0.01, `got ${v}`);
});

test('relValueAt computes ratios and gas/oil on an energy basis', () => {
  // 3 $/MMBtu × 5.8 MMBtu/bbl ÷ 96 $/bbl = 0.18125
  const v = relValueAt({ kind: 'ratio', a: 'gas', b: 'wti', af: 5.8 }, { gas: 3, wti: 96 });
  assert.ok(Math.abs(v - 0.18125) < 1e-9, `got ${v}`);
  assert.equal(relValueAt({ kind: 'ratio', a: 'a', b: 'b' }, { a: 10, b: 0 }), null);
});

test('relValueAt reproduces the 3-2-1, crush and steel formulas', () => {
  assert.equal(relValueAt({ kind: 'margin', calc: 'c321' }, { rbob: 2, ulsd: 2, wti: 80 }), 4);
  const crush = relValueAt({ kind: 'margin', calc: 'crush' }, { soymeal: 300, soyoil: 50, soybean: 1000 });
  assert.ok(Math.abs(crush - 2.7) < 1e-9, `got ${crush}`);
  const steel = relValueAt({ kind: 'margin', calc: 'steel' }, { steel: 800, ironore: 100 });
  assert.ok(Math.abs(steel - (800 / 0.90718474 - 160)) < 1e-6, `got ${steel}`);
});

test('diesel minus gasoline is 42 × the per-gallon difference', () => {
  const v = relValueAt({ kind: 'diff', a: 'ulsd', b: 'rbob', scale: 42 }, { ulsd: 2.5, rbob: 2.1 });
  assert.ok(Math.abs(v - 16.8) < 1e-9, `got ${v}`);
});

test('buildRelValueRow ranks the last value against its own history', () => {
  const d = days(100);
  const legs = { a: {}, b: {} };
  d.forEach((day, i) => { legs.a[day] = 100 + i; legs.b[day] = 90; });
  const row = buildRelValueRow({ id: 'x', label: 'X', kind: 'diff', a: 'a', b: 'b', unit: '$', dp: 2 }, legs);
  assert.equal(row.obs, 100);
  assert.equal(row.asOf, d[99]);
  assert.equal(row.last, 109);
  assert.equal(row.pct, 100);
});

test('buildRelValueRow only uses dates both legs share', () => {
  const legs = { a: { '2025-01-01': 10, '2025-01-02': 11, '2025-01-03': 12 }, b: { '2025-01-02': 5, '2025-01-03': 6, '2025-01-04': 7 } };
  const row = buildRelValueRow({ id: 'x', label: 'X', kind: 'diff', a: 'a', b: 'b' }, legs);
  assert.equal(row.obs, 2);
  assert.equal(row.asOf, '2025-01-03');
  assert.equal(row.last, 6);
});

test('a missing leg or a short history leaves the percentile blank', () => {
  const d = days(10);
  const short = { a: {}, b: {} };
  d.forEach((day, i) => { short.a[day] = 100 + i; short.b[day] = 90; });
  const row = buildRelValueRow({ id: 'x', label: 'X', kind: 'diff', a: 'a', b: 'b' }, short);
  assert.equal(row.obs, 10);
  assert.equal(row.last, 19);
  assert.equal(row.pct, null);

  const missing = buildRelValueRow({ id: 'x', label: 'X', kind: 'diff', a: 'a', b: 'b' }, { a: short.a });
  assert.equal(missing.obs, 0);
  assert.equal(missing.last, null);
  assert.equal(missing.pct, null);
});

test('scale is applied to the published value', () => {
  const legs = { a: { '2025-01-01': 4.5 }, b: { '2025-01-01': 4000 } };
  const row = buildRelValueRow({ id: 'x', label: 'X', kind: 'ratio', a: 'a', b: 'b', scale: 1000 }, legs);
  assert.equal(row.last, 1.125);
});

test('relValueZone names the position without pretending direction is good or bad', () => {
  assert.match(relValueZone(95), /near the top/);
  assert.match(relValueZone(75), /above/);
  assert.match(relValueZone(50), /around/);
  assert.match(relValueZone(25), /below/);
  assert.match(relValueZone(5), /near the bottom/);
  assert.equal(relValueZone(null), null);
});

test('ordinal handles the teens and the tens', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(91), '91st');
  assert.equal(ordinal(null), '—');
});
