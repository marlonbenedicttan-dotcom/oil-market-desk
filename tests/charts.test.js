import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, openSync, readSync, closeSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combineSeries, pointsFromColumns, rangeStart, sliceRange, seriesFromLine } from '../src/charts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('pointsFromColumns skips gaps and keeps the date alignment of the rest', () => {
  const p = pointsFromColumns(['2024-01-01', '2024-01-02', '2024-01-03'], [10, null, 30]);
  assert.deepEqual(p, [{ d: '2024-01-01', c: 10 }, { d: '2024-01-03', c: 30 }]);
});

test('combineSeries keeps daily points and fills older history from weekly, without duplicates', () => {
  const daily = [{ d: '2024-01-03', c: 30 }, { d: '2024-01-04', c: 40 }];
  const weekly = [{ d: '2023-12-01', c: 10 }, { d: '2024-01-03', c: 999 }];
  assert.deepEqual(combineSeries(daily, weekly), [
    { d: '2023-12-01', c: 10 },
    { d: '2024-01-03', c: 30 },   // daily wins on a shared date
    { d: '2024-01-04', c: 40 },
  ]);
});

test('combineSeries returns the daily series when there is no weekly history', () => {
  const daily = [{ d: '2024-01-03', c: 30 }];
  assert.deepEqual(combineSeries(daily, []), [{ d: '2024-01-03', c: 30 }]);
});

test('rangeStart measures back from the series last date, not today', () => {
  assert.equal(rangeStart('2024-06-30', 'ytd'), '2024-01-01');
  assert.equal(rangeStart('2024-06-30', '1m'), '2024-05-30');
  assert.equal(rangeStart('2024-06-30', '1y'), '2023-06-30');
  assert.equal(rangeStart('2024-06-30', '5y'), '2019-07-01');
  // Yahoo's aliases are accepted too: the client used to send 1mo/6mo.
  assert.equal(rangeStart('2024-06-30', '1mo'), rangeStart('2024-06-30', '1m'));
});

test('sliceRange keeps dates and closes aligned and excludes the older tail', () => {
  const dates = ['2022-01-01', '2024-01-02', '2024-01-03'];
  const closes = [1, 2, 3];
  assert.deepEqual(sliceRange(dates, closes, '1m'), { dates: ['2024-01-02', '2024-01-03'], closes: [2, 3] });
  assert.deepEqual(sliceRange(dates, closes, '5y'), { dates, closes });
  // Too short to chart is an empty answer, never a one-point line.
  assert.deepEqual(sliceRange(['2024-01-01'], [1], '1y'), { dates: [], closes: [] });
});

test('seriesFromLine expands date indices and skips an unknown index', () => {
  const line = { k: '2330', p: [[0, 10], [2, 30], [9, 99]] };
  assert.deepEqual(seriesFromLine(line, ['2024-01-01', '2024-01-02', '2024-01-03']), {
    dates: ['2024-01-01', '2024-01-03'],
    closes: [10, 30],
  });
});

// The chart store is a build artifact, like korea-list.json. If a build forgets to refresh it the
// chart still works (the server falls back), but the page pays the old parse cost again — so the
// artifact being present and populated is part of the fix.
test('the US store carries the S&P 1500, so the market chart is not a live Yahoo call', () => {
  const idx = JSON.parse(readFileSync(join(ROOT, 'data', 'charts', 'us.idx.json'), 'utf8'));
  const span = idx.keys['^SP1500'];
  assert.ok(span, '^SP1500 is missing from the US chart store');
  const fd = openSync(join(ROOT, 'data', 'charts', 'us.ndjson'), 'r');
  const buf = Buffer.alloc(span[1]);
  const n = readSync(fd, buf, 0, span[1], span[0]);
  closeSync(fd);
  const series = seriesFromLine(JSON.parse(buf.toString('utf8', 0, n)), idx.dates);
  assert.ok(series.dates.length > 100, `the S&P 1500 has only ${series.dates.length} points`);
  assert.equal(series.dates.length, series.closes.length);
});

test('the chart store covers every market', () => {
  const markets = {
    us: 'NVDA', jp: '72030', kr: '005930', tw: '2330', hk: '0700', au: 'BHP',
    in: 'RELIANCE', id: 'BBCA', br: 'PETR4', za: 'NPN',
  };
  for (const [market, code] of Object.entries(markets)) {
    const idxFile = join(ROOT, 'data', 'charts', `${market}.idx.json`);
    assert.ok(existsSync(idxFile), `${market}: chart index is missing`);
    const idx = JSON.parse(readFileSync(idxFile, 'utf8'));
    assert.ok(Object.keys(idx.keys).length > 100, `${market}: chart store looks collapsed`);
    assert.ok(idx.dates.length > 20, `${market}: no shared date table`);
    assert.ok(idx.source, `${market}: no source stamp — the server cannot detect a stale store`);
    const span = idx.keys[code];
    assert.ok(span, `${market}: ${code} is not in the chart store`);
    const fd = openSync(join(ROOT, 'data', 'charts', `${market}.ndjson`), 'r');
    const buf = Buffer.alloc(span[1]);
    const n = readSync(fd, buf, 0, span[1], span[0]);
    closeSync(fd);
    const series = seriesFromLine(JSON.parse(buf.toString('utf8', 0, n)), idx.dates);
    assert.ok(series.dates.length > 10, `${market}: ${code} has ${series.dates.length} points`);
    assert.equal(series.dates.length, series.closes.length);
  }
});

// A store built before the final data rewrite is worse than no store: the server sees the stamp
// mismatch and falls back to the slow whole-market parse, which is exactly the regression that made
// Korea 7 s on the live site. The build scripts run the store builder last; this catches a build that
// forgot to, before the commit reaches production.
test('every chart store is current with the source it was built from', () => {
  const sources = {
    us: 'us-charts.json', jp: 'japan-series.json', kr: 'korea.json',
    tw: 'taiwan-series', hk: 'hongkong-series', au: 'australia-series',
    in: 'india-series', id: 'indonesia-series', br: 'brazil-series', za: 'southafrica-series',
  };
  const fileStamp = (file) => {
    const buf = Buffer.alloc(256);
    const fd = openSync(file, 'r');
    const n = readSync(fd, buf, 0, 256, 0);
    closeSync(fd);
    const m = /"updated"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
    return m ? m[1] : null;
  };
  for (const [market, src] of Object.entries(sources)) {
    const p = join(ROOT, 'data', src);
    const source = src.endsWith('.json')
      ? p
      : join(p, readdirSync(p).filter((f) => f.endsWith('.json')).sort()[0]);
    const idx = JSON.parse(readFileSync(join(ROOT, 'data', 'charts', `${market}.idx.json`), 'utf8'));
    assert.equal(idx.source, fileStamp(source), `${market}: chart store is behind ${src} — run scripts/build-chart-store.mjs ${market}`);
  }
});
