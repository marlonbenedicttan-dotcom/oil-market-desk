import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const PORT = 4999;
let child;

before(async () => {
  child = spawn('node', [BIN], { env: { ...process.env, PORT: String(PORT), NOTIFY: 'off', WARM: 'off' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
});

after(() => { child?.kill(); });

test('serves the dashboard', async () => {
  const r = await fetch(`http://localhost:${PORT}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /MARLON'S WATCHTOWER/);
  assert.match(html, /data-pane="home"/);   // watchlist + alerts home screen
  assert.match(html, /id="home-watch"/);
  assert.match(html, /id="headlines"/);     // live headlines board now lives in HOME
  assert.match(html, /id="regime-board"/);  // cross-asset backdrop (INVESTOR #2)
  assert.match(html, /id="screen"/);        // screener (INVESTOR #3)
  assert.match(html, /id="home-rules"/);    // custom alert rules (INVESTOR #4)
  assert.doesNotMatch(html, /class="hero"/); // ...not pinned to the top of every page
});

test('pure endpoints always respond 200', async () => {
  for (const p of ['/api/chokepoints', '/api/reroute', '/api/flows']) {
    const r = await fetch(`http://localhost:${PORT}${p}`);
    assert.equal(r.status, 200, `${p} -> ${r.status}`);
    await r.json(); // must be valid JSON
  }
});

// Data endpoints depend on external APIs — assert the server responds without crashing.
// `flares` (NASA FIRMS' global 24h CSV, ~25s) and `sar` (Copernicus) are slow THIRD-PARTY feeds: if the
// upstream stalls we accept the failed fetch rather than blaming our server, because the endpoint is
// still exercised by the status assertion whenever the feed answers.
const ENDPOINTS = [
  { p: '/api/market' }, { p: '/api/curve' }, { p: '/api/tightness' }, { p: '/api/products' },
  { p: '/api/analytics' }, { p: '/api/inventories' }, { p: '/api/positioning' }, { p: '/api/equities' },
  { p: '/api/flares', external: true }, { p: '/api/sar', external: true },
];
for (const { p, external } of ENDPOINTS) {
  test(`GET ${p} responds`, async () => {
    try {
      const r = await fetch(`http://localhost:${PORT}${p}`);
      assert.ok([200, 500].includes(r.status), `${p} -> ${r.status}`);
    } catch (e) {
      if (!external) throw e;
      assert.match(String(e.message), /fetch|abort|socket|timeout|other side/i, `${p} upstream failed unexpectedly: ${e.message}`);
    }
  });
}

test('/api/brief returns the on-screen daily brief (headline + happened + next + alerts)', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/brief`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.error, undefined, JSON.stringify(j).slice(0, 120));
  assert.ok(typeof j.headline === 'string' && j.headline.length > 0);
  assert.ok(Array.isArray(j.happened) && j.happened.length > 0);
  assert.ok(j.happened.every((x) => x.text && x.kind));
  assert.ok(Array.isArray(j.next) && j.next.length > 0);
  assert.ok(j.next.every((e) => e.name));
  assert.ok(Array.isArray(j.alerts));
});

test('/api/alerts returns the server alert engine output', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/alerts`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.current), 'current must be an array');
  for (const a of j.current) assert.ok(a.key && a.level && a.text, 'each alert needs key + level + text');
});

test('/api/markets groups benchmarks into 9 segments (WTI+Brent=Crude, fuels=Refined)', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/markets`);
  assert.equal(r.status, 200);
  const ms = await r.json();
  assert.equal(ms.length, 9);
  const crude = ms.find((m) => m.id === 'crude');
  assert.deepEqual(crude.components.map((c) => c.id), ['wti', 'brent']);
  assert.equal(crude.hasBasis, true);
  assert.deepEqual(ms.find((m) => m.id === 'refined').components.map((c) => c.id), ['rbob', 'ulsd', 'jet', 'propane']);
  assert.equal(ms.find((m) => m.id === 'precious').components.length, 4);
  assert.equal(ms.find((m) => m.id === 'grains').hasBasis, false);
  assert.deepEqual(ms.find((m) => m.id === 'grains').components.map((c) => c.id), ['corn', 'wheat', 'soybean', 'soymeal', 'soyoil']);
  // nickel is gone; industrial metals are copper + aluminium
  assert.deepEqual(ms.find((m) => m.id === 'industrial').components.map((c) => c.id), ['copper', 'aluminium']);
  // a new Livestock segment exists, headed by live cattle
  const live = ms.find((m) => m.id === 'livestock');
  assert.ok(live, 'livestock segment must exist');
  assert.equal(live.primary, 'cattle');
  assert.deepEqual(live.components.map((c) => c.id), ['cattle', 'hogs', 'feeder']);
  assert.equal(live.hasBasis, false);
  // a Dairy segment exists, headed by Class III milk, with the full CME complex
  const dairy = ms.find((m) => m.id === 'dairy');
  assert.ok(dairy, 'dairy segment must exist');
  assert.equal(dairy.primary, 'milk');
  assert.deepEqual(dairy.components.map((c) => c.id), ['milk', 'butter', 'nfdm', 'cheese', 'whey']);
  assert.equal(dairy.hasBasis, false);
  assert.ok(ms.every((m) => m.primary && m.hasCOT));
});

test('/api/crush returns the soybean board crush + oil share + aligned history', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/crush`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(typeof j.crush === 'number' && Number.isFinite(j.crush), 'crush is a finite number');
  assert.ok(typeof j.oilShare === 'number' && j.oilShare > 0 && j.oilShare < 100, 'oil share is a valid %');
  assert.ok(Array.isArray(j.history?.dates) && j.history.dates.length > 20, 'has a crush history');
  assert.equal(j.history.crush.length, j.history.dates.length, 'history arrays are aligned');
  assert.ok(j.legs && typeof j.legs.mealValue === 'number' && typeof j.legs.oilValue === 'number', 'exposes the legs');
});

test('/api/marketread returns a per-segment read (404 for unknown)', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/marketread?id=grains`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.id, 'grains');
  assert.ok(j.verdict && typeof j.verdict.score !== 'undefined');
  assert.ok(Array.isArray(j.verdict.sectorsUp) && Array.isArray(j.verdict.tickersDown));
  assert.equal((await fetch(`http://localhost:${PORT}/api/marketread?id=nope`)).status, 404);
});

test('/api/marketread gives a SIGNED price-vs-history score, separate from supply & demand', async () => {
  const crude = await (await fetch(`http://localhost:${PORT}/api/marketread?id=crude`)).json();
  const ps = crude.verdict.priceStretch;
  assert.ok(ps && typeof ps.score === 'number', 'the price headline is a number');
  assert.ok(ps.score >= -100 && ps.score <= 100, 'the price headline is signed and bounded to ±100');
  assert.ok(Array.isArray(ps.parts) && ps.parts.length >= 3, 'the price score exposes its components');
  assert.ok(ps.parts.some((p) => p.key === 'pos2y'), 'includes the 2-yr position component');
  assert.ok(ps.parts.every((p) => p.score == null || (p.score >= -100 && p.score <= 100)), 'each part is signed and bounded');
  const sd = crude.verdict.supplyDemand;
  assert.ok(sd && typeof sd === 'object', 'supplyDemand is present');
  assert.ok(sd.score == null || (sd.score >= 0 && sd.score <= 100), 'the S/D score is 0-100 when present');
  assert.ok(sd.score == null || ['UNDERSUPPLIED', 'TIGHT', 'BALANCED', 'WELL SUPPLIED', 'OVERSUPPLIED'].includes(sd.label), 'S/D label is a plain word');
  assert.ok(Array.isArray(sd.parts) && typeof sd.note === 'string' && sd.note.length > 0, 'S/D exposes its parts + an evidence note');
  // grains have no free basis or inventories → the S/D read is curve-only, never a basis component
  const grains = await (await fetch(`http://localhost:${PORT}/api/marketread?id=grains`)).json();
  assert.ok(grains.verdict.supplyDemand.parts.every((p) => p.key !== 'basis'));
  // peanuts: no free basis; corn (grains' headline) DOES have the USDA stocks-to-use snapshot leg
  assert.ok(grains.verdict.supplyDemand.parts.some((p) => p.key === 'usda'), 'grains S/D includes the USDA stocks-to-use leg');
  assert.equal(grains.verdict.supplyDemand.kind, 'physical');
});

test('/api/movewho returns trusted-source news for the given move dates', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/movewho?id=crude&dates=${encodeURIComponent('2026-07-13:1,2026-04-14:-1')}`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.results), 'results is an array');
  for (const x of j.results) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(x.date), 'each result carries its date');
  assert.equal((await fetch(`http://localhost:${PORT}/api/movewho?id=nope&dates=2026-07-13:1`)).status, 404);
});

test('/api/news returns headlines for segments and macro regions (graceful if unavailable)', async () => {
  for (const id of ['crude', 'us', 'eu', 'jp', 'apac']) {
    const r = await fetch(`http://localhost:${PORT}/api/news?id=${id}`);
    assert.equal(r.status, 200, `${id} -> ${r.status}`);
    const j = await r.json();
    assert.ok(Array.isArray(j.items), `${id}: items must be an array`);
  }
  assert.equal((await fetch(`http://localhost:${PORT}/api/news?id=nope`)).status, 404);
});

test('/api/countries, /api/country and /api/region-quotes', async () => {
  const c = await (await fetch(`http://localhost:${PORT}/api/countries`)).json();
  for (const r of ['us', 'eu', 'jp', 'cn', 'in', 'apac']) assert.ok(c[r] && c[r].length, `region ${r}`);
  const idn = await (await fetch(`http://localhost:${PORT}/api/country?id=id`)).json();
  assert.equal(idn.label, 'Indonesia');
  assert.ok(idn.fx && idn.index && idn.fund && Array.isArray(idn.fund.gdpGrowth));
  assert.equal(idn.fx.source, 'Yahoo Finance');
  assert.ok(idn.fx.deltas && 'd1' in idn.fx.deltas, 'country fx carries multi-horizon deltas');
  assert.ok(idn.fund.debtToGdp && idn.fund.debtToGdp.year >= 2018, 'debt/GDP is current (IMF WEO), not a stale year');
  assert.equal((await fetch(`http://localhost:${PORT}/api/country?id=nope`)).status, 404);
  const mt = await (await fetch(`http://localhost:${PORT}/api/region-quotes?id=apac`)).json();
  assert.ok(Array.isArray(mt.items) && mt.items.length >= 8);   // currencies (and indices where free)
  assert.ok(mt.items.some((i) => i.deltas && 'd1' in i.deltas), 'region currencies carry deltas');
});

test('/api/headlines + /api/fundamentals respond', async () => {
  const h = await (await fetch(`http://localhost:${PORT}/api/headlines`)).json();
  assert.ok(Array.isArray(h.items));
  const f = await (await fetch(`http://localhost:${PORT}/api/fundamentals?id=softs`)).json();
  assert.ok(Array.isArray(f.items));
  assert.equal((await fetch(`http://localhost:${PORT}/api/fundamentals?id=nope`)).status, 404);
});

test('/api/transmission returns cross-asset logic with real triggers', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/transmission`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.error == null, JSON.stringify(j).slice(0, 100));
  assert.ok(Array.isArray(j.ideas));
  for (const i of j.ideas) {
    assert.ok(i.trigger && i.chain, 'each idea needs a trigger + chain');
    assert.ok(Array.isArray(i.segments) && Array.isArray(i.regions));
    assert.ok(j.signals && typeof j.signals === 'object');
  }
});

test('/api/positioning works for any covered market', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/positioning?id=gold`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.error == null && j.latest && typeof j.pct === 'number');
});

test('/api/fx lists chartable currencies', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/fx`);
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.ok(Array.isArray(list) && list.length >= 10);
  assert.ok(list.every((f) => f.id && f.label && typeof f.dp === 'number'));
});

test('chart endpoints accept benchmarks, gaps and currencies', async () => {
  for (const p of ['/api/range?id=wti&range=3m', '/api/range?id=fx:eurusd&range=1y', '/api/longterm?id=fx:usdjpy&years=5', '/api/longterm?id=basis:brent&years=5']) {
    const r = await fetch(`http://localhost:${PORT}${p}`);
    assert.equal(r.status, 200, `${p} -> ${r.status}`);
    const j = await r.json();
    assert.ok(j.error == null, `${p} returned ${JSON.stringify(j).slice(0, 80)}`);
  }
});

test('/api/rates + rate series are chartable (for gold vs real yields)', async () => {
  const rates = await (await fetch(`http://localhost:${PORT}/api/rates`)).json();
  assert.ok(Array.isArray(rates) && rates.length >= 1);
  assert.ok(rates.every((r) => r.id && r.label && typeof r.dp === 'number'));
  const r = await fetch(`http://localhost:${PORT}/api/range?id=rate:real10y&range=6m`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.error, undefined, JSON.stringify(j).slice(0, 100));
  assert.equal(j.kind, 'rate');
  assert.ok(Array.isArray(j.dates) && Array.isArray(j.series.paper));
});

test('/api/seasonal carries a 5-year grade + forward bias', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/seasonal?id=corn`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.error == null, JSON.stringify(j).slice(0, 80));
  assert.ok(j.low && j.high && j.median, 'band present');
  assert.ok(j.grade && typeof j.grade.pos === 'number' && j.grade.label, 'grade present');
  assert.ok('ahead' in j);
});

test('/api/curve carries numeric carry + calendar spreads', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/curve`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.wti && j.wti.contracts, 'wti curve present');
  assert.equal(j.wti.unit, '$/bbl');
  assert.ok(Array.isArray(j.wti.calendar) && j.wti.calendar.length >= 1);
  assert.ok(j.wti.calendar.every((s) => s.from && s.to && typeof s.value === 'number'));
  assert.ok(typeof j.wti.rollMonthly === 'number');
  assert.ok('rollYieldAnn' in j.wti);
});

test('/api/yields returns short + long bond yields (US daily, Japan monthly)', async () => {
  const us = await (await fetch(`http://localhost:${PORT}/api/yields?id=us`)).json();
  assert.ok(us.short && us.long, 'US short + long present');
  assert.equal(us.freq, 'daily');
  assert.ok(typeof us.spread === 'number');
  const jp = await (await fetch(`http://localhost:${PORT}/api/yields?id=jp`)).json();
  assert.ok(jp.short && jp.long, 'Japan short + long present');
  const none = await (await fetch(`http://localhost:${PORT}/api/yields?id=in`)).json();
  assert.ok(none.error, 'India labelled as no free data, not faked');
  assert.equal((await fetch(`http://localhost:${PORT}/api/yields?id=nope`)).status, 404);
});

test('/api/attribution explains the past year with cited news drivers', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/attribution?id=crude`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.error, undefined, JSON.stringify(j).slice(0, 120));
  assert.ok(typeof j.y1 === 'number' || j.y1 === null);
  assert.ok(Array.isArray(j.drivers));
  for (const d of j.drivers) assert.ok(d.kind && d.sample && d.sample.url, 'each driver cites a source');
  assert.equal((await fetch(`http://localhost:${PORT}/api/attribution?id=nope`)).status, 404);
});

test('/api/termstructure returns a curve, 404 for unknown', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/termstructure?id=wti`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.id, 'wti');
  assert.ok(Array.isArray(c.contracts));
  assert.equal((await fetch(`http://localhost:${PORT}/api/termstructure?id=nope`)).status, 404);
});

test('market carries palm oil + per-benchmark curve flags', async () => {
  const m = await (await fetch(`http://localhost:${PORT}/api/market`)).json();
  const palm = m.benchmarks.find((b) => b.id === 'palm');
  assert.ok(palm, 'palm oil present in the registry');
  assert.equal(palm.unit, '$/t');
  assert.equal(palm.curve, false); // no free contract months
  assert.equal(m.benchmarks.find((b) => b.id === 'gold').curve, true);
});

test('/api/market rows carry a source + as-of for the freshness badge', async () => {
  const m = await (await fetch(`http://localhost:${PORT}/api/market`)).json();
  const wti = m.benchmarks.find((b) => b.id === 'wti');
  assert.equal(wti.paperSource, 'Yahoo Finance');
  assert.equal(wti.physicalSource, 'FRED');
  assert.ok(wti.paperDate == null || /^\d{4}-\d{2}-\d{2}$/.test(wti.paperDate));
  assert.equal(m.benchmarks.find((b) => b.id === 'gold').physicalSource, null); // futures-only → no spot to badge
});

test('/api/history carries 1D/1W/1M/YTD/1Y deltas per instrument', async () => {
  const h = await (await fetch(`http://localhost:${PORT}/api/history`)).json();
  assert.ok(h.deltas && h.deltas.wti, 'wti deltas present');
  const d = h.deltas.wti.paper;
  for (const k of ['d1', 'w1', 'm1', 'ytd', 'y1']) assert.ok(k in d, `${k} present`);
  assert.ok(d.asOf == null || /^\d{4}-\d{2}-\d{2}$/.test(d.asOf));
  assert.equal(h.deltas.gold.physical, null); // metals have no free spot series
});

test('unknown chart metric → 404', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/range?id=nope&range=1y`);
  assert.equal(r.status, 404);
});

test('export.csv returns CSV', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/export.csv`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /benchmark,unit/);
});

test('security headers are set on every response', async () => {
  const html = await fetch(`http://localhost:${PORT}/`);
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(html.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(html.headers.get('referrer-policy') || '', /strict-origin/);
  assert.match(html.headers.get('permissions-policy') || '', /geolocation=\(\)/);
  assert.match(html.headers.get('content-security-policy-report-only') || '', /default-src 'self'/);
  const api = await fetch(`http://localhost:${PORT}/api/market`);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
});

test('/api/options returns vol/put-call/skew for a proxy (or a clean error)', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/options?id=gold`);
  assert.equal(r.status, 200);
  const j = await r.json();
  if (!j.error) { assert.equal(j.proxy, 'GLD'); assert.ok('atmIv' in j && 'pcOi' in j && 'skew' in j); }
  assert.equal((await fetch(`http://localhost:${PORT}/api/options?id=soymeal`)).status, 200); // error shape, not 500
});

test('/api/fxadjusted converts returns to a base currency', async () => {
  const usd = await (await fetch(`http://localhost:${PORT}/api/fxadjusted?base=USD`)).json();
  const eur = await (await fetch(`http://localhost:${PORT}/api/fxadjusted?base=EUR`)).json();
  assert.equal(usd.base, 'USD');
  assert.equal(eur.base, 'EUR');
  if (!usd.error && !eur.error) {
    const uw = usd.rows.find((r) => r.id === 'wti');
    const ew = eur.rows.find((r) => r.id === 'wti');
    assert.ok(uw && ew && 'deltas' in uw && 'deltas' in ew, 'per-instrument windows');
  }
  assert.equal((await fetch(`http://localhost:${PORT}/api/fxadjusted?base=XYZ`)).status, 200); // error shape, not 500
});

test('/api/risk returns drawdown, a vol term structure and a correlation matrix', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/risk`);
  assert.equal(r.status, 200);
  const j = await r.json();
  if (!j.error) {
    assert.ok(Array.isArray(j.metrics) && j.metrics.length >= 5, 'a metric per key asset');
    const m = j.metrics.find((x) => x.key === 'wti');
    assert.ok(m && 'drawdown' in m && 'vol' in m && 'w30' in m.vol, 'WTI has drawdown + vol term');
    assert.ok(j.keys.length >= 5 && typeof j.matrix === 'object');
    assert.equal(j.matrix.wti.wti, 1, 'diagonal is 1');
  }
});

test('/api/calendar returns dated upcoming events (FOMC at least)', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/calendar`);
  assert.equal(r.status, 200);
  const j = await r.json();
  if (!j.error) {
    assert.ok(Array.isArray(j.events) && j.events.length >= 3, 'a few upcoming events');
    assert.ok(j.events.some((e) => /FOMC/.test(e.name)), 'FOMC meeting dates are present');
    for (const e of j.events.slice(0, 5)) assert.ok(e.name && (e.date == null || /^\d{4}-\d{2}-\d{2}$/.test(e.date)), 'dated (or explicitly undated)');
  }
});

test('/api/screen returns one row per instrument with scores', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/screen`);
  assert.equal(r.status, 200);
  const j = await r.json();
  if (!j.error) {
    assert.ok(Array.isArray(j.rows) && j.rows.length >= 20, 'ranks the universe');
    const row = j.rows.find((x) => x.id === 'wti');
    assert.ok(row && 'deltas' in row && 'stretch' in row && 'tight' in row && 'posPct' in row, 'WTI row carries deltas + scores');
  }
});

test('/api/regime returns the cross-asset board', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/regime`);
  assert.equal(r.status, 200);
  const j = await r.json();
  if (!j.error) {
    assert.ok(Array.isArray(j.rows) && j.rows.length >= 6, 'at least 6 regime rows');
    const dxy = j.rows.find((x) => x.id === 'dxy');
    assert.ok(dxy && 'price' in dxy && 'deltas' in dxy, 'DXY row has a price + deltas');
    const y = j.rows.find((x) => x.id === 'us10y');
    assert.ok(y && y.rate === true, 'the 10y is flagged as a rate (pp, not %)');
  }
});

test('/api/positioning serves a single series and a per-segment bundle', async () => {
  const one = await (await fetch(`http://localhost:${PORT}/api/positioning?id=wti`)).json();
  assert.equal(one.id, 'wti');
  if (!one.error) { assert.ok(Number.isFinite(one.pct) || one.pct == null); assert.ok('pct3y' in one && 'flag' in one); }
  const seg = await (await fetch(`http://localhost:${PORT}/api/positioning?segment=crude`)).json();
  assert.equal(seg.segment, 'crude');
  if (!seg.error) assert.ok(Array.isArray(seg.items));
  assert.equal((await fetch(`http://localhost:${PORT}/api/positioning?segment=nope`)).status, 200); // error shape, not a 500
});

test('/health reports a build version', async () => {
  const j = await (await fetch(`http://localhost:${PORT}/health`)).json();
  assert.equal(j.ok, true);
  assert.ok(j.version, 'a build version is present');
});

test('text assets are gzipped when the client accepts it (and decode cleanly)', async () => {
  const res = await new Promise((resolve) => {
    http.get({ host: 'localhost', port: PORT, path: '/app.js', headers: { 'accept-encoding': 'gzip' } }, resolve);
  });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.match(res.headers.vary || '', /accept-encoding/i);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const body = zlib.gunzipSync(Buffer.concat(chunks)).toString();
  assert.match(body, /tickerStart/, 'the gzip stream decodes to the real script');
});
