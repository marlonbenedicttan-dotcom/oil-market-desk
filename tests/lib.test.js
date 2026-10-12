import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sgn, inBox, haversineNm, isoWeek, monthly, pctOver, percentile, realizedVol, computeCracks, computeCrush, backAdjust, pearson, logReturns, horizonDeltas, curveTightness, inventoryTightness, weightedScore, seasonalGrade, seasonalAhead, contractMonthsBetween, signedPosition, signedMove, stretchScore, attributeMoves } from '../src/lib.js';

test('sgn formats with sign', () => {
  assert.equal(sgn(4.39), '+4.39');
  assert.equal(sgn(-2), '-2.00');
  assert.equal(sgn(null), '—');
});

test('inBox detects points in a bounding box', () => {
  assert.equal(inBox(26.5, 56.5, [[24, 54], [28, 58]]), true);
  assert.equal(inBox(0, 0, [[24, 54], [28, 58]]), false);
});

test('haversineNm ≈ 60 nm per degree of longitude at the equator', () => {
  const d = haversineNm(0, 0, 0, 1);
  assert.ok(d > 59 && d < 61, `got ${d}`);
});

test('isoWeek', () => {
  assert.equal(isoWeek('2026-01-01'), 1);
  assert.equal(isoWeek('2026-12-31'), 53);
});

test('monthly keeps the last value of each month', () => {
  const m = monthly({ '2026-01-05': 1, '2026-01-20': 2, '2026-02-01': 3 });
  assert.deepEqual(m, { '2026-01': 2, '2026-02': 3 });
});

test('pctOver computes % change from the start', () => {
  assert.equal(Math.round(pctOver([100, 101, 102, 103, 104, 105], 5)), 5);
  assert.equal(pctOver([null, null], 1), null);
});

test('percentile ranks a value within a series', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 3), 60);
});

test('realizedVol returns null with too few points', () => {
  assert.equal(realizedVol([1, 2, 3], 30), null);
});

test('logReturns computes log changes and keeps nulls', () => {
  const r = logReturns({ a: 100, b: 110, c: 121 }, ['a', 'b', 'c', 'd']);
  assert.equal(r.length, 3); // one return per adjacent date pair
  assert.ok(Math.abs(r[0] - Math.log(1.1)) < 1e-9);
  assert.equal(r[2], null); // d missing -> no return
});

test('pearson correlates two series (and needs enough points)', () => {
  const up = Array.from({ length: 20 }, (_, i) => i);
  assert.equal(pearson(up, up), 1);
  assert.equal(pearson(up, up.map((v) => -v)), -1);
  assert.equal(pearson([1, 2, 3], [1, 2, 3]), null); // too few points
});

test('backAdjust removes roll jumps', () => {
  const raw = [10, 11, 13, 14];
  const gaps = new Map([[2, 1]]); // new − old = 13 − 12 = +1
  assert.deepEqual(backAdjust(raw, gaps), [11, 12, 13, 14]);
});

test('horizonDeltas computes 1D/1W/1M/YTD/1Y moves from a dated series', () => {
  const dates  = ['2023-12-01','2024-01-01','2024-02-01','2024-03-01','2024-04-01','2024-05-01','2024-06-01','2024-07-01','2024-08-01','2024-09-01','2024-10-01','2024-11-01','2024-12-01','2025-01-01','2025-02-01','2025-03-01','2025-04-01','2025-05-01','2025-06-01','2025-06-15'];
  const values = [50,52,54,56,58,60,62,64,66,68,70,72,74,80,82,84,86,88,90,95];
  const d = horizonDeltas(dates, values);
  assert.equal(d.d1, 5.56);   // 95 vs 90 (previous observation)
  assert.equal(d.w1, 5.56);   // 95 vs 90 (latest point ≤ 7 days back)
  assert.equal(d.m1, 7.95);   // 95 vs 88 (latest point ≤ 30 days back)
  assert.equal(d.ytd, 18.75); // 95 vs 80 (year-to-date base)
  assert.equal(d.y1, 53.23);  // 95 vs 62 (latest point ≤ 1 year back)
});

test('horizonDeltas never fakes a window it cannot compute', () => {
  assert.deepEqual(horizonDeltas(['2025-01-01'], [100]), { d1: null, w1: null, m1: null, ytd: null, y1: null });
  assert.equal(horizonDeltas(['2025-03-01', '2025-06-01'], [100, 110]).ytd, null); // starts mid-year → no YTD base
  assert.equal(horizonDeltas(['2025-06-01', '2025-06-15'], [0, 5]).d1, null);      // zero base skipped, not divided
  assert.equal(horizonDeltas(['2025-06-01', '2025-06-10', '2025-06-15'], [10, null, 12]).d1, 20); // nulls skipped
});

test('curveTightness: backwardation reads tight, contango loose, flat neutral', () => {
  assert.equal(curveTightness(0, 100), 50);
  assert.ok(curveTightness(2, 100) > 70);    // +2% backwardation
  assert.ok(curveTightness(-2, 100) < 30);   // contango
  assert.equal(curveTightness(null, 100), null);
  assert.equal(curveTightness(1, 0), null);  // no price → can't normalise
});

test('inventoryTightness: a bigger-than-usual draw reads tight', () => {
  assert.equal(inventoryTightness(0, -1000, 1000), 50);
  assert.ok(inventoryTightness(-1000, -1000, 1000) > 50); // drew more than usual
  assert.ok(inventoryTightness(1000, -1000, 1000) < 50);  // built more than usual
  assert.equal(inventoryTightness(null, -1, 1), null);
});

test('weightedScore averages the parts present and is null when none are', () => {
  const a = weightedScore([
    { key: 'c', label: 'Curve', weight: 0.4, score: 80 },
    { key: 'b', label: 'Basis', weight: 0.3, score: 20 },
    { key: 'i', label: 'Stocks', weight: 0.3, score: null }, // missing → skipped, weight re-normalised
  ]);
  assert.equal(a.score, 54); // (0.4*80 + 0.3*20) / 0.7 = 54.3 → 54
  assert.deepEqual(a.parts.map((p) => p.key), ['c', 'b']);
  assert.equal(a.label, 'BALANCED');
  assert.equal(weightedScore([]).score, null);
  assert.equal(weightedScore([]).label, '—');
});

test('seasonalGrade places today\u2019s price in the 5-yr band', () => {
  const low = { '06-15': 100 }, high = { '06-15': 200 }, median = { '06-15': 150 };
  const g = seasonalGrade(low, high, median, 150, '06-15');
  assert.equal(g.pos, 50);
  assert.equal(g.label, 'IN LINE');
  assert.equal(g.vsMedian, 0);
  assert.equal(seasonalGrade(low, high, median, 170, '06-15').label, 'ABOVE SEASONAL');
  assert.equal(seasonalGrade(low, high, median, 210, '06-15').label, 'WELL ABOVE SEASONAL');
  assert.equal(seasonalGrade(low, high, median, 90, '06-15').label, 'WELL BELOW SEASONAL');
  assert.equal(seasonalGrade(low, high, median, null, '06-15'), null);
  assert.equal(seasonalGrade(low, high, median, 150, '01-01'), null); // no band for that day
});

test('seasonalAhead gives the normal move along the median path', () => {
  const median = { '06-15': 100, '07-15': 110 };
  assert.equal(seasonalAhead(median, '06-15', '07-15'), 10);
  assert.equal(seasonalAhead(median, '06-15', '09-01'), null); // unknown target day
});

test('contractMonthsBetween measures the gap between futures months', () => {
  assert.equal(contractMonthsBetween('F26', 'G26'), 1);       // Jan → Feb 2026
  assert.equal(contractMonthsBetween('Z26', 'F27'), 1);       // Dec 2026 → Jan 2027
  assert.equal(contractMonthsBetween('F26', 'F27'), 12);
  assert.equal(contractMonthsBetween('F26', 'H26'), 2);       // Jan → Mar
  assert.equal(contractMonthsBetween(null, 'F26'), null);
});

test('signedPosition: ends at its highs → +100, at its lows → −100, middle → ~0', () => {
  const ramp = Array.from({ length: 101 }, (_, i) => i); // 0..100
  assert.equal(signedPosition(ramp), 100);               // last value is the max → rich
  assert.ok(signedPosition(ramp.slice().reverse()) <= -95, 'ending at its lows must be strongly negative (cheap)');
  const mid = ramp.slice(0, 100).concat([50]);           // last value ≈ median
  assert.ok(Math.abs(signedPosition(mid)) <= 5, `mid should be ~0, got ${signedPosition(mid)}`);
  assert.equal(signedPosition([1, 2, 3]), null);         // too few points
});

test('signedMove: a rise is positive, a fall negative, both scaled by the market’s own moves', () => {
  const flat = Array.from({ length: 60 }, (_, i) => 100 + (i % 3));
  const up = flat.concat([200]);   // a huge final move up
  const down = flat.concat([50]);  // a huge final move down
  assert.ok(signedMove(up, 1) > 0, `a rise must be positive, got ${signedMove(up, 1)}`);
  assert.ok(signedMove(down, 1) < 0, `a fall must be negative, got ${signedMove(down, 1)}`);
  assert.equal(signedMove([1, 2, 3], 5), null); // too short
});

test('stretchScore: signed blend reads rich on the way up, cheap on the way down', () => {
  const rich = stretchScore([{ key: 'a', label: 'A', weight: 0.6, score: 90 }, { key: 'b', label: 'B', weight: 0.4, score: 40 }]);
  assert.equal(rich.score, 70);
  assert.equal(rich.label, 'RICH');
  const cheap = stretchScore([{ key: 'a', label: 'A', weight: 0.6, score: -100 }, { key: 'b', label: 'B', weight: 0.4, score: -50 }]);
  assert.equal(cheap.score, -80);
  assert.equal(cheap.label, 'VERY CHEAP');
  assert.equal(stretchScore([]).score, null);
});

test('computeCrush: board crush = meal×0.024 + oil×0.11 − beans/100, with oil share', () => {
  const m = { benchmarks: [{ id: 'soymeal', paper: 364.4 }, { id: 'soyoil', paper: 67.89 }, { id: 'soybean', paper: 1283.75 }] };
  const c = computeCrush(m);
  assert.ok(Math.abs(c.crush - 3.376) < 0.02, `crush got ${c.crush}`);
  assert.ok(Math.abs(c.oilShare - 46.1) < 0.3, `oil share got ${c.oilShare}`);
  assert.deepEqual(computeCrush({ benchmarks: [{ id: 'corn', paper: 480 }] }), {}); // no beans/meal/oil → {}
});

test('attributeMoves picks the news kinds consistent with the move direction', () => {
  const events = [
    { kind: 'Geopolitics', effect: 'up', weight: 3, tier1: true, title: 'Hormuz strike', source: 'Reuters', url: 'u1', date: '2026-06-01' },
    { kind: 'Geopolitics', effect: 'up', weight: 3, title: 'Tension rises', source: 'X', url: 'u2', date: '2026-02-01' },
    { kind: 'Ample supply', effect: 'down', weight: 2, title: 'Record output', source: 'Y', url: 'u3', date: '2026-03-01' },
  ];
  const up = attributeMoves({ y1: 47, m6: -8 }, events);
  assert.equal(up.direction, 'up');
  assert.equal(up.drivers[0].kind, 'Geopolitics');            // aligns with the up move
  assert.equal(up.drivers[0].count, 2);
  assert.equal(up.drivers[0].sample.title, 'Hormuz strike');  // tier-1 sample wins
  const down = attributeMoves({ y1: -30, m6: -5 }, events);
  assert.equal(down.direction, 'down');
  assert.equal(down.drivers[0].kind, 'Ample supply');         // aligns with the down move
  assert.equal(attributeMoves({ y1: 2, m6: 1 }, events).direction, 'up'); // small year move -> uses 6m sign
  assert.deepEqual(attributeMoves({}, []).drivers, []);
  // bullish news must NOT "explain" a fall — flag the divergence instead
  const div = attributeMoves({ y1: -25, m6: -5 }, [{ kind: 'Drought', effect: 'up', weight: 3, title: 'x', source: 'y', url: 'z' }]);
  assert.equal(div.drivers.length, 0);
  assert.equal(div.divergence, true);
});

test('computeCracks builds refining margins', () => {
  const m = { benchmarks: [
    { id: 'wti', paper: 100, physical: 100 },
    { id: 'rbob', paper: 3, physical: 3 },
    { id: 'ulsd', paper: 4, physical: 4 },
    { id: 'jet', physical: 5 },
  ] };
  const c = computeCracks(m);
  assert.equal(c.gasoline, 3 * 42 - 100);
  assert.equal(c.diesel, 4 * 42 - 100);
  assert.equal(c.c321, ((2 * 3 + 4) * 42) / 3 - 100);
  assert.equal(c.jetPhys, 5 * 42 - 100);
});
