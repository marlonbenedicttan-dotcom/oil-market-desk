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
