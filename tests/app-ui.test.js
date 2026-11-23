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

// A real-enough storage for the watchlist tests; a fresh context gets a fresh store.
function memoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
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
    localStorage: memoryStore(),
    sessionStorage: memoryStore(),
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
    esc, safeHref, attrBlock, gbSectors, gbScreenerShell, hmScreenerShell,
    pctf, cls, ago, deltaStrip, renderRisk, renderRelValue, tileSignals, curveShort, renderInventories,
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
    renderUsThemes,
    offIndexAsUs,
    renderHongKongMarket,
    hkBalanceSheetFinancial,
    liveRef, liveChg, setMetricText, LIVE_BASE, patchQuoteHomeRow,
    drawMarketIndexChart,
    jpFlowPanel, jpFlowContext, jpFlowMini, jpCalendarLine, jpDividendLadder,
    coWindowsFor,
    coWindow,
    coSlice,
    coFitRange,
    mergeLongSeries,
    charts,
    applyTheme,
    CT,
    getTheme: () => currentTheme,
    gsQuickSearch,
    setGsQuick: (v) => { gsQuick = v; },
    renderHomeIdeas,
    hmApplyIdea,
    gbPagerHtml,
    isBootDeepLink,
    loadBrief,
    offTag,
    renderOffIndexPage,
    watchlist, toggleWatch, renderWatchlist, CO_WATCH,
    getBriefPayload: () => briefPayload,
    setBriefBusy: (v) => { briefBusy = v; },
    setBriefPayload: (v) => { briefPayload = v; },
    getHomeIdeaState: () => ({ mode: screenMode, filters: { ...hmScr }, sort: hmScrSort, page: hmScrPage }),
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

test('a small listing keeps the long window when it has at least a year of prices', () => {
  const { ui } = loadApp();
  const dates = ['2022-06-29', '2026-11-10'];   // 4.37 years: enough for four, not five
  const closes = [100, 200];
  assert.equal(ui.coFitRange({ dates, closes }, '5y'), '5y', '5Y must not drop to 1Y');
  assert.equal(ui.coFitRange({ dates, closes }, '10y'), '10y', '10Y keeps the requested window and labels the actual coverage');
  assert.equal(ui.coFitRange({ dates: ['2020-01-01', '2026-01-01'], closes }, '10y'), '10y');
  assert.equal(ui.coFitRange({ dates: ['2026-01-01', '2026-06-30'], closes }, '5y'), '5y');
  assert.equal(ui.coFitRange({ dates: ['2026-10-01', '2026-11-10'], closes }, '5y'), '5y');
  const sparse = ui.coSlice({ dates: ['2026-09-01', '2026-11-01'], closes: [100, 101] }, '1m');
  assert.equal(sparse.dates.length, 2, 'a sparse line still draws its last two points');
  const merged = ui.mergeLongSeries([
    { dates: ['2020-01-01', '2026-11-06'], closes: [10, 20] },
    { dates: ['2025-01-01', '2026-11-11'], closes: [15, 21] },
  ]);
  assert.equal(merged.dates.join(','), '2020-01-01,2025-01-01,2026-11-06,2026-11-11');
  assert.equal(merged.closes.at(-1), 21, 'the newest source wins on a shared date');
});

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
  assert.equal(cells[8].textContent, '$1K');
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

test('home idea cards open their own company screen instead of a stale company page', () => {
  const { ui, document } = loadApp();
  ui.renderHomeIdeas({ ideas: { cheap: 12, filings: 3, quality: 8 } });
  const html = document.getElementById('home-ideas').innerHTML;
  assert.match(html, /<button[^>]+class="home-idea"[^>]+data-hm-idea="cheap"/);
  assert.match(html, /data-hm-idea="quality"/);
  assert.doesNotMatch(html, /data-tab="deals"/, 'an idea must not reopen the last selected company');

  ui.hmApplyIdea('quality');
  const state = ui.getHomeIdeaState();
  assert.equal(state.mode, 'companies');
  assert.equal(state.page, 1);
  assert.equal(state.sort, 'roe');
  assert.equal(state.filters.roeMin, '15');
  assert.equal(state.filters.peMax, 20);

  // The cheap card is a percentile screen, not an absolute P/E < 15 screen. The screener must
  // apply the same filter (and show a chip explaining it), not a different one.
  ui.hmApplyIdea('cheap');
  const cheap = ui.getHomeIdeaState();
  assert.equal(cheap.filters.pePctMax, 20);
  assert.equal(cheap.filters.peMax, 0);
  ui.hmApplyIdea('filings');
  const filings = ui.getHomeIdeaState();
  assert.equal(filings.filters.filingsOnly, true);
  assert.equal(filings.filters.market, 'us');
});

test('idea/screener presets are explained and the shell is labelled for assistive tech', () => {
  const { ui } = loadApp();
  const shell = ui.gbScreenerShell({ markets: [{ id: 'us', label: 'United States' }] });
  assert.match(shell, /id="gb-activefilters"/);
  for (const id of ['gb-f-market', 'gb-f-sector', 'gb-f-pe', 'gb-f-roe', 'gb-f-cap', 'gb-f-ytd', 'gb-f-q']) {
    assert.match(shell, new RegExp(`id="${id}"[^>]*aria-label=`, 'i'), `${id} needs an accessible name`);
  }
  const hm = ui.hmScreenerShell();
  assert.match(hm, /id="hm-activefilters"/);
  assert.match(hm, /id="hm-f-q"[^>]*aria-label=/);
});

test('sector allocation divides by total market cap, not by the top-eight subtotal', () => {
  const { ui } = loadApp();
  const html = ui.gbSectors({ sectors: [{ name: 'Technology', cap: 34 }, { name: 'Energy', cap: 6 }], totalCapUsd: 100 });
  assert.match(html, /Technology/);
  assert.match(html, /34%/, 'Technology is 34% of the whole market');
  assert.match(html, /top 8 · share of total market cap/);
});

test('external news is escaped and non-http links are refused', () => {
  const { ui } = loadApp();
  assert.equal(ui.safeHref('javascript:alert(1)'), '#');
  const html = ui.attrBlock({
    y1: 12.3,
    drivers: [{ kind: 'OPEC <b>x</b>', count: 1, sample: {
      url: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)>', source: '<script>x</script>', date: '2026-01-02',
    } }],
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /href="#"/);
});

test('global and home screeners use bounded previous and next pages', () => {
  const { ui } = loadApp();
  const first = ui.gbPagerHtml(125, 1, 50, 'hmpage');
  assert.match(first, /PAGE 1 OF 3/);
  assert.match(first, /data-hmpage="0" disabled/);
  assert.match(first, /data-hmpage="2"/);
  assert.match(first, /NEXT PAGE/);
  assert.doesNotMatch(first, /SHOW MORE/);
  const last = ui.gbPagerHtml(125, 3, 50, 'gbpage');
  assert.match(last, /data-gbpage="2"/);
  assert.match(last, /data-gbpage="4" disabled/);
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


test('Japan puts the fiscal-year record before the quarterly matrix, like every other market', () => {
  const app = fs.readFileSync(APP, 'utf8');
  const start = app.indexOf('function renderJapanPageBody');
  const end = app.indexOf('function jpHistoryHtml');
  assert.ok(start > 0 && end > start);
  const body = app.slice(start, end);
  const fiscal = body.indexOf('+ jpHistoryHtml(c)');
  const quarterly = body.indexOf("+ periodMatrixHtml(c, { market: 'jp'");
  assert.ok(fiscal > 0 && quarterly > 0, 'both sections are rendered');
  assert.ok(fiscal < quarterly, 'the fiscal-year record must come first');
});

test('a reload on the Companies tab lands on HOME, but real deep links survive', () => {
  const { ui } = loadApp();
  // The bare tab route is not a deep link: reloading the global board must not reopen it.
  assert.equal(ui.isBootDeepLink('#/deals'), false);
  assert.equal(ui.isBootDeepLink('#/deals/'), false);
  assert.equal(ui.isBootDeepLink('#/companies'), false);
  assert.equal(ui.isBootDeepLink('#/home'), false);
  assert.equal(ui.isBootDeepLink('#/commodities/crude'), false);
  // Real sub-routes still survive a cold load or a pasted link.
  assert.equal(ui.isBootDeepLink('#/companies/us/company/320193'), true);
  assert.equal(ui.isBootDeepLink('#/companies/search/apple'), true);
  assert.equal(ui.isBootDeepLink('#/deals/sector/energy'), true);
});

test('desktop market tabs grow to the search-box edge', () => {
  const css = fs.readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /#co-region\s*\{\s*flex:\s*1 1 auto\s*\}/, 'the tab strip fills the row');
  assert.match(css, /#co-region button\s*\{\s*flex:\s*1 0 auto/, 'the tabs share the extra width without shrinking');
  assert.match(css, /#co-region::after\s*\{\s*display:\s*none\s*\}/, 'the scroll spacer must not leave a trailing gap');
  assert.match(css, /\.co-nav\s*\{\s*padding:\s*12px 12px 0/, 'the tab row shares the search-box insets');
});

test('the brief divider belongs to the two-column block, not the lead story', () => {
  const css = fs.readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /#pane-home #p-brief-more\s*\{\s*border-top:\s*1px solid var\(--line\)/, 'the two-card block owns a visible rule');
  assert.match(css, /#pane-home #p-brief-more\s*\{\s*padding-top:\s*8px/, 'the rule sits in the middle of the gap');
  assert.match(css, /\.home-brief-grid\s*\{\s*row-gap:\s*8px/, 'the gap is split around the rule');
  assert.match(css, /#p-brief-more \.brief-mini \+ \.brief-mini::before\s*\{[^}]*bottom:\s*8px[^}]*background:\s*var\(--line\)/s, 'the vertical divider is inset from the closing rule');
  assert.match(css, /\.imp-list\s*\{\s*border-bottom:\s*0/, 'the lead story must not float its own rule above the gap');
});

test('the US company chart controls stay outside the fixed-height chart frame', () => {
  // On a phone the chart frame is 270px. Compare + the seven range chips + the return strip used
  // to live inside it, wrapped to ~184px and left a 37px chart. They belong above the frame, as
  // they already do in the other nine markets.
  const app = fs.readFileSync(APP, 'utf8');
  assert.doesNotMatch(app, /<div class="co-chartwrap">\s*<div class="co-ranges">/);
  assert.match(app, /<div class="co-rets" id="co-rets"><\/div>\s*<div class="co-chartwrap"><div class="co-canvas">/);
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

test('the theme toggle switches the document and chart palette without a reload', () => {
  const { ui, document } = loadApp();
  assert.equal(ui.getTheme(), 'dark');
  const darkLine = ui.CT.c1;
  ui.applyTheme('light');
  assert.equal(ui.getTheme(), 'light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.notEqual(ui.CT.c1, darkLine);
  assert.equal(ui.CT.tooltipBg, '#173d32');
  ui.applyTheme('dark');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(ui.CT.c1, darkLine);
});

test('net profit is a result, not a profitability ratio', () => {
  const src = fs.readFileSync(APP, 'utf8');
  for (const fn of ['renderAustraliaPage', 'renderIndiaPage', 'renderIndonesiaPage', 'renderBrazilPage', 'renderSouthAfricaPage']) {
    const start = src.indexOf(`async function ${fn}`);
    assert.ok(start > 0, `${fn} is missing`);
    const end = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, end > 0 ? end : start + 30000);
    const prof = body.indexOf('>Profitability<');
    const res = body.indexOf('>Results<');
    assert.ok(prof > 0 && res > 0, `${fn} lost a section`);
    const profEnd = body.indexOf('<div class="co-sect"', prof + 1);
    const resEnd = body.indexOf('<div class="co-sect"', res + 1);
    assert.doesNotMatch(body.slice(prof, profEnd), /NET PROFIT/, `${fn} still puts net profit in Profitability`);
    assert.match(body.slice(res, resEnd), /NET PROFIT/, `${fn} lost net profit from Results`);
  }
});

test('cash-flow amounts live in Cash flow, not Results', () => {
  const src = fs.readFileSync(APP, 'utf8');
  const pages = ['renderAustraliaPage', 'renderIndiaPage', 'renderIndonesiaPage', 'renderBrazilPage', 'renderSouthAfricaPage', 'renderTaiwanPage', 'renderKoreaPage', 'renderHongKongPage'];
  for (const fn of pages) {
    const start = src.indexOf(`async function ${fn}`);
    assert.ok(start > 0, `${fn} is missing`);
    const end = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, end > 0 ? end : start + 30000);
    const resultsAt = body.indexOf('>Results<');
    const cashAt = body.indexOf('>Cash flow');
    assert.ok(resultsAt > 0 && cashAt > 0, `${fn} lost Results or Cash flow`);
    const resultsEnd = body.indexOf('<div class="co-sect"', resultsAt + 1);
    const cashEnd = body.indexOf('<div class="co-sect"', cashAt + 1);
    const results = body.slice(resultsAt, resultsEnd);
    const cash = body.slice(cashAt, cashEnd);
    assert.doesNotMatch(results, /FREE CASH FLOW|CASH AFTER INVESTING/, `${fn} still puts a cash-flow amount in Results`);
    assert.match(cash, /FREE CASH FLOW|CASH AFTER INVESTING/, `${fn} has no free-cash-flow amount in Cash flow`);
  }
});

// --- the daily brief (shipped regression) ------------------------------------------------------
// "Sometimes the brief is broken on load and I have to reload." /api/brief is the only
// above-the-fold JSON with real work behind it (event pool + wire matching), and fetch has no
// deadline: a stalled request left "Reading the day…" in a card as tall as the calendar until the
// page was reloaded. The loader now bounds each attempt, retries, keeps the copy already on screen,
// and schedules one late retry so the desk heals without the reader doing anything.

const BRIEF_OK = { updated: '2026-11-17T00:00:00Z', events: [], rows: [], macro: [], happened: [], hero: null };
const LATE_RETRY = 30000;

function briefCtx() {
  const app = loadApp();
  // The page's own boot starts a brief request with the harness' never-resolving fetch; take the
  // loader back so the test drives it.
  app.ui.setBriefBusy(false);
  app.ui.setBriefPayload(null);
  const timers = [];
  app.window.setTimeout = (fn, ms = 0) => { timers.push({ fn, ms }); return timers.length; };
  app.window.clearTimeout = () => {};
  const step = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  // Run the short backoffs, leave the 30-second late retry queued.
  const drain = async () => {
    let guard = 0;
    for (;;) {
      const i = timers.findIndex((t) => t.ms < LATE_RETRY);
      if (i < 0 || guard++ > 20) return;
      const [t] = timers.splice(i, 1);
      t.fn();
      await step();
    }
  };
  return { ...app, timers, step, drain };
}

test('the brief retries a stalled request instead of waiting for a reload', async () => {
  const { ui, window, document, step, drain } = briefCtx();
  let calls = 0;
  window.fetch = async () => {
    calls += 1;
    if (calls <= 2) throw new Error('the host was asleep');
    return { ok: true, json: async () => BRIEF_OK };
  };
  const done = ui.loadBrief();
  await step();
  await drain();
  await done;
  assert.equal(calls, 3, 'two stalls are retried without the reader reloading');
  assert.match(document.getElementById('home-brief').innerHTML, /No ranked story today/);
  assert.deepEqual(ui.getBriefPayload(), BRIEF_OK);
});

test('a failed refresh never blanks the brief already on screen', async () => {
  const { ui, window, document, step, drain } = briefCtx();
  let fail = false;
  window.fetch = async () => {
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => BRIEF_OK };
  };
  const first = ui.loadBrief();
  await step();
  await drain();
  await first;
  const painted = document.getElementById('home-brief').innerHTML;
  assert.match(painted, /No ranked story today/);

  fail = true;
  const second = ui.loadBrief();
  await step();
  await drain();
  await second;
  assert.equal(document.getElementById('home-brief').innerHTML, painted, 'the reader keeps the copy they were reading');
});

test('a brief that never answers asks for one more go by itself', async () => {
  const { ui, window, timers, step, drain } = briefCtx();
  let calls = 0;
  window.fetch = async () => { calls += 1; throw new Error('dead'); };
  const done = ui.loadBrief();
  await step();
  await drain();
  await done;
  assert.equal(calls, 3, 'three bounded attempts, not an endless spinner');
  assert.equal(timers.filter((t) => t.ms >= LATE_RETRY).length, 1, 'and one late retry is queued instead of asking for a reload');
});

test('an off-index screener row is tagged, an index member is not', () => {
  const { ui } = loadApp();
  assert.match(ui.offTag({ off: true, why: 'Listed 19 Nov 2026 · not an index constituent yet' }), /class="gb-off"/);
  assert.match(ui.offTag({ off: true }), /OFF-INDEX/);
  assert.match(ui.offTag({ off: true, preIpo: true, why: 'IPO filed' }), /PRE-IPO/);
  assert.equal(ui.offTag({ off: false, t: 'AAPL' }), '', 'an index member carries no tag');
  assert.equal(ui.offTag(null), '');
});

test('a US theme shows the off-index names it claims, tagged', () => {
  const { ui, document } = loadApp();
  const aapl = { cik: '1', ticker: 'AAPL', name: 'Apple Inc.', marketCap: 3e12, pe: 30, revenue: 4e11, netIncome: 1e11, roe: 100, chgYtd: 10 };
  const spcx = { cik: '2', ticker: 'SPCX', name: 'Space Exploration Technologies Corp.', marketCap: 1.7e12, pe: null, revenue: 3.2e10, netIncome: -2.7e9, roe: null, chgYtd: null, why: 'Listed 12 Jun 2026 · not an index constituent yet' };
  ui.setCompanies({
    companies: [aapl], offIndex: [spcx],
    themes: [{ id: 'ai', label: 'AI & SEMICONDUCTORS', tickers: ['AAPL'], off: ['SPCX'], note: '' }],
  });
  ui.renderUsThemes(document.getElementById('co-body'), [aapl]);
  const html = document.getElementById('co-body').innerHTML;
  assert.match(html, /SPCX/);
  assert.match(html, /OFF-INDEX/);
  assert.match(html, /Space Exploration Technologies/);
});

test('an off-index page with a TTM shows the annual record and a meaningful ROE', () => {
  const { ui, document } = loadApp();
  const el = document.getElementById('co-body');
  const q = [
    { end: '2025-03-31', fy: 2025, q: 1, revenue: 4.067e9, netIncome: -0.528e9, eps: -0.18 },
    { end: '2025-06-30', fy: 2025, q: 2, revenue: 4.071e9, netIncome: -1.008e9, eps: -0.34 },
    { end: '2025-09-30', fy: 2025, q: 3, revenue: 5.576e9, netIncome: -1.054e9, eps: -0.36 },
    { end: '2025-12-31', fy: 2025, q: 4, revenue: 4.96e9, netIncome: -2.347e9, eps: null },
    { end: '2026-03-31', fy: 2026, q: 1, revenue: 4.694e9, netIncome: -4.276e9, eps: -1.27 },
    { end: '2026-06-30', fy: 2026, q: 2, revenue: 7.814e9, netIncome: -0.541e9, eps: -0.09 },
    { end: '2026-09-30', fy: 2026, q: 3, revenue: 14.575e9, netIncome: 4.404e9, eps: 0.35 },
  ];
  ui.renderOffIndexPage(el, {
    ticker: 'SPCX', name: 'SpaceX', price: 127.79, chg1d: -7.69, chg6m: null, ytd: null, vsIpo: -5.34,
    marketCap: 1735e9, ipoPrice: 135, listedAt: '2026-06-12', priceDate: '2026-11-20',
    cik: '1181412', sector: 'Technology', industry: 'Computer Software', exchange: 'NASDAQ',
    pe: null, roe: -1583, netMargin: -342.7, revenueCagr: 955.8,
    financials: {
      ttm: { end: '2026-09-30', revenue: 35.282e9, netIncome: -120.896e9, equity: 7.637e9, assets: 154.32e9 },
      fy: { end: '2025-12-31', revenue: 4.585e9, netIncome: -41.965e9 },
      latest: { start: '2026-01-01', end: '2026-09-30', revenue: 33.242e9, netIncome: -104.039e9 },
      quarters: q,
      annual: [
        { end: '2023-12-31', revenue: 41e6, netIncome: -1.531e9 },
        { end: '2024-12-31', revenue: 386e6, netIncome: -8.309e9 },
        { end: '2025-12-31', revenue: 4.585e9, netIncome: -41.965e9 },
      ],
      source: 'stockanalysis.com (S-1/prospectus)',
      latestFiling: null,
    },
  });
  const html = el.innerHTML;
  assert.match(html, /REVENUE · TTM/);
  assert.match(html, /NET PROFIT · TTM/);
  assert.match(html, /REVENUE CAGR/);
  assert.match(html, /QUARTERLY RESULTS/);
  assert.match(html, /data-costar="us:SPCX"/, 'the off-index page carries the same watchlist star as a US page');
  assert.match(html, /co-star-t">WATCH/, 'and it starts unpinned');
  const chartAt = html.indexOf('id="co-chart"');
  const noteAt = html.indexOf('Latest filing:');
  const fyAt = html.indexOf('FISCAL-YEAR RECORD');
  const qAt = html.indexOf('QUARTERLY RESULTS');
  assert.ok(chartAt > -1 && chartAt < noteAt && noteAt < fyAt && fyAt < qAt,
    'the US order is chart → filing note → fiscal-year record → quarterly matrix');
  assert.match(html, /n\/m/, 'an extreme ROE is labelled not meaningful');
  assert.doesNotMatch(html, /-1583\.0%/);
});

test('an off-index page fills the same six sections as an index page as its data lands', () => {
  const { ui, document } = loadApp();
  const el = document.getElementById('co-body');
  const thin = {
    ticker: 'TEST', cik: '9', name: 'Test Co', price: 10, chg1d: 1, vsIpo: 2, ipoPrice: 9,
    listedAt: '2026-11-01', marketCap: 1e11, sector: 'Technology', exchange: 'NASDAQ',
    financials: {
      source: 'SEC XBRL',
      ttm: { end: '2026-09-30', revenue: 5e9, netIncome: 5e8, equity: 4e9, assets: 8e9 },
      fy: { end: '2025-12-31', revenue: 4e9, netIncome: 4e8 },
      annual: [
        { end: '2024-12-31', revenue: 3e9, netIncome: 3e8, eps: 0.3 },
        { end: '2025-12-31', revenue: 4e9, netIncome: 4e8, eps: 0.4 },
      ],
      quarters: [],
    },
  };
  ui.renderOffIndexPage(el, thin);
  const a = el.innerHTML;
  // The same six section headers a US index page renders, not a bespoke off-index layout.
  for (const s of ['Valuation', 'Leverage', 'Profitability', 'Results', 'Cash &amp; return', 'Growth']) {
    assert.ok(a.includes(`<div class="co-sect">${s}</div>`), `missing ${s}`);
  }
  assert.match(a, /ASSET TURNOVER[\s\S]{0,160}0\.63×/, 'derived from revenue ÷ assets');
  const evBefore = a.slice(a.indexOf('ENTERPRISE VALUE'));
  assert.match(evBefore.slice(0, 220), />—</, 'no debt or cash on file, so enterprise value is a dash');

  // The same record once the balance sheet and cash-flow legs are extracted.
  ui.renderOffIndexPage(el, {
    ...thin,
    debt: 6e9, cash: 2e9, ebitdaTTM: 1.5e9,
    operatingCashFlow: 1.2e9, capex: 0.2e9,
    currentAssets: 3e9, currentLiabilities: 2e9,
  });
  const b = el.innerHTML;
  const evAfter = b.slice(b.indexOf('ENTERPRISE VALUE'));
  assert.doesNotMatch(evAfter.slice(0, 220), />—</, 'enterprise value fills in without a UI change');
  assert.match(b, /CURRENT RATIO[\s\S]{0,160}1\.50/);
  assert.match(b, /EV \/ EBITDA[\s\S]{0,160}69\.3/, 'enterprise value ÷ EBITDA');
  assert.match(b, /FREE CASH FLOW[\s\S]{0,200}\$1\.0B/);
});

test('the off-index mapping derives every ratio from the filed lines', () => {
  const { ui } = loadApp();
  const rec = ui.offIndexAsUs({
    ticker: 'X', cik: '1', name: 'X', price: 10, capUsd: 100e9, shares: 10e9,
    sector: 'Technology', status: 'listed',
    financials: {
      source: 'SEC XBRL',
      ttm: { end: '2026-09-30', revenue: 50e9, netIncome: 5e9, equity: 25e9, assets: 100e9 },
      fy: { end: '2025-12-31', revenue: 40e9, netIncome: 4e9 },
      annual: [
        { end: '2024-12-31', revenue: 30e9, netIncome: 3e9, eps: 0.3 },
        { end: '2025-12-31', revenue: 40e9, netIncome: 4e9, eps: 0.4 },
      ],
      quarters: [],
      balanceEnd: '2026-09-30',
    },
    debt: 10e9, cash: 20e9, currentAssets: 30e9, currentLiabilities: 15e9,
    ebitdaTTM: 8e9, ebitTTM: 6e9, operatingCashFlow: 7e9, capex: 2e9,
    dividendsPaid: 1e9, buybacks: 1e9,
  });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  near(rec.marketCap, 100e9);
  near(rec.ev, 90e9);                 // cap + debt − cash
  near(rec.pb, 4);                    // cap / equity
  near(rec.evEbitda, 11.25);          // EV / EBITDA
  near(rec.currentRatio, 2);          // current assets / current liabilities
  near(rec.debtEquity, 0.4);          // debt / equity
  near(rec.netDebtEbitda, -1.25);     // (debt − cash) / EBITDA
  near(rec.roic, 33.3333333333);      // profit / (equity + debt − cash)
  near(rec.ebitYield, 6.6666666667);  // EBIT / EV
  near(rec.assetTurnover, 0.5);       // revenue / assets
  near(rec.fcf, 5e9);                 // operating cash flow − capex
  near(rec.fcfYield, 5);              // FCF / cap
  near(rec.cashConversion, 1);        // FCF / profit
  near(rec.shareholderYield, 2);      // (dividends + buybacks) / cap
  near(rec.roe, 20);                  // profit / equity
  near(rec.netMargin, 10);            // profit / revenue
  near(rec.epsCagr, 33.3333333333);   // 0.30 → 0.40 over one year
});

test('the off-index mapping refuses ratios that would read as meaningful', () => {
  const { ui } = loadApp();
  const base = {
    ticker: 'Y', cik: '2', name: 'Y', capUsd: 10e9, sector: 'Technology',
    financials: {
      source: 'SEC XBRL', quarters: [],
      ttm: { end: '2026-06-30', revenue: 1e9, netIncome: -5e9, equity: 1e9, assets: 2e9 },
      balanceEnd: '2026-06-30',
    },
    debt: 1e9, cash: 1e9, ebitdaTTM: -1e9, ebitTTM: -1.2e9, operatingCashFlow: -1e9, capex: 0.5e9,
  };
  const r = ui.offIndexAsUs(base);
  assert.equal(r.evEbitda, null, 'a negative EBITDA has no multiple');
  assert.match(String(r.evEbitdaNA), /negative/);
  assert.equal(r.netDebtEbitda, null, 'and no years-of-EBITDA reading');
  assert.match(String(r.netDebtNA), /negative/);
  assert.equal(r.roic, null, 'a loss several times the capital base is not a return');
  assert.match(String(r.roicNA), /loss/);
  assert.equal(r.cashConversion, null, 'no cash conversion without a profit to convert');
  assert.equal(ui.offIndexAsUs({ ...base, cash: null }).ev, null, 'enterprise value needs both sides of the bridge');
  assert.equal(ui.offIndexAsUs({ ...base, ebitdaTTM: null }).evEbitda, null);
});

test('an off-index name can be pinned and renders in the home watchlist', () => {
  const { ui, document } = loadApp();
  const spcx = {
    cik: '1181412', ticker: 'SPCX', name: 'Space Exploration Technologies Corp.',
    price: 127.79, chg1d: -7.69, chg6m: null, chgYtd: null, marketCap: 1.7e12,
    pe: null, roe: null, offIndex: true,
  };
  ui.setCompanies({ companies: [], offIndex: [spcx], themes: [] });
  assert.equal(ui.CO_WATCH.us.find('SPCX')?.ticker, 'SPCX', 'the US resolver finds the off-index row');
  ui.toggleWatch('us:SPCX');
  assert.equal(ui.watchlist().join(','), 'us:SPCX');
  ui.renderWatchlist();
  const html = document.getElementById('home-watch').innerHTML;
  assert.match(html, /SPCX/);
  assert.match(html, /data-star="us:SPCX"/);
  assert.match(html, /data-cik="1181412"/);
  ui.toggleWatch('us:SPCX');
  assert.equal(ui.watchlist().length, 0, 'clicking the star again unpins it');
});

test('a pre-IPO page shows S-1 financials without inventing a quote', () => {
  const { ui, document } = loadApp();
  const el = document.getElementById('co-body');
  ui.renderOffIndexPage(el, {
    status: 'pre-ipo', preIpo: true, ticker: 'OURA', name: 'Oura', price: null, marketCap: null,
    listedAt: null, ipoPrice: null, exchange: 'NASDAQ', priceRange: [40, 44],
    why: 'IPO filed 21 Sep 2026 · not trading yet', sector: 'Consumer', industry: 'Wearable Technology',
    pe: null, roe: null, netMargin: 4.2, revenueGrowth: 123.2, revenueCagr: null,
    financials: {
      ttm: { end: '2026-09-30', revenue: 1424793000, netIncome: 59207000, equity: -1617734000, assets: 1063188000 },
      latest: { start: '2026-01-01', end: '2026-09-30', revenue: 1214506000, netIncome: 60768000 },
      fy: { end: '2025-12-31', revenue: 907856000, netIncome: 12000 },
      assets: 1063188000, equity: -1617734000, periodBasis: 'quarter',
      source: 'SEC S-1/A (pre-IPO)',
      latestFiling: { form: 'S-1/A', filed: '2026-09-21', url: 'https://www.sec.gov/Archives/x' },
      quarters: [
        { end: '2025-03-31', fy: 2025, q: 1, revenue: 232595000, netIncome: 12567000 },
        { end: '2025-06-30', fy: 2025, q: 2, revenue: 234290000, netIncome: 3007000 },
        { end: '2025-09-30', fy: 2025, q: 3, revenue: 230684000, netIncome: -14001000 },
        { end: '2025-12-31', fy: 2025, q: 4, revenue: 210287000, netIncome: -1561000 },
      ],
      annual: [
        { end: '2024-12-31', revenue: 406751000, netIncome: 3649000 },
        { end: '2025-12-31', revenue: 907856000, netIncome: 12000 },
      ],
    },
  });
  const html = el.innerHTML;
  assert.match(html, /PRE-IPO/);
  assert.match(html, /NOT TRADING YET/);
  assert.match(html, /EXPECTED PRICE RANGE/);
  assert.match(html, /REVENUE GROWTH/);
  assert.ok(html.indexOf('FISCAL-YEAR RECORD') > -1, 'the annual record is shown');
  assert.ok(html.indexOf('FISCAL-YEAR RECORD') < html.indexOf('QUARTERLY RESULTS'), 'the annual record comes before the quarterly matrix, like the US template');
  assert.doesNotMatch(html, /vs IPO/, 'a pre-IPO page does not compare against an IPO price');
  assert.doesNotMatch(html, /id="co-chart"/, 'and it does not draw a price chart');
});
