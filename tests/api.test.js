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
  assert.match(await r.text(), /COMMODITY DESK/);
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

test('/api/news returns headlines for segments and macro regions (graceful if unavailable)', async () => {
  for (const id of ['crude', 'us', 'eu', 'jp', 'apac']) {
    const r = await fetch(`http://localhost:${PORT}/api/news?id=${id}`);
    assert.equal(r.status, 200, `${id} -> ${r.status}`);
    const j = await r.json();
    assert.ok(Array.isArray(j.items), `${id}: items must be an array`);
  }
  assert.equal((await fetch(`http://localhost:${PORT}/api/news?id=nope`)).status, 404);
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

test('unknown chart metric → 404', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/range?id=nope&range=1y`);
  assert.equal(r.status, 404);
});

test('export.csv returns CSV', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/export.csv`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /benchmark,unit/);
});
