// Front-end regression tests.
//
// public/app.js is a classic browser script: no modules, no exports, and it wires listeners at the
// top level. Rather than add a DOM dependency to a project that deliberately has none, this file runs
// the real app.js inside a node:vm context with a small DOM stub that models exactly the operations
// the tests use (select options, ticker nodes, classList, innerHTML).
//
// The two bugs covered here both shipped: the segment picker went blank when /api/market won the race
// against the segment list, and the ticker rebuilt ~110 spans every minute, which read as a stutter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'public', 'app.js');

// --- DOM stub ---------------------------------------------------------------------------------

function el(id = '') {
  const classes = new Set();
  const node = {
    id,
    children: [],
    options: [],
    style: {},
    dataset: {},
    title: '',
    textContent: '',
    className: '',
    value: '',
    _html: '',
    _htmlWrites: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c)),
    },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    focus() {}, blur() {}, click() {}, select() {}, setSelectionRange() {},
    scrollIntoView() {}, remove() {}, insertBefore() {}, replaceChildren() {},
    getAttribute() { return null; },
    appendChild(c) { node.children.push(c); return c; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll(sel) { return sel === '.tk' ? node.children : []; },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
  };
  Object.defineProperty(node, 'innerHTML', {
    get: () => node._html,
    set: (v) => {
      node._html = String(v);
      node._htmlWrites++;
      node.options = [...node._html.matchAll(/<option value="([^"]*)"/g)].map((m) => ({ value: m[1], label: '' }));
      // The ticker writes two identical copies of N cells; model each <span class="tk"> as a node.
      const n = (node._html.match(/class="tk"/g) || []).length;
      node.children = Array.from({ length: n }, () => {
        const kids = new Map();
        const child = {
          title: '', className: '', textContent: '',
          classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
          querySelector(sel) {
            if (!kids.has(sel)) kids.set(sel, { textContent: '', className: '' });
            return kids.get(sel);
          },
        };
        return child;
      });
    },
  });
  return node;
}

function makeDocument() {
  const byId = new Map();
  const ticker = el('ticker');
  const track = el('ticker-track');
  ticker.querySelector = (sel) => (sel === '.ticker-track' ? track : null);
  ticker.track = track;
  byId.set('ticker', ticker);

  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, el(id));
      return byId.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: el('body'),
    documentElement: el('html'),
    element: byId,
  };
}

// Every browser global app.js touches must exist, even if it is inert.
function makeContext() {
  const document = makeDocument();
  const noop = () => 0;
  const inertObserver = class { observe() {} unobserve() {} disconnect() {} };
  const ctx = {
    document,
    window: null,
    navigator: { userAgent: 'node-test', connection: {}, language: 'en' },
    location: { hash: '', pathname: '/', search: '', href: 'http://localhost/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    queueMicrotask() {},
    performance: { now: () => 0 },
    // A pending fetch, never resolved: boot code must not run against half a response.
    fetch: () => new Promise(() => {}),
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    IntersectionObserver: inertObserver,
    ResizeObserver: inertObserver,
    Chart: class { static register() {} destroy() {} update() {} resize() {} },
    Notification: class { static permission = 'denied'; static requestPermission() {} },
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    console,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  return ctx;
}

function loadApp() {
  // A fresh context per test: app.js keeps module-level state (markets, bootReady, tickerSig) and
  // one test marking every panel ready must not leak into the next.
  const source = fs.readFileSync(APP, 'utf8');
  // `const`/`function` declarations are script-scoped, so hand the ones under test back explicitly.
  const exported = `\n;globalThis.__ui = {
    esc, pctf, cls, ago, deltaStrip,
    buildBpOptions, renderTicker, markReady, hideBoot, BOOT_CORE, bootReady,
    setMarkets: (v) => { markets = v; },
    getMarkets: () => markets,
    setCurrentMarket: (v) => { currentMarket = v; },
    getCurrentMarket: () => currentMarket,
    setHistory: (v) => { history = v; },
  };`;
  const ctx = makeContext();
  vm.createContext(ctx);
  vm.runInContext(source + exported, ctx, { filename: 'public/app.js' });
  return { ui: ctx.__ui, document: ctx.document, window: ctx.window };
}

const SEGMENTS = [
  { id: 'crude', label: 'Crude oil', group: 'energy', components: [] },
  { id: 'gas', label: 'Natural gas', group: 'energy', components: [] },
  { id: 'precious', label: 'Precious metals', group: 'metals', components: [] },
  { id: 'grains', label: 'Grains & oilseeds', group: 'ags', components: [] },
];

// --- the segment picker (shipped regression) ---------------------------------------------------

test('the segment picker fills in even when markets arrive after the first render', () => {
  const { ui, document } = loadApp();
  const sel = document.getElementById('bp-metric');

  ui.setMarkets([]);
  ui.buildBpOptions();                     // /api/market won the race; the list was still empty
  assert.equal(sel.options.length, 0, 'nothing to offer before the segments land');

  ui.setMarkets(SEGMENTS);
  ui.buildBpOptions();                     // the late arrival must still build the picker
  assert.deepEqual(sel.options.map((o) => o.value), ['crude', 'gas', 'precious', 'grains']);
});

test('the segment picker is idempotent and keeps the current selection', () => {
  const { ui, document } = loadApp();
  const sel = document.getElementById('bp-metric');
  ui.setMarkets(SEGMENTS);
  ui.setCurrentMarket('precious');

  ui.buildBpOptions();
  assert.equal(sel.value, 'precious');
  const html = sel.innerHTML;
  const count = sel.options.length;

  ui.buildBpOptions();
  ui.buildBpOptions();
  assert.equal(sel.options.length, count, 're-rendering does not duplicate segments');
  assert.equal(sel.innerHTML, html, 're-rendering produces the same option list');
  assert.equal(sel.value, 'precious', 'the reader keeps the segment they picked');
});

test('the picker only marks the first screen ready once it has options', () => {
  const { ui } = loadApp();
  ui.setMarkets([]);
  ui.buildBpOptions();
  assert.equal(ui.bootReady.segments, false);

  ui.setMarkets(SEGMENTS);
  ui.buildBpOptions();
  assert.equal(ui.bootReady.segments, true);
});

// --- the ticker (shipped regression) -----------------------------------------------------------

const tickerMarket = (price) => ({
  benchmarks: [
    { id: 'wti', label: 'WTI (Cushing)', paper: price, physical: null, dp: 2, unit: 'USD/bbl' },
    { id: 'brent', label: 'Brent', paper: price + 4, physical: null, dp: 2, unit: 'USD/bbl' },
  ],
});

test('the ticker updates its cells in place instead of rebuilding the strip', () => {
  const { ui, document } = loadApp();
  const ticker = document.getElementById('ticker');
  const track = ticker.track;

  ui.renderTicker(tickerMarket(80));
  const writes = track._htmlWrites;
  assert.ok(writes > 0, 'the first render builds the strip');
  const firstNodes = track.children;

  ui.renderTicker(tickerMarket(81));        // same labels, one new number
  assert.equal(track._htmlWrites, writes, 'a price tick must not re-create ~110 spans');
  assert.equal(track.children, firstNodes, 'the same DOM nodes survive the refresh');

  const span = track.children[0];
  assert.equal(span.querySelector('b').textContent, 'WTI');
  assert.equal(span.querySelector('.tk-px').textContent, '81.00');
});

test('the ticker rebuilds when the set of cells changes', () => {
  const { ui, document } = loadApp();
  const track = document.getElementById('ticker').track;

  ui.renderTicker(tickerMarket(80));
  const writes = track._htmlWrites;

  ui.renderTicker({
    benchmarks: [
      { id: 'wti', label: 'WTI (Cushing)', paper: 80, physical: null, dp: 2, unit: 'USD/bbl' },
      { id: 'brent', label: 'Brent', paper: 84, physical: null, dp: 2, unit: 'USD/bbl' },
      { id: 'ng', label: 'Natural gas', paper: 3.1, physical: null, dp: 2, unit: 'USD/mmBtu' },
    ],
  });
  assert.ok(track._htmlWrites > writes, 'a new instrument has to enter the tape');
});

// --- the boot gate (shipped regression) --------------------------------------------------------

test('the boot overlay lifts only when every first-screen panel is ready', () => {
  const { ui, document, window } = loadApp();
  const boot = document.getElementById('boot');

  for (const key of ui.BOOT_CORE.slice(0, -1)) ui.markReady(key);
  assert.equal(boot.classList.contains('done'), false, 'a half-empty page must not be revealed');
  assert.equal(ui.bootReady[ui.BOOT_CORE.at(-1)], false);

  ui.markReady(ui.BOOT_CORE.at(-1));
  assert.equal(boot.classList.contains('done'), true);
  assert.equal(window.__bootDone, true);
});

test('the progress bar never runs backwards and unknown keys are ignored', () => {
  const { ui, document } = loadApp();
  const bar = document.getElementById('boot-bar');

  ui.markReady('data');
  const one = parseFloat(bar.style.width);
  assert.ok(one > 0 && one < 100);

  ui.markReady('data');                    // duplicate
  assert.equal(parseFloat(bar.style.width), one);

  ui.markReady('not-a-panel');
  assert.equal(parseFloat(bar.style.width), one, 'an unknown key is not a step');
});

// --- formatting helpers ------------------------------------------------------------------------

test('esc escapes external text, including quotes and angle brackets', () => {
  const { ui } = loadApp();
  assert.equal(ui.esc(`<img src=x onerror="alert('x')">`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;');
  assert.equal(ui.esc(null), '');
});

test('pctf and cls keep the sign and the empty state', () => {
  const { ui } = loadApp();
  assert.equal(ui.pctf(1.234), '+1.2%');
  assert.equal(ui.pctf(-1.26), '-1.3%');
  assert.equal(ui.pctf(null), '—');
  assert.equal(ui.cls(0.1), 'pos');
  assert.equal(ui.cls(-0.1), 'neg');
  assert.equal(ui.cls(null), '');
});
