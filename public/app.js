const $ = (id) => document.getElementById(id);
const fmt = (n, dp = 2) => (n == null ? '—' : '$' + Number(n).toFixed(dp));
const signed = (n, dp = 2) => (n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(dp));
const pctf = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(1) + '%');
const cls = (n) => (n == null ? '' : n >= 0 ? 'pos' : 'neg');
const GAL = 42;
const ago = (iso) => { if (!iso) return ''; const s = Math.round((Date.now() - new Date(iso)) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

// Every price shows its move over the usual windows at once, not just today.
const HORIZONS = [['1D', 'd1'], ['1W', 'w1'], ['1M', 'm1'], ['YTD', 'ytd'], ['1Y', 'y1']];
function deltaStrip(d) {
  if (!d) return '';
  const cells = HORIZONS.map(([lab, k]) => {
    const v = d[k];
    return `<span class="dl"><i>${lab}</i><b class="${cls(v)}">${v == null ? '—' : pctf(v)}</b></span>`;
  }).join('');
  return `<span class="dstrip" title="change over 1 day · 1 week · 1 month · year-to-date · 1 year">${cells}</span>`;
}
// Same strip, but in basis points (for a yield, where a % move is meaningless).
function deltaStripRate(d) {
  if (!d) return '';
  const cells = HORIZONS.map(([lab, k]) => {
    const v = d[k];
    return `<span class="dl"><i>${lab}</i><b class="${cls(v)}">${v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}bp`}</b></span>`;
  }).join('');
  return `<span class="dstrip" title="change in basis points over 1 day · 1 week · 1 month · year-to-date · 1 year">${cells}</span>`;
}
// Source + as-of badge: which feed a number comes from and how current it is.
function freshBadge(source, asOf, lagDays) {
  if (!source && !asOf) return '';
  const lag = lagDays != null && lagDays >= 1 ? ` <em>${lagDays}d old</em>` : '';
  return `<span class="fresh">${source || 'live'}${asOf ? ` · ${asOf}` : ''}${lag}</span>`;
}
// The series the headline number uses (futures where it exists, else the real/spot price).
function headDeltas(b) { const dd = history?.deltas?.[b.id]; return dd ? (b.paper != null ? dd.paper : dd.physical) : null; }
function headSource(b) {
  return b.paper != null
    ? { source: b.paperSource, asOf: b.paperDate, lag: null }
    : { source: b.physicalSource, asOf: b.physicalDate, lag: b.spotLagDays };
}
function freshStrip(b) { const f = headSource(b); return freshBadge(f.source, f.asOf, f.lag); }

let data, history, analytics;
let tankerInfo = { status: {}, count: 0, tankers: [] };
let nextRefresh = 60;
let fxList = [];        // chartable currencies (from /api/fx)
let rateList = [];      // chartable rates (from /api/rates)
let markets = [];       // commodity markets (from /api/markets) — Big Picture groups
let currentMarket = 'crude';   // which segment the page is showing
let currentComponent = null;   // which instrument within the segment the READ reflects (null = the segment's headline)
let marketRead = null;         // /api/marketread payload for currentMarket
let lastFx = null;             // latest FX quotes (for the top ticker)
let macroMd = null;            // /api/macrodash payload (macro tab)
let macroRegion = 'us';        // selected macro region
let macroCountries = null;     // /api/countries — country lists per region
let macroCountry = 'us';       // selected country
let prefCountry = null;        // one-shot: the country to select on the next region render (restore)
let transmission = null;       // /api/transmission — cross-asset logic
let macroTickers = null;       // this region's macro tickers (currencies + indices) for the tape
let macroChart = null;         // per-country index vs currency chart
const countryCache = {};       // id -> { t, data } so switching is instant
const COUNTRY_FX_ID = { 'DX-Y.NYB': 'dxy', 'EURUSD=X': 'eurusd', 'GBPUSD=X': 'gbpusd', 'USDJPY=X': 'usdjpy', 'USDCNY=X': 'usdcny', 'USDINR=X': 'usdinr', 'AUDUSD=X': 'audusd' };
let chartDp = 2;        // decimals for the current chart (set in renderChart)
const seenAlerts = new Set();
let serverAlerts = [];  // /api/alerts — the server's alert engine (basis extremes, data checks, idle ships)
const CHART_TTL = 15 * 60e3;   // chart series re-fetch at most every 15 min (they used to cache forever)
const ltCache = {};

const GLOSSARY = `
  <dl>
    <dt>Prices</dt><dd>Live futures for every commodity. Energy also shows the <b>real</b> (spot) price.</dd>
    <dt>Premium / discount</dt><dd>How today's price compares with its <b>own history</b> — a big premium means it's near the top of its usual range.</dd>
    <dt>Supply &amp; demand</dt><dd><b>Undersupplied</b> (tight) → <b>oversupplied</b> (ample). Built from the curve, the real-vs-futures gap and stocks where available; “curve only” means it is market-implied.</dd>
    <dt>The curve</dt><dd>Prices for each future month. Pricier <b>now</b> than later (“backwardation”) = tight; the reverse = well supplied.</dd>
    <dt>Refining profit (crack)</dt><dd>What a refiner earns turning crude into fuel. Higher = better for refiners.</dd>
    <dt>The gap (basis)</dt><dd>Real (spot) price − futures. Positive = real barrels cost more → <b>tight</b>. Energy only.</dd>
    <dt>Stockpiles</dt><dd>Weekly US oil &amp; gas inventories (EIA). A surprise <b>draw</b> is bullish; a <b>build</b> is bearish.</dd>
    <dt>USDA stocks-to-use</dt><dd>Official US grain / dairy / livestock stocks vs consumption; low = tight. Monthly.</dd>
    <dt>Big-move markers</dt><dd>The dots on a chart mark its <b>biggest moves</b> — hover one for the trusted news behind it.</dd>
    <dt>% change</dt><dd>The move over the chosen window, not just today.</dd>
    <dt>Oil-field flames</dt><dd>Satellites see the gas burned off at oil fields; fewer flames = fields shutting down.</dd>
  </dl>`;


function showError(msg) { const el = $('error'); el.classList.remove('hidden'); el.textContent = msg; }
// How stale is the market data? A relative label for the header, plus a green/amber/red dot that
// also survives on phones (where the text label is hidden).
function relAge(iso) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.round(mins / 60);
  return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
}
function updateFreshness(iso) {
  const label = relAge(iso);
  const upd = $('updated'); if (upd) upd.textContent = label ? 'updated ' + label : 'price data —';
  const dot = $('fresh'); if (!dot) return;
  const mins = iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity;
  dot.className = 'fresh-dot ' + (mins < 5 ? 'ok' : mins < 30 ? 'warn' : 'stale');
  const title = 'Market data ' + (label ? 'updated ' + label : 'not available');
  dot.title = title; dot.setAttribute('aria-label', title);
}

// ---------------------------------------------------------------------------
// One voice + one look for every panel state, so the page never reads as half-built.
//   loading → a pulsing dot + what is being fetched
//   empty   → a calm "nothing here" (and why)
//   error   → what failed, and that we retry (never a bare "unavailable")
// ---------------------------------------------------------------------------
const stState = (kind, text) => `<div class="state ${kind}">${kind === 'loading' ? '<i class="spin" aria-hidden="true"></i>' : ''}<span>${text}</span></div>`;
const stLoading = (text = 'Loading…') => stState('loading', text);
const stEmpty = (text) => stState('empty', text);
const stError = (text) => stState('error', text);

// The on-site "Data & Methodology" — sources + freshness, what the scores mean, how basis works,
// and the rules. Content comes from the server (METHODOLOGY in src/lib.js) so it can't drift.
function renderMethodology(data) {
  const el = $('notes'); if (!el) return;
  const m = data.methodology;
  const caveats = (data.notes || []).map((n) => `<li>${n}</li>`).join('');
  let html = '';
  if (m) {
    const rows = m.sources.map((s) => `<tr><td>${s.name}</td><td>${s.covers}</td><td class="m-fresh">${s.freshness}</td></tr>`).join('');
    const scores = m.scores.map((s) => `<div class="m-score"><div class="m-score-h">${s.name}<span>${s.range}</span></div><p>${s.read}</p></div>`).join('');
    const rules = m.rules.map((r) => `<li>${r}</li>`).join('');
    html = `<div class="m-sec"><h4>WHERE THE DATA COMES FROM</h4><div class="m-tbl-wrap"><table class="m-tbl"><thead><tr><th>Source</th><th>What it covers</th><th>Freshness</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
      + `<div class="m-sec"><h4>WHAT THE SCORES MEAN</h4>${scores}</div>`
      + `<div class="m-sec"><h4>HOW BASIS WORKS</h4><p>${m.basis}</p></div>`
      + `<div class="m-sec"><h4>THE RULES</h4><ul class="m-rules">${rules}</ul></div>`;
  }
  if (caveats) html += `<div class="m-sec"><h4>THINGS TO FLAG</h4><ul class="m-rules">${caveats}</ul></div>`;
  el.innerHTML = `<details class="fold" id="methodology"><summary>DATA &amp; METHODOLOGY</summary><div class="note-body">${html}</div></details>`
    + '<div class="foot-line dimtext">Marlon\'s Watchtower · built and maintained by <b>Marlon Benedict Tan</b> · data © the respective sources · not investment advice.</div>';
}
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`); return r.json(); }
// Memoised GET — a per-session cache so re-visiting a segment is instant (no re-fetch of the
// read, news, curve, etc.). Short TTL; the server has its own longer cache anyway.
const jcache = new Map();
async function jget(url, ttl = 180000) {
  const hit = jcache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await getJSON(url);
  jcache.set(url, { t: Date.now(), v });
  return v;
}
// The current selection identity — every loader captures it and drops its result if the user
// switched away while it was waiting. This is what stops "I clicked oil but it still shows corn".
const segKey = () => currentMarket + '|' + (currentComponent || '');
// Boot beacon: a progress bar + dots that fill as the CORE panels land. The overlay is dropped
// only once they are all in (or at a hard cap, so it never lingers on a slow feed).
const BOOT_CORE = ['data', 'read', 'chart', 'news', 'headlines', 'regime', 'screen', 'calendar', 'positioning'];
const bootReady = Object.fromEntries(BOOT_CORE.map((k) => [k, false]));
let bootCount0 = 0;
const bootCount = () => BOOT_CORE.filter((k) => bootReady[k]).length;
const hideBoot = () => { const b = document.getElementById('boot'); if (b) b.classList.add('done'); };
const bootPaint = () => {
  const n = bootCount(); if (n === bootCount0 && n) return; bootCount0 = n;
  const frac = n / BOOT_CORE.length;
  const bar = document.getElementById('boot-bar'); if (bar) bar.style.width = (frac * 100).toFixed(0) + '%';
  const blips = document.querySelectorAll('.scope-blip');
  blips.forEach((b, i) => b.classList.toggle('on', frac * blips.length > i + 0.01));
  if (n === BOOT_CORE.length) hideBoot();
};
const bootStep = (m) => { const el = document.getElementById('boot-status'); if (el) el.textContent = m; bootPaint(); };
const markReady = (k) => { if (!(k in bootReady) || bootReady[k]) return; bootReady[k] = true; bootPaint(); };
async function getLongterm(id, years = 10) {
  const k = id + years; const hit = ltCache[k];
  if (hit && Date.now() - hit.t < CHART_TTL) return hit.v;
  const v = await getJSON(`/api/longterm?id=${encodeURIComponent(id)}&years=${years}`);
  ltCache[k] = { t: Date.now(), v }; return v;
}
const rangeCache = {};
async function getRange(id, range) {
  const k = id + range; const hit = rangeCache[k];
  if (hit && Date.now() - hit.t < CHART_TTL) return hit.v;
  const v = await getJSON(`/api/range?id=${encodeURIComponent(id)}&range=${range}`);
  rangeCache[k] = { t: Date.now(), v }; return v;
}
const seasonCache = {};
async function getSeasonal(id) {
  const hit = seasonCache[id];
  if (hit && Date.now() - hit.t < CHART_TTL) return hit.v;
  const v = await getJSON('/api/seasonal?id=' + encodeURIComponent(id));
  seasonCache[id] = { t: Date.now(), v }; return v;
}

// last two non-null points → day change + %
function lastTwo(arr) {
  if (!arr) return {};
  let last = null, prev = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) { if (last == null) last = arr[i]; else { prev = arr[i]; break; } }
  }
  return { last, prev };
}
const changeOf = (arr) => { const { last, prev } = lastTwo(arr); return last == null || prev == null ? null : last - prev; };
const pctOf = (arr) => { const { last, prev } = lastTwo(arr); return last == null || prev == null || prev === 0 ? null : ((last - prev) / prev) * 100; };

// ---------------------------------------------------------------------------
// Crack spreads
// ---------------------------------------------------------------------------
function crackSpreads(m) {
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const w = by.wti, rb = by.rbob, ho = by.ulsd;
  const out = [];
  const add = (label, value) => { if (value != null && !Number.isNaN(value)) out.push({ label, value }); };
  if (rb && w) { add('Gasoline refining profit', rb.paper != null && w.paper != null ? rb.paper * GAL - w.paper : null); add('Gasoline profit (real barrels)', rb.physical != null && w.physical != null ? rb.physical * GAL - w.physical : null); }
  if (ho && w) { add('Diesel refining profit', ho.paper != null && w.paper != null ? ho.paper * GAL - w.paper : null); add('Diesel profit (real barrels)', ho.physical != null && w.physical != null ? ho.physical * GAL - w.physical : null); }
  if (rb && ho && w && rb.paper != null && ho.paper != null && w.paper != null) add('3-2-1 refining profit', ((2 * rb.paper + ho.paper) * GAL) / 3 - w.paper);
  return out;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
function benchCard(b) {
  const realOnly = b.paper == null;      // spot only (jet/propane)
  const paperOnly = b.physical == null;  // futures only (metals/ags)
  const s = history?.series?.[b.id];
  const arr = b.paper != null ? s?.paper : s?.physical;
  const day = changeOf(arr), dayPct = pctOf(arr);
  const stale = b.spotLagDays != null && b.spotLagDays >= 3;
  const rows = [];
  rows.push(`<div class="row"><span class="k">Futures price</span><span class="v">${realOnly ? '<span class="k">— none</span>' : fmt(b.paper, b.dp)}</span></div>`);
  if (!paperOnly) rows.push(`<div class="row"><span class="k">Real barrels <em>${b.physicalDate || ''}</em>${stale ? ` <span class="qb">${b.spotLagDays}d old</span>` : ''}</span><span class="v">${fmt(b.physical, b.dp)}</span></div>`);
  if (!realOnly && !paperOnly) rows.push(`<div class="row"><span class="k">Gap (real − futures) <span class="qi" title="Real price minus futures price">ⓘ</span></span><span class="v basis ${cls(b.basis)}">${b.basis == null ? '—' : signed(b.basis, b.dp)}</span></div>`);
  rows.push(`<div class="row"><span class="k">Change today</span><span class="v ${cls(day)}">${day == null ? '—' : `${signed(day, b.dp)} (${pctf(dayPct)})`}</span></div>`);
  return `
    <div class="card clickable" data-id="${b.id}" title="Click for history">
      <h3 title="${b.label}">${b.label} <span>${b.unit}${realOnly ? ' · real only' : paperOnly ? ' · futures' : ''}</span></h3>
      ${rows.join('')}
    </div>`;
}
function spreadCard(s) {
  return `<div class="card"><h3>${s.label} <span>${s.unit}</span></h3>
      <div class="row"><span class="k">Futures gap</span><span class="v ${cls(s.paper)}">${signed(s.paper, s.dp)}</span></div>
      <div class="row"><span class="k">Real-barrel gap</span><span class="v ${cls(s.physical)}">${signed(s.physical, s.dp)}</span></div>
      <div class="row"><span class="k">Difference</span><span class="v ${cls(s.paper - s.physical)}">${signed(s.paper - s.physical, s.dp)}</span></div></div>`;
}
function crackCard(c) {
  const read = c.value > 20 ? 'very good' : c.value > 8 ? 'ok' : 'poor';
  return `<div class="card"><h3>${c.label} <span>$/bbl</span></h3>
      <div class="row"><span class="k">Profit / barrel</span><span class="v basis ${cls(c.value)}">${signed(c.value)}</span></div>
      <div class="row"><span class="k">Read</span><span class="v dimtext" style="font-weight:400">${read}</span></div></div>`;
}
function watchlist() { try { return JSON.parse(localStorage.getItem('oilbasis.watch') || '[]'); } catch { return []; } }
function toggleWatch(id) { const w = watchlist(); const i = w.indexOf(id); if (i >= 0) w.splice(i, 1); else w.push(id); localStorage.setItem('oilbasis.watch', JSON.stringify(w)); }
// Remember the user's view across visits (tab, segment, range, compare, macro) — feels like the
// app "knows" you, with zero new UI.
const saveStr = (k, v) => { try { localStorage.setItem('oilbasis.' + k, v); } catch {} };
function saveCompare() { try { localStorage.setItem('oilbasis.cmp', JSON.stringify({ a: $('cmp-a')?.value, b: $('cmp-b')?.value, range: $('cmp-range')?.value, view: $('cmp-view')?.value })); } catch {} }
function restoreCompare() {
  try {
    const c = JSON.parse(localStorage.getItem('oilbasis.cmp') || 'null');
    if (!c) return;
    const set = (id, v) => { const el = $(id); if (v && el && [...el.options].some((o) => o.value === v)) el.value = v; };
    set('cmp-a', c.a); set('cmp-b', c.b); set('cmp-range', c.range); set('cmp-view', c.view);
    renderCompare();
  } catch {}
}
// Tiny inline trend line (last ~6 months of the fetched history), coloured by direction.
function tileSpark(arr) {
  const v = (arr || []).filter((x) => x != null);
  if (v.length < 5) return '<svg class="spark" aria-hidden="true"></svg>';
  const w = 100, h = 22, min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
  const step = w / ((arr.length - 1) || 1);
  let d = '';
  arr.forEach((x, i) => { if (x == null) return; const px = (i * step).toFixed(1); const py = (h - 2 - ((x - min) / rng) * (h - 4)).toFixed(1); d += (d ? ' L' : 'M') + px + ',' + py; });
  const up = v[v.length - 1] >= v[0];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${up ? 'var(--green)' : 'var(--red)'}" stroke-width="1.4"/></svg>`;
}
function tileHtml(b) {
  const s = history?.series?.[b.id];
  const arr = b.paper != null ? s?.paper : s?.physical;
  const val = b.paper != null ? b.paper : b.physical;
  const starred = watchlist().includes(b.id);
  const fs = headSource(b);
  return `<div class="tile" data-id="${b.id}" title="${b.label} — click for the chart">
    <span class="t-name">${b.label}</span>
    <span class="star ${starred ? 'on' : ''}" data-star="${b.id}" title="Pin to watchlist">${starred ? '★' : '☆'}</span>
    <span class="t-px">${val == null ? '—' : Number(val).toFixed(b.dp)}</span>
    ${tileSpark(arr)}
    <span class="t-foot">${deltaStrip(headDeltas(b))}${freshBadge(fs.source, fs.asOf, fs.lag)}</span>
  </div>`;
}
function renderCards(m) {
  if (!m) return;
  const mk = markets.find((x) => x.id === currentMarket);
  const ids = mk ? mk.components.map((c) => c.id) : m.benchmarks.map((b) => b.id);
  const inSeg = m.benchmarks.filter((b) => ids.includes(b.id));
  const w = watchlist();
  const watch = inSeg.filter((b) => w.includes(b.id));
  let html = '';
  if (watch.length) html += `<div class="group"><div class="gtitle">WATCHLIST</div><div class="tiles">${watch.map(tileHtml).join('')}</div></div>`;
  html += `<div class="tiles">${inSeg.map(tileHtml).join('')}</div>`;
  $('cards').innerHTML = html;
}
function setCardsTitle() {
  const mk = markets.find((x) => x.id === currentMarket);
  const el = $('cards-title');
  if (el) el.textContent = 'INSTRUMENTS — ' + (mk ? mk.label.toUpperCase() : 'ALL');
}

// Home: the pinned instruments, across every segment, in one board.
function renderWatchlist() {
  const el = $('home-watch');
  if (!el || !data) return;
  const items = watchlist().map((id) => data.benchmarks.find((b) => b.id === id)).filter(Boolean);
  el.innerHTML = items.length
    ? `<div class="tiles">${items.map(tileHtml).join('')}</div>`
    : stEmpty('Nothing pinned yet — open <b>COMMODITIES</b> and click <b>☆</b> on any instrument to pin it here.');
}

// ---------------------------------------------------------------------------
// Big-picture snapshot — any commodity, not just crude
// ---------------------------------------------------------------------------
function buildBpOptions() {
  const sel = $('bp-metric');
  if (!sel || !markets.length) return;
  const prev = sel.value || 'crude';
  const groups = {};
  for (const m of markets) (groups[m.group] ||= []).push(m);
  sel.innerHTML = Object.entries(groups).map(([g, list]) => `<optgroup label="${g.toUpperCase()}">${list.map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}</optgroup>`).join('');
  const want = [...sel.options].some((o) => o.value === currentMarket) ? currentMarket : (sel.value || prev);
  if ([...sel.options].some((o) => o.value === want)) sel.value = want;
}
function bpVol(arr) {
  const xs = (arr || []).filter((v) => v != null);
  if (xs.length < 31) return null;
  const r = [];
  for (let i = xs.length - 30; i < xs.length; i++) r.push(Math.log(xs[i] / xs[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}
function renderSnapshot() {
  const el = $('bp-snapshot');
  if (!el || !data) return;
  const mk = markets.find((x) => x.id === currentMarket);
  const selId = currentComponent || (mk ? mk.primary : $('bp-metric').value);
  const b = data.benchmarks.find((x) => x.id === selId);
  if (!b) { el.innerHTML = ''; return; }
  const s = history?.series?.[b.id];
  const arr = b.paper != null ? s?.paper : s?.physical;
  const val = b.paper != null ? b.paper : b.physical;
  const dp = b.dp;
  const day = pctOf(arr);
  const n = (arr || []).filter((x) => x != null);
  const six = n.length > 1 ? ((n[n.length - 1] - n[0]) / n[0]) * 100 : null;
  const min = n.length ? Math.min(...n) : null, max = n.length ? Math.max(...n) : null;
  const pos = val != null && min != null && max > min ? ((val - min) / (max - min)) * 100 : null;
  const vol = bpVol(arr);
  const cells = [
    [`${b.label.toUpperCase()} PRICE`, val == null ? '—' : `${Number(val).toFixed(dp)} <span class="dimtext">${b.unit}</span>`, ''],
    ['TODAY', day == null ? '—' : pctf(day), cls(day)],
    ['PAST 6 MONTHS', six == null ? '—' : pctf(six), cls(six)],
    ['30-DAY JUMPINESS', vol == null ? '—' : vol.toFixed(1) + '%', ''],
    ['IN 6-MONTH RANGE', pos == null ? '—' : `${pos.toFixed(0)}/100`, pctClass(pos)],
    [b.physical != null ? 'REAL vs FUTURES' : 'SOURCE', b.physical != null ? signed(b.basis, dp) : 'futures only', cls(b.basis)],
  ];
  const bits = [];
  if (day != null) bits.push(`${b.label} is ${day >= 0 ? 'up' : 'down'} <b>${Math.abs(day).toFixed(1)}%</b> today`);
  if (six != null) bits.push(`${Math.abs(six).toFixed(0)}% ${six >= 0 ? 'higher' : 'lower'} over 6 months`);
  if (pos != null) bits.push(pos >= 70 ? 'near the top of its range' : pos <= 30 ? 'near the bottom of its range' : 'mid-range');
  if (vol != null) bits.push(vol > 35 ? 'very jumpy' : vol > 20 ? 'fairly jumpy' : 'calm');
  if (b.basis != null) bits.push(`real barrels ${b.basis >= 0 ? 'above' : 'below'} futures by ${Math.abs(b.basis).toFixed(dp)}`);
  // components strip (only when a market bundles more than one instrument)
  const comps = (mk ? mk.components.map((c) => data.benchmarks.find((x) => x.id === c.id)) : []).filter(Boolean);
  const compStrip = comps.length > 1 ? `<div class="bp-comps">${comps.map((c) => {
    const a = c.paper != null ? history?.series?.[c.id]?.paper : history?.series?.[c.id]?.physical;
    const pc = pctOf(a); const v = c.paper != null ? c.paper : c.physical;
    return `<span class="bp-comp ${c.id === b.id ? 'active' : ''}" data-component="${c.id}" title="Read this instrument's own stretch &amp; tightness"><span class="bp-comp-l">${c.label.replace(/\s*\(.*\)/, '')}</span><b>${v == null ? '—' : Number(v).toFixed(c.dp)}</b> <em class="${cls(pc)}">${pc == null ? '' : pctf(pc)}</em></span>`;
  }).join('')}</div>` : '';
  const spreadLine = (mk && mk.id === 'crude' && data.spreads?.brent_wti)
    ? `<div class="read-line">Brent − WTI spread: <b>${signed(data.spreads.brent_wti.paper, 2)}</b> futures · <b>${signed(data.spreads.brent_wti.physical, 2)}</b> real barrels.</div>` : '';
  el.innerHTML = `<div class="bp-head">${mk ? mk.label : b.label}${comps.length > 1 ? ` <span class="dimtext">· ${b.label.toUpperCase()}</span>` : ''}</div>`
    + `<div class="bp-grid">${cells.map(([k, v, c]) => `<div class="bp-cell"><div class="bp-k">${k}</div><div class="bp-v ${c || ''}">${v}</div></div>`).join('')}</div>`
    + `<div class="bp-deltas">${deltaStrip(headDeltas(b))}${freshStrip(b)}</div>`
    + compStrip + (compStrip ? '<div class="dimtext" style="padding:0 12px 6px">click a name to read that instrument\'s own stretch &amp; tightness</div>' : '') + spreadLine
    + `<div class="bp-spark">${tileSpark(arr)}</div>`
    + `<div class="read-line">${bits.join(' · ')}.</div>`;
}

// ---------------------------------------------------------------------------
// Adaptive Big Picture — the panels follow the selected market
// ---------------------------------------------------------------------------
function setTitle(id, text) { const e = $(id); if (e) e.textContent = text; }
function marketAlerts(r) {
  const out = [];
  if (r.range.pos != null && r.range.pos >= 90) out.push({ level: 'high', text: `${r.label} is near its 2-year high (${r.range.pos.toFixed(0)}/100 percentile).` });
  else if (r.range.pos != null && r.range.pos <= 10) out.push({ level: 'med', text: `${r.label} is near its 2-year low (${r.range.pos.toFixed(0)}/100 percentile).` });
  if (r.vol?.pctile != null && r.vol.pctile >= 90) out.push({ level: 'med', text: `${r.label} volatility is unusually high (${r.vol.v30.toFixed(0)}% annualised, ${r.vol.pctile.toFixed(0)}th pctile).` });
  return out;
}
function renderMarketContext(r) {
  const mk = markets.find((x) => x.id === r.id);
  const comps = (mk?.components || []).map((c) => data.benchmarks.find((b) => b.id === c.id)).filter(Boolean);
  const rows = comps.map((b) => {
    const a = b.paper != null ? history?.series?.[b.id]?.paper : history?.series?.[b.id]?.physical;
    const n = (a || []).filter((x) => x != null);
    if (n.length < 5) return '';
    const v = n[n.length - 1], lo = Math.min(...n), hi = Math.max(...n);
    const pct = hi > lo ? ((v - lo) / (hi - lo)) * 100 : null;
    const vol = bpVol(a);
    return ctxRow(`${b.label} — in its 6-month range`, pct, vol == null ? '' : `${vol.toFixed(0)}% vol`);
  }).filter(Boolean).join('');
  const macro = r.macro ? `<div class="chokes"><div class="chokes-h">LINK TO BROADER MARKETS (3-month correlation)</div><span class="choke"><b>${r.macro.usd ?? '—'}</b> vs US dollar</span><span class="choke"><b>${r.macro.vix ?? '—'}</b> vs VIX</span><span class="choke"><b>${r.macro.spx ?? '—'}</b> vs S&amp;P 500</span></div>` : '';
  const dc = `<div class="qflags"><div class="chokes-h">DATA CHECKS</div>${r.hasBasis ? '<div class="qflag ok">✓ Real (spot) prices are available for this market.</div>' : '<div class="qflag watch">⚠ No free real-barrel/spot price or inventories for this market — price, curve, positioning and macro are shown instead (never faked).</div>'}</div>`;
  $('context').innerHTML = rows + macro + dc;
}
// Hero board: one quick-read tile per segment.
function renderMarketState() {
  const el = $('marketstate');
  if (!el || !markets.length || !data) return;
  el.innerHTML = markets.map((m) => {
    const b = data.benchmarks.find((x) => x.id === m.primary);
    if (!b) return '';
    const s = history?.series?.[b.id];
    const arr = b.paper != null ? s?.paper : s?.physical;
    const n = (arr || []).filter((x) => x != null);
    const val = b.paper != null ? b.paper : b.physical;
    const day = pctOf(arr);
    const six = n.length > 1 ? ((n[n.length - 1] - n[0]) / n[0]) * 100 : null;
    const lo = n.length ? Math.min(...n) : null, hi = n.length ? Math.max(...n) : null;
    const pos = val != null && lo != null && hi > lo ? ((val - lo) / (hi - lo)) * 100 : null;
    return `<button class="ms-tile${m.id === currentMarket ? ' active' : ''}" data-market="${m.id}" title="${m.label} — click to open">
      <span class="ms-name">${m.label}</span>
      <span class="ms-px">${val == null ? '—' : Number(val).toFixed(b.dp)}</span>
      <span class="ms-chg ${cls(day)}">${day == null ? '—' : pctf(day)}</span>
      <span class="ms-sub dimtext">${six == null ? '' : `${pctf(six)} 6m`}${pos == null ? '' : ` · ${pos.toFixed(0)}/100 range`}</span>
    </button>`;
  }).join('');
}
function regLine(r) {
  const bits = [];
  if (r.perf?.m6 != null) bits.push(`${r.label} ${r.perf.m6 >= 0 ? 'up' : 'down'} ${Math.abs(r.perf.m6).toFixed(0)}% in 6 months`);
  if (r.range?.pos != null) bits.push(r.range.pos >= 70 ? 'near 2-year highs' : r.range.pos <= 30 ? 'near 2-year lows' : 'mid-range');
  if (r.curve) bits.push(r.curve.shape.toLowerCase());
  return `MARKET STATE — ${bits.join(' · ')}.`;
}
// Show only the segment-specific blocks (ships for crude, fuels/stocks for refined, …).
function toggleMarketBlocks() {
  document.querySelectorAll('.market-only').forEach((el) => {
    const list = (el.dataset.when || '').split(',').map((s) => s.trim());
    el.classList.toggle('hidden', !(list.includes('*') || list.includes(currentMarket)));
  });
  if (currentMarket === 'crude') {
    if (map) setTimeout(() => map.invalidateSize(), 80);
    if (rerouteChart) setTimeout(() => rerouteChart.resize(), 80);
  }
  if (currentMarket === 'refined' && crackHistChart) setTimeout(() => crackHistChart.resize(), 80);
}
async function loadMarketRead() {
  const k = segKey();
  let r = null;
  try { r = await jget('/api/marketread?id=' + encodeURIComponent(currentMarket) + (currentComponent ? '&component=' + encodeURIComponent(currentComponent) : ''), 120000); } catch {}
  if (k !== segKey()) return;          // selection changed while we waited — drop it
  marketRead = r; renderAdaptive();
}
function renderAdaptive() {
  const mk = markets.find((x) => x.id === currentMarket);
  const nm = (marketRead && marketRead.id === currentMarket && marketRead.label) || (mk && mk.label) || '';
  setTitle('tightness-title', nm ? `${nm.toUpperCase()} — TIGHTNESS` : 'TIGHTNESS');
  setTitle('tightness-sub', 'price vs its own history · physical tightness · curve · volatility');
  if (!marketRead || marketRead.id !== currentMarket || marketRead.error) { readSkeleton(mk); return; }
  const r = marketRead, v = r.verdict;
  const score = v.score;
  const sd = v.supplyDemand || { score: null, label: '—', parts: [], note: '', kind: null };
  const kl = score == null ? 'elevated' : score >= 20 ? 'high' : score <= -20 ? 'low' : 'elevated';
  const sdCls = sd.score == null ? '' : sd.score >= 58 ? 'pos' : sd.score <= 42 ? 'neg' : '';
  const sdWord = (s) => (s == null ? '—' : s >= 70 ? 'UNDERSUPPLIED' : s >= 58 ? 'TIGHT' : s >= 42 ? 'BALANCED' : s >= 30 ? 'WELL SUPPLIED' : 'OVERSUPPLIED');
  // The verdict bar's colour reflects the supply/demand read (tight/loose); price richness is
  // shown by the tile colour above. No physical data → stay neutral.
  const vk = sd.score == null ? 'mixed' : sd.score >= 58 ? 'tight' : sd.score <= 42 ? 'loose' : 'mixed';
  if ($('regime')) $('regime').textContent = regLine(r);
  const next = [...(v.catalysts || []).map((c) => `Watch: <b>${c}</b>`), ...(v.watch || [])];
  const chips = [...(v.tickersUp || []).map((t) => `<span class="chip up">▲ ${t}</span>`), ...(v.tickersDown || []).map((t) => `<span class="chip down">▼ ${t}</span>`)].join('');
  const kp = (r.takeaways || []).length ? r.takeaways.map((t) => `<li>${t}</li>`).join('') : '<li class="dimtext">No key points yet.</li>';
  // Past-year news drivers are fetched separately (/api/marketwhy) so the core read appears fast.
  const attrHtml = '<div id="read-attr" class="attr-holder"></div>';
  $('bottomline').innerHTML = `<div class="bl">
      <div class="bl-score ${kl}"><div class="bl-num" title="Price vs its own history: −100 = cheap / washed-out, +100 = rich / premium, 0 = mid.">${score == null ? '—' : signed(score, 0)}<span>/100</span></div><div class="bl-lbl">PRICE vs ITS OWN HISTORY<div class="bl-tag">${v.label}</div></div>
        <div class="bl-phys"><div class="bl-phys-k">SUPPLY &amp; DEMAND${sd.kind ? ` · ${sd.kind === 'physical' ? 'real data' : 'curve only'}` : ''}</div><div class="bl-phys-v ${sdCls}" title="Supply &amp; demand: 0 = oversupplied, 50 = balanced, 100 = undersupplied.">${sd.score == null ? 'no free data' : `${sd.score}<span>/100</span> ${sd.label}`}</div></div>
        <div class="score-key" title="Full method in DATA &amp; METHODOLOGY (footer)">Scores: <b>−100</b> cheap → <b>+100</b> rich · <b>0</b> oversupplied → <b>100</b> undersupplied</div>
      </div>
      <div class="bl-sec"><div class="gtitle">WHAT HAPPENED</div><p>${v.meaning} ${(v.notes || []).join(' ')}</p>${attrHtml}</div>
      <div class="bl-sec"><div class="gtitle">KEY POINTS</div><ul>${kp}</ul></div>
      <div class="bl-sec"><div class="gtitle">WHAT'S NEXT</div><ul>${next.map((w) => `<li>${w}</li>`).join('')}</ul></div>
    </div>
    <div class="bl-ti"><div class="gtitle">TRADE IDEAS — BENEFITS / TROUBLE</div>
      <p>${v.ideas || ''}</p>
      <div class="ti"><div class="ti-row"><span class="ti-k pos">BENEFITS</span><span class="ti-v">${(v.sectorsUp || []).join(' · ')}</span></div><div class="ti-row"><span class="ti-k neg">TROUBLE</span><span class="ti-v">${(v.sectorsDown || []).join(' · ')}</span></div></div>
      <div class="bl-chips">${chips}</div>
    </div>`;
  const ev = [];
  const push = (label, value, dir, note) => ev.push({ label, value, dir, note });
  if (r.range.pos != null) push('Price vs its 2-year range', `${r.range.pos.toFixed(0)}/100`, r.range.pos >= 70 ? 'HIGH' : r.range.pos <= 30 ? 'LOW' : 'MID', r.range.pos >= 70 ? 'expensive vs 2 years' : r.range.pos <= 30 ? 'cheap vs 2 years' : 'mid-range');
  if (r.vol.v30 != null) push('Volatility (30-day, annualised)', r.vol.v30.toFixed(1) + '%', (r.vol.pctile ?? 50) >= 70 ? 'HIGH' : (r.vol.pctile ?? 50) <= 30 ? 'LOW' : 'MID', `${(r.vol.pctile ?? 50).toFixed(0)}th pctile — ${(r.vol.pctile ?? 50) >= 70 ? 'jumpier than usual' : (r.vol.pctile ?? 50) <= 30 ? 'calmer than usual' : 'normal'}`);
  if (r.curve) push('Curve — near vs later', r.curve.shape, r.curve.m1m2 >= 0 ? 'TIGHT' : 'LOOSE', r.curve.m1m2 >= 0 ? 'near-term prices higher' : 'near-term supply comfortable');
  if (r.basis) push('Real vs futures', signed(r.basis.value, r.dp), r.basis.value >= 0 ? 'TIGHT' : 'LOOSE', r.basis.pctile != null ? `${r.basis.pctile.toFixed(0)}th pctile` : 'physical vs paper');
  if (r.inventory?.length) for (const it of r.inventory) push(`${it.label} vs seasonal`, it.surprise == null ? '—' : signed(it.surprise, 0), it.surprise < 0 ? 'TIGHT' : 'LOOSE', it.surprise < 0 ? 'a bigger draw than usual' : 'built up vs usual');
  if (r.usda) push('USDA US stocks-to-use', `${(r.usda.stocksToUse * 100).toFixed(1)}%`, r.usda.stocksPct <= 30 ? 'TIGHT' : r.usda.stocksPct >= 70 ? 'LOOSE' : 'MID', `${r.usda.yearLabel} market year · ${r.usda.stocksPct.toFixed(0)}th pctile vs 30 yrs`);
  if (r.macro?.usd != null) push('Link to the US dollar', `${r.macro.usd}`, 'MID', '3-month correlation (negative = moves against the dollar)');
  const sdChips = (sd.parts && sd.parts.length) ? `<div class="phys-parts">${sd.parts.map((p) => `<span class="phys-part ${p.score >= 58 ? 'tight' : p.score <= 42 ? 'loose' : ''}">${p.label} <b>${p.score}</b> ${sdWord(p.score)}</span>`).join('')}</div>` : '';
  const sdNote = sd.note ? `<div class="phys-note dimtext">${sd.note}</div>` : '';
  const psParts = (v.priceStretch && v.priceStretch.parts) || [];
  const psChips = psParts.length ? `<div class="phys-parts"><span class="dimtext" style="align-self:center">vs its own history:</span>${psParts.map((p) => `<span class="phys-part">${p.label} <b>${signed(p.score, 0)}</b></span>`).join('')}</div>` : '';
  const priceLine = score == null ? 'price vs its own history unavailable'
    : (score >= 20 || score <= -20) ? `it trades <b>${v.label.toLowerCase()}</b> vs its own history (${signed(score, 0)}/100)`
    : `it is <b>${v.label.toLowerCase()}</b> (${signed(score, 0)}/100)`;
  const sdLine = sd.score == null ? 'no free supply/demand data' : `supply vs demand looks <b>${sd.label.toLowerCase()}</b> (${sd.score}/100)`;
  $('tightness').innerHTML = `<div class="verdict ${vk}">${r.label}: ${priceLine} · ${sdLine}.</div>${psChips}${sdChips}${sdNote}<div class="ev-list">${ev.map((e) => `<div class="ev"><span class="ev-l">${e.label}</span><span class="ev-v">${e.value}</span><span class="tag ${e.dir.toLowerCase()}">${e.dir}</span><span class="ev-n dimtext">${e.note}</span></div>`).join('')}</div>`;
  const si = $('ships-insights');
  if (si) si.innerHTML = r.hasShips ? tankerInsights(tankerInfo).map((x) => `<li>${x}</li>`).join('') : '';
  renderAlerts(marketAlerts(r));
  renderMarketContext(r);
  setTitle('xa-seg', mk ? mk.label.toUpperCase() : '');
  const xa = $('crossasset');
  if (xa) xa.innerHTML = crossAssetBlock((i) => (i.segments || []).includes(currentMarket));
  loadMarketWhy();   // fill the past-year news-drivers block in afterwards
  markReady('read');  // the read is up
}
// An instant, correct-segment skeleton shown while the full read loads (price/6m from memory).
function readSkeleton(mk) {
  const b = mk && data && data.benchmarks.find((x) => x.id === mk.primary);
  const s = b && history?.series?.[b.id];
  const arr = b ? (b.paper != null ? s?.paper : s?.physical) : null;
  const val = b ? (b.paper != null ? b.paper : b.physical) : null;
  const n = (arr || []).filter((x) => x != null);
  const six = n.length > 1 ? ((n[n.length - 1] - n[0]) / n[0]) * 100 : null;
  const name = b ? b.label : (mk ? mk.label : '');
  const px = (val == null || !b) ? '—' : Number(val).toFixed(b.dp);
  $('bottomline').innerHTML = `<div class="bl">
    <div class="bl-score elevated"><div class="bl-num">${px}</div><div class="bl-lbl">${String(name).toUpperCase()}${b ? ` <span class="dimtext">${b.unit}</span>` : ''}<div class="bl-tag">reading the full verdict…</div></div></div>
    <div class="bl-sec"><div class="gtitle">WHAT HAPPENED</div><p class="dimtext">Pulling the price history, curve, supply/demand and news for <b>${name}</b>${six == null ? '' : ` — ${six >= 0 ? '+' : ''}${six.toFixed(0)}% over 6 months`}…</p></div></div>`;
  $('tightness').innerHTML = stLoading('Reading the market…');
}
// The past-year news drivers (slow) — fetched after the read, into the placeholder.
async function loadMarketWhy() {
  const el = $('read-attr'); if (!el) return;
  const k = segKey();
  el.innerHTML = stLoading('Pulling the past-year news drivers…');
  try {
    const d = await jget('/api/marketwhy?id=' + encodeURIComponent(currentMarket) + (currentComponent ? '&component=' + encodeURIComponent(currentComponent) : ''), 900000);
    if (k !== segKey()) return;
    el.innerHTML = attrBlock(d && d.attribution);
  } catch { el.innerHTML = ''; }
}
function attrBlock(at) {
  if (!at || at.error) return '';
  if (at.drivers && at.drivers.length) {
    const lead = at.y1 == null ? 'Past-year news drivers:' : `Over the past year it is <b>${pctf(at.y1)}</b> — the news most consistent with that move:`;
    const items = at.drivers.map((d) => { const s = d.sample || {}; return `<li><b>${d.kind}</b> <span class="dimtext">(${d.count} headline${d.count > 1 ? 's' : ''})</span> — <a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title || ''}</a> <span class="dimtext">${s.source || ''}${s.date ? ' · ' + String(s.date).slice(0, 10) : ''}</span></li>`; }).join('');
    return `<div class="attr"><div class="attr-lead">${lead}</div><ul class="attr-list">${items}</ul><div class="dimtext attr-caveat">News-implied, not a verdict — links open at the source.</div></div>`;
  }
  return at.divergence
    ? '<div class="attr dimtext">The past-year news leaned <b>against</b> that move — a divergence worth investigating. See the news panel.</div>'
    : '<div class="attr dimtext">No single clear news driver found over the past year — see the news panel.</div>';
}
async function loadNews() {
  const el = $('news');
  if (!el) return;
  const k = segKey();
  el.innerHTML = stLoading('Loading headlines…');
  try { const n = await jget('/api/news?id=' + encodeURIComponent(currentMarket) + (currentComponent ? '&component=' + encodeURIComponent(currentComponent) : ''), 300000); if (k !== segKey()) return; renderNews(n); }
  catch { if (k === segKey()) { el.innerHTML = stError('Couldn\u2019t load headlines — retrying.'); markReady('news'); } }
}
function renderNews(n, elId = 'news', subId = 'news-sub') {
  const el = $(elId);
  if (!el) return;
  if (elId === 'news') markReady('news');
  const items = (n && n.items) || [];
  const sub = $(subId);
  const lbl = (n && n.label) || '';
  if (sub) sub.textContent = lbl + ' · tier-1 wire · refreshes daily';
  if (!items.length) { el.innerHTML = stEmpty('No recent tier-1 headlines for this segment.'); return; }
  el.innerHTML = items.map((it) => `<a class="news-item" href="${it.url}" target="_blank" rel="noopener noreferrer"><span class="news-src">${it.source || 'wire'}</span><span class="news-t">${it.kind ? `<em class="news-k">${it.kind}</em> ` : ''}${it.title}</span><span class="news-d dimtext">${ago(it.date)}</span></a>`).join('')
    + '<div class="dimtext" style="padding:6px 12px;font-size:10px">Headlines via Google News · © the respective publishers · links open at the source.</div>';
}
function selectMarket(id) {
  saveStr('segment', id);
  currentMarket = id;
  currentComponent = null;   // reset to the segment's headline when the segment changes
  marketRead = null;         // clear so nothing from the previous segment can linger
  const pick = $('bp-metric');
  if (pick && [...pick.options].some((o) => o.value === id)) pick.value = id;   // keep the picker in sync
  renderSnapshot();
  renderMarketState();
  toggleMarketBlocks();
  if (data) { renderCards(data); buildMetricOptions(data); }
  setCardsTitle();
  renderCurveForSegment();   // the curve follows the segment
  loadCurveHistory();        // and so does the curve-over-time (or hides)
  loadSeasonal();            // and the seasonality grade (gas/grains/softs)
  loadCrush();               // and the soybean crush (grains)
  renderAdaptive();
  loadMarketRead();
  loadNews();
  loadFundamentals();
  loadPositioning();
  loadOptions();
  renderChart();
  syncCompareToSelection();
}

// ---------------------------------------------------------------------------
// Insights & alerts
// ---------------------------------------------------------------------------
function tankerInsights(t) {
  const out = []; const s = t.status || {};
  if (!s.enabled) { out.push('Live ship tracking is off. Add a free key to switch it on.'); return out; }
  const list = t.tankers || [];
  if (!list.length) { out.push(`Connected to ship trackers (${(s.messages || 0).toLocaleString()} signals) — identifying ships…`); return out; }
  const idlers = list.filter((v) => (v.sog ?? 0) < 1).length;
  const avg = list.reduce((a, v) => a + (v.sog || 0), 0) / list.length;
  out.push(`<b>${list.length} oil ships</b> tracked: ${list.length - idlers} under way, ${idlers} sitting still.`);
  out.push('Ships sitting still can mean floating storage or congestion; lots of fast-moving ships usually means busier trade.');
  out.push(`Average speed ${avg.toFixed(1)} knots — ${avg > 8 ? 'brisk (busy trade).' : avg < 4 ? 'slow.' : 'moderate.'}`);
  return out;
}
const DEFAULT_THRESH = { brent: 10, wti: 3.5, diesel: 28, idlers: 15 };
function thresholds() { try { return { ...DEFAULT_THRESH, ...(JSON.parse(localStorage.getItem('oilbasis.thresholds')) || {}) }; } catch { return DEFAULT_THRESH; } }
function computeAlerts(m, t) {
  const T = thresholds();
  const out = []; const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  if (by.brent?.basis != null && Math.abs(by.brent.basis) > T.brent) out.push({ level: 'high', text: `Brent real-vs-futures gap is extreme (${signed(by.brent.basis)}).` });
  if (by.wti?.basis != null && Math.abs(by.wti.basis) > T.wti) out.push({ level: 'med', text: `WTI real-vs-futures gap is wide (${signed(by.wti.basis)}).` });
  const s = m.spreads.brent_wti;
  if (s && Math.abs(s.physical - s.paper) > 5) out.push({ level: 'med', text: `Brent vs WTI: the real gap and the futures gap have split by ${signed(s.physical - s.paper)}.` });
  const diesel = crackSpreads(m).find((c) => c.label.startsWith('Diesel refining profit'));
  if (diesel && diesel.value > T.diesel) out.push({ level: 'high', text: `Diesel refining profit is very high (${signed(diesel.value)} a barrel).` });
  if (diesel && diesel.value < 6) out.push({ level: 'high', text: `Diesel refining profit is very low (${signed(diesel.value)}) — refiners may cut back.` });
  const idlers = (t.tankers || []).filter((v) => (v.sog ?? 0) < 1).length;
  if (t.status?.enabled && idlers >= T.idlers) out.push({ level: 'med', text: `${idlers} oil ships sitting still — watch for floating storage building.` });
  return out;
}
function renderThresholds() {
  const T = thresholds();
  const rows = [['brent', 'Brent gap alerts above', T.brent], ['wti', 'WTI gap alerts above', T.wti], ['diesel', 'Diesel profit alerts above', T.diesel], ['idlers', 'Idle-ships alerts above', T.idlers]];
  $('alert-thresholds').innerHTML = rows.map(([k, label, v]) => `<label class="thr"><span>${label}</span><input type="number" step="0.5" data-k="${k}" value="${v}"></label>`).join('');
  $('alert-thresholds').querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
    const t2 = thresholds(); t2[inp.dataset.k] = Number(inp.value);
    localStorage.setItem('oilbasis.thresholds', JSON.stringify(t2));
    renderAlerts(computeAlerts(data, tankerInfo));
  }));
}
function renderAlerts(alerts) {
  $('alert-count').textContent = String(alerts.length);
  $('alert-count').className = 'pill ' + (alerts.some((a) => a.level === 'high') ? 'warn' : alerts.length ? '' : 'ok');
  $('alerts').innerHTML = alerts.length ? alerts.map((a) => `<div class="alert ${a.level}"><span class="badge">${a.level === 'high' ? 'HIGH' : 'WATCH'}</span> ${a.text}</div>`).join('') : '<div class="alert none">No alerts — markets within normal ranges.</div>';
  if ('Notification' in window && Notification.permission === 'granted') for (const a of alerts) if (a.level === 'high' && !seenAlerts.has(a.text)) { seenAlerts.add(a.text); try { new Notification('Oil market alert', { body: a.text }); } catch {} }
}
// ---------------------------------------------------------------------------
// Custom alert rules — user-set "tell me when X is above/below/crosses Y".
// Client-side (localStorage 'oilbasis.rules'); evaluated on every refresh while the tab is open.
// ---------------------------------------------------------------------------
const RULES_KEY = 'oilbasis.rules';
const rulePrev = {};   // last value per rule id, for "crosses"
function rules() { try { const a = JSON.parse(localStorage.getItem(RULES_KEY)); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveRules(a) { try { localStorage.setItem(RULES_KEY, JSON.stringify(a)); } catch {} }
function metricGroups() {
  const bs = (data && data.benchmarks) || [];
  const g = [];
  g.push(['INSTRUMENTS (price)', bs.map((b) => ({ v: 'bench:' + b.id, l: b.label }))]);
  const basis = bs.filter((b) => b.basis != null);
  if (basis.length) g.push(['BASIS (real − futures)', basis.map((b) => ({ v: 'basis:' + b.id, l: b.label }))]);
  const fx = lastFx || [];
  if (fx.length) g.push(['CURRENCIES', fx.map((f) => ({ v: 'fx:' + f.id, l: f.label }))]);
  return g.filter(([, arr]) => arr.length);
}
function ruleLabel(metric) {
  const [kind, id] = String(metric).split(':');
  if (kind === 'bench') { const b = (data && data.benchmarks || []).find((x) => x.id === id); return `${b ? b.label : id} price`; }
  if (kind === 'basis') { const b = (data && data.benchmarks || []).find((x) => x.id === id); return `${b ? b.label : id} gap`; }
  if (kind === 'fx') { const f = (lastFx || []).find((x) => x.id === id); return `${f ? f.label : id}`; }
  return metric;
}
function ruleValue(metric) {
  const [kind, id] = String(metric).split(':');
  if (kind === 'bench') { const b = (data && data.benchmarks || []).find((x) => x.id === id); return b ? (b.paper != null ? b.paper : b.physical) : null; }
  if (kind === 'basis') { const b = (data && data.benchmarks || []).find((x) => x.id === id); return b ? b.basis : null; }
  if (kind === 'fx') { const f = (lastFx || []).find((x) => x.id === id); return f ? f.price : null; }
  return null;
}
function computeRules() {
  const out = [];
  if (!data) return out;
  for (const r of rules()) {
    if (r.on === false) continue;
    const v = ruleValue(r.metric);
    if (v == null) continue;
    const prev = rulePrev[r.id]; rulePrev[r.id] = v;
    let hit = false;
    if (r.op === '>') hit = v > r.level;
    else if (r.op === '<') hit = v < r.level;
    else if (r.op === 'crosses') hit = prev != null && ((prev < r.level && v >= r.level) || (prev > r.level && v <= r.level));
    if (hit) out.push({ level: 'med', rule: true, text: `${ruleLabel(r.metric)} ${r.op === '>' ? 'is above' : r.op === '<' ? 'is below' : 'crossed'} ${r.level}${r.note ? ` — ${r.note}` : ''} (now ${Number(v).toFixed(2)}).` });
  }
  return out;
}
function renderRules() {
  const el = $('home-rules'); if (!el) return;
  const rs = rules();
  const opts = metricGroups().map(([g, arr]) => `<optgroup label="${g}">${arr.map((o) => `<option value="${o.v}">${o.l}</option>`).join('')}</optgroup>`).join('');
  const list = rs.length
    ? rs.map((r) => `<div class="rule"><span>${ruleLabel(r.metric)} ${r.op === '>' ? 'above' : r.op === '<' ? 'below' : 'crosses'} <b>${r.level}</b>${r.note ? ` — ${r.note}` : ''}</span><button class="rule-x" data-del="${r.id}" aria-label="Delete rule">✕</button></div>`).join('')
    : '<div class="dimtext" style="padding:2px 0">No rules yet — add one below.</div>';
  const granted = 'Notification' in window && Notification.permission === 'granted';
  el.innerHTML = '<div class="rules-h">ALERT RULES — tell me when…</div>'
    + `<div class="rules-list">${list}</div>`
    + `<div class="rule-add"><select id="rule-metric" aria-label="Metric">${opts}</select>`
    + '<select id="rule-op" aria-label="Condition"><option value=">">is above</option><option value="<">is below</option><option value="crosses">crosses</option></select>'
    + '<input id="rule-level" type="number" step="any" placeholder="level" aria-label="Level">'
    + '<input id="rule-note" type="text" placeholder="note (optional)" aria-label="Note">'
    + '<button id="rule-add" class="ghost small" type="button">＋ ADD RULE</button></div>'
    + `<div class="rule-foot dimtext">Checked in this tab while it is open. <button id="rule-notify" class="ghost small" type="button">${granted ? '✓ notifications on' : 'ENABLE NOTIFICATIONS'}</button></div>`;
}
$('home-rules')?.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { saveRules(rules().filter((r) => r.id !== del.dataset.del)); renderRules(); renderHomeAlerts(); return; }
  if (e.target.id === 'rule-notify') { if ('Notification' in window) Notification.requestPermission().then(() => renderRules()); return; }
  if (e.target.id === 'rule-add') {
    const metric = $('rule-metric').value, op = $('rule-op').value, level = Number($('rule-level').value), note = $('rule-note').value.trim();
    if (!metric || !Number.isFinite(level)) { showError('Give the rule a numeric level.'); return; }
    const rs = rules(); rs.push({ id: 'r' + Date.now().toString(36), metric, op, level, note, on: true }); saveRules(rs);
    renderRules(); renderHomeAlerts();
  }
});
// Home: every alert firing, from both engines, severity-sorted.
const ALERT_RANK = { high: 0, med: 1, watch: 2 };
function allAlerts() {
  const out = serverAlerts.map((a) => ({ level: a.level, text: a.text }));
  if (data) for (const a of computeAlerts(data, tankerInfo)) out.push({ level: a.level, text: a.text });
  for (const a of computeRules()) out.push(a);   // user rules
  return out.sort((x, y) => (ALERT_RANK[x.level] ?? 3) - (ALERT_RANK[y.level] ?? 3));
}
function renderHomeAlerts() {
  const el = $('home-alerts');
  if (!el) return;
  const list = data ? allAlerts() : [];
  const c = $('home-alert-count');
  if (c) { c.textContent = String(list.length); c.className = 'pill ' + (list.some((a) => a.level === 'high') ? 'warn' : list.length ? '' : 'ok'); }
  const sub = $('home-alert-sub');
  if (sub) sub.textContent = 'server checks (basis extremes, data quality, idle ships) + your rules · add rules below, or edit thresholds in COMMODITIES → MORE DETAIL';
  el.innerHTML = list.length
    ? list.map((a) => `<div class="alert ${a.level}"><span class="badge">${a.level === 'high' ? 'HIGH' : a.level === 'watch' ? 'CHECK' : 'WATCH'}</span> ${a.text}</div>`).join('')
    : '<div class="alert none">No alerts — markets within normal ranges.</div>';
  // Browser notifications for new high alerts + any rule that fires (rules are user-defined, so
  // they always announce). Client-side only — this runs while the tab is open.
  if ('Notification' in window && Notification.permission === 'granted') {
    for (const a of list) if ((a.rule || a.level === 'high') && !seenAlerts.has(a.text)) { seenAlerts.add(a.text); try { new Notification("Marlon's Watchtower", { body: a.text }); } catch {} }
  }
}
async function loadAlerts() {
  try { serverAlerts = (await getJSON('/api/alerts')).current || []; } catch { serverAlerts = []; }
  renderHomeAlerts();
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------
function renderTicker(m) {
  if (!m) return;
  // One constant tape: every commodity + every currency + every macro index, always
  // the same regardless of which tab you're on. Deduped so shared names appear once.
  const seen = new Set();
  const parts = [];
  const push = (label, html) => { const k = (label || '').replace(/\s*[·(].*/, '').trim(); if (!k || seen.has(k)) return; seen.add(k); parts.push(html); };
  for (const b of m.benchmarks) {
    const s = history?.series?.[b.id];
    const arr = b.paper != null ? s?.paper : s?.physical;
    const val = b.paper != null ? b.paper : b.physical;
    const chg = changeOf(arr), pc = pctOf(arr);
    const c = chg == null ? '' : chg >= 0 ? 'pos' : 'neg';
    const arrow = chg == null ? '' : chg >= 0 ? '▲' : '▼';
    const short = b.label.replace(/\s*\(.*\)/, '');
    const d = headDeltas(b);
    const tip = d ? HORIZONS.map(([l, k]) => `${l} ${d[k] == null ? '—' : pctf(d[k])}`).join(' · ') : '';
    const fs = headSource(b);
    push(short, `<span class="tk" title="${short} · ${tip || 'no history'} — ${fs.source || ''} ${fs.asOf || ''}"><b>${short}</b><span class="tk-px">${val == null ? '—' : Number(val).toFixed(b.dp)}</span><span class="tk-chg ${c}">${chg == null ? '' : `${arrow}${Math.abs(chg).toFixed(b.dp)} ${pctf(pc)}`}</span></span>`);
  }
  for (const f of (lastFx || [])) push(f.label, `<span class="tk"><b>${f.label.replace(/\s*·.*/, '')}</b><span class="tk-px">${f.price == null ? '—' : Number(f.price).toFixed(f.price < 10 ? 4 : 2)}</span><span class="tk-chg ${cls(f.pct)}">${f.pct == null ? '' : pctf(f.pct)}</span></span>`);
  for (const t of (macroTickers || [])) push(t.label, `<span class="tk"><b>${t.label}</b><span class="tk-px">${t.price == null ? '—' : Number(t.price).toFixed(t.price < 10 ? 4 : 2)}</span><span class="tk-chg ${cls(t.pct)}">${t.pct == null ? '' : pctf(t.pct)}</span></span>`);
  const one = parts.join('');
  const ticker = $('ticker');
  if (!ticker) return;
  // Reuse the existing track element so the tape never jumps (only its children are refreshed).
  // Rebuilding #ticker.innerHTML would reset the scroll position.
  const track = ticker.querySelector('.ticker-track');
  if (track) track.innerHTML = `${one}${one}`;
  else ticker.innerHTML = `<div class="ticker-track">${one}${one}</div>`;   // two copies → seamless marquee
  tickerStart();
}

// The tape moves on requestAnimationFrame, NOT a CSS animation: iOS Safari latches :hover after a
// touch (and can still report `(hover: hover)`), which freezes a CSS marquee. Owning the motion in
// JS means it always runs; press-and-hold pauses it. Two identical copies make a seamless loop.
let tickerX = 0, tickerRAF = null, tickerLast = 0, tickerHeld = false, tickerPaused = false, tickerWired = false;
const tickerReduce = matchMedia('(prefers-reduced-motion: reduce)');
const TICKER_MS = 120000;   // one full copy takes 120s — the SAME speed on phone and desktop
function tickerStart() {
  const ticker = $('ticker');
  if (!ticker) return;
  if (!tickerWired) {                               // wire listeners once (re-renders don't re-add)
    tickerWired = true;
    const setHeld = (v) => () => { tickerHeld = v; };
    ticker.addEventListener('pointerdown', setHeld(true), { passive: true });
    ticker.addEventListener('pointerup', setHeld(false), { passive: true });
    ticker.addEventListener('pointercancel', setHeld(false), { passive: true });
    ticker.addEventListener('pointerleave', setHeld(false), { passive: true });
    tickerReduce.addEventListener?.('change', () => { if (!tickerReduce.matches) tickerStart(); });   // OS toggle → resume
    // A visible pause/play control — WCAG 2.2.2: auto-moving content must be stoppable.
    const pauseBtn = $('ticker-pause');
    pauseBtn?.addEventListener('click', () => {
      tickerPaused = !tickerPaused;
      pauseBtn.setAttribute('aria-pressed', String(tickerPaused));
      pauseBtn.textContent = tickerPaused ? '▸' : '❚❚';
      const label = tickerPaused ? 'Play the ticker' : 'Pause the ticker';
      pauseBtn.setAttribute('aria-label', label); pauseBtn.title = label;
      if (!tickerPaused) { tickerLast = performance.now(); tickerStart(); }
    });
  }
  if (tickerReduce.matches) {                       // honour Reduce Motion: leave it as a swipe strip
    const t = ticker.querySelector('.ticker-track');
    if (t) t.style.transform = '';
    return;
  }
  if (tickerRAF) return;                            // one loop, reused across re-renders
  tickerLast = performance.now();
  tickerRAF = requestAnimationFrame(function step(now) {
    const track = ticker.querySelector('.ticker-track');
    if (!track || tickerReduce.matches) {           // stop cleanly if the content or the setting changes
      if (track) track.style.transform = '';
      tickerRAF = null;
      return;
    }
    const half = track.scrollWidth / 2;             // one copy's width
    if (!half) { tickerRAF = requestAnimationFrame(step); return; }   // not laid out yet
    const dt = Math.min(64, Math.max(0, now - tickerLast)); tickerLast = now;
    if (!tickerHeld && !tickerPaused) tickerX -= (half / TICKER_MS) * dt;   // one copy per duration (same on all sizes)
    if (tickerX <= -half) tickerX += half;
    if (tickerX > 0) tickerX -= half;
    track.style.transform = `translateX(${tickerX.toFixed(2)}px)`;
    tickerRAF = requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------------------
// Chart (6M and 10Y)
// ---------------------------------------------------------------------------
// ---- Chart kit -------------------------------------------------------------
// ONE definition of how every chart looks, so a chart reads the same everywhere:
// same grid/axis/legend/tooltip and the same role colours. No new controls for
// the reader — just consistency. Roles: c1 primary (futures), c2 secondary
// (real/spot), c3 tertiary, c4 alt, accent.
const CT = { text: '#7c8a99', grid: '#151a20', ref: '#2a3440', c1: '#4aa3ff', c2: '#ff9e00', c3: '#00c853', c4: '#c06bff', accent: '#ffd54f' };
const charts = {};   // canvas id -> Chart instance (re-render updates in place; no leaks)
const fmtNum = (v, dp = 2) => {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e5) return (v / 1e3).toFixed(0) + 'k';
  return Number(v).toFixed(dp);
};
// Change formatting. For a PRICE, a relative % is right. For a RATE (already a %), it is not — a
// policy rate near zero makes "% change" explode (Japan), so rate charts show percentage-points /
// basis-points instead.
const chgText = (v, absolute) => {
  if (v == null || Number.isNaN(v)) return '—';
  if (absolute) { const bp = v * 100; return Math.abs(v) < 1 ? `${bp >= 0 ? '+' : ''}${bp.toFixed(0)} bp` : `${v >= 0 ? '+' : ''}${v.toFixed(2)} pp`; }
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
};
const moveText = (e) => chgText(e.move, e.mode === 'abs');
function baseOptions({ dp = 2, unit = '', percentAxis = false, yTitle = '', y1Title = '', legend = true, log = false, anchorable = false } = {}) {
  const tick = (v) => (percentAxis ? v + '%' : fmtNum(v, dp) + unit);
  return {
    responsive: true, maintainAspectRatio: false,
    animation: { duration: 200 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, labels: { color: CT.text, boxWidth: 10, usePointStyle: true, font: { family: 'monospace' }, filter: (item, data) => !(data.datasets[item.datasetIndex] && data.datasets[item.datasetIndex].$news) } },
      tooltip: {
        mode: 'index', intersect: false,
        backgroundColor: '#0c0f13', borderColor: '#2a3440', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#c9d4df', padding: 8,
        callbacks: {
          title: (it) => (it && it.length ? String(it[0].label) : ''),
          label: (ctx) => {
            // The invisible "news" dataset: one line per big move, right inside the normal tooltip.
            if (ctx.dataset && ctx.dataset.$news) {
              const e = ctx.dataset.$news[ctx.dataIndex];
              if (!e) return undefined;
              const t = String(e.title); const tt = t.length > 90 ? t.slice(0, 89) + '…' : t;
              return `NEWS · ${e.date.slice(5)} · ${tt} — ${e.source} (${moveText(e)})`;
            }
            const v = ctx.parsed.y;
            if (v == null || Number.isNaN(v)) return `${ctx.dataset.label}: —`;
            let out = `${ctx.dataset.label}: ${percentAxis ? Number(v).toFixed(dp) + '%' : fmtNum(v, dp) + unit}`;
            const d = ctx.dataset.data || [];
            const first = d.find((x) => x != null);
            if (first != null) out += `   ${chgText(percentAxis ? (v - first) : ((v - first) / first) * 100, percentAxis)}`;
            if (anchorable && chartAnchor != null && d[chartAnchor] != null) out += `  ·  ${chgText(percentAxis ? (v - d[chartAnchor]) : ((v - d[chartAnchor]) / d[chartAnchor]) * 100, percentAxis)} vs ●`;
            return out;
          },
        },
      },
    },
    scales: {
      x: { ticks: { color: CT.text, maxTicksLimit: 7, autoSkip: true, maxRotation: 0 }, grid: { color: CT.grid } },
      y: {
        type: log ? 'logarithmic' : 'linear',
        ...(yTitle ? { title: { display: true, text: yTitle, color: CT.text } } : {}),
        ticks: { color: CT.text, callback: tick }, grid: { color: CT.grid },
      },
      ...(y1Title ? { y1: { position: 'right', title: { display: true, text: y1Title, color: CT.text }, ticks: { color: CT.text }, grid: { drawOnChartArea: false } } } : {}),
    },
  };
}
function mountChart(id, data, options, plugins) {
  const cv = $(id);
  if (!cv) return null;
  const wrap = cv.parentElement;
  if (typeof Chart === 'undefined') {   // the Chart.js CDN failed — say so, don't throw
    if (wrap) wrap.setAttribute('data-empty', 'Charts are unavailable right now — the chart library didn’t load.');
    return null;
  }
  if (wrap) wrap.removeAttribute('data-empty');
  // A text alternative for screen readers: what the chart plots, with the latest value.
  const ds = (data?.datasets || []).filter((d) => d && d.label && !d.$news);
  if (ds.length) {
    const desc = ds.map((d) => {
      const arr = (d.data || []).filter((v) => v != null);
      const last = arr.length ? Number(arr[arr.length - 1]) : null;
      return Number.isFinite(last) ? `${d.label} (latest ${last.toFixed(2)})` : d.label;
    }).join(', ');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', `Line chart — ${desc}. Values are approximate; hover a point for detail.`);
  }
  if (charts[id]) { charts[id].data = data; charts[id].options = options; charts[id].update(); return charts[id]; }
  charts[id] = new Chart(cv, { type: 'line', data, options, plugins: plugins || [] });
  return charts[id];
}
function chartEmpty(id, msg) { const cv = $(id); if (cv && cv.parentElement) cv.parentElement.setAttribute('data-empty', msg || 'no data for this range'); }

const bandsPlugin = {
  id: 'bands',
  beforeDatasetsDraw(c) {
    const b = c.$bands;
    if (!b) return;
    const { top, bottom, left, right } = c.chartArea;
    const draw = (y, color) => { const yy = c.scales.y.getPixelForValue(y); if (yy < top || yy > bottom) return; c.ctx.save(); c.ctx.strokeStyle = color; c.ctx.setLineDash([4, 4]); c.ctx.beginPath(); c.ctx.moveTo(left, yy); c.ctx.lineTo(right, yy); c.ctx.stroke(); c.ctx.restore(); };
    draw(b.p10, '#2a3440'); draw(b.p90, '#2a3440'); draw(b.median, '#4aa3ff');
  },
};
// Event markers: a faint line + dot at each dated news shock (see chartMarkers).
const eventsPlugin = {
  id: 'events',
  afterDatasetsDraw(c) {
    const ev = c.$events;
    if (!ev || !ev.length) return;
    const { top, bottom, left, right } = c.chartArea;
    const g = c.ctx;
    for (const e of ev) {
      const x = c.scales.x.getPixelForValue(e.idx);
      if (x < left || x > right) continue;
      g.save();
      g.strokeStyle = e.color; g.globalAlpha = 0.45; g.setLineDash([2, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1; g.fillStyle = e.color;
      g.beginPath(); g.arc(x, top + 3, 2.6, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  },
};
// Register it for EVERY chart (it does nothing on charts with no events) — otherwise only the
// chart that listed it explicitly drew the markers.
Chart.register(eventsPlugin);
let chart;
let chartAnchor = null;
const anchorLine = {
  id: 'anchorLine',
  afterDatasetsDraw(c) {
    if (chartAnchor == null) return;
    const x = c.scales.x.getPixelForValue(chartAnchor);
    const { top, bottom } = c.chartArea;
    const g = c.ctx; g.save(); g.strokeStyle = '#ff9e00'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.restore();
  },
};
function buildMetricOptions(m) {
  const sel = $('metric');
  if (!sel || !m) return;
  const prev = sel.value || localStorage.getItem('oilbasis.metric');
  const mk = markets.find((x) => x.id === currentMarket);
  const ids = mk ? mk.components.map((c) => c.id) : m.benchmarks.map((b) => b.id);
  const opts = [];
  for (const b of m.benchmarks) {
    if (!ids.includes(b.id)) continue;                 // chart stays inside the selected segment
    if (history && !(b.id in history.series)) continue;
    if (b.paper == null) opts.push(`<option value="${b.id}">${b.label} (real price only)</option>`);
    else if (b.physical == null) opts.push(`<option value="${b.id}">${b.label} (futures)</option>`);
    else { opts.push(`<option value="${b.id}">${b.label} — futures vs real</option>`); opts.push(`<option value="basis:${b.id}">${b.label} gap (real − futures)</option>`); }
  }
  if (currentMarket === 'crude') for (const key of Object.keys(m.spreads)) opts.push(`<option value="spread:${key}">${m.spreads[key].label} (futures & real)</option>`);
  if (fxList.length) opts.push(`<optgroup label="CURRENCIES">${fxList.map((f) => `<option value="fx:${f.id}">${f.label}</option>`).join('')}</optgroup>`);
  sel.innerHTML = opts.join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else { const prim = mk?.primary; if (prim && [...sel.options].some((o) => o.value === prim)) sel.value = prim; }
}
function line(label, arr, color) { return { label, data: arr, borderColor: color, backgroundColor: color + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true, fill: false }; }
function datasetsFor(metric, h, m) {
  const b = m.benchmarks.find((x) => x.id === metric);
  if (b) { const s = h.series[metric]; const sets = []; if (b.paper != null) sets.push(line(`${b.label} futures`, s.paper, '#4aa3ff')); if (b.physical != null) sets.push(line(`${b.label} real`, s.physical, '#ff9e00')); return sets; }
  if (metric.startsWith('basis:')) { const id = metric.slice(6); return [line(`${id} gap`, h.basis[id], '#00c853')]; }
  if (metric.startsWith('spread:')) { const s = h.spreads[metric.slice(7)]; return [line('futures', s.paper, '#4aa3ff'), line('real', s.physical, '#ff9e00')]; }
  return [];
}
// (chart options now come from baseOptions() in the chart kit above.)
// Resolver-shaped series → chart datasets (benchmark futures/real · a gap · a currency).
function seriesLines(r) {
  const has = (a) => a && a.some((v) => v != null);
  if (r.kind === 'fx') return has(r.series.paper) ? [line(r.label, r.series.paper, '#c06bff')] : [];
  if (r.kind === 'basis') return has(r.series.paper) ? [line(r.label, r.series.paper, '#00c853')] : [];
  const out = [];
  if (has(r.series.paper)) out.push(line(`${r.label} futures`, r.series.paper, '#4aa3ff'));
  if (has(r.series.physical)) out.push(line(`${r.label} real`, r.series.physical, '#ff9e00'));
  return out;
}
function chartSummary(r, label) {
  const flat = (s) => (s && typeof s === 'object' ? s.total : s);
  const f = (s) => (s == null ? '—' : signed(s, 1) + '%');
  if (r.kind === 'fx' || r.kind === 'basis') return `${r.label} — ${f(flat(r.summary.paper))} over ${label}`;
  const p = r.summary.paper, ph = r.summary.physical;
  const extra = p && typeof p === 'object' && p.last5y != null ? ` (5y ${f(p.last5y)} · 1y ${f(p.last1y)})` : '';
  return `${label} PERFORMANCE — futures ${f(flat(p))}${extra} · real ${f(flat(ph))}`;
}
function basisBands(arr) {
  const s = (arr || []).filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? { p10: s[Math.floor(s.length * 0.1)], p90: s[Math.floor(s.length * 0.9)], median: s[Math.floor(s.length * 0.5)] } : null;
}
const RANGE_YEARS = { '5y': 5, '10y': 10 };
async function renderChart() {
  if (!history || !data) return;
  const metric = $('metric').value;
  const range = $('range').value;
  const chartKey = metric + '|' + range + '|' + currentMarket;   // guard: drop if the choice changed
  const bench = data.benchmarks.find((b) => b.id === metric);
  const isFx = metric.startsWith('fx:');
  const isSpread = metric.startsWith('spread:');
  let labels, datasets, summary = '', bands = null;
  chartDp = bench ? bench.dp : 2;

  if (range === '6m' && !isFx) {
    // fast path: the shared 6-month daily history (every instrument at once) + seasonal band
    labels = history.dates;
    datasets = datasetsFor(metric, history, data);
    if (metric.startsWith('basis:')) bands = basisBands(history.basis[metric.slice(6)]);
    if (bench) {
      try {
        const sea = await getSeasonal(bench.id);
        if (sea && !sea.error) {
          const band = (lb, arr) => ({ label: lb, data: arr, borderColor: '#3a4d63', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, tension: 0.25, spanGaps: true, fill: false });
          datasets.push(band('5-yr low', labels.map((d) => (sea.low[d.slice(5)] ?? null))));
          datasets.push(band('5-yr high', labels.map((d) => (sea.high[d.slice(5)] ?? null))));
        }
      } catch {}
    }
  } else if (isSpread) {
    labels = history.dates;
    datasets = datasetsFor(metric, history, data);
    summary = 'Range view is per-instrument — pick a benchmark or currency above.';
  } else {
    let r;
    try { r = RANGE_YEARS[range] ? await getLongterm(metric, RANGE_YEARS[range]) : await getRange(metric, range); }
    catch (e) { showError(e.message); markReady('chart'); return; }
    if (!r || r.error || (!r.dates && !r.months)) { showError('No chart data for ' + metric.replace(/^fx:|^basis:/, '')); chartEmpty('chart', 'no chart data for this range'); markReady('chart'); return; }
    labels = r.dates || r.months;
    chartDp = r.dp ?? chartDp;
    datasets = seriesLines(r);
    summary = chartSummary(r, RANGE_YEARS[range] ? RANGE_YEARS[range] + 'Y' : range.toUpperCase());
    if (r.kind === 'basis') bands = basisBands(r.series.paper);
  }

  const histLabels = labels.slice();
  // Forward-curve overlay — the futures months, priced, extended to the right (dashed). Links
  // the price chart to the "prices for months ahead" panel. Segment benchmarks only.
  if (bench && datasets.length) {
    const term = await curveForBench(bench.id);
    if (term && term.available && term.contracts && term.contracts.length >= 2) {
      const MC = { F: 'Jan', G: 'Feb', H: 'Mar', J: 'Apr', K: 'May', M: 'Jun', N: 'Jul', Q: 'Aug', U: 'Sep', V: 'Oct', X: 'Nov', Z: 'Dec' };
      const cs = term.contracts.slice(0, 6);
      const fLabels = cs.map((c) => { const m = MC[(c.label || '')[0]]; return m ? `${m}-${(c.label || '').slice(1)}` : c.label; });
      const lastVal = [...datasets[0].data].reverse().find((v) => v != null);
      const fwdData = histLabels.map(() => null); fwdData[histLabels.length - 1] = lastVal;
      for (const c of cs) fwdData.push(c.price);
      labels = [...histLabels, ...fLabels];
      for (const ds of datasets) ds.data = [...ds.data, ...fLabels.map(() => null)];
      datasets.push({ label: 'Forward curve (futures)', data: fwdData, borderColor: CT.accent, backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 2, pointStyle: 'rectRot', tension: 0.2, fill: false });
    }
  }

  if (chartKey !== $('metric').value + '|' + $('range').value + '|' + currentMarket) return;   // metric/range changed while loading
  $('lt-summary').textContent = (summary ? summary + '  ·  ' : '') + 'hover any point for its % change · click to drop an anchor (●), hover again to measure between two';
  const chartData = { labels, datasets };
  chart = mountChart('chart', chartData, baseOptions({ dp: chartDp, anchorable: true }), [anchorLine, bandsPlugin]);
  markReady('chart');
  if (chart) chart.$bands = bands;
  // Big-move markers — the chart's own largest swings, each tagged with the trusted news behind it.
  let newsId = null;
  if (bench) newsId = currentMarket;
  else if (metric.startsWith('basis:')) { const mk2 = markets.find((m) => m.components.includes(metric.slice(6))); newsId = mk2 ? mk2.id : null; }
  else if (metric.startsWith('spread:')) newsId = 'crude';
  if (chart) await attachMarkers(chart, newsId, histLabels, [datasets[0] ? datasets[0].data.slice(0, histLabels.length) : []], '#chart-events', 'pct', bench ? bench.id : null);
}
// The futures curve for a benchmark (client-cached 5 min) — powers the forward-curve overlay.
const termCache = {};
async function curveForBench(id) {
  const c = termCache[id];
  if (c && Date.now() - c.t < 5 * 60e3) return c.v;
  let v = null;
  try { v = await getJSON('/api/termstructure?id=' + encodeURIComponent(id)); } catch { v = null; }
  termCache[id] = { t: Date.now(), v };
  return v;
}
// Big moves + the trusted news behind them. Markers are the MOVES (not every headline): we find
// the largest swings in the plotted series, then ask the server for the news in a tight window
// around each one (tier-1 sources only) and attach the best match.
function detectBigMoves(labels, data, maxN = 4, mode = 'pct') {
  const rets = [];
  for (let i = 1; i < data.length; i++) {
    const a = data[i - 1], b = data[i];
    if (a == null || b == null) { rets.push(null); continue; }
    rets.push(mode === 'abs' ? (b - a) : (a ? ((b - a) / a) * 100 : null));
  }
  const abs = rets.filter((r) => r != null).map(Math.abs).sort((x, y) => x - y);
  if (abs.length < 12) return [];
  const med = abs[Math.floor(abs.length / 2)] || 0;
  const p95 = abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))] || med;
  let thresh = Math.max(med * 2.5, p95);            // clearly above the market's typical swing
  if (!(thresh > 0)) { const nz = abs.find((x) => x > 0); thresh = nz != null ? nz : Infinity; }   // stepped series (e.g. a policy rate): any change counts
  const idxs = [];
  for (let i = 0; i < rets.length; i++) if (rets[i] != null && Math.abs(rets[i]) >= thresh) idxs.push(i + 1);
  idxs.sort((i, j) => Math.abs(rets[j - 1]) - Math.abs(rets[i - 1]));
  const chosen = [];
  for (const i of idxs) { if (chosen.length >= maxN) break; if (chosen.some((c) => Math.abs(c - i) < 3)) continue; chosen.push(i); }
  return chosen.sort((a, b) => a - b).map((i) => ({ idx: i, date: labels[i], move: rets[i - 1], dir: rets[i - 1] >= 0 ? 'up' : 'down' }));
}
async function chartMoveMarkers(market, labels, seriesList, mode = 'pct', focusId = null) {
  if (!market) return [];
  const lists = (seriesList || []).filter((a) => Array.isArray(a) && a.length >= 12);
  if (!lists.length) return [];
  const byIdx = new Map();
  for (const s of lists) for (const m of detectBigMoves(labels, s, 4, mode)) { const cur = byIdx.get(m.idx); if (!cur || Math.abs(m.move) > Math.abs(cur.move)) byIdx.set(m.idx, m); }
  const moves = [...byIdx.values()].sort((a, b) => Math.abs(b.move) - Math.abs(a.move)).slice(0, 5).sort((a, b) => a.idx - b.idx);
  if (!moves.length) return [];
  const dates = moves.map((mv) => `${mv.date}:${mv.dir === 'up' ? 1 : -1}`).join(',');
  let res = [];
  try { const f = await jget('/api/movewho?id=' + encodeURIComponent(market) + (focusId ? '&focus=' + encodeURIComponent(focusId) : '') + '&dates=' + encodeURIComponent(dates), 300000); res = f.results || []; } catch {}
  const byDate = Object.fromEntries(res.map((r) => [r.date, r.news]));
  const out = [];
  for (const mv of moves) {
    const n = byDate[mv.date];
    if (!n) continue;   // only mark moves we can actually explain with a trusted source
    out.push({ idx: mv.idx, date: mv.date, move: mv.move, mode, kind: n.kind, title: n.title, source: n.source, url: n.url, color: mv.dir === 'up' ? '#2e9e6b' : '#c25b5b' });
  }
  return out;
}
function renderChartEvents(ev, sel = '#chart-events') {
  const el = $(sel); if (!el) return;
  if (!ev || !ev.length) { el.innerHTML = stEmpty('No big move with a trusted-news match on this chart right now.'); return; }
  el.innerHTML = `<span class="dimtext">big moves on this chart — hover a marker for the headline, or open the source:</span> ` + ev.map((e) => { const t = String(e.title); const short = t.length > 72 ? t.slice(0, 71) + '…' : t; return `<a class="ce" href="${e.url}" target="_blank" rel="noopener noreferrer" title="${t.replace(/"/g, '&quot;')}"><span class="ce-dot" style="background:${e.color}"></span>${e.date.slice(5)} ${e.move >= 0 ? '▲' : '▼'} ${moveText(e)} · ${short} <span class="dimtext">(${e.source})</span></a>`; }).join('');
}
// Shared by every chart: detect its big moves, attach the trusted news (as a line INSIDE the
// normal tooltip) and render the clickable chip list under the chart.
async function attachMarkers(chart, newsId, labels, seriesList, chipsSel, mode = 'pct', focusId = null) {
  if (!chart) return;
  // Race guard: if the user switches segment/country/metric before this resolves, a newer call
  // bumps $mseq and we drop the stale result (otherwise old headlines linger on the new chart).
  const seq = (chart.$mseq || 0) + 1; chart.$mseq = seq;
  const chips = $(chipsSel); if (chips) chips.innerHTML = '';
  const ev = await chartMoveMarkers(newsId, labels, seriesList, mode, focusId).catch(() => []);
  if (chart.$mseq !== seq) return;
  chart.$events = ev;
  applyNewsDataset(chart, ev);
  renderChartEvents(ev, chipsSel);
  chart.update('none');
}
// Put the news INSIDE the normal Chart.js tooltip: an invisible dataset with a point at each big
// move, whose tooltip line is the headline. Chart.js handles the hover + hiding (no floating card).
function seriesValueAt(data, i) {
  if (data && data[i] != null) return data[i];
  for (let j = i - 1; j >= 0; j--) if (data[j] != null) return data[j];
  for (let j = i + 1; j < (data ? data.length : 0); j++) if (data[j] != null) return data[j];
  return null;
}
function applyNewsDataset(chart, ev) {
  if (!chart || !chart.data) return;
  chart.data.datasets = (chart.data.datasets || []).filter((d) => !d.$news);
  if (!ev || !ev.length) return;
  const labels = chart.data.labels || [];
  const primary = (chart.data.datasets[0] && chart.data.datasets[0].data) || [];
  if (!primary.some((x) => x != null)) return;
  // A small BAND around each move (not one column) so hovering NEAR it shows the headline.
  const band = labels.length > 200 ? 3 : 2;
  const byIdx = {}; const data = labels.map(() => null);
  for (const e of ev) {
    for (let j = Math.max(0, e.idx - band); j <= Math.min(labels.length - 1, e.idx + band); j++) {
      if (byIdx[j]) continue;                       // an earlier (closer) event already claimed this column
      byIdx[j] = e;
      const v = seriesValueAt(primary, j);
      data[j] = v == null ? 0 : v;
    }
  }
  if (!Object.keys(byIdx).length) return;
  chart.data.datasets.push({ label: 'news', data, borderColor: 'transparent', backgroundColor: 'transparent', borderWidth: 0, pointRadius: 0, pointHitRadius: 16, showLine: false, spanGaps: true, fill: false, $news: byIdx });
}

// ---------------------------------------------------------------------------
// Compare / spread — overlay any two chartable series (commodities, currencies, rates).
// ---------------------------------------------------------------------------
const CMP_PRESETS = [
  ['Brent − WTI', 'brent', 'wti', 'diff'],
  ['Oil vs dollar', 'wti', 'fx:dxy', 'index'],
  ['Gold vs dollar', 'gold', 'fx:dxy', 'index'],
  ['Gold vs real yield', 'gold', 'rate:real10y', 'index'],
  ['Copper vs oil', 'copper', 'wti', 'index'],
];
function cmpOptionsHtml() {
  const opts = [];
  for (const b of data.benchmarks) if (history && (b.id in history.series)) opts.push(`<option value="${b.id}">${b.label}</option>`);
  if (fxList.length) opts.push(`<optgroup label="CURRENCIES">${fxList.map((f) => `<option value="fx:${f.id}">${f.label}</option>`).join('')}</optgroup>`);
  if (rateList.length) opts.push(`<optgroup label="RATES">${rateList.map((r) => `<option value="rate:${r.id}">${r.label}</option>`).join('')}</optgroup>`);
  return opts.join('');
}
let cmpBuilt = false;
function buildCompareOptions() {
  const a = $('cmp-a'), b = $('cmp-b');
  if (!a || !b || !data || cmpBuilt) return;
  const html = cmpOptionsHtml();
  a.innerHTML = html; b.innerHTML = html;
  a.value = 'brent'; b.value = 'wti';            // a sensible default pair
  if ($('cmp-view')) $('cmp-view').value = 'diff';
  cmpBuilt = true;
}
function renderCmpPresets() {
  const el = $('cmp-presets');
  if (el) el.innerHTML = CMP_PRESETS.map(([lab, a, b, v]) => `<button class="ghost small cmp-preset" data-a="${a}" data-b="${b}" data-v="${v}">${lab}</button>`).join('');
}
function cmpUnit(id) {
  if (!id || id.startsWith('fx:') || id.startsWith('rate:')) return '';
  const b = data.benchmarks.find((x) => x.id === id);
  return b ? b.unit : '';
}
// Point COMPARE at the chosen instrument: A = it, B = another component of the segment
// (else the dollar), view = difference only when the units match.
function syncCompareToSelection() {
  const a = $('cmp-a'), b = $('cmp-b');
  if (!a || !b || !data || !a.options.length) return;
  const mk = markets.find((x) => x.id === currentMarket);
  const sel = currentComponent || (mk && mk.primary) || a.value;
  if ([...a.options].some((o) => o.value === sel)) a.value = sel;
  const partner = (mk ? mk.components.map((c) => c.id) : []).find((id) => id !== a.value && [...b.options].some((o) => o.value === id));
  b.value = partner || (a.value === 'fx:dxy' ? 'wti' : 'fx:dxy');
  if ($('cmp-view')) $('cmp-view').value = cmpUnit(a.value) && cmpUnit(a.value) === cmpUnit(b.value) ? 'diff' : 'index';
  renderCompare();
}
async function cmpSeries(metric, range) {
  let r; try { r = await getRange(metric, range); } catch { return null; }
  if (!r || r.error) return null;
  const single = r.kind === 'fx' || r.kind === 'basis' || r.kind === 'rate';
  const arr = single ? r.series.paper : (r.series.paper || r.series.physical);
  const label = r.kind === 'bench' ? `${r.label}${r.series.paper ? ' futures' : ' real'}` : r.label;
  return { dates: r.dates || r.months || [], arr: arr || [], label, dp: r.dp ?? 2, unit: r.unit || '', kind: r.kind };
}
let cmpChart = null;
async function renderCompare() {
  const cv = $('cmp-chart'), sum = $('cmp-summary');
  if (!cv || !data) return;
  const a = $('cmp-a')?.value, b = $('cmp-b')?.value, range = $('cmp-range')?.value || '6m', view = $('cmp-view')?.value || 'index';
  if (!a || !b) return;
  if (a === b) { if (sum) sum.textContent = 'Pick two different series to compare.'; return; }
  const [A, B] = await Promise.all([cmpSeries(a, range), cmpSeries(b, range)]);
  if (!A || !B || !A.arr.some((v) => v != null) || !B.arr.some((v) => v != null)) { if (sum) sum.textContent = 'No data for one of the series over this range.'; return; }
  const axis = [...new Set([...A.dates, ...B.dates])].sort();
  const align = (S) => { const m = new Map(); S.dates.forEach((d, i) => m.set(d, S.arr[i])); return axis.map((d) => (m.has(d) ? m.get(d) : null)); };
  const a2 = align(A), b2 = align(B);
  const first = (arr) => arr.find((v) => v != null);
  const last = (arr) => [...arr].reverse().find((v) => v != null);
  const pct = (arr) => { const f = first(arr), l = last(arr); return f && l ? ((l - f) / f) * 100 : null; };
  const label = range.toUpperCase();
  let datasets, summary;
  if (view === 'diff') {
    const diff = a2.map((v, i) => (v != null && b2[i] != null ? v - b2[i] : null));
    chartDp = Math.max(A.dp, B.dp);
    datasets = [line(`${A.label} − ${B.label}`, diff, '#ff9e00')];
    const now = last(diff), f0 = first(diff);
    const unitNote = A.unit && A.unit === B.unit ? ` ${A.unit}` : ' (units differ)';
    summary = `${A.label} − ${B.label}: ${now == null ? '—' : signed(now, chartDp)}${unitNote}${now != null && f0 != null ? ` · ${signed(now - f0, chartDp)} over ${label}` : ''}`;
  } else {
    chartDp = 1;
    const ba = first(a2), bb = first(b2);
    const ia = a2.map((v) => (v == null || !ba ? null : (v / ba) * 100));
    const ib = b2.map((v) => (v == null || !bb ? null : (v / bb) * 100));
    datasets = [line(A.label, ia, CT.c1), line(B.label, ib, CT.c4)];
    const rateNote = (A.kind === 'rate' || B.kind === 'rate') ? ' · a yield is already a %, so this is its % change (not pp)' : '';
    summary = `${A.label} ${pctf(pct(a2))} vs ${B.label} ${pctf(pct(b2))} over ${label} · both start at 100${rateNote}`;
  }
  if (sum) sum.textContent = summary;
  cmpChart = mountChart('cmp-chart', { labels: axis, datasets }, baseOptions({ dp: chartDp }));
}

async function loadHistory() {
  const empty = { dates: [], series: {}, basis: {}, spreads: {}, deltas: {} };
  try { history = await getJSON('/api/history'); }
  catch {                                   // a 500 is usually a transient upstream hiccup — retry once, then degrade
    await new Promise((r) => setTimeout(r, 1200));
    try { history = await getJSON('/api/history'); } catch { history = empty; }
  }
  if (!history || !history.series) history = empty;
}
// Re-pull the daily history and redraw everything that depends on it (the 1D/1W/1M/YTD/1Y
// strips + sparklines), so they keep up as new daily bars arrive — not just at page load.
async function reloadHistory() {
  try { await loadHistory(); } catch { return; }
  if (!data) return;
  renderCards(data); renderSnapshot(); renderMarketState(); renderTicker(data); renderWatchlist();
  if ($('range') && $('range').value === '6m') renderChart();
}
async function loadMarket() {
  let d = null;
  try { d = await getJSON('/api/market'); }
  catch (e) { console.error('[market]', e.message); if (data && data.benchmarks && data.benchmarks.length) return; throw e; }   // keep the last good board; never blank it on a hiccup
  data = d;
  markReady('data');
  renderCards(data); buildMetricOptions(data); buildBpOptions();
  renderMarketState(); renderSnapshot(); setCardsTitle(); renderTicker(data);
  renderWatchlist(); renderHomeAlerts();
  if (!$('home-rules')?.innerHTML) renderRules();   // metric options need data (+ fx when it lands)
  await renderChart();   // ← render AFTER data exists
  buildCompareOptions(); syncCompareToSelection();
  loadSeasonal();
  loadMarketRead();      // populate the adaptive Big Picture (hero line + panels)
  loadNews();
  updateFreshness(data.updated);
  renderMethodology(data);
}

// ---------------------------------------------------------------------------
// Tankers
// ---------------------------------------------------------------------------
let map, layer;
function initMap() {
  if (typeof L === 'undefined') {   // the Leaflet CDN failed — degrade to a note, don't throw
    const e = $('map-empty');
    if (e) { e.classList.remove('hidden'); e.textContent = 'Map unavailable — the map library didn’t load.'; }
    return;
  }
  map = L.map('map', { worldCopyJump: false, minZoom: 2, maxZoom: 16, maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1.0 }).setView([25, 40], 2);
  const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri', maxZoom: 16, noWrap: true });
  esri.addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, noWrap: true }).addTo(map);
  let fellBack = false;
  esri.on('tileerror', () => { if (fellBack) return; fellBack = true; map.eachLayer((l) => { if (l instanceof L.TileLayer && l !== layer) map.removeLayer(l); }); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18, noWrap: true }).addTo(map); });
  layer = L.layerGroup().addTo(map);
  setTimeout(() => map.invalidateSize(), 200);
}
async function loadTankers() {
  try { tankerInfo = await getJSON('/api/tankers'); } catch (e) { console.error('[tankers]', e.message); return; }   // AIS is flaky; keep the last state
  const s = tankerInfo.status;
  const pill = $('ais-status');
  if (!s.enabled) {
    pill.textContent = 'off'; pill.className = 'pill warn';
    $('ais-help').classList.remove('hidden');
    $('ais-help').innerHTML = `Live tankers are <b>off</b>. Get a free key at <a href="https://aisstream.io" target="_blank">aisstream.io</a>, then start with <code>AISSTREAM_KEY=yourkey npm start</code>.`;
  } else {
    pill.textContent = s.connected ? `live · ${tankerInfo.count} tankers` : 'connecting…';
    pill.className = 'pill ' + (s.connected ? 'ok' : 'warn');
    $('ais-help').classList.add('hidden');
    $('ais-sub').textContent = `${(s.messages || 0).toLocaleString()} AIS messages · last ${ago(s.lastMessage)}`;
  }
  layer.clearLayers();
  for (const v of tankerInfo.tankers) { if (v.lat == null || v.lon == null) continue; L.circleMarker([v.lat, v.lon], { radius: 4, color: '#ff9e00', weight: 1, fillColor: '#ff9e00', fillOpacity: 0.8 }).bindPopup(`<b>${v.name || 'MMSI ' + v.mmsi}</b><br>${(v.sog ?? 0).toFixed(1)} kn · MMSI ${v.mmsi}`).addTo(layer); }
  $('map-empty').classList.toggle('hidden', tankerInfo.count > 0);
  const rows = tankerInfo.tankers.slice(0, 60).map((v) => `<div class="t"><span>${v.name || '(' + v.mmsi + ')'}</span><span>${(v.sog ?? 0).toFixed(1)} kn</span><span>${v.lat.toFixed(1)}, ${v.lon.toFixed(1)}</span></div>`).join('');
  $('tanker-list').innerHTML = `<div class="t h"><span>VESSEL (${tankerInfo.count} TRACKED)</span><span>SPEED</span><span>POSITION</span></div>` + rows;
  if (data) renderAdaptive();   // refresh the ship row of the adaptive Big Picture
  renderHomeAlerts();           // idle-ship count feeds the alerts board
}

// ---------------------------------------------------------------------------
// New panels: context, inventories, positioning, sectors, chokepoints
// ---------------------------------------------------------------------------
const pctClass = (p) => (p == null ? '' : p >= 80 ? 'hot' : p <= 20 ? 'cold' : '');
function ctxRow(k, pct, value) {
  return `<div class="ctx-row"><span class="ctx-k">${k}</span><span class="ctx-bar"><i style="width:${pct == null ? 0 : pct}%"></i></span><span class="ctx-p ${pctClass(pct)}">${pct == null ? '—' : pct.toFixed(0) + '/100'}</span><span class="ctx-v">${value}</span></div>`;
}
function renderInventories(d) {
  if (!d || !d.items?.length) { $('inventories').innerHTML = stEmpty('EIA key needed, or no inventory data.'); return; }
  const LBL = { crude: 'Crude oil', cushing: 'Cushing (delivery hub)', gasoline: 'Gasoline', distillate: 'Diesel & heating oil', spr: 'Strategic reserve' };
  $('inv-date').textContent = 'weekly US stockpiles · week of ' + d.items[0].period;
  const fmtN = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  const crude = d.items.find((i) => i.key === 'crude');
  const read = crude?.surprise != null
    ? (crude.surprise < 0 ? 'Crude stocks <b>fell more than usual</b> this week → bullish for oil.' : 'Crude stocks <b>built more than usual</b> → bearish for oil.')
    : '';
  const rows = d.items.map((i) => {
    const sur = i.surprise;
    const range = i.seasonalMin != null ? ` <span class="dimtext">(usual ${i.seasonalMin.toLocaleString()} to ${i.seasonalMax.toLocaleString()})</span>` : '';
    const tag = sur == null ? '<span class="dimtext">—</span>'
      : sur < 0 ? `<span class="pos">drew ${Math.abs(sur).toLocaleString()} more than usual</span>${range}`
        : `<span class="neg">built ${sur.toLocaleString()} vs usual</span>${range}`;
    return `<div class="t inv"><span class="inv-l">${LBL[i.key] || i.label}</span><span class="num">${i.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span><span class="num ${cls(i.wow)}">${fmtN(i.wow)}</span><span class="num">${tag}</span></div>`;
  }).join('');
  $('inventories').innerHTML =
    (read ? `<div class="read-line">${read}</div>` : '') +
    `<div class="t inv h"><span class="inv-l">SERIES (million barrels)</span><span class="num">LEVEL</span><span class="num">THIS WEEK</span><span class="num">vs NORMAL</span></div>` + rows +
    (d.gas ? `<div class="read-line" style="border-top:1px solid var(--line)">Natural gas storage: <b>${d.gas.value.toLocaleString()} BCF</b> (${d.gas.wow >= 0 ? '+' : ''}${d.gas.wow} this week${d.gas.surprise != null ? `, vs a normal ${d.gas.surprise >= 0 ? '+' : ''}${d.gas.surprise}` : ''}) — ${d.gas.wow < 0 ? 'a draw is bullish for gas' : 'a build is bearish for gas'}.</div>` : '');
}
// ---------------------------------------------------------------------------
// Positioning (CFTC, weekly) — who is crowded. Fetched per segment; the server supplies the
// plain read (positioningFlag / positioningRead in src/lib.js).
// ---------------------------------------------------------------------------
async function loadPositioning() {
  const el = $('positioning'); if (!el) return;
  const seg = currentMarket;
  el.innerHTML = stLoading('Loading positioning…');
  let d = null;
  try { d = await jget('/api/positioning?segment=' + encodeURIComponent(seg), 6 * 60e3); } catch { d = null; }
  if (seg !== currentMarket) return;   // the segment changed while this was in flight
  markReady('positioning');
  renderPositioning(d);
}
function renderPositioning(d) {
  const el = $('positioning'); if (!el) return;
  const sub = $('pos-sub');
  const items = (d && d.items) || [];
  if (!items.length) { el.innerHTML = stEmpty('No CFTC positioning series covers this segment.'); if (sub) sub.textContent = ''; return; }
  const mk = markets.find((m) => m.id === currentMarket);
  const primary = items.find((it) => it.id === (mk && mk.primary)) || items[0];
  const f = primary.flag || { label: '—', tone: 'mid' };
  const num = (n) => (n == null ? '—' : (n < 0 ? '−' : '+') + Math.abs(n).toLocaleString());
  const pct = primary.pct3y;
  if (sub) sub.textContent = `CFTC · managed money · weekly · as of ${(primary.latest && primary.latest.date) || '—'}`;
  let html = `<div class="pos-hero"><span class="pos-net ${primary.latest && primary.latest.net >= 0 ? 'pos' : 'neg'}">${primary.latest ? num(primary.latest.net) : '—'}</span>`
    + `<span class="pos-lab">contracts · ${String(primary.label).replace(/ spec net.*/, '')} spec net</span><span class="pos-flag ${f.tone}">${f.label}</span></div>`
    + `<div class="pos-row"><span>${pct == null ? 'little history' : `${Math.round(pct)}th pctile (3y)`}</span>`
    + `<span>this week <b class="${primary.wow >= 0 ? 'pos' : 'neg'}">${num(primary.wow)}</b></span>`
    + (primary.latest && primary.latest.long != null ? `<span>long <b>${primary.latest.long.toLocaleString()}</b></span><span>short <b>${primary.latest.short.toLocaleString()}</b></span>` : '')
    + (primary.oi ? `<span>open interest <b>${primary.oi.toLocaleString()}</b>${primary.oiChange != null ? ` (${num(primary.oiChange)})` : ''}</span>` : '')
    + '</div>';
  const spark = sparkline((primary.history || []).map((r) => r.net));
  if (spark) html += `<div class="pos-spark" aria-hidden="true">${spark}</div>`;
  if (primary.read) html += `<div class="pos-note dimtext">${primary.read}</div>`;
  const others = items.filter((it) => it !== primary);
  if (others.length) html += `<div class="pos-chips"><span class="dimtext" style="align-self:center">also covered:</span>`
    + others.map((it) => `<span class="pos-chip" title="${it.label} — ${it.read || ''}">${String(it.label).replace(/\s*\(.*\)/, '')} <em>${it.latest ? num(it.latest.net) : '—'}</em> <span class="pos-flag ${(it.flag || {}).tone || 'mid'}">${(it.flag || {}).label || ''}</span></span>`).join('') + '</div>';
  el.innerHTML = html;
}
// Options (CBOE delayed, via the commodity's ETF proxy) — vol, put/call and 25-delta skew.
async function loadOptions() {
  const el = $('options'); if (!el) return;
  const seg = currentMarket;
  const mk = markets.find((m) => m.id === seg) || {};
  const id = currentComponent || mk.primary || seg;
  el.innerHTML = stLoading('Loading options…');
  let d = null; try { d = await jget('/api/options?id=' + encodeURIComponent(id), 1800000); } catch { d = null; }
  if (seg !== currentMarket || id !== (currentComponent || (markets.find((m) => m.id === currentMarket) || {}).primary || currentMarket)) return;
  renderOptions(d);
}
function renderOptions(d) {
  const el = $('options'); if (!el) return;
  const sub = $('opt-sub');
  if (!d || d.error) { el.innerHTML = stEmpty('No free options series for this instrument — its ETF proxy has no listed options.'); if (sub) sub.textContent = ''; return; }
  if (sub) sub.textContent = `${d.proxy} ETF options · CBOE delayed · as of ${d.asOf || '—'}`;
  const iv = d.atmIv, pc = d.pcOi, pcv = d.pcVol, sk = d.skew;
  const pcCls = pc == null ? '' : pc >= 1.2 ? 'neg' : pc <= 0.8 ? 'pos' : '';
  const skCls = sk == null ? '' : sk >= 1 ? 'neg' : sk <= -1 ? 'pos' : '';
  const cell = (k, v, cls, s) => `<div class="opt-cell"><div class="opt-k">${k}</div><div class="opt-v ${cls}">${v}</div><div class="opt-s dimtext">${s}</div></div>`;
  el.innerHTML = '<div class="opt-grid">'
    + cell('ATM IMPLIED VOL', iv == null ? '—' : iv.toFixed(1) + '%', '', iv == null ? '' : `${iv >= 40 ? 'elevated' : iv <= 20 ? 'calm' : 'normal'} · ${d.expiry || ''}`)
    + cell('PUT / CALL · open interest', pc == null ? '—' : pc.toFixed(2), pcCls, pc == null ? '' : pc >= 1.2 ? 'put-heavy — defensive' : pc <= 0.8 ? 'call-heavy — bullish' : 'balanced')
    + cell('PUT / CALL · volume', pcv == null ? '—' : pcv.toFixed(2), '', "today's flow")
    + cell('25Δ SKEW · put − call IV', sk == null ? '—' : (sk > 0 ? '+' : '') + sk.toFixed(1), skCls, sk == null ? '' : sk >= 1 ? 'puts bid — hedging' : sk <= -1 ? 'calls bid — chasing upside' : 'flat')
    + '</div>'
    + `<div class="pos-note dimtext">From the <b>${d.proxy}</b> ETF's options (a liquid proxy, not the futures options themselves) · CBOE delayed. Total open interest ${Number(d.totalOi || 0).toLocaleString()}. IV rank needs a stored history, so it is not shown.</div>`;
}
function sparkline(vals, w = 240, h = 40) {
  const xs = vals.filter((v) => v != null);
  const min = Math.min(...xs), max = Math.max(...xs), rng = max - min || 1;
  const pts = xs.map((v, i) => `${(i / (xs.length - 1)) * w},${h - ((v - min) / rng) * h}`).join(' ');
  return `<svg width="${w}" height="${h}" class="spark"><polyline points="${pts}" fill="none" stroke="#ff9e00" stroke-width="1.5"/></svg>`;
}
function sectorRead(m, a, t) {
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const cracks = crackSpreads(m);
  const d321 = cracks.find((c) => c.label.startsWith('3-2-1'));
  const diesel = cracks.find((c) => c.label.startsWith('Diesel crack (paper)'));
  const lines = [];
  const back = (by.brent?.basis ?? 0) > 0 || (by.wti?.basis ?? 0) > 0;
  lines.push(back
    ? 'Backwardated, tight physical market → favours <b>E&amp;P</b> (COP, EOG, OXY, FANG) cash flow; storage plays unattractive.'
    : 'Contango → storage economics improve; supportive for <b>floating-storage tankers</b>.');
  if (d321) lines.push(`3-2-1 crack ${signed(d321.value)} → ${d321.value > 18 ? '<b>refiners</b> (VLO, PSX, MPC, DINO) earning strong margins.' : d321.value > 8 ? 'refiners modestly profitable.' : 'weak margins → pressure on <b>refiners</b>.'}`);
  if (diesel) lines.push(`Diesel crack ${signed(diesel.value)} → diesel-levered refiners ${diesel.value > 25 ? 'outperforming' : 'under pressure'}.`);
  if (a?.arb) lines.push(a.arb.open
    ? `Export arb OPEN (net ${signed(a.arb.net)}) → USGC barrels pulled to Europe, supportive for <b>crude tanker rates</b> (FRO, DHT, STNG, INSW).`
    : 'Export arb closed → less long-haul crude demand, softer freight.');
  const idlers = (t.tankers || []).filter((v) => (v.sog ?? 0) < 1).length;
  if (t.status?.enabled) lines.push(`${idlers} tankers idle → ${idlers > 12 ? 'rising floating storage (watch tanker names).' : 'normal transit.'}`);
  lines.push('High crude + wide cracks squeeze <b>airlines</b> (DAL, UAL, AAL) and <b>petrochemicals</b> (LYB) via input costs.');
  return lines;
}
function renderSectors(eq, m, a, t) {
  $('sector-read').innerHTML = '<ul class="ins-list">' + sectorRead(m, a, t).map((x) => `<li>${x}</li>`).join('') + '</ul>';
  if (!eq) { $('sectors').innerHTML = ''; return; }
  $('eq-date').textContent = 'quotes ' + new Date().toLocaleTimeString('en-GB');
  $('sectors').innerHTML = eq.groups.map((g) => {
    const qs = g.quotes.map((q) => `<span class="eq ${cls(q.pct)}"><b>${q.symbol}</b> ${q.price != null ? q.price.toFixed(q.price < 10 ? 3 : 2) : '—'} <em>${q.pct != null ? pctf(q.pct) : ''}</em></span>`).join('');
    return `<div class="eq-group"><div class="eq-name">${g.name} <span class="dimtext">— ${g.why}</span></div><div class="eq-list">${qs}</div></div>`;
  }).join('');
}
function renderChokepoints(d) {
  const el = $('chokepoints');
  if (!el || !d?.chokepoints) return;
  el.innerHTML = '<div class="chokes-h dimtext">TANKERS IN CHOKEPOINTS (live)</div>' +
    d.chokepoints.map((c) => `<span class="choke"><b>${c.count}</b> ${c.name}</span>`).join('');
}
const MONTHS = { F: 'Jan', G: 'Feb', H: 'Mar', J: 'Apr', K: 'May', M: 'Jun', N: 'Jul', Q: 'Aug', U: 'Sep', V: 'Oct', X: 'Nov', Z: 'Dec' };
const mname = (l) => `${MONTHS[l[0]] || l[0]} '${l.slice(1)}`;
function curveBlock(name, c) {
  if (!c?.contracts || c.contracts.length < 2) return '';
  const unit = c.unit || '$/bbl';
  const dp = c.dp ?? 2;
  const prices = c.contracts.map((x) => x.price);
  const max = Math.max(...prices), min = Math.min(...prices);
  const rows = c.contracts.slice(0, 9).map((x) => {
    const w = ((x.price - min) / (max - min || 1)) * 100;
    return `<div class="cbar"><span class="cl">${mname(x.label)}</span><span class="cb"><i style="width:${Math.max(w, 4)}%"></i></span><span class="cp">${x.price.toFixed(2)}</span></div>`;
  }).join('');
  const shape = c.shape === 'Backwardation' ? 'pricier NOW than later → tight' : 'cheaper now than later → well supplied';
  const carry = c.rollMonthly == null ? '' : `<div class="curve-carry">Roll yield (long, rolling monthly): <b class="${cls(c.rollMonthly)}">${signed(c.rollMonthly, dp)} ${unit}/month</b>${c.rollYieldAnn != null ? ` ≈ <b class="${cls(c.rollYieldAnn)}">${signed(c.rollYieldAnn, 1)}%/yr</b>` : ''} <span class="dimtext">— ${c.rollMonthly >= 0 ? 'you are paid to roll (backwardation)' : 'rolling costs you (contango)'}</span></div>`;
  const cal = (c.calendar || []).slice(0, 4).map((s) => `<span class="cal-sp"><span class="cal-m">${mname(s.from)}−${mname(s.to)}</span> <b class="${cls(s.value)}">${signed(s.value, dp)}</b></span>`).join('');
  const calLine = cal ? `<div class="curve-cal"><span class="dimtext">Calendar spreads:</span> ${cal}</div>` : '';
  return `<div class="curve-blk"><div class="curve-h">${name} — <b class="${c.m1m2 >= 0 ? 'pos' : 'neg'}">${shape}</b> · this month vs next <b class="${cls(c.m1m2)}">${signed(c.m1m2, 2)}</b>${c.m1m6 != null ? ` · vs 6 months ahead <b class="${cls(c.m1m6)}">${signed(c.m1m6, 2)}</b>` : ''}</div>${carry}${calLine}${rows}</div>`;
}
let curveHistChart;
function renderCurveHistory(d) {
  const cv = $('curvehist');
  const block = $('curvehist-block');
  if (!cv) return;
  if (!d?.dates?.length || d.dates.length < 20) { if (block) block.style.display = 'none'; return; }
  if (block) block.style.display = '';
  const data = { labels: d.dates, datasets: [line('WTI: this month − next month', d.m1m2, CT.c2)] };
  curveHistChart = mountChart('curvehist', data, baseOptions({ dp: 2, yTitle: '$/bbl' }));
  attachMarkers(curveHistChart, currentMarket, d.dates, [d.m1m2], '#curvehist-events');
}
function renderCurve(d) { if (!d) return; $('curve').innerHTML = curveBlock('WTI', d.wti) + curveBlock('Brent', d.brent); }
// The curve ALWAYS follows the selected segment (no second picker).
async function renderCurveForSegment() {
  const k = segKey();
  const mk = markets.find((x) => x.id === currentMarket);
  setTitle('curve-title', mk ? mk.label.toUpperCase() : '');
  const el = $('curve');
  if (!el) return;
  if (currentMarket === 'crude') { try { const c = await jget('/api/curve', 60000); if (k !== segKey()) return; renderCurve(c); return; } catch {} }
  const comps = ((mk ? mk.components : []).map((c) => data.benchmarks.find((x) => x.id === c.id))).filter((b) => b && b.curve);
  el.innerHTML = stLoading('Loading the curve…');
  const results = await Promise.all(comps.map((b) => jget('/api/termstructure?id=' + encodeURIComponent(b.id), 180000).catch(() => null)));
  if (k !== segKey()) return;
  const html = results.filter((r) => r && r.available).map((r) => curveBlock(r.label, r)).join('');
  el.innerHTML = html || stEmpty('No free month-by-month curve for this segment — only a front-month price.');
}
// Soybean crush — the processor margin (meal + oil − beans, $/bu) for the grains segment.
async function loadCrush() {
  const el = $('crush');
  if (!el) return;
  if (currentMarket !== 'grains') { el.innerHTML = ''; return; }
  const k = segKey();
  el.innerHTML = stLoading('Reading the soybean crush…');
  let d; try { d = await jget('/api/crush', 300000); } catch { d = null; }
  if (k !== segKey() || currentMarket !== 'grains') return;
  renderCrush(d);
}
let crushChart;
function renderCrush(d) {
  const el = $('crush'); if (!el) return;
  if (!d || d.error || d.crush == null || !d.legs) { el.innerHTML = stError('Soybean crush data isn\u2019t available right now.'); return; }
  const read = d.crush > 2 ? 'fat' : d.crush > 1 ? 'healthy' : d.crush > 0 ? 'thin' : 'negative — processors losing money';
  const oilRead = d.oilShare == null ? '—' : d.oilShare >= 45 ? 'oil-led (soyoil rich vs meal)' : d.oilShare <= 38 ? 'meal-led (soymeal rich vs oil)' : 'balanced';
  el.innerHTML = `<div class="cards">
    <div class="card"><h3>Soybean crush <span>$/bushel</span></h3>
      <div class="row"><span class="k">Crush margin</span><span class="v basis ${cls(d.crush)}">${signed(d.crush, 2)}</span></div>
      <div class="row"><span class="k">How extreme</span><span class="v">${d.pct == null ? '—' : d.pct.toFixed(0) + '/100'}</span></div>
      <div class="row"><span class="k">Read</span><span class="v dimtext" style="font-weight:400">${read}</span></div></div>
    <div class="card"><h3>Oil share <span>% of product value</span></h3>
      <div class="row"><span class="k">Oil share</span><span class="v">${d.oilShare == null ? '—' : d.oilShare.toFixed(1) + '%'}</span></div>
      <div class="row"><span class="k">How extreme</span><span class="v">${d.oilSharePct == null ? '—' : d.oilSharePct.toFixed(0) + '/100'}</span></div>
      <div class="row"><span class="k">Read</span><span class="v dimtext" style="font-weight:400">${oilRead}</span></div></div>
    <div class="card"><h3>The three legs <span>$/bushel</span></h3>
      <div class="row"><span class="k">Meal value</span><span class="v">${signed(d.legs.mealValue, 2)}</span></div>
      <div class="row"><span class="k">Oil value</span><span class="v">${signed(d.legs.oilValue, 2)}</span></div>
      <div class="row"><span class="k">Bean cost</span><span class="v">${signed(-Math.abs(d.legs.beanCost), 2)}</span></div></div>
  </div>`;
  renderCrushHistory(d.history);
}
function renderCrushHistory(h) {
  const cv = $('crushhist'); if (!cv || !h?.dates?.length) return;
  const data = { labels: h.dates, datasets: [
    { label: 'Crush $/bu', data: h.crush, borderColor: CT.accent, backgroundColor: CT.accent + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, yAxisID: 'y' },
    { label: 'Oil share %', data: h.oilShare, borderColor: CT.c1, backgroundColor: CT.c1 + '22', borderWidth: 1.5, pointRadius: 0, tension: 0.25, yAxisID: 'y1' },
  ] };
  crushChart = mountChart('crushhist', data, baseOptions({ dp: 2, yTitle: '$/bu', y1Title: '%' }));
  attachMarkers(crushChart, 'grains', h.dates, [h.crush], '#crush-events');
}

// Seasonality — where the price sits vs its 5-year day-of-year band (gas/grains/softs).
async function loadSeasonal() {
  const el = $('seasonal');
  if (!el || !data) return;
  const k = segKey();
  const mk = markets.find((x) => x.id === currentMarket);
  const b = mk ? data.benchmarks.find((x) => x.id === mk.primary) : null;
  if (!b) { el.innerHTML = ''; return; }
  el.innerHTML = stLoading('Reading 5-year seasonality…');
  let sea; try { sea = await getSeasonal(b.id); } catch { sea = null; }
  if (k !== segKey()) return;
  renderSeasonal(sea, b);
}
function renderSeasonal(sea, b) {
  const el = $('seasonal');
  if (!el) return;
  const sub = $('seasonal-sub');
  if (sub) sub.textContent = b ? `${b.label} · 5-year, day-of-year` : '';
  const g = sea && !sea.error ? sea.grade : null;
  if (!g) { el.innerHTML = stEmpty('No 5-year seasonal history for this instrument.'); return; }
  const dp = (b && b.dp) ?? 2;
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const pos = clamp(g.pos);
  const medPos = g.median != null && g.high > g.low ? clamp(((g.median - g.low) / (g.high - g.low)) * 100) : 50;
  const ahead = sea.ahead;
  const aheadTxt = ahead == null ? '' : ` It normally ${ahead >= 0 ? 'rises' : 'falls'} ~${Math.abs(ahead).toFixed(0)}% over the next month.`;
  const price = b ? (b.paper != null ? b.paper : b.physical) : null;
  el.innerHTML = `
    <div class="seas-head"><span class="seas-grade">${g.label}</span><span class="seas-pos">${g.pos}/100 of its usual range for this time of year</span></div>
    <div class="seas-bar">
      <span class="seas-end">${Number(g.low).toFixed(dp)}</span>
      <div class="seas-track"><i class="seas-med" style="left:${medPos}%"></i><b class="seas-now" style="left:${pos}%"></b></div>
      <span class="seas-end">${Number(g.high).toFixed(dp)}</span>
    </div>
    <div class="read-line">Now <b>${price == null ? '—' : Number(price).toFixed(dp)}</b>${g.vsMedian != null ? ` — ${g.vsMedian >= 0 ? '+' : ''}${g.vsMedian}% vs the 5-year median` : ''}.${aheadTxt}</div>`;
}
function renderAnalogue(a) {
  if (!a || a.error) { $('analogue').innerHTML = a?.error ? stError('Couldn\u2019t load the analogue — retrying.') : stLoading(); return; }
  const rows = a.horizons.map((h) => (h.n
    ? `<tr><td>${h.h} days</td><td>${h.n}</td><td class="${cls(h.median)}">${signed(h.median, 2)}</td><td>${h.q25.toFixed(2)} … ${h.q75.toFixed(2)}</td><td>${h.pctUp.toFixed(0)}%</td></tr>`
    : `<tr><td>${h.h} days</td><td colspan="4" class="dimtext">never this extreme</td></tr>`)).join('');
  const h20 = a.horizons.find((x) => x.h === 20);
  let verdict = '';
  if (h20 && h20.n) {
    const side = a.pct >= 80 ? (h20.median < 0 ? 'came back <b>DOWN</b>' : 'kept going <b>UP</b>') : a.pct <= 20 ? (h20.median > 0 ? 'bounced <b>UP</b>' : 'kept going <b>DOWN</b>') : 'had no clear pattern';
    verdict = `<b>WHAT USUALLY HAPPENED:</b> when this was as extreme, over the next 20 days it ${side} — a typical move of ${signed(h20.median, 2)}, rising ${h20.pctUp.toFixed(0)}% of the time.`;
  }
  $('analogue').innerHTML =
    `<div class="an-head">Right now: <b>${a.current.toFixed(2)}</b> — this rare (${a.pct.toFixed(0)}/100) has only happened <b>${a.analogN}</b> times in the last ${a.years} years.</div>` +
    `<table class="antable"><thead><tr><th>Looking ahead</th><th>Times seen</th><th>Typical move</th><th>Usual range</th><th>Went up</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="an-verdict">${verdict}</div>`;
}
async function loadAnalogue() {
  try { renderAnalogue(await getJSON('/api/analogue?metric=' + encodeURIComponent($('an-metric').value))); }
  catch (e) { showError(e.message); }
}
function renderFlows(d) {
  if (!d?.regions) { $('flows').innerHTML = ''; return; }
  const regions = d.regions.map((r) => `<span class="choke"><b>${r.count}</b> ${r.name}</span>`).join('');
  const rates = (d.rates || []).map((r) => `<span class="choke ${r.perMin === 0 ? 'cold' : ''}"><b>${r.perMin}</b>/min ${r.name}</span>`).join('');
  const e = d.exit; const total = (e.eastbound + e.westbound) || 1;
  const ew = (e.eastbound / total * 100).toFixed(0), ww = (e.westbound / total * 100).toFixed(0);
  const darkNote = (d.dark && d.dark.length)
    ? `<div class="qflag watch" style="margin:8px 12px"><b>No ship signals</b> in: ${d.dark.join(', ')} — this area has gone quiet (ships may be switching off trackers, or the feed is limited).</div>`
    : '';
  const ms = d.marketStress;
  const stressHtml = ms ? `<div class="chokes-h dimtext" style="padding:10px 12px 0">WHAT PRICES ARE SAYING (ships go dark, but prices can't)</div>
    <div style="padding:6px 12px 0"><div class="verdict ${ms.score >= 2 ? 'tight' : 'mixed'}">${ms.verdict}</div>
    ${ms.signals.map((s) => `<div class="ev"><span class="ev-l">${s.label}</span><span class="ev-v ${s.hot ? 'pos' : ''}">${s.value != null ? (s.value >= 0 ? '+' : '') + Number(s.value).toFixed(2) : '—'}</span><span class="tag ${s.hot ? 'tight' : 'neutral'}">${s.hot ? 'STRESS' : 'ok'}</span><span class="ev-n dimtext">${s.hot ? 'pricing disruption' : 'normal'}</span></div>`).join('')}</div>` : '';
  const an = d.anomalies || {};
  const anHtml = (an.spoof || an.darkGap) ? `<div class="chokes-h dimtext" style="padding:0 12px">TRACKER ODDITIES (ships still visible)</div>
    <div class="chokes"><span class="choke"><b>${an.spoof || 0}</b> fake jumps (spoofing)</span><span class="choke"><b>${an.darkGap || 0}</b> went silent (hidden trips)</span></div>` : '';
  const routes = (d.routes || []).map((r) => `<span class="choke ${r.perMin === 0 ? 'cold' : ''}"><b>${r.count}</b> ${r.name} <span class="dimtext">${r.perMin}/min</span></span>`).join('');
  const routesHtml = `<div class="chokes-h dimtext" style="padding:0 12px">ARE SHIPS DODGING CHOKEPOINTS?</div><div class="chokes">${routes}</div>`;
  const divHtml = d.diversion ? `<div class="qflag watch" style="margin:8px 12px">${d.diversion}</div>` : '';
  $('flows').innerHTML =
    `<div class="chokes-h dimtext">MIDDLE-EAST SHIPPING (live)</div>
     <div class="chokes">${regions}</div>
     <div class="chokes-h dimtext" style="padding:0 12px">SHIP-TRACKER SIGNALS (per minute · last 5 min)</div>
     <div class="chokes">${rates}</div>
     ${darkNote}
     ${routesHtml}
     ${divHtml}
     ${stressHtml}
     ${anHtml}
     <div class="flowbar"><div class="dimtext">Where ships leaving the Gulf are heading</div>
       <div class="fb"><span class="fb-e" style="width:${ew}%">${e.eastbound} heading east → Asia</span><span class="fb-w" style="width:${ww}%">${e.westbound} heading west → Suez</span></div>
       <div class="dimtext">${e.total} ships in the exit zone · ${e.moving} moving · ${e.idle} idle</div></div>`;
}
let crackHistChart;
function renderCrackHistory(h) {
  const cv = $('crackhist');
  if (!cv || !h?.dates?.length) return;
  const data = { labels: h.dates, datasets: [
    { label: 'Diesel', data: h.diesel, borderColor: CT.c2, backgroundColor: CT.c2 + '22', borderWidth: 2, pointRadius: 0, tension: 0.25 },
    { label: 'Gasoline', data: h.gasoline, borderColor: CT.c1, backgroundColor: CT.c1 + '22', borderWidth: 2, pointRadius: 0, tension: 0.25 },
    { label: '3-2-1', data: h.c321, borderColor: CT.c3, backgroundColor: CT.c3 + '22', borderWidth: 1.5, pointRadius: 0, tension: 0.25 },
  ] };
  crackHistChart = mountChart('crackhist', data, baseOptions({ dp: 2, yTitle: '$/bbl' }));
  attachMarkers(crackHistChart, 'refined', h.dates, [h.diesel, h.c321, h.gasoline], '#crack-events');
}
function renderProducts(d) {
  if (!d?.items) { $('products').innerHTML = ''; return; }
  const cards = d.items.map((i) => {
    const read = i.crack == null ? '—' : i.crack > 25 ? 'excellent' : i.crack > 12 ? 'good' : i.crack > 5 ? 'ok' : 'poor';
    return `<div class="card"><h3>${i.label} <span>profit / barrel</span></h3>
      <div class="row"><span class="k">Profit / barrel</span><span class="v basis ${cls(i.crack)}">${signed(i.crack, 2)}</span></div>
      <div class="row"><span class="k">How extreme</span><span class="v">${i.pct != null ? i.pct.toFixed(0) + '/100' : '—'}</span></div>
      <div class="row"><span class="k">Read <span class="qi" title="${i.note}">ⓘ</span></span><span class="v dimtext" style="font-weight:400">${read}</span></div></div>`;
  }).join('');
  $('products').innerHTML = `<div class="cards">${cards}</div>`;
  renderCrackHistory(d.history);
}
let rerouteChart;
function processSar() {
  const cv = $('sar-canvas');
  if (!cv) return;
  const img = new Image();
  img.onload = () => {
    const W = img.width, H = img.height;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    let data;
    try { data = ctx.getImageData(0, 0, W, H).data; } catch { const s = $('sar-count'); if (s) s.textContent = 'could not analyse image'; return; }
    const T = 220;
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) bin[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) > T ? 1 : 0;
    const seen = new Uint8Array(W * H), stack = [], points = [];
    for (let start = 0; start < W * H; start++) {
      if (!bin[start] || seen[start]) continue;
      stack.length = 0; stack.push(start); seen[start] = 1;
      let area = 0, sx = 0, sy = 0;
      while (stack.length) {
        const p = stack.pop(), x = p % W, y = (p / W) | 0;
        area++; sx += x; sy += y;
        if (x > 0 && bin[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < W - 1 && bin[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && bin[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
        if (y < H - 1 && bin[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
      }
      if (area >= 2 && area <= 40) points.push({ x: sx / area, y: sy / area });
    }
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ff3b30';
    for (const p of points) { ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.stroke(); }
    $('sar-count').innerHTML = `<b>${points.length}</b> small bright objects circled — likely <b>oil platforms or ships</b>. (At this zoom a single tanker is under 1 pixel, so treat the count as indicative, not exact.)`;
  };
  img.onerror = () => { const s = $('sar-count'); if (s) s.textContent = 'image unavailable'; };
  img.src = '/api/sar/image';
}

function renderSatellite(sar, flares) {
  let html = '';
  if (sar && !sar.error) {
    const latest = sar.latest ? new Date(sar.latest.time).toLocaleString() : '—';
    html += `<div class="read-line"><b>How the Gulf is visible from space.</b> This is <b>radar, not a photo</b> — so it works at night and through cloud. Latest pass: <b>${latest}</b>.</div>
      <div class="legend"><span class="lg"><i class="sw bright"></i> bright = a solid object (ship, platform) or land</span><span class="lg"><i class="sw dark"></i> dark = open water</span><span class="lg"><i class="sw circle"></i> red circle = a small object detected</span></div>
      <div class="sarimg"><canvas id="sar-canvas"></canvas><div id="sar-count" class="dimtext">reading the image…</div></div>`;
  }
  if (flares && !flares.error) {
    const regions = Object.entries(flares.byRegion || {}).map(([k, v]) => `<span class="choke"><b>${v}</b> ${k}</span>`).join('');
    html += `<div class="read-line" style="border-top:1px solid var(--line)"><b>Gas flames = how much oil is being produced.</b> Oil fields burn off gas in flames satellites can see from orbit. More flames ≈ more output; fewer ≈ fields shut down. Right now: <b>${flares.total}</b> flames seen in the last day.</div>
      <div class="chokes">${regions}</div>`;
    if (flares.trend?.length > 1) html += `<div class="dimtext" style="padding:4px 12px 10px">flames seen per day: ${flares.trend.map((t) => `${t.date.slice(5)}: ${t.count}`).join(' · ')}</div>`;
  }
  $('satellite').innerHTML = html || stEmpty('No satellite picture right now.');
  if (sar && !sar.error) processSar();
}
function renderReroute(d) {
  const cv = $('reroute');
  if (!cv || !d?.series?.length) return;
  const s = d.series;
  const labels = s.map((x) => new Date(x.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const data = { labels, datasets: [
    { label: 'Cape of Good Hope', data: s.map((x) => x.cape), borderColor: CT.c2, backgroundColor: CT.c2 + '22', borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true },
    { label: 'Red Sea / Suez', data: s.map((x) => x.suez), borderColor: CT.c1, backgroundColor: CT.c1 + '22', borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true },
  ] };
  rerouteChart = mountChart('reroute', data, baseOptions({ dp: 0 }));
}
async function loadReroute() { try { renderReroute(await getJSON('/api/reroute')); } catch {} }
function macroTile(label, value, sub, klass, metric, extra) {
  return `<div class="kpi${metric ? ' clickable' : ''}"${metric ? ` data-metric="${metric}" title="Click for the chart"` : ''}><div class="kpi-l">${label}</div><div class="kpi-v ${klass || ''}">${value}</div><div class="kpi-s dimtext">${sub || ''}</div>${extra || ''}</div>`;
}
function renderMacroRegion() {
  const sel = $('macro-country');
  const list = (macroCountries && macroCountries[macroRegion]) || [];
  if (sel) {
    sel.innerHTML = list.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
    const want = (prefCountry && list.some((c) => c.id === prefCountry)) ? prefCountry : (list[0] ? list[0].id : 'us');
    macroCountry = want; prefCountry = null;
    if ([...sel.options].some((o) => o.value === macroCountry)) sel.value = macroCountry;
  }
  loadMacroTickers();
  loadRegionCurrencies();
  loadCountry().then(prefetchRegion);   // then warm the rest of the region in the background
}
// CURRENCIES board is scoped to the chosen region (not the global majors).
async function loadRegionCurrencies() {
  const el = $('macro-fx');
  if (!el) return;
  el.innerHTML = stLoading();
  const req = macroRegion;
  let items = null;
  try { items = (await getJSON('/api/region-quotes?id=' + req)).items || []; } catch {}
  if (req !== macroRegion) return;
  const scope = $('fx-scope'); if (scope) scope.textContent = req.toUpperCase();
  const seen = new Set();
  const fx = (items || []).filter((i) => i.kind === 'fx').filter((i) => { if (seen.has(i.label)) return false; seen.add(i.label); return true; });
  el.innerHTML = fx.length
    ? '<div class="kpis">' + fx.map((f) => macroTile(f.label, f.price == null ? '—' : Number(f.price).toFixed(f.price < 10 ? 4 : 2), f.pct != null ? pctf(f.pct) : '', cls(f.pct), null, f.deltas ? deltaStrip(f.deltas) : '')).join('') + '</div><div class="macro-note">the chosen region\'s currencies · moves over 1D/1W/1M/YTD/1Y</div>'
    : stEmpty('No currencies for this region.');
}
async function loadMacroTickers() {
  // the macro tape shows EVERY macro ticker (all regions) so it is never sparse
  let items = null;
  try { items = (await getJSON('/api/macro-tickers')).items || []; } catch { items = null; }
  if (items) macroTickers = items;
  if (data) renderTicker(data);
}
// Cached fetch: instant if we already have it (or prefetched).
async function fetchCountry(id) {
  const hit = countryCache[id];
  if (hit && Date.now() - hit.t < 5 * 60e3) return hit.data;
  try { const data = await getJSON('/api/country?id=' + encodeURIComponent(id)); countryCache[id] = { t: Date.now(), data }; return data; }
  catch { return countryCache[id] ? countryCache[id].data : null; }
}
// Warm every other country in the region in the background → switching is instant.
async function prefetchRegion() {
  const list = (macroCountries && macroCountries[macroRegion]) || [];
  const ids = list.map((c) => c.id).filter((id) => id !== macroCountry);
  let i = 0;
  const worker = async () => { while (i < ids.length) { const id = ids[i++]; await fetchCountry(id); } };
  await Promise.all([worker(), worker(), worker()]);
}
async function loadCountry() {
  const el = $('macro-region-panel');
  if (!el) return;
  const req = macroCountry;                       // guard: newest country wins
  const showUsJp = req === 'us' || req === 'jp';
  const up = $('usjp-panel');
  if (up) up.classList.toggle('hidden', !showUsJp);
  if (showUsJp) loadUsJp();
  const sel = $('macro-country');
  const label = (sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : req).trim();
  el.innerHTML = `<div class="macro-note">${label.toUpperCase()}</div>${stLoading()}`;
  const c = await fetchCountry(req);
  if (req !== macroCountry) return;
  if (!c || c.error) { el.innerHTML = `<div class="macro-note">${label.toUpperCase()}</div>${stError('Couldn\u2019t load this country\u2019s data.')}`; return; }
  const num = (v, dp) => (v == null ? '—' : Number(v).toFixed(dp));
  const fxId = COUNTRY_FX_ID[c.fx.sym];
  const f = c.fund || {};
  const gdp = f.gdpGrowth || [];
  const card = (l, v, s, k, dl) => `<div class="bb-card"${fxId && l === c.fx.label ? ` data-metric="fx:${fxId}" style="cursor:pointer"` : ''}><div class="bb-l">${l}</div><div class="bb-v ${k || ''}">${v}</div><div class="bb-s">${s || ''}</div>${dl ? deltaStrip(dl) : ''}</div>`;
  let html = `<div class="bb-head">${c.label.toUpperCase()} <span class="dimtext">· ${(c.region || '').toUpperCase()}</span></div>`;

  html += '<div class="bb-sec">MARKET</div><div class="bb-grid">'
    + card(c.fx.label, num(c.fx.price, c.fx.price != null && c.fx.price < 10 ? 4 : 2), (c.fx.pct != null ? pctf(c.fx.pct) + ' today' : '—') + freshBadge(c.fx.source, c.fx.asOf), cls(c.fx.pct), c.fx.deltas)
    + (c.index.label && !/not free/i.test(c.index.label) ? card(c.index.label, num(c.index.price, c.index.price != null && c.index.price < 1000 ? 1 : 0), (c.index.pct != null ? pctf(c.index.pct) + ' today' : '—') + freshBadge(c.index.source, c.index.asOf), cls(c.index.pct), c.index.deltas) : '')
    + '</div>';

  html += '<div class="bb-sec">RATES &amp; INFLATION</div><div class="bb-grid">';
  if (c.policy) html += card('CENTRAL BANK RATE', c.policy.latest.value + '%', 'as of ' + c.policy.latest.date, '');
  if (c.macro && c.macro.fields) for (const mf of c.macro.fields) html += card(mf.k.toUpperCase(), mf.v == null ? '—' : `${mf.v}${mf.suf || ''}`, mf.asOf ? 'as of ' + mf.asOf : '', '');
  html += card('CPI (LATEST)', f.inflation ? f.inflation.value + '%' : '—', f.inflation ? String(f.inflation.year) : 'n/a', '') + '</div>';

  html += '<div class="bb-sec">GROWTH &amp; DEBT</div><div class="bb-grid">'
    + card('GDP GROWTH', gdp.length ? gdp[gdp.length - 1].value + '%' : '—', gdp.length ? String(gdp[gdp.length - 1].year) : 'n/a', '')
    + card('DEBT / GDP', f.debtToGdp && f.debtToGdp.year >= 2018 ? f.debtToGdp.value + '%' : '—', f.debtToGdp ? `${f.debtToGdp.year}${f.debtToGdp.year < 2018 ? ' — old' : ''}` : 'not available', '')
    + card('UNEMPLOYMENT', f.unemployment ? f.unemployment.value + '%' : '—', f.unemployment ? String(f.unemployment.year) : 'n/a', '')
    + '</div>'
    + (f.source ? `<div class="macro-note">${f.source} — labelled by year.</div>` : '');

  if (!c.policy && c.policyNote) html += `<div class="macro-note">${c.policyNote}</div>`;
  if (gdp.length > 1) html += `<div class="dimtext" style="padding:2px 12px 8px">real GDP growth by year — ${gdp.map((g) => `${g.year}: ${g.value}%`).join(' · ')}</div>`;

  html += '<div class="bb-sec">COMMODITY LINKAGE — its currency vs…</div>';
  if (c.links && c.links.length) {
    html += '<div class="bb-grid">' + c.links.map((l) => {
      const v = l.corr;
      const sub = v == null ? 'no data' : (Math.abs(v) >= 0.3 ? 'linked' : 'weak');
      return card(l.commodity, v == null ? '—' : v, '3-mo corr · ' + sub, v == null ? '' : (v < 0 ? 'neg' : 'pos'));
    }).join('') + '</div>';
  } else {
    html += '<div class="macro-note">No tracked commodity is closely tied to this currency.</div>';
  }
  if (c.oilLink != null) {
    const read = c.oilLink > 0.2 ? 'the currency weakens when oil rises (importer strain)' : c.oilLink < -0.2 ? 'the currency firms with oil (exporter benefit)' : 'no strong currency–oil link right now';
    html += `<div class="macro-note">${c.label} is a net oil ${c.oil}; currency vs Brent 3-mo correlation <b>${c.oilLink}</b> — ${read}.</div>`;
  }
  if (c.takeaways && c.takeaways.length) html += '<div class="bb-sec">KEY TAKEAWAYS</div><ul class="ins-list">' + c.takeaways.map((t) => `<li>${t}</li>`).join('') + '</ul>';
  html += '<div class="bb-sec">CROSS-ASSET — HOW THIS REGION IS AFFECTED</div>' + crossAssetBlock((i) => (i.regions || []).includes(macroRegion));
  el.innerHTML = html;
  loadMacroNews();
  loadCountryChart();
  renderPolicyChart(c.policy, c.policyNote);
  renderCpiChart(c.cpi);
  loadYields();
}
// Per-country chart: equity index and currency, both indexed to 100 so they compare.
async function loadCountryChart() {
  const cv = $('macro-chart');
  if (!cv) return;
  const req = macroCountry;
  let d;
  try { d = await getJSON('/api/country-series?id=' + encodeURIComponent(req) + '&range=' + ($('macro-range') ? $('macro-range').value : '1y')); }
  catch { return; }
  if (req !== macroCountry) return;
  if (!d || d.error || !d.dates || !d.dates.length) return;
  const norm = (arr) => { const base = (arr || []).find((v) => v != null); return (arr || []).map((v) => (v == null || !base) ? null : (v / base) * 100); };
  chartDp = 1; chartAnchor = null;
  const datasets = [];
  if (d.index && d.index.some((v) => v != null)) datasets.push(line(`${d.indexLabel} (indexed)`, norm(d.index), CT.c1));
  if (d.fx && d.fx.some((v) => v != null)) datasets.push(line(`${d.fxLabel} (indexed)`, norm(d.fx), CT.c4));
  const note = $('macro-chart-note');
  if (note) note.textContent = `${d.label} — both lines start at 100; hover any point for its % change. ${d.indexLabel ? '' : 'Index unavailable free.'}`;
  macroChart = mountChart('macro-chart', { labels: d.dates, datasets }, baseOptions({ dp: 1 }));
  attachMarkers(macroChart, req, d.dates, [d.index, d.fx].filter(Boolean), '#macro-chart-events');
}
// Central-bank policy rate history (stepped line; hover shows the rate).
let policyChart = null;
function renderPolicyChart(policy, policyNote) {
  const cv = $('policy-chart');
  if (!cv) return;
  const wrap = cv.parentElement;
  const note = $('policy-note');
  if (!policy || !policy.history || !policy.history.length) {
    if (wrap) wrap.style.display = 'none';
    if (note) note.textContent = policyNote || 'no free policy-rate series for this country';
    return;
  }
  if (wrap) wrap.style.display = '';
  if (note) note.textContent = `${policy.latest.value}% · as of ${policy.latest.date}`;
  const data = { labels: policy.history.map((h) => h.date), datasets: [{ label: 'policy rate', data: policy.history.map((h) => h.value), borderColor: CT.c2, backgroundColor: CT.c2 + '22', borderWidth: 2, pointRadius: 0, stepped: true, fill: false }] };
  policyChart = mountChart('policy-chart', data, baseOptions({ dp: 2, percentAxis: true, legend: false }));
  attachMarkers(policyChart, macroCountry, data.labels, [data.datasets[0].data], '#policy-events', 'abs');
}
// CPI — annual inflation % per country (World Bank), hover shows year + %.
let cpiChart = null;
let yieldsChart = null;   // per-country bond yields (short + long)
let usjpChart = null;     // US vs Japan 10-year
function renderCpiChart(cpi) {
  const cv = $('cpi-chart');
  if (!cv) return;
  const wrap = cv.parentElement;
  const note = $('cpi-note');
  if (!cpi || !cpi.length) { if (wrap) wrap.style.display = 'none'; if (note) note.textContent = 'no free CPI series for this country'; return; }
  if (wrap) wrap.style.display = '';
  if (note) note.textContent = `latest ${cpi[cpi.length - 1].value}% (${cpi[cpi.length - 1].year})`;
  const data = { labels: cpi.map((d) => String(d.year)), datasets: [{ label: 'CPI YoY %', data: cpi.map((d) => d.value), borderColor: CT.c4, backgroundColor: CT.c4 + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false }] };
  cpiChart = mountChart('cpi-chart', data, baseOptions({ dp: 1, percentAxis: true, legend: false }));
}
// Government bond yields for the selected country (short + long + term spread).
function renderYields(d) {
  const cv = $('yields-chart');
  const wrap = cv ? cv.parentElement : null;
  const note = $('yields-note');
  const sum = $('yields-summary');
  if (!d || d.error || (!d.short && !d.long)) {
    if (wrap) wrap.style.display = 'none';
    if (sum) sum.textContent = '';
    if (note) note.textContent = (d && d.error) || 'no free bond-yield data for this country';
    return;
  }
  if (wrap) wrap.style.display = '';
  const parts = [];
  if (d.short) parts.push(`${d.short.label} ${d.short.latest == null ? '—' : d.short.latest.toFixed(2) + '%'}`);
  if (d.long) parts.push(`${d.long.label} ${d.long.latest == null ? '—' : d.long.latest.toFixed(2) + '%'}`);
  if (d.spread != null) parts.push(`term spread ${d.spread >= 0 ? '+' : ''}${d.spread}pp`);
  if (note) note.textContent = `${d.freq || ''}${d.asOf ? ' · as of ' + d.asOf : ''}`;
  if (sum) sum.textContent = parts.join(' · ') + (d.long && !d.short ? ' · no free short-term rate' : '') + (d.short && !d.long ? ' · no free long-term rate' : '');
  const dates = [...new Set([...(d.short?.dates || []), ...(d.long?.dates || [])])].sort();
  const arr = (s) => { const m = new Map(); if (s) s.dates.forEach((dt, i) => m.set(dt, s.values[i])); return dates.map((dt) => (m.has(dt) ? m.get(dt) : null)); };
  const datasets = [];
  if (d.short) datasets.push(line(`${d.short.label} yield`, arr(d.short), CT.c1));
  if (d.long) datasets.push(line(`${d.long.label} yield`, arr(d.long), CT.c2));
  const chartData = { labels: dates, datasets };
  yieldsChart = mountChart('yields-chart', chartData, baseOptions({ dp: 2, percentAxis: true }));
  const ysrc = d.long || d.short;
  if (ysrc) attachMarkers(yieldsChart, macroCountry, dates, [arr(ysrc)], '#yields-events', 'abs');
}
async function loadYields() {
  const cv = $('yields-chart');
  if (!cv) return;
  const req = macroCountry;
  let d; try { d = await getJSON('/api/yields?id=' + encodeURIComponent(req)); } catch { d = null; }
  if (req !== macroCountry) return;
  renderYields(d);
}
// US vs Japan 10-year — the classic carry differential. Japan is monthly, so its last
// value is carried forward across the daily axis so every hover shows both + the spread.
function renderUsJp(us, jp) {
  const cv = $('usjp-chart');
  const note = $('usjp-note');
  const sum = $('usjp-summary');
  const ul = us && us.long, jl = jp && jp.long;
  if (!cv || !ul || !jl) { if (sum) sum.textContent = 'US or Japan 10-year data is unavailable right now.'; return; }
  const dates = [...new Set([...ul.dates, ...jl.dates])].sort();
  const raw = (s) => { const m = new Map(); s.dates.forEach((dt, i) => m.set(dt, s.values[i])); return dates.map((dt) => (m.has(dt) ? m.get(dt) : null)); };
  const usArr = raw(ul);
  const jpArr = []; { let last = null; for (const v of raw(jl)) { if (v != null) last = v; jpArr.push(last); } }
  const spread = ul.latest != null && jl.latest != null ? +(ul.latest - jl.latest).toFixed(2) : null;
  if (note) note.textContent = `US daily · Japan monthly (OECD, carried forward)${us.asOf ? ' · as of ' + us.asOf : ''}`;
  if (sum) sum.textContent = `US 10-yr ${ul.latest == null ? '—' : ul.latest.toFixed(2) + '%'} · Japan 10-yr ${jl.latest == null ? '—' : jl.latest.toFixed(2) + '%'}${spread != null ? ` · US–Japan spread ${spread >= 0 ? '+' : ''}${spread}pp (the carry gap)` : ''}`;
  const datasets = [line('US 10-yr', usArr, CT.c1), line('Japan 10-yr', jpArr, CT.c4)];
  const chartData = { labels: dates, datasets };
  usjpChart = mountChart('usjp-chart', chartData, baseOptions({ dp: 2, percentAxis: true }));
  attachMarkers(usjpChart, macroCountry === 'jp' ? 'jp' : 'us', dates, [usArr, jpArr], '#usjp-events', 'abs');
}
async function loadUsJp() {
  if (!$('usjp-chart')) return;
  try { const [us, jp] = await Promise.all([getJSON('/api/yields?id=us'), getJSON('/api/yields?id=jp')]); renderUsJp(us, jp); } catch {}
}
// Cross-asset transmission block — shared by segments and macro regions.
function crossAssetBlock(pred, title) {
  const ideas = ((transmission && transmission.ideas) || []).filter(pred);
  if (!ideas.length) return stEmpty('No strong cross-asset signal right now — moves are within normal ranges.');
  return ideas.map((i) => `
    <div class="xa">
      <div class="xa-trig">▸ ${i.trigger}</div>
      <div class="xa-chain">${i.chain}</div>
      <div class="ti"><div class="ti-row"><span class="ti-k pos">BENEFITS</span><span class="ti-v">${(i.benefits || []).join(' · ')}</span></div><div class="ti-row"><span class="ti-k neg">TROUBLE</span><span class="ti-v">${(i.hurt || []).join(' · ')}</span></div></div>
      <div class="bl-chips">${(i.up || []).map((t) => `<span class="chip up">▲ ${t}</span>`).join('')}${(i.down || []).map((t) => `<span class="chip down">▼ ${t}</span>`).join('')}</div>
    </div>`).join('')
    + '<div class="macro-note">The moves above are real data; the chains are how assets usually link — a framework, not a forecast.</div>';
}
async function loadTransmission() {
  try { transmission = await getJSON('/api/transmission'); } catch { transmission = null; }
  renderAdaptive();
  if ($('macro-region-panel')) loadCountry();
}
// Segment fundamentals — auto-tagged supply/demand events from the news.
async function loadFundamentals() {
  const el = $('fundamentals');
  if (!el) return;
  const k = segKey();
  el.innerHTML = stLoading('Scanning fundamentals…');
  try { const f = await jget('/api/fundamentals?id=' + encodeURIComponent(currentMarket) + (currentComponent ? '&component=' + encodeURIComponent(currentComponent) : ''), 300000); if (k !== segKey()) return; renderFundamentals(f); }
  catch { if (k === segKey()) el.innerHTML = stError('Couldn\u2019t load fundamentals — retrying.'); }
}
function renderFundamentals(f) {
  const el = $('fundamentals');
  if (!el) return;
  const sub = $('fund-sub');
  const items = (f && f.items) || [];
  // A qualitative news TILT — shown next to the news, deliberately NOT scored (headlines are
  // keyword-tagged prompts, not data). Counts only explicit bullish/bearish supply-demand shocks.
  const up = items.filter((i) => i.effect === 'up').length;
  const down = items.filter((i) => i.effect === 'down').length;
  const lean = (up + down) < 3 ? 'too few tagged shocks to lean'
    : up >= down * 1.5 ? 'tight-leaning (more supply shocks than gluts)'
    : down >= up * 1.5 ? 'loose-leaning (more gluts than supply shocks)' : 'mixed';
  if (sub) sub.textContent = `${f && f.label ? f.label + ' · ' : ''}news tilt: ${lean} — ${up} bullish vs ${down} bearish tagged shocks (qualitative, not scored)`;
  if (!items.length) { el.innerHTML = stEmpty('No supply/demand shocks in recent coverage.'); return; }
  el.innerHTML = items.map((i) => `<div class="xa">
      <div class="xa-trig ${i.effect === 'down' ? 'neg' : 'pos'}">${i.effect === 'down' ? '▼' : '▲'} ${i.kind} <span class="dimtext">· ${i.ageDays <= 14 ? 'recent' : Math.max(1, Math.round(i.ageDays / 30)) + 'mo ago'} · ${i.source}</span></div>
      <div class="xa-chain"><a href="${i.url}" target="_blank" rel="noopener noreferrer">${i.title}</a></div>
      <div class="macro-note">${i.chain}</div>
    </div>`).join('')
    + '<div class="macro-note">Auto-tagged: a keyword matched a supply/demand event — a prompt to investigate, not a certainty. Links open at the source.</div>';
}
// On-screen daily brief (HOME) — what happened / what's on today, in 60 seconds.
function renderBrief(b) {
  const el = $('home-brief');
  if (!el) return;
  if (!b || b.error) { el.innerHTML = stError('Couldn\u2019t load today\u2019s brief — retrying.'); return; }
  const upd = $('brief-updated');
  if (upd) upd.textContent = 'as of ' + new Date(b.updated).toLocaleString('en-GB');
  const happened = (b.happened || []).map((x) => `<li>${x.text}</li>`).join('') || '<li class="dimtext">No notable moves.</li>';
  const next = (b.next || []).map((e) => `<li><b>${e.name}</b>${e.date ? ` — ${e.date}` : ''} <span class="dimtext">${e.note || ''}</span></li>`).join('') || '<li class="dimtext">Nothing scheduled.</li>';
  el.innerHTML = `<div class="brief-head">${b.headline || ''}</div>
    <div class="brief-cols">
      <div class="brief-col"><div class="gtitle">WHAT HAPPENED</div><ul class="ins-list">${happened}</ul></div>
      <div class="brief-col"><div class="gtitle">WHAT'S ON TODAY / NEXT</div><ul class="ins-list">${next}</ul></div>
    </div>`;
}
async function loadBrief() {
  const el = $('home-brief');
  if (el && !el.innerHTML) el.innerHTML = stLoading('Reading the day…');
  try { renderBrief(await getJSON('/api/brief')); } catch { renderBrief(null); }
}
// Live important headlines (hero board).
// Cross-asset regime board — the backdrop that sets the day's tone (dollar, volatility, rates,
// risk, metals, oil). Each cell shows the level + its 1D/1W/1M/YTD/1Y strip and its source.
async function loadRegime() {
  const el = $('regime-board'); if (!el) return; if (!el.innerHTML) el.innerHTML = stLoading('Loading the backdrop…');
  let d = null; try { d = await jget('/api/regime', 120000); } catch { d = null; }
  markReady('regime');
  renderRegime(d);
}
function renderRegime(d) {
  const el = $('regime-board'); if (!el) return;
  const rows = (d && d.rows) || [];
  if (!rows.length) { el.innerHTML = stError('Couldn’t load the markets board — retrying.'); return; }
  el.innerHTML = rows.map((r) => {
    const src = `${r.source}${r.asOf ? ` · ${r.asOf}` : ''}`;
    if (r.price == null) return `<div class="rb-cell"><div class="rb-l" title="${r.label}">${r.label}</div><div class="rb-v">—</div><div class="rb-src">${src}</div></div>`;
    const strip = r.rate ? deltaStripRate(r.deltas) : deltaStrip(r.deltas);
    const dv = r.deltas ? r.deltas.d1 : null;
    return `<div class="rb-cell" title="${r.label} · ${src}"><div class="rb-l">${r.label}</div>`
      + `<div class="rb-v ${cls(dv)}">${fmtNum(r.price, r.dp)}${r.unit ? `<span class="rb-u">${r.unit}</span>` : ''}</div>${strip}`
      + `<div class="rb-src">${src}</div></div>`;
  }).join('');
}
// Screener — every instrument in one sortable table (assembled server-side at /api/screen).
let screenRows = null, screenSort = { key: 'absd1', dir: -1 }, fxBase = 'USD', fxRows = null;
const SCREEN_COLS = [
  { k: 'label', t: 'INSTRUMENT' }, { k: 'price', t: 'LAST' },
  { k: 'd1', t: '1D' }, { k: 'w1', t: '1W' }, { k: 'm1', t: '1M' }, { k: 'ytd', t: 'YTD' }, { k: 'y1', t: '1Y' },
  { k: 'stretch', t: 'STRETCH' }, { k: 'tight', t: 'TIGHT' }, { k: 'basisPct', t: 'BASIS%' }, { k: 'posPct', t: 'CROWD' },
];
const DELTA_KEYS = ['d1', 'w1', 'm1', 'ytd', 'y1'];
function effDeltas(r) { return (fxBase !== 'USD' && fxRows && fxRows[r.id]) ? fxRows[r.id] : (r.deltas || {}); }
function screenVal(r, k) {
  if (k === 'label' || k === 'price') return r[k];
  if (k === 'absd1') { const d = effDeltas(r); return Math.abs(d.d1 == null ? 0 : d.d1); }
  if (DELTA_KEYS.includes(k)) return effDeltas(r)[k];
  return r[k];
}
async function loadScreen() {
  const el = $('screen'); if (!el) return;
  if (!el.innerHTML) el.innerHTML = stLoading('Ranking the board…');
  let d = null; try { d = await jget('/api/screen', 300000); } catch { d = null; }
  screenRows = (d && d.rows) || [];
  markReady('screen');
  renderScreen();
}
function renderScreen() {
  const el = $('screen'); if (!el) return;
  if (!screenRows || !screenRows.length) { el.innerHTML = stError('Couldn’t load the screener — retrying.'); return; }
  const { key, dir } = screenSort;
  const rows = [...screenRows].sort((a, b) => {
    const x = screenVal(a, key), y = screenVal(b, key);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return key === 'label' ? x.localeCompare(y) * dir : (x - y) * dir;
  });
  const head = SCREEN_COLS.map((c) => `<th class="${key === c.k ? 'on' : ''}" data-k="${c.k}">${c.t}${key === c.k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  const pcell = (v) => (v == null ? '<td class="num">—</td>' : `<td class="num ${cls(v)}">${pctf(v)}</td>`);
  const body = rows.map((r) => {
    const d = effDeltas(r);
    const flagCls = r.posFlag === 'CROWDED LONG' || r.posFlag === 'CROWDED SHORT' ? 'hot' : r.posFlag === 'STRETCHED LONG' ? 'warm' : r.posFlag === 'WASHED-OUT' ? 'cool' : '';
    const crowd = r.posPct == null ? '<td class="num">—</td>' : `<td class="num"><span class="sc-flag ${flagCls}" title="${r.posFlag || ''}">${r.posPct}</span></td>`;
    const s = (v) => `<td class="num">${v == null ? '—' : v}</td>`;
    return `<tr data-id="${r.id}" title="${r.label} · ${r.source || ''} ${r.asOf || ''}">`
      + `<td class="sc-name">${r.label}</td><td class="num">${fmtNum(r.price, r.dp)}</td>`
      + pcell(d.d1) + pcell(d.w1) + pcell(d.m1) + pcell(d.ytd) + pcell(d.y1)
      + s(r.stretch) + s(r.tight) + s(r.basisPct) + crowd + '</tr>';
  }).join('');
  el.innerHTML = `<div class="sc-wrap"><table class="sc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
    + `<div class="sc-note dimtext">${fxBase !== 'USD' ? `Returns converted to <b>${fxBase}</b> (USD move + the currency's own move). ` : ''}Click a header to sort; click a row to open its chart. STRETCH is −100 (cheap)…+100 (rich) · TIGHT is 0 (oversupplied)…100 (undersupplied) · BASIS% and CROWD are percentiles.</div>`;
}
$('base-cur')?.addEventListener('change', async (e) => {
  fxBase = e.target.value || 'USD';
  fxRows = null;
  if (fxBase !== 'USD') {
    try {
      const d = await jget('/api/fxadjusted?base=' + encodeURIComponent(fxBase), 3600000);
      fxRows = Object.fromEntries(((d && d.rows) || []).map((r) => [r.id, r.deltas]));
    } catch { fxRows = null; }
  }
  renderScreen();
});
$('screen')?.addEventListener('click', (e) => {
  const th = e.target.closest('th[data-k]');
  if (th) { const k = th.dataset.k; screenSort = { key: k, dir: screenSort.key === k ? -screenSort.dir : (k === 'label' ? 1 : -1) }; renderScreen(); return; }
  const tr = e.target.closest('tr[data-id]');
  if (tr) { showTab('commodities'); pickMetric(tr.dataset.id, '6m'); }
});
// Economic calendar — a real month grid. Dated events sit on their day; undated ones are listed below.
const CAL_DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
let calEvents = null, calMonth = null, calFomc = null;
async function loadCalendar() {
  const el = $('calendar'); if (!el) return;
  if (!el.innerHTML) el.innerHTML = stLoading('Loading the calendar…');
  let d = null; try { d = await jget('/api/calendar', 1800000); } catch { d = null; }
  calEvents = (d && d.events) || null;
  calFomc = d && d.fomc;
  markReady('calendar');
  if (calEvents && !calMonth) {
    const dated = calEvents.filter((e) => e.date);
    const basis = dated.length ? new Date(dated[0].date + 'T00:00:00Z') : new Date();
    calMonth = { y: basis.getUTCFullYear(), m: basis.getUTCMonth() };
  }
  renderCalendar();
}
function calRow(e, today, withDay) {
  const days = e.date ? Math.round((Date.parse(e.date) - Date.parse(today)) / 864e5) : null;
  const when = e.date ? `${e.date.slice(5)}${withDay ? (days === 0 ? ' · today' : days > 0 ? ` · ${days}d` : '') : ''}` : 'date varies';
  return `<div class="cal-row"><span class="cal-date">${when}</span><span class="cal-name">${e.name}</span><span class="cal-src">${e.source || ''}</span>${e.note ? `<span class="cal-note dimtext">${e.note}</span>` : ''}</div>`;
}
function renderCalendar() {
  const el = $('calendar'); if (!el) return;
  const sub = $('cal-sub'); if (sub) sub.textContent = 'dates only — no free consensus, so no forecasts (never invented)';
  if (!calEvents || !calMonth) { el.innerHTML = stError('Couldn’t load the calendar — retrying.'); return; }
  const today = new Date().toISOString().slice(0, 10);
  const byDate = {};
  for (const e of calEvents) if (e.date) (byDate[e.date] = byDate[e.date] || []).push(e);
  const { y, m } = calMonth;
  const startDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;   // Monday-first
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let day = 1; day <= dim; day++) { const k = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; cells.push({ day, k, ev: byDate[k] || [] }); }
  while (cells.length % 7) cells.push(null);
  const grid = cells.map((c) => c
    ? `<div class="cal-day${c.k === today ? ' today' : ''}${c.ev.length ? ' has' : ''}"><span class="cal-dn">${c.day}</span>${c.ev.map((e) => `<span class="cal-ev" title="${e.name}${e.source ? ' · ' + e.source : ''}">${e.name}</span>`).join('')}</div>`
    : '<div class="cal-day pad"></div>').join('');
  const mk = `${y}-${String(m + 1).padStart(2, '0')}`;
  const monthEvents = calEvents.filter((e) => e.date && e.date.slice(0, 7) === mk);
  const undated = calEvents.filter((e) => !e.date);
  el.innerHTML = `<div class="cal-head"><div class="cal-nav"><button id="cal-prev" type="button" aria-label="Previous month">‹</button><span class="cal-title">${MONTH_NAMES[m]} ${y}</span><button id="cal-next" type="button" aria-label="Next month">›</button></div><button id="cal-today" class="ghost small" type="button">TODAY</button></div>`
    + `<div class="cal-grid">${CAL_DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('')}${grid}</div>`
    + (monthEvents.length ? `<div class="cal-list">${monthEvents.map((e) => calRow(e, today, true)).join('')}</div>` : '<div class="cal-foot dimtext">No dated events this month.</div>')
    + (undated.length ? undated.map((e) => calRow(e, today, false)).join('') : '')
    + (calFomc === 'fallback' ? '<div class="cal-foot dimtext">FOMC dates from the published schedule — the live Federal Reserve feed was unavailable.</div>' : '');
}
$('calendar')?.addEventListener('click', (e) => {
  if (!calMonth) return;
  if (e.target.id === 'cal-prev') { calMonth.m--; if (calMonth.m < 0) { calMonth.m = 11; calMonth.y--; } renderCalendar(); return; }
  if (e.target.id === 'cal-next') { calMonth.m++; if (calMonth.m > 11) { calMonth.m = 0; calMonth.y++; } renderCalendar(); return; }
  if (e.target.id === 'cal-today') { const n = new Date(); calMonth = { y: n.getUTCFullYear(), m: n.getUTCMonth() }; renderCalendar(); }
});
// Risk & correlation — a plain read, bars-with-words, and a focus view (full matrix behind a fold).
let riskData = null, riskFocus = null;
async function loadRisk() {
  const el = $('risk'); if (!el) return;
  if (!el.innerHTML) el.innerHTML = stLoading('Loading risk metrics…');
  let d = null; try { d = await jget('/api/risk', 3600000); } catch { d = null; }
  riskData = d;
  if (d && d.keys && d.keys.length && !riskFocus) riskFocus = d.keys[0].key;
  renderRisk(d);
}
function renderRisk(d) {
  const el = $('risk'); if (!el) return;
  const sub = $('risk-sub'); if (sub) sub.textContent = 'worst 1-year fall · how jumpy · what moves together (daily returns)';
  const metrics = (d && d.metrics) || [];
  if (!metrics.length) { el.innerHTML = stError('Couldn’t load risk metrics — retrying.'); return; }
  const maxDD = Math.max(1, ...metrics.map((m) => Math.abs(m.drawdown || 0)));
  const ddCls = (w) => (w === 'deep fall' ? 'deep' : w === 'barely moved' || w === 'mild fall' ? 'mild' : '');
  const arrow = { rising: '↑', falling: '↓', flat: '→' };
  const rows = metrics.map((m) => {
    const w = Math.abs(m.drawdown || 0) / maxDD * 100;
    const vw = m.vol && m.vol.w30;
    return `<div class="rk-row"><span class="rk-name">${m.label}</span>`
      + `<span class="rk-dd" title="worst peak-to-trough fall over the last year">${m.drawdown == null ? '—' : m.drawdown.toFixed(0) + '%'}</span>`
      + `<span class="rk-bar ${ddCls(m.ddWord)}"><i style="width:${w.toFixed(0)}%"></i></span>`
      + `<span class="rk-word">${m.ddWord}</span>`
      + `<span class="rk-vol" title="annualised realised volatility over 30 days (and the 30-vs-90 trend)">${vw == null ? '—' : Math.round(vw) + '%'} <em>${m.volWord || ''}</em> ${m.volTrend ? arrow[m.volTrend] : ''}</span></div>`;
  }).join('');
  const keys = (d && d.keys) || [];
  const mtx = (d && d.matrix) || {};
  const focusLabel = ((keys.find((k) => k.key === riskFocus) || {}).label) || '';
  const picks = keys.map((k) => `<option value="${k.key}"${k.key === riskFocus ? ' selected' : ''}>${k.label}</option>`).join('');
  const row = (riskFocus && mtx[riskFocus]) || {};
  const frows = keys.filter((k) => k.key !== riskFocus && row[k.key] != null).map((k) => ({ ...k, r: row[k.key] })).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const fb = frows.map((k) => `<div class="crf-row"><span class="crf-k">${k.label}</span><span class="crf-bar" title="${focusLabel} ${k.r > 0 ? 'moves WITH' : 'moves OPPOSITE'} ${k.label} (r = ${k.r})"><i class="${k.r >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(k.r) * 50).toFixed(0)}%"></i></span><span class="crf-r ${k.r > 0 ? 'pos' : 'neg'}">${k.r > 0 ? '+' : ''}${k.r.toFixed(2)}</span></div>`).join('');
  const short = (k) => k.short || k.label;
  const cls = (v) => (v == null ? '' : Math.abs(v) >= 0.6 ? (v > 0 ? 'hi' : 'hineg') : Math.abs(v) >= 0.3 ? 'mid' : 'lo');
  const heat = '<div class="corr-wrap"><table class="corr-tbl"><thead><tr><th></th>' + keys.map((k) => `<th>${short(k)}</th>`).join('') + '</tr></thead><tbody>'
    + keys.map((a) => `<tr><th>${short(a)}</th>` + keys.map((b) => { const v = a.key === b.key ? null : (mtx[a.key] ? mtx[a.key][b.key] : null); return `<td class="${cls(v)}">${v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2)}</td>`; }).join('') + '</tr>').join('') + '</tbody></table></div>';
  el.innerHTML = (d.read ? `<div class="risk-read">${d.read}</div>` : '')
    + '<div class="rk-head"><span class="rk-name">INSTRUMENT</span><span class="rk-dd">FALL</span><span class="rk-bar"></span><span class="rk-word">WORST 1Y</span><span class="rk-vol">HOW JUMPY (30d)</span></div>'
    + rows
    + `<div class="crf"><div class="crf-head">WHAT <select id="risk-focus" aria-label="Focus instrument">${picks}</select> MOVES WITH — lately</div>${fb || '<div class="dimtext">No overlapping history for this one.</div>'}</div>`
    + `<details class="fold"><summary>▸ SHOW THE FULL CORRELATION MATRIX</summary><div class="note-body">${heat}<div class="sc-note dimtext">Every pair, over ~1 year of daily returns: <b>+1</b> = same direction, <b>−1</b> = opposite, <b>0</b> = unrelated. Colour is only a guide — the number is what counts.</div></div></details>`
    + '<div class="sc-note dimtext">“Worst fall” = the biggest peak-to-trough drop over the last year (a risk gauge, not a forecast). “How jumpy” = annualised realised volatility; ↑ rising, ↓ falling. Correlation is about DAILY moves and it changes over time. For a yield (US 10y) and VIX, a “fall” is a move in the level, not a P&amp;L.</div>';
}
$('risk')?.addEventListener('change', (e) => {
  if (e.target.id === 'risk-focus') { riskFocus = e.target.value; renderRisk(riskData); }
});
async function loadHeadlines() {
  const el = $('headlines');
  if (!el) return;
  try { renderHeadlines(await getJSON('/api/headlines')); }
  catch { el.innerHTML = stError('Couldn\u2019t load headlines — retrying.'); }
  markReady('headlines');
}
function renderHeadlines(h) {
  const el = $('headlines');
  if (!el) return;
  const items = (h && h.items) || [];
  if (!items.length) { el.innerHTML = stEmpty('No major commodity headlines right now.'); return; }
  el.innerHTML = items.map((i) => `<a class="hl ${i.effect === 'down' ? 'down' : 'up'}" href="${i.url}" target="_blank" rel="noopener noreferrer"><span class="hl-tag">${i.effect === 'down' ? '▼' : '▲'} ${i.kind}</span><span class="hl-t">${i.title}</span><span class="hl-s dimtext">${i.source}</span></a>`).join('');
}
async function loadMacroNews() {
  const el = $('macro-news');
  if (!el) return;
  const req = macroCountry;
  el.innerHTML = stLoading('Loading headlines…');
  let n; try { n = await getJSON('/api/macro-news?id=' + req); } catch { n = null; }
  if (req !== macroCountry) return;
  renderNews(n || { items: [] }, 'macro-news', 'macro-news-sub');
}
function renderMacroDash(md, corr, events) {
  if (!md || md.error) return;
  macroMd = md;
  renderMacroRegion();
  if ($('macro-links')) {
    const rows = (md.links || []).map((l) => {
      if (l.corr == null) return macroTile(l.pair, '—', l.commodity + ' · no data', '');
      const holds = Math.sign(l.corr) === l.expect;
      const read = !holds ? 'link broken' : Math.abs(l.corr) >= 0.3 ? 'link holding' : 'link weak';
      return macroTile(l.pair, signed(l.corr, 2), `${l.commodity} · ${read}`, holds ? 'pos' : 'neg', 'fx:' + l.id);
    }).join('');
    $('macro-links').innerHTML = `<div class="kpis">${rows}</div><div class="dimtext" style="padding:6px 12px">Correlation of daily moves over the last 3 months. <span class="pos">Green</span> = the currency still tracks its commodity the usual way; <span class="neg">red</span> = the link has broken down right now. On a <b>USD/xxx</b> pair a negative number is the normal sign (a stronger dollar and a weaker commodity tend to move together).</div>`;
  }
  const c = corr || {};
  const cTile = (label, v, note) => macroTile(label, v != null ? v : '—', note, v != null ? (v < 0 ? 'neg' : 'pos') : '');
  const mcorr = $('macro-corr'); if (mcorr) mcorr.innerHTML = `<div class="kpis">${cTile('OIL vs US DOLLAR', c.oilVsDollar, 'usually negative')}${cTile('OIL vs VIX', c.oilVsVix, 'risk-off link')}${cTile('OIL vs S&P 500', c.oilVsSp500, 'risk-on link')}</div>`;
  $('macro-events').innerHTML = (events || []).map((e) => `<div class="read-line"><b>${e.name}</b>${e.date ? ` — ${e.date}` : ''} <span class="dimtext">${e.note || ''}</span></div>`).join('');
}
// Curve-over-time only exists for the NYMEX energy roots (CL/BZ/NG/RB/HO);
// it self-hides for metals/ags where the contract-month history isn't free.
const CURVE_ROOT = { crude: { root: 'CL', name: 'CRUDE OIL' }, refined: { root: 'RB', name: 'GASOLINE' }, gas: { root: 'NG', name: 'NATURAL GAS' } };
let curveHistRoot = null;
let curveHistPending = null;    // root still to fetch, deferred until the panel is in view
let curveHistVisible = false;   // has the panel ever scrolled into view?
async function loadCurveHistory() {
  const k = segKey();
  const spec = CURVE_ROOT[currentMarket];
  const block = $('curvehist-block');
  if (!spec) { if (block) block.style.display = 'none'; return; }
  if (block) block.style.display = '';
  if (curveHistRoot === spec.root) return;
  const t = $('curvehist-title');
  // Deferred: this is the single most expensive request (~20-45s cold, energy-only) and it is
  // below the fold — so we only fetch it once you actually scroll to it.
  if (!curveHistVisible) {
    curveHistPending = spec.root;
    if (t) t.textContent = `IS ${spec.name} GETTING TIGHTER OR LOOSER? — scroll here to load this chart`;
    return;
  }
  curveHistPending = null;
  curveHistRoot = spec.root;
  if (t) t.textContent = `IS ${spec.name} GETTING TIGHTER OR LOOSER? — this month vs next, over time (above 0 = tight)`;
  try { const d = await jget('/api/curvehistory?root=' + spec.root, 6 * 3600e3); if (k !== segKey()) return; renderCurveHistory(d); } catch {}
}
function initCurveHist() {
  const block = $('curvehist-block');
  if (!block || !('IntersectionObserver' in window)) { curveHistVisible = true; return; }   // no IO → load eagerly
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    curveHistVisible = true; io.disconnect();
    if (curveHistPending) loadCurveHistory();
  }, { rootMargin: '300px' });
  io.observe(block);
}
function showTab(name) {
  saveStr('tab', name);
  document.querySelectorAll('.tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'commodities') {
    loadCurveHistory();
    if (chart) setTimeout(() => chart.resize(), 50);
    if (cmpChart) setTimeout(() => cmpChart.resize(), 55);
    if (curveHistChart) setTimeout(() => curveHistChart.resize(), 60);
    if (map) setTimeout(() => map.invalidateSize(), 80);
    if (crackHistChart && currentMarket === 'refined') setTimeout(() => crackHistChart.resize(), 80);
  }
  if (name === 'macro') { loadMacroTickers(); if (!extraSlowDone) setTimeout(() => loadExtraSlow().catch(() => {}), 0); if (macroChart) setTimeout(() => macroChart.resize(), 60); if (policyChart) setTimeout(() => policyChart.resize(), 70); if (cpiChart) setTimeout(() => cpiChart.resize(), 80); if (yieldsChart) setTimeout(() => yieldsChart.resize(), 85); if (usjpChart) setTimeout(() => usjpChart.resize(), 90); }
  if (data) renderTicker(data);
}

async function loadExtra() { await loadExtraCore(); await loadExtraSlow(); }

// Above-the-fold feeds — fired immediately, not awaited, so the read/chart/news can start now.
async function loadExtraCore() {
  if (!data) return; // need prices first
  reloadHistory();    // deltas + sparklines
  loadRegime();       // HOME: markets at a glance
  loadScreen();       // HOME: screener
  loadCalendar();     // HOME: calendar
  loadRisk();         // HOME: risk & correlation
  loadAlerts();       // HOME: alerts
  loadBrief();        // HOME: daily brief
  loadTransmission(); // COMMODITIES: how it transmits
  renderMarketState();
  renderAdaptive();
  loadBelowFold();    // everything below the fold — fire-and-forget (NOT awaited)
}
// Below-the-fold panels (inventories, sector quotes, ships, refining margins…). Deliberately not
// awaited — these used to block the read/chart from starting.
async function loadBelowFold() {
  try {
    const [inv, eq, chk, an, fl, pr] = await Promise.all([
      getJSON('/api/inventories').catch(() => null),
      getJSON('/api/equities').catch(() => null),
      getJSON('/api/chokepoints').catch(() => null),
      getJSON('/api/analytics').catch(() => null),
      getJSON('/api/flows').catch(() => null),
      getJSON('/api/products').catch(() => null),
    ]);
    analytics = an;
    renderInventories(inv);
    renderSectors(eq, data, an, tankerInfo);
    renderChokepoints(chk);
    renderCurveForSegment();
    loadCurveHistory();
    renderFlows(fl);
    renderProducts(pr);
    loadCrush();
  } catch { /* below the fold — stay quiet */ }
}
// Below-the-fold / MACRO-only feeds — the slowest requests (satellite, macro). Loaded AFTER the
// first paint (and again on the periodic refresh) so they never delay the initial screen.
let extraSlowDone = false;
async function loadExtraSlow() {
  if (!data) return;
  try {
    const [flr, sar] = await Promise.all([
      getJSON('/api/flares').catch(() => null),
      getJSON('/api/sar').catch(() => null),
    ]);
    const [md, corr, ev] = await Promise.all([
      getJSON('/api/macrodash').catch(() => null),
      getJSON('/api/correlations').catch(() => null),
      getJSON('/api/calendar').then((x) => (x && x.events) || null).catch(() => null),
    ]);
    renderSatellite(sar, flr);
    renderMacroDash(md, corr, ev);
    if (md?.fx) { lastFx = md.fx; renderTicker(data); const lv = $('rule-level'); if ($('home-rules') && !$('home-rules').innerHTML.includes('CURRENCIES') && (!lv || !lv.value)) renderRules(); }
    extraSlowDone = true;
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function refreshLive() {
  // Transient upstream hiccups must never pop the error banner (the loaders keep last-good state).
  try { await loadMarket(); } catch (e) { console.error('[market]', e.message); }
  try { await loadTankers(); } catch (e) { console.error('[tankers]', e.message); }
}
$('refresh').addEventListener('click', () => { nextRefresh = 60; refreshLive(); loadExtra(); });
$('metric').addEventListener('change', () => { localStorage.setItem('oilbasis.metric', $('metric').value); chartAnchor = null; renderChart(); });
$('range').addEventListener('change', () => { saveStr('range', $('range').value); chartAnchor = null; renderChart(); });
['cmp-a', 'cmp-b', 'cmp-range', 'cmp-view'].forEach((id) => $(id)?.addEventListener('change', () => { saveCompare(); renderCompare(); }));
$('cmp-presets')?.addEventListener('click', (e) => { const btn = e.target.closest('.cmp-preset'); if (!btn) return; $('cmp-a').value = btn.dataset.a; $('cmp-b').value = btn.dataset.b; $('cmp-view').value = btn.dataset.v; saveCompare(); renderCompare(); });
$('bp-metric')?.addEventListener('change', () => selectMarket($('bp-metric').value));
$('bp-snapshot')?.addEventListener('click', (e) => {
  const c = e.target.closest('.bp-comp[data-component]');
  if (!c) return;
  currentComponent = c.dataset.component;
  // Follow the commodity you're reading in the PRICE chart too (so its big-move markers apply).
  if ([...$('metric').options].some((o) => o.value === currentComponent)) { $('metric').value = currentComponent; saveStr('metric', currentComponent); chartAnchor = null; renderChart(); }
  renderSnapshot();
  loadMarketRead();
  syncCompareToSelection();
});

$('marketstate')?.addEventListener('click', (e) => { const t = e.target.closest('[data-market]'); if (t) { showTab('commodities'); selectMarket(t.dataset.market); } });
$('macro-region')?.addEventListener('change', () => { macroRegion = $('macro-region').value; saveStr('macroRegion', macroRegion); renderMacroRegion(); });
$('macro-region-panel')?.addEventListener('click', (e) => { const el = e.target.closest('[data-metric]'); if (el) pickMetric(el.dataset.metric, '1y'); });
$('macro-country')?.addEventListener('change', () => { macroCountry = $('macro-country').value; saveStr('macroCountry', macroCountry); loadCountry(); });
$('macro-range')?.addEventListener('change', loadCountryChart);
$('chart').addEventListener('click', (ev) => {
  if (!chart) return;
  const pts = chart.getElementsAtEventForMode(ev, 'index', { intersect: false }, true);
  if (!pts.length) return;
  const idx = pts[0].index;
  chartAnchor = chartAnchor === idx ? null : idx;
  chart.update('none');
});
$('an-metric').addEventListener('change', loadAnalogue);
$('alert-settings')?.addEventListener('click', () => {
  const panel = $('alert-thresholds');
  if (panel.classList.contains('hidden')) { renderThresholds(); panel.classList.remove('hidden'); }
  else panel.classList.add('hidden');
});
// Jump to the chart for any metric id (benchmark, basis:*, fx:*).
function pickMetric(id, range = '6m') {
  if (id && [...$('metric').options].some((o) => o.value === id)) $('metric').value = id;
  localStorage.setItem('oilbasis.metric', id);
  $('range').value = range;
  chartAnchor = null;
  showTab('commodities');
  renderChart();
  const cp = $('chart-panel');
  if (cp) setTimeout(() => cp.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) showTab(b.dataset.tab); });
// Arrow keys move between tabs (standard tablist behaviour).
$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = [...document.querySelectorAll('.tab')];
  const i = tabs.indexOf(e.target.closest('.tab'));
  if (i < 0) return;
  e.preventDefault();
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.focus(); next.click();
});
$('help-btn').addEventListener('click', () => { const g = $('glossary'); g.innerHTML = GLOSSARY; g.classList.toggle('hidden'); });
$('cards').addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  if (star) { toggleWatch(star.dataset.star); renderCards(data); renderWatchlist(); return; }
  const tile = e.target.closest('.tile[data-id]');
  if (tile) pickMetric(tile.dataset.id, '6m');
});
$('home-watch')?.addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  if (star) { toggleWatch(star.dataset.star); renderWatchlist(); if (data) renderCards(data); return; }
  const tile = e.target.closest('.tile[data-id]');
  if (tile) pickMetric(tile.dataset.id, '6m');
});
$('macro-fx')?.addEventListener('click', (e) => { const el = e.target.closest('[data-metric]'); if (el) pickMetric(el.dataset.metric, '1y'); });
$('macro-links')?.addEventListener('click', (e) => { const el = e.target.closest('[data-metric]'); if (el) pickMetric(el.dataset.metric, '1y'); });

(async function boot() {
  try { initMap(); } catch (e) { console.error(e); }
  document.querySelectorAll('details.fold-panel').forEach((d) => d.addEventListener('toggle', () => {
    if (!d.open) return;
    if (map) setTimeout(() => map.invalidateSize(), 60);
    if (rerouteChart) setTimeout(() => rerouteChart.resize(), 60);
  }));
  const tick = () => { $('clock').textContent = new Date().toLocaleTimeString('en-GB'); };
  tick(); setInterval(tick, 1000);
  // Keep the sticky jump-nav pinned just under the (variable-height) top bar.
  const setTopbarH = () => { const tb = document.querySelector('.topbar'); if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px'); };
  setTopbarH(); addEventListener('resize', setTopbarH);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const onboardEl = $('onboarding');
  // Give the tower's contact blips a fresh random phase/duration each time the intro opens.
  const seedBlips = () => document.querySelectorAll('.tower-blip').forEach((b) => {
    b.style.setProperty('--dur', (3 + Math.random() * 2.8).toFixed(2) + 's');
    b.style.setProperty('--delay', '-' + (Math.random() * 7).toFixed(2) + 's');
  });
  const showOnboard = () => { seedBlips(); onboardEl?.classList.remove('hidden'); $('onboard-close')?.focus(); };
  const hideOnboard = () => { localStorage.setItem('oilbasis.seenOnboard', '1'); onboardEl?.classList.add('hidden'); };
  if (!localStorage.getItem('oilbasis.seenOnboard')) showOnboard();
  $('onboard-close')?.addEventListener('click', hideOnboard);
  $('help-open')?.addEventListener('click', showOnboard);
  onboardEl?.addEventListener('click', (e) => { if (e.target.id === 'onboarding') hideOnboard(); });
  // Real dialog behaviour: Escape closes, and Tab is trapped inside while it is open.
  onboardEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideOnboard(); return; }
    if (e.key !== 'Tab') return;
    const f = [...onboardEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Restore the last view — tab, segment, chart range, compare, and macro region/country.
  const savedTab = localStorage.getItem('oilbasis.tab');
  const savedSeg = localStorage.getItem('oilbasis.segment');
  const savedRegion = localStorage.getItem('oilbasis.macroRegion');
  const savedCountry = localStorage.getItem('oilbasis.macroCountry');
  const savedRange = localStorage.getItem('oilbasis.range');
  if (savedRange && [...$('range').options].some((o) => o.value === savedRange)) $('range').value = savedRange;
  if (savedRegion) { macroRegion = savedRegion; if ($('macro-region')) $('macro-region').value = savedRegion; }
  if (savedCountry) prefCountry = savedCountry;
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  bootStep('Loading history…');
  // Fire the small config feeds in parallel with the (heavy) history load.
  const fxP = getJSON('/api/fx').catch(() => []);
  const rateP = getJSON('/api/rates').catch(() => []);
  const mkP = getJSON('/api/markets').catch(() => []);
  const ctryP = getJSON('/api/countries').catch(() => null);
  await loadHistory().catch(() => {});   // never fatal — degrades to an empty history
  fxList = await fxP; rateList = await rateP;
  renderCmpPresets();
  bootStep('Loading markets…');
  markets = await mkP;
  macroCountries = await ctryP;
  bootStep('Loading prices…');
  await refreshLive();        // prices + ships (sets `data` first)
  initCurveHist();            // arm the lazy loader for the (expensive) curve-history chart
  bootStep('reading the market…');
  await loadExtraCore();      // the above-the-fold feeds only — below-the-fold comes after first paint
  // Always land on a segment (first visit included) so the read actually loads.
  selectMarket(savedSeg && markets.some((m) => m.id === savedSeg) ? savedSeg : (markets[0] && markets[0].id) || 'crude');
  restoreCompare();
  if (savedTab) showTab(savedTab);
  setTimeout(hideBoot, 8000);                     // hard cap — never linger, even on a slow feed
  setTimeout(() => loadExtraSlow().catch(() => {}), 300);   // the slow, below-the-fold feeds
  loadAnalogue();
  loadReroute();
  loadHeadlines();
  setInterval(loadHeadlines, 600000);   // refresh the live headline board
  setInterval(loadTankers, 15000);                                  // ships
  setInterval(loadReroute, 300000);                                 // reroute index
  setInterval(loadExtra, 600000);                                   // slow feeds every 10 min
  setInterval(() => { nextRefresh -= 5; if (nextRefresh <= 0) { nextRefresh = 60; refreshLive(); } const cd = $('countdown'); if (cd) cd.textContent = `auto ${nextRefresh}s`; }, 5000);
})();
