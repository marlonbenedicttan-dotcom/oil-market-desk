import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sgn, inBox, haversineNm, isoWeek, monthly, pctOver, percentile, lastNonNull, escHtml, webhookPayload, realizedVol, computeCracks, computeCrush, computeSteel, backAdjust, pearson, logReturns, horizonDeltas, horizonDeltasAbs, curveTightness, inventoryTightness, weightedScore, seasonalGrade, seasonalAhead, contractMonthsBetween, signedPosition, signedMove, stretchScore, sdLabel, attributeMoves, newsContextOk, looksLikeProperNoun, NON_MARKET_CTX, METHODOLOGY, positioningFlag, positioningRead, positioningDivergence, maxDrawdown, drawdownNow, realizedVolTerm, volPercentile, corrMatrix, fxAdjust, parseOcc, drawdownWord, volWord, volTrend, volVsOwnWord, corrWord, corrShift, focusRows, topPairs, pairGroups, bestDiversifier, riskRead, mergePeriods, mergeSeriesPoints } from '../src/lib.js';

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

test('webhookPayload shapes the POST for each chat service', () => {
  assert.deepEqual(webhookPayload('https://hooks.slack.com/services/T/B/x', 'S', 'T'), { json: { text: 'S\n\nT' } });
  assert.deepEqual(webhookPayload('https://discord.com/api/webhooks/1/abc', 'S', 'T'), { json: { content: 'S\n\nT' } });
  assert.deepEqual(webhookPayload('https://discordapp.com/api/webhooks/1/abc', 'S', 'T'), { json: { content: 'S\n\nT' } });
  assert.deepEqual(webhookPayload('https://api.telegram.org/bot123:abc/sendMessage', 'S', 'T', '99'), { json: { chat_id: '99', text: 'S\n\nT', disable_web_page_preview: true } });
  assert.deepEqual(webhookPayload('https://ntfy.sh/my-topic', 'Alert', 'plain body'), { raw: 'plain body', headers: { Title: 'Alert' } });
  assert.deepEqual(webhookPayload('https://example.com/my-hook', 'S', 'T'), { json: { subject: 'S', text: 'T' } });
});

test('escHtml neutralises external text but leaves prose markup alone', () => {
  assert.equal(escHtml('OPEC+ cuts & prices rise'), 'OPEC+ cuts &amp; prices rise');
  assert.equal(escHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escHtml('a "quote" and \'apostrophe\''), 'a &quot;quote&quot; and &#39;apostrophe&#39;');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
  // the prose wrapper keeps its tags — only the injected fragment is escaped
  assert.equal(`<b>OPEC</b>: ${escHtml('Rates < 5%')}`, '<b>OPEC</b>: Rates &lt; 5%');
});

test('lastNonNull returns the last present value (never a stale meta quote)', () => {
  assert.equal(lastNonNull([1, 2, null]), 2);
  assert.equal(lastNonNull([3]), 3);
  assert.equal(lastNonNull([null, null]), null);
  assert.equal(lastNonNull([]), null);
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

test('stretchScore: signed blend reads premium on the way up, discount on the way down', () => {
  const rich = stretchScore([{ key: 'a', label: 'A', weight: 0.6, score: 90 }, { key: 'b', label: 'B', weight: 0.4, score: 40 }]);
  assert.equal(rich.score, 70);
  assert.equal(rich.label, 'AT A PREMIUM');
  const cheap = stretchScore([{ key: 'a', label: 'A', weight: 0.6, score: -100 }, { key: 'b', label: 'B', weight: 0.4, score: -50 }]);
  assert.equal(cheap.score, -80);
  assert.equal(cheap.label, 'AT A BIG DISCOUNT');
  assert.equal(stretchScore([]).score, null);
});

test('sdLabel: plain supply/demand words, balanced at 50', () => {
  assert.equal(sdLabel(85), 'UNDERSUPPLIED');
  assert.equal(sdLabel(62), 'TIGHT');
  assert.equal(sdLabel(50), 'BALANCED');
  assert.equal(sdLabel(35), 'WELL SUPPLIED');
  assert.equal(sdLabel(15), 'OVERSUPPLIED');
  assert.equal(sdLabel(null), '—');
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

test('newsContextOk: a commodity word must be a MARKET story, not a name or a sport', () => {
  assert.ok(NON_MARKET_CTX.test('NBA finals'), 'sanity: the block-list regex is wired');
  // the bug this fixes: the NBA commissioner's name contains "silver"
  assert.equal(newsContextOk('NBA commissioner Adam Silver addresses the media'), false);
  assert.equal(newsContextOk('Adam Silver says the league will expand the playoffs'), false);
  // a real metals story still matches
  assert.equal(newsContextOk('Silver jumps on safe-haven demand'), true);
  assert.equal(newsContextOk('Gold and silver gain as the dollar slips'), true);
  assert.equal(newsContextOk('Silver prices hit a record high'), true);
  assert.equal(newsContextOk('Copper edges up on Chinese demand'), true);
  // the same class of bug in other segments
  assert.equal(newsContextOk('Families flock to the annual corn maze'), false);
  assert.equal(newsContextOk('Corn futures fall after a record harvest'), true);
  assert.equal(newsContextOk('Comedian Coffee Jones releases a new album'), false);
  // a hard market term (a unit / an exchange) overrides the sports/entertainment block-list
  assert.equal(newsContextOk('Comex silver futures steady amid NBA talk'), true);
  // unambiguous commodities stay on-topic without a price term (don't over-filter real coverage)
  assert.equal(newsContextOk('US to Reopen Largest Port for Mexican Cattle Shipments'), true);
  assert.equal(newsContextOk('Ghana cocoa regulator secures funding for farmer purchases'), true);
  // …while the homonyms still need market framing
  assert.equal(newsContextOk("Toshikazu Kawaguchi on the appeal of Japan's coffee shops"), false);
  assert.equal(newsContextOk("Watch Why Harley's Are Called Hogs"), false);
  // callers can force or waive the market-context requirement
  assert.equal(newsContextOk('Silver', { requireMarket: false }), true);
  assert.equal(newsContextOk('Corn futures fall after a record harvest', { requireMarket: true }), true);
});

test('horizonDeltasAbs gives ABSOLUTE changes (a yield move is pp, not %)', () => {
  const dates = ['2025-01-01', '2025-03-01', '2025-06-01', '2026-01-01', '2026-06-01'];
  const values = [4.00, 4.10, 4.30, 4.40, 4.25];
  const d = horizonDeltasAbs(dates, values);
  assert.equal(d.d1, -0.15);   // 4.25 vs 4.40
  assert.equal(d.ytd, -0.15);  // vs the 2026-01-01 base
  assert.equal(d.y1, -0.05);   // vs the latest point ≤ 1 year back (4.30)
  assert.deepEqual(horizonDeltasAbs(['2025-01-01'], [4.2]), { d1: null, w1: null, m1: null, ytd: null, y1: null });
});

test('positioningFlag / positioningRead turn a percentile into a plain verdict', () => {
  assert.equal(positioningFlag(95).label, 'CROWDED LONG');
  assert.equal(positioningFlag(95).tone, 'hot');
  assert.equal(positioningFlag(75).label, 'STRETCHED LONG');
  assert.equal(positioningFlag(20).label, 'WASHED-OUT');
  assert.equal(positioningFlag(5).label, 'CROWDED SHORT');
  assert.equal(positioningFlag(5).tone, 'hot');
  assert.equal(positioningFlag(50).label, 'NEUTRAL');
  assert.equal(positioningFlag(null).label, '—');
  assert.match(positioningRead(95), /crowded long/i);
  assert.match(positioningRead(5), /squeeze/i);
  assert.equal(positioningRead(null), '');
});

test('risk words: drawdownWord / volWord / volTrend / volVsOwnWord', () => {
  assert.equal(drawdownWord(-39), 'deep fall');
  assert.equal(drawdownWord(-12), 'moderate fall');
  assert.equal(drawdownWord(-2), 'barely moved');
  assert.equal(drawdownWord(null), '—');
  assert.equal(volWord(87), 'very jumpy');
  assert.equal(volWord(43), 'jumpy');
  assert.equal(volWord(19), 'normal');
  assert.equal(volWord(5), 'calm');
  assert.equal(volTrend({ w30: 30, w90: 20 }), 'rising');
  assert.equal(volTrend({ w30: 10, w90: 20 }), 'falling');
  assert.equal(volTrend({ w30: 20, w90: 20 }), 'flat');
  assert.equal(volVsOwnWord(95), 'unusually jumpy');
  assert.equal(volVsOwnWord(70), 'jumpier than usual');
  assert.equal(volVsOwnWord(50), 'typical');
  assert.equal(volVsOwnWord(25), 'calmer than usual');
  assert.equal(volVsOwnWord(5), 'unusually calm');
  assert.equal(volVsOwnWord(null), '—');
});

test('drawdownNow is today vs the high; maxDrawdown is the worst the year got', () => {
  const recovered = [10, 4, 9];
  assert.equal(maxDrawdown(recovered), -60);
  assert.equal(drawdownNow(recovered), -10);
  assert.equal(drawdownNow([10, 12, 13]), 0);
  assert.equal(drawdownNow([10, 12, 9, 6]), -50);
  assert.equal(drawdownNow([5]), null);
  assert.equal(drawdownNow([]), null);
});

test('volPercentile puts today against the instrument’s own year', () => {
  const xs = [];
  let p = 100;
  for (let i = 0; i < 200; i++) { p *= i % 2 ? 1.001 : 0.999; xs.push(p); }
  for (let i = 0; i < 40; i++) { p *= i % 2 ? 1.05 : 0.95; xs.push(p); }
  const pct = volPercentile(xs, 30);
  assert.ok(pct >= 90, `the last month is the most volatile of the year (got ${pct})`);
  assert.equal(volPercentile([1, 2, 3], 30), null, 'not enough history to rank');
});

test('corrWord / corrShift turn a pair into words, not just a colour', () => {
  assert.equal(corrWord(0.84), 'strong');
  assert.equal(corrWord(-0.55), 'clear');
  assert.equal(corrWord(0.34), 'moderate');
  assert.equal(corrWord(-0.12), 'loose');
  assert.equal(corrWord(null), '—');
  assert.equal(corrShift(0.5, 0.74).word, 'stronger');
  assert.equal(corrShift(0.7, 0.4).word, 'weaker');
  assert.equal(corrShift(-0.6, 0.5).word, 'flipped');
  assert.equal(corrShift(0.4, 0.5).word, 'steady');
  assert.equal(corrShift(null, 0.5), null);
});

test('focusRows / topPairs / pairGroups / bestDiversifier read a correlation matrix', () => {
  const keys = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }];
  const m = { a: { a: 1, b: 0.5, c: -0.2 }, b: { a: 0.5, b: 1, c: -0.9 }, c: { a: -0.2, b: -0.9, c: 1 } };
  assert.deepEqual(focusRows(m, 'a', keys).map((r) => [r.key, r.r]), [['b', 0.5], ['c', -0.2]]);
  assert.equal(topPairs(m, keys)[0].r, -0.9);                        // strongest |r|
  assert.equal(topPairs(m, keys)[0].a.key + topPairs(m, keys)[0].b.key, 'bc');
  const g = pairGroups(m, keys, 0.5);
  assert.deepEqual(g.together.map((p) => p.a.key + p.b.key), ['ab']); // +0.5 is the cut
  assert.deepEqual(g.opposite.map((p) => p.a.key + p.b.key), ['bc']);
  assert.equal(g.loose.length, 1);
  const div = bestDiversifier(m, keys);
  assert.equal(div.key, 'a');                                        // (0.5+0.2)/2 = 0.35, the lowest
  assert.equal(div.avg, 0.35);
});

test('riskRead leads with the current drawdown and never calls a level a loss', () => {
  const metrics = [
    { key: 'wti', label: 'WTI', drawdownNow: -12, drawdown: -39, vol: { w30: 43, w90: 48 }, volTrend: 'flat' },
    { key: 'gold', label: 'Gold', drawdownNow: -25, drawdown: -30, vol: { w30: 19, w90: 24 }, volTrend: 'rising' },
    { key: 'vix', label: 'VIX', level: true, drawdownNow: -54, drawdown: -54, vol: { w30: 87, w90: 90 }, volTrend: 'flat' },
  ];
  const s = riskRead(metrics);
  assert.match(s, /Gold<\/b> is 25% below its 1-year high \(worst fall 30%\)/);
  assert.match(s, /WTI<\/b> is the jumpiest to own \(43%\); <b>VIX<\/b> is more volatile still \(87%\), but that is a level move, not a loss/);
  assert.match(s, /Vol is building for Gold/);
  assert.doesNotMatch(s, /Wildest here/);
});

test('parseOcc decodes an OCC option symbol', () => {
  assert.deepEqual(parseOcc('USO261014C00123000'), { root: 'USO', expiry: '2026-10-14', type: 'call', strike: 123 });
  assert.deepEqual(parseOcc('GLD261218P00450000'), { root: 'GLD', expiry: '2026-12-18', type: 'put', strike: 450 });
  assert.equal(parseOcc('not-an-option'), null);
  assert.equal(parseOcc(null), null);
});

test('fxAdjust converts a USD return into a base-currency return', () => {
  // +10% in USD and the base weakens 5% (USD/base up 5%) → base gain ≈ 1.10/1.05 − 1 = +4.76% (div)
  assert.equal(fxAdjust(10, 5, 'div'), 4.76);
  // +10% in USD and USD/base up 5% (multiply) → +15.5%
  assert.equal(fxAdjust(10, 5, 'mul'), 15.5);
  // a flat FX move leaves the return unchanged
  assert.equal(fxAdjust(7.5, 0, 'div'), 7.5);
  assert.equal(fxAdjust(null, 5, 'mul'), null);
});

test('maxDrawdown finds the worst peak-to-trough decline', () => {
  assert.equal(maxDrawdown([100, 120, 90, 110]), -25);
  assert.equal(maxDrawdown([100, 130, 120]), -7.7);
  assert.equal(maxDrawdown([100, 110, 120]), 0);   // never below a prior peak
  assert.equal(maxDrawdown([5]), null);
});

test('realizedVolTerm gives a vol per window (null when too short)', () => {
  const ramp = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const t = realizedVolTerm(ramp);
  assert.ok(t.w30 > 0 && t.w60 > 0 && t.w90 > 0);
  assert.equal(realizedVolTerm([1, 2, 3]).w90, null);
});

test('corrMatrix is +1 for a series with itself and −1 for a mirrored one', () => {
  const mk = (rets) => { let p = 100; const m = {}; rets.forEach((r, i) => { p *= Math.exp(r); m['2026-' + String(i + 1).padStart(3, '0')] = p; }); return m; };
  const rets = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.02 : -0.02));
  const a = mk(rets), b = mk(rets.map((r) => -r));
  const m = corrMatrix({ a, b }, Object.keys(a));
  assert.equal(m.a.a, 1);
  assert.equal(m.a.b, -1);
});

test('METHODOLOGY documents all nine company markets', () => {
  const text = METHODOLOGY.companies.map((c) => `${c.name} ${c.basis} ${c.note}`).join(' ');
  for (const market of ['Hong Kong', 'Australia', 'India', 'Indonesia', 'Brazil']) {
    assert.ok(new RegExp(market, 'i').test(text), `missing ${market} in the company data`);
  }
  const limits = METHODOLOGY.limits.join(' ');
  for (const market of ['Hong Kong', 'Australia', 'India', 'Indonesia', 'Brazil']) {
    assert.match(limits, new RegExp(market, 'i'), `missing ${market} in the limits`);
  }
});

test('METHODOLOGY is complete — every source and score carries its labels', () => {
  assert.ok(Array.isArray(METHODOLOGY.sources) && METHODOLOGY.sources.length >= 6, 'expect a source list');
  for (const s of METHODOLOGY.sources) assert.ok(s.name && s.covers && s.freshness, `source incomplete: ${JSON.stringify(s)}`);
  assert.equal(METHODOLOGY.scores.length, 2, 'price score + supply/demand score');
  for (const s of METHODOLOGY.scores) assert.ok(s.name && s.range && s.read, `score incomplete: ${JSON.stringify(s)}`);
  assert.ok(METHODOLOGY.basis.length > 40, 'basis needs an explanation');
  assert.ok(METHODOLOGY.rules.some((r) => /not investment advice/i.test(r)), 'keep the disclaimer');
});

test('looksLikeProperNoun flags a commodity used as a surname', () => {
  assert.equal(looksLikeProperNoun('Adam Silver said the league will expand'), true);
  assert.equal(looksLikeProperNoun('Ari Gold is a fictional agent'), true);
  assert.equal(looksLikeProperNoun('Silver prices rose today'), false);
  assert.equal(looksLikeProperNoun('The silver market is tight'), false);
});

test('newsContextOk: the MACRO domain needs an economy story, not just a country name', () => {
  // a sports/entertainment headline that merely names the country must not attach
  assert.equal(newsContextOk('US beat Mexico in the World Cup final', { domain: 'macro' }), false);
  assert.equal(newsContextOk("Japanese film wins the Palme d'Or at Cannes", { domain: 'macro' }), false);
  assert.equal(newsContextOk('India wins the cricket series against Australia', { domain: 'macro' }), false);
  // a real economy story stays
  assert.equal(newsContextOk('US inflation cools as the Fed holds rates', { domain: 'macro' }), true);
  assert.equal(newsContextOk('Japan GDP beats forecasts as the yen steadies', { domain: 'macro' }), true);
  assert.equal(newsContextOk('China unveils fresh stimulus to lift property demand', { domain: 'macro' }), true);
  assert.equal(newsContextOk('Euro area inflation falls to the ECB\u2019s target', { domain: 'macro' }), true);
  assert.equal(newsContextOk('UK bond yields jump after a budget downgrade', { domain: 'macro' }), true);
  // a hard macro term overrides a stray sports word
  assert.equal(newsContextOk('RBI holds rates despite the cricket season', { domain: 'macro' }), true);
  // a commodity headline is never judged by the macro rules
  assert.equal(newsContextOk('Silver jumps on safe-haven demand'), true);
  assert.equal(newsContextOk('Silver', { domain: 'macro' }), false); // no economy framing at all
});

test('computeSteel: coil per tonne minus 1.6t of ore, with the short->metric conversion', () => {
  // $907.18474 per SHORT ton is exactly $1,000 per metric tonne.
  const m = { benchmarks: [{ id: 'steel', paper: 907.18474 }, { id: 'ironore', paper: 100 }] };
  const r = computeSteel(m);
  assert.equal(+r.coilPerT.toFixed(2), 1000);
  assert.equal(r.orePerT, 160);
  assert.equal(+r.margin.toFixed(2), 840);
  assert.equal(+r.ratio.toFixed(2), 10);
  // Missing one leg -> nothing invented, exactly like the crush.
  assert.deepEqual(computeSteel({ benchmarks: [{ id: 'steel', paper: 900 }] }), {});
  assert.deepEqual(computeSteel({}), {});
});

test('positioningDivergence: specs fading a rally is bearish, buying weakness is bullish', () => {
  const d0 = Date.UTC(2026, 0, 6);
  const day = (i) => new Date(d0 + i * 7 * 864e5).toISOString().slice(0, 10);
  const rows = Array.from({ length: 15 }, (_, i) => ({ date: day(i), net: 120000, oi: 2000000 }));
  const price = {};
  for (const r of rows) price[r.date] = 100;
  // 13-week window runs rows[1] -> rows[14]
  price[rows[14].date] = 110;                       // +10%
  rows[14].net = 80000;                             // specs cut 2 points of OI
  const bear = positioningDivergence(price, rows);
  assert.equal(bear.tone, 'bear');
  assert.equal(+bear.pricePct.toFixed(1), 10);
  assert.equal(+bear.netPctChg.toFixed(1), -2);

  const down = { ...price };
  down[rows[14].date] = 92;                         // -8%
  const added = rows.map((r) => ({ ...r }));
  added[14].net = 160000;                           // specs added 2 points
  const bull = positioningDivergence(down, added);
  assert.equal(bull.tone, 'bull');

  // price up and specs adding = aligned, not a divergence
  assert.equal(positioningDivergence(price, added).tone, 'aligned');

  // no invented signal when there is not enough history
  assert.equal(positioningDivergence(price, rows.slice(0, 5)).tone, 'flat');
  assert.equal(positioningDivergence({}, rows).tone, 'flat');
});

import { frontExpiry } from '../src/lib.js';

test('frontExpiry applies each market\'s own expiry rule, not one shared date', () => {
  // WTI: 3 business days before the 25th of the month before delivery.
  assert.equal(frontExpiry('CL', '2026-10-19'), '2026-10-21');
  assert.equal(frontExpiry('CL', '2026-10-21'), '2026-10-21');   // still front month ON expiry day
  assert.equal(frontExpiry('CL', '2026-10-22'), '2026-11-20');   // rolled to the next contract
  // Gold: third-last business day of the delivery month.
  assert.equal(frontExpiry('GC', '2026-10-01'), '2026-10-28');
  // Corn: business day before the 15th of the month before delivery.
  assert.equal(frontExpiry('ZC', '2026-10-01'), '2026-10-14');
  // Unknown roots are null, never a guess.
  assert.equal(frontExpiry('NOPE', '2026-10-01'), null);
});

import { priorityOf, rankByPriority, splitCause, classifyEvent, matchEntities, clusterEvents, scoreEvents, selectEvents, sourceTier, explainRows, textTags } from '../src/lib.js';

test('priorityOf puts the macro core ahead of specialist markets', () => {
  assert.equal(priorityOf('wti'), 1);
  assert.equal(priorityOf('gold'), 1);
  assert.equal(priorityOf('us'), 1);
  assert.equal(priorityOf('corn'), 2);
  assert.equal(priorityOf('id'), 2);
  assert.equal(priorityOf('cheese'), 3);
  assert.equal(priorityOf('hogs'), 3);
  // Unknown ids may appear, but are never assumed core.
  assert.equal(priorityOf('something-new'), 2);
  // Empirical backstop: a stepped series is thin whatever the list says.
  assert.equal(priorityOf({ id: 'corn', flat: 41 }), 3);
});

test('rankByPriority never lets a thin market lead on a price move alone', () => {
  // The exact complaint: cheddar +6% scores 9.9, Brent +2% scores 1.4.
  const board = [
    { id: 'cheese', label: 'Cheddar Cheese', kind: 'bench', group: 'Dairy', d1: 6, score: 9.9, flat: 45 },
    { id: 'milk', label: 'Class III Milk', kind: 'bench', group: 'Dairy', d1: 4, score: 7.2, flat: 40 },
    { id: 'wti', label: 'WTI (Cushing)', kind: 'bench', group: 'Crude', d1: 2, score: 1.4, flat: 0 },
    { id: 'gold', label: 'Gold', kind: 'bench', group: 'Metals', d1: 1.5, score: 1.1, flat: 0 },
    { id: 'us', label: 'United States', kind: 'index', d1: 0.9, score: 0.9, flat: 0 },
    { id: 'corn', label: 'Corn', kind: 'bench', group: 'Agriculture', d1: 3, score: 2.2, flat: 0 },
  ];
  const picked = rankByPriority(board, { max: 6, slots: { 1: 4, 2: 2, 3: 0 } });
  assert.deepEqual(picked.map((x) => x.id), ['wti', 'gold', 'us', 'corn']);
  assert.equal(picked[0].id, 'wti', 'a core market leads, not the biggest percentage');
  assert.ok(!picked.some((x) => priorityOf(x) === 3), 'no thin market on a price move alone');
});

test('rankByPriority fills core first, keeps diversity, and honours the cap', () => {
  const board = [
    { id: 'wti', kind: 'bench', group: 'Crude', d1: 1, score: 5 },
    { id: 'brent', kind: 'bench', group: 'Crude', d1: 1, score: 4 },
    { id: 'gold', kind: 'bench', group: 'Metals', d1: 1, score: 3 },
    { id: 'copper', kind: 'bench', group: 'Metals', d1: 1, score: 2 },
    { id: 'corn', kind: 'bench', group: 'Agriculture', d1: 1, score: 9 },
    { id: 'wheat', kind: 'bench', group: 'Agriculture', d1: 1, score: 8 },
    { id: 'coffee', kind: 'bench', group: 'Agriculture', d1: 1, score: 7 },
  ];
  const picked = rankByPriority(board, { max: 5, slots: { 1: 4, 2: 2, 3: 0 } });
  assert.deepEqual(picked.map((x) => x.id), ['wti', 'brent', 'gold', 'copper', 'corn']);
  // Two per group: Crude has two, Metals two, and the remaining Agriculture slot is one, not three.
  assert.equal(picked.filter((x) => x.group === 'Agriculture').length, 1);
  assert.equal(picked.length, 5);
});

test('rankByPriority can admit a tier-3 market when a confirmed event allows it', () => {
  const board = [
    { id: 'butter', kind: 'bench', group: 'Dairy', d1: 12, score: 8, flat: 45 },
    { id: 'wti', kind: 'bench', group: 'Crude', d1: 1, score: 1 },
  ];
  const picked = rankByPriority(board, { max: 6, slots: { 1: 4, 2: 2, 3: 1 } });
  assert.deepEqual(picked.map((x) => x.id), ['wti', 'butter']);
  assert.equal(picked[0].id, 'wti', 'even then, a thin market never leads');
});

test('splitCause extracts the wire\'s own reason and invents nothing', () => {
  assert.deepEqual(
    splitCause('Indonesian stocks sink as MSCI flags possible reclassification'),
    { what: 'Indonesian stocks sink', why: 'MSCI flags possible reclassification' });
  assert.deepEqual(
    splitCause('Oil jumps after OPEC agrees output cut'),
    { what: 'Oil jumps', why: 'OPEC agrees output cut' });
  // A headline with no causal clause stays a fact; the caller must not manufacture a reason.
  assert.deepEqual(splitCause('Gold rises'), { what: 'Gold rises', why: null });
  // "on Monday" is not a cause, even though "on" can introduce one.
  assert.deepEqual(splitCause('Ford on Monday reports earnings'), { what: 'Ford on Monday reports earnings', why: null });
  // "as nuclear weapons state" is a description, not a reason.
  assert.deepEqual(
    splitCause('North Korea says sanctions do not work as nuclear weapons state'),
    { what: 'North Korea says sanctions do not work as nuclear weapons state', why: null });
});

test('classifyEvent puts index reviews and policy ahead of a generic market move', () => {
  assert.equal(classifyEvent('MSCI puts Indonesia on review').id, 'market-access');
  assert.equal(classifyEvent('OPEC agrees output cut').id, 'opec');
  assert.equal(classifyEvent('Butter jumps after EU export ban').id, 'sanctions');
  assert.equal(classifyEvent('Fed cuts rates').id, 'central-bank');
  assert.equal(classifyEvent('US tech stocks tumble').id, 'markets');
  assert.equal(classifyEvent('China to convene meeting on supporting stock market').id, 'policy');
  // The subject decides the category: an economy print with war in the background is data, not war.
  assert.equal(classifyEvent('Saudi economy shrank at a slower pace before the war escalated').id, 'data');
  assert.equal(classifyEvent('Oil jumps after attack on a tanker').id, 'geopolitics');
  // A colour piece about election day is not an election result.
  assert.equal(classifyEvent("When buses stopped running on Brazil election day, 'Lula's Army' grabbed their car keys"), null);
  assert.equal(classifyEvent('Brazil election result lifts stocks').id, 'politics');
  // A dairy quote on its own is not an event.
  assert.equal(classifyEvent('Cheddar cheese prices jump 6%'), null);
});

test('clusterEvents counts corroboration and ignores a dairy quote', () => {
  const catalog = [
    { id: 'id', label: 'Indonesia', kind: 'country', patterns: ['Indonesia', 'Indonesian', 'IDX', 'rupiah'] },
    { id: 'us', label: 'United States', kind: 'country', patterns: [/United States/, /\bUS\b/, 'S&P 500'] },
    { id: 'cheese', label: 'Cheddar Cheese', kind: 'bench', patterns: ['cheddar', 'cheese'] },
  ];
  const day = '2026-11-02';
  const items = [
    { title: 'Indonesian stocks sink as MSCI flags possible reclassification', source: 'Bloomberg', url: 'u1', date: `${day}T01:00:00Z` },
    { title: 'Indonesia shares fall after MSCI review warning', source: 'Reuters', url: 'u2', date: `${day}T02:00:00Z` },
    { title: 'US tech stocks tumble as AI spending concerns intensify', source: 'Financial Times', url: 'u3', date: `${day}T03:00:00Z` },
    { title: 'Cheddar cheese prices jump 6%', source: 'Reuters', url: 'u4', date: `${day}T04:00:00Z` },
  ];
  const clusters = clusterEvents(items, { catalog, now: Date.parse(`${day}T12:00:00Z`) });
  const idc = clusters.find((c) => c.primary && c.primary.id === 'id');
  assert.ok(idc, 'the Indonesia story is one event');
  assert.equal(idc.category, 'market-access');
  assert.equal(idc.corroboration, 2, 'two wires corroborate it');
  assert.match(idc.why, /MSCI/);
  assert.ok(idc.at, 'keeps the best headline timestamp for the reader\'s local clock');
  assert.ok(!clusters.some((c) => c.primary && c.primary.id === 'cheese'), 'a price print is not an event');
});

test('clusterEvents drops analysis pieces and stale items', () => {
  const day = '2026-11-02';
  const catalog = [{ id: 'wti', label: 'WTI', kind: 'bench', patterns: ['WTI', 'OPEC'] }];
  const items = [
    { title: 'What would another OPEC conflict look like?', source: 'Financial Times', date: `${day}T00:00:00Z` },
    { title: "An Asian Stock Trader's Guide Ahead of the US Midterm Elections", source: 'Bloomberg', date: `${day}T00:00:00Z` },
    { title: 'OPEC agrees output cut', source: 'Reuters', date: '2026-10-30T00:00:00Z' },
    { title: 'OPEC agrees output cut after talks', source: 'Reuters', date: `${day}T00:00:00Z` },
  ];
  const clusters = clusterEvents(items, { catalog, now: Date.parse(`${day}T12:00:00Z`) });
  assert.equal(clusters.length, 1, 'only the current, non-analysis story survives');
  assert.equal(clusters[0].category, 'opec');
});

test('clusterEvents accepts a deal as a first-class event', () => {
  const c = clusterEvents([{
    title: 'Ares Capital to buy Apollo MFIC in $2.6 billion deal', source: 'Reuters', url: 'u',
    date: '2026-11-02T10:00:00Z', category: 'mna', categoryLabel: 'M&A', weight: 6, mechanism: 'm',
    entities: [{ id: 'deal:apollo|ares', label: 'Apollo MFIC', kind: 'company' }],
  }], { catalog: [], now: Date.parse('2026-11-02T12:00:00Z') });
  assert.equal(c.length, 1);
  assert.equal(c[0].label, 'M&A');
  assert.equal(c[0].primary.id, 'deal:apollo|ares');
});

test('clusterEvents follows the session date, not the wall clock', () => {
  const catalog = [{ id: 'us', label: 'United States', kind: 'country', patterns: [/\bUS\b/] }];
  const item = { title: 'US tech stocks tumble', source: 'Financial Times', url: 'u', date: '2026-10-30T12:00:00Z' };
  assert.equal(clusterEvents([item], { catalog, refDate: '2026-10-30' }).length, 1, 'Friday news explains Friday\'s close');
  assert.equal(clusterEvents([item], { catalog, refDate: '2026-11-02' }).length, 0, 'it is not today\'s news');
});

test('explainRows gives global and commodity reasons, clearly labelled', () => {
  const rows = [
    { id: 'us', kind: 'index', d1: -1.8, label: 'United States', why: { title: 'US tech stocks tumble', source: 'FT', url: 'u1' } },
    { id: 'jp', kind: 'index', d1: -2.1, label: 'Japan' },
    { id: 'kr', kind: 'index', d1: -3.5, label: 'Korea' },
    { id: 'za', kind: 'index', d1: -3.6, label: 'South Africa' },
    { id: 'gold', kind: 'bench', group: 'Metals', d1: -3.3, label: 'Gold', why: { title: 'Gold slides', source: 'Reuters', url: 'u2' } },
    { id: 'sg', kind: 'index', d1: -1.0, label: 'Singapore' },
  ];
  const clusters = [{
    primary: { id: 'us', kind: 'country' }, label: 'Markets', what: 'US tech stocks tumble',
    why: 'AI spending concerns', titles: ['US tech stocks tumble as AI spending concerns intensify'],
    source: 'Financial Times', url: 'u1', score: 90,
  }];
  const out = explainRows(rows, clusters, {
    exposures: { jp: ['tech'], kr: ['tech'], za: ['metals'], us: ['tech'] },
    groups: { jp: 'asia', kr: 'asia', za: 'africa', us: 'americas', sg: 'asia' },
    directionOf: (t) => (/tumble|slides|falls|down/i.test(t) ? 'down' : /rise|jump|up/i.test(t) ? 'up' : null),
  });
  assert.equal(out[1].why.scope, 'global', 'Japan gets the shared tech driver, labelled global');
  assert.match(out[1].why.title, /tech stocks/);
  assert.equal(out[2].why.scope, 'global', 'Korea too');
  assert.equal(out[3].why.scope, 'commodity', 'South Africa gets the gold/metal driver');
  assert.match(out[3].why.title, /Gold slides/);
  assert.equal(out[5].why, undefined, 'no invented reason when nothing matches');
  assert.deepEqual(textTags('Gold and copper slide'), ['metals']);
});

test('scoreEvents ranks a policy event over a broad market move, and selectEvents keeps it diverse', () => {
  const mk = (over) => ({ mechanism: 'm', what: 'w', why: 'y', ageDays: 0, corroboration: 1, ...over });
  const clusters = [
    mk({ key: 'market-access|id|d', category: 'market-access', label: 'Market access', weight: 8,
      primary: { id: 'id', label: 'Indonesia', kind: 'country' }, entities: [{ id: 'id', kind: 'country' }], source: 'Bloomberg', corroboration: 2 }),
    mk({ key: 'markets|us|d', category: 'markets', label: 'Markets', weight: 5,
      primary: { id: 'us', label: 'United States', kind: 'country' }, entities: [{ id: 'us', kind: 'country' }], source: 'Financial Times' }),
    mk({ key: 'geopolitics|wti|d', category: 'geopolitics', label: 'Geopolitics', weight: 10,
      primary: { id: 'wti', label: 'WTI', kind: 'bench' }, entities: [{ id: 'wti', kind: 'bench' }], source: 'Reuters' }),
  ];
  const marketCtx = { id: { kind: 'index', label: 'IDX', d1: -2.1 }, wti: { kind: 'bench', label: 'WTI', d1: 3.4 } };
  const scored = scoreEvents(clusters, { marketCtx, seen: new Set() });
  assert.equal(scored[0].category, 'geopolitics', 'the heaviest category leads');
  assert.equal(scored.find((c) => c.category === 'market-access').confirmed, true);
  assert.equal(scored.find((c) => c.category === 'market-access').novelty, 'new');
  const picked = selectEvents(scored, { max: 5, perCategory: 2 });
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((e) => e.primary.id)).size, picked.length, 'one story per subject');
});

test('a tier-3 market needs corroboration before it becomes an event', () => {
  const dairy = {
    key: 'supply|cheese|d', category: 'supply', label: 'Supply shock', weight: 7, mechanism: 'm',
    primary: { id: 'cheese', label: 'Cheddar', kind: 'bench' }, entities: [{ id: 'cheese', kind: 'bench' }],
    source: 'Reuters', corroboration: 1, ageDays: 0, what: 'Cheese jumps', why: null,
  };
  assert.equal(selectEvents([dairy]).length, 0, 'one wire and no market proof is not enough');
  assert.equal(selectEvents([{ ...dairy, corroboration: 2 }]).length, 1, 'two wires is');
});

test('sourceTier puts Bloomberg and the FT above a single wire', () => {
  assert.ok(sourceTier('Bloomberg') > sourceTier('Reuters'));
  assert.ok(sourceTier('Financial Times') > sourceTier('CNBC'));
  assert.equal(sourceTier('Some Blog'), 0);
});

test('mergePeriods accepts a numeric fiscal-year key', () => {
  const merged = mergePeriods(
    [{ fy: 2021, revenue: 10 }, { fy: 2022, revenue: 11 }],
    [{ fy: 2022, revenue: 11 }, { fy: 2023, revenue: 12 }],
    'fy',
  );
  assert.deepEqual(merged.map((r) => r.fy), [2021, 2022, 2023]);
});

test('mergePeriods keeps years that scrolled off the vendor page', () => {
  // The vendor shows a rolling five-year window; the platform keeps what it has.
  const prev = [
    { end: '2021-12-31', revenue: 10 },
    { end: '2022-12-31', revenue: 11 },
    { end: '2023-12-31', revenue: 12 },
  ];
  const next = [
    { end: '2022-12-31', revenue: 11 },
    { end: '2023-12-31', revenue: 12 },
    { end: '2024-12-31', revenue: 13 },
  ];
  const out = mergePeriods(prev, next, 'end');
  assert.deepEqual(out.map((r) => r.end), ['2021-12-31', '2022-12-31', '2023-12-31', '2024-12-31']);
});

test('mergePeriods lets a restatement replace the old figure', () => {
  const prev = [{ end: '2023-12-31', revenue: 12 }, { end: '2024-12-31', revenue: 13 }];
  const next = [{ end: '2024-12-31', revenue: 14 }];
  const out = mergePeriods(prev, next, 'end');
  assert.equal(out.find((r) => r.end === '2024-12-31').revenue, 14);
  assert.equal(out.length, 2);
});

test('mergePeriods keeps a descending table descending', () => {
  const prev = [{ end: '2023-12-31' }, { end: '2022-12-31' }];
  const next = [{ end: '2024-12-31' }, { end: '2023-12-31' }];
  const out = mergePeriods(prev, next, 'end');
  assert.deepEqual(out.map((r) => r.end), ['2024-12-31', '2023-12-31', '2022-12-31']);
});

test('mergePeriods survives a missing table and an odd record', () => {
  assert.deepEqual(mergePeriods(null, undefined, 'end'), []);
  assert.deepEqual(mergePeriods([{ end: '2023-12-31' }], null, 'end'), [{ end: '2023-12-31' }]);
  const out = mergePeriods([{ end: '2023-12-31' }], [{ end: '2024-12-31' }, { noEnd: 1 }], 'end');
  assert.deepEqual(out.map((r) => r.end), ['2023-12-31', '2024-12-31']);
});

test('mergePeriods never resurrects a junk period inside the vendor window', () => {
  // China Eastern's old parse wrote 2022-01-01 / 2023-01-01; the corrected build has 2021-12-31 ..
  // 2025-12-31. Restoring the junk dates would show two extra, wrong fiscal years.
  const prev = [
    { end: '2022-01-01', revenue: 1 },
    { end: '2023-01-01', revenue: 2 },
    { end: '2025-12-31', revenue: 3 },
  ];
  const next = [
    { end: '2021-12-31', revenue: 10 },
    { end: '2022-12-31', revenue: 11 },
    { end: '2025-12-31', revenue: 13 },
  ];
  const out = mergePeriods(prev, next, 'end');
  assert.deepEqual(out.map((r) => r.end), ['2021-12-31', '2022-12-31', '2025-12-31']);
});

test('mergeSeriesPoints keeps the sessions that scrolled off the window', () => {
  const prev = [{ d: '2020-01-02', c: 10 }, { d: '2021-01-04', c: 11 }, { d: '2022-01-03', c: 12 }];
  const next = [{ d: '2021-01-04', c: 11 }, { d: '2022-01-03', c: 12 }, { d: '2023-01-03', c: 13 }];
  const out = mergeSeriesPoints(prev, next);
  assert.deepEqual(out.map((r) => r.d), ['2020-01-02', '2021-01-04', '2022-01-03', '2023-01-03']);
});

test('mergeSeriesPoints rescales older prices after a split', () => {
  // A two-for-one split: every fresh price is half the stored one, so the kept 2020 bar must halve too.
  const prev = [
    { d: '2020-01-02', c: 100 },
    { d: '2021-01-04', c: 200 }, { d: '2021-01-05', c: 202 },
    { d: '2021-01-06', c: 204 }, { d: '2021-01-07', c: 206 }, { d: '2021-01-08', c: 208 },
  ];
  const next = [
    { d: '2021-01-04', c: 100 }, { d: '2021-01-05', c: 101 },
    { d: '2021-01-06', c: 102 }, { d: '2021-01-07', c: 103 }, { d: '2021-01-08', c: 104 },
  ];
  const out = mergeSeriesPoints(prev, next);
  assert.equal(out[0].d, '2020-01-02');
  assert.equal(out[0].c, 50);           // halved, so the chart has no cliff
  assert.equal(out.at(-1).c, 104);
});

test('mergeSeriesPoints does not rescale when the overlap agrees', () => {
  const prev = [{ d: '2020-01-02', c: 10 }, { d: '2021-01-04', c: 11 }];
  const next = [{ d: '2021-01-04', c: 11.02 }, { d: '2022-01-03', c: 12 }];
  const out = mergeSeriesPoints(prev, next);
  assert.equal(out[0].c, 10);           // kept at its own scale
});

test('mergeSeriesPoints handles a listing with no overlap and empty input', () => {
  assert.deepEqual(mergeSeriesPoints([], [{ d: '2024-01-02', c: 5 }]), [{ d: '2024-01-02', c: 5 }]);
  assert.deepEqual(mergeSeriesPoints([{ d: '2020-01-02', c: 5 }], []), [{ d: '2020-01-02', c: 5 }]);
  const out = mergeSeriesPoints([{ d: '2020-01-02', c: 5 }], [{ d: '2021-01-04', c: 7 }]);
  assert.deepEqual(out.map((r) => r.d), ['2020-01-02', '2021-01-04']);
});
