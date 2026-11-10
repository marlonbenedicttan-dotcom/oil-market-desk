// The company matrix is a browser function, so the test extracts the pure model block from app.js
// and runs it without a DOM. It guards the fiscal calendar, the label convention and the no-future
// periods rule across markets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');
const start = src.indexOf('function coMatrixPeriods');
const end = src.indexOf('function coMatrixInner');
const api = new Function(`${src.slice(start, end)}\nreturn { coMatrixBuild, coMatrixDetectN };`)();
const us = JSON.parse(readFileSync(join(here, '..', 'data', 'companies.json'), 'utf8')).companies;
const company = (ticker) => us.find((c) => c.ticker === ticker);
const sumGroup = (model, year) => {
  const g = model.groups.get(year) || {};
  return Object.keys(g).map((q) => g[q].revenue).filter((v) => v != null).reduce((a, b) => a + b, 0);
};
const seriesRevenue = (c, fy) => (c.series || []).find((x) => Number(x.fy) === fy)?.revenue;

test('a US quarter is labelled by the fiscal year that contains it, matching the annual table', () => {
  const c = company('NVDA');
  const m = api.coMatrixBuild(c, { market: 'us' });
  assert.deepEqual(m.years.slice(0, 3), [2026, 2025, 2024]);
  assert.equal(m.groups.get(2025)[1].date, '2025-04-27');
  assert.ok(Math.abs(sumGroup(m, 2025) - seriesRevenue(c, 2025)) / seriesRevenue(c, 2025) < 0.005);
});

test('a January fiscal year keeps the vendor label and does not shift a column', () => {
  const c = company('WMT');
  const m = api.coMatrixBuild(c, { market: 'us' });
  assert.ok(m.years.includes(2025));
  assert.ok(Math.abs(sumGroup(m, 2025) - seriesRevenue(c, 2025)) / seriesRevenue(c, 2025) < 0.005);
  assert.equal(m.groups.get(2025)[4].date, '2026-01-31');
});

test('a missing quarter leaves its own cell blank instead of shifting the later quarters', () => {
  const c = {
    ticker: 'TEST',
    quarters: [
      { end: '2025-03-31', revenue: 10, netIncome: 1 },
      { end: '2025-09-30', revenue: 30, netIncome: 3 },
      { end: '2025-12-31', revenue: 40, netIncome: 4 },
      { end: '2026-03-31', revenue: 11, netIncome: 1 },
    ],
    series: [{ fy: 2025, revenue: 80, netIncome: 8 }],
  };
  const m = api.coMatrixBuild(c, { market: 'us' });
  assert.equal(m.groups.get(2025)[1].revenue, 10);
  assert.equal(m.groups.get(2025)[2], undefined);
  assert.equal(m.groups.get(2025)[3].revenue, 30);
  assert.equal(m.groups.get(2025)[4].revenue, 40);
});

test('the latest reported quarter is shown, and no future-dated period is', () => {
  const c = company('MSFT');
  const m = api.coMatrixBuild(c, { market: 'us' });
  const last = m.periods[m.periods.length - 1];
  assert.ok(last.date <= new Date().toISOString().slice(0, 10));
  assert.ok(m.periods.every((p) => p.date <= new Date().toISOString().slice(0, 10)));
  // After the stale-feed refresh the latest 10-Q is in the matrix.
  assert.equal(last.date, '2026-09-30');
  assert.ok(m.years.includes(2027));
  assert.equal(m.groups.get(2027)[1].date, '2026-09-30');
});

test('a synthetic future quarter is discarded', () => {
  const c = {
    ticker: 'FUT',
    quarters: [
      { end: '2025-03-31', revenue: 10 },
      { end: '2025-06-30', revenue: 11 },
      { end: '2099-03-31', revenue: 999 },
    ],
    series: [{ fy: 2025, revenue: 21 }],
  };
  const m = api.coMatrixBuild(c, { market: 'us' });
  assert.ok(m.periods.every((p) => p.date <= new Date().toISOString().slice(0, 10)));
  assert.equal(m.periods.length, 2);
});

test('a half-year feed builds H1/H2 from the actual period ends', () => {
  const c = {
    ticker: 'AUX',
    periodBasis: 'half',
    quarters: [
      { d: '2025-06-30', revenue: 100 },
      { d: '2025-12-31', revenue: 110 },
      { d: '2026-06-30', revenue: 120 },
    ],
    history: [
      { y: '2025-06-30', s: 200 },
      { y: '2026-06-30', s: 230 },
    ],
  };
  const m = api.coMatrixBuild(c, { market: 'au' });
  assert.equal(m.n, 2);
  assert.equal(m.basis, 'period');
  assert.equal(m.groups.get(2026)[1].date, '2025-12-31');
  assert.equal(m.groups.get(2026)[2].date, '2026-06-30');
});

test('no region builds a period after today and every grouped cell carries its date', () => {
  const today = new Date().toISOString().slice(0, 10);
  const dirs = [
    ['au', 'australia-companies'], ['jp', 'japan-companies'], ['kr', 'korea-companies'],
    ['tw', 'taiwan-companies'], ['hk', 'hongkong-companies'], ['in', 'india-companies'],
    ['id', 'indonesia-companies'], ['br', 'brazil-companies'], ['za', 'southafrica-companies'],
  ];
  let checked = 0;
  for (const [market, dir] of dirs) {
    const path = join(here, '..', 'data', dir);
    for (const f of readdirSync(path)) {
      if (!f.endsWith('.json')) continue;
      const c = JSON.parse(readFileSync(join(path, f), 'utf8'));
      const m = api.coMatrixBuild(c, { market });
      if (!m) continue;
      checked++;
      for (const p of m.periods) {
        assert.ok(p.date, `${market}/${c.code}: a period has a date`);
        assert.ok(p.date <= today, `${market}/${c.code}: ${p.date} is not in the future`);
      }
      for (const [y, g] of m.groups) {
        for (const q of Object.keys(g)) {
          if (g[q] && (g[q].revenue != null || g[q].netIncome != null)) {
            assert.ok(g[q].date, `${market}/${c.code}: FY${y} Q${q} has a period date`);
          }
        }
      }
      assert.ok(m.n === 2 || m.n === 4, `${market}/${c.code}: a known period width`);
    }
  }
  assert.ok(checked > 10000, `the matrix model covers every region (${checked} companies)`);
});


test('a ten-year history keeps every year for horizontal scrolling', () => {
  const quarters = [];
  const series = [];
  for (let y = 2016; y <= 2025; y++) {
    const total = 400 + (y - 2016) * 40;
    series.push({ fy: y, revenue: total, netIncome: total / 10 });
    for (let q = 1; q <= 4; q++) {
      quarters.push({ end: `${y}-${String(q * 3).padStart(2, '0')}-30`, revenue: total / 4, netIncome: total / 40 });
    }
  }
  const m = api.coMatrixBuild({ ticker: 'LONG', quarters, series }, { market: 'us' });
  assert.equal(m.years.length, 10);
  assert.deepEqual(m.years, [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016]);
});
