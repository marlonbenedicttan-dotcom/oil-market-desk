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
      for (const [y, g] of m.groups) {
        const qs = Object.keys(g).map(Number).sort((a, b) => a - b);
        for (let i = 0; i < qs.length; i++) {
          assert.ok(Number.isInteger(qs[i]) && qs[i] >= 1 && qs[i] <= m.n,
            `${market}/${c.code}: quarter ${qs[i]} is inside 1..${m.n}`);
          if (i && g[qs[i]].date && g[qs[i - 1]].date) {
            assert.ok(String(g[qs[i]].date) > String(g[qs[i - 1]].date),
              `${market}/${c.code}: FY${y} Q${qs[i]} is after Q${qs[i - 1]}`);
          }
        }
      }
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

test('a Q4 tagged with the annual total is rebuilt from the annual record', () => {
  // DINO's 2024 10-K put the full-year revenue in the fourth-quarter context: Q4 printed as
  // $28.58B while Q1–Q3 were $22.08B. The annual record is the reliable side of that pair.
  const c = company('DINO');
  const m = api.coMatrixBuild(c, { market: 'us' });
  const ann = c.series.find((x) => Number(x.fy) === 2024).revenue;
  const q4 = m.groups.get(2024)[4].revenue;
  assert.ok(q4 < ann * 0.6, `Q4 should be a quarter, not the year (got ${q4} vs ${ann})`);
  assert.ok(Math.abs(sumGroup(m, 2024) - ann) / ann < 0.01, 'the repaired quarters reconcile with the annual');
  assert.ok(m.repairs.repaired.size > 0, 'the repair is reported');
});

test('an irregular four-period window does not move the fiscal year end', () => {
  // Cardinal Health reports to June. Its quarter feed skips two quarters in 2026, so four
  // entries spanning 15 months once matched the FY2026 total and moved the year-end to September.
  const c = company('CAH');
  const m = api.coMatrixBuild(c, { market: 'us' });
  assert.equal(m.grouping, 'annual');
  assert.equal(m.groups.get(2026)[1].date, '2025-09-30');
  assert.equal(m.groups.get(2026)[2].date, '2025-12-31');
  assert.equal(m.groups.get(2026)[3], undefined);
  assert.equal(m.groups.get(2026)[4], undefined);
  assert.equal(m.groups.get(2027)[1].date, '2026-09-30');
});

test('an early-month quarter stays in its own quarter (no Q2.67)', () => {
  const c = company('PEP');
  const m = api.coMatrixBuild(c, { market: 'us' });
  for (const [, g] of m.groups) {
    for (const q of Object.keys(g)) assert.ok(Number.isInteger(Number(q)), `quarter ${q} is an integer`);
  }
  assert.equal(m.groups.get(2026)[3].date, '2026-09-05');
});

test('a fiscal-year change gets its own labelled column, not a lost quarter', () => {
  const c = JSON.parse(readFileSync(join(here, '..', 'data', 'japan-companies', '2871.json'), 'utf8'));
  const m = api.coMatrixBuild(c, { market: 'jp' });
  const split = Object.keys(m.yearLabels || {});
  assert.ok(split.length >= 2, 'both ends of the split year are labelled');
  assert.match(m.yearLabels['2026'], /Mar/);
  assert.match(m.yearLabels['2026.12'], /Dec/);
  assert.equal(m.groups.get(2026)[1].date, '2025-06-30');
  assert.equal(m.groups.get(2026.12)[1].date, '2026-06-30');
});

test('an annual-only feed does not invent a half-year matrix', () => {
  const c = {
    ticker: 'ANNUAL',
    quarters: [
      { end: '2024-12-31', revenue: 100 },
      { end: '2025-12-31', revenue: 110 },
    ],
    series: [{ fy: 2024, revenue: 100 }, { fy: 2025, revenue: 110 }],
  };
  assert.equal(api.coMatrixBuild(c, { market: 'us' }), null);
});

test('the matrix TTM source matches the profile TTM tile', () => {
  const msft = company('MSFT');
  const us = api.coMatrixBuild(msft, { market: 'us' });
  assert.ok(us.topTtm, 'US has a trailing tile');
  assert.equal(us.topTtm.netIncome, msft.netIncomeTTM);
  const bhp = JSON.parse(readFileSync(join(here, '..', 'data', 'australia-companies', 'BHP.json'), 'utf8'));
  const au = api.coMatrixBuild(bhp, { market: 'au' });
  assert.equal(au.topTtm.netIncome, bhp.reports.ttm.netIncome);
  const tsm = JSON.parse(readFileSync(join(here, '..', 'data', 'taiwan-companies', '2330.json'), 'utf8'));
  const tw = api.coMatrixBuild(tsm, { market: 'tw' });
  assert.equal(tw.topTtm.netIncome, tsm.reports.ttm.netIncome);
  const toyota = JSON.parse(readFileSync(join(here, '..', 'data', 'japan-companies', '7203.json'), 'utf8'));
  assert.equal(api.coMatrixBuild(toyota, { market: 'jp' }).topTtm, null, 'Japan top tile is the fiscal year');
  const samsung = JSON.parse(readFileSync(join(here, '..', 'data', 'korea-companies', '005930.json'), 'utf8'));
  assert.equal(api.coMatrixBuild(samsung, { market: 'kr' }).topTtm, null, 'Korea FY P/E top tile is the fiscal year');
});
