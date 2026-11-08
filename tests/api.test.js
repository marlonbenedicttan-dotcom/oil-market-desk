import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priorityOf } from '../src/lib.js';

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
  assert.match(html, /data-pane="home"/);   // watchlist + brief home screen
  assert.match(html, /id="home-watch"/);
  assert.match(html, /id="headlines"/);     // live headlines board now lives in HOME
  assert.match(html, /id="regime-board"/);  // cross-asset backdrop (INVESTOR #2)
  assert.match(html, /id="screen"/);        // screener (INVESTOR #3)
  assert.match(html, /id="relval"/);        // curated spreads (COMMODITIES)
  assert.doesNotMatch(html, /class="hero"/); // ...not pinned to the top of every page
  // Retired from the UI (kept only as endpoints): the HOME alerts panel, its subscribe form,
  // and the header's EXPORT CSV / DAILY BRIEF buttons.
  assert.doesNotMatch(html, /id="p-alerts"/);
  assert.doesNotMatch(html, /id="home-rules"/);
  assert.doesNotMatch(html, /id="subscribe"/);
  assert.doesNotMatch(html, /api\/export\.csv">EXPORT CSV/);
  assert.doesNotMatch(html, /href="\/api\/digest"/);
});

test('/api/relvalue returns a curated spread with its own percentile, and nothing for an unknown segment', async () => {
  const d = await (await fetch(`http://localhost:${PORT}/api/relvalue?segment=crude`)).json();
  assert.equal(d.segment, 'crude');
  assert.equal(d.label, 'Crude oil');
  assert.ok(Array.isArray(d.rows), 'rows is an array');
  assert.ok(d.rows.length >= 1, 'crude has its Brent-WTI spread');
  const row = d.rows[0];
  assert.equal(row.id, 'brent_wti');
  assert.ok(row.label && row.unit, 'a spread carries its label and unit');
  assert.equal(typeof row.obs, 'number');
  if (row.last != null) assert.ok(Number.isFinite(row.last));
  if (row.pct != null) assert.ok(row.pct >= 0 && row.pct <= 100, `percentile in range (got ${row.pct})`);
  assert.ok(!('history' in row), 'the full history is stripped from the response');
  const none = await (await fetch(`http://localhost:${PORT}/api/relvalue?segment=not-a-segment`)).json();
  assert.deepEqual(none.rows, []);
});

test('/api/segmentscore gives every component its own scores and deltas', async () => {
  const d = await (await fetch(`http://localhost:${PORT}/api/segmentscore?segment=crude`)).json();
  assert.equal(d.segment, 'crude');
  assert.equal(d.label, 'Crude oil');
  assert.deepEqual(d.rows.map((r) => r.id), ['wti', 'brent'], 'the segment keeps its component order');
  for (const r of d.rows) {
    assert.ok(r.label && r.unit, 'a row carries its label and unit');
    assert.equal(typeof r.deltas, 'object');
    if (r.stretch != null) assert.ok(r.stretch >= -100 && r.stretch <= 100, `stretch in range (got ${r.stretch})`);
    if (r.tight != null) assert.ok(r.tight >= 0 && r.tight <= 100, `tight in range (got ${r.tight})`);
    if (r.posPct != null) assert.ok(r.posPct >= 0 && r.posPct <= 100, `COT percentile in range (got ${r.posPct})`);
  }
  const none = await (await fetch(`http://localhost:${PORT}/api/segmentscore?segment=not-a-segment`)).json();
  assert.deepEqual(none.rows, []);
});

test('/api/calendar spans every macro country, with consensus where published', async () => {
  const c = await (await fetch(`http://localhost:${PORT}/api/calendar`)).json();
  const ev = c.events || [];
  assert.ok(Array.isArray(ev) && ev.length, 'calendar has events');
  const world = ev.filter((e) => e.cc);
  assert.ok(world.length >= 20, `cross-country releases present (got ${world.length})`);
  const countries = new Set(world.map((e) => e.cc));
  assert.ok(countries.size >= 15, `many countries represented (got ${countries.size})`);
  for (const e of world.slice(0, 12)) {
    assert.ok(e.name && e.date, 'every country release has a name + date');
    assert.ok(e.country && e.country !== e.cc, 'and a readable country name');
    assert.ok(/TradingView/.test(e.source || ''), 'sourced to TradingView');
  }
  // The old panel claimed there was no free consensus; the feed publishes forecast/previous.
  assert.ok(world.some((e) => /consensus|prior/.test(e.note || '')), 'consensus/prior appears where published');
  // Structural events must survive alongside them.
  assert.ok(ev.some((e) => /EIA|WASDE|FOMC|expiry/i.test(e.name)), 'the structural calendar is still there');
});

test('/api/brief covers macro, not just commodities', async () => {
  const b = await (await fetch(`http://localhost:${PORT}/api/brief`)).json();
  assert.ok(b.headline, 'brief headline');
  assert.ok(Array.isArray(b.happened) && b.happened.length, 'commodities section');
  assert.ok(Array.isArray(b.macro), 'a macro section exists (empty is fine on a quiet day)');
  for (const m of b.macro) {
    assert.ok(m.label && m.route && /^#\/macro\//.test(m.route), 'macro move carries a country deep link');
    assert.ok(m.text && typeof m.d1 === 'number', 'macro move has text + a move');
    assert.ok(['index', 'fx'].includes(m.kind), 'macro move is an index or a currency');
    if (m.why) assert.ok(/^https?:/.test(m.why.url || ''), 'the explaining headline links to its source');
    assert.notEqual(m.kind, undefined);
  }
  // A pegged Gulf currency must never appear as a macro "move" (it reports no moves at all).
  assert.ok(!b.macro.some((m) => m.kind === 'fx' && ['sa', 'ae', 'qa'].includes(m.id)), 'pegged currencies never show as movers');
});

test('pure endpoints always respond 200', async () => {
  for (const p of ['/api/markets', '/api/fx', '/api/countries']) {
    const r = await fetch(`http://localhost:${PORT}${p}`);
    assert.equal(r.status, 200, `${p} -> ${r.status}`);
    await r.json(); // must be valid JSON
  }
});

// Data endpoints depend on external APIs — assert the server responds without crashing.
const ENDPOINTS = [
  { p: '/api/market' }, { p: '/api/curve' }, { p: '/api/tightness' }, { p: '/api/products' },
  { p: '/api/analytics' }, { p: '/api/inventories' }, { p: '/api/positioning' }, { p: '/api/equities' },
];
for (const { p } of ENDPOINTS) {
  test(`GET ${p} responds`, async () => {
    const r = await fetch(`http://localhost:${PORT}${p}`);
    assert.ok([200, 500].includes(r.status), `${p} -> ${r.status}`);
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
  assert.ok(Array.isArray(j.events), 'the brief carries an event-first layer');
  assert.ok(j.events.every((e) => e.what && e.label && Array.isArray(e.sources)));
});

test('/api/brief ranks one leaderboard and explains every row', async () => {
  const b = await (await fetch(`http://localhost:${PORT}/api/brief`)).json();
  const rows = b.rows || [];
  assert.ok(rows.length <= 7, 'the brief lists at most seven rows under the hero (moves + deals)');
  if (b.hero) {
    assert.ok(Array.isArray(b.hero.facts) && b.hero.facts.length > 0, 'the hero always carries a computed line');
    assert.ok(['bench', 'index', 'fx'].includes(b.hero.srcKind), 'the hero knows what kind of market it is');
    assert.ok(priorityOf(b.hero) < 3, `the hero cannot be a thin market (${b.hero.label})`);
  }
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // A fresh deal can be a rumour with no disclosed price — it still belongs on the brief if both
    // parties are named. Freshness, not price, is what admits a deal now.
    assert.ok(r.label && (r.kind === 'deal'
      ? (typeof r.value === 'number' || (r.acquirer && r.target))
      : typeof r.d1 === 'number'),
      'each row is a real move or a named deal');
    // A deal row is explained by its price and status; a move row by a wire story or computed driver.
    const explained = r.kind === 'deal'
      ? (r.value != null || r.status)
      : ((r.why && /^https?:/.test(r.why.url || '')) || (r.facts && r.facts.length));
    assert.ok(explained, `${r.label} must carry an explanation — never a bare number`);
    assert.ok(!ids.has(r.id), 'the same instrument never appears twice');
    ids.add(r.id);
    if (r.kind !== 'deal') assert.ok(priorityOf(r) < 3, `${r.label} is thin and cannot appear on a price move alone`);
    if (i) {
      // Bands come first, the score orders inside a band. A core market with a smaller move still
      // outranks a thin one with a bigger print; deals trail the move rows.
      const tierOf = (x) => (x.kind === 'deal' ? 9 : priorityOf(x));
      const prev = rows[i - 1], cur = r;
      assert.ok(tierOf(prev) < tierOf(cur)
        || (tierOf(prev) === tierOf(cur) && (prev.score ?? 0) >= (cur.score ?? 0)),
        'rows stay in priority then rank order');
    }
  }
  for (const e of b.events || []) {
    assert.ok(e.key && e.label && e.what, 'an event says what happened');
    assert.ok(Array.isArray(e.market), 'market evidence is a list');
    assert.ok(e.why || e.mechanism || /wire coverage/.test(e.what), 'an event carries a reason or says it has none');
    if (e.primary && e.primary.kind === 'bench') {
      assert.ok(priorityOf(e.primary.id) < 3 || e.corroboration >= 2 || e.confirmed,
        `${e.what} is a thin market and needs proof`);
    }
  }
});

test('/api/deals returns a deal store with a lifecycle and evidence', async () => {
  const d = await (await fetch(`http://localhost:${PORT}/api/deals`)).json();
  assert.ok(Array.isArray(d.deals), 'deals is an array');
  const ids = new Set();
  for (const x of d.deals) {
    assert.ok(x.target || x.acquirer, 'every deal names at least one side');
    assert.ok(['rumour', 'announced', 'closed', 'terminated'].includes(x.status), 'status is one of the lifecycle states');
    assert.ok(typeof x.verified === 'boolean', 'verification is a flag, not a status');
    assert.ok(Array.isArray(x.events) && x.events.length >= 1, 'a deal carries at least one event');
    for (const e of x.events) assert.ok(e.date && e.title, 'events are dated and titled');
    assert.ok(!ids.has(x.key), 'a deal appears once, not once per headline');
    ids.add(x.key);
    if (x.verified) assert.ok(/^https?:/.test(x.url || ''), 'a verified deal links to its filing');
  }
  assert.ok(Array.isArray(d.sectors));
  assert.ok(d.log && typeof d.log.count === 'number');
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
  assert.deepEqual(ms.find((m) => m.id === 'grains').components.map((c) => c.id), ['corn', 'wheat', 'soybean', 'soymeal', 'soyoil', 'rice']);
  // nickel is gone (no free daily source); the industrial segment carries the metals plus the steel chain
  assert.deepEqual(ms.find((m) => m.id === 'industrial').components.map((c) => c.id), ['copper', 'aluminium', 'ironore', 'steel']);
  assert.deepEqual(ms.find((m) => m.id === 'softs').components.map((c) => c.id), ['sugar', 'coffee', 'cocoa', 'cotton', 'palm', 'orange']);
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
  for (const r of ['us', 'eu', 'jp', 'cn', 'in', 'apac', 'me', 'af']) assert.ok(c[r] && c[r].length, `region ${r}`);
  assert.equal(c.me.length, 3);   // Saudi Arabia, UAE, Qatar
  assert.equal(c.af.length, 3);   // South Africa, Nigeria, Kenya
  assert.equal(c.us.length, 5);   // United States, Mexico, Brazil, Argentina, Venezuela
  // Argentina: real MERVAL, Pampas commodity links, and NO stale policy rate (BIS stops in Jul 2025).
  const arg = await (await fetch(`http://localhost:${PORT}/api/country?id=ar`)).json();
  assert.equal(arg.index.label, 'MERVAL');
  assert.ok(arg.index.price > 0, 'the MERVAL quotes');
  assert.ok(arg.links.some((l) => l.commodity === 'Soybeans'), 'Argentina links to soybeans');
  assert.equal(arg.policy, null, 'no policy rate is shown');
  assert.match(arg.policyNote || '', /July 2025|stops/i, 'and it says why (the BIS series is stale)');
  // Mexico: a real index (S&P/BMV IPC), Banxico's rate, and the peso's crude/silver links.
  const mex = await (await fetch(`http://localhost:${PORT}/api/country?id=mx`)).json();
  assert.equal(mex.index.label, 'S&P/BMV IPC');
  assert.ok(mex.index.price > 0, 'the IPC quotes');
  assert.ok(mex.policy && mex.policy.latest.value > 0, 'Mexico carries its Banxico policy rate (BIS)');
  assert.ok(mex.links.some((l) => l.commodity === 'Silver'), 'Mexico links to silver');
  assert.ok(mex.links.some((l) => l.commodity === 'WTI crude'), 'and to crude');
  // Brazil has a REAL index (Ibovespa), not an ETF proxy — and it must be chartable.
  const bra = await (await fetch(`http://localhost:${PORT}/api/country?id=br`)).json();
  assert.equal(bra.label, 'Brazil');
  assert.equal(bra.index.label, 'Ibovespa');
  assert.ok(bra.index.price > 0, 'Ibovespa quotes');
  assert.ok(bra.policy && bra.policy.latest.value > 0, 'Brazil carries its Selic (BIS)');
  assert.ok(bra.links.some((l) => l.commodity === 'Soybeans'), 'Brazil links to soybeans');
  // Venezuela has no ETF and no usable index (IBC.CR returns a single point) — declared, not faked.
  const ven = await (await fetch(`http://localhost:${PORT}/api/country?id=ve`)).json();
  assert.equal(ven.index.price, null);
  assert.equal(ven.index.label, null);
  assert.match(ven.policyNote || '', /BCV|parallel/i, 'Venezuela explains the controlled FX rate');
  assert.ok(ven.fund.inflation.value > 100, 'Venezuela reports its (hyper)inflation honestly');
  const idn = await (await fetch(`http://localhost:${PORT}/api/country?id=id`)).json();
  assert.equal(idn.label, 'Indonesia');
  assert.ok(idn.fx && idn.index && idn.fund && Array.isArray(idn.fund.gdpGrowth));
  assert.equal(idn.fx.source, 'Yahoo Finance');
  assert.ok(idn.fx.deltas && 'd1' in idn.fx.deltas, 'country fx carries multi-horizon deltas');
  assert.ok(idn.fund.debtToGdp && idn.fund.debtToGdp.year >= 2018, 'debt/GDP is current (IMF WEO), not a stale year');
  assert.equal((await fetch(`http://localhost:${PORT}/api/country?id=nope`)).status, 404);
  // Nigeria has no free equity line (no Yahoo index, no surviving ETF) — it must be declared, not faked.
  const nga = await (await fetch(`http://localhost:${PORT}/api/country?id=ng`)).json();
  assert.equal(nga.label, 'Nigeria');
  assert.equal(nga.index.price, null);
  assert.equal(nga.index.label, null);
  assert.ok(nga.fund.gdpGrowth.length, 'Nigeria still carries IMF annual macro');
  assert.ok(nga.fx.price, 'Nigeria carries a live FX quote');
  // A pegged Gulf currency is reported as a peg, never as a meaningless commodity correlation.
  const sau = await (await fetch(`http://localhost:${PORT}/api/country?id=sa`)).json();
  assert.ok(sau.takeaways.some((x) => /pegged to the US dollar/.test(x)), 'Saudi: the peg is stated');
  assert.ok(!sau.links.length, 'Saudi: no commodity-correlation rows for a pegged currency');
  assert.ok(sau.peg, 'Saudi carries its peg');
  assert.deepEqual(sau.fx.deltas, {}, 'a pegged currency reports no % moves (the upstream series has bad ticks)');
  assert.equal(sau.fx.pct, null, 'and no daily % either');
  assert.ok(sau.fx.price, 'but it still reports the level');
  const qat = await (await fetch(`http://localhost:${PORT}/api/country?id=qa`)).json();
  assert.equal(qat.policy, null);
  assert.match(qat.policyNote || '', /peg/i);   // and it says WHY there is no policy rate
  const zaf = await (await fetch(`http://localhost:${PORT}/api/country?id=za`)).json();
  assert.ok(zaf.links.some((l) => l.commodity === 'Gold'), 'South Africa links to gold');
  const mt = await (await fetch(`http://localhost:${PORT}/api/region-quotes?id=apac`)).json();
  assert.ok(Array.isArray(mt.items) && mt.items.length >= 8);   // currencies (and indices where free)
  assert.ok(mt.items.some((i) => i.deltas && 'd1' in i.deltas), 'region currencies carry deltas');
  // A pegged currency reports its level and NO moves — on every path that publishes a quote, not just
  // the country card (the Gulf tape and region board leaked a fake +3.3% before this).
  const gulf = await (await fetch(`http://localhost:${PORT}/api/region-quotes?id=me`)).json();
  assert.equal(gulf.items.length, 6, 'Gulf region: 3 currencies + 3 equity proxies');
  for (const it of gulf.items.filter((i) => i.kind === 'fx')) {
    assert.equal(it.pct, null, `${it.label} must not report a daily % (pegged)`);
    assert.deepEqual(it.deltas, {}, `${it.label} must not report multi-horizon moves (pegged)`);
    assert.ok(it.price > 3 && it.price < 4, `${it.label} still reports its level`);
  }
  assert.ok(gulf.items.filter((i) => i.kind === 'index').every((i) => i.price > 0), 'the Gulf equity proxies still quote');
  // and the new currencies are chartable + offered in the currency dropdown
  // Country news must come from a tier-1 wire — Nigeria/Kenya used to fill with content farms
  // (UA.NEWS, nigeriahousingmarket.com) because only the segment news required tier-1.
  const TIER1 = /reuters|bloomberg|financial times|ft\.com|ap news|associated press|cnbc|wsj|wall street journal/i;
  for (const id of ['ng', 'ke', 'qa', 'sa']) {
    const nw = await (await fetch(`http://localhost:${PORT}/api/macro-news?id=${id}`)).json();
    assert.ok(Array.isArray(nw.items), `${id} news payload`);
    for (const it of nw.items) assert.ok(TIER1.test(it.source || ''), `${id} headline from a real wire (got "${it.source}")`);
  }
  const fxl = await (await fetch(`http://localhost:${PORT}/api/fx`)).json();
  for (const id of ['usdsar', 'usdaed', 'usdqar', 'usdngn', 'usdkes', 'usdzar']) {
    assert.ok(fxl.some((f) => f.id === id), `${id} is chartable`);
  }
  // The card carries its news + chart series so a country switch no longer fires two extra requests.
  assert.ok(Array.isArray(arg.news && arg.news.items), 'country payload carries its news items');
  assert.ok(Array.isArray(arg.series && arg.series.dates) && arg.series.dates.length, 'country payload carries the chart series');
  // The two slow, independent feeds arrive together from one endpoint.
  const extras = await (await fetch(`http://localhost:${PORT}/api/country-extras?id=us`)).json();
  assert.equal(extras.id, 'us');
  assert.ok(extras.yields && extras.yields.long, 'extras carry bond yields');
  assert.ok(Array.isArray(extras.catalysts && extras.catalysts.events), 'extras carry the release calendar');
  assert.equal((await fetch(`http://localhost:${PORT}/api/country-extras?id=nope`)).status, 404);
});

test('/api/headlines + /api/fundamentals respond', async () => {
  const h = await (await fetch(`http://localhost:${PORT}/api/headlines`)).json();
  assert.ok(Array.isArray(h.items));
  const f = await (await fetch(`http://localhost:${PORT}/api/fundamentals?id=softs`)).json();
  assert.ok(Array.isArray(f.items));
  assert.equal((await fetch(`http://localhost:${PORT}/api/fundamentals?id=nope`)).status, 404);
});

test('/api/transmission returns cross-asset logic with real triggers', async (t) => {
  const j = await softGet(t, '/api/transmission');
  if (!j) return;
  assert.ok(j.error == null, JSON.stringify(j).slice(0, 100));
  assert.ok(Array.isArray(j.ideas));
  for (const i of j.ideas) {
    assert.ok(i.trigger && i.chain, 'each idea needs a trigger + chain');
    assert.ok(Array.isArray(i.segments) && Array.isArray(i.regions));
    assert.ok(j.signals && typeof j.signals === 'object');
  }
});

// These endpoints fetch from live feeds (CFTC, Yahoo, news wires). A feed outage is not a defect here,
// so retry once and then skip with the reason rather than failing the build — a false alarm trains you
// to ignore the one that matters.
const UPSTREAM = /fetch failed|network|timeout|ETIMEDOUT|ECONN|ENOTFOUND|\b429\b|\b50[234]\b|unavailable|rate limit|socket hang up/i;
async function softGet(t, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`http://localhost:${PORT}${path}`);
    assert.equal(r.status, 200, `${path} -> ${r.status}`);
    const j = await r.json();
    if (!j.error) return j;
    if (!UPSTREAM.test(String(j.error))) return j;     // a real defect: let the assertion below fail
    if (attempt === 0) { await new Promise((res) => setTimeout(res, 2000)); continue; }
    t.diagnostic(`${path}: ${j.error}`);
    t.skip('upstream feed unavailable');
    return null;
  }
  return null;
}

test('/api/positioning works for any covered market', async (t) => {
  const j = await softGet(t, '/api/positioning?id=gold');
  if (!j) return;
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
  // FRED (the only free source for non-US curves) has outages; then the endpoint must SAY so rather
  // than pretend. When it is up, both tenors must be there.
  if (jp.short && jp.long) assert.ok(jp.long.latest > jp.short.latest - 5, 'Japan curve is plausible');
  else assert.match(String(jp.note || ''), /unavailable/i, 'a missing feed is named, not hidden');
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
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
  assert.match(html.headers.get('referrer-policy') || '', /strict-origin/);
  assert.match(html.headers.get('permissions-policy') || '', /geolocation=\(\)/);
  assert.equal(html.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(html.headers.get('cross-origin-resource-policy'), 'same-origin');
  // Enforced, not report-only, and the inline shell script is pinned by hash rather than
  // 'unsafe-inline' — otherwise the policy would wave through any injected script.
  const csp = html.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(csp.split(';').find((x) => /script-src/.test(x)) || '', /unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(html.headers.get('content-security-policy-report-only'), null);
  const api = await fetch(`http://localhost:${PORT}/api/market`);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
});

test('the API rate-limits a caller that hammers it', async () => {
  const ip = '198.51.100.7';                 // TEST-NET-2: a real address to the limiter, nobody's
  let last = null;
  for (let i = 0; i < 150; i++) {
    last = await fetch(`http://localhost:${PORT}/api/fx`, { headers: { 'x-forwarded-for': ip } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, 'a burst past the bucket is refused');
  assert.ok(Number(last.headers.get('retry-after')) >= 1, 'and says when to come back');
  // Local traffic is exempt, so the rest of the suite is never throttled by this test.
  assert.equal((await fetch(`http://localhost:${PORT}/api/fx`)).status, 200);
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
    assert.ok('drawdownNow' in m && 'volPct' in m && 'volVsOwn' in m && 'level' in m, 'current risk + own-history baseline');
    assert.ok(j.keys.length >= 5 && typeof j.matrix === 'object');
    assert.equal(j.matrix.wti.wti, 1, 'diagonal is 1');
    assert.ok(typeof j.matrix3m === 'object' && j.matrix3m.wti.wti === 1, 'a 3-month matrix alongside the year');
    assert.ok(j.groups3m && Array.isArray(j.groups3m.together) && Array.isArray(j.groups3m.opposite) && Array.isArray(j.groups3m.loose), 'pairs grouped by decision');
    assert.match(j.read, /below its 1-year high|closest to its 1-year high|worst fall this year/);
    assert.doesNotMatch(j.read, /Wildest here/);
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
  if (!one.error) {
    assert.ok(Number.isFinite(one.pct) || one.pct == null);
    assert.ok('pct3y' in one && 'flag' in one);
    assert.ok(Array.isArray(one.history) && one.history.length > 10, 'weekly history for the chart');
    assert.ok(one.history.filter((r) => r.price != null).length > 5, 'price aligned to the weekly reports');
    assert.ok(one.priceLabel && one.priceUnit, 'the price axis is labelled');
  }
  const seg = await (await fetch(`http://localhost:${PORT}/api/positioning?segment=crude`)).json();
  assert.equal(seg.segment, 'crude');
  if (!seg.error) assert.ok(Array.isArray(seg.items));
  assert.equal((await fetch(`http://localhost:${PORT}/api/positioning?segment=nope`)).status, 200); // error shape, not a 500
});

test('/api/positioning uses current CFTC contract names, not legacy series', async (t) => {
  for (const id of ['natgas', 'brent', 'copper']) {
    const j = await (await fetch(`http://localhost:${PORT}/api/positioning?id=${id}`)).json();
    if (j.error) return t.skip(`${id}: CFTC unavailable`);
    assert.ok(j.latest && j.latest.date >= '2025-01-01', `${id} latest report is ${j.latest && j.latest.date}`);
  }
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

// --- search and compare -------------------------------------------------------------------------
// The compare box takes a company name; the server has to turn that into a chartable ref.
test('search resolves a company name to a market ref', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/search?q=jpmorgan`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.results.length, 'no results for a company that definitely exists');
  assert.equal(d.results[0].ref, 'us:JPM');
});

test('search prefers the biggest company when several share a name', async () => {
  const d = await (await fetch(`http://localhost:${PORT}/api/search?q=samsung&limit=3`)).json();
  assert.equal(d.results[0].ref, 'kr:005930', `got ${d.results[0] && d.results[0].ref}`);
});

test('search matches several words across the name and the exchange short name', async () => {
  const d = await (await fetch(`http://localhost:${PORT}/api/search?q=shk%20properties&limit=3`)).json();
  assert.ok(d.results.length, 'SHK Properties has no result');
  assert.equal(d.results[0].ref, 'hk:0016', `got ${d.results[0] && d.results[0].ref}`);
});

test('search spans all three markets', async () => {
  const d = await (await fetch(`http://localhost:${PORT}/api/search?q=toyota&limit=3`)).json();
  assert.ok(d.results.some((x) => x.market === 'jp'), 'Japan missing from the search index');
  assert.equal(d.results[0].ref, 'jp:7203');
});

test('a Japanese chart answers to both the ticker and the five-digit code', async () => {
  const byTicker = await (await fetch(`http://localhost:${PORT}/api/japan-chart?code=7203&range=1y`)).json();
  const byCode = await (await fetch(`http://localhost:${PORT}/api/japan-chart?code=72030&range=1y`)).json();
  assert.ok(byTicker.dates.length > 40, `ticker form returned ${byTicker.dates.length} points`);
  assert.deepEqual(byTicker.dates, byCode.dates);
});

// KOSPI's list is the slowest market to open, and the reason is the source file: korea.json carries
// five years of daily closes per company (~24 MB of its 28 MB). The list endpoint must keep shipping
// the projection only, and must stay revalidatable, or every KOREA click pays for the whole file.
test('/api/taiwan ships the list projection, not the price history, and revalidates', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/taiwan`);
  assert.equal(r.status, 200);
  const etag = r.headers.get('etag');
  assert.ok(etag, 'the Taiwan list must carry an ETag');
  const d = await r.json();
  assert.ok(d.companies.length > 900, `got ${d.companies.length} companies`);
  assert.ok(d.index && d.index.level != null, 'the TAIEX level is missing');
  const tsmc = d.companies.find((x) => x.ticker === '2330');
  assert.ok(tsmc && tsmc.nameEn, 'TSMC is missing from the list');
  assert.equal(tsmc.series, undefined, 'the list must not carry per-company price history');
  assert.ok(JSON.stringify(d).length < 2_000_000, 'the Taiwan list payload ballooned');
  const again = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: '/api/taiwan', headers: { 'if-none-match': etag }, agent: false }, resolve).on('error', reject);
  });
  assert.equal(again.statusCode, 304);
  again.resume();
});

test('/api/taiwan/company carries as-reported periods and five years of history', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/taiwan/company/2330`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.sector, 'Semiconductors');
  assert.ok(c.reports && c.reports.ttm && c.reports.ttm.revenue > 0, 'TTM revenue is missing');
  assert.ok(c.history.length >= 5, 'five fiscal years are missing');
  assert.ok(c.quarters.length >= 4, 'the quarterly table is missing');
  assert.ok(c.marketCap === c.price * (c.sharesCurrent ?? c.shares), 'market cap does not reconcile');
});

test('/api/taiwan/chart serves the range it was asked for', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/taiwan/chart?code=2330&range=5y`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.dates.length > 200, `got ${d.dates.length} points`);
  assert.equal(d.dates.length, d.closes.length);
  for (let i = 1; i < d.dates.length; i++) assert.ok(d.dates[i] > d.dates[i - 1]);
});

test('/api/hongkong ships the list projection, not the price history, and revalidates', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/hongkong`);
  assert.equal(r.status, 200);
  const etag = r.headers.get('etag');
  assert.ok(etag, 'the Hong Kong list must carry an ETag');
  const d = await r.json();
  assert.ok(d.companies.length > 1000, `got ${d.companies.length} companies`);
  assert.ok(d.index && d.index.level != null, 'the Hang Seng level is missing');
  assert.ok(d.fx && d.fx.rate > 7, 'the USD/HKD rate is missing — the ratios need it');
  const tencent = d.companies.find((x) => x.ticker === '0700');
  assert.ok(tencent && tencent.nameEn, 'Tencent is missing from the list');
  assert.equal(tencent.reportCurrency, 'CNY', 'Tencent reports in CNY, and the list must say so');
  assert.equal(tencent.series, undefined, 'the list must not carry per-company price history');
  assert.ok(JSON.stringify(d).length < 3_000_000, 'the Hong Kong list payload ballooned');
  const again = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: '/api/hongkong', headers: { 'if-none-match': etag }, agent: false }, resolve).on('error', reject);
  });
  assert.equal(again.statusCode, 304);
  again.resume();
});

test('/api/hongkong/company values a foreign-currency reporter in its own currency', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/hongkong/company/0700`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.ok(c.sector, 'the sector is missing');
  assert.equal(c.reportCurrency, 'CNY');
  assert.ok(c.reports && c.reports.ttm && c.reports.ttm.revenue > 0, 'TTM revenue is missing');
  assert.ok(c.history.length >= 3, 'the fiscal-year record is missing');
  assert.ok(c.marketCap === c.price * (c.sharesCurrent ?? c.shares), 'market cap does not reconcile');
  if (c.pe != null) {
    const conv = 6.6 / 7.8;   // CNY per HKD: the cap is HKD, the profit is CNY
    const want = +(c.marketCap * conv / c.reports.ttm.netIncome).toFixed(2);
    assert.ok(Math.abs(want - c.pe) < 0.2, `P/E ${c.pe} is not cap-in-CNY ÷ profit`);
  }
});

test('/api/hongkong/chart serves the range it was asked for', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/hongkong/chart?code=0700&range=5y`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.dates.length > 200, `got ${d.dates.length} points`);
  assert.equal(d.dates.length, d.closes.length);
  for (let i = 1; i < d.dates.length; i++) assert.ok(d.dates[i] > d.dates[i - 1]);
});

test('/api/australia ships the list projection, not the price history, and revalidates', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/australia`);
  assert.equal(r.status, 200);
  const etag = r.headers.get('etag');
  assert.ok(etag, 'the Australia list must carry an ETag');
  const d = await r.json();
  assert.ok(d.companies.length > 1000, `got ${d.companies.length} companies`);
  assert.ok(d.index && d.index.level != null, 'the ASX 200 level is missing');
  assert.ok(d.fx && d.fx.rate > 1, 'the USD/AUD rate is missing — the ratios need it');
  const bhp = d.companies.find((x) => x.ticker === 'BHP');
  assert.ok(bhp && bhp.nameEn, 'BHP is missing from the list');
  assert.equal(bhp.reportCurrency, 'USD', 'BHP reports in USD, and the list must say so');
  assert.equal(bhp.series, undefined, 'the list must not carry per-company price history');
  assert.ok(JSON.stringify(d).length < 3_000_000, 'the Australia list payload ballooned');
  const again = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: '/api/australia', headers: { 'if-none-match': etag }, agent: false }, resolve).on('error', reject);
  });
  assert.equal(again.statusCode, 304);
  again.resume();
});

test('/api/australia/company values a USD reporter in USD', async () => {
  const list = await (await fetch(`http://localhost:${PORT}/api/australia`)).json();
  const r = await fetch(`http://localhost:${PORT}/api/australia/company/BHP`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.ok(c.sector, 'the sector is missing');
  assert.equal(c.reportCurrency, 'USD');
  assert.ok(c.reports && c.reports.ttm && c.reports.ttm.revenue > 0, 'TTM revenue is missing');
  assert.ok(c.history.length >= 3, 'the fiscal-year record is missing');
  assert.ok(c.marketCap === c.price * (c.sharesCurrent ?? c.shares), 'market cap does not reconcile');
  if (c.pe != null) {
    const usdPerAud = 1 / list.fx.rate;   // the cap is AUD; the profit is USD
    const want = +(c.marketCap * usdPerAud / c.reports.ttm.netIncome).toFixed(2);
    assert.ok(Math.abs(want - c.pe) < 0.2, `P/E ${c.pe} is not cap-in-USD ÷ profit`);
  }
});

test('/api/australia/chart serves the range it was asked for', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/australia/chart?code=BHP&range=5y`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.dates.length > 200, `got ${d.dates.length} points`);
  assert.equal(d.dates.length, d.closes.length);
  for (let i = 1; i < d.dates.length; i++) assert.ok(d.dates[i] > d.dates[i - 1]);
});

test('/api/indonesia ships the list projection, not the price history, and revalidates', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/indonesia`);
  assert.equal(r.status, 200);
  const etag = r.headers.get('etag');
  assert.ok(etag, 'the Indonesia list must carry an ETag');
  const d = await r.json();
  assert.ok(d.companies.length > 800, `got ${d.companies.length} companies`);
  assert.ok(d.index && d.index.level != null, 'the IDX Composite level is missing');
  assert.ok(d.fx && d.fx.rate > 1000, 'the USD/IDR rate is missing — the ratios need it');
  const bbca = d.companies.find((x) => x.ticker === 'BBCA');
  assert.ok(bbca && bbca.nameEn, 'Bank Central Asia is missing from the list');
  assert.equal(bbca.reportCurrency, 'IDR');
  assert.equal(bbca.series, undefined, 'the list must not carry per-company price history');
  assert.ok(JSON.stringify(d).length < 3_000_000, 'the Indonesia list payload ballooned');
  const again = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: '/api/indonesia', headers: { 'if-none-match': etag }, agent: false }, resolve).on('error', reject);
  });
  assert.equal(again.statusCode, 304);
  again.resume();
});

test('/api/indonesia/company values a bank without inventing an operating margin', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/indonesia/company/BBCA`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.ok(c.sector, 'the sector is missing');
  assert.equal(c.reportCurrency, 'IDR');
  assert.ok(c.reports && c.reports.ttm && c.reports.ttm.revenue > 0, 'TTM revenue is missing');
  assert.ok(c.history.length >= 3, 'the fiscal-year record is missing');
  assert.ok(c.marketCap === c.price * (c.sharesCurrent ?? c.shares), 'market cap does not reconcile');
  assert.equal(c.bankLike, true, 'BCA is a bank');
  assert.equal(c.opMargin, null, 'a bank has no operating margin');
  if (c.pe != null) {
    const want = +(c.marketCap / c.reports.ttm.netIncome).toFixed(2);
    assert.ok(Math.abs(want - c.pe) < 0.2, `P/E ${c.pe} is not cap ÷ profit`);
  }
});

test('/api/indonesia/chart serves the range it was asked for', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/indonesia/chart?code=BBCA&range=5y`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.dates.length > 200, `got ${d.dates.length} points`);
  assert.equal(d.dates.length, d.closes.length);
  for (let i = 1; i < d.dates.length; i++) assert.ok(d.dates[i] > d.dates[i - 1]);
});

test('/api/brazil ships the list projection, not the price history, and revalidates', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/brazil`);
  assert.equal(r.status, 200);
  const etag = r.headers.get('etag');
  assert.ok(etag, 'the Brazil list must carry an ETag');
  const d = await r.json();
  assert.ok(d.companies.length > 200, `got ${d.companies.length} companies`);
  assert.ok(d.index && d.index.level != null, 'the Ibovespa level is missing');
  assert.ok(d.fx && d.fx.rate > 3, 'the USD/BRL rate is missing');
  const petr = d.companies.find((x) => x.ticker === 'PETR4');
  assert.ok(petr && petr.nameEn, 'Petrobras is missing');
  assert.equal(petr.reportCurrency, 'BRL');
  assert.equal(petr.shareClass, 'PN');
  assert.equal(petr.series, undefined, 'the list must not carry per-company price history');
  const nubr = d.companies.find((x) => x.code === 'ROXO34');
  assert.ok(nubr && nubr.bdr, 'the Nubank BDR is missing');
  assert.equal(nubr.bdrUnderlying, 'NYSE: NU');
  assert.equal(nubr.reportCurrency, 'USD');
  assert.equal(nubr.shareClass, 'BDR');
  assert.ok(nubr.marketCap === nubr.vendorCap, 'the BDR cap is not the vendor company cap');
  assert.equal(d.market.companies, d.companies.filter((x) => !x.bdr).length);
  assert.equal(d.market.bdrs, d.companies.filter((x) => x.bdr).length);
  assert.ok(d.market.bdrCap > 0 && d.market.bdrCap < d.market.totalCap, 'BDR caps should be separate and below the domestic total');
  assert.ok(!d.companies.some((x) => x.code === 'AAPL34'), 'the US Apple line must not be duplicated as a Brazil BDR');
  assert.ok(JSON.stringify(d).length < 3_000_000, 'the Brazil list payload ballooned');
  const again = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: '/api/brazil', headers: { 'if-none-match': etag }, agent: false }, resolve).on('error', reject);
  });
  assert.equal(again.statusCode, 304);
  again.resume();
});

test('/api/brazil/company keeps the company cap and the class price apart', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/brazil/company/PETR4`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.ok(c.sector, 'the sector is missing');
  assert.equal(c.reportCurrency, 'BRL');
  assert.equal(c.shareClass, 'PN');
  assert.ok(c.reports && c.reports.ttm && c.reports.ttm.revenue > 0, 'TTM revenue is missing');
  assert.ok(c.history.length >= 3, 'the fiscal-year record is missing');
  assert.ok(c.marketCap === c.vendorCap, 'the company cap is not the vendor total');
  if (c.pe != null) {
    const want = +(c.marketCap / c.reports.ttm.netIncome).toFixed(2);
    assert.ok(Math.abs(want - c.pe) < 0.2, `P/E ${c.pe} is not the company cap ÷ profit`);
  }
});

test('/api/brazil/company serves a BDR with the global cap and no per-BDR band', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/brazil/company/ROXO34`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.bdr, true);
  assert.equal(c.bdrUnderlying, 'NYSE: NU');
  assert.equal(c.shareClass, 'BDR');
  assert.equal(c.reportCurrency, 'USD');
  assert.equal(c.bands, null);
  assert.ok(c.marketCap === c.vendorCap, 'market cap is not the B3 company cap');
  assert.ok(c.reports && c.reports.ttm && c.reports.ttm.revenue > 0, 'underlying TTM revenue is missing');
  assert.ok(c.price > 0 && c.priceDate, 'BDR line price is missing');
  assert.ok(c.history.length >= 3, 'underlying fiscal-year record is missing');
});

test('/api/brazil/chart serves the range it was asked for', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/brazil/chart?code=PETR4&range=5y`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.dates.length > 200, `got ${d.dates.length} points`);
  assert.equal(d.dates.length, d.closes.length);
  for (let i = 1; i < d.dates.length; i++) assert.ok(d.dates[i] > d.dates[i - 1]);
});

test('/api/southafrica ships the list projection, not the price history, and revalidates', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/southafrica`);
  assert.equal(r.status, 200);
  const etag = r.headers.get('etag');
  assert.ok(etag, 'the South Africa list must carry an ETag');
  const d = await r.json();
  assert.ok(d.companies.length > 200, `got ${d.companies.length} companies`);
  assert.equal(d.currency, 'ZAR');
  assert.equal(d.indexName, 'JSE All Share');
  assert.ok(d.index && d.index.level != null, 'the JSE All Share level is missing');
  assert.ok(d.fx && d.fx.rate > 5, 'the USD/ZAR rate is missing');
  const npn = d.companies.find((x) => x.ticker === 'NPN');
  assert.ok(npn && npn.nameEn, 'Naspers is missing');
  assert.equal(npn.foreignSecondary, false);
  assert.ok(npn.marketCap === npn.vendorCap, 'the JSE cap is not the vendor company total');
  assert.equal(npn.series, undefined, 'the list must not carry per-company price history');
  const bti = d.companies.find((x) => x.ticker === 'BTI');
  assert.ok(bti && bti.foreignSecondary, 'the BAT secondary line is missing');
  assert.ok(bti.secondarySource && bti.secondaryExchange, 'the secondary line has no primary source');
  assert.equal(bti.reportCurrency, 'GBP');
  assert.ok(bti.marketCap === bti.vendorCap, 'the secondary cap is not the vendor company total');
  assert.equal(d.market.primary, d.companies.filter((x) => !x.foreignSecondary).length);
  assert.equal(d.market.secondary, d.companies.filter((x) => x.foreignSecondary).length);
  assert.equal(d.market.listed, d.companies.length);
  assert.ok(JSON.stringify(d).length < 3_000_000, 'the South Africa list payload ballooned');
  const again = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: '/api/southafrica', headers: { 'if-none-match': etag }, agent: false }, resolve).on('error', reject);
  });
  assert.equal(again.statusCode, 304);
  again.resume();
});

test('/api/southafrica/company serves a JSE-primary company in rand', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/southafrica/company/NPN`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.ok(c.sector, 'the sector is missing');
  assert.equal(c.currency, 'ZAR');
  assert.equal(c.foreignSecondary, false);
  // Naspers' year-end has just passed, so the vendor serves annual columns and no TTM; the engine
  // falls back to the fiscal year and flags it. Either is a real revenue line, not a missing one.
  const ttm = (c.reports && c.reports.ttm) || {};
  const fy = (c.reports && c.reports.annual && c.reports.annual.at(-1)) || {};
  assert.ok(ttm.revenue > 0 || fy.revenue > 0, 'no revenue line in the statement record');
  assert.ok(c.history.length >= 3, 'the fiscal-year record is missing');
  assert.ok(c.price > 0 && c.priceDate, 'the JSE price is missing');
  assert.ok(c.marketCap === c.vendorCap, 'the company cap is not the vendor total');
});

test('/api/southafrica/company serves a foreign-secondary line with its primary source', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/southafrica/company/BTI`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.foreignSecondary, true);
  assert.equal(c.secondaryExchange, 'NYSE');
  assert.equal(c.reportCurrency, 'GBP');
  assert.ok(c.marketCap === c.vendorCap, 'market cap is not the JSE company total');
  assert.ok(c.reports && c.reports.ttm && c.reports.ttm.revenue > 0, 'underlying TTM revenue is missing');
  assert.ok(c.price > 0 && c.priceDate, 'JSE line price is missing');
});

test('/api/southafrica/chart serves the range it was asked for', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/southafrica/chart?code=NPN&range=5y`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.dates.length > 200, `got ${d.dates.length} points`);
  assert.equal(d.dates.length, d.closes.length);
  for (let i = 1; i < d.dates.length; i++) assert.ok(d.dates[i] > d.dates[i - 1]);
});

// One company is one small file now (data/korea-companies), not a parse of the 28 MB market. The
// detail page reads quarters/history; the chart comes from data/charts, so the record carries no series.
test('/api/korea/company answers by code or ticker from the per-company file', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/korea/company/005930`);
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.ticker, '005930');
  assert.ok(c.history && c.history.length >= 4, 'the five-year record is missing');
  assert.ok(c.quarters && c.quarters.length >= 4, 'the quarterly table is missing');
  const annual = (c.reports || []).find((x) => x.report === 'annual');
  assert.ok(annual && annual.revenue > 0, 'the annual statements are missing');
  assert.equal(c.series, undefined, 'the detail page must not carry the price history');
  assert.ok(JSON.stringify(c).length < 50_000, 'the company payload ballooned');
  const byCode = await (await fetch(`http://localhost:${PORT}/api/korea/company/00126380`)).json();
  assert.equal(byCode.ticker, c.ticker, 'the DART code must resolve to the same company');
});

test('/api/korea ships the list projection, not the price history, and revalidates', async () => {
  const r = await fetch(`http://localhost:${PORT}/api/korea`);
  assert.equal(r.status, 200);
  const etag = r.headers.get('etag');
  assert.ok(etag, 'the Korea list must carry an ETag so a returning reader transfers nothing');
  const d = await r.json();
  assert.ok(d.companies.length > 500, `got ${d.companies.length} companies`);
  assert.ok(d.index && d.index.level != null, 'the KOSPI level is missing');
  const samsung = d.companies.find((x) => x.ticker === '005930');
  assert.ok(samsung && samsung.nameEn, 'Samsung Electronics is missing from the list');
  assert.equal(samsung.series, undefined, 'the list must not carry per-company price history');
  assert.ok(JSON.stringify(d).length < 1_000_000, 'the Korea list payload ballooned — check projectKr');
  // A fresh connection, so the assertion never depends on undici reusing a keep-alive socket that a
  // busy parallel test file could have let the server time out.
  const again = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: '/api/korea', headers: { 'if-none-match': etag }, agent: false }, resolve).on('error', reject);
  });
  assert.equal(again.statusCode, 304);
  again.resume();
});
