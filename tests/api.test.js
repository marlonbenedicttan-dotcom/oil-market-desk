import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const PORT = 4999;
let child;

before(async () => {
  child = spawn('node', [BIN], { env: { ...process.env, PORT: String(PORT), NOTIFY: 'off' }, stdio: 'ignore' });
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
  assert.match(html, /COMMODITY DESK/);
  assert.match(html, /data-pane="home"/);   // watchlist + alerts home screen
  assert.match(html, /id="home-watch"/);
});

test('pure endpoints always respond 200', async () => {
  for (const p of ['/api/chokepoints', '/api/reroute', '/api/flows']) {
    const r = await fetch(`http://localhost:${PORT}${p}`);
    assert.equal(r.status, 200, `${p} -> ${r.status}`);
    await r.json(); // must be valid JSON
  }
});

// Data endpoints depend on external APIs — assert the server responds without crashing.
for (const p of ['/api/market', '/api/curve', '/api/tightness', '/api/products', '/api/analytics', '/api/inventories', '/api/positioning', '/api/equities', '/api/flares', '/api/sar']) {
  test(`GET ${p} responds`, async () => {
    const r = await fetch(`http://localhost:${PORT}${p}`);
    assert.ok([200, 500].includes(r.status), `${p} -> ${r.status}`);
  });
}

test('/api/alerts returns the server alert engine output', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/alerts`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.current), 'current must be an array');
  for (const a of j.current) assert.ok(a.key && a.level && a.text, 'each alert needs key + level + text');
});

test('/api/markets groups benchmarks into 7 segments (WTI+Brent=Crude, fuels=Refined)', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/markets`);
  assert.equal(r.status, 200);
  const ms = await r.json();
  assert.equal(ms.length, 7);
  const crude = ms.find((m) => m.id === 'crude');
  assert.deepEqual(crude.components.map((c) => c.id), ['wti', 'brent']);
  assert.equal(crude.hasBasis, true);
  assert.deepEqual(ms.find((m) => m.id === 'refined').components.map((c) => c.id), ['rbob', 'ulsd', 'jet', 'propane']);
  assert.equal(ms.find((m) => m.id === 'precious').components.length, 4);
  assert.equal(ms.find((m) => m.id === 'grains').hasBasis, false);
  assert.ok(ms.every((m) => m.primary && m.hasCOT));
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

test('/api/marketread splits price stretch from physical tightness', async () => {
  const crude = await (await fetch(`http://localhost:${PORT}/api/marketread?id=crude`)).json();
  assert.ok(crude.verdict.priceStretch && typeof crude.verdict.priceStretch.score !== 'undefined');
  assert.ok(crude.verdict.physical && typeof crude.verdict.physical === 'object');
  assert.ok('score' in crude.verdict.physical && Array.isArray(crude.verdict.physical.parts));
  assert.ok(typeof crude.verdict.physical.note === 'string' && crude.verdict.physical.note.length > 0);
  // grains have no free basis or inventories → never a basis component
  const grains = await (await fetch(`http://localhost:${PORT}/api/marketread?id=grains`)).json();
  assert.ok(grains.verdict.physical.parts.every((p) => p.key !== 'basis'));
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
