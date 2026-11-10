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
    Chart: class { constructor(cv, cfg) { this.canvas = cv; this.data = (cfg && cfg.data) || {}; } static register() {} destroy() {} update() {} resize() {} },
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
    esc, pctf, cls, ago, deltaStrip, renderRisk, renderRelValue, tileSignals, curveShort, renderInventories,
    isPropertyCompany, epsGrowthLabel, epsGrowthNote,
    buildBpOptions, renderTicker, markReady, hideBoot, BOOT_CORE, bootReady,
    setMarkets: (v) => { markets = v; },
    getMarkets: () => markets,
    setCurrentMarket: (v) => { currentMarket = v; },
    getCurrentMarket: () => currentMarket,
    setHistory: (v) => { history = v; },
    setData: (v) => { data = v; },
    setFx: (v) => { fxList = v; },
    setRates: (v) => { rateList = v; },
    setComponent: (v) => { currentComponent = v; },
    buildCompareOptions,
    syncCompareToSelection,
    renderCmpPresets,
    compareFor,
    cmpSubject,
    ensureCmpLegs,
    saveCompare,
    CMP_SPREADS,
    setCompanies: (v) => { companiesData = v; },
    renderUsMarket,
    renderHongKongMarket,
    hkBalanceSheetFinancial,
    liveRef, liveChg, setMetricText, LIVE_BASE, patchQuoteHomeRow,
    drawMarketIndexChart,
    jpFlowPanel, jpFlowContext, jpFlowMini, jpCalendarLine, jpDividendLadder,
    coWindowsFor,
    coWindow,
    coSlice,
    charts,
    gsQuickSearch,
    setGsQuick: (v) => { gsQuick = v; },
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

// --- compare / spread (shipped regression) -----------------------------------------------------
// The two pickers were built once, on the first /api/market response. That response usually beats
// /api/history and the FX/rate feeds, so the one-shot build left them with currencies only (and
// sometimes nothing at all) and the panel could never draw. Each commodity also has to open on its
// own spread rather than re-picking Brent vs WTI every time.

const CMP_DATA = {
  benchmarks: [
    { id: 'wti', label: 'WTI (Cushing)', unit: '$/bbl', dp: 2, paper: 70 },
    { id: 'brent', label: 'Brent', unit: '$/bbl', dp: 2, paper: 74 },
    { id: 'gold', label: 'Gold', unit: '$/oz', dp: 2, paper: 2000 },
    { id: 'silver', label: 'Silver', unit: '$/oz', dp: 3, paper: 25 },
    { id: 'copper', label: 'Copper', unit: '$/lb', dp: 4, paper: 4 },
  ],
};
const CMP_MARKETS = [
  { id: 'crude', label: 'Crude oil', primary: 'wti', components: [{ id: 'wti' }, { id: 'brent' }] },
  { id: 'precious', label: 'Precious metals', primary: 'gold', components: [{ id: 'gold' }, { id: 'silver' }] },
  { id: 'industrial', label: 'Industrial metals', primary: 'copper', components: [{ id: 'copper' }] },
];

test('relative value paints a percentile marker and never invents one', () => {
  const { ui, document } = loadApp();
  const el = document.getElementById('relval');
  ui.renderRelValue({ segment: 'crude', asOf: '2026-11-03', rows: [
    { id: 'brent_wti', label: 'Brent − WTI', unit: '$/bbl', dp: 2, signed: true, last: 7.56, pct: 91.2, pctLabel: '91st pctile', zone: 'near the top of its 1-year range', why: 'Wide = tight non-US crude.', extreme: true, obs: 250, asOf: '2026-11-03', spark: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { id: 'short', label: 'Short history', unit: '$/t', dp: 0, signed: true, last: null, pct: null, pctLabel: null, zone: null, why: '', extreme: false, obs: 12, asOf: '2026-10-31', spark: [] },
  ] });
  assert.match(el.innerHTML, /Brent − WTI/);
  assert.match(el.innerHTML, /91st pctile/);
  assert.match(el.innerHTML, /MOST EXTREME/);
  assert.match(el.innerHTML, /rv-mark hot/);
  assert.match(el.innerHTML, /not enough history/);
  assert.doesNotMatch(el.innerHTML, /NaN/);
});

test('the segment tile chips show only the signals that exist', () => {
  const { ui } = loadApp();
  const full = ui.tileSignals({ stretch: 79, stretchLabel: 'AT A PREMIUM', tight: 72, tightLabel: 'UNDERSUPPLIED', curve: 'Backwardation', posPct: 10, posFlag: 'WASHED-OUT', basisPct: 89 });
  assert.match(full, /P \+79/);
  assert.match(full, /S&D 72/);
  assert.match(full, /CURVE BACK/);
  assert.match(full, /COT 10/);
  assert.match(full, /BASIS 89/);
  assert.match(full, /t-chip cool/);          // washed-out COT
  const bare = ui.tileSignals({ stretch: null, tight: null, curve: null, posPct: null, basisPct: null });
  assert.equal(bare, '');
  assert.equal(ui.curveShort('Backwardation'), 'BACK');
  assert.equal(ui.curveShort('Contango'), 'CONTANGO');
  assert.equal(ui.curveShort('Flat'), 'FLAT');
  assert.equal(ui.curveShort(null), null);
});

test('the supply table labels EIA stocks in million barrels, not thousand', () => {
  const { ui, document } = loadApp();
  ui.renderInventories({
    items: [{
      key: 'crude', label: 'Crude (ex-SPR)', period: '2026-10-23', value: 410625, wow: -1892,
      seasonal: -351, seasonalMin: -6858, seasonalMax: 4320, surprise: -1541, unit: 'kbbl',
      history: [
        { period: '2026-10-16', value: 409000, min: 380000, avg: 400000, max: 420000, n: 5 },
        { period: '2026-10-23', value: 410625, min: 381000, avg: 401000, max: 421000, n: 5 },
      ],
    }],
    gas: { period: '2026-10-23', value: 3500, wow: -20, surprise: -10, unit: 'BCF', history: [] },
  });
  const html = document.getElementById('inventories').innerHTML;
  assert.match(html, /410\.6/);
  assert.doesNotMatch(html, /410,625/);
  assert.match(html, /-1\.9/);
  assert.match(html, /drew 1\.5/);
  assert.match(html, /3,500 BCF/);
  assert.match(document.getElementById('inv-chart-title').textContent, /CRUDE \(EX-SPR\)/);
});

test('the compare pickers fill in even when prices land before history and FX', () => {
  const { ui, document } = loadApp();
  const a = document.getElementById('cmp-a'), b = document.getElementById('cmp-b');

  ui.setData(CMP_DATA);
  ui.setMarkets(CMP_MARKETS);
  ui.setHistory(undefined);             // /api/history has not answered yet — this used to empty the list
  ui.setFx([]); ui.setRates([]);
  ui.buildCompareOptions();

  assert.ok(a.options.some((o) => o.value === 'wti'), 'commodities are offered, not just currencies');
  assert.equal(a.options.length, b.options.length);
  assert.equal(ui.cmpSubject(), 'wti');
});

test('each commodity opens on its own spread, in a view its units allow', () => {
  const { ui, document } = loadApp();
  ui.setData(CMP_DATA);
  ui.setMarkets(CMP_MARKETS);
  ui.buildCompareOptions();
  const view = () => document.getElementById('cmp-view').value;

  for (const [id, leg, v] of [['wti', 'brent', 'diff'], ['brent', 'wti', 'diff'], ['gold', 'silver', 'diff'], ['copper', 'gold', 'index']]) {
    ui.syncCompareToSelection(id);
    assert.equal(document.getElementById('cmp-a').value, id, `${id} is leg A`);
    assert.equal(document.getElementById('cmp-b').value, leg, `${id} opens against ${leg}`);
    assert.equal(view(), v, `${id} picks the view its units allow`);
  }
});

test('a rebuild of the pickers never throws away the reader’s choice', () => {
  const { ui, document } = loadApp();
  const a = document.getElementById('cmp-a'), b = document.getElementById('cmp-b');
  ui.setData(CMP_DATA);
  ui.setMarkets(CMP_MARKETS);
  ui.buildCompareOptions();

  a.value = 'gold'; b.value = 'silver'; document.getElementById('cmp-view').value = 'diff';
  ui.saveCompare();
  ui.buildCompareOptions();
  assert.equal(a.value, 'gold', 'the pair survives an identical rebuild');

  // A later feed adds an instrument: the list has to grow, and the choice still has to stand.
  ui.setData({ benchmarks: [...CMP_DATA.benchmarks, { id: 'natgas', label: 'Natural Gas', unit: '$/MMBtu', dp: 2, paper: 3 }] });
  ui.buildCompareOptions();
  assert.ok(a.options.some((o) => o.value === 'natgas'), 'the new instrument is offered');
  assert.equal(a.value, 'gold');
  assert.equal(b.value, 'silver');
});

test('a manual pair never collapses to one series', () => {
  const { ui, document } = loadApp();
  ui.setData(CMP_DATA);
  ui.setMarkets(CMP_MARKETS);
  ui.buildCompareOptions();
  // Picking the same instrument on both sides used to leave the panel saying "pick two series".
  document.getElementById('cmp-a').value = 'gold';
  document.getElementById('cmp-b').value = 'gold';
  ui.ensureCmpLegs();
  assert.equal(document.getElementById('cmp-b').value, 'silver', 'gold falls back to its own partner');
});

test('the preset strip leads with the commodity being read', () => {
  const { ui, document } = loadApp();
  ui.setData(CMP_DATA);
  ui.setMarkets(CMP_MARKETS);
  ui.setCurrentMarket('precious');
  ui.setComponent('silver');
  ui.buildCompareOptions();
  const html = document.getElementById('cmp-presets').innerHTML;
  assert.match(html, /data-a="silver" data-b="gold"/, 'silver opens against gold, not Brent vs WTI');
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

// --- the risk panel (readability regression) ---------------------------------------------------

test('the risk panel separates current risk from level moves and groups correlation by decision', () => {
  const { ui, document } = loadApp();
  ui.renderRisk({
    read: '<b>Gold</b> is 25% below its 1-year high.',
    metrics: [
      { key: 'wti', label: 'WTI crude', drawdownNow: -10, drawdown: -39, vol: { w30: 39 }, volWord: 'jumpy', volTrend: 'falling', volPct: 72, volVsOwn: 'jumpier than usual' },
      { key: 'vix', label: 'VIX', level: true, drawdownNow: -54, drawdown: -54, vol: { w30: 103 }, volWord: 'very jumpy', volTrend: 'flat', volPct: 50, volVsOwn: 'typical' },
    ],
    keys: [{ key: 'wti', label: 'WTI crude', short: 'WTI' }, { key: 'vix', label: 'VIX', short: 'VIX' }],
    matrix: { wti: { wti: 1, vix: 0.2 }, vix: { wti: 0.2, vix: 1 } },
    matrix3m: { wti: { wti: 1, vix: -0.6 }, vix: { wti: -0.6, vix: 1 } },
    groups3m: {
      together: [],
      opposite: [{ a: { key: 'wti', label: 'WTI crude', short: 'WTI' }, b: { key: 'vix', label: 'VIX', short: 'VIX' }, r: -0.6, r1: 0.2, shift: { word: 'flipped', tone: 'warn' } }],
      loose: [],
    },
    div: { label: 'VIX', avg: 0.4 },
  });
  const html = document.getElementById('risk').innerHTML;
  assert.match(html, /OFF 1Y HIGH/);
  assert.match(html, /LEVEL/, 'a level series is labelled, not reported as a loss');
  assert.match(html, /MOVE TOGETHER/);
  assert.match(html, /MOVE OPPOSITE/);
  assert.match(html, /flipped/, 'a link that changed sign is called out');
  assert.match(html, /3 MONTHS/);
  assert.doesNotMatch(html, /Wildest here/);
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

// --- boot ordering -----------------------------------------------------------------------------

test('the overlay ceiling is armed before anything that can block', () => {
  const src = fs.readFileSync(APP, 'utf8');
  const ceiling = src.indexOf('setTimeout(hideBoot');
  const prompt = src.indexOf('Notification.requestPermission');
  assert.ok(ceiling > 0, 'there is a hard ceiling');
  assert.ok(prompt > ceiling, 'the cap is armed before the permission prompt, not after it');
  assert.doesNotMatch(src, /await\s+Notification\.requestPermission/, 'the prompt must never hold the boot');
});

// --- market index windows (smoothness regression) -----------------------------------------------

test('an index window change re-slices the same series and updates the chart in place', () => {
  const { ui, document } = loadApp();
  // ~7 years of daily points, so 5Y is offered and 10Y is not.
  const dates = [];
  for (let i = 0; i < 2600; i++) dates.push(new Date(Date.UTC(2017, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const full = { dates, closes: dates.map((_, i) => 100 + i) };

  const first = ui.drawMarketIndexChart('jp-mkt', full, '1y', 'jpmkt', 'TOPIX');
  assert.equal(first, '1y');
  const chart = ui.charts['jp-mkt-chart'];
  assert.ok(chart, 'the chart is mounted');
  const oneYear = chart.data.labels.length;

  ui.drawMarketIndexChart('jp-mkt', full, '5y', 'jpmkt', 'TOPIX');
  assert.equal(ui.charts['jp-mkt-chart'], chart, 'the instance is updated, not destroyed and remounted');
  assert.ok(chart.data.labels.length > oneYear, 'the five-year window holds more points');
  assert.match(chart.data.datasets[0].label, /5Y/);
  const strip = document.getElementById('jp-mkt-rets');
  assert.match(strip.innerHTML, /class="co-ret on" data-jpmkt="5y"/, 'the strip moves its active chip');
  assert.doesNotMatch(strip.innerHTML, /data-jpmkt="1y"[^>]*class="co-ret on"/, 'the old chip is not still active');
});

// The Hong Kong overview is anchored on the Hang Seng, not on our coverage. A company outside the
// index must not move a single figure on that panel — that was the whole point of the change, and it
// is the kind of thing that silently regresses when someone edits the reducer.
test('the Hong Kong overview counts index members only, not every company we hold', () => {
  const { ui, document } = loadApp();
  const mk = (code, cap, pe, yld, sector, ccy) => ({
    code, ticker: code, name: code, nameEn: code, marketCap: cap, pe, pb: 1.5, roe: 10,
    dividendYield: yld, chg1d: 1, chgYtd: 2, sector, reportCurrency: ccy, price: 10,
  });
  const all = [
    mk('0700', 3.6e12, 13, 1, 'Technology', 'CNY'),
    mk('0005', 2.3e12, 11, 5, 'Financials', 'USD'),
    mk('9999', 9e12, 5, 0, 'Other', 'HKD'),          // not a constituent — must be ignored
  ];
  ui.renderHongKongMarket(all, {
    hsi: { codes: ['0700', '0005'], count: 2, updated: '2026-11-03' },
    index: { level: 23000, chg1d: 0.5 },
    session: '2026-10-30',
  });
  const html = document.getElementById('co-body').innerHTML;
  assert.match(html, /2 of 2/, 'the panel reports members held, not coverage');
  assert.match(html, /HK\$5\.90T/, 'members\u2019 cap excludes the 9T non-member');
  assert.doesNotMatch(html, /HK\$14\.90T/, 'the non-member leaked into the total');
  assert.match(html, /INDEX P\/E/, 'the cap-weighted index P/E is shown');
  assert.match(html, /12\.1×/, 'the weighted P/E is cap over earnings, not a median');
  assert.match(html, /INDEX YIELD/, 'the cap-weighted yield is shown');
});

test('the Hong Kong company page omits industrial ratios for a balance-sheet financial', () => {
  const { ui } = loadApp();
  assert.equal(ui.hkBalanceSheetFinancial({ sector: 'Financials', industry: 'Banks - Diversified' }), true);
  assert.equal(ui.hkBalanceSheetFinancial({ sector: 'Financials', industry: 'Insurance - Life' }), true);
  assert.equal(ui.hkBalanceSheetFinancial({ sector: 'Financials', industry: 'Credit Services' }), true);
  assert.equal(ui.hkBalanceSheetFinancial({ sector: 'Financials', industry: 'Capital Markets' }), false);
  assert.equal(ui.hkBalanceSheetFinancial({ sector: 'Financials', industry: 'Financial Data & Stock Exchanges' }), false);
  assert.equal(ui.hkBalanceSheetFinancial({ sector: 'Financials', industry: 'Insurance Brokers' }), false);
  assert.equal(ui.hkBalanceSheetFinancial({ sector: 'Technology', industry: 'Banks - Diversified' }), false);
});

test('a short stat strip fills its last row instead of leaving a hole', () => {
  // The strip used to paint its empty cells — the container's grey showed through the gaps, and Hong
  // Kong padded the row with filler tiles. Both read as empty boxes under the last real tile. The
  // tiles now grow to fill whatever the last row has left, so there is no empty cell at all.
  const css = fs.readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');
  const app = fs.readFileSync(APP, 'utf8');
  const rule = (sel) => {
    const m = css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`));
    return m ? m[0] : '';
  };
  const stats = rule('.co-stats');
  const tile = rule('.co-stat');
  assert.match(stats, /display: flex/, 'a wrapping row of tiles, not a fixed grid');
  assert.match(stats, /flex-wrap: wrap/, 'tiles wrap into rows');
  assert.match(tile, /flex: 1 1 20%/, 'tiles grow to fill the row, so the last row is never short');
  assert.match(css, /\.co-stat \{ flex-basis: 40%/, 'two tiles per row on a phone');
  assert.doesNotMatch(app, /co-stat-void/, 'no filler tiles are rendered');
});

test('a live quote scales the price-derived numbers off the committed close', () => {
  const { ui } = loadApp();
  const base = { price: 100, marketCap: 1000, pe: 20, chgYtd: 10 };
  assert.equal(ui.liveRef('us', 'aapl', base), 'data-qref="us:AAPL"');
  assert.equal(ui.LIVE_BASE.get('us:AAPL'), base, 'the base is kept for every later tick');

  // +10% price: a 10% YTD return becomes 21%, and P/E scales by 1.1.
  assert.ok(Math.abs(ui.liveChg(10, 1.1) - 21) < 0.001);
  assert.equal(ui.liveChg(null, 1.1), null);

  const ratio = { textContent: '10.00×' };
  ui.setMetricText(ratio, 12.345, '×');
  assert.equal(ratio.textContent, '12.35×', 'keeps the page’s two-decimal multiple');
  const oneDp = { textContent: '10.0' };
  ui.setMetricText(oneDp, 12.345, '');
  assert.equal(oneDp.textContent, '12.3', 'keeps the page’s one-decimal multiple');
  const pct = { textContent: '5.0%' };
  ui.setMetricText(pct, 5.555, '%');
  assert.equal(pct.textContent, '5.6%');
  const annotated = { textContent: '9.70× sector 10.1×' };
  ui.setMetricText(annotated, 9.94, '×');
  assert.equal(annotated.textContent, '9.94× sector 10.1×', 'keeps the sector annotation');
});

test('a live quote patches a home-screener row by column', () => {
  const { ui } = loadApp();
  const cell = () => ({ textContent: '', classList: { remove() {}, add() {} } });
  const cells = Array.from({ length: 9 }, cell);
  const row = { children: cells };
  const base = { price: 100, marketCap: 1000, pe: 20, pb: 2, chg6m: 5, chgYtd: 10, priceAsOf: '2026-11-06' };
  ui.LIVE_BASE.set('us:AAPL', base);
  ui.patchQuoteHomeRow(row, 'us:AAPL', { price: 110, chg1d: 10, time: '2026-11-09T21:00:00.000Z' });
  assert.equal(cells[1].textContent, '$110.00');
  assert.equal(cells[2].textContent, '+10.0%');
  assert.ok(Math.abs(parseFloat(cells[3].textContent) - 15.5) < 0.01, '6M scales with the price');
  assert.ok(Math.abs(parseFloat(cells[4].textContent) - 21) < 0.01, 'YTD scales with the price');
  assert.equal(cells[5].textContent, '22.0×');
  assert.equal(cells[6].textContent, '2.20×');
  assert.equal(cells[8].textContent, '$1100');
});

test('an out-of-range window falls back to one the series actually covers', () => {
  const { ui } = loadApp();
  const dates = [];
  for (let i = 0; i < 400; i++) dates.push(new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const full = { dates, closes: dates.map((_, i) => 100 + i) };
  const used = ui.drawMarketIndexChart('kr-mkt', full, '5y', 'krmkt', 'KOSPI');
  assert.equal(used, '1y', 'a one-year series switches to 1Y rather than faking five');
});

test('the US market page paints before the index quote arrives', () => {
  const { ui, document } = loadApp();
  ui.setCompanies({ valuation: {}, universe: { name: 'S&P 1500' }, companies: [] });
  const el = document.getElementById('co-body');
  ui.renderUsMarket(el, [], 0);
  // The quote request is still in flight (the stub fetch never settles); the page must already be
  // the S&P 1500 — not whatever market was on screen before the click.
  assert.match(el.innerHTML, /S&amp;P 1500/);
  assert.match(el.innerHTML, /id="us-mkt-quote"/);
});

// --- formatting helpers ------------------------------------------------------------------------


test('the Japan flow, calendar and dividend helpers render cleanly', () => {
  const { ui } = loadApp();
  const flow = {
    updated: '2026-10-30',
    w4: { foreign: 1.34e12, individual: -1.85e11, invTrust: -2.06e11, brokerage: 7.62e11, proprietary: -7.23e11, total: 3.65e14 },
    weeks: [{ d: '2026-10-30', foreign: 1.34e12 }],
  };
  const panel = ui.jpFlowPanel(flow);
  assert.match(panel, /WHO IS BUYING/);
  assert.match(panel, /FOREIGN/);
  assert.match(panel, /Foreigners bought/);
  assert.match(ui.jpCalendarLine({ today: { d: '2026-11-10', open: false }, nextSession: { d: '2026-11-11', halfDay: false }, holidays: [{ d: '2026-11-23' }] }), /NEXT SESSION/);
  assert.match(ui.jpFlowContext(flow), /whole Prime market/);
  assert.match(ui.jpFlowMini(flow), /4W FOREIGN/);
  const ladder = ui.jpDividendLadder({ dividend: { perShare: 95, periods: [{ label: 'Interim', value: 45 }, { label: 'Year-end', value: 50 }], nextYear: 100, growthPct: 5.3, payoutRatio: 0.32 } });
  assert.match(ladder, /DIVIDEND LADDER/);
  assert.match(ladder, /Interim/);
  assert.match(ladder, /Next year/);
});
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

test('property and REIT EPS growth is labelled statutory', () => {
  const { ui } = loadApp();
  const swire = { sector: 'Real Estate', industry: 'Real Estate Services', cagrYears: 4 };
  assert.equal(ui.epsGrowthLabel(swire), 'EPS GROWTH · 4Y · STATUTORY');
  assert.match(ui.epsGrowthNote(swire), /investment-property fair-value changes/);
  assert.match(ui.epsGrowthNote(swire), /underlying profit can differ materially/);

  const reit = { sector: 'Equity Real Estate Investment Trusts (REITs)', industry: 'REIT - Diversified' };
  assert.equal(ui.epsGrowthLabel(reit), 'EPS GROWTH · STATUTORY');

  const bank = { sector: 'Financials', industry: 'Banks', cagrYears: 4 };
  assert.equal(ui.epsGrowthLabel(bank), 'EPS GROWTH · 4Y', 'non-property names are not labelled');
  assert.equal(ui.epsGrowthNote(bank), '');
});

test('all ten markets are reachable in the COMPANIES navigation', () => {
  // The row is a deliberate horizontal scroll on a phone; every region must be present, and the
  // active one is scrolled into view so a saved newer market is not left off-screen.
  const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');
  for (const region of ['us', 'jp', 'kr', 'tw', 'hk', 'au', 'in', 'id', 'br', 'za']) {
    assert.match(html, new RegExp(`data-region="${region}"`), `${region} region button is missing`);
  }
  const css = fs.readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.co-region \{[^}]*overflow-x: auto/s, 'the market row must scroll sideways');
  const app = fs.readFileSync(APP, 'utf8');
  assert.match(app, /function scrollActiveIntoView/, 'the active market must be scrolled into view');
});


test('each market loader fetches its own endpoint', () => {
  // Brazil shipped loading /api/southafrica: the B3 tab painted the JSE list, then every company
  // click asked the Brazil company route for a JSE code and failed. Guard the whole loader set.
  const app = fs.readFileSync(APP, 'utf8');
  const loaders = {
    loadJapan: '/api/japan',
    loadKorea: '/api/korea',
    loadTaiwan: '/api/taiwan',
    loadHongKong: '/api/hongkong',
    loadAustralia: '/api/australia',
    loadIndia: '/api/india',
    loadIndonesia: '/api/indonesia',
    loadBrazil: '/api/brazil',
    loadSouthAfrica: '/api/southafrica',
    loadCompanies: '/api/companies',
  };
  for (const [fn, endpoint] of Object.entries(loaders)) {
    const start = app.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, `${fn} is missing`);
    const next = app.indexOf('\nasync function ', start + 1);
    const body = app.slice(start, next < 0 ? undefined : next);
    assert.ok(body.includes(`'${endpoint}'`), `${fn} does not fetch ${endpoint}`);
  }
  const brStart = app.indexOf('async function loadBrazil(');
  const brEnd = app.indexOf('\nasync function ', brStart + 1);
  const brBody = app.slice(brStart, brEnd < 0 ? undefined : brEnd);
  assert.doesNotMatch(brBody, /\/api\/southafrica/, 'Brazil still reads the South Africa feed');
});


test('the JSE chart uses the same six windows as every other market', () => {
  // The JSE page used to expose a seventh MAX chip. It now shares the 1M–5Y controls and
  // the coFitRange fallback with Japan, Korea, Taiwan, Hong Kong, Australia, India,
  // Indonesia and Brazil. A stored MAX preference must fall back to 1Y, not resurrect it.
  const app = fs.readFileSync(APP, 'utf8');
  const start = app.indexOf('data-zarange');
  assert.ok(start >= 0, 'ZA range controls are missing');
  const arrStart = app.lastIndexOf('[[', start);
  const arrEnd = app.indexOf('].map', arrStart);
  const chip = app.slice(arrStart, arrEnd + 1);
  assert.match(chip, /'1m'/);
  assert.match(chip, /'5y'/);
  assert.doesNotMatch(chip, /'max'/);
  assert.match(app, /paintReturns\('za-rets', 'za-big', full, range, WINDOWS_5Y, 'zarange'\)/);
  assert.match(app, /const use = full \? coFitRange\(full, range\) : range;/);
  assert.doesNotMatch(app, /use = 'max'/);
  assert.match(app, /\['1m', '3m', '6m', 'ytd', '1y', '5y'\]\.includes\(v\) \? v : '1y'/);
});

test('the local quick index ranks exact names, brands and codes without a request', () => {
  const { ui } = loadApp();
  ui.setGsQuick({
    markets: { us: { label: 'United States', flag: '\u{1F1FA}\u{1F1F8}' }, br: { label: 'Brazil', flag: '\u{1F1E7}\u{1F1F7}' } },
    entries: [
      { market: 'us', id: '1', ticker: 'AAPL', code: 'AAPL', name: 'Apple Inc.', nameEn: 'Apple Inc.', capUsd: 3e12, hay: 'apple inc apple inc aapl', codes: ['AAPL'] },
      { market: 'us', id: '2', ticker: 'APLE', code: 'APLE', name: 'Apple Hospitality', nameEn: 'Apple Hospitality', capUsd: 2e9, hay: 'apple hospitality apple hospitality aple', codes: ['APLE'] },
      { market: 'br', id: 'ROXO34', ticker: 'ROXO34', code: 'ROXO34', name: 'Nu Holdings', nameEn: 'Nu Holdings', capUsd: 5e10, hay: 'nu holdings nu holdings roxo34 nubank', codes: ['ROXO34'] },
    ],
  });
  assert.equal(ui.gsQuickSearch('apple').results[0].ticker, 'AAPL');
  assert.equal(ui.gsQuickSearch('nubank').results[0].market, 'br');
  assert.equal(ui.gsQuickSearch('aapl').results[0].ticker, 'AAPL');
  assert.equal(ui.gsQuickSearch('nothing-here-xyz').total, 0);
});
