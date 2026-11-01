const $ = (id) => document.getElementById(String(id).replace(/^#/, ''));
const signed = (n, dp = 2) => (n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(dp));
const pctf = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(1) + '%');
const cls = (n) => (n == null ? '' : n >= 0 ? 'pos' : 'neg');
// Escape text that comes from outside the app — wire headlines, URLs, TradingView event titles,
// user-typed rule notes — before interpolating it into innerHTML. Server-side prose deliberately
// contains <b> tags, so only genuinely external strings are escaped, never the prose fields.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
let macroRegionSeq = 0;        // a region change invalidates an in-flight background prefetch
let transmission = null;       // /api/transmission — cross-asset logic
let macroTickers = null;       // this region's macro tickers (currencies + indices) for the tape
let macroChart = null;         // per-country index vs currency chart
const countryCache = {};       // id -> { t, data } so switching is instant
const COUNTRY_FX_ID = { 'DX-Y.NYB': 'dxy', 'EURUSD=X': 'eurusd', 'GBPUSD=X': 'gbpusd', 'USDJPY=X': 'usdjpy', 'USDCNY=X': 'usdcny', 'USDINR=X': 'usdinr', 'AUDUSD=X': 'audusd' };
let chartDp = 2;        // decimals for the current chart (set in renderChart)
const seenAlerts = new Set();
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
      + (m.companies ? `<div class="m-sec"><h4>COMPANY DATA — WHAT EACH BASIS MEANS</h4><div class="m-tbl-wrap"><table class="m-tbl"><thead><tr><th>Source</th><th>Basis</th><th>Notes</th></tr></thead><tbody>${m.companies.map((c) => `<tr><td>${c.name}</td><td>${c.basis}</td><td class="m-fresh">${c.note}</td></tr>`).join('')}</tbody></table></div></div>` : '')
      + (m.limits ? `<div class="m-sec"><h4>WHAT IS NOT COVERED</h4><ul class="m-rules">${m.limits.map((x) => `<li>${x}</li>`).join('')}</ul></div>` : '')
      + `<div class="m-sec"><h4>WHAT THE SCORES MEAN</h4>${scores}</div>`
      + `<div class="m-sec"><h4>HOW BASIS WORKS</h4><p>${m.basis}</p></div>`
      + `<div class="m-sec"><h4>THE RULES</h4><ul class="m-rules">${rules}</ul></div>`;
  }
  if (caveats) html += `<div class="m-sec"><h4>THINGS TO FLAG</h4><ul class="m-rules">${caveats}</ul></div>`;
  el.innerHTML = `<details class="fold" id="methodology"><summary>DATA &amp; METHODOLOGY</summary><div class="note-body">${html}</div></details>`
    + '<div class="foot-line dimtext">Marlon\'s Watchtower · built and maintained by <b>Marlon Benedict Tan</b> · data © the respective sources · not investment advice.</div>';
}
// The host sleeps when idle, so a first request can hang for 20-30s. The beacon just says 'waking the
// server…' and the failsafe waits longer — no plan/pricing chatter on the loading screen.
const BOOT_T0 = Date.now();
let coldTold = false;
function noteColdStart() {
  if (coldTold) return;
  coldTold = true;
  window.__coldStart = true;
  const st = document.getElementById('boot-status');
  if (st) st.textContent = 'waking the server…';
}
async function getJSON(url) {
  const t0 = Date.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  // The first response tells us whether the instance was asleep (or the network was slow).
  if (!coldTold && Date.now() - BOOT_T0 > 2500 && t0 - BOOT_T0 < 1500) noteColdStart();
  else if (!coldTold && Date.now() - BOOT_T0 > 4000 && !Object.values(bootReady).some(Boolean)) noteColdStart();
  return r.json();
}
// Memoised GET — a per-session cache so re-visiting a segment is instant (no re-fetch of the
// read, news, curve, etc.). Short TTL; the server has its own longer cache anyway.
const jcache = new Map();
const jfly = new Map();
async function jget(url, ttl = 180000) {
  const hit = jcache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  // Two panels asking for the same URL at the same moment share one request instead of racing.
  if (jfly.has(url)) return jfly.get(url);
  const p = getJSON(url)
    .then((v) => { jcache.set(url, { t: Date.now(), v }); return v; })
    .finally(() => jfly.delete(url));
  jfly.set(url, p);
  return p;
}
// The current selection identity — every loader captures it and drops its result if the user
// switched away while it was waiting. This is what stops "I clicked oil but it still shows corn".
const segKey = () => currentMarket + '|' + (currentComponent || '');
// Boot beacon: a progress bar + dots that fill as the CORE panels land. The overlay is dropped
// only once they are all in (or at a hard cap, so it never lingers on a slow feed).
// The loading overlay waits only for what HOME shows above the fold: the price board, the segment
// picker and the backdrop strip. The daily brief, the commodity read, the chart and the news strip
// live further down (or in the COMMODITIES pane) and fill themselves in — gating the first paint on
// them meant a cold upstream could hold the whole page for seconds. The 4s ceiling still applies.
const BOOT_CORE = ['data', 'segments', 'regime'];
const bootReady = Object.fromEntries(BOOT_CORE.map((k) => [k, false]));
let bootCount0 = 0;
const bootCount = () => BOOT_CORE.filter((k) => bootReady[k]).length;
const hideBoot = () => { window.__bootDone = true; const b = document.getElementById('boot'); if (b) b.classList.add('done'); };
// Run a below-the-fold render after the first screen is on the page — a 400-row screener or a
// 170-event calendar is not allowed to compete with the paint the reader is waiting for.
const afterBoot = (fn) => {
  if (window.__bootDone) { setTimeout(fn, 0); return; }
  const iv = setInterval(() => { if (window.__bootDone) { clearInterval(iv); setTimeout(fn, 0); } }, 100);
};
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
// Chart windows are asked for from several panels at once (the main chart, the compare chart, the
// seasonal band). One request per window, not one per caller: on a slow link the duplicates queue
// behind each other in the browser's six-connection budget.
const rangeFly = new Map();
const ltFly = new Map();
const seasonFly = new Map();
async function getLongterm(id, years = 10) {
  const k = id + years; const hit = ltCache[k];
  if (hit && Date.now() - hit.t < CHART_TTL) return hit.v;
  if (ltFly.has(k)) return ltFly.get(k);
  const p = getJSON(`/api/longterm?id=${encodeURIComponent(id)}&years=${years}`)
    .then((v) => { ltCache[k] = { t: Date.now(), v }; return v; })
    .finally(() => ltFly.delete(k));
  ltFly.set(k, p);
  return p;
}
const rangeCache = {};
async function getRange(id, range) {
  const k = id + range; const hit = rangeCache[k];
  if (hit && Date.now() - hit.t < CHART_TTL) return hit.v;
  if (rangeFly.has(k)) return rangeFly.get(k);
  const p = getJSON(`/api/range?id=${encodeURIComponent(id)}&range=${range}`)
    .then((v) => { rangeCache[k] = { t: Date.now(), v }; return v; })
    .finally(() => rangeFly.delete(k));
  rangeFly.set(k, p);
  return p;
}
const seasonCache = {};
async function getSeasonal(id) {
  const hit = seasonCache[id];
  if (hit && Date.now() - hit.t < CHART_TTL) return hit.v;
  if (seasonFly.has(id)) return seasonFly.get(id);
  const p = getJSON('/api/seasonal?id=' + encodeURIComponent(id))
    .then((v) => { seasonCache[id] = { t: Date.now(), v }; return v; })
    .finally(() => seasonFly.delete(id));
  seasonFly.set(id, p);
  return p;
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
function tileSpark(arr, forceUp = null, fill = false) {
  const v = (arr || []).filter((x) => x != null);
  if (v.length < 5) return '<svg class="spark" aria-hidden="true"></svg>';
  const w = 100, h = 22, min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
  const step = w / ((arr.length - 1) || 1);
  let d = '';
  arr.forEach((x, i) => { if (x == null) return; const px = (i * step).toFixed(1); const py = (h - 2 - ((x - min) / rng) * (h - 4)).toFixed(1); d += (d ? ' L' : 'M') + px + ',' + py; });
  const up = forceUp == null ? v[v.length - 1] >= v[0] : !!forceUp;   // null = judge by the window
  const col = up ? 'var(--green)' : 'var(--red)';
  const area = fill ? `<path d="${d}" fill="${col}" fill-opacity="0.09" stroke="none"/>` : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${area}<path d="${d}" fill="none" stroke="${col}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
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

// A pinned company: same tile grammar as an instrument, but it opens the company page.
function companyTile(c) {
  const chg = (v) => (v == null ? '' : `<em class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</em>`);
  return `<div class="tile" data-cik="${esc(c.cik)}" title="${esc(c.name)} — open the company page">
    <span class="t-name">${esc(c.ticker || c.name)}</span>
    <span class="star on" data-star="${esc(c.ticker)}" title="Unpin from watchlist">★</span>
    <span class="t-px">${c.price != null ? '$' + c.price.toFixed(2) : '—'}</span>
    <span class="t-foot">${chg(c.chg1d)} today · ${chg(c.chg6m)} 6M · ${chg(c.chgYtd)} YTD</span>
  </div>`;
}

// Home: the pinned instruments AND companies, in one board.
function renderWatchlist() {
  const el = $('home-watch');
  if (!el) return;
  const ids = watchlist();
  const tiles = ids.map((id) => {
    const b = data?.benchmarks?.find((x) => x.id === id);
    if (b) return tileHtml(b);
    if (String(id).startsWith('jp:')) {
      const code = String(id).slice(3);
      const j = japanData?.companies?.find((x) => x.code === code);
      if (j) return japanTile(j);
      if (!japanData) loadJapan().then(() => renderWatchlist());
      return null;
    }
    const c = companiesData?.companies?.find((x) => x.ticker === id);
    return c ? companyTile(c) : null;
  }).filter(Boolean);
  el.innerHTML = tiles.length
    ? `<div class="tiles">${tiles.join('')}</div>`
    : stEmpty('Nothing pinned yet — open <b>COMMODITIES</b> and click <b>☆</b> on an instrument, or open a company and click <b>☆</b> next to its name.');
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
  if (sel.options.length) markReady('segments');   // first screen is complete once the picker has options
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
function regLine(r) {
  const bits = [];
  if (r.perf?.m6 != null) bits.push(`${r.label} ${r.perf.m6 >= 0 ? 'up' : 'down'} ${Math.abs(r.perf.m6).toFixed(0)}% in 6 months`);
  if (r.range?.pos != null) bits.push(r.range.pos >= 70 ? 'near 2-year highs' : r.range.pos <= 30 ? 'near 2-year lows' : 'mid-range');
  if (r.curve) bits.push(r.curve.shape.toLowerCase());
  return `MARKET STATE — ${bits.join(' · ')}.`;
}
// Show only the segment-specific blocks (fuels/stocks for refined, …).
function toggleMarketBlocks() {
  document.querySelectorAll('.market-only').forEach((el) => {
    const list = (el.dataset.when || '').split(',').map((s) => s.trim());
    el.classList.toggle('hidden', !(list.includes('*') || list.includes(currentMarket)));
  });
  if (currentMarket === 'refined' && crackHistChart) setTimeout(() => crackHistChart.resize(), 80);
  syncJumpnavs();
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
  if (!items.length) { el.innerHTML = stEmpty(elId === 'macro-news' ? 'No tier-1 wire coverage on this country right now.' : 'No recent tier-1 headlines for this segment.'); return; }
  el.innerHTML = items.map((it) => `<a class="news-item" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer"><span class="news-src">${esc(it.source || 'wire')}</span><span class="news-t">${it.kind ? `<em class="news-k">${esc(it.kind)}</em> ` : ''}${esc(it.title)}</span><span class="news-d dimtext">${ago(it.date)}</span></a>`).join('')
    + '<div class="dimtext" style="padding:6px 12px;font-size:10px">Headlines via Google News · © the respective publishers · links open at the source.</div>';
}
function selectMarket(id) {
  saveStr('segment', id);
  currentMarket = id;
  currentComponent = null;   // reset to the segment's headline when the segment changes
  marketRead = null;         // clear so nothing from the previous segment can linger
  buildBpOptions();          // idempotent; also repairs the picker if it was built before markets arrived
  const pick = $('bp-metric');
  if (pick && [...pick.options].some((o) => o.value === id)) pick.value = id;   // keep the picker in sync
  renderSnapshot();

  toggleMarketBlocks();
  if (data) { renderCards(data); buildMetricOptions(data); }
  setCardsTitle();
  syncRoute(false);          // replace: the URL always reflects the current view
  renderCurveForSegment();   // the curve follows the segment
  loadCurveHistory();        // and so does the curve-over-time (or hides)
  loadSeasonal();            // and the seasonality grade (gas/grains/softs)
  loadCrush();               // and the soybean crush (grains)
  loadSteel();               // and the steel margin (industrial)
  renderAdaptive();
  loadMarketRead();
  loadNews();
  loadFundamentals();
  // Both live inside hidden-by-default COMMODITIES panels — don't fetch them for a tab that isn't open.
  whenNear('#positioning-panel', loadPositioning);
  whenNear('#options-panel', loadOptions);
  renderChart();
  syncCompareToSelection();
}

// ---------------------------------------------------------------------------
// Insights & alerts
// ---------------------------------------------------------------------------
const DEFAULT_THRESH = { brent: 10, wti: 3.5, diesel: 28 };
function thresholds() { try { return { ...DEFAULT_THRESH, ...(JSON.parse(localStorage.getItem('oilbasis.thresholds')) || {}) }; } catch { return DEFAULT_THRESH; } }
function computeAlerts(m) {
  const T = thresholds();
  const out = []; const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  if (by.brent?.basis != null && Math.abs(by.brent.basis) > T.brent) out.push({ level: 'high', text: `Brent real-vs-futures gap is extreme (${signed(by.brent.basis)}).` });
  if (by.wti?.basis != null && Math.abs(by.wti.basis) > T.wti) out.push({ level: 'med', text: `WTI real-vs-futures gap is wide (${signed(by.wti.basis)}).` });
  const s = m.spreads.brent_wti;
  if (s && Math.abs(s.physical - s.paper) > 5) out.push({ level: 'med', text: `Brent vs WTI: the real gap and the futures gap have split by ${signed(s.physical - s.paper)}.` });
  const diesel = crackSpreads(m).find((c) => c.label.startsWith('Diesel refining profit'));
  if (diesel && diesel.value > T.diesel) out.push({ level: 'high', text: `Diesel refining profit is very high (${signed(diesel.value)} a barrel).` });
  if (diesel && diesel.value < 6) out.push({ level: 'high', text: `Diesel refining profit is very low (${signed(diesel.value)}) — refiners may cut back.` });
  return out;
}
function renderThresholds() {
  const T = thresholds();
  const rows = [['brent', 'Brent gap alerts above', T.brent], ['wti', 'WTI gap alerts above', T.wti], ['diesel', 'Diesel profit alerts above', T.diesel]];
  $('alert-thresholds').innerHTML = rows.map(([k, label, v]) => `<label class="thr"><span>${label}</span><input type="number" step="0.5" data-k="${k}" value="${v}"></label>`).join('');
  $('alert-thresholds').querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
    const t2 = thresholds(); t2[inp.dataset.k] = Number(inp.value);
    localStorage.setItem('oilbasis.thresholds', JSON.stringify(t2));
    renderAlerts(computeAlerts(data));
  }));
}
function renderAlerts(alerts) {
  $('alert-count').textContent = String(alerts.length);
  $('alert-count').className = 'pill ' + (alerts.some((a) => a.level === 'high') ? 'warn' : alerts.length ? '' : 'ok');
  $('alerts').innerHTML = alerts.length ? alerts.map((a) => `<div class="alert ${a.level}"><span class="badge">${a.level === 'high' ? 'HIGH' : 'WATCH'}</span> ${a.text}</div>`).join('') : '<div class="alert none">No alerts — markets within normal ranges.</div>';
  if ('Notification' in window && Notification.permission === 'granted') for (const a of alerts) if (a.level === 'high' && !seenAlerts.has(a.text)) { seenAlerts.add(a.text); try { new Notification('Oil market alert', { body: a.text }); } catch {} }
}
// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------
function renderTicker(m) {
  if (!m) return;
  // One constant tape: every commodity + every currency + every macro index, always the same
  // regardless of which tab you're on. Deduped so shared names appear once.
  const seen = new Set();
  const cells = [];
  const push = (label, cell) => { const k = (label || '').replace(/\s*[·(].*/, '').trim(); if (!k || seen.has(k)) return; seen.add(k); cells.push(cell); };

  for (const b of m.benchmarks) {
    const s0 = history?.series?.[b.id];
    const arr = b.paper != null ? s0?.paper : s0?.physical;
    const val = b.paper != null ? b.paper : b.physical;
    const chg = changeOf(arr), pc = pctOf(arr);
    const c = chg == null ? '' : chg >= 0 ? 'pos' : 'neg';
    const arrow = chg == null ? '' : chg >= 0 ? '▲' : '▼';
    const short = b.label.replace(/\s*\(.*\)/, '');
    const d = headDeltas(b);
    const tip = d ? HORIZONS.map(([l, k]) => `${l} ${d[k] == null ? '—' : pctf(d[k])}`).join(' · ') : '';
    const fs = headSource(b);
    push(short, {
      label: short,
      px: val == null ? '—' : Number(val).toFixed(b.dp),
      chg: chg == null ? '' : `${arrow}${Math.abs(chg).toFixed(b.dp)} ${pctf(pc)}`,
      cls: c,
      title: `${short} · ${tip || 'no history'} — ${fs.source || ''} ${fs.asOf || ''}`,
    });
  }
  for (const f of (lastFx || [])) {
    push(f.label, {
      label: f.label.replace(/\s*·.*/, ''),
      px: f.price == null ? '—' : Number(f.price).toFixed(f.price < 10 ? 4 : 2),
      chg: f.pct == null ? '' : pctf(f.pct),
      cls: cls(f.pct),
      title: '',
    });
  }
  for (const t of (macroTickers || [])) {
    push(t.label, {
      label: t.label,
      px: t.price == null ? '—' : Number(t.price).toFixed(t.price < 10 ? 4 : 2),
      chg: t.pct == null ? '' : pctf(t.pct),
      cls: cls(t.pct),
      title: '',
    });
  }

  const ticker = $('ticker');
  if (!ticker) return;
  const html = (c) => `<span class="tk"${c.title ? ` title="${esc(c.title)}"` : ''}><b>${esc(c.label)}</b><span class="tk-px">${esc(c.px)}</span><span class="tk-chg ${c.cls}">${esc(c.chg)}</span></span>`;
  const track = ticker.querySelector('.ticker-track');
  const sig = cells.map((c) => c.label).join('|');

  // Same cells, new numbers: update the text in place. Re-creating ~70 spans once a minute was the
  // hitch the eye caught on a phone — the tape restarted its paint while everything else refreshed.
  const nodes = track ? track.querySelectorAll('.tk') : null;
  if (track && sig === tickerSig && nodes && nodes.length === cells.length * 2) {
    const n = cells.length;
    for (let i = 0; i < n * 2; i++) {
      const c = cells[i % n], el = nodes[i];
      const b = el.querySelector('b'), px = el.querySelector('.tk-px'), ch = el.querySelector('.tk-chg');
      if (b && b.textContent !== c.label) b.textContent = c.label;
      if (px && px.textContent !== c.px) px.textContent = c.px;
      if (ch && ch.textContent !== c.chg) ch.textContent = c.chg;
      if (ch) { const k = `tk-chg ${c.cls}`; if (ch.className !== k) ch.className = k; }
      if ((el.title || '') !== c.title) el.title = c.title;
    }
    tickerHalf = 0;              // a changed number can change the width; re-measure once
  } else {
    const one = cells.map(html).join('');
    tickerSig = sig;
    if (track) track.innerHTML = `${one}${one}`;
    else ticker.innerHTML = `<div class="ticker-track">${one}${one}</div>`;   // two copies → seamless marquee
    tickerHalf = 0;
  }
  tickerStart();
}

// The tape moves on requestAnimationFrame, NOT a CSS animation: iOS Safari latches :hover after a
// touch (and can still report `(hover: hover)`), which freezes a CSS marquee. Owning the motion in
// JS means it always runs; press-and-hold pauses it. Two identical copies make a seamless loop.
let tickerX = 0, tickerRAF = null, tickerLast = 0, tickerHeld = false, tickerPaused = false, tickerWired = false;
// One copy's width, measured only when the content or the viewport changes. Reading scrollWidth inside
// the frame loop forced a layout flush on every single frame — that is what made the tape stutter.
let tickerHalf = 0, tickerSig = '';
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
    addEventListener('resize', () => { tickerHalf = 0; }, { passive: true });
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
    const half = tickerHalf || (tickerHalf = track.scrollWidth / 2);   // measured once, then cached
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
  if (a >= 1e12) return (v / 1e12).toFixed(2).replace(/\.?0+$/, '') + 'T';
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
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2021-10-25" is 80px of label; "Oct 21" is 40px and fits four to a phone screen.
const shortDate = (v) => {
  const [y, m] = String(v).split('-');
  return m && MONTHS_SHORT[+m - 1] ? `${MONTHS_SHORT[+m - 1]} ${y.slice(2)}` : String(v);
};
function baseOptions({ dp = 2, unit = '', percentAxis = false, yTitle = '', y1Title = '', legend = true, log = false, anchorable = false, dateAxis = false } = {}) {
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
      x: {
        ticks: {
          color: CT.text, autoSkip: true, maxRotation: 0,
          maxTicksLimit: dateAxis ? (typeof window !== 'undefined' && window.innerWidth < 640 ? 4 : 6) : 7,
          callback: dateAxis ? function (value) { return shortDate(this.getLabelForValue(value)); } : undefined,
        },
        grid: { color: CT.grid },
      },
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
  // The page replaces its innerHTML on every navigation, so the canvas a chart was mounted on is gone.
  // Reusing the instance then draws into a detached element — the "chart not loading" bug.
  if (charts[id] && charts[id].canvas !== cv) { try { charts[id].destroy(); } catch {} delete charts[id]; }
  if (charts[id]) { charts[id].data = data; charts[id].options = options; charts[id].resize(); charts[id].update(); return charts[id]; }
  charts[id] = new Chart(cv, { type: 'line', data, options, plugins: plugins || [] });
  // The canvas can be mounted before the layout settles (a page rendered from a search), which leaves
  // it zero-height and draws nothing. Nudge it once the frame is painted.
  requestAnimationFrame(() => { try { charts[id]?.resize(); } catch {} });
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

  // State the selected window's return over the plot itself — the number was only in the small
  // summary line under the chart, which is easy to miss. Taken from the plotted series, so the label
  // can never disagree with the line above it.
  const bigEl = $('chart-big');
  if (bigEl) {
    const series0 = (datasets[0] && datasets[0].data) || [];
    const vals = series0.filter((v) => v != null);
    if (vals.length > 1 && vals[0]) {
      const pct = (vals[vals.length - 1] / vals[0] - 1) * 100;
      bigEl.innerHTML = `<b class="${pct >= 0 ? 'pos' : 'neg'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</b><span>${range.toUpperCase()}</span>`;
    } else {
      bigEl.innerHTML = '';
    }
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
  chart = mountChart('chart', chartData, baseOptions({ dp: chartDp, anchorable: true, dateAxis: true }), [anchorLine, bandsPlugin]);
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
  // Through jget so the curve panel and the chart overlay share one in-flight request.
  const v = await jget('/api/termstructure?id=' + encodeURIComponent(id), 180000).catch(() => null);
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
  el.innerHTML = `<span class="dimtext">big moves on this chart — hover a marker for the headline, or open the source:</span> ` + ev.map((e) => { const t = String(e.title); const short = t.length > 72 ? t.slice(0, 71) + '…' : t; return `<a class="ce" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" title="${esc(t)}"><span class="ce-dot" style="background:${e.color}"></span>${e.date.slice(5)} ${e.move >= 0 ? '▲' : '▼'} ${moveText(e)} · ${esc(short)} <span class="dimtext">(${esc(e.source)})</span></a>`; }).join('');
}
// Shared by every chart: detect its big moves, attach the trusted news (as a line INSIDE the
// normal tooltip) and render the clickable chip list under the chart.
async function attachMarkers(chart, newsId, labels, seriesList, chipsSel, mode = 'pct', focusId = null) {
  if (!chart) return;
  // Race guard: if the user switches segment/country/metric before this resolves, a newer call
  // bumps $mseq and we drop the stale result (otherwise old headlines linger on the new chart).
  const seq = (chart.$mseq || 0) + 1; chart.$mseq = seq;
  const chips = $(chipsSel); if (chips) chips.innerHTML = '';
  const run = async () => {
    if (chart.$mseq !== seq) return;
    const ev = await chartMoveMarkers(newsId, labels, seriesList, mode, focusId).catch(() => []);
    if (chart.$mseq !== seq) return;
    chart.$events = ev;
    applyNewsDataset(chart, ev);
    renderChartEvents(ev, chipsSel);
    chart.update('none');
  };
  // Macro charts sit below the country card. Do not spend a news lookup per chart until the reader is
  // actually near them; flipping through countries at the top then costs the card + extras only.
  const inMacro = chart.canvas && chart.canvas.closest && chart.canvas.closest('#pane-macro');
  if (inMacro) {
    const node = chart.canvas.closest('.chart-wrap') || chart.canvas;
    whenNear(node, run, '250px');
    return;
  }
  await run();
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
  // The boot already fetched history; refetching it here sent the same 24 KB twice on every load.
  if (!history || !history.series) { try { await loadHistory(); } catch { return; } }
  if (!data) return;
  renderCards(data); renderSnapshot(); renderTicker(data); renderWatchlist();
  if ($('range') && $('range').value === '6m') renderChart();
}
async function loadMarket() {
  let d = null;
  try { d = await getJSON('/api/market'); }
  catch (e) { console.error('[market]', e.message); if (data && data.benchmarks && data.benchmarks.length) return; throw e; }   // keep the last good board; never blank it on a hiccup
  data = d;
  markReady('data');
  renderCards(data); buildMetricOptions(data); buildBpOptions();
  renderSnapshot(); setCardsTitle(); renderTicker(data);
  renderWatchlist();
  await renderChart();   // ← render AFTER data exists
  buildCompareOptions(); syncCompareToSelection();
  loadSeasonal();
  loadMarketRead();      // populate the adaptive Big Picture (hero line + panels)
  loadNews();
  updateFreshness(data.updated);
  renderMethodology(data);
}

// ---------------------------------------------------------------------------
// New panels: context, inventories, positioning, sectors
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
  const dv = primary.divergence;
  if (dv && dv.read && dv.tone !== 'flat') {
    const tone = dv.tone === 'bear' ? 'watch' : dv.tone === 'bull' ? 'ok' : '';
    html += `<div class="pos-note"><span class="qflag ${tone}" style="margin-right:7px">PRICE vs POSITIONING</span>${dv.read}</div>`;
  }
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
function sectorRead(m, a) {
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
  lines.push('High crude + wide cracks squeeze <b>airlines</b> (DAL, UAL, AAL) and <b>petrochemicals</b> (LYB) via input costs.');
  return lines;
}
function renderSectors(eq, m, a) {
  $('sector-read').innerHTML = '<ul class="ins-list">' + sectorRead(m, a).map((x) => `<li>${x}</li>`).join('') + '</ul>';
  if (!eq) { $('sectors').innerHTML = ''; return; }
  $('eq-date').textContent = 'quotes ' + new Date().toLocaleTimeString('en-GB');
  $('sectors').innerHTML = eq.groups.map((g) => {
    const qs = g.quotes.map((q) => `<span class="eq ${cls(q.pct)}"><b>${q.symbol}</b> ${q.price != null ? q.price.toFixed(q.price < 10 ? 3 : 2) : '—'} <em>${q.pct != null ? pctf(q.pct) : ''}</em></span>`).join('');
    return `<div class="eq-group"><div class="eq-name">${g.name} <span class="dimtext">— ${g.why}</span></div><div class="eq-list">${qs}</div></div>`;
  }).join('');
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

// Steel margin — the industrial twin of the soybean crush: coil minus the ore needed to make it ($/t).
async function loadSteel() {
  const el = $('steel');
  if (!el) return;
  if (currentMarket !== 'industrial') { el.innerHTML = ''; return; }
  const k = segKey();
  el.innerHTML = stLoading('Reading the steel margin…');
  let d; try { d = await jget('/api/steel', 300000); } catch { d = null; }
  if (k !== segKey() || currentMarket !== 'industrial') return;
  renderSteel(d);
}
let steelChart;
function renderSteel(d) {
  const el = $('steel'); if (!el) return;
  if (!d || d.error || d.margin == null || !d.legs) { el.innerHTML = stError('Steel-margin data isn\u2019t available right now.'); return; }
  // Relative, not absolute: a gross spread has no universal line between "healthy" and "thin".
  const word = (p) => p == null ? '—' : p >= 80 ? 'wide vs its own history' : p <= 20 ? 'compressed vs its own history' : 'normal for the last two years';
  el.innerHTML = `<div class="cards">
    <div class="card"><h3>Steel margin <span>$/tonne</span></h3>
      <div class="row"><span class="k">Coil − 1.6 × ore</span><span class="v basis ${cls(d.margin)}">${signed(d.margin, 0)}</span></div>
      <div class="row"><span class="k">How extreme</span><span class="v">${d.pct == null ? '—' : d.pct.toFixed(0) + '/100'}</span></div>
      <div class="row"><span class="k">Read</span><span class="v dimtext" style="font-weight:400">${word(d.pct)}</span></div></div>
    <div class="card"><h3>Coil ÷ ore <span>multiple</span></h3>
      <div class="row"><span class="k">Ratio</span><span class="v">${d.ratio == null ? '—' : d.ratio.toFixed(1) + '×'}</span></div>
      <div class="row"><span class="k">How extreme</span><span class="v">${d.ratioPct == null ? '—' : d.ratioPct.toFixed(0) + '/100'}</span></div>
      <div class="row"><span class="k">Read</span><span class="v dimtext" style="font-weight:400">${word(d.ratioPct)}</span></div></div>
    <div class="card"><h3>The two legs <span>$/tonne</span></h3>
      <div class="row"><span class="k">Coil (HRC)</span><span class="v">${d.legs.coilPerT == null ? '—' : signed(d.legs.coilPerT, 0)}</span></div>
      <div class="row"><span class="k">Ore cost (×1.6)</span><span class="v">${d.legs.orePerT == null ? '—' : signed(-Math.abs(d.legs.orePerT), 0)}</span></div>
      <div class="row"><span class="k">Excludes</span><span class="v dimtext" style="font-weight:400">coking coal, energy &amp; scrap</span></div></div>
  </div>`;
  renderSteelHistory(d.history);
}
function renderSteelHistory(h) {
  const cv = $('steelhist'); if (!cv || !h?.dates?.length) return;
  const data = { labels: h.dates, datasets: [
    { label: 'Steel margin $/t', data: h.margin, borderColor: CT.accent, backgroundColor: CT.accent + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, yAxisID: 'y' },
    { label: 'Coil ÷ ore', data: h.ratio, borderColor: CT.c1, backgroundColor: CT.c1 + '22', borderWidth: 1.5, pointRadius: 0, tension: 0.25, yAxisID: 'y1' },
  ] };
  steelChart = mountChart('steelhist', data, baseOptions({ dp: 0, yTitle: '$/t', y1Title: '×' }));
  // focus 'steel' so a margin move is explained by a steel story, not whichever copper headline
  // happens to be in the industrial segment's feed.
  attachMarkers(steelChart, 'industrial', h.dates, [h.margin], '#steel-events', 'pct', 'steel');
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
function macroTile(label, value, sub, klass, metric, extra) {
  return `<div class="kpi${metric ? ' clickable' : ''}"${metric ? ` data-metric="${metric}" title="Click for the chart"` : ''}><div class="kpi-l">${label}</div><div class="kpi-v ${klass || ''}">${value}</div><div class="kpi-s dimtext">${sub || ''}</div>${extra || ''}</div>`;
}
let countriesP = null;          // in-flight /api/countries fetch, shared by boot + the region renderer
function ensureCountries() {
  if (macroCountries) return Promise.resolve(macroCountries);
  if (!countriesP) countriesP = getJSON('/api/countries').catch(() => null).then((c) => { macroCountries = macroCountries || c || {}; return macroCountries; });
  return countriesP;
}
function renderMacroRegion() {
  // The country lists arrive with a boot-time fetch. If a region is picked before they land (or the
  // fetch is slow), rendering now would fall back to the US — so wait, then render the picked region.
  if (!macroCountries) { ensureCountries().then(renderMacroRegion); return; }
  const seq = ++macroRegionSeq;   // cancels a prefetch that belonged to the previous region
  const sel = $('macro-country');
  const list = (macroCountries && macroCountries[macroRegion]) || [];
  if (sel) {
    sel.innerHTML = list.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
    // Keep the country the reader is already on when the same region re-renders (a background refresh
    // used to snap the panel back to the region's first country). A real region change has a country
    // that is not in the new list, so it still falls back to that region's first country.
    const keep = (prefCountry && list.some((c) => c.id === prefCountry)) ? prefCountry
      : (list.some((c) => c.id === macroCountry) ? macroCountry : (list[0] ? list[0].id : 'us'));
    macroCountry = keep; prefCountry = null;
    if ([...sel.options].some((o) => o.value === macroCountry)) sel.value = macroCountry;
  }
  loadMacroTickers();   // feeds the top tape — keep eager
  // The country panel pulls World Bank/BIS/FRED data and renders 5 charts. It's a hidden pane while
  // the reader is on HOME, so render it when MACRO is actually opened (a no-op once seen).
  // Prefetch the rest of the region only once the page is idle — doing it immediately competes with the
  // country you actually opened, which is what made some of them feel slow.
  whenNear('#pane-macro', () => {
    loadRegionCurrencies();
    loadCountry().then(() => {
      const go = () => { if (seq === macroRegionSeq) prefetchRegion(seq); };
      // Later and gentler: the burst used to compete with the country the reader had just opened,
      // which is exactly what made the first country feel slow. Give the visible panel a couple of
      // seconds (not just "the next idle moment") before warming the rest of the region.
      setTimeout(() => {
        if (seq !== macroRegionSeq) return;
        if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 8000 }); else go();
      }, 2500);
    });
  });
}
// The chosen country's name — shared by the currency and catalyst panel scopes.
function countryLabel(id) {
  const list = (macroCountries && macroCountries[macroRegion]) || [];
  const c = list.find((x) => x.id === id);
  return c ? c.label : String(id || '').toUpperCase();
}
// CURRENCIES board — scoped to the chosen COUNTRY so it matches the catalysts panel below it.
async function loadRegionCurrencies() {
  const el = $('macro-fx');
  if (!el) return;
  el.innerHTML = stLoading();
  const reqR = macroRegion, reqC = macroCountry;
  let items = null;
  try { items = (await jget('/api/region-quotes?id=' + reqR, 300000)).items || []; } catch {}
  if (reqR !== macroRegion || reqC !== macroCountry) return;   // newest pick wins
  const scope = $('fx-scope'); if (scope) scope.textContent = countryLabel(reqC).toUpperCase();
  const byLabel = {};
  for (const f of (fxList || [])) byLabel[f.label.replace(/\s*·.*/, '')] = f.id;   // chartable ones only
  const fx = (items || []).filter((i) => i.kind === 'fx' && i.id === reqC);
  el.innerHTML = fx.length
    ? '<div class="kpis">' + fx.map((f) => {
      const cid = byLabel[f.label.replace(/\s*·.*/, '')];
      return macroTile(f.label, f.price == null ? '—' : Number(f.price).toFixed(f.price < 10 ? 4 : 2), f.pct != null ? pctf(f.pct) : '', cls(f.pct), cid ? 'fx:' + cid : null, f.deltas ? deltaStrip(f.deltas) : '');
    }).join('') + '</div><div class="macro-note">the chosen country\'s currency · moves over 1D/1W/1M/YTD/1Y</div>'
    : stEmpty('No currency for this country.');
}
async function loadMacroTickers() {
  // the macro tape shows EVERY macro ticker (all regions) so it is never sparse. It is the same list
  // on every region change, so cache it instead of paying ~1.7s each time.
  let items = null;
  try { items = (await jget('/api/macro-tickers', 300000)).items || []; } catch { items = null; }
  if (items) macroTickers = items;
  if (data) renderTicker(data);
}
// Upcoming catalysts — scoped to the chosen country, collapsed under its own header.
const CAT_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CAT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const catDate = (d) => { const t = new Date(d + 'T12:00:00Z'); return `${CAT_DOW[t.getUTCDay()]} ${t.getUTCDate()} ${CAT_MON[t.getUTCMonth()]}`; };
async function loadCatalysts() {
  const el = $('macro-events');
  if (!el) return;
  const req = macroCountry || 'us';
  el.innerHTML = stLoading();
  let d = null;
  try { d = await jget('/api/catalysts?country=' + encodeURIComponent(req), 600000); } catch {}
  if (req !== (macroCountry || 'us')) return;   // newest country wins
  renderCatalysts(d, req);
}
// Rendered from the country payload (or the fallback request above).
function renderCatalysts(d, req = macroCountry || 'us') {
  const el = $('macro-events');
  if (!el) return;
  const scope = $('cat-scope'); if (scope) scope.textContent = ((d && d.label) || req).toUpperCase();
  const items = (d && d.events) || [];
  const cnt = $('cat-count'); if (cnt) cnt.textContent = items.length ? `· ${items.length}` : '';
  el.innerHTML = items.length
    ? items.map((e) => `<div class="cal-row"><span class="cal-date">${catDate(e.date)}</span><span class="cal-name">${esc(e.name)}${e.time ? ` <span class="dimtext">· ${esc(e.time)}</span>` : ''}</span><span class="cal-src${e.importance >= 1 ? ' hi' : ''}">${e.importance >= 1 ? 'High' : e.importance === 0 ? 'Med' : 'Low'}</span></div>`).join('')
      + '<div class="macro-note">Near-term releases for this country, from TradingView\'s economic calendar. The full dated schedule (including FOMC) lives in the Calendar panel.</div>'
    : stEmpty('No releases scheduled for ' + ((d && d.label) || req) + ' over the next 6 weeks.');
}
// Cached fetch: instant if we already have it (or prefetched).
async function fetchCountry(id) {
  const hit = countryCache[id];
  if (hit && Date.now() - hit.t < 5 * 60e3) return hit.data;
  try { const data = await getJSON('/api/country?id=' + encodeURIComponent(id)); countryCache[id] = { t: Date.now(), data }; return data; }
  catch { return countryCache[id] ? countryCache[id].data : null; }
}
// Warm every other country in the region in the background → switching is instant.
async function prefetchRegion(seq = macroRegionSeq) {
  const list = (macroCountries && macroCountries[macroRegion]) || [];
  const ids = list.map((c) => c.id).filter((id) => id !== macroCountry);
  // A metered/slow connection should not spend a region's worth of background payloads.
  const conn = navigator.connection || {};
  if (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '')) return;
  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      if (seq !== macroRegionSeq) return;   // the reader moved on — stop warming the old region
      const id = ids[i++];
      await fetchCountry(id);
      if (seq !== macroRegionSeq) return;
    }
  };
  await Promise.all([worker(), worker()]);
}
async function loadCountry() {
  const el = $('macro-region-panel');
  if (!el) return;
  const req = macroCountry;                       // guard: newest country wins
  loadRegionCurrencies();                         // country-scoped, and independent of the card
  const showUsJp = req === 'us' || req === 'jp';
  const up = $('usjp-panel');
  if (up) up.classList.toggle('hidden', !showUsJp);
  syncJumpnavs();
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

  const hasIndex = !!(c.index.label && !/not free/i.test(c.index.label));
  html += '<div class="bb-sec">MARKET</div><div class="bb-grid">'
    + card(c.fx.label, num(c.fx.price, c.fx.price != null && c.fx.price < 10 ? 4 : 2), (c.fx.pct != null ? pctf(c.fx.pct) + ' today' : '—') + freshBadge(c.fx.source, c.fx.asOf), cls(c.fx.pct), c.fx.deltas)
    + (hasIndex ? card(c.index.label, num(c.index.price, c.index.price != null && c.index.price < 1000 ? 1 : 0), (c.index.pct != null ? pctf(c.index.pct) + ' today' : '—') + freshBadge(c.index.source, c.index.asOf), cls(c.index.pct), c.index.deltas)
        : card('Equity market', 'N/A', 'no free index exists for this country', 'dim'))
    + '</div>'
    + (hasIndex ? '' : `<div class="macro-note">Equity market: <b>not available</b> — no free index or ETF tracks ${esc(c.label)}, so the currency and the macro data above are what we can show.</div>`);

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

  html += '<div class="bb-sec">COMMODITY LINKAGE</div>';
  if (c.peg) {
    // A pegged currency does not float, so a correlation against it measures nothing.
    html += `<div class="macro-note">Nothing to correlate — the currency is <b>pegged to the US dollar at ${c.peg}</b>, so it does not float against it.</div>`;
  } else {
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
  }
  if (c.takeaways && c.takeaways.length) html += '<div class="bb-sec">KEY TAKEAWAYS</div><ul class="ins-list">' + c.takeaways.map((t) => `<li>${t}</li>`).join('') + '</ul>';
  html += '<div class="bb-sec">CROSS-ASSET — HOW THIS REGION IS AFFECTED</div>' + crossAssetBlock((i) => (i.regions || []).includes(macroRegion));
  el.innerHTML = html;
  // The card, news and chart series all arrived in this one payload. The two slow, independent feeds
  // (yields + catalysts) come from /api/country-extras in a single follow-up request, so the card is
  // never held hostage by them; the separate loaders remain as a fallback for an upstream outage.
  if (c.news) renderNews(c.news, 'macro-news', 'macro-news-sub'); else loadMacroNews();
  loadCountryChart(c.series);
  if (c.yields && c.catalysts) { renderYields(c.yields); renderCatalysts(c.catalysts, req); }
  else loadCountryExtras(req);
  renderPolicyChart(c.policy, c.policyNote);
  renderCpiChart(c.cpi);
}
// Yields + catalysts in one request (the card does not wait for them).
async function loadCountryExtras(req = macroCountry) {
  let d = null;
  try { d = await jget('/api/country-extras?id=' + encodeURIComponent(req), 600000); } catch {}
  if (req !== macroCountry) return;
  if (d && !d.error) {
    if (d.yields) renderYields(d.yields); else loadYields();
    if (d.catalysts) renderCatalysts(d.catalysts, req); else loadCatalysts();
  } else { loadYields(); loadCatalysts(); }
}
// Per-country chart: equity index and currency, both indexed to 100 so they compare.
// The country chart compares this country against whatever you pick: another country's index (the
// default is the S&P 500 — or the euro area when you are looking at the US), a currency, or a commodity.
const MACRO_VS_DEFAULT = (id) => (id === 'us' ? 'idx:ea' : 'idx:us');
function buildMacroVs() {
  const sel = $('macro-vs'); if (!sel || sel.options.length) return;
  const idx = [];
  for (const list of Object.values(macroCountries || {})) for (const c of list) if (c.index) idx.push(`<option value="idx:${c.id}">${esc(c.indexLabel || c.label)}</option>`);
  const fxs = (fxList || []).map((f) => `<option value="fx:${f.id}">${esc(f.label.replace(/\s*·.*/, ''))}</option>`).join('');
  const coms = ((data && data.benchmarks) || []).filter((b) => b.paper).map((b) => `<option value="bench:${b.id}">${esc(b.label)}</option>`).join('');
  sel.innerHTML = `<optgroup label="INDICES">${idx.join('')}</optgroup><optgroup label="CURRENCIES">${fxs}</optgroup><optgroup label="COMMODITIES">${coms}</optgroup>`;
}
function syncMacroVs() {
  buildMacroVs();
  const sel = $('macro-vs'); if (!sel) return;
  const saved = localStorage.getItem('oilbasis.macroVs') || '';
  const want = saved && saved !== `idx:${macroCountry}` ? saved : MACRO_VS_DEFAULT(macroCountry);
  if ([...sel.options].some((o) => o.value === want)) sel.value = want;
}
const currentVs = () => (($('macro-vs') && $('macro-vs').value) || MACRO_VS_DEFAULT(macroCountry));
async function loadCountryChart(pre = null) {
  const cv = $('macro-chart');
  if (!cv) return;
  const req = macroCountry;
  syncMacroVs();
  const vs = currentVs();
  const range = $('macro-range') ? $('macro-range').value : '1y';
  let d = pre && pre.dates && pre.id === req && pre.range === range && pre.vsSpec === vs ? pre : null;
  if (!d) {
    try { d = await jget('/api/country-series?id=' + encodeURIComponent(req) + '&range=' + range + '&vs=' + encodeURIComponent(vs), 300000); }
    catch { return; }
  }
  if (req !== macroCountry) return;
  if (!d || d.error || !d.dates || !d.dates.length) return;
  const norm = (arr) => { const base = (arr || []).find((v) => v != null); return (arr || []).map((v) => (v == null || !base) ? null : (v / base) * 100); };
  chartDp = 1; chartAnchor = null;
  // No free index for this country? Then its currency is the line we have.
  const hasIdx = d.index && d.index.some((v) => v != null);
  const main = hasIdx ? { arr: d.index, label: d.indexLabel } : { arr: d.fx, label: d.fxLabel };
  const datasets = [];
  if (main.arr && main.arr.some((v) => v != null)) datasets.push(line(`${main.label} (indexed)`, norm(main.arr), CT.c1));
  if (d.vs && d.vs.some((v) => v != null)) datasets.push(line(`${d.vsLabel} (indexed)`, norm(d.vs), CT.c4));
  const note = $('macro-chart-note');
  if (note) note.textContent = `${d.label} — ${main.label || 'this market'} vs ${d.vsLabel || 'nothing'}, both starting at 100; hover a point for its % change.`
    + `${hasIdx ? '' : ' No free equity index exists for this country, so the currency is the line above.'}`
    + `${d.peg ? ` (The currency is pegged at ${d.peg}, so it is not charted — a flat line says nothing.)` : ''}`;
  macroChart = mountChart('macro-chart', { labels: d.dates, datasets }, baseOptions({ dp: 1 }));
  attachMarkers(macroChart, req, d.dates, [main.arr, d.vs].filter(Boolean), '#macro-chart-events');
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
  // Venezuela's series runs from 21% to 65,374% (2018 hyperinflation). On a linear axis that is one
  // spike with everything else flat against zero, so a chart that extreme switches to a log axis —
  // the shape stays honest, the axis just says "×10 each step" instead of hiding the history.
  const vals = cpi.map((d) => d.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const logCpi = lo > 0 && hi / lo > 50;
  if (note) note.textContent = `latest ${cpi[cpi.length - 1].value}% (${cpi[cpi.length - 1].year})${logCpi ? ' · log scale' : ''}`;
  const data = { labels: cpi.map((d) => String(d.year)), datasets: [{ label: 'CPI YoY %', data: vals, borderColor: CT.c4, backgroundColor: CT.c4 + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false }] };
  cpiChart = mountChart('cpi-chart', data, baseOptions({ dp: 1, percentAxis: true, legend: false, log: logCpi }));
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
  if ($('macro-region-panel')) whenNear('#pane-macro', loadCountry);
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
      <div class="xa-trig ${i.effect === 'down' ? 'neg' : 'pos'}">${i.effect === 'down' ? '▼' : '▲'} ${esc(i.kind)} <span class="dimtext">· ${i.ageDays <= 14 ? 'recent' : Math.max(1, Math.round(i.ageDays / 30)) + 'mo ago'} · ${esc(i.source)}</span></div>
      <div class="xa-chain"><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a></div>
      <div class="macro-note">${i.chain}</div>
    </div>`).join('')
    + '<div class="macro-note">Auto-tagged: a keyword matched a supply/demand event — a prompt to investigate, not a certainty. Links open at the source.</div>';
}
// On-screen daily brief (HOME) — what happened / what's on today, in 60 seconds.
// The brief is read top-down in three beats: three stat tiles (the day in one glance), the macro
// moves with the wire story behind them, then the commodity detail and what's next.
// The brief: one hero (the day's most newsworthy move), then two strict columns — what happened and
// what's next — and a single dim context line. Every row uses the same grammar: tag · name · % · spark.
function renderBrief(b) {
  const el = $('home-brief');
  if (!el) return;
  if (!b || b.error) { el.innerHTML = stError('Couldn\u2019t load today\u2019s brief — retrying.'); return; }
  const upd = $('brief-updated');
  if (upd) upd.textContent = 'as of ' + new Date(b.updated).toLocaleString('en-GB');
  const h = b.hero;
  // IMPORTANT TODAY — event-first. The card carries the event, the reason the wire gives, and the
  // market evidence. It is a separate layer from the ranked tape below, not another row of it.
  const evDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    // The reader's calendar and clock: a story filed two hours ago should read "Today", even when
    // the server's UTC day has not rolled over yet.
    const now = new Date();
    const hasTime = /T\d/.test(String(iso));
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return hasTime ? `Today ${time}` : 'Today';
    if (d.toDateString() === new Date(now.getTime() - 864e5).toDateString()) return hasTime ? `Yesterday ${time}` : 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  };
  const impHtml = (b.events || []).length
    ? `<div class="gtitle">IMPORTANT · ${esc(b.sessionDate ? evDate(b.sessionDate) : 'TODAY')}</div><div class="imp-list">${b.events.slice(0, 5).map((e) => {
      const mkt = (e.market || []).map((m) => `<span class="imp-m ${cls(m.d1)}">${esc(m.label)} ${pctf(m.d1)}</span>`).join('');
      const src = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.source || 'Source')}</a>` : '';
      const wires = (e.sources || []).length > 1 ? `<span class="dimtext">${e.sources.length} wires</span>` : '';
      const why = e.why ? esc(e.why) : (e.mechanism ? esc(e.mechanism) : '<span class="dimtext">Reason not established in the wire coverage.</span>');
      const whyK = e.why ? 'WHY' : (e.mechanism ? 'WHY IT MATTERS' : 'WHY');
      const mech = e.why && e.mechanism ? ` <span class="dimtext">— ${esc(e.mechanism)}</span>` : '';
      return `<div class="imp">`
        + `<div class="imp-top"><span class="imp-tag">${esc(e.label)}</span>`
        + `${e.novelty === 'new' ? '<span class="imp-badge new">NEW</span>' : '<span class="imp-badge">DEVELOPING</span>'}`
        + `<span class="imp-date">${esc(evDate(e.at || e.date))}</span></div>`
        + `<div class="imp-what">${esc(e.what)}</div>`
        + `<div class="imp-why"><span class="why-k">${whyK}</span>${why}${mech}</div>`
        + `<div class="imp-mkt">${mkt}${mkt && (src || wires) ? '<span class="dimtext">·</span>' : ''}${src}${src && wires ? '<span class="dimtext">·</span>' : ''}${wires}</div>`
        + `</div>`;
    }).join('')}</div>`
    : '';
  const relDay = (d) => {
    if (!d) return '';
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    return new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
  };
  const spark = (arr, up, fill) => (arr && arr.length ? tileSpark(arr, up, fill) : '');
  // The hero: the number and its shape side by side, then the one line that says WHY.
  const heroHtml = h ? `<div class="hero${h.route ? ' link' : ''}"${h.route ? ` data-go="${esc(h.route)}" role="link" tabindex="0"` : ''}>`
    + `<div class="hero-l">${esc(h.tag || '')}${h.flat != null && h.flat >= 10 ? ' · thin quotes' : ''}</div>`
    + `<div class="hero-n">${esc(h.label)}${h.sym && h.sym !== h.label ? `<em>${esc(h.sym)}</em>` : ''}</div>`
    + `<div class="hero-mid"><span class="hero-v ${cls(h.d1)}">${pctf(h.d1)}</span>`
    + (spark(h.spark, h.d1 >= 0, true) ? `<span class="hero-sp">${spark(h.spark, h.d1 >= 0, true)}</span>` : '')
    + `</div>`
    + `<div class="hero-s dimtext">${h.y1 != null ? `${h.y1 >= 0 ? '+' : '−'}${Math.abs(h.y1).toFixed(0)}% over a year` : ''}`
    + `${h.m1 != null ? ` · ${pctf(h.m1)} this month` : ''}${h.sigma ? ` · a normal day is ${h.sigma.toFixed(1)}%` : ''}</div>`
    + (h.why ? `<div class="hero-w"><span class="why-k">WHY</span><a href="${esc(h.why.url)}" target="_blank" rel="noopener noreferrer">${esc(h.why.title)}</a> <span class="dimtext">— ${esc(h.why.source)}</span></div>` : '')
    + ((h.facts || []).length ? `<div class="hero-f">${esc(h.facts.slice(0, 2).join(' · '))}</div>` : '')
    + `</div>` : '';
  // One line under a row: either the computed contract-roll note or the wire story that fits.
  const whyLine = (x) => {
    if (x.roll) {
      const r = x.roll;
      const full = `Front month expires ${r.when}. The curve is $${r.spread.toFixed(2)} backwardated (front above next), so about ${Math.abs(r.pct).toFixed(1)}% of this ${pctf(x.d1)} move is the contract rolling, not a selloff.`;
      return `<span class="mvr-why roll" title="${esc(full)}">Roll, not a selloff — ${Math.abs(r.pct).toFixed(1)}% of this move is the expiring contract.</span>`;
    }
    if (x.why) {
      const tag = x.why.scope === 'regional' ? 'REGIONAL' : x.why.scope === 'global' ? 'GLOBAL'
        : x.why.scope === 'commodity' ? 'COMMODITY' : '';
      return `<span class="mvr-why" title="${esc(x.why.title + ' — ' + (x.why.source || '') + (x.why.via ? ' (' + x.why.via + ')' : ''))}">`
        + `${tag ? `<b class="why-scope">${tag}</b> ` : ''}<a href="${esc(x.why.url)}" target="_blank" rel="noopener noreferrer">${esc(x.why.title)}</a> <span class="dimtext">— ${esc(x.why.source)}</span></span>`;
    }
    // No wire story that day. Say it is context, not a cause, so a bare number never reads as a reason.
    if ((x.facts || []).length) return `<span class="mvr-why context" title="${esc(x.facts.join(' · '))}">CONTEXT — ${esc(x.facts.join(' · '))}</span>`;
    return '<span class="mvr-why context">No wire reason found.</span>';
  };
  // Everything else, one grammar. The hero's own row is skipped so nothing is said twice.
  // The server ranked these already (one leaderboard for commodities and countries). Do NOT re-sort:
  // WHAT HAPPENED is simply the next five on the same board.
  const rest = b.rows || [];
  const rows = rest.slice(0, 7).map((x) => x.kind === 'deal'
    ? `<div class="mvr deal">`
      + `<span class="mvr-tag">M&A</span>`
      + `<span class="mvr-n deal-name" title="${esc(x.label)}">`
      + (x.acquirer ? `<b>${esc(x.acquirer)}</b>` : '')
      + (x.acquirer && x.target ? '<i class="deal-arrow">→</i>' : '')
      + (x.target ? `<b>${esc(x.target)}</b>` : '')
      + `</span>`
      + `<span class="mvr-v deal-v">${dealVal(x.value)}</span><span class="mvr-sp">${chipFor(x)}</span>`
      + `<span class="mvr-why">announced ${dealDateY(x.date)}${x.closed ? ' · closed ' + dealDateY(x.closed) : ''}</span></div>`
    : `<div class="mvr${x.flat != null && x.flat >= 10 ? ' thin' : ''}">`
      + `<span class="mvr-tag">${esc(x.tag)}</span><span class="mvr-n" title="${esc(x.label)}">${esc(x.label)}</span>`
      + `<span class="mvr-v ${cls(x.d1)}">${pctf(x.d1)}</span><span class="mvr-sp">${spark(x.spark, x.d1 >= 0)}</span>`
      + whyLine(x) + `</div>`).join('')
    || '<div class="mvr"><span class="mvr-tag"></span><span class="mvr-n dimtext">Nothing moved enough to flag today.</span><span></span><span></span></div>';
  const nextRows = (b.next || []).slice(0, 4).map((e) => `<div class="mvr">`
    + `<span class="mvr-tag">${esc(relDay(e.date))}</span><span class="mvr-n">${esc(e.name)}</span>`
    + `<span class="mvr-v dimtext" style="font-weight:400">${esc(e.time || '')}</span><span class="mvr-sp"></span></div>`).join('')
    || '<div class="mvr"><span class="mvr-tag"></span><span class="mvr-n dimtext">Nothing scheduled.</span><span></span><span></span></div>';
  const ctx = (b.happened || []).filter((x) => x.kind !== 'move').map((x) => x.text).join(' · ');
  el.innerHTML = impHtml + heroHtml
    + `<div class="brief-cols"><div class="brief-col"><div class="gtitle">WHAT HAPPENED</div>${rows}</div>`
    + `<div class="brief-col"><div class="gtitle">WHAT'S NEXT</div>${nextRows}</div></div>`
    + (ctx ? `<div class="brief-ctx dimtext">${ctx}</div>` : '');
}
async function loadBrief() {
  const el = $('home-brief');
  if (el && !el.innerHTML) el.innerHTML = stLoading('Reading the day…');
  try { renderBrief(await getJSON('/api/brief')); } catch { renderBrief(null); }
  markReady('brief');
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
// Column count from the number of tiles, not from a fixed 4: eight tiles -> 4 across (two clean
// rows), nine -> 3 across (three clean rows), ten -> 5 across. If n has no tidy divisor we still use
// the squarest count and let the last tile stretch to fill the row, so a row is never half empty.
function gridCols(n) {
  if (n <= 1) return 1;
  const start = Math.max(2, Math.ceil(Math.sqrt(n)));
  for (let c = start; c <= Math.min(6, n); c++) if (n % c === 0) return c;
  return Math.min(6, Math.max(2, Math.ceil(n / Math.ceil(n / start))));
}
function renderRegime(d) {
  const el = $('regime-board'); if (!el) return;
  const rows = (d && d.rows) || [];
  if (!rows.length) { el.innerHTML = stError('Couldn’t load the markets board — retrying.'); return; }
  const cols = gridCols(rows.length);
  el.style.setProperty('--rb-cols', cols);
  const addFill = (html, i) => {
    const short = rows.length % cols;                       // tiles short on the final row
    const fill = short && i >= rows.length - short ? cols - (rows.length % cols) + 1 : 0;
    return fill > 1 ? html.replace('<div class="rb-cell"', `<div class="rb-cell" style="grid-column: span ${fill}"`) : html;
  };
  el.innerHTML = rows.map((r, i) => addFill((() => {
    const src = `${r.source}${r.asOf ? ` · ${r.asOf}` : ''}`;
    if (r.price == null) return `<div class="rb-cell"><div class="rb-l" title="${r.label}">${r.label}</div><div class="rb-v">—</div><div class="rb-src">${src}</div></div>`;
    const strip = r.rate ? deltaStripRate(r.deltas) : deltaStrip(r.deltas);
    const dv = r.deltas ? r.deltas.d1 : null;
    return `<div class="rb-cell" title="${r.label} · ${src}"><div class="rb-l">${r.label}</div>`
      + `<div class="rb-v ${cls(dv)}">${fmtNum(r.price, r.dp)}${r.unit ? `<span class="rb-u">${r.unit}</span>` : ''}</div>${strip}`
      + `<div class="rb-src">${src}</div></div>`;
  })(), i)).join('');
}
// Screener — every instrument in one sortable table (assembled server-side at /api/screen).
let screenRows = null, screenSort = { key: 'absd1', dir: -1 }, fxBase = 'USD', fxRows = null;
let fxWin = null;  // currency moves for the screener's "returns in" base, so a yen return can be a dollar return
// The home screener covers two universes: instruments and companies.
let screenMode = (() => { try { return localStorage.getItem('oilbasis.screenMode') === 'companies' ? 'companies' : 'commodities'; } catch { return 'commodities'; } })();
let coScreen = { sort: 'marketCap', dir: -1, q: '', sector: 'all', page: 1, per: 50 };
let screenSegs = [];                  // the segment list from /api/screen
let screenSeg = 'all';                // segment filter
let screenPicks = null;               // Set of instrument ids to show; null = show every one
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
  screenSegs = (d && d.segments) || [];
  markReady('screen');
  renderScreen(true);   // full: filter bar + table
}
// Filters — narrow the board by segment, and/or tick exactly which instruments to show.
function screenSegOptions() {
  if (screenSegs.length) return screenSegs;
  const seen = new Map();
  for (const r of screenRows) if (!seen.has(r.seg)) seen.set(r.seg, r.segLabel || r.seg);
  return [...seen].map(([id, label]) => ({ id, label }));
}
const screenVisible = () => screenRows.filter((r) => (screenSeg === 'all' || r.seg === screenSeg) && (screenPicks === null || screenPicks.has(r.id)));
function persistScreenFilter() {
  saveStr('scSeg', screenSeg);
  saveStr('scPicks', screenPicks === null ? 'all' : JSON.stringify([...screenPicks]));
}
// Re-paint the bar's own controls (without replacing it, so an open pick-list stays open).
function syncScreenBar() {
  const s = $('sc-seg'); if (s) s.value = screenSeg;
  document.querySelectorAll('#sc-pick-list input[data-id]').forEach((cb) => { cb.checked = screenPicks === null || screenPicks.has(cb.dataset.id); });
}
function screenModeHtml() {
  return `<div class="sc-modes"><button type="button" class="${screenMode === 'commodities' ? 'on' : ''}" data-screen-mode="commodities">COMMODITIES</button><button type="button" class="${screenMode === 'companies' ? 'on' : ''}" data-screen-mode="companies">COMPANIES</button></div>`;
}

function scBarHtml() {
  const groups = [];
  for (const r of screenRows) {
    let g = groups.find((x) => x.seg === r.seg);
    if (!g) { g = { seg: r.seg, label: r.segLabel || r.seg || 'Other', items: [] }; groups.push(g); }
    g.items.push(r);
  }
  return `<label class="sc-f">SEGMENT <select id="sc-seg" aria-label="Filter the screener by segment"><option value="all">All segments</option>`
    + screenSegOptions().map((s) => `<option value="${s.id}"${screenSeg === s.id ? ' selected' : ''}>${s.label}</option>`).join('')
    + `</select></label>`
    + `<details class="sc-pick"><summary>INSTRUMENTS</summary><div class="sc-pick-body">`
    + `<div class="sc-pick-actions"><button type="button" data-sc-act="all">ALL</button><button type="button" data-sc-act="none">NONE</button><button type="button" data-sc-act="seg">THIS SEGMENT</button></div>`
    + `<div id="sc-pick-list">` + groups.map((g) => `<div class="sc-pick-seg">${String(g.label).toUpperCase()}</div>`
      + g.items.map((r) => `<label><input type="checkbox" data-id="${r.id}"${screenPicks === null || screenPicks.has(r.id) ? ' checked' : ''}> ${r.label}</label>`).join('')).join('')
    + `</div></div></details>`
    + `<button type="button" class="ghost" data-sc-act="reset">RESET</button>`
    + `<span class="sc-count dimtext" id="sc-count"></span>`;
}
let usView = (() => {
  try {
    const v = localStorage.getItem('oilbasis.usView');
    // The old fourth tab is a preset inside THEMES now — move anyone who had it open to that.
    if (v === 'mag7') {
      localStorage.setItem('oilbasis.usView', 'themes');
      localStorage.setItem('oilbasis.usTheme', 'mag7');
      return 'themes';
    }
    return v || 'market';
  } catch { return 'market'; }
})();
const MAG7 = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA'];
// The view tabs live in ONE fixed strip under the market tabs, not inside every view's body. Two
// identical-looking tab rows in different places is what made "press US, then find Screener" a
// mis-tap into Japan.
// The SAME three tabs in every region, so the row never shifts when you change market — and no label
// shares a stem with the row's own "SHOW" heading (OVERVIEW next to VIEW read as the same word).
// MAG 7 is a curated list, so it is a preset inside THEMES rather than a fourth tab.
const CO_VIEWS = {
  us: [['usview', 'market', 'MARKET'], ['usview', 'screener', 'SCREENER'], ['usview', 'themes', 'THEMES']],
  jp: [['jpview', 'market', 'MARKET'], ['jpview', 'screener', 'SCREENER'], ['jpview', 'themes', 'THEMES']],
  kr: [['krview', 'market', 'MARKET'], ['krview', 'screener', 'SCREENER'], ['krview', 'themes', 'THEMES']],
};
function paintCoViews() {
  const bar = $('co-views');
  if (!bar) return;
  const active = coRegion === 'jp' ? jpView : coRegion === 'kr' ? krView : usView;
  bar.innerHTML = (CO_VIEWS[coRegion] || CO_VIEWS.us)
    .map(([attr, key, label]) => `<button type="button" data-${attr}="${key}" class="${active === key ? 'on' : ''}">${label}</button>`)
    .join('');
}
const usViewsBar = () => '';

let screenMarket = (() => { try { return localStorage.getItem('oilbasis.screenMarket') || 'us'; } catch { return 'us'; } })();
const coScreenJp = { q: '', sector: 'all', sort: 'marketCap', dir: -1, page: 1, per: 50 };
const coScreenKr = { q: '', sector: 'all', sort: 'marketCap', dir: -1, page: 1, per: 50 };
// A 1,500-row page is a wall of scroll. Paging keeps one screenful at a time and the whole list one
// click away — no infinite scroll, nothing hidden.
const pagerHtml = (total, page, per, attr) => {
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, page), pages);
  const from = total ? (p - 1) * per + 1 : 0;
  const to = Math.min(total, p * per);
  return `<div class="sc-pager"><span class="dimtext">${from}–${to} of ${total}</span>`
    + `<button type="button" class="co-tgl" data-${attr}="${p - 1}" ${p <= 1 ? 'disabled' : ''}>‹ PREV</button>`
    + `<span class="dimtext">PAGE ${p} OF ${pages}</span>`
    + `<button type="button" class="co-tgl" data-${attr}="${p + 1}" ${p >= pages ? 'disabled' : ''}>NEXT ›</button>`
    + `<select data-${attr}per="1" aria-label="Rows per page">${[25, 50, 100, 250].map((n) => `<option value="${n}"${n === per ? ' selected' : ''}>${n} / page</option>`).join('')}</select></div>`;
};
const JP_SCREEN_COLS = [
  { k: 'label', t: 'COMPANY' }, { k: 'price', t: 'PRICE' }, { k: 'chg1d', t: '1D' },
  { k: 'chg6m', t: '6M' }, { k: 'chgYtd', t: 'YTD' }, { k: 'pe', t: 'P/E' },
  { k: 'pb', t: 'P/B' }, { k: 'roe', t: 'ROE' }, { k: 'marketCap', t: 'MKT CAP' },
];
const screenMarketHtml = () => `<div class="sc-modes sc-mkt">${[['us', 'US'], ['jp', 'JAPAN'], ['kr', 'KOREA']].map(([k, t]) => `<button type="button" class="${screenMarket === k ? 'on' : ''}" data-screen-market="${k}">${t}</button>`).join('')}</div>`;

// A company's return in the screener's chosen base currency. A Tokyo listing returns yen; a dollar
// investor gets that return *plus* the yen's own move, so the two are compounded rather than added.
// Falls back to the local number only when no FX move is known, and the note under the table says so.
const CUR_OF_MARKET = { us: 'USD', jp: 'JPY', kr: 'KRW' };
// The date the prices belong to — the modal session across the table, so a stale feed is visible
// rather than implied.
function sessionOf(list, field) {
  const tally = {};
  for (const c of list) { const d = c[field]; if (d) tally[d] = (tally[d] || 0) + 1; }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}
const asOfText = (list, field) => { const d = sessionOf(list, field); return d ? `prices as of ${dealDateY(d)}` : ''; };
function fxRet(v, cur, win) {
  if (v == null) return null;
  if (!fxWin || !fxWin.windows) return v;
  if (fxWin.base === cur) return v;
  const w = fxWin.windows[win] ? fxWin.windows[win][cur] : null;
  if (w == null) return v;
  return +(((1 + v / 100) / (1 + w / 100) - 1) * 100).toFixed(1);
}
function fxNote(cur) {
  if (fxBase === cur) return '';
  if (!fxWin || !fxWin.windows) return 'Returns are in local currency — the FX history for this base is unavailable right now. ';
  return `Returns converted to <b>${esc(fxBase)}</b>: the local move compounded with the ${esc(cur)} move over the same window, at ECB reference rates. `;
}
async function loadFxWin(base) {
  // Even on a USD base the yen and won moves are needed — that is the whole point.
  try { fxWin = await jget('/api/fxwindows?base=' + encodeURIComponent(base || 'USD'), 3600000); } catch { fxWin = null; }
}

const CO_SCREEN_COLS = [
  { k: 'label', t: 'COMPANY' }, { k: 'price', t: 'PRICE' }, { k: 'chg1d', t: '1D' },
  { k: 'chg6m', t: '6M' }, { k: 'chgYtd', t: 'YTD' }, { k: 'pe', t: 'P/E' },
  { k: 'fcfYield', t: 'FCF YLD' }, { k: 'revenueCagr', t: 'REV CAGR' }, { k: 'roic', t: 'ROIC' },
  { k: 'marketCap', t: 'MKT CAP' },
];
function renderCompanyScreen(el) {
  if (!fxWin) { loadFxWin(fxBase).then(() => renderScreen(true)).catch(() => {}); }
  if (screenMarket === 'jp') return renderJapanScreen(el);
  if (screenMarket === 'kr') return renderKoreaScreen(el);
  // The companies payload is normally fetched when the COMPANIES tab opens; the home screener can ask
  // for it first, so load it here and re-render when it lands.
  if (!companiesData) {
    el.innerHTML = stLoading('Reading the filings…');
    getJSON('/api/companies').then((d) => { companiesData = d; renderScreen(true); }).catch(() => {});
    return;
  }
  // A ticker with no SEC filing has nothing to show: no statements, no quarters, no chart of substance.
  const all = (companiesData?.companies || []).filter((c) => !c.shareClass && c.ticker && !c.noFilings);
  if (!all.length) { el.innerHTML = stError('Couldn’t load companies — retrying.'); return; }
  const sectors = [...new Set(all.map((c) => c.sector).filter(Boolean))].sort();
  const q = coScreen.q.trim().toLowerCase();
  let rows = all.filter((c) => (coScreen.sector === 'all' || c.sector === coScreen.sector)
    && (!q || `${c.name} ${c.ticker} ${c.industry || ''} ${(c.brands || []).join(' ')}`.toLowerCase().includes(q)));
  const { sort, dir } = coScreen;
  rows = [...rows].sort((a, b) => {
    const x = sort === 'label' ? (a.name || '') : a[sort];
    const y = sort === 'label' ? (b.name || '') : b[sort];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return sort === 'label' ? x.localeCompare(y) * dir : (x - y) * dir;
  });
  const head = CO_SCREEN_COLS.map((c) => `<th class="${sort === c.k ? 'on' : ''}" data-cokey="${c.k}">${c.t}${sort === c.k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  const cell = (v, dp = 1, suffix = '') => (v == null ? '<td class="num">—</td>' : `<td class="num">${v.toFixed(dp)}${suffix}</td>`);
  const pct = (v) => (v == null ? '<td class="num">—</td>' : `<td class="num ${cls(v)}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</td>`);
  const usPer = coScreen.per || 50;
  const usPage = coScreen.page || 1;
  const usPages = Math.max(1, Math.ceil(rows.length / usPer));
  if (usPage > usPages) coScreen.page = usPages;
  const usShown = rows.slice(((coScreen.page || 1) - 1) * usPer, (coScreen.page || 1) * usPer);
  const body = usShown.map((c) => `<tr data-cocik="${esc(c.cik)}" title="${esc(c.name)}">
      <td class="sc-name">${esc(c.name)}<span class="sc-tick">${esc(c.ticker)}</span></td>
      <td class="num">${c.price != null ? '$' + c.price.toFixed(2) : '—'}</td>
      ${pct(fxRet(c.chg1d, 'USD', 'd1'))}${pct(fxRet(c.chg6m, 'USD', 'm6'))}${pct(fxRet(c.chgYtd, 'USD', 'ytd'))}
      ${cell(c.pe, 1, '×')}${c.fcfYield != null ? cell(c.fcfYield, 1, '%') : '<td class="num">' + (c.fcfNA ? 'n/a' : '—') + '</td>'}
      ${cell(c.revenueCagr, 1, '%')}${cell(c.roic, 1, '%')}
      <td class="num">${coMoney(c.marketCap)}</td></tr>`).join('');
  el.innerHTML = `<div class="sc-bar">${screenModeHtml()}${screenMarketHtml()}
      <label class="sc-f">SEARCH <input id="cos-q" type="search" placeholder="company or ticker…" value="${esc(coScreen.q)}"></label>
      <label class="sc-f">SECTOR <select id="cos-sector"><option value="all">All sectors</option>${sectors.map((x) => `<option value="${esc(x)}"${coScreen.sector === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <span class="sc-count dimtext">${rows.length} of ${all.length} companies</span>
    </div><div class="sc-wrap" id="sc-table"><table class="sc-table sc-cotable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${pagerHtml(rows.length, coScreen.page, coScreen.per, 'copage')}
    <div class="sc-note dimtext">${fxNote('USD')}S&amp;P 500 companies · SEC filings, GAAP as filed · ${asOfText(all, 'priceAsOf') || 'prices from Nasdaq'}. Click a row to open the company.</div>`;
}

// The same screener, on the Japanese market. Yen, its own columns, its own filters — never mixed
// into the dollar table, because a ¥ and a $ in one column would be a lie.
function renderJapanScreen(el) {
  if (!japanData) {
    el.innerHTML = stLoading('Reading the Japanese filings…');
    loadJapan().then(() => renderScreen(true));
    return;
  }
  // A preferred share class is not a separate company; the US list has the same rule.
  const all = (japanData.companies || []).filter((c) => !c.shareClass);
  const sectors = [...new Set(all.map((c) => c.sector).filter(Boolean))].sort();
  const q = coScreenJp.q.trim().toLowerCase();
  const { sort, dir } = coScreenJp;
  const keyOf = (c) => (sort === 'label' ? (c.name || '') : c[sort]);
  let rows = all.filter((c) => (coScreenJp.sector === 'all' || c.sector === coScreenJp.sector)
    && (!q || `${c.name} ${c.nameJa || ''} ${c.ticker} ${c.sector}`.toLowerCase().includes(q)));
  rows = [...rows].sort((a, b) => {
    const x = keyOf(a), y = keyOf(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return sort === 'label' ? x.localeCompare(y) * dir : (x - y) * dir;
  });
  const jpPer = coScreenJp.per || 50;
  const jpPages = Math.max(1, Math.ceil(rows.length / jpPer));
  if ((coScreenJp.page || 1) > jpPages) coScreenJp.page = jpPages;
  const shown = rows.slice(((coScreenJp.page || 1) - 1) * jpPer, (coScreenJp.page || 1) * jpPer);
  const head = JP_SCREEN_COLS.map((c) => `<th class="${sort === c.k ? 'on' : ''}" data-jpkey="${c.k}">${c.t}${sort === c.k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  const pct = (v) => (v == null ? '<td class="num">—</td>' : `<td class="num ${cls(v)}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</td>`);
  const num = (v, dp, suffix = '') => (v == null ? '<td class="num">—</td>' : `<td class="num">${v.toFixed(dp)}${suffix}</td>`);
  const body = shown.map((c) => `<tr data-jpcode="${esc(c.code)}" title="${esc(c.name)}">
      <td class="sc-name">${esc(c.name)}<span class="sc-tick">${esc(c.ticker)} · ${esc(c.sector)}</span></td>
      <td class="num">${yen(c.price)}</td>
      ${pct(fxRet(c.chg1d, 'JPY', 'd1'))}${pct(fxRet(c.chg6m, 'JPY', 'm6'))}${pct(fxRet(c.chgYtd, 'JPY', 'ytd'))}
      ${num(c.pe, 1, '×')}${num(c.pb, 2, '×')}${num(c.roe, 1, '%')}
      <td class="num">${yen(c.marketCap)}</td></tr>`).join('');
  el.innerHTML = `<div class="sc-bar">${screenModeHtml()}${screenMarketHtml()}
      <label class="sc-f">SEARCH <input id="cosj-q" type="search" placeholder="company or ticker…" value="${esc(coScreenJp.q)}"></label>
      <label class="sc-f">SECTOR <select id="cosj-sector"><option value="all">All sectors</option>${sectors.map((x) => `<option value="${esc(x)}"${coScreenJp.sector === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <span class="sc-count dimtext">${rows.length} of ${all.length} companies</span>
    </div><div class="sc-wrap" id="sc-table"><table class="sc-table sc-cotable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${pagerHtml(rows.length, coScreenJp.page, coScreenJp.per, 'jppage')}
    <div class="sc-note dimtext">${fxNote('JPY')}TSE Prime companies · J-Quants (JPX) · ${asOfText(all, 'priceDate') || 'prices in yen'} · P/E and ROE are trailing twelve months. Click a row to open the company.</div>`;
}

// Korea in the home screener, the same shape as Japan's.
const KR_SCREEN_COLS = [
  { k: 'label', t: 'COMPANY' }, { k: 'price', t: 'PRICE' }, { k: 'chg1d', t: '1D' },
  { k: 'chg6m', t: '6M' }, { k: 'chgYtd', t: 'YTD' }, { k: 'pe', t: 'P/E' },
  { k: 'pb', t: 'P/B' }, { k: 'roe', t: 'ROE' }, { k: 'marketCap', t: 'MKT CAP' },
];
function renderKoreaScreen(el) {
  if (!koreaData) {
    el.innerHTML = stLoading('Reading the Korean filings…');
    loadKorea().then(() => renderScreen(true));
    return;
  }
  const all = koreaData.companies || [];
  const sectors = [...new Set(all.map((c) => c.sector).filter(Boolean))].sort();
  const q = coScreenKr.q.trim().toLowerCase();
  const { sort, dir } = coScreenKr;
  const keyOf = (c) => (sort === 'label' ? (c.nameEn || c.name || '') : c[sort]);
  let rows = all.filter((c) => (coScreenKr.sector === 'all' || c.sector === coScreenKr.sector)
    && (!q || `${c.name} ${c.nameEn || ''} ${c.ticker} ${c.sector || ''} ${(c.brands || []).join(' ')}`.toLowerCase().includes(q)));
  rows = [...rows].sort((a, b) => {
    const x = keyOf(a), y = keyOf(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return sort === 'label' ? x.localeCompare(y) * dir : (x - y) * dir;
  });
  const per = coScreenKr.per || 50;
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const page = Math.min(coScreenKr.page || 1, pages);
  const shown = rows.slice((page - 1) * per, page * per);
  const head = KR_SCREEN_COLS.map((c) => `<th class="${sort === c.k ? 'on' : ''}" data-krkey="${c.k}">${c.t}${sort === c.k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  const pct = (v) => (v == null ? '<td class="num">—</td>' : `<td class="num ${cls(v)}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</td>`);
  const num = (v, dp, suffix = '') => (v == null ? '<td class="num">—</td>' : `<td class="num">${v.toFixed(dp)}${suffix}</td>`);
  const body = shown.map((c) => `<tr data-krrow="${esc(c.code)}" title="${esc(c.nameEn || c.name)}">
      <td class="sc-name">${esc(c.nameEn || c.name)}<span class="sc-tick">${esc(c.ticker)}${c.sector ? ' · ' + esc(c.sector) : ''}</span></td>
      <td class="num">${wonPx(c.price)}</td>
      ${pct(fxRet(c.chg1d, 'KRW', 'd1'))}${pct(fxRet(c.chg6m, 'KRW', 'm6'))}${pct(fxRet(c.chgYtd, 'KRW', 'ytd'))}
      ${num(c.pe, 1, '×')}${num(c.pb, 2, '×')}${num(c.roe, 1, '%')}
      <td class="num">${won(c.marketCap)}</td></tr>`).join('');
  el.innerHTML = `<div class="sc-bar">${screenModeHtml()}${screenMarketHtml()}
      <label class="sc-f">SEARCH <input id="cosk-q" type="search" placeholder="company or code…" value="${esc(coScreenKr.q)}"></label>
      <label class="sc-f">SECTOR <select id="cosk-sector"><option value="all">All sectors</option>${sectors.map((x) => `<option value="${esc(x)}"${coScreenKr.sector === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <span class="sc-count dimtext">${rows.length} of ${all.length} companies</span>
    </div><div class="sc-wrap" id="sc-table"><table class="sc-table sc-cotable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${pagerHtml(rows.length, page, per, 'krpage')}
    <div class="sc-note dimtext">${fxNote('KRW')}KOSPI companies · DART statements · ${asOfText(all, 'priceDate') || 'Naver prices'} · P/E is trailing twelve months.</div>`;
}

function renderScreen(full) {
  const el = $('screen'); if (!el) return;
  // The currency control applies to the company tables too: their returns are converted, not relabelled.
  const curCtl = document.querySelector('#p-screen .controls');
  if (curCtl) curCtl.classList.remove('hidden');
  if (screenMode === 'companies') return renderCompanyScreen(el);
  if (!screenRows || !screenRows.length) { el.innerHTML = stError('Couldn’t load the screener — retrying.'); return; }
  if (full || !$('sc-table')) {
    el.innerHTML = '<div class="sc-bar">' + screenModeHtml() + scBarHtml() + '</div><div class="sc-wrap" id="sc-table"></div><div class="sc-note dimtext" id="sc-note"></div>';
  }
  const rows = screenVisible();
  const { key, dir } = screenSort;
  const sorted = [...rows].sort((a, b) => {
    const x = screenVal(a, key), y = screenVal(b, key);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return key === 'label' ? x.localeCompare(y) * dir : (x - y) * dir;
  });
  const head = SCREEN_COLS.map((c) => `<th class="${key === c.k ? 'on' : ''}" data-k="${c.k}">${c.t}${key === c.k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');
  const pcell = (v) => (v == null ? '<td class="num">—</td>' : `<td class="num ${cls(v)}">${pctf(v)}</td>`);
  const body = sorted.map((r) => {
    const d = effDeltas(r);
    const flagCls = r.posFlag === 'CROWDED LONG' || r.posFlag === 'CROWDED SHORT' ? 'hot' : r.posFlag === 'STRETCHED LONG' ? 'warm' : r.posFlag === 'WASHED-OUT' ? 'cool' : '';
    const crowd = r.posPct == null ? '<td class="num">—</td>' : `<td class="num"><span class="sc-flag ${flagCls}" title="${r.posFlag || ''}">${r.posPct}</span></td>`;
    const s = (v) => `<td class="num">${v == null ? '—' : v}</td>`;
    return `<tr data-id="${r.id}" title="${r.label} · ${r.source || ''} ${r.asOf || ''}">`
      + `<td class="sc-name">${r.label}</td><td class="num">${fmtNum(r.price, r.dp)}</td>`
      + pcell(d.d1) + pcell(d.w1) + pcell(d.m1) + pcell(d.ytd) + pcell(d.y1)
      + s(r.stretch) + s(r.tight) + s(r.basisPct) + crowd + '</tr>';
  }).join('');
  $('sc-table').innerHTML = body
    ? `<table class="sc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '<div class="sc-empty dimtext">Nothing matches this filter — pick a different segment, tick more instruments, or hit RESET.</div>';
  const cnt = $('sc-count'); if (cnt) cnt.textContent = `${rows.length} of ${screenRows.length} shown`;
  $('sc-note').innerHTML = (rows.length !== screenRows.length ? `Filtered to <b>${rows.length}</b> of ${screenRows.length} instruments. ` : '')
    + (fxBase !== 'USD' ? `Returns converted to <b>${fxBase}</b> (USD move + the currency's own move). ` : '')
    + 'Click a header to sort; click a row to open its chart. STRETCH is −100 (cheap)…+100 (rich) · TIGHT is 0 (oversupplied)…100 (undersupplied) · BASIS% and CROWD are percentiles.';
}
$('base-cur')?.addEventListener('change', async (e) => {
  fxBase = e.target.value || 'USD';
  fxRows = null;
  await Promise.all([
    loadFxWin(fxBase),
    (async () => {
      if (fxBase === 'USD') return;
      try {
        const d = await jget('/api/fxadjusted?base=' + encodeURIComponent(fxBase), 3600000);
        fxRows = Object.fromEntries(((d && d.rows) || []).map((r) => [r.id, r.deltas]));
      } catch { fxRows = null; }
    })(),
  ]);
  renderScreen(true);
});
$('screen')?.addEventListener('click', (e) => {
  const mode = e.target.closest('[data-screen-mode]');
  if (mode) {
    screenMode = mode.dataset.screenMode;
    try { localStorage.setItem('oilbasis.screenMode', screenMode); } catch {}
    renderScreen(true);
    return;
  }
  const jpp = e.target.closest('[data-jppage]');
  if (jpp && jpp.dataset.jppage !== 'per') { coScreenJp.page = Math.max(1, Number(jpp.dataset.jppage)); renderScreen(true); return; }
  const usp = e.target.closest('[data-copage]');
  if (usp && usp.dataset.copage !== 'per') { coScreen.page = Math.max(1, Number(usp.dataset.copage)); renderScreen(true); return; }
  const mkt = e.target.closest('[data-screen-market]');
  if (mkt) {
    screenMarket = mkt.dataset.screenMarket;
    try { localStorage.setItem('oilbasis.screenMarket', screenMarket); } catch {}
    const cur = document.querySelector('#p-screen .controls');
    if (cur) cur.classList.toggle('hidden', screenMarket === 'jp');
    renderScreen(true);
    return;
  }
  const krp2 = e.target.closest('[data-krpage]');
  if (krp2 && krp2.dataset.krpage !== 'per') { coScreenKr.page = Math.max(1, Number(krp2.dataset.krpage)); renderScreen(true); return; }
  const krkey = e.target.closest('th[data-krkey]');
  if (krkey) {
    const k = krkey.dataset.krkey;
    coScreenKr.dir = coScreenKr.sort === k ? -coScreenKr.dir : (k === 'label' ? 1 : -1);
    coScreenKr.sort = k;
    coScreenKr.page = 1;
    renderScreen(true);
    return;
  }
  const jpkey = e.target.closest('th[data-jpkey]');
  if (jpkey) {
    const k = jpkey.dataset.jpkey;
    coScreenJp.dir = coScreenJp.sort === k ? -coScreenJp.dir : (k === 'label' ? 1 : -1);
    coScreenJp.sort = k;
    coScreenJp.page = 1;
    renderScreen(true);
    return;
  }
  const cokey = e.target.closest('th[data-cokey]');
  if (cokey) {
    const k = cokey.dataset.cokey;
    coScreen = { ...coScreen, sort: k, dir: coScreen.sort === k ? -coScreen.dir : (k === 'label' ? 1 : -1) };
    renderScreen(true);
    return;
  }
  const corow = e.target.closest('tr[data-cocik]');
  if (corow) {
    coCik = corow.dataset.cocik;
    document.querySelector('[data-tab="deals"]')?.click();
    renderCompanies();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const act = e.target.closest('[data-sc-act]');
  if (act) {
    const a = act.dataset.scAct;
    if (a === 'reset') { screenSeg = 'all'; screenPicks = null; }
    else if (a === 'all') screenPicks = null;
    else if (a === 'none') screenPicks = new Set();
    else if (a === 'seg') screenPicks = new Set(screenRows.filter((r) => screenSeg === 'all' || r.seg === screenSeg).map((r) => r.id));
    persistScreenFilter(); syncScreenBar(); renderScreen(false); return;
  }
  const th = e.target.closest('th[data-k]');
  if (th) { const k = th.dataset.k; screenSort = { key: k, dir: screenSort.key === k ? -screenSort.dir : (k === 'label' ? 1 : -1) }; renderScreen(false); return; }
  const krrow2 = e.target.closest('tr[data-krrow]');
  if (krrow2) {
    coRegion = 'kr'; try { localStorage.setItem('oilbasis.coRegion', 'kr'); } catch {}
    krSel = krrow2.dataset.krrow;
    document.querySelector('[data-tab="deals"]')?.click();
    renderKorea();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const tr = e.target.closest('tr[data-id]');
  if (tr) goToInstrument(tr.dataset.id);
});
// The bar's own controls: the segment select and the instrument checkboxes.
$('screen')?.addEventListener('input', (e) => {
  if (e.target.id === 'cos-q') { coScreen = { ...coScreen, q: e.target.value || '', page: 1 }; renderScreen(true); }
  if (e.target.id === 'cosj-q') { coScreenJp.q = e.target.value || ''; coScreenJp.page = 1; renderScreen(true); }
  if (e.target.id === 'cosk-q') { coScreenKr.q = e.target.value || ''; coScreenKr.page = 1; renderScreen(true); }
});
$('screen')?.addEventListener('change', (e) => {
  if (e.target.id === 'cos-sector') { coScreen = { ...coScreen, sector: e.target.value, page: 1 }; renderScreen(true); return; }
  if (e.target.id === 'cosj-sector') { coScreenJp.sector = e.target.value; coScreenJp.page = 1; renderScreen(true); return; }
  if (e.target.id === 'cosk-sector') { coScreenKr.sector = e.target.value; coScreenKr.page = 1; renderScreen(true); return; }
  if (e.target.dataset && e.target.dataset.jppageper) { coScreenJp.per = Number(e.target.value); coScreenJp.page = 1; renderScreen(true); return; }
  if (e.target.dataset && e.target.dataset.krpageper) { coScreenKr.per = Number(e.target.value); coScreenKr.page = 1; renderScreen(true); return; }
  if (e.target.dataset && e.target.dataset.copageper) { coScreen.per = Number(e.target.value); coScreen.page = 1; renderScreen(true); return; }
  const t = e.target;
  if (t.id === 'sc-seg') { screenSeg = t.value; persistScreenFilter(); renderScreen(false); return; }
  if (t.matches && t.matches('#sc-pick-list input[data-id]')) {
    if (screenPicks === null) screenPicks = new Set(screenRows.map((r) => r.id));
    if (t.checked) screenPicks.add(t.dataset.id); else screenPicks.delete(t.dataset.id);
    if (screenPicks.size === screenRows.length) screenPicks = null;   // everything ticked = no filter at all
    persistScreenFilter(); syncScreenBar(); renderScreen(false);
  }
});
// Economic calendar — a real month grid. Dated events sit on their day; undated ones are listed below.
const CAL_DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
let calEvents = null, calMonth = null, calSel = null, calFomc = null;
let calCompany = [];
// Which market the companies tab is showing: the S&P 500 or TSE Prime.
let coRegion = (() => { try { return localStorage.getItem('oilbasis.coRegion') || 'us'; } catch { return 'us'; } })();
// Two views, not four: the macro calendar and company events. Anything else is a filter inside those.
let calMode = (() => {
  try {
    const v = localStorage.getItem('oilbasis.calMode');
    if (v === 'companies' || v === 'macro') return v;
    return 'macro';   // the old watch/top/all modes collapse into companies
  } catch { return 'macro'; }
})();
async function loadCalendar() {
  const el = $('calendar'); if (!el) return;
  if (!el.innerHTML) el.innerHTML = stLoading('Loading the calendar…');
  let d = null; try { d = await jget('/api/calendar', 1800000); } catch { d = null; }
  calEvents = (d && d.events) || null;
  calCompany = (d && d.companies) || [];
  calFomc = d && d.fomc;
  markReady('calendar');
  renderCalendar();
}
// The month grid, plus the events of ONE selected day underneath (today by default). The full month is
// never listed out — click a day to read that day. High-impact releases only, so the cells stay legible.
function renderCalendar() {
  const el = $('calendar'); if (!el) return;
  const sub = $('cal-sub');
  if (sub) sub.textContent = calMode === 'companies'
    ? 'earnings and filings · click a day for its events'
    : 'every macro country · high-impact releases · click a day for its events';
  if (!calEvents) { el.innerHTML = stError('Couldn\u2019t load the calendar — retrying.'); return; }
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = iso(new Date());
  if (!calMonth) { const d = new Date(today + 'T00:00:00Z'); calMonth = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; }
  const byDate = {};
  // The two tabs are exclusive: MACRO shows economic releases, COMPANIES shows earnings and filings.
  const wantMacro = calMode !== 'companies';
  const wantCompanies = calMode === 'companies';
  if (wantMacro) {
    for (const e of calEvents) {
      if (!e.date || (e.cc && !(e.importance >= 1))) continue;   // structural, or a high-impact release
      (byDate[e.date] = byDate[e.date] || []).push(e);
    }
  }
  if (wantCompanies && calCompany.length) {
    for (const e of calCompany) {
      if (!e.date) continue;
      (byDate[e.date] = byDate[e.date] || []).push({ ...e, company: true });
    }
  }
  for (const k of Object.keys(byDate)) byDate[k].sort((x, y) => (x.time || '').localeCompare(y.time || ''));
  const { y, m } = calMonth;
  const mk = `${y}-${String(m + 1).padStart(2, '0')}`;
  if (!calSel || calSel.slice(0, 7) !== mk) calSel = (today.slice(0, 7) === mk ? today : `${mk}-01`);
  const startDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;   // Monday-first
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let day = 1; day <= dim; day++) { const k = `${mk}-${String(day).padStart(2, '0')}`; cells.push({ day, k, ev: byDate[k] || [] }); }
  while (cells.length % 7) cells.push(null);
  const CAL_MAX = 2;
  const tipOf = (e) => esc(`${e.cc ? e.cc + ' · ' : ''}${e.name}${e.time ? ' · ' + e.time : ''}${e.note ? ' · ' + e.note : ''}`);
  const grid = cells.map((c) => {
    if (!c) return '<div class="cal-day pad"></div>';
    const shown = c.ev.slice(0, CAL_MAX), more = c.ev.length - shown.length;
    const cos = c.ev.filter((e) => e.company);
    return `<div class="cal-day${c.k === today ? ' today' : ''}${c.ev.length ? ' has' : ''}${c.k === calSel ? ' sel' : ''}" data-date="${c.k}" role="button" tabindex="0" aria-label="${c.k}${c.ev.length ? ' — ' + c.ev.length + ' release' + (c.ev.length > 1 ? 's' : '') : ', nothing scheduled'}">`
      + `<span class="cal-dn">${c.day}</span>`
      + shown.map((e) => `<span class="cal-ev" title="${tipOf(e)}">${e.cc ? `<em class="cal-cc">${esc(e.cc)}</em>` : ''}${esc(e.name)}</span>`).join('')
      + (cos.length ? `<span class="cal-cos" title="${esc(cos.map((e) => e.label).join(' · '))}">${esc(cos.slice(0, 3).map((e) => e.ticker).join(' '))}${cos.length > 3 ? ` +${cos.length - 3}` : ''}</span>` : '')
      + (more > 0 ? `<span class="cal-more">+${more}</span>` : '')
      + '</div>';
  }).join('');
  const selEv = byDate[calSel] || [];
  const d0 = new Date(calSel + 'T00:00:00Z');
  const md = `${MONTH_NAMES[d0.getUTCMonth()].slice(0, 3)} ${d0.getUTCDate()}`;
  const dayLabel = calSel === today ? `TODAY · ${md}` : `${CAL_DOW[(d0.getUTCDay() + 6) % 7].toUpperCase()} · ${md}`;
  const row = (e) => (e.company
    ? `<div class="cal-row cal-crow" ${e.market === 'JP' ? `data-caljp="${esc(e.code || '')}"` : `data-calco="${esc(e.ticker || '')}"`}><span class="cal-date">${esc(e.basis === 'expected' ? 'EST' : 'FILED')}</span><span class="cal-name">${esc(e.label)}</span><span class="cal-src">${esc(e.kind === 'earnings' ? 'company' : e.kind)}</span><span class="cal-note dimtext">${esc(e.detail || '')}</span></div>`
    : `<div class="cal-row"><span class="cal-date">${esc(e.time || '—')}</span><span class="cal-name">${e.cc ? `<em class="cal-cc">${esc(e.cc)}</em>` : ''}${esc(e.name)}</span><span class="cal-src">${esc(e.source || '')}</span>${e.note ? `<span class="cal-note dimtext">${esc(e.note)}</span>` : ''}</div>`);
  const modes = [['macro', 'MACRO'], ['companies', 'COMPANIES']];
  el.innerHTML = `<div class="cal-modes">${modes.map(([k, t]) => `<button type="button" class="${calMode === k ? 'on' : ''}" data-calmode="${k}">${t}</button>`).join('')}</div>`
    + `<div class="cal-head"><div class="cal-nav"><button id="cal-prev" type="button" aria-label="Previous month">‹</button><span class="cal-title">${MONTH_NAMES[m]} ${y}</span><button id="cal-next" type="button" aria-label="Next month">›</button></div><button id="cal-today" class="ghost small" type="button">TODAY</button></div>`
    + `<div class="cal-grid">${CAL_DOW.map((x) => `<div class="cal-dow">${x}</div>`).join('')}${grid}</div>`
    + `<div class="cal-dayh">${dayLabel}</div>`
    + (selEv.length ? selEv.map(row).join('') : `<div class="cal-foot dimtext">Nothing ${calMode === 'companies' ? 'from a company' : 'high-impact'} scheduled on this day.</div>`)
    + (calFomc === 'fallback' ? '<div class="cal-foot dimtext">FOMC dates from the published schedule — the live Federal Reserve feed was unavailable.</div>' : '');
}
const calPick = (k) => { if (k) { calSel = k; renderCalendar(); } };
$('calendar')?.addEventListener('click', (e) => {
  if (!calMonth) return;
  const mode = e.target.closest('[data-calmode]');
  if (mode) { calMode = mode.dataset.calmode; try { localStorage.setItem('oilbasis.calMode', calMode); } catch {} renderCalendar(); return; }
  const cjp = e.target.closest('[data-caljp]');
  if (cjp && cjp.dataset.caljp) {
    coRegion = 'jp'; try { localStorage.setItem('oilbasis.coRegion', 'jp'); } catch {}
    jpSel = cjp.dataset.caljp;
    document.querySelector('[data-tab="deals"]')?.click();
    renderJapan();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const crow = e.target.closest('[data-calco]');
  if (crow && crow.dataset.calco) {
    coCik = null;
    const c = (companiesData?.companies || []).find((x) => x.ticker === crow.dataset.calco);
    if (c) { coCik = c.cik; document.querySelector('[data-tab="deals"]')?.click(); renderCompanies(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    return;
  }
  if (e.target.id === 'cal-prev') { calMonth.m--; if (calMonth.m < 0) { calMonth.m = 11; calMonth.y--; } calSel = null; renderCalendar(); return; }
  if (e.target.id === 'cal-next') { calMonth.m++; if (calMonth.m > 11) { calMonth.m = 0; calMonth.y++; } calSel = null; renderCalendar(); return; }
  if (e.target.id === 'cal-today') { const n = new Date(); calMonth = { y: n.getUTCFullYear(), m: n.getUTCMonth() }; calSel = n.toISOString().slice(0, 10); renderCalendar(); return; }
  const cell = e.target.closest('.cal-day[data-date]');
  if (cell) calPick(cell.dataset.date);
});
$('calendar')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const cell = e.target.closest('.cal-day[data-date]');
  if (cell) { e.preventDefault(); calPick(cell.dataset.date); }
});
// Risk & correlation — a plain read, rows with a baseline, and correlation grouped by decision
// (doubles up / hedges / loose) before the full matrix behind a fold.
let riskData = null, riskFocus = null, riskWin = '3m', riskFoldOpen = false;
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
  const sub = $('risk-sub');
  if (sub) sub.textContent = 'how far off its 1-year high · how jumpy · whether that is normal · what moves together';
  const metrics = (d && d.metrics) || [];
  if (!metrics.length) { el.innerHTML = stError('Couldn’t load risk metrics — retrying.'); return; }

  const arrow = { rising: '↑', falling: '↓', flat: '→' };
  const rows = metrics.map((m) => {
    const now = m.drawdownNow;
    const nowTxt = now == null ? '—' : now === 0 ? 'at its high' : Math.abs(now).toFixed(0) + '% off';
    const barW = now == null ? 0 : Math.min(100, Math.abs(now) / 50 * 100);
    const volTxt = m.vol && m.vol.w30 != null ? Math.round(m.vol.w30) + '%' : '—';
    const ownCls = m.volPct == null ? '' : m.volPct >= 80 ? 'hot' : m.volPct <= 20 ? 'cool' : '';
    return `<div class="rk-row">`
      + `<span class="rk-name">${esc(m.label)}${m.level ? ' <span class="rk-tag" title="A level, not a holding — a fall here is not a loss">LEVEL</span>' : ''}</span>`
      + `<span class="rk-now"><b>${nowTxt}</b><span class="rk-bar" title="Distance below the 1-year high · the bar runs 0–50%"><i style="width:${barW.toFixed(0)}%"></i></span></span>`
      + `<span class="rk-worst">${m.drawdown == null ? '—' : 'worst ' + Math.abs(m.drawdown).toFixed(0) + '%'}</span>`
      + `<span class="rk-vol">${volTxt} <em>${m.volWord || ''}</em> ${arrow[m.volTrend] || ''}</span>`
      + `<span class="rk-own ${ownCls}" title="Today’s 30-day vol against its own past year${m.volPct == null ? '' : ' (percentile ' + m.volPct + ')'}">${m.volVsOwn || '—'}</span>`
      + `</div>`;
  }).join('');

  const keys = (d && d.keys) || [];
  const m1 = (d && d.matrix) || {};
  const m3 = (d && d.matrix3m) || m1;
  const g = (d && d.groups3m) || { together: [], opposite: [], loose: [] };
  const fmt = (v) => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2);
  const pairChip = (p) => {
    const r = p.r, r1 = p.r1;
    const shift = p.shift && p.shift.word !== 'steady' ? `<span class="pair-shift ${p.shift.tone}">${p.shift.word}</span>` : '';
    return `<div class="pair" title="${esc(p.a.label)} ${r > 0 ? 'moves with' : 'moves opposite'} ${esc(p.b.label)} · 3m ${fmt(r)}${r1 == null ? '' : ' · 1y ' + fmt(r1)}">`
      + `<span class="pair-n">${esc(p.a.short || p.a.label)} ↔ ${esc(p.b.short || p.b.label)}</span>`
      + `<span class="pair-r ${r > 0 ? 'pos' : 'neg'}">${fmt(r)}</span>`
      + `<span class="pair-1y">1y ${fmt(r1)}</span>${shift}</div>`;
  };
  const col = (title, note, cls, list, empty) => `<div class="crf-col">`
    + `<div class="crf-col-h ${cls}">${title} <em>${note}</em></div>`
    + (list.length ? list.map(pairChip).join('') : `<div class="crf-empty dimtext">${empty}</div>`)
    + `</div>`;
  const loose = (g.loose || []).length;
  const div = (d && (d.div3m || d.div)) || null;
  const corrBlock = `<div class="crf">`
    + `<div class="crf-head">WHAT MOVES TOGETHER <span class="crf-sub">last 3 months · 1-year in grey</span></div>`
    + `<div class="crf-cols">`
    + col('MOVE TOGETHER', 'same direction', 'pos', g.together || [], 'Nothing moves clearly together right now.')
    + col('MOVE OPPOSITE', 'opposite direction', 'neg', g.opposite || [], 'No clear hedge in this window.')
    + `</div>`
    + `<div class="crf-loose dimtext">${loose} other pair${loose === 1 ? '' : 's'} ${loose === 1 ? 'is' : 'are'} loose (|r| under 0.40)${div && div.label ? ` · most independent: <b>${esc(div.label)}</b> (average link ${div.avg})` : ''}.</div>`
    + `<div class="crf-note dimtext"><b>+1</b> = same direction, <b>−1</b> = opposite, <b>0</b> = unrelated. Pairs at <b>0.40+</b> are listed above; <b>0.50+</b> is a dependable link, 0.40–0.50 moderate. Three months is noisier than a year.</div>`
    + `</div>`;

  const focusLabel = ((keys.find((k) => k.key === riskFocus) || {}).label) || '';
  const picks = keys.map((k) => `<option value="${k.key}"${k.key === riskFocus ? ' selected' : ''}>${esc(k.label)}</option>`).join('');
  const rr3 = (riskFocus && m3[riskFocus]) || {};
  const rr1 = (riskFocus && m1[riskFocus]) || {};
  const frows = keys.filter((k) => k.key !== riskFocus && (rr3[k.key] != null || rr1[k.key] != null))
    .map((k) => ({ ...k, r3: rr3[k.key], r1: rr1[k.key] }))
    .sort((a, b) => Math.abs(b.r3 ?? b.r1 ?? 0) - Math.abs(a.r3 ?? a.r1 ?? 0));
  const fb = frows.map((k) => {
    const r = k.r3 ?? k.r1;
    return `<div class="crf-row">`
      + `<span class="crf-k">${esc(k.label)}</span>`
      + `<span class="crf-bar" title="${esc(focusLabel)} vs ${esc(k.label)} · 3m ${fmt(k.r3)} · 1y ${fmt(k.r1)}"><i class="${r >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(r) * 50).toFixed(0)}%"></i></span>`
      + `<span class="crf-r ${r >= 0 ? 'pos' : 'neg'}">${fmt(r)}</span>`
      + `<span class="crf-1y">1y ${fmt(k.r1)}</span>`
      + `</div>`;
  }).join('');
  const focusBlock = `<div class="crf">`
    + `<div class="crf-head">HOW <select id="risk-focus" aria-label="Focus instrument">${picks}</select> LINKS TO THE OTHERS <span class="crf-sub">3 months · 1-year beside</span></div>`
    + (fb || '<div class="dimtext">No overlapping history for this one.</div>')
    + `</div>`;

  const win = riskWin === '1y' ? '1y' : '3m';
  const mm = win === '1y' ? m1 : m3;
  const short = (k) => k.short || k.label;
  const cell = (v) => {
    if (v == null) return '<td class="na">—</td>';
    const a = Math.min(0.34, Math.abs(v) * 0.36).toFixed(2);
    return `<td class="${v > 0 ? 'pos' : 'neg'}" style="background:${v > 0 ? 'rgba(255,158,0,' : 'rgba(74,163,255,'}${a})">${fmt(v)}</td>`;
  };
  const heat = `<div class="corr-wrap"><table class="corr-tbl"><thead><tr><th></th>${keys.map((k) => `<th>${esc(short(k))}</th>`).join('')}</tr></thead><tbody>`
    + keys.map((a) => `<tr><th>${esc(short(a))}</th>` + keys.map((b) => (a.key === b.key ? '<td class="na">—</td>' : cell(mm[a.key] ? mm[a.key][b.key] : null))).join('') + '</tr>').join('')
    + `</tbody></table></div>`;
  const matrixBlock = `<details class="fold risk-fold"${riskFoldOpen ? ' open' : ''}><summary>▸ FULL CORRELATION MATRIX — ${win === '1y' ? '1 YEAR' : '3 MONTHS'}</summary>`
    + `<div class="note-body"><div class="crf-winrow">`
    + `<button class="crf-win ${win === '3m' ? 'on' : ''}" data-win="3m" aria-pressed="${win === '3m'}">3 MONTHS</button>`
    + `<button class="crf-win ${win === '1y' ? 'on' : ''}" data-win="1y" aria-pressed="${win === '1y'}">1 YEAR</button>`
    + `</div>${heat}<div class="sc-note dimtext">Every pair, over aligned daily returns. The matrix is symmetric — one row is one instrument’s links to the rest. Colour is only a guide; the number is what counts.</div></div></details>`;

  el.innerHTML = (d.read ? `<div class="risk-read">${d.read}</div>` : '')
    + '<div class="rk-head"><span class="rk-name">INSTRUMENT</span><span class="rk-now">OFF 1Y HIGH</span><span class="rk-worst">WORST FALL</span><span class="rk-vol">JUMPY NOW (30D)</span><span class="rk-own">NORMAL FOR IT?</span></div>'
    + rows
    + corrBlock
    + focusBlock
    + matrixBlock
    + '<div class="sc-note dimtext">“Off 1y high” = today versus its own peak over the year; the bar runs 0–50%. “Worst fall” = the biggest peak-to-trough drop in that year. “Jumpy now” = annualised 30-day realised volatility; ↑ rising, ↓ falling. “Normal for it?” compares that vol with its own year, not a fixed threshold. For US 10y and VIX the figures describe the level, not a P&amp;L.</div>';
}
$('risk')?.addEventListener('change', (e) => {
  if (e.target.id !== 'risk-focus') return;
  const det = $('risk')?.querySelector?.('details.risk-fold');
  if (det) riskFoldOpen = !!det.open;
  riskFocus = e.target.value;
  renderRisk(riskData);
});
$('risk')?.addEventListener('click', (e) => {
  const w = e.target.closest('[data-win]');
  if (!w) return;
  const det = $('risk')?.querySelector?.('details.risk-fold');
  if (det) riskFoldOpen = !!det.open;
  riskWin = w.dataset.win === '1y' ? '1y' : '3m';
  renderRisk(riskData);
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
  el.innerHTML = items.map((i) => `<a class="hl ${i.effect === 'down' ? 'down' : 'up'}" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer"><span class="hl-tag">${i.effect === 'down' ? '▼' : '▲'} ${esc(i.kind)}</span><span class="hl-t">${esc(i.title)}</span><span class="hl-s dimtext">${esc(i.source)}</span></a>`).join('');
}
async function loadMacroNews() {
  const el = $('macro-news');
  if (!el) return;
  const req = macroCountry;
  el.innerHTML = stLoading('Loading headlines…');
  let n; try { n = await jget('/api/macro-news?id=' + req, 300000); } catch { n = null; }
  if (req !== macroCountry) return;
  renderNews(n || { items: [] }, 'macro-news', 'macro-news-sub');
}
function renderMacroDash(md, corr) {
  if (!md || md.error) return;
  macroMd = md;
  // Populate the region/country picker once. A periodic re-render must not rebuild the panel: it would
  // reload the country the reader is on (and used to snap back to the region's first country).
  if (!$('macro-country') || !$('macro-country').options.length) renderMacroRegion();
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
// Run a below-the-fold loader only once its element first comes near the viewport. A panel inside a
// hidden pane never intersects, so this also covers "don't render the other tabs until they're opened".
// Once a panel has been seen it runs immediately on later calls (so refresh cycles stay simple).
const nearSeen = new WeakSet();
function whenNear(el, fn, rootMargin = '400px') {
  const node = typeof el === 'string' ? $(el) : el;
  if (!node || nearSeen.has(node) || !('IntersectionObserver' in window)) { fn(); return; }
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    nearSeen.add(node);
    fn();
  }, { rootMargin });
  io.observe(node);
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
// A jump-nav chip must never point at a panel that isn't currently rendered: COMMODITIES shows and
// hides a dozen sections by segment, and the US–Japan panel only exists for the US/Japan. Hide the
// dead chips rather than offering a link that goes nowhere.
// ---------------------------------------------------------------------------
// Deep links + Back — the URL hash mirrors the view (#/commodities/gold/wti,
// #/macro/jp/jp) so a view can be bookmarked and shared, and the browser Back
// button walks your tabs instead of leaving the app. Tab changes push a
// history entry; everything finer-grained replaces, so Back isn't noisy.
// ---------------------------------------------------------------------------
let routeSuppress = false, routingReady = false;
function currentRoute() {
  const tab = document.querySelector('.tab.active')?.dataset.tab || 'home';
  if (tab === 'commodities') {
    const m = $('metric')?.value || currentComponent || '';
    return `#/commodities/${currentMarket}${m ? '/' + encodeURIComponent(m) : ''}`;
  }
  if (tab === 'macro') return `#/macro/${macroRegion}/${macroCountry}`;
  if (tab === 'deals') {
    if (!maSector) return '#/deals';
    return `#/deals/sector/${encodeURIComponent(maSector)}${maCompany ? '/company/' + encodeURIComponent(maCompany) : ''}`;
  }
  return '#/home';
}
function syncRoute(push) {
  if (routeSuppress) return;
  const r = currentRoute();
  if (location.hash === r) return;
  // NOTE: app.js has its own `history` (the price-history payload), which shadows window.history —
  // so the History API must be reached through `window.` explicitly.
  try { (push && routingReady) ? window.history.pushState(null, '', r) : window.history.replaceState(null, '', r); } catch {}
}
// Returns true when the hash really was a route (so callers can fall back to syncRoute).
function applyRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean)
    .map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (!parts.length) return false;
  const [tab, a, b] = parts;
  routeSuppress = true;
  try {
    if (tab === 'home') { showTab('home'); return true; }
    if (tab === 'deals') {
      maView = a ? 'sectors' : 'highlights';
      maSector = null; maCompany = null;
      if (a === 'sector' && b) { maSector = b; if (c === 'company' && parts[3]) maCompany = parts[3]; }
      if (a === 'company' && b) { maCompany = b; }
      showTab('deals');
      return true;
    }
    if (tab === 'commodities') {
      if (a && (markets || []).some((m) => m.id === a)) selectMarket(a);
      showTab('commodities');
      if (b) pickMetric(b, $('range')?.value || '6m');   // validates against the segment's metric options
      return true;
    }
    if (tab === 'macro') {
      showTab('macro');
      const rs = $('macro-region'), cs = $('macro-country');
      if (a && rs && [...rs.options].some((o) => o.value === a)) {
        rs.value = a; rs.dispatchEvent(new Event('change', { bubbles: true }));
        if (b && cs && [...cs.options].some((o) => o.value === b)) { cs.value = b; cs.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      return true;
    }
  } finally { routeSuppress = false; }
  return false;
}
// Jump-nav chips stay plain anchors for accessibility, but we scroll them ourselves so they don't
// overwrite the route hash in the address bar.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('.jumpnav a[href^="#"]');
  if (!a) return;
  const t = $(a.getAttribute('href'));
  if (!t) return;
  e.preventDefault();
  const pane = a.closest('.tabpane');
  if (pane) showTab(pane.dataset.pane);
  setTimeout(() => t.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
});
addEventListener('popstate', () => { if (!applyRoute(location.hash)) syncRoute(false); });
addEventListener('hashchange', () => { if (routingReady && !applyRoute(location.hash)) syncRoute(false); });

function syncJumpnavs() {
  document.querySelectorAll('.jumpnav').forEach((nav) => {
    const pane = nav.closest('.tabpane');
    if (!pane || pane.classList.contains('hidden')) return;
    nav.querySelectorAll('a[href^="#"]').forEach((a) => {
      const t = $(a.getAttribute('href'));
      a.classList.toggle('hidden', !(t && (t.offsetParent !== null || t.getClientRects().length > 0)));
    });
  });
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
    if (crackHistChart && currentMarket === 'refined') setTimeout(() => crackHistChart.resize(), 80);
  }
  if (name === 'deals') {
    // Warm all three markets as soon as the tab opens: switching region should not wait on a 70 KB
    // fetch that could have been in flight since the tab opened.
    warmMarkets(0);
    loadCompanies();
  }
  if (name === 'macro') { loadMacroTickers(); if (!extraSlowDone) setTimeout(() => loadExtraSlow().catch(() => {}), 0); if (macroChart) setTimeout(() => macroChart.resize(), 60); if (policyChart) setTimeout(() => policyChart.resize(), 70); if (cpiChart) setTimeout(() => cpiChart.resize(), 80); if (yieldsChart) setTimeout(() => yieldsChart.resize(), 85); if (usjpChart) setTimeout(() => usjpChart.resize(), 90); }
  if (data) renderTicker(data);
  syncJumpnavs();
  syncRoute(true);            // tab changes are the history steps (Back walks the tabs)
}

async function loadExtra() { loadBrief(); await loadExtraCore(); await loadExtraSlow(); }

// Above-the-fold feeds — fired immediately, not awaited, so the read/chart/news can start now.
async function loadExtraCore() {
  if (!data) return; // need prices first
  reloadHistory();    // deltas + sparklines
  loadRegime();       // HOME: markets at a glance
  // Loaded eagerly (a gate here is unreliable: these panels define the page height, so their
  // on-screen position is only known once they've rendered). The loading overlay no longer waits on
  // them — they sit below the fold, so BOOT_CORE excludes the screener and calendar.
  afterBoot(loadScreen);      // ~400 rows, below the fold
  afterBoot(loadCalendar);    // 170 events + 548 earnings dates
  loadRisk();
  loadTransmission(); // COMMODITIES: how it transmits

  renderAdaptive();
  // 40+ sector quotes, inventories, refiners… all inside the COMMODITIES pane, which is hidden
  // while the reader is on HOME. Defer the whole batch until that pane is actually opened.
  whenNear('#pane-commodities', loadBelowFold);
}
// Below-the-fold panels (inventories, sector quotes, ships, refining margins…). Deliberately not
// awaited — these used to block the read/chart from starting.
async function loadBelowFold() {
  try {
    const [inv, eq, an, pr] = await Promise.all([
      getJSON('/api/inventories').catch(() => null),
      getJSON('/api/equities').catch(() => null),
      getJSON('/api/analytics').catch(() => null),
      getJSON('/api/products').catch(() => null),
    ]);
    analytics = an;
    renderInventories(inv);
    renderSectors(eq, data, an);
    renderCurveForSegment();
    loadCurveHistory();
    renderProducts(pr);
    loadCrush();
  } catch { /* below the fold — stay quiet */ }
}
// Below-the-fold / MACRO-only feeds — the slowest requests. Loaded AFTER the
// first paint (and again on the periodic refresh) so they never delay the initial screen.
let extraSlowDone = false;
async function loadExtraSlow() {
  if (!data) return;
  try {
    // macrodash is fetched eagerly because `md.fx` feeds the top tape's currency section.
    const [md, corr] = await Promise.all([
      getJSON('/api/macrodash').catch(() => null),
      getJSON('/api/correlations').catch(() => null),
    ]);
    // renderMacroDash renders the region/country panel, whose loader now brings the catalysts with it
    // (or fetches them itself if the bundle is unavailable). Do not fire a duplicate catalysts request.
    whenNear('#pane-macro', () => { if (md && !md.error) renderMacroDash(md, corr); else renderMacroRegion(); });
    if (md?.fx) { lastFx = md.fx; renderTicker(data); }
    extraSlowDone = true;
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function refreshLive() {
  // Transient upstream hiccups must never pop the error banner (the loaders keep last-good state).
  try { await loadMarket(); } catch (e) { console.error('[market]', e.message); }
}
$('refresh').addEventListener('click', () => { nextRefresh = 60; refreshLive(); loadExtra(); });
$('metric').addEventListener('change', () => { localStorage.setItem('oilbasis.metric', $('metric').value); chartAnchor = null; renderChart(); syncRoute(false); });
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

$('macro-region')?.addEventListener('change', () => { macroRegion = $('macro-region').value; saveStr('macroRegion', macroRegion); renderMacroRegion(); syncRoute(false); });
$('macro-region-panel')?.addEventListener('click', (e) => { const el = e.target.closest('[data-metric]'); if (el) pickMetric(el.dataset.metric, '1y'); });
$('macro-country')?.addEventListener('change', () => { macroCountry = $('macro-country').value; saveStr('macroCountry', macroCountry); loadCountry(); syncRoute(false); });
$('macro-range')?.addEventListener('change', loadCountryChart);
$('macro-vs')?.addEventListener('change', () => { try { localStorage.setItem('oilbasis.macroVs', $('macro-vs').value); } catch {} loadCountryChart(); });
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
// `land` decides where the view ends up: 'chart' (the default) scrolls down to the chart panel, which
// is right when you just switched metric from inside the page; 'top' starts at the very top of the
// instrument's page, which is right when a tap on a tile is really a page change.
function pickMetric(id, range = '6m', land = 'chart') {
  if (id && [...$('metric').options].some((o) => o.value === id)) $('metric').value = id;
  localStorage.setItem('oilbasis.metric', id);
  $('range').value = range;
  chartAnchor = null;
  showTab('commodities');
  renderChart();
  syncRoute(false);
  if (land === 'top') {
    // scroll-behavior is unset in CSS, so 'auto' is instant — and it overrides the smooth scroll that
    // used to drag the view down to the chart panel, leaving you part-way down a page you just opened.
    setTimeout(() => window.scrollTo({ top: 0, behavior: 'auto' }), 0);
  } else {
    const cp = $('chart-panel');
    if (cp) setTimeout(() => cp.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }
}
// Open one instrument's page (watchlist tile, screener row, component card). The metric picker is
// rebuilt for whichever segment is open, so the segment that OWNS the instrument has to be selected
// FIRST — otherwise the instrument has no option to land on and you stay on whatever segment happened
// to be open, which reads as "it sent me to some random segment".
function goToInstrument(id, range = '6m') {
  if (!id) return;
  const owner = (markets || []).find((m) => (m.components || []).some((c) => c.id === id));
  if (owner && owner.id !== currentMarket) selectMarket(owner.id);   // also rebuilds the metric options
  currentComponent = id;          // the snapshot + READ follow this instrument, not the segment headline
  pickMetric(id, range, 'top');   // switches to COMMODITIES, selects it, draws the chart, starts at the top
  renderSnapshot();
  loadMarketRead();
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
  if (tile) goToInstrument(tile.dataset.id);
});
$('home-watch')?.addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  if (star) { toggleWatch(star.dataset.star); renderWatchlist(); if (data) renderCards(data); return; }
  const tile = e.target.closest('.tile[data-id]');
  if (tile) { goToInstrument(tile.dataset.id); return; }
  const co = e.target.closest('.tile[data-cik]');
  if (co) { coCik = co.dataset.cik; document.querySelector('[data-tab="deals"]')?.click(); renderCompanies(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
$('macro-fx')?.addEventListener('click', (e) => { const el = e.target.closest('[data-metric]'); if (el) pickMetric(el.dataset.metric, '1y'); });
$('macro-links')?.addEventListener('click', (e) => { const el = e.target.closest('[data-metric]'); if (el) pickMetric(el.dataset.metric, '1y'); });

(async function boot() {
  document.querySelectorAll('details.fold-panel').forEach((d) => d.addEventListener('toggle', () => {
    if (!d.open) return;
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
  const savedSeg = localStorage.getItem('oilbasis.segment');
  const savedRegion = localStorage.getItem('oilbasis.macroRegion');
  const savedCountry = localStorage.getItem('oilbasis.macroCountry');
  const savedRange = localStorage.getItem('oilbasis.range');
  if (savedRange && [...$('range').options].some((o) => o.value === savedRange)) $('range').value = savedRange;
  // Screener filters survive a reload like the rest of the view state.
  const savedScSeg = localStorage.getItem('oilbasis.scSeg');
  if (savedScSeg) screenSeg = savedScSeg;
  const savedScPicks = localStorage.getItem('oilbasis.scPicks');
  if (savedScPicks === 'all') screenPicks = null;
  else if (savedScPicks) { try { const a = JSON.parse(savedScPicks); if (Array.isArray(a)) screenPicks = new Set(a); } catch {} }
  if (savedRegion) { macroRegion = savedRegion; if ($('macro-region')) $('macro-region').value = savedRegion; }
  if (savedCountry) prefCountry = savedCountry;
  // Arm the overlay's ceiling BEFORE anything can block. This used to sit below the permission
  // request, awaited, so a prompt the reader ignored kept the boot screen up for as long as the
  // prompt lived — the one path where the cap never fired at all.
  setTimeout(hideBoot, 4000);   // hard ceiling: show whatever is ready after four seconds
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});   // never awaited: the page does not wait for a prompt
  }
  bootStep('Loading history…');
  // Fire the small config feeds in parallel with the (heavy) history load.
  const fxP = getJSON('/api/fx').catch(() => []);
  const rateP = getJSON('/api/rates').catch(() => []);
  const mkP = getJSON('/api/markets').catch(() => []);
  const ctryP = getJSON('/api/countries').catch(() => null);
  countriesP = ctryP;   // shared with ensureCountries() so a slow boot can't lose the user's pick
  // History and prices do not depend on each other — run them together rather than back to back.
  const histP = loadHistory().catch(() => {});   // never fatal — degrades to an empty history
  const liveP = refreshLive();
  fxList = await fxP; rateList = await rateP;
  renderCmpPresets();
  bootStep('Loading markets…');
  markets = await mkP;
  // Prices and the segment list load in parallel now, so either can land first. The picker is built
  // from `markets`, and loadMarket() bails out when the list is still empty — build it here too.
  buildBpOptions();
  macroCountries = await ctryP;
  bootStep('Loading prices…');
  await liveP;                // prices (sets `data` first)
  loadRegime();               // the backdrop is part of the first screen — start it with the prices,
                              // not after history (the overlay waits for data + segments + regime)
  loadBrief();                // and the brief runs beside history instead of after it
  await histP;
  initCurveHist();            // arm the lazy loader for the (expensive) curve-history chart
  bootStep('reading the market…');
  await loadExtraCore();      // the above-the-fold feeds only — below-the-fold comes after first paint
  // Always land on a segment (first visit included) so the read actually loads.
  selectMarket(savedSeg && markets.some((m) => m.id === savedSeg) ? savedSeg : (markets[0] && markets[0].id) || 'crude');
  restoreCompare();
  // Always start on HOME. A reload must not drop you back into whichever tab you left (MACRO, say),
  // and the URL hash is rewritten to #/home so it can't restore one either. In-app navigation still
  // updates the hash, back/forward still works (popstate), and pasting a route later still works
  // (hashchange) — only the boot state is pinned to HOME.
  showTab('home');
  syncRoute(false);
  routingReady = true;
  setTimeout(() => loadExtraSlow().catch(() => {}), 300);   // the slow, below-the-fold feeds
  // COMPANIES is a separate tab, so it is not part of the loading gate — but its payloads can load
  // quietly once the first screen is settled, which makes the tab open instantly.
  setTimeout(() => { try { warmMarkets(0); } catch {} }, 2500);
  loadAnalogue();
  loadHeadlines();
  setInterval(loadHeadlines, 600000);   // refresh the live headline board
  setInterval(loadExtra, 600000);                                   // slow feeds every 10 min
  setInterval(() => { nextRefresh -= 5; if (nextRefresh <= 0) { nextRefresh = 60; refreshLive(); } const cd = $('countdown'); if (cd) cd.textContent = `auto ${nextRefresh}s`; }, 5000);
  // Any request resets the host's idle timer; a tab left open keeps the instance from sleeping, which
  // is what makes the next visit wait 20-30s on the boot screen.
  setInterval(() => { fetch('/health', { cache: 'no-store' }).catch(() => {}); }, 5 * 60e3);
})();

// ---------------------------------------------------------------------------
// M&A — two pages: HIGHLIGHTS (what happened) and SECTORS (browse sector → company → deal).
// Every row carries its evidence: VERIFIED (read from the filing), REPORTED (a wire says so) or
// RUMOUR (the wire says talks/exploring). Verification is a flag, never a separate section.
let dealsData = null, maView = 'highlights', maSector = null, maCompany = null, maDays = 0;
let maQuery = '', maMin = 0, maStatus = 'all', maBuyer = 'all', maLookupFor = null, maLookupBusy = false;
let maSecDays = 0, maSecSort = 'date', maPriced = false;   // the sector's own window + sort, independent of the board's
const PE_RE = /\b(capital|partners|equity|kkr|blackstone|apollo|carlyle|bain|vista|thoma bravo|advent|cvc|eqt|warburg|silver lake|tpg|permira|bc partners|cinven|kps|platinum|golden gate|hellman)\b/i;
const dealDate = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }) : '');
// Two-digit years everywhere: "23 Oct 26" is unambiguous next to "23 Oct" and leaves the company
// name room to breathe in a narrow column.
const dealDateY = (d) => {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
};
const dealVal = (v) => (v == null ? '' : v >= 1000 ? `$${(v / 1000).toFixed(1)}B` : `$${Math.round(v)}M`);
// A computed value is marked: "≈" plus the basis on hover. It is never shown as if the filing said it.
const valCell = (d) => d.value == null ? '' : (d.valueSource === 'computed' ? `≈ ${dealVal(d.value)}` : dealVal(d.value));
const STATUS_LABEL = { rumour: 'RUMOUR', announced: 'ANNOUNCED', closed: 'CLOSED', terminated: 'TERMINATED' };
// Two dimensions, one chip: verified beats everything (it is evidence), otherwise show the lifecycle.
const chipFor = (d) => d.verified
  ? '<span class="ma-status s-verified" title="read out of the company’s own filing">VERIFIED</span>'
  : `<span class="ma-status s-${esc(d.status || 'announced')}"${d.statusInferred ? ' title="no closing filing on record — closed inferred from age"' : ''}>${STATUS_LABEL[d.status] || 'ANNOUNCED'}</span>`;
function maMono(name) {
  const parts = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const ini = ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="ma-mono" style="--h:${h}">${esc(ini)}</span>`;
}
const companyKey = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Keep the two segment buttons in step with the state, however the state was reached.
function syncMaTabs() {
  document.querySelectorAll('.deal-view').forEach((x) => { const on = x.dataset.view === maView; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); });
}
// Headline fragments ("ADNOC's XRG in talks", "Daiichi Life Offers $4.4 Billion") are not company names.
const maName = (n) => String(n || '').replace(/\s+(?:is )?(?:in|in advanced) talks\b.*$/i, '').replace(/\s+offers?\b.*$/i, '').replace(/[,;:.]+$/, '').trim();

async function loadDeals() {
  const el = $('deal-body');
  if (!el) return;
  if (!dealsData) el.innerHTML = stLoading('Reading the deal book…');
  try { dealsData = await jget('/api/deals', 300000); } catch { dealsData = dealsData || null; }
  renderDeals();
}

function renderDeals() {
  const el = $('deal-body');
  if (!el) return;
  if (!dealsData) { el.innerHTML = stError('Couldn’t load the deal book — retrying.'); return; }
  const allDeals = dealsData.deals || [];
  const cutoff = maDays ? new Date(Date.now() - maDays * 864e5).toISOString().slice(0, 10) : null;
  const q = maQuery.trim().toLowerCase();
  const deals = allDeals.filter((d) => {
    if (cutoff && (d.lastSeen || d.date || '') < cutoff) return false;
    if (maMin && (d.value || 0) < maMin) return false;
    if (maStatus === 'verified' && !d.verified) return false;
    if (maStatus === 'rumour' && d.status !== 'rumour') return false;
    if (maBuyer === 'pe' && !PE_RE.test(d.acquirer || '')) return false;
    if (maPriced && !d.value) return false;
    if (q && !(`${d.acquirer || ''} ${d.target || ''} ${d.sector || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const sub = $('deals-sub');
  const ver = deals.filter((d) => d.verified).length;
  if (sub) sub.textContent = `${deals.length} deals · ${ver} verified · ${(dealsData.log && dealsData.log.since) ? 'since ' + dealDateY(dealsData.log.since) : 'live'}`;
  const tools = $('ma-tools');
  if (tools) tools.classList.toggle('hidden', maView !== 'highlights');
  renderMaTools();
  const hint = $('deal-hint');
  if (hint) hint.textContent = maView === 'highlights'
    ? 'The year’s biggest verified deal, the largest logged, and what came in this week.'
    : 'Pick a sector, then a deal, to see the parties, the price and the timeline.';
  if (maView === 'sectors') {
    if (maCompany) return renderCompanyDeals(el, allDeals);
    if (maSector) return renderCompanyList(el, allDeals);
    return renderSectorGrid(el, deals);
  }
  return renderHighlights(el, deals);
}

function renderMaTools() {
  const box = $('ma-chips');
  if (!box) return;
  const chip = (label, on, attrs) => `<button class="ma-chip${on ? ' on' : ''}" ${attrs}>${label}</button>`;
  const group = (label, inner) => `<span class="ma-fgroup"><span class="ma-flabel">${label}</span>${inner}</span>`;
  const size = group('SIZE', chip('All', maMin === 0, 'data-min="0"') + chip('$1B+', maMin === 1000, 'data-min="1000"') + chip('$5B+', maMin === 5000, 'data-min="5000"'));
  const evidence = group('EVIDENCE', chip('All', maStatus === 'all', 'data-status="all"') + chip('Verified', maStatus === 'verified', 'data-status="verified"') + chip('Rumour', maStatus === 'rumour', 'data-status="rumour"'));
  const buyer = group('BUYER', chip('All', maBuyer === 'all', 'data-buyer="all"') + chip('PE', maBuyer === 'pe', 'data-buyer="pe"'));
  const active = (maMin ? 1 : 0) + (maStatus !== 'all' ? 1 : 0) + (maBuyer !== 'all' ? 1 : 0) + (maQuery.trim() ? 1 : 0) + (maPriced ? 1 : 0);
  box.innerHTML = size + evidence + buyer + chip('Priced', maPriced, 'data-priced="1"') + (active ? `<button class="ma-reset" data-reset="1">CLEAR ${active} FILTER${active === 1 ? '' : 'S'}</button>` : '');
}

function renderHighlights(el, deals) {
  const verified = deals.filter((d) => d.status === 'verified' && d.value);
  const hero = verified.slice().sort((a, b) => b.value - a.value)[0]
    || deals.filter((d) => d.value).sort((a, b) => b.value - a.value)[0];
  // No deal twice on one page: the hero is out of the rankings, and whatever the rankings show is out
  // of LATEST. (The same deal appearing in two lists read as two deals.)
  const heroKey = hero ? (hero.key || hero.id) : null;
  const year = deals.filter((d) => d.value && (d.key || d.id) !== heroKey).sort((a, b) => b.value - a.value).slice(0, 8);
  const shown = new Set(year.map((d) => d.key || d.id));
  const latest = deals.filter((d) => !shown.has(d.key || d.id)).slice(0, 10);
  const row = (d, i) => `<button class="ma-row" data-status="${esc(d.status || 'reported')}" data-deal="${esc(d.key || d.id)}" data-sector="${esc(d.sector || '')}" data-company="${esc(maName(d.acquirer) || maName(d.target) || '')}">
      ${i != null ? `<span class="ma-rank">${i + 1}</span>` : `<span class="ma-when">${dealDateY(d.date)}</span>`}
      <span class="ma-who">${maMono(maName(d.target) || maName(d.acquirer))}<span class="ma-names"><b>${esc(maName(d.acquirer) || '—')}</b> <span class="dimtext">→</span> ${esc(maName(d.target) || '—')}</span></span>
      <span class="ma-val">${dealVal(d.value)}</span>
      <span class="ma-tags">${chipFor(d)}</span>
    </button>`;
  // Nothing in the book for this term? Ask the news archive for it once, then re-render. This is how a
  // deal from before the store existed (e.g. OxyChem) still surfaces when you search for it.
  const term = maQuery.trim();
  if (!deals.length && term.length >= 3 && maLookupFor !== term && !maLookupBusy) {
    maLookupFor = term; maLookupBusy = true;
    fetch('/api/deals/lookup?q=' + encodeURIComponent(term))
      .then((r) => r.json())
      .then(() => { maLookupBusy = false; return loadDeals(); })
      .catch(() => { maLookupBusy = false; });
  }
  const active = (maMin ? 1 : 0) + (maStatus !== 'all' ? 1 : 0) + (maBuyer !== 'all' ? 1 : 0) + (maQuery.trim() ? 1 : 0) + (maPriced ? 1 : 0);
  const summary = `<div class="ma-sumline">${deals.length} deal${deals.length === 1 ? '' : 's'}${active ? ' · filtered' : ''}</div>`;
  if (!deals.length) { el.innerHTML = summary + '<div class="macro-note">No deals match these filters. Use CLEAR to reset.</div>'; return; }
  el.innerHTML = summary + (hero ? `<div class="ma-hero" data-deal="${esc(hero.key || hero.id)}" data-sector="${esc(hero.sector || '')}" data-company="${esc(hero.acquirer || hero.target || '')}" role="button" tabindex="0">
      <div class="ma-hero-l">${hero.verified ? 'BIGGEST VERIFIED DEAL' : 'BIGGEST LOGGED'} · ${esc(hero.sector || '')}</div>
      <div class="ma-hero-pair">${maMono(maName(hero.target))}<span><b>${esc(maName(hero.acquirer) || '—')}</b> <span class="dimtext">→</span> ${esc(maName(hero.target) || '—')}</span></div>
      <div class="ma-hero-v">${dealVal(hero.value)}</div>
      ${hero.rationale ? `<div class="ma-hero-w">“${esc(hero.rationale)}”</div>` : ''}
      <div class="ma-hero-m">announced ${dealDate(hero.date)}${hero.closed ? ' · closed ' + dealDate(hero.closed) : ''} · ${(hero.advisers || []).length ? 'advisers: ' + esc(hero.advisers.join(', ')) : 'advisers not disclosed'}</div>
    </div>` : '')
    + `<div class="gtitle">BIGGEST LOGGED</div>${year.map((d, i) => row(d, i)).join('')}`
    + `<div class="gtitle">LATEST</div>${latest.map((d) => row(d, null)).join('')}`;
}

function sectorStats(deals) {
  const map = new Map();
  for (const d of deals) {
    if (!d.sector) continue;
    if (!map.has(d.sector)) map.set(d.sector, { id: d.sector, count: 0, value: 0, verified: 0, reported: 0, rumour: 0, companies: new Map(), top: null });
    const s = map.get(d.sector);
    s.count++;
    s.value += d.value || 0;
    if (d.verified) s.verified++; else if (d.status === 'rumour') s.rumour++; else s.reported++;
    for (const n of [d.acquirer, d.target]) {
      if (!n) continue;
      const k = companyKey(n);
      if (!s.companies.has(k)) s.companies.set(k, { name: maName(n), value: 0 });
      s.companies.get(k).value += d.value || 0;
    }
    if (!s.top || (d.value || 0) > (s.top.value || 0)) s.top = d;
  }
  return [...map.values()].sort((a, b) => b.value - a.value || b.count - a.count);
}

function renderSectorGrid(el, deals) {
  const secs = sectorStats(deals);
  const max = Math.max(1, ...secs.map((s) => s.value));
  const total = secs.reduce((a, s) => a + s.value, 0) || 1;
  const ranges = [[7, '7D'], [30, '30D'], [365, '1Y'], [0, 'ALL']];
  el.innerHTML = `<div class="ma-filters">${ranges.map(([d, l]) => `<button class="ma-chip${maDays === d ? ' on' : ''}" data-days="${d}">${l}</button>`).join('')}</div>`
    + secs.map((s) => {
      const companies = [...s.companies.values()].sort((a, b) => b.value - a.value).slice(0, 3);
      const mix = (n) => (s.count ? (n / s.count) * 100 : 0);
      return `<button class="ma-sec" data-sector="${esc(s.id)}">
        <span class="ma-sec-top">
          <span class="ma-sec-name">${esc(s.id)}</span>
          <span class="ma-sec-count">${s.count} deal${s.count === 1 ? '' : 's'}</span>
          <span class="ma-sec-val">${s.value ? dealVal(s.value) : '—'}</span>
        </span>
        <span class="ma-sec-bar"><i style="width:${Math.max(2, (s.value / max) * 100)}%"></i></span>
        <span class="ma-sec-foot">
          <span class="ma-sec-mono">${companies.map((c) => maMono(c.name)).join('')}</span>
          <span class="ma-sec-share">${Math.round((s.value / total) * 100)}% of disclosed</span>
          <span class="ma-sec-mix" title="${s.verified} verified · ${s.reported} reported · ${s.rumour} rumour">
            <i class="v" style="width:${mix(s.verified)}%"></i><i class="r" style="width:${mix(s.reported)}%"></i><i class="u" style="width:${mix(s.rumour)}%"></i>
          </span>
        </span>
      </button>`;
    }).join('')
    + (secs.length ? `<div class="macro-note">Book starts ${dealsData.log && dealsData.log.since ? dealDateY(dealsData.log.since) : 'this week'} — earlier deals are still being backfilled, so a sector can look thinner than the market was.</div>` : '<div class="macro-note">Nothing in this window.</div>');
}

function renderCompanyList(el, allDeals) {
  const cutoff = maSecDays ? new Date(Date.now() - maSecDays * 864e5).toISOString().slice(0, 10) : null;
  const rows = allDeals
    .filter((d) => d.sector === maSector && (!cutoff || (d.date || '') >= cutoff))
    .sort((a, b) => (maSecSort === 'value' ? (b.value || 0) - (a.value || 0) : (a.date < b.date ? 1 : -1)));
  const total = rows.reduce((a, b) => a + (b.value || 0), 0);
  const verified = rows.filter((d) => d.verified).length;
  const span = rows.length ? `${dealDateY(rows[rows.length - 1].date)} → ${dealDateY(rows[0].date)}` : '';
  const ranges = [[0, 'ALL'], [365 * 3, '3Y'], [365, '12M'], [180, '6M']];
  const dealRow = (d) => `<button class="ma-row ma-deal-row" data-status="${esc(d.status || 'announced')}" data-deal="${esc(d.key || d.id)}" data-sector="${esc(d.sector || '')}" data-company="${esc(maName(d.acquirer) || maName(d.target) || '')}">
      <span class="ma-when">${dealDateY(d.date)}</span>
      <span class="ma-who">${maMono(maName(d.target))}<span class="ma-names" title="${esc((maName(d.acquirer) || '') + ' → ' + (maName(d.target) || ''))}"><b>${esc(maName(d.acquirer) || '—')}</b> <span class="dimtext">→</span> ${esc(maName(d.target) || '—')}</span></span>
      <span class="ma-val" title="${d.valueSource === 'computed' ? esc(d.valueBasis || 'computed from price × shares') : ''}">${valCell(d) || '—'}</span>
      <span class="ma-tags">${chipFor(d)}</span>
    </button>`;
  el.innerHTML = `<div class="ma-crumb"><button class="ma-back" data-back="1">← SECTORS</button> <span>${esc(maSector)}</span></div>`
    + `<div class="ma-sec-head"><span class="ma-sec-head-n">${rows.length} deal${rows.length === 1 ? '' : 's'}</span><span class="ma-sec-head-v">${total ? dealVal(total) + ' disclosed' : 'no value disclosed'}</span><span class="ma-sec-head-c">${verified} verified</span></div>`
    + `<div class="ma-filters">${ranges.map(([d, l]) => `<button class="ma-chip${maSecDays === d ? ' on' : ''}" data-secdays="${d}">${l}</button>`).join('')}`
    + `<span class="ma-gap"></span><button class="ma-chip${maSecSort === 'date' ? ' on' : ''}" data-secsort="date">LATEST</button><button class="ma-chip${maSecSort === 'value' ? ' on' : ''}" data-secsort="value">LARGEST</button></div>`
    + (span ? `<div class="ma-sumline">${esc(span)}</div>` : '')
    + `<div class="gtitle">DEALS</div>`
    + (rows.length ? rows.map(dealRow).join('') : '<div class="macro-note">No deals in this window — widen the range.</div>');
}

function renderCompanyDeals(el, deals) {
  const mine = deals.filter((d) => companyKey(d.acquirer) === companyKey(maCompany) || companyKey(d.target) === companyKey(maCompany));
  const d = mine[0];
  if (!d) { el.innerHTML = `<div class="ma-crumb"><button class="ma-back" data-back="1">← BACK</button></div><div class="macro-note">No deals for this company.</div>`; return; }
  const other = mine.slice(1);
  // Comparables: same sector, a price within half to twice this deal, within three years either side.
  const similar = d.value
    ? deals.filter((x) => x !== d && x.sector === d.sector && x.value && x.value >= d.value * 0.5 && x.value <= d.value * 2
      && Math.abs(Date.parse(x.date) - Date.parse(d.date)) < 3 * 365 * 864e5).slice(0, 4)
    : [];
  const otherHtml = other.map((x) => {
    const attrs = `data-deal="${esc(x.key || x.id)}" data-sector="${esc(x.sector || '')}" data-company="${esc(x.acquirer || x.target || '')}"`;
    return `<button class="ma-row" ${attrs}>
        <span class="ma-when">${dealDate(x.date)}</span>
        <span class="ma-names">${esc(x.acquirer || '—')} <span class="dimtext">→</span> ${esc(x.target || '—')}</span>
        <span class="ma-val">${dealVal(x.value)}</span>
        <span class="ma-tags">${chipFor(x)}</span></button>`;
  }).join('');
  const advisers = (d.advisers || []).length
    ? `<div>advisers: ${esc(d.advisers.join(', '))}</div>`
    : '<div class="dimtext">advisers not disclosed</div>';
  const link = d.url
    ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${d.status === 'verified' ? 'the filing' : 'the story'} ↗</a>`
    : '';
  const asAcq = mine.filter((x) => companyKey(x.acquirer) === companyKey(maCompany)).length;
  const asTgt = mine.filter((x) => companyKey(x.target) === companyKey(maCompany)).length;
  const total = mine.reduce((a2, b2) => a2 + (b2.value || 0), 0);
  const stats = `<div class="ma-sec-head"><span class="ma-sec-head-n">${mine.length} deal${mine.length === 1 ? '' : 's'}</span><span class="ma-sec-head-v">${asAcq} as buyer · ${asTgt} as target</span>${total ? `<span class="ma-sec-head-c">${dealVal(total)}</span>` : ''}</div>`;
  el.innerHTML = `<div class="ma-crumb"><button class="ma-back" data-back="1">← ${esc(maSector || 'SECTORS')}</button> <span>${esc(maCompany)}</span></div>`
    + stats
    + `<div class="ma-deal">
        <div class="ma-deal-pair">${maMono(d.target)}<span><button class="ma-part" data-company="${esc(d.acquirer || '')}">${esc(maName(d.acquirer) || '—')}</button> <span class="dimtext">→</span> <button class="ma-part" data-company="${esc(d.target || '')}">${esc(maName(d.target) || '—')}</button></span></div>
        <div class="ma-deal-v">${valCell(d) || 'value not disclosed'} ${chipFor(d)}</div>
        ${d.valueSource === 'computed' ? `<div class="ma-deal-m">computed · ${esc(d.valueBasis || 'price × shares')}</div>` : ''}
        <div class="ma-deal-m">announced ${dealDate(d.date)}${d.closed ? ' · closed ' + dealDate(d.closed) : ''} · ${esc(d.sector || '')}${d.consideration ? ' · ' + esc(d.consideration) : ''}</div>
        ${d.rationale ? `<div class="dc-why">“${esc(d.rationale)}”</div>` : ''}
        <div class="ma-deal-foot">${advisers}${link}</div>
      </div>`
    + ((d.events || []).length > 1 ? `<div class="gtitle">TIMELINE</div><div class="ma-tl">${(d.events || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map((e) => `<div class="ma-tl-row">
        <span class="ma-tl-d">${dealDate(e.date)}</span>
        <span class="ma-tl-s s-${esc(e.status)}">${STATUS_LABEL[e.status] || esc(e.status || '')}</span>
        <a href="${esc(e.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(e.title)} <span class="dimtext">— ${esc(e.source || '')}</span></a>
      </div>`).join('')}</div>` : '')
    + (other.length ? `<div class="gtitle">ALSO INVOLVED</div>${otherHtml}` : '')
    + (similar.length ? `<div class="gtitle">COMPARABLE DEALS</div>${similar.map((x) => {
        const attrs = `data-deal="${esc(x.key || x.id)}" data-sector="${esc(x.sector || '')}" data-company="${esc(maName(x.acquirer) || maName(x.target) || '')}"`;
        return `<button class="ma-row" ${attrs}>
          <span class="ma-when">${dealDateY(x.date)}</span>
          <span class="ma-names" title="${esc((maName(x.acquirer) || '') + ' → ' + (maName(x.target) || ''))}">${esc(maName(x.acquirer) || '—')} <span class="dimtext">→</span> ${esc(maName(x.target) || '—')}</span>
          <span class="ma-val">${dealVal(x.value)}</span>
          <span class="ma-tags">${chipFor(x)}</span></button>`;
      }).join('')}` : '');
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'ma-search') {
    maQuery = e.target.value || '';
    renderDeals();
  }
});

document.addEventListener('click', (e) => {
  const sd = e.target.closest('[data-secdays]');
  if (sd) { maSecDays = Number(sd.dataset.secdays); renderDeals(); return; }
  const ss = e.target.closest('[data-secsort]');
  if (ss) { maSecSort = ss.dataset.secsort; renderDeals(); return; }
  if (e.target.closest('[data-reset]')) {
    maMin = 0; maStatus = 'all'; maBuyer = 'all'; maQuery = '';
    const inp = $('ma-search'); if (inp) inp.value = '';
    renderDeals();
    return;
  }
  const mc = e.target.closest('#ma-chips .ma-chip');
  if (e.target.closest('[data-priced]')) { maPriced = !maPriced; renderDeals(); return; }
  if (mc) {
    // Single-select per group: pressing one chip always means "show me this", never "toggle something".
    if (mc.dataset.min != null) maMin = Number(mc.dataset.min);
    if (mc.dataset.buyer != null) maBuyer = mc.dataset.buyer;
    if (mc.dataset.status != null) maStatus = mc.dataset.status;
    renderDeals();
    return;
  }
  const bd = e.target.closest('.brief-deal');
  if (bd) {
    maView = 'sectors';
    maSector = bd.dataset.sector || null;
    maCompany = bd.dataset.company || null;
    syncMaTabs();
    showTab('deals');
    return;
  }
  const days = e.target.closest('[data-days]');
  if (days) { maDays = Number(days.dataset.days); renderDeals(); return; }
  const view = e.target.closest('.deal-view');
  if (view && view.dataset.view) {
    maView = view.dataset.view; maSector = null; maCompany = null;
    document.querySelectorAll('.deal-view').forEach((x) => { const on = x === view; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); });
    renderDeals();
    return;
  }
  if (e.target.closest('[data-back]')) {
    if (maCompany) maCompany = null; else maSector = null;
    renderDeals();
    syncRoute(true);
    return;
  }
  const part = e.target.closest('.ma-part');
  if (part && part.dataset.company) { maCompany = part.dataset.company; renderDeals(); syncRoute(true); return; }
  const co = e.target.closest('[data-company]');
  if (co && maView === 'sectors') { maCompany = co.dataset.company; renderDeals(); syncRoute(true); return; }
  const sec = e.target.closest('[data-sector]');
  if (sec && maView === 'sectors' && !sec.dataset.deal) { maSector = sec.dataset.sector; maCompany = null; renderDeals(); syncRoute(true); return; }
  const deal = e.target.closest('[data-deal]');
  if (deal && deal.dataset.company) { maView = 'sectors'; maSector = deal.dataset.sector; maCompany = deal.dataset.company; syncMaTabs(); renderDeals(); }
});

// ---------------------------------------------------------------------------
// COMPANIES — profiles and financials from SEC XBRL (tagged facts, no estimates).
let companiesData = null, coQuery = '', coSector = 'all', coMin = 0, coCik = null, coTicker = null, coRange = '5y', coCompare = '';
// The compare box is per company: moving to another name starts clean instead of leaving the old
// benchmark on the chart. `coOpenCik` is what the current comparison belongs to.
let coOpenCik = null, jpOpenSel = null, krOpenSel = null;
let coPreset = null;
// A compare ref is `us:AAPL` / `jp:7203` / `kr:005930`; the box and the chart legend show the code.
const cmpCode = (ref) => { const s = String(ref || ''); return s.includes(':') ? s.split(':')[1] : s; };
// Screens that are a rule, not a list — the US counterpart of Japan's BELOW BOOK / CASH RICH presets.
const CO_PRESETS = [
  { id: 'buyback', label: 'BUYBACK HEAVY', test: (c) => c.buybacks && c.marketCap && c.buybacks / c.marketCap > 0.03 },
  { id: 'quality', label: 'QUALITY', test: (c) => (c.roic || 0) > 15 && (c.revenueCagr || 0) > 10 },
  { id: 'yield', label: 'HIGH YIELD', test: (c) => (c.dividendYield || 0) > 3 },
];
let coSort = 'cap', coDir = -1;   // screener: which column, and which way

// One filter bar for all three markets. The markets keep their own filters — a Korean bank screen is
// not a US one — but the shape is identical: preset chips, then labelled selects, then CLEAR. Same
// markup, same classes, same place in the toolbar, so switching market does not re-teach the user.
function coFilterBar({ presets = [], preset = null, presetAttr, selects = [], extra = '', clearAttr, clearValue = 'clear', active = 0, asOf = '' }) {
  const sel = (key, label, opts, cur, attr) => `<label class="co-sel"><span>${label}</span><select ${attr}="${esc(key)}">`
    + opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(t)}</option>`).join('')
    + '</select></label>';
  return `<div class="jp-presets" style="width:100%;padding:0 0 2px">${presets.map((p) => `<button type="button" class="co-tgl${preset === p.id ? ' on' : ''}" ${presetAttr}="${esc(p.id)}">${esc(p.label)}</button>`).join('')}</div>`
    + selects.map((x) => sel(x.key, x.label, x.opts, x.cur, x.attr)).join('')
    + extra
    + (active ? `<button class="ma-reset" ${clearAttr}="${esc(clearValue)}">CLEAR ${active}</button>` : '')
    + (asOf ? `<span class="co-asof dimtext">${esc(asOf)}</span>` : '');
}
let coPe = 'all', coMinMargin = 0, coGrowth = null, coPriced = false, coVerified = false, coView = 'list';

async function loadCompanies() {
  const el = $('co-body');
  if (!el) return;
  if (!companiesData) el.innerHTML = stLoading('Reading the filings…');
  // jget de-dupes and caches: this loader and warmMarkets used to fetch the same 62 KB twice when the
  // tab was opened before the background warm had finished.
  try { companiesData = await jget('/api/companies', 300000); } catch { companiesData = companiesData || null; }
  renderCompanies();
}

const coMono = (c) => {
  const src = String(c.ticker || c.name || '?').replace(/[^A-Za-z0-9]/g, '');
  const ini = src.slice(0, 2).toUpperCase();
  let h = 0;
  for (const ch of String(c.name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="ma-mono" style="--h:${h}">${esc(ini)}</span>`;
};
const coMoney = (v) => (v == null ? '—'
  : Math.abs(v) >= 1e12 ? `$${(v / 1e12).toFixed(2)}T`
  : Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B`
  : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(0)}M`
  : `$${Math.round(v)}`);
// Common names people type that are not the legal name on the filing.
const CO_ALIAS = {
  google: 'GOOGL', alphabet: 'GOOGL', youtube: 'GOOGL', facebook: 'META', instagram: 'META', whatsapp: 'META',
  berkshire: 'BRK-B', jpmorgan: 'JPM', 'jp morgan': 'JPM', exxon: 'XOM', 'johnson & johnson': 'JNJ', jnj: 'JNJ',
  procter: 'PG', 'coca cola': 'KO', cocacola: 'KO', 'home depot': 'HD', 'bank of america': 'BAC', 'wells fargo': 'WFC',
  goldman: 'GS', 'morgan stanley': 'MS', 'at&t': 'T', att: 'T', 't mobile': 'TMUS', 'eli lilly': 'LLY',
  unitedhealth: 'UNH', 'united health': 'UNH', 'general motors': 'GM', 'ford': 'F', 'boeing': 'BA',
};
const coMarginOf = (c) => (c.revenue && c.netIncome != null ? (c.netIncome / c.revenue) * 100 : null);
const coMargin = coMarginOf;

// --- Japan: TSE Prime, from J-Quants (JPX's own API) -------------------------------------------
// Built from the same components as the US page — ma-crumb, co-head, coMono, co-price, co-stats —
// so it reads as one product. Different currency and fiscal year, same layout.
let japanData = null, jpSel = null, jpQuery = '';
let jpView = (() => { try { return localStorage.getItem('oilbasis.jpView') || 'market'; } catch { return 'market'; } })();
let jpMktRange = (() => { try { return localStorage.getItem('oilbasis.jpMktRange') || '1y'; } catch { return '1y'; } })();
let jpRange = (() => { try { return localStorage.getItem('oilbasis.jpRange') || '6m'; } catch { return '6m'; } })();
let jpCompare = '';
let jpSort = (() => { try { return localStorage.getItem('oilbasis.jpSort') || 'cap'; } catch { return 'cap'; } })();
let jpPreset = null;
let jpFilter = (() => { try { return JSON.parse(localStorage.getItem('oilbasis.jpFilter') || '{}'); } catch { return {}; } })();
const saveJpFilter = () => { try { localStorage.setItem('oilbasis.jpFilter', JSON.stringify(jpFilter)); } catch {} };

const JP_PRESETS = [
  { id: 'book', label: 'BELOW BOOK', f: { pbMax: 0.8, roeMin: 0, capMin: 20e9 } },
  { id: 'banks', label: 'REGIONAL BANKS', f: { sector: 'Banks', capMax: 300e9 } },
  { id: 'yield', label: 'HIGH YIELD', f: { yieldMin: 3.5 } },
  { id: 'cash', label: 'CASH RICH', f: { cashMin: 0.2 } },
  { id: 'cheap', label: 'CHEAP VS ITSELF', f: { pePercentileMax: 20, roeMin: 0 } },
];

function yen(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `¥${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `¥${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `¥${(v / 1e6).toFixed(1)}M`;
  return `¥${Math.round(v).toLocaleString('en-US')}`;
}

// Japanese codes are four digits, so the US ticker monogram would read "83". Use the name instead.
const jpMono = (c) => coMono({ ticker: String(c.name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2), name: c.name });

let japanPromise = null;
async function loadJapan() {
  if (japanData) return japanData;
  if (japanPromise) return japanPromise;
  japanPromise = (async () => {
    try { japanData = await jget('/api/japan', 3600000); } catch { japanData = { companies: [] }; }
    japanPromise = null;
    return japanData;
  })();
  return japanPromise;
}

function japanTile(c) {
  const chg = (v) => (v == null ? '' : `<em class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</em>`);
  return `<div class="tile" data-jpcode="${esc(c.code)}" title="${esc(c.name)} — open the company page">
    <span class="t-name">${esc(c.ticker)} · ${esc(c.name.length > 14 ? c.name.slice(0, 13) + '…' : c.name)}</span>
    <span class="star on" data-star="jp:${esc(c.code)}" title="Unpin from watchlist">★</span>
    <span class="t-px">${yen(c.price)}</span>
    <span class="t-foot">${chg(c.chg1d)} today · ${chg(c.chg6m)} 6M · ${chg(c.chgYtd)} YTD</span>
  </div>`;
}

// The search box only makes sense over a list. In MARKET or BANKS, or on a company page, it has
// nothing to act on, so it is hidden rather than left there doing nothing.
function syncCoTools() {
  const tools = document.querySelector('.co-tools');
  if (!tools) return;
  // Every market writes its own filters into the same chips container, so it is never hidden — only
  // repainted. Uniform place, uniform shape, market-specific choices.
  const chips = document.getElementById('co-chips');
  if (chips) chips.classList.remove('hidden');
  const wanted = coRegion === 'jp'
    ? (!jpSel && jpView === 'screener')
    : coRegion === 'kr' ? (!krSel && krView === 'screener')
    : (coCik ? true : usView === 'screener');
  tools.classList.toggle('hidden', !wanted);
  // On a phone, a company page should start at the top: the filter bar is for lists.
  const detail = coRegion === 'jp' ? !!jpSel : coRegion === 'kr' ? !!krSel : !!coCik;
  tools.dataset.detail = detail ? '1' : '';
}

const jpViewsBar = () => '';

const jpYield = (c) => (c.dividend && c.dividend.yield != null ? c.dividend.yield : null);
const jpCashRatio = (c) => (c.cash && c.marketCap ? c.cash / c.marketCap : 0);

function jpMatches(c) {
  const f = jpFilter;
  if (jpQuery) {
    const hay = `${c.name} ${c.nameJa || ''} ${c.ticker} ${c.sector} ${(c.brands || []).join(' ')}`.toLowerCase();
    if (!hay.includes(jpQuery.trim().toLowerCase())) return false;
  }
  if (f.sector && c.sector !== f.sector) return false;
  if (f.pe) {
    if (c.pe == null) return false;
    if (f.pe === 'lt10' && c.pe >= 10) return false;
    if (f.pe === '10to15' && (c.pe < 10 || c.pe >= 15)) return false;
    if (f.pe === '15to25' && (c.pe < 15 || c.pe >= 25)) return false;
    if (f.pe === 'gt25' && c.pe < 25) return false;
  }
  if (f.roe && !(c.roe != null && c.roe >= Number(f.roe))) return false;
  if (f.roeMin != null && !(c.roe != null && c.roe >= f.roeMin)) return false;
  if (f.yield && !(jpYield(c) != null && jpYield(c) >= Number(f.yield))) return false;
  if (f.yieldMin != null && !(jpYield(c) != null && jpYield(c) >= f.yieldMin)) return false;
  if (f.pbMax != null && !(c.pb != null && c.pb <= f.pbMax)) return false;
  if (f.capMin != null && !((c.marketCap || 0) >= f.capMin)) return false;
  if (f.capMax != null && !((c.marketCap || 0) <= f.capMax)) return false;
  if (f.cashMin != null && jpCashRatio(c) < f.cashMin) return false;
  if (f.pePercentileMax != null && !(c.bands && c.bands.pe && c.bands.pe.percentile <= f.pePercentileMax)) return false;
  return true;
}

async function renderJapan(token = takeToken()) {
  paintCoViews();
  const el = $('co-body'); if (!el) return;
  if (jpSel !== jpOpenSel) { jpCompare = ''; jpOpenSel = jpSel; }
  syncMarketAccent();
  const noteUs = $('co-note'); if (noteUs) noteUs.classList.add('hidden');
  for (const k of ['jp-chart', 'jp-q-chart']) {
    if (charts[k]) { try { charts[k].destroy(); } catch {} delete charts[k]; }
  }
  if (!japanData) el.innerHTML = stLoading('Loading Japan…');
  const d = await loadJapan();
  if (stale(token)) return;          // another market was chosen while this one loaded
  syncMarketAccent();
  // Preferred share classes carry a price but are not separate companies — same rule as the US.
  const all = ((d && d.companies) || []).filter((c) => !c.shareClass);
  const sub = $('deals-sub');
  if (sub) {
    const what = jpView === 'screener' ? 'filter and sort' : jpView === 'themes' ? 'curated theme lists' : 'breadth, sectors and TOPIX';
    sub.textContent = all.length ? `${all.length} companies · TSE Prime · ¥ JPY · ${what}` : 'TSE Prime · J-Quants (JPX)';
  }
  if (!all.length) {
    el.innerHTML = `<div class="macro-note">Japan is not built yet. With a J-Quants key in the environment, run <code>node scripts/build-japan.mjs</code> — the whole pipeline is ready.</div>`;
    return;
  }
  const sel = all.find((c) => c.code === jpSel);
  if (sel) { syncCoTools(); return renderJapanPage(sel); }
  syncCoTools();
  warmMarkets();
  if (jpView === 'market') return renderJapanMarket(all, d);
  if (jpView === 'themes') return renderJapanThemes(all, d);
  return renderJapanScreener(all, d);
}

// Whole-market view, computed from the constituent set rather than an index file.
function renderJapanMarket(all, d) {
  const el = $('co-body'); if (!el) return;
  syncCoTools();
  const m = d.market || {};
  const t = d.topix || {};
  const cell = (k, val, title, cls = '') => `<div class="co-stat" title="${esc(title)}"><span class="co-k">${k}</span><span class="co-v ${cls}">${val}</span></div>`;
  const chg = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  const sectors = (m.sectors || []);
  const breadth = m.advancing != null && m.declining != null
    ? `<div class="jp-breadth"><span class="pos">${m.advancing} up</span><i><i style="width:${Math.round((m.advancing / Math.max(1, m.advancing + m.declining)) * 100)}%"></i></i><span class="neg">${m.declining} down</span></div>` : '';

  el.innerHTML = jpViewsBar()
    + `<div class="jp-market-head"><span class="ph-t">TOPIX</span><span class="jp-market-lvl">${t.level != null ? t.level.toFixed(2) : '—'}</span>
        <span class="${(t.chg1d || 0) >= 0 ? 'pos' : 'neg'}">${chg(t.chg1d)} today</span>
        <span class="dimtext">official index · whole market</span></div>`
    + `<div class="co-stats co-stats-12">
        ${cell('PRIME MARKET CAP', yen(m.totalCap), 'Sum of every Prime constituent we hold, ex-treasury')}
        ${cell('COMPANIES', String(m.companies || all.length), 'Prime issues with a market cap')}
        ${cell('MEDIAN P/E', m.medianPe != null ? `${m.medianPe.toFixed(1)}×` : '—', 'Median across the market — not cap-weighted')}
        ${cell('MEDIAN P/B', m.medianPb != null ? `${m.medianPb.toFixed(2)}×` : '—', 'Median across the market')}
        ${cell('MEDIAN ROE', m.medianRoe != null ? `${m.medianRoe.toFixed(1)}%` : '—', 'Trailing twelve months, median')}
        ${cell('MEDIAN YIELD', m.medianYield != null ? `${m.medianYield.toFixed(2)}%` : '—', 'Median dividend yield')}
        ${cell('BELOW BOOK', m.belowBook != null ? `${m.belowBook}` : '—', 'Companies trading under 1× book value', 'pos')}
        ${cell('UP THIS YEAR', m.upYtd != null ? `${m.upYtd}` : '—', 'Companies with a positive year-to-date return')}
      </div>`
    + breadth
    + (t.series && t.series.length > 1 ? '<div class="co-rets" id="jp-mkt-rets"></div><div class="co-chartwrap"><canvas id="jp-mkt-chart"></canvas></div>' : '')
    + `<div class="co-hrow jp-mkt-hrow"><span>SECTOR</span><span>N</span><span>CAP</span><span>P/E</span><span>P/B</span><span>ROE</span><span>YIELD</span><span>YTD</span></div>`
    + sectors.map((s) => `<div class="jp-mkt-row">
        <span>${esc(s.name)}</span><span>${s.count}</span><span>${yen(s.cap)}</span>
        <span>${s.pe != null ? s.pe.toFixed(1) : '—'}</span>
        <span>${s.pb != null ? s.pb.toFixed(2) : '—'}</span>
        <span class="${(s.roe || 0) >= 0 ? 'pos' : 'neg'}">${s.roe != null ? s.roe.toFixed(1) + '%' : '—'}</span>
        <span>${s.yield != null ? s.yield.toFixed(2) + '%' : '—'}</span>
        <span class="${(s.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${chg(s.chgYtd)}</span>
      </div>`).join('')
    + `<div class="macro-note">Aggregates are computed from the ${all.length} Prime constituents in this dataset, not from an index file — medians are equal-weighted, so they describe the typical company rather than the largest. TOPIX is the exchange's official index and covers Prime, Standard and Growth.</div>`;
  // TOPIX's own history, with the same window strip a company page carries. The series is already in
  // the page, so changing the window is a redraw rather than a request.
  if (t.series && t.series.length > 1) redrawJapanIndex();
}

// Themes: two written lists and two rules. The rules are computed here from live data so they never
// go stale; the written lists come from data/japan-themes.json.
let jpTheme = (() => { try { return localStorage.getItem('oilbasis.jpTheme') || 'banks'; } catch { return 'banks'; } })();

function jpThemeList(d) {
  const curated = (d && d.themes) || [];
  return [
    { id: 'banks', label: 'BANKS', kind: 'rule', note: 'Every Prime-listed bank, sorted by price to book. A bank under book with a positive return on equity is the classic Japanese value setup — or a value trap, which is why ROE sits beside it.', pick: (c) => c.sector === 'Banks' },
    ...curated,
    { id: 'reform', label: 'TSE REFORM', kind: 'rule', note: 'Trading below book, profitable, but earning less than 8% on equity — the companies the Tokyo Stock Exchange has been pressing to change. This is the pool, not a list of activist targets.', pick: (c) => c.pb != null && c.pb < 1 && (c.roe || 0) < 8 && (c.np || 0) > 0 },
  ];
}

function renderJapanThemes(all, d) {
  const el = $('co-body'); if (!el) return;
  syncCoTools();
  const themes = jpThemeList(d);
  const active = themes.find((t) => t.id === jpTheme) || themes[0];
  const set = active.codes ? new Set(active.codes) : null;
  const rows = all
    .filter((c) => (set ? set.has(c.code) : active.pick ? active.pick(c) : false))
    .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  const chg = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  el.innerHTML = jpViewsBar()
    + `<div class="jp-presets">${themes.map((t) => `<button type="button" data-jptheme="${t.id}" class="${t.id === active.id ? 'on' : ''}">${t.label}</button>`).join('')}</div>`
    + `<div class="jp-market-head"><span class="ph-t">${esc(active.label)}</span><span class="dimtext">${rows.length} companies · ${active.kind === 'curated' ? 'curated list' : 'computed from the data'}</span></div>`
    + `<div class="co-hrow jp-bank-hrow"><span>#</span><span>COMPANY</span><span>CAP</span><span>P/B</span><span>P/E</span><span>ROE</span><span>YIELD</span><span>YTD</span></div>`
    + rows.map((c, i) => `<button class="jp-bank-row" data-jp="${esc(c.code)}">
        <span>${i + 1}</span>
        <span><b>${esc(c.name)}</b><span class="co-tick">${esc(c.ticker)}</span></span>
        <span>${yen(c.marketCap)}</span>
        <span class="${c.pb != null && c.pb < 1 ? 'pos' : ''}">${c.pb != null ? c.pb.toFixed(2) + '×' : '—'}</span>
        <span>${c.pe != null ? c.pe.toFixed(1) : '—'}</span>
        <span class="${(c.roe || 0) >= 0 ? 'pos' : 'neg'}">${c.roe != null ? c.roe.toFixed(1) + '%' : '—'}</span>
        <span>${jpYield(c) != null ? jpYield(c).toFixed(2) + '%' : '—'}</span>
        <span class="${(c.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${chg(c.chgYtd)}</span>
      </button>`).join('')
    + `<div class="macro-note">${esc(active.note || '')}</div>`;
}

function renderJapanScreener(all, d) {
  const el = $('co-body'); if (!el) return;
  syncCoTools();
  const sectors = [...new Set(all.map((c) => c.sector))].sort();
  const matched = all.filter(jpMatches);
  const key = { cap: (c) => c.marketCap, pe: (c) => c.pe, pb: (c) => c.pb, roe: (c) => c.roe, yield: (c) => jpYield(c), ytd: (c) => c.chgYtd };
  // Bigger is better for cap, ROE, yield and YTD; smaller is better for P/E and P/B.
  const dir = jpSort === 'pe' || jpSort === 'pb' ? 1 : -1;
  const kf = key[jpSort] || key.cap;
  // A blank is not a low number: it goes last whichever way the column runs.
  matched.sort((a, b) => {
    const x = kf(a), y = kf(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir;
  });
  const rows = matched;

  const max = Math.max(...all.map((c) => c.marketCap || 0), 1);
  const opt = (v, label, cur) => `<option value="${v}" ${String(cur || '') === String(v) ? 'selected' : ''}>${label}</option>`;
  const jpChips = $('co-chips');
  if (jpChips) {
    const nJp = Object.values(jpFilter).filter((v) => v != null && v !== '').length + (jpQuery.trim() ? 1 : 0);
    const activeJp = nJp || (jpPreset ? 1 : 0);
    jpChips.innerHTML = coFilterBar({
      presets: JP_PRESETS, preset: jpPreset, presetAttr: 'data-jppreset',
      selects: [
        { key: 'sector', label: 'SECTOR', opts: [['', 'All'], ...sectors.map((x) => [x, x.toUpperCase()])], cur: jpFilter.sector, attr: 'data-jpf' },
        { key: 'pe', label: 'P/E', opts: [['', 'Any'], ['lt10', '<10'], ['10to15', '10–15'], ['15to25', '15–25'], ['gt25', '>25']], cur: jpFilter.pe, attr: 'data-jpf' },
        { key: 'roe', label: 'ROE', opts: [['', 'Any'], ['10', '>10%'], ['15', '>15%']], cur: jpFilter.roe, attr: 'data-jpf' },
        { key: 'yield', label: 'YIELD', opts: [['', 'Any'], ['2', '>2%'], ['3', '>3%'], ['4', '>4%']], cur: jpFilter.yield, attr: 'data-jpf' },
        { key: 'sort', label: 'SORT', opts: [['cap', 'Market cap'], ['pe', 'P/E low'], ['pb', 'P/B low'], ['roe', 'ROE high'], ['yield', 'Yield high'], ['ytd', 'YTD best']], cur: jpSort, attr: 'data-jpf' },
      ],
      clearAttr: 'data-jppreset', clearValue: 'clear', active: activeJp, asOf: asOfText(all, 'priceDate'),
    });
  }
  el.innerHTML = jpViewsBar()
    + `<div class="co-hrow"><span>#</span><span></span><span>COMPANY</span><span>MARKET CAP</span><span>P/E</span><span>ROE</span></div>`
    + (rows.length ? '' : `<div class="macro-note">No company matches those filters.</div>`)
    + `<div id="jp-rows"></div>`;
  // 1,500 rows in one innerHTML blocks the paint. The first chunk lands immediately and the rest
  // append over the next frames, so a tab switch feels instant and every row still ends up there.
  const host = document.getElementById('jp-rows');
  const noteHtml = `<div class="macro-note">${rows.length === all.length ? `all ${all.length}` : `${rows.length} of ${all.length}`} companies · ${esc(d.universe || '')} · P/E and ROE are trailing twelve months, from JPX · forward P/E uses the company's own guidance · market cap excludes treasury shares · FX ${d.fx && d.fx.rate ? d.fx.rate.toFixed(2) : '—'} JPY per USD.</div>`;
  const rowHtml = (c, i) => `<button class="co-row" data-jp="${esc(c.code)}">
        <span class="co-rank">${i + 1}</span>
        ${jpMono(c)}
        <span class="co-id"><b>${esc(c.name)}</b>
          <span class="co-meta">
            <span class="co-tick">${esc(c.ticker)}</span>
            <span class="jp-sector">${esc(c.sector)}</span>
            <span class="co-px">${yen(c.price)}</span>
            <em class="${(c.chg1d || 0) >= 0 ? 'pos' : 'neg'}">${c.chg1d == null ? '—' : `${c.chg1d >= 0 ? '+' : ''}${c.chg1d.toFixed(1)}%`}</em>
            <em class="${(c.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${c.chgYtd == null ? '—' : `${c.chgYtd >= 0 ? '+' : ''}${c.chgYtd.toFixed(1)}%`} ${c.chgYtdBasis === 'YTD' ? 'YTD' : 'SINCE ' + String(c.chgYtdBasis || '').slice(6)}</em>
          </span></span>
        <span class="co-cap">${yen(c.marketCap)}<i class="co-bar"><i style="width:${Math.max(2, ((c.marketCap || 0) / max) * 100)}%"></i></i></span>
        <span class="co-pe" title="${c.peBasis === 'TTM' ? 'trailing twelve months, from JPX' : 'fiscal year'}">${c.pe != null ? c.pe.toFixed(1) : '—'}</span>
        <span class="co-mar ${c.roe == null ? 'dimtext' : c.roe >= 0 ? 'pos' : 'neg'}">${c.roe == null ? '—' : `${c.roe.toFixed(1)}%`}</span>
      </button>`;
  if (!host) return;
  if (!rows.length) { host.insertAdjacentHTML('afterend', '<div class="macro-note">No company matches those filters.</div>' + noteHtml); return; }
  let at = 0;
  const paint = () => {
    host.insertAdjacentHTML('beforeend', rows.slice(at, at + 250).map((c, j) => rowHtml(c, at + j)).join(''));
    at += 250;
    if (at < rows.length) requestAnimationFrame(paint);
    else host.insertAdjacentHTML('afterend', noteHtml);
  };
  paint();
}

function jpBand(label, current, b, unit) {
  if (!b || current == null) return '';
  const span = b.max - b.min || 1;
  const pos = Math.max(0, Math.min(100, ((current - b.min) / span) * 100));
  const med = Math.max(0, Math.min(100, ((b.median - b.min) / span) * 100));
  return `<div class="jp-band">
      <span class="jp-band-k">${label}</span>
      <span class="jp-band-v">${current.toFixed(2)}${unit}</span>
      <span class="jp-band-track" title="Range over the last ${b.years} years">
        <i class="jp-band-med" style="left:${med}%"></i>
        <i class="jp-band-dot" style="left:${pos}%"></i>
      </span>
      <span class="jp-band-r">${b.min.toFixed(1)}–${b.max.toFixed(1)}${unit} · median ${b.median.toFixed(1)}${unit} · <b>${b.percentile}th</b> percentile of ${b.years}y</span>
    </div>`;
}

const jpDetailCache = new Map();
async function renderJapanPage(stub) {
  const el = $('co-body'); if (!el) return;
  let c = jpDetailCache.get(stub.code);
  if (!c) {
    el.innerHTML = stLoading('Reading the filing…');
    try { c = await jget(`/api/japan/company/${encodeURIComponent(stub.code)}`, 1800000); } catch { c = null; }
    if (c) jpDetailCache.set(stub.code, c);
  }
  if (!c) { el.innerHTML = stError('Couldn\u2019t load this company \u2014 retrying.'); return; }
  return renderJapanPageBody(c);
}

function renderJapanPageBody(c) {
  const el = $('co-body'); if (!el) return;
  const sub = $('deals-sub'); if (sub) sub.textContent = `${c.name} · ${c.ticker} · TSE Prime`;
  const v = c.verification || {};
  const vtext = v.status === 'verified'
    ? '✓ CROSS-CHECKED · P/B REBUILT FROM THE FILING AGREES WITH JPX'
    : v.status === 'disputed'
      ? `P/B DIFFERS FROM JPX · ${Math.round(((v.fields && v.fields.equity && v.fields.equity.diff) || 0) * 100)}% APART · BOTH VALUES BELOW`
      : 'NOT CROSS-CHECKED';
  const vcls = v.status === 'verified' ? ' ok' : v.status === 'disputed' ? ' bad' : '';
  const d = c.dividend;
  const cell = (k, val, title, cls = '') => `<div class="co-stat" title="${esc(title)}"><span class="co-k">${k}</span><span class="co-v ${cls}">${val}</span></div>`;
  const chg = (x) => (x == null ? '' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  const pbOurs = v.fields && v.fields.equity ? v.fields.equity.ours : null;
  const starred = watchlist().includes(`jp:${c.code}`);

  el.innerHTML = `<div class="ma-crumb"><button class="ma-back" data-jpback="1">← COMPANIES</button> <span>${esc(c.ticker)}</span><span class="mb-tag">JAPAN</span></div>`
    + `<div class="co-head">${jpMono(c)}
        <div><div class="co-name">${esc(c.name)}</div>
        <div class="co-sub">${esc(c.ticker)}${c.sector ? ' · ' + esc(c.sector) : ''}${c.size ? ' · ' + esc(c.size) : ''}${c.nameJa ? ' · ' + esc(c.nameJa) : ''}</div>
        ${c.description ? `<div class="co-desc">${esc(c.description)}${c.descSource === 'generated' ? ' <em class="co-approx" title="Written from the filing data, not a company profile">generated</em>' : ''}</div>` : ''}
        ${c.brands && c.brands.length ? `<div class="jp-brands">${c.brands.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : ''}</div>
        <button class="co-star ${starred ? 'on' : ''}" data-jpstar="${esc(c.code)}" title="${starred ? 'Unpin from watchlist' : 'Pin to watchlist'}">${starred ? '★' : '☆'}</button>
      </div>`
    + `<div class="co-price">
        <span class="co-price-v">${yen(c.price)}</span>
        <span class="co-price-c ${c.chg1d >= 0 ? 'pos' : 'neg'}">${c.chg1d == null ? '' : `${chg(c.chg1d)} today`}</span>
        <span class="co-price-c ${c.chg6m >= 0 ? 'pos' : 'neg'}">${c.chg6m == null ? '' : `${chg(c.chg6m)} 6M`}</span>
        <span class="co-price-c ${c.chgYtd >= 0 ? 'pos' : 'neg'}">${c.chgYtd == null ? '' : `${chg(c.chgYtd)} ${c.chgYtdBasis === 'YTD' ? 'YTD' : 'since ' + String(c.chgYtdBasis || '').slice(6)}`}</span>
        <span class="dimtext">${c.priceDate ? `as of ${c.priceDate}` : ''}</span>
        ${japanData && japanData.topix && japanData.topix.chgYtd != null ? `<span class="dimtext" title="TOPIX, the exchange's own index">TOPIX ${japanData.topix.chgYtd >= 0 ? '+' : ''}${japanData.topix.chgYtd.toFixed(1)}% YTD</span>` : ''}
        ${c.vsTopix && c.vsTopix.ytd != null ? `<span class="dimtext ${c.vsTopix.ytd >= 0 ? 'pos' : 'neg'}" title="Percentage points above or below TOPIX over the same window">${c.vsTopix.ytd >= 0 ? '+' : ''}${c.vsTopix.ytd.toFixed(1)}pp vs TOPIX</span>` : ''}
      </div>`
    + `<div class="co-verif${vcls}">${vtext}</div>`
    + `<div class="co-stats co-stats-12">
        ${cell('MARKET CAP', yen(c.marketCap), 'Shares outstanding less treasury, at the last close — JPX\u2019s definition')}
        ${cell('MARKET CAP · USD', c.marketCapUsd ? `$${(c.marketCapUsd / 1e9).toFixed(1)}B` : '—', 'Converted at the current USD/JPY rate')}
        ${cell(`P/E · ${c.peBasis || 'FY'}`, c.pe != null ? `${c.pe.toFixed(2)}×${c.sectorMedian && c.sectorMedian.pe ? ` <em class="co-approx" title="Median across ${c.sectorMedian.count} companies in ${esc(c.sector)}">sector ${c.sectorMedian.pe.toFixed(1)}×</em>` : ''}` : '—', c.peBasis === 'TTM' ? 'Trailing twelve months, computed by JPX from disclosed earnings' : 'Market cap ÷ fiscal-year net profit')}
        ${cell('P/B', c.pb != null ? `${c.pb.toFixed(2)}×${c.sectorMedian && c.sectorMedian.pb ? ` <em class="co-approx" title="Median across ${c.sectorMedian.count} companies in ${esc(c.sector)}">sector ${c.sectorMedian.pb.toFixed(1)}×</em>` : ''}` : '—', 'Market cap ÷ shareholders\u2019 equity attributable to the parent')}
        ${cell('RETURN ON EQUITY', c.roe != null ? `${c.roe.toFixed(1)}%` : '—', 'Trailing twelve months, from JPX', c.roe >= 0 ? 'pos' : 'neg')}
        ${cell('FORWARD P/E', c.forwardPe != null ? `${c.forwardPe.toFixed(1)}×` : '—', 'Market cap ÷ the company\u2019s own full-year profit forecast — guidance, not consensus')}
        ${cell(c.marginBasis === 'ordinary' ? 'ORDINARY MARGIN' : 'OPERATING MARGIN', c.opMargin != null ? `${c.opMargin.toFixed(1)}%` : '—', c.marginBasis === 'ordinary' ? 'Ordinary profit ÷ net sales — the line Japanese financials report' : 'Operating profit ÷ net sales, fiscal year', c.opMargin >= 0 ? 'pos' : 'neg')}
        ${cell('DIVIDEND YIELD', d && d.yield != null ? `${d.yield.toFixed(2)}%` : '—', d && d.perShare != null ? `¥${d.perShare} per share for the fiscal year${d.forecast ? `, forecast ¥${d.forecast}` : ''}` : 'No dividend disclosed')}
        ${cell('NET SALES', yen(c.sales), 'Fiscal year, as reported')}
        ${cell(c.op != null ? 'OPERATING PROFIT' : 'ORDINARY PROFIT', yen(c.op != null ? c.op : c.odp), c.op != null ? 'Fiscal year, as reported' : 'Banks report ordinary profit instead of operating profit', (c.op != null ? c.op : c.odp) >= 0 ? 'pos' : 'neg')}
        ${cell('NET PROFIT', yen(c.np), 'Fiscal year, attributable to owners of the parent', c.np >= 0 ? 'pos' : 'neg')}
        ${cell('CASH AFTER INVESTING', yen(c.fcf), 'Operating cash flow + investing cash flow — capex sits inside investing and is not broken out in the summary')}
      </div>`
    + (c.bands && (c.bands.pe || c.bands.pb) ? `<div class="jp-bands">
        ${jpBand('P/E', c.pe, c.bands.pe, '×')}
        ${jpBand('P/B', c.pb, c.bands.pb, '×')}
      </div>` : '')
    + `<div class="co-stats co-stats-12">
        ${c.odp != null
          ? cell('ORDINARY PROFIT', yen(c.odp), 'Operating profit plus non-operating items — the line Japanese GAAP filers report; IFRS filers do not have it', c.odp >= 0 ? 'pos' : 'neg')
          : cell('TOTAL ASSETS', yen(c.ta), 'As reported — banks carry their loan book here')}
        ${cell('SHAREHOLDERS\u2019 EQUITY', yen(c.eqLatest), `Attributable to the parent${c.eqLatestPeriod ? `, as of ${c.eqLatestPeriod}` : ''}`)}
        ${cell('EQUITY RATIO', c.eqAr != null ? `${(c.eqAr * 100).toFixed(1)}%` : '—', 'Equity ÷ total assets, as reported')}
        ${cell('PAYOUT RATIO', d && d.payoutRatio != null ? `${(d.payoutRatio * 100).toFixed(0)}%` : '—', 'Dividends ÷ net profit for the fiscal year')}
      </div>`
    + `<div class="co-stats co-stats-12">
        ${cell('DAILY TRADED VALUE', c.liquidity ? yen(c.liquidity.avg) : '—', `Average over the last ${(c.liquidity && c.liquidity.days) || 30} sessions — what actually changes hands, not what is listed`)}
        ${cell('CASH', yen(c.cash), 'Cash and equivalents, as reported')}
        ${cell('OPERATING CASH FLOW', yen(c.cfo), 'Fiscal year, as reported')}
        ${cell('FINANCING CASH FLOW', yen(c.cff), 'Dividends, buybacks and borrowings, net')}
      </div>`
    + `<div class="co-ranges">
        <span class="co-cmp-l">COMPARE</span><input class="co-cmp" id="jp-cmp" placeholder="company name, e.g. toyota" value="${esc(cmpCode(jpCompare))}" autocomplete="off">
        <button class="co-cmp-clear${jpCompare ? '' : ' hidden'}" id="jp-cmp-clear" data-cmpclear="jp" type="button" title="Clear comparison" aria-label="Clear comparison">×</button>
        <div class="co-sugg" id="jp-sugg"></div>
        ${[['1m', '1M'], ['3m', '3M'], ['6m', '6M'], ['ytd', 'YTD'], ['1y', '1Y'], ['5y', '5Y']].map(([k, t]) => `<button class="ma-chip${jpRange === k ? ' on' : ''}" data-jprange="${k}">${t}</button>`).join('')}
      </div>`
    + `<div class="co-rets" id="jp-rets"></div>`
              + `<div class="co-chartwrap"><div class="co-big" id="jp-big"></div><canvas id="jp-chart"></canvas></div>`
    + '<div id="jp-peers-x"></div>'
    + jpQuartersHtml(c)
    + jpHistoryHtml(c)
    + jpPeersHtml(c)
    + `<div class="macro-note">
        Fiscal year ending ${esc(c.period || '—')} · statement figures from the company's summary of financial statements (J-Quants); P/E, P/B and ROE from JPX's own valuation file.
        ${pbOurs != null && v.status === 'disputed' ? `Our P/B from the filing is ${pbOurs.toFixed(2)}× against JPX's ${c.pb.toFixed(2)}×.` : ''}
        ${c.guidance ? `Guidance for FY ${esc(c.guidance.fy || '—')}: sales ${yen(c.guidance.sales)}, operating profit ${yen(c.guidance.op)}, net profit ${yen(c.guidance.np)}.` : 'No company forecast on file.'}
        ${c.guidanceVsDelivered ? ` FY ${esc(c.guidanceVsDelivered.fy)}: the company guided ${yen(c.guidanceVsDelivered.forecast)} and delivered ${yen(c.guidanceVsDelivered.actual)} (${c.guidanceVsDelivered.deltaPct >= 0 ? '+' : ''}${c.guidanceVsDelivered.deltaPct}%).` : ''}
        ${c.revisions ? ` This year the forecast moved ${c.revisions.moves} time${c.revisions.moves > 1 ? 's' : ''} — ${c.revisions.up} up, ${c.revisions.down} down — from ${yen(c.revisions.first)} to ${yen(c.revisions.last)} (${c.revisions.deltaPct >= 0 ? '+' : ''}${c.revisions.deltaPct}%).` : ''}
        ${c.earnings ? ` Next results: ${esc(c.earnings.date)} (${esc(c.earnings.quarter || 'scheduled')}).` : ''}
        Currency is yen throughout; the USD figure is a conversion, not a separate quote.${c.descSource === 'profile' ? ' Company description from stockanalysis.com.' : ''}
      </div>`;
  drawJpPrice(c);
  drawJpQuarters(c);
  fillPeers(`jp:${c.ticker}`, 'jp-peers-x');
}

// Quarters get their own section under the price chart: a chart plus a table an investor can read
// line by line, because the shape of the year matters more than the annual total.
function jpQuartersHtml(c) {
  const q = c.quarters || [];
  if (q.length < 2) return '';
  const yoy = (x) => {
    const target = Date.parse(x.d);
    const prev = q.find((y) => y.q === x.q && Math.abs(Date.parse(y.d) - (target - 365.25 * 864e5)) < 45 * 864e5);
    return prev && prev.sales && x.sales ? ((x.sales / prev.sales) - 1) * 100 : null;
  };
  const rows = [...q].reverse().map((x) => {
    const y = yoy(x);
    const margin = x.sales && x.op != null ? (x.op / x.sales) * 100 : null;
    return `<tr>
        <td>${esc(x.d)} <em>${esc(x.q)}</em></td>
        <td>${yen(x.sales)}</td>
        <td class="${y == null ? 'dimtext' : y >= 0 ? 'pos' : 'neg'}">${y == null ? '—' : `${y >= 0 ? '+' : ''}${y.toFixed(1)}%`}</td>
        <td class="${x.op == null ? 'dimtext' : x.op >= 0 ? 'pos' : 'neg'}">${x.op == null ? '—' : yen(x.op)}</td>
        <td>${margin == null ? '—' : `${margin.toFixed(1)}%`}</td>
        <td class="${x.np == null ? 'dimtext' : x.np >= 0 ? 'pos' : 'neg'}">${x.np == null ? '—' : yen(x.np)}</td>
      </tr>`;
  }).join('');
  return `<div class="jp-q">
      <div class="jp-q-head"><span class="ph-t">QUARTERLY RESULTS</span><span class="dimtext">${q.length} quarters · ¥ yen</span></div>
      <div class="co-chartwrap"><canvas id="jp-q-chart"></canvas></div>
      <table class="jp-q-table">
        <thead><tr><th>QUARTER</th><th>NET SALES</th><th>YOY</th><th>OPERATING PROFIT</th><th>MARGIN</th><th>NET PROFIT</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="macro-note">Standalone quarters, derived from the cumulative year-to-date figures companies publish (Q2 = 2Q − 1Q, Q4 = FY − 3Q). Year-on-year compares the same quarter a year earlier.</div>
    </div>`;
}

// The companies this one is actually compared with: same exchange sector, nearest by size.
function jpPeersHtml(c) {
  const all = (japanData && japanData.companies) || [];
  if (!all.length || !c.marketCap) return '';
  const cap = c.marketCap;
  const pool = all.filter((x) => x.code !== c.code && x.sector === c.sector && x.marketCap);
  // Within roughly a quarter to two and a half times the size — that is the comparison that means
  // something. If the sector is thin, fall back to the sector alone rather than showing nothing.
  let near = pool.filter((x) => x.marketCap >= cap * 0.4 && x.marketCap <= cap * 2.5);
  if (near.length < 3) near = pool;
  const peers = near
    .sort((a, b) => Math.abs(Math.log(a.marketCap / cap)) - Math.abs(Math.log(b.marketCap / cap)))
    .slice(0, 6);
  if (!peers.length) return '';
  const median = (xs) => {
    const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
  };
  const peerPe = median(peers.map((x) => x.pe));
  const peerPb = median(peers.map((x) => x.pb));
  const chg = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  const row = (x, i) => `<button class="jp-bank-row" data-jp="${esc(x.code)}">
      <span>${i + 1}</span>
      <span><b>${esc(x.name)}</b><span class="co-tick">${esc(x.ticker)}</span></span>
      <span>${yen(x.marketCap)}</span>
      <span>${x.pe != null ? x.pe.toFixed(1) : '—'}</span>
      <span>${x.pb != null ? x.pb.toFixed(2) : '—'}</span>
      <span class="${(x.roe || 0) >= 0 ? 'pos' : 'neg'}">${x.roe != null ? x.roe.toFixed(1) + '%' : '—'}</span>
      <span>${jpYield(x) != null ? jpYield(x).toFixed(2) + '%' : '—'}</span>
      <span class="${(x.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${chg(x.chgYtd)}</span>
    </button>`;
  const rel = (mine, theirs, dp, unit) => {
    if (mine == null || theirs == null) return '—';
    const pct = (mine / theirs - 1) * 100;
    return `${mine.toFixed(dp)}${unit} vs ${theirs.toFixed(dp)}${unit} <em class="co-approx">${Math.abs(pct).toFixed(0)}% ${pct >= 0 ? 'above' : 'below'}</em>`;
  };
  return `<div class="jp-q">
      <div class="jp-q-head"><span class="ph-t">PEERS</span><span class="dimtext">${esc(c.sector)} · nearest ${peers.length} by size</span></div>
      <div class="co-hrow jp-bank-hrow"><span>#</span><span>COMPANY</span><span>CAP</span><span>P/E</span><span>P/B</span><span>ROE</span><span>YIELD</span><span>YTD</span></div>
      <div class="jp-q-head" style="padding:8px 12px 4px"><span class="dimtext">THIS COMPANY</span><span class="dimtext">P/E ${rel(c.pe, peerPe, 1, '×')} · P/B ${rel(c.pb, peerPb, 2, '×')}</span></div>
      ${peers.map(row).join('')}
      <div class="macro-note">Same exchange sector, sized within a quarter to two and a half times this company. Peer medians are equal-weighted; a company that looks cheap against the market can still be expensive against its own industry.</div>
    </div>`;
}

// Five reported fiscal years, so a single year can be read against its own record.
function jpHistoryHtml(c) {
  const h = c.history || [];
  if (h.length < 2) return '';
  const rows = [...h].reverse().map((x) => {
    const roe = x.n != null && x.q ? (x.n / x.q) * 100 : null;
    const eqAr = x.q != null && x.a ? (x.q / x.a) * 100 : null;
    return `<tr>
        <td>${esc(x.y)}</td>
        <td>${yen(x.s)}</td>
        <td class="${x.o == null ? 'dimtext' : x.o >= 0 ? 'pos' : 'neg'}">${x.o == null ? '—' : yen(x.o)}</td>
        <td class="${x.n == null ? 'dimtext' : x.n >= 0 ? 'pos' : 'neg'}">${x.n == null ? '—' : yen(x.n)}</td>
        <td class="${roe == null ? 'dimtext' : roe >= 0 ? 'pos' : 'neg'}">${roe == null ? '—' : `${roe.toFixed(1)}%`}</td>
        <td>${eqAr == null ? '—' : `${eqAr.toFixed(1)}%`}</td>
        <td>${x.d == null ? '—' : `¥${x.d}`}</td>
      </tr>`;
  }).join('');
  return `<div class="jp-q">
      <div class="jp-q-head"><span class="ph-t">FIVE-YEAR RECORD</span><span class="dimtext">${h.length} fiscal years · ¥ yen</span></div>
      <table class="jp-q-table">
        <thead><tr><th>FISCAL YEAR</th><th>NET SALES</th><th>OP PROFIT</th><th>NET PROFIT</th><th>ROE</th><th>EQUITY RATIO</th><th>DIV / SHARE</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="macro-note">As reported in each year's summary of financial statements. ROE and the equity ratio are computed from the reported figures, not restated for later share issues.</div>
    </div>`;
}

// The price chart is fetched per company and range, the same way the US chart is.
async function drawJpPrice(c, range = jpRange) {
  if (charts['jp-chart']) { try { charts['jp-chart'].destroy(); } catch {} delete charts['jp-chart']; }
  coLong('jp:' + c.code).then((long) => { if (long) paintReturns('jp-rets', 'jp-big', long, range, WINDOWS_5Y, 'jprange'); }).catch(() => {});
  const wrap = $('jp-chart') && $('jp-chart').parentElement;
  const fetchOne = async (code) => {
    try { return await jget(`/api/japan-chart?code=${encodeURIComponent(code)}&range=${encodeURIComponent(range)}`, 600000); } catch { return null; }
  };
  const ch = await fetchOne(c.code);
  if (!ch || !ch.dates || ch.dates.length < 2) {
    if (wrap) wrap.setAttribute('data-empty', `No price history for ${c.ticker} over ${range.toUpperCase()}.`);
    return;
  }
  if (wrap) wrap.removeAttribute('data-empty');

  // A second company is indexed to 100 at the first shared date, the way the US chart compares.
  let other = null;
  if (jpCompare && cmpCode(jpCompare).toUpperCase() !== String(c.code).toUpperCase()) {
    if (jpCompare.toUpperCase() === 'TOPIX' && japanData && japanData.topix && japanData.topix.series) {
      const tmap = new Map(japanData.topix.series.map((p) => [p.d, p.c]));
      other = { dates: ch.dates, closes: ch.dates.map((d) => (tmap.has(d) ? tmap.get(d) : null)) };
    } else {
      other = await seriesFor(jpCompare, range);
    }
  }
  if (other && other.dates && other.dates.length > 1) {
    const bmap = new Map(other.dates.map((d, i) => [d, other.closes[i]]));
    const dates = ch.dates.filter((d, i) => ch.closes[i] != null && bmap.get(d) != null);
    if (dates.length > 1) {
      const a0 = ch.closes[ch.dates.indexOf(dates[0])];
      const b0 = bmap.get(dates[0]);
      // The comparison may come from another market now, so look it up by ref as well as by code.
      const peer = jpCompare.toUpperCase() === 'TOPIX' ? { name: 'TOPIX' }
        : ((japanData && japanData.companies) || []).find((x) => x.code === jpCompare || `jp:${x.ticker}` === jpCompare)
          || ((koreaData && koreaData.companies) || []).find((x) => `kr:${x.ticker}` === jpCompare)
          || ((companiesData && companiesData.companies) || []).find((x) => `us:${x.ticker}` === jpCompare);
      mountChart('jp-chart', {
        labels: dates,
        datasets: [
          line(`${c.ticker} · ${c.name.slice(0, 14)}`, dates.map((d) => (ch.closes[ch.dates.indexOf(d)] / a0) * 100), CT.c1),
          line(peer ? `${cmpCode(jpCompare)} · ${peer.name.slice(0, 14)}` : cmpCode(jpCompare), dates.map((d) => (bmap.get(d) / b0) * 100), CT.c2),
        ],
      }, baseOptions({ dp: 0, dateAxis: true, yTitle: 'indexed to 100' }));
      return;
    }
  }
  mountChart('jp-chart', { labels: ch.dates, datasets: [line(`${c.ticker} · JPY · ${range.toUpperCase()}`, ch.closes, CT.c1)] }, baseOptions({ dp: 0, dateAxis: true }));
}

function drawJpQuarters(c) {
  if (charts['jp-q-chart']) { try { charts['jp-q-chart'].destroy(); } catch {} delete charts['jp-q-chart']; }
  const q = c.quarters || [];
  if (q.length < 2) return;
  mountChart('jp-q-chart', {
    labels: q.map((x) => x.d),
    datasets: [
      { type: 'bar', label: 'Net sales', data: q.map((x) => (x.sales == null ? null : x.sales / 1e9)), backgroundColor: '#1b2733', borderColor: '#2a3440', borderWidth: 1, yAxisID: 'y', order: 2 },
      { type: 'line', label: 'Operating profit', data: q.map((x) => (x.op == null ? null : x.op / 1e9)), borderColor: CT.c1, backgroundColor: 'transparent', tension: 0.25, pointRadius: 2, yAxisID: 'y1', order: 1 },
    ],
  }, baseOptions({ dp: 0, yTitle: '¥bn sales', y1Title: '¥bn profit', dateAxis: true }));
}

// --- Korea: KOSPI, from DART (FSS) -------------------------------------------------------------
// Same three views as the other two markets. What Korea does not have is guidance — Korean companies
// do not publish full-year forecasts — so there is no forward P/E and no guidance-versus-delivered.
let koreaData = null, krSel = null, krQuery = '';
// Every market render takes a token. If you switch again while one is still fetching, the older one
// bails instead of painting over the market you actually chose.
let renderSeq = 0;
const takeToken = () => ++renderSeq;
const stale = (t) => t !== renderSeq;
let krRange = (() => { try { return localStorage.getItem('oilbasis.krRange') || '1y'; } catch { return '1y'; } })();
let krPreset = null, krSector = 'all', krCompare = '';
let krSort = (() => { try { return localStorage.getItem('oilbasis.krSort') || 'cap'; } catch { return 'cap'; } })();
let krFilter = (() => { try { return JSON.parse(localStorage.getItem('oilbasis.krFilter') || '{}'); } catch { return {}; } })();
const saveKrFilter = () => { try { localStorage.setItem('oilbasis.krFilter', JSON.stringify(krFilter)); } catch {} };
let krView = (() => { try { return localStorage.getItem('oilbasis.krView') || 'market'; } catch { return 'market'; } })();
let krMktRange = (() => { try { return localStorage.getItem('oilbasis.krMktRange') || '1y'; } catch { return '1y'; } })();
let krTheme = (() => { try { return localStorage.getItem('oilbasis.krTheme') || 'semis'; } catch { return 'semis'; } })();

const won = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `₩${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e8) return `₩${(v / 1e8).toFixed(1)}B`;
  if (a >= 1e4) return `₩${(v / 1e4).toFixed(0)}만`;
  return `₩${Math.round(v).toLocaleString('en-US')}`;
};
const wonPx = (v) => (v == null || !Number.isFinite(v) ? '—' : `₩${Math.round(v).toLocaleString('en-US')}`);
const krMono = (c) => coMono({ ticker: String(c.nameEn || c.name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2) || 'KR', name: c.name });
const krName = (c) => c.nameEn || c.name;

// Resolve a compare reference to a price series, whichever market it lives in.
//   AAPL → the current market · us:AAPL · jp:7203 · kr:005930
// Cross-market peers for the chart. Same broad sector, nearest size, different market — clicking one
// puts it on the same indexed-100 chart, which is the comparison that actually answers "is this cheap?".
// The compare box takes a company name, not a ref. Type "jpmorgan", pick the suggestion, the chart
// redraws. The server does the matching across all three markets so the client needs no index.
let suggTimer = null;
async function showSuggestions(input, boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const q = String(input.value || '').trim();
  if (q.length < 2) { box.innerHTML = ''; box.classList.remove('on'); return; }
  let d = null;
  try { d = await jget('/api/search?q=' + encodeURIComponent(q) + '&limit=6', 120000); } catch { d = null; }
  const results = (d && d.results) || [];
  if (!results.length) { box.innerHTML = `<div class="co-sugg-empty dimtext">No company matches “${esc(q)}”.</div>`; box.classList.add('on'); return; }
  box.innerHTML = results.map((r) => `<button type="button" class="co-sugg-row" data-sugg="${esc(r.ref)}">
      <b>${esc(r.ticker)}</b><span>${esc(r.name)}</span><em>${esc(r.market.toUpperCase())}</em></button>`).join('');
  box.classList.add('on');
}
function hideSuggestions(boxId) {
  const box = document.getElementById(boxId);
  if (box) { box.innerHTML = ''; box.classList.remove('on'); }
}
// Turn whatever was typed into a ref: a bare ticker, a market:ref, or a company name.
async function resolveCompare(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = /^(us|jp|kr):([A-Za-z0-9.\-]+)$/.exec(raw);
  if (m) return `${m[1].toLowerCase()}:${m[2]}`;
  let d = null;
  try { d = await jget('/api/search?q=' + encodeURIComponent(raw) + '&limit=1', 120000); } catch { d = null; }
  const hit = d && d.results && d.results[0];
  return hit ? hit.ref : null;
}

const krRef = (code) => {
  const c = (koreaData && koreaData.companies || []).find((x) => x.code === code || x.ticker === code);
  return c && c.ticker ? `kr:${c.ticker}` : (code ? `kr:${code}` : '');
};
const currentCmpRef = () => (coRegion === 'jp'
  ? (jpSel ? `jp:${jpSel}` : '')
  : coRegion === 'kr'
    ? krRef(krSel)
    : (coTicker ? `us:${coTicker}` : ''));

function syncCmpClear(region) {
  const on = region === 'jp' ? !!jpCompare : region === 'kr' ? !!krCompare : !!coCompare;
  const b = $(region + '-cmp-clear');
  if (b) b.classList.toggle('hidden', !on);
}

// Remove the comparison without leaving the page. The input keeps its hint; the chart redraws alone.
function clearCompare(region = coRegion) {
  if (region === 'jp') {
    jpCompare = '';
    const inp = $('jp-cmp'); if (inp) inp.value = '';
    hideSuggestions('jp-sugg'); syncCmpClear('jp');
    const cur = (japanData && japanData.companies || []).find((x) => x.code === jpSel);
    if (cur) drawJpPrice(cur, jpRange);
  } else if (region === 'kr') {
    krCompare = '';
    const inp = $('kr-cmp'); if (inp) inp.value = '';
    hideSuggestions('kr-sugg'); syncCmpClear('kr');
    const cur = (koreaData && koreaData.companies || []).find((x) => x.code === krSel);
    if (cur) drawKrChart(cur, krRange);
  } else {
    coCompare = '';
    const inp = $('co-cmp'); if (inp) inp.value = '';
    hideSuggestions('us-sugg'); syncCmpClear('us');
    if (coTicker) loadCoChart(coTicker, coRange);
  }
}

function setCompare(ref) {
  const clean = String(ref || '').trim();
  if (!clean) return;
  // Picking the company you are already looking at is not a comparison — clear instead of drawing
  // two identical lines.
  if (clean.toLowerCase() === currentCmpRef().toLowerCase()) return clearCompare();
  const label = cmpCode(clean);
  if (coRegion === 'jp') {
    jpCompare = clean;
    const inp = $('jp-cmp'); if (inp) inp.value = label;
    hideSuggestions('jp-sugg'); syncCmpClear('jp');
    const cur = (japanData && japanData.companies || []).find((x) => x.code === jpSel);
    if (cur) drawJpPrice(cur, jpRange);
  } else if (coRegion === 'kr') {
    krCompare = clean;
    const inp = $('kr-cmp'); if (inp) inp.value = label;
    hideSuggestions('kr-sugg'); syncCmpClear('kr');
    const cur = (koreaData && koreaData.companies || []).find((x) => x.code === krSel);
    if (cur) drawKrChart(cur, krRange);
  } else {
    coCompare = clean;
    const inp = $('co-cmp'); if (inp) inp.value = label;
    hideSuggestions('us-sugg'); syncCmpClear('us');
    if (coTicker) loadCoChart(coTicker, coRange, clean);
  }
}

const peerCache = new Map();
async function peersFor(ref) {
  if (!ref) return null;
  if (peerCache.has(ref)) return peerCache.get(ref);
  let d = null;
  try { d = await jget('/api/peers?ref=' + encodeURIComponent(ref), 3600000); } catch { d = null; }
  peerCache.set(ref, d);
  return d;
}
function peersHtml(d) {
  if (!d || !d.peers || !d.peers.length) return '';
  return `<div class="co-peers"><span class="co-peers-l">PEERS IN OTHER MARKETS</span><span class="co-peers-s dimtext">same broad sector, nearest size</span>`
    + d.peers.map((p) => `<button class="co-peer" data-peer="${esc(p.ref)}" title="${esc(p.name)} · ${esc(p.sector)} · ${p.ratio}× the size">`
      + `<b>${esc(p.ref.split(':')[1])}</b> ${esc(String(p.name).slice(0, 22))}<em>${esc(p.market.toUpperCase())}</em></button>`).join('')
    + '</div>';
}
async function fillPeers(ref, slotId) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  const d = await peersFor(ref);
  const html = peersHtml(d);
  if (html) slot.innerHTML = html;
}

async function seriesFor(ref, range) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const parts = raw.includes(':') ? raw.split(':') : [coRegion, raw];
  const mkt = String(parts[0]).toLowerCase();
  const code = parts[1];
  const yRange = range === '1m' ? '1mo' : range === '6m' ? '6mo' : range;
  try {
    if (mkt === 'jp') return await jget(`/api/japan-chart?code=${encodeURIComponent(code)}&range=${encodeURIComponent(range)}`, 600000);
    if (mkt === 'kr') return await jget(`/api/korea/chart?ticker=${encodeURIComponent(code)}&range=${encodeURIComponent(range)}`, 600000);
    return await jget(`/api/company-chart?ticker=${encodeURIComponent(code)}&range=${encodeURIComponent(yRange)}`, 600000);
  } catch { return null; }
}

// One request in flight, not two: the prefetch and the click used to race and both hit the network.
let koreaPromise = null;
async function loadKorea() {
  if (koreaData) return koreaData;
  if (koreaPromise) return koreaPromise;
  koreaPromise = (async () => {
    try { koreaData = await jget('/api/korea', 3600000); }
    // A failed prefetch must not be remembered as "Korea is not built yet": leave the slot empty so
    // the next visit retries instead of rendering an empty market until a reload.
    catch { koreaData = null; }
    finally { koreaPromise = null; }
    return koreaData;
  })();
  return koreaPromise;
}

const krViewsBar = () => '';

async function renderKorea(token = takeToken()) {
  paintCoViews();
  const el = $('co-body'); if (!el) return;
  if (krSel !== krOpenSel) { krCompare = ''; krOpenSel = krSel; }
  syncMarketAccent();
  const noteUs = $('co-note'); if (noteUs) noteUs.classList.add('hidden');
  syncCoTools();
  if (!koreaData) el.innerHTML = stLoading('Loading KOSPI…');
  const d = await loadKorea();
  if (stale(token)) return;
  syncMarketAccent();
  // Preferred share classes carry a price but are not separate companies — same rule as the US.
  const all = ((d && d.companies) || []).filter((c) => !c.shareClass);
  const sub = $('deals-sub');
  if (sub) {
    const what = krView === 'screener' ? 'filter and sort' : krView === 'themes' ? 'curated theme lists' : 'breadth, sectors and KOSPI';
    sub.textContent = all.length ? `${all.length} companies · KOSPI · ₩ KRW · ${what}` : 'KOSPI · DART';
  }
  if (!all.length) {
    el.innerHTML = `<div class="macro-note">Korea is not built yet. With a DART key in the environment, run <code>node scripts/build-korea.mjs</code>.</div>`;
    return;
  }
  const sel = all.find((c) => c.code === krSel);
  if (sel) return renderKoreaPage(sel);
  warmMarkets();
  if (krView === 'market') return renderKoreaMarket(all, d);
  if (krView === 'themes') return renderKoreaThemes(all, d);
  return renderKoreaScreener(all, d);
}

function renderKoreaMarket(all, d) {
  const el = $('co-body'); if (!el) return;
  const m = d.market || {}; const idx = d.index || {};
  const cell = (k, v, t, cls = '') => `<div class="co-stat" title="${esc(t)}"><span class="co-k">${k}</span><span class="co-v ${cls}">${v}</span></div>`;
  const chg = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  const breadth = m.advancing != null ? `<div class="jp-breadth"><span class="pos">${m.advancing} up</span><i><i style="width:${Math.round((m.advancing / Math.max(1, m.advancing + m.declining)) * 100)}%"></i></i><span class="neg">${m.declining} down</span></div>` : '';
  el.innerHTML = krViewsBar()
    + `<div class="jp-market-head"><span class="ph-t">KOSPI</span>
        ${idx.level != null ? `<span class="jp-market-lvl">${idx.level.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>` : '<span class="dimtext">index unavailable</span>'}
        <span class="${(idx.chg1d || 0) >= 0 ? 'pos' : 'neg'}">${chg(idx.chg1d)} today</span>
        <span class="dimtext">${all.length} companies · computed from the constituent set</span></div>`
    + `<div class="co-stats co-stats-12">
        ${cell('TOTAL MARKET CAP', won(m.totalCap), 'Sum of every KOSPI constituent we hold')}
        ${cell('COMPANIES', String(m.companies || all.length), 'KOSPI issues with a price')}
        ${cell('MEDIAN P/E', m.medianPe != null ? `${m.medianPe.toFixed(1)}×` : '—', 'Median — the typical company, not the index')}
        ${cell('MEDIAN P/B', m.medianPb != null ? `${m.medianPb.toFixed(2)}×` : '—', 'Median across the market')}
        ${cell('MEDIAN ROE', m.medianRoe != null ? `${m.medianRoe.toFixed(1)}%` : '—', 'Trailing twelve months, median')}
        ${cell('BELOW BOOK', String(m.belowBook ?? '—'), 'Companies trading under 1× book')}
        ${cell('UP THIS YEAR', String(m.upYtd ?? '—'), 'Companies with a positive year-to-date return')}
      </div>`
    + breadth
    + (idx.series && idx.series.length > 1 ? `<div class="co-rets" id="kr-mkt-rets"></div><div class="co-chartwrap"><canvas id="kr-mkt-chart"></canvas></div>` : '')
    + `<div class="co-hrow jp-mkt-hrow"><span>SECTOR</span><span>N</span><span>CAP</span><span>P/E</span><span>P/B</span><span>ROE</span><span>PAYOUT</span><span>YTD</span></div>`
    + (m.sectors || []).map((x) => `<div class="jp-mkt-row">
        <span>${esc(x.name)}</span><span>${x.count}</span><span>${won(x.cap)}</span>
        <span>${x.pe != null ? x.pe.toFixed(1) : '—'}</span>
        <span class="${x.pb != null && x.pb < 1 ? 'pos' : ''}">${x.pb != null ? x.pb.toFixed(2) : '—'}</span>
        <span class="${(x.roe || 0) >= 0 ? 'pos' : 'neg'}">${x.roe != null ? x.roe.toFixed(1) + '%' : '—'}</span>
        <span>${x.payout != null ? x.payout.toFixed(2) + '%' : '—'}</span>
        <span class="${(x.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${chg(x.chgYtd)}</span>
      </div>`).join('')
    + `<div class="macro-note">Aggregates computed from the ${all.length} KOSPI constituents. Sectors from each company's KSIC industry code. KOSPI level and history from Naver Finance.</div>`;
  if (idx.series && idx.series.length > 1) redrawKoreaIndex();
}

function renderKoreaThemes(all, d) {
  const el = $('co-body'); if (!el) return;
  const themes = (d && d.themes) || [];
  if (!themes.length) { el.innerHTML = krViewsBar() + '<div class="macro-note">No themes loaded.</div>'; return; }
  const active = themes.find((t) => t.id === krTheme) || themes[0];
  const set = new Set(active.tickers || []);
  const rows = all.filter((c) => set.has(c.ticker)).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  const chg = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  el.innerHTML = krViewsBar()
    + `<div class="jp-presets">${themes.map((t) => `<button type="button" data-krtheme="${t.id}" class="${t.id === active.id ? 'on' : ''}">${t.label}</button>`).join('')}</div>`
    + `<div class="jp-market-head"><span class="ph-t">${esc(active.label)}</span><span class="dimtext">${rows.length} companies · curated list</span></div>`
    + `<div class="co-hrow jp-bank-hrow"><span>#</span><span>COMPANY</span><span>CAP</span><span>P/E</span><span>P/B</span><span>ROE</span><span>MARGIN</span><span>YTD</span></div>`
    + rows.map((c, i) => `<button class="jp-bank-row" data-kr="${esc(c.code)}">
        <span>${i + 1}</span>
        <span><b>${esc(krName(c))}</b><span class="co-tick">${esc(c.ticker)}</span></span>
        <span>${won(c.marketCap)}</span>
        <span>${c.pe != null ? c.pe.toFixed(1) : '—'}</span>
        <span class="${c.pb != null && c.pb < 1 ? 'pos' : ''}">${c.pb != null ? c.pb.toFixed(2) : '—'}</span>
        <span class="${(c.roe || 0) >= 0 ? 'pos' : 'neg'}">${c.roe != null ? c.roe.toFixed(1) + '%' : '—'}</span>
        <span>${c.opMargin != null ? c.opMargin.toFixed(1) + '%' : '—'}</span>
        <span class="${(c.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${chg(c.chgYtd)}</span>
      </button>`).join('')
    + `<div class="macro-note">${esc(active.note || '')}</div>`;
}

const KR_PRESETS = [
  { id: 'book', label: 'BELOW BOOK', test: (c) => c.pb != null && c.pb < 1 },
  { id: 'roe', label: 'HIGH ROE', test: (c) => (c.roe || 0) > 12 },
  { id: 'cheap', label: 'CHEAP VS ITSELF', test: (c) => c.bands && c.bands.pe && c.bands.pe.percentile <= 20 },
];

function renderKoreaScreener(all, d) {
  const el = $('co-body'); if (!el) return;
  const q = krQuery.trim().toLowerCase();
  const sectors = [...new Set(all.map((c) => c.sector).filter(Boolean))].sort();
  const preset = KR_PRESETS.find((p) => p.id === krPreset);
  const f = krFilter;
  const rows = all.filter((c) => (!q || `${c.name} ${c.nameEn || ''} ${c.ticker} ${(c.brands || []).join(' ')}`.toLowerCase().includes(q))
    && (krSector === 'all' || c.sector === krSector)
    && (!f.pe || (c.pe != null && (f.pe === 'lt10' ? c.pe < 10 : f.pe === '10to15' ? c.pe >= 10 && c.pe < 15 : f.pe === '15to25' ? c.pe >= 15 && c.pe < 25 : c.pe >= 25)))
    && (!f.roe || (c.roe != null && c.roe >= Number(f.roe)))
    && (!preset || preset.test(c)));
  const sortOf = { cap: (c) => c.marketCap, pe: (c) => c.pe, pb: (c) => c.pb, roe: (c) => c.roe, ytd: (c) => c.chgYtd };
  const dir = krSort === 'pe' || krSort === 'pb' ? 1 : -1;
  const kf = sortOf[krSort] || sortOf.cap;
  const sorted = [...rows].sort((a, b) => {
    const x = kf(a), y = kf(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir;
  });
  const krChips = $('co-chips');
  if (krChips) {
    const nKr = Object.values(f).filter((v) => v != null && v !== '').length + (krSector !== 'all' ? 1 : 0) + (q ? 1 : 0);
    const activeKr = nKr || (krPreset ? 1 : 0);
    krChips.innerHTML = coFilterBar({
      presets: KR_PRESETS, preset: krPreset, presetAttr: 'data-krpreset',
      selects: [
        { key: 'sector', label: 'SECTOR', opts: [['all', 'All'], ...sectors.map((x) => [x, x.toUpperCase()])], cur: krSector, attr: 'data-krf' },
        { key: 'pe', label: 'P/E', opts: [['', 'Any'], ['lt10', '<10'], ['10to15', '10–15'], ['15to25', '15–25'], ['gt25', '>25']], cur: f.pe, attr: 'data-krf' },
        { key: 'roe', label: 'ROE', opts: [['', 'Any'], ['10', '>10%'], ['15', '>15%']], cur: f.roe, attr: 'data-krf' },
        { key: 'sort', label: 'SORT', opts: [['cap', 'Market cap'], ['pe', 'P/E low'], ['pb', 'P/B low'], ['roe', 'ROE high'], ['ytd', 'YTD best']], cur: krSort, attr: 'data-krf' },
      ],
      clearAttr: 'data-krpreset', clearValue: 'clear', active: activeKr, asOf: asOfText(all, 'priceDate'),
    });
  }
  const max = Math.max(...all.map((c) => c.marketCap || 0), 1);
  el.innerHTML = krViewsBar()
    + `<div class="co-hrow"><span>#</span><span></span><span>COMPANY</span><span>MARKET CAP</span><span>P/E</span><span>ROE</span></div>`
    + sorted.map((c, i) => `<button class="co-row" data-kr="${esc(c.code)}">
        <span class="co-rank">${i + 1}</span>
        ${krMono(c)}
        <span class="co-id"><b>${esc(krName(c))}</b>
          <span class="co-meta">
            <span class="co-tick">${esc(c.ticker)}</span>
            <span class="co-px">${wonPx(c.price)}</span>
            <em class="${(c.chg1d || 0) >= 0 ? 'pos' : 'neg'}">${c.chg1d == null ? '—' : `${c.chg1d >= 0 ? '+' : ''}${c.chg1d.toFixed(1)}%`}</em>
            <em class="${(c.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${c.chgYtd == null ? '—' : `${c.chgYtd >= 0 ? '+' : ''}${c.chgYtd.toFixed(1)}%`} YTD</em>
          </span></span>
        <span class="co-cap">${won(c.marketCap)}<i class="co-bar"><i style="width:${Math.max(2, ((c.marketCap || 0) / max) * 100)}%"></i></i></span>
        <span class="co-pe">${c.pe != null ? c.pe.toFixed(1) : '—'}</span>
        <span class="co-mar ${c.roe == null ? 'dimtext' : c.roe >= 0 ? 'pos' : 'neg'}">${c.roe == null ? '—' : `${c.roe.toFixed(1)}%`}</span>
      </button>`).join('')
    + `<div class="macro-note">${rows.length} of ${all.length} · KOSPI · DART statements, Naver prices · P/E is trailing twelve months · FX ${d.fx && d.fx.rate ? d.fx.rate.toFixed(0) : '—'} KRW per USD.</div>`;
}

async function renderKoreaPage(stub) {
  const el = $('co-body'); if (!el) return;
  let c = null;
  el.innerHTML = stLoading('Reading the filing…');
  try { c = await jget(`/api/korea/company/${encodeURIComponent(stub.code)}`, 1800000); } catch { c = null; }
  if (!c) { el.innerHTML = stError('Couldn\u2019t load this company.'); return; }
  const sub = $('deals-sub'); if (sub) sub.textContent = `${krName(c)} · ${c.ticker} · KOSPI`;
  const cell = (k, v, t, cls = '') => `<div class="co-stat" title="${esc(t)}"><span class="co-k">${k}</span><span class="co-v ${cls}">${v}</span></div>`;
  const chg = (x) => (x == null ? '' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  const q = c.quarters || [];
  const h = c.history || [];
  el.innerHTML = `<div class="ma-crumb"><button class="ma-back" data-krback="1">← COMPANIES</button> <span>${esc(c.ticker)}</span><span class="mb-tag">KOREA</span></div>`
    + `<div class="co-head">${krMono(c)}<div><div class="co-name">${esc(krName(c))}</div>
        <div class="co-sub">${esc(c.ticker)} · KOSPI${c.name ? ' · ' + esc(c.name) : ''}</div>
        ${c.description ? `<div class="co-desc">${esc(c.description)}</div>` : ''}
        ${c.brands && c.brands.length ? `<div class="jp-brands">${c.brands.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : ''}</div></div>`
    + `<div class="co-price"><span class="co-price-v">${wonPx(c.price)}</span>
        <span class="co-price-c ${c.chg1d >= 0 ? 'pos' : 'neg'}">${chg(c.chg1d)} today</span>
        <span class="co-price-c ${c.chg6m >= 0 ? 'pos' : 'neg'}">${chg(c.chg6m)} 6M</span>
        <span class="co-price-c ${c.chgYtd >= 0 ? 'pos' : 'neg'}">${chg(c.chgYtd)} YTD</span>
        <span class="dimtext">${c.priceDate ? `as of ${c.priceDate}` : ''}</span></div>`
    + `<div class="co-stats co-stats-12">
        ${cell('MARKET CAP', won(c.marketCap), 'Price × shares outstanding')}
        ${cell('MARKET CAP · USD', c.marketCapUsd ? `$${(c.marketCapUsd / 1e9).toFixed(1)}B` : '—', 'Converted at the current USD/KRW rate')}
        ${cell(`P/E · ${c.peBasis || 'FY'}`, c.pe != null ? `${c.pe.toFixed(2)}×` : '—', c.peBasis === 'TTM' ? 'Market cap ÷ the last four quarters of profit' : 'Market cap ÷ fiscal-year profit')}
        ${cell('P/B', c.pb != null ? `${c.pb.toFixed(2)}×` : '—', 'Market cap ÷ shareholders\u2019 equity')}
        ${cell('RETURN ON EQUITY', c.roe != null ? `${c.roe.toFixed(1)}%` : '—', 'Profit ÷ equity', c.roe >= 0 ? 'pos' : 'neg')}
        ${cell('OPERATING MARGIN', c.opMargin != null ? `${c.opMargin.toFixed(1)}%` : '—', 'Operating profit ÷ revenue', c.opMargin >= 0 ? 'pos' : 'neg')}
        ${cell('NET MARGIN', c.netMargin != null ? `${c.netMargin.toFixed(1)}%` : '—', 'Net profit ÷ revenue', c.netMargin >= 0 ? 'pos' : 'neg')}
        ${cell('FCF YIELD', c.fcfYield != null ? `${c.fcfYield.toFixed(1)}%` : '—', 'Operating plus investing cash flow ÷ market cap')}
      </div>`
    + `<div class="co-ranges">
        <span class="co-cmp-l">COMPARE</span><input class="co-cmp" id="kr-cmp" placeholder="company name, e.g. samsung" value="${esc(cmpCode(krCompare))}" autocomplete="off">
        <button class="co-cmp-clear${krCompare ? '' : ' hidden'}" id="kr-cmp-clear" data-cmpclear="kr" type="button" title="Clear comparison" aria-label="Clear comparison">×</button>
        <div class="co-sugg" id="kr-sugg"></div>
        ${[['1m', '1M'], ['3m', '3M'], ['6m', '6M'], ['ytd', 'YTD'], ['1y', '1Y'], ['5y', '5Y']].map(([k, t]) => `<button class="ma-chip${krRange === k ? ' on' : ''}" data-krrange="${k}">${t}</button>`).join('')}
      </div>`
    + `<div class="co-rets" id="kr-rets"></div>`
              + `<div class="co-chartwrap"><div class="co-big" id="kr-big"></div><canvas id="kr-chart"></canvas></div>`
    + '<div id="kr-peers-x"></div>'
    + (h.length > 1 ? `<div class="jp-q"><div class="jp-q-head"><span class="ph-t">FIVE-YEAR RECORD</span><span class="dimtext">${h.length} fiscal years · ₩</span></div>
        <table class="jp-q-table"><thead><tr><th>FISCAL YEAR</th><th>REVENUE</th><th>OP PROFIT</th><th>NET PROFIT</th><th>ROE</th></tr></thead><tbody>
        ${[...h].reverse().map((x) => `<tr><td>${esc(x.y)}</td><td>${won(x.s)}</td><td>${won(x.o)}</td><td>${won(x.n)}</td><td>${x.n != null && x.q ? `${((x.n / x.q) * 100).toFixed(1)}%` : '—'}</td></tr>`).join('')}
        </tbody></table></div>` : '')
    + (q.length > 1 ? `<div class="jp-q"><div class="jp-q-head"><span class="ph-t">QUARTERLY RESULTS</span><span class="dimtext">${q.length} quarters · ₩</span></div>
        <table class="jp-q-table"><thead><tr><th>QUARTER</th><th>REVENUE</th><th>OP PROFIT</th><th>MARGIN</th><th>NET PROFIT</th></tr></thead><tbody>
        ${[...q].reverse().map((x) => `<tr><td>${esc(x.d)} <em>${esc(x.q)}</em></td><td>${won(x.revenue)}</td><td>${won(x.operatingProfit)}</td><td>${x.revenue && x.operatingProfit != null ? `${((x.operatingProfit / x.revenue) * 100).toFixed(1)}%` : '—'}</td><td>${won(x.netIncome)}</td></tr>`).join('')}
        </tbody></table></div>` : '')
    + `<div class="macro-note">KOSPI · statements from DART (Financial Supervisory Service), prices from Naver Finance. Korean companies report cumulatively (Q1, H1, Q3, annual), so quarters here are the differences and the annual report is Q4. No guidance is published, so there is no forward P/E.${c.descSource === 'profile' ? ' Company description from stockanalysis.com.' : ''}</div>`;
  drawKrChart(c);
  fillPeers(`kr:${c.ticker}`, 'kr-peers-x');
}

async function drawKrChart(c, range = krRange) {
  if (charts['kr-chart']) { try { charts['kr-chart'].destroy(); } catch {} delete charts['kr-chart']; }
  coLong('kr:' + c.ticker).then((long) => { if (long) paintReturns('kr-rets', 'kr-big', long, range, WINDOWS_5Y, 'krrange'); }).catch(() => {});
  const wrap = $('kr-chart') && $('kr-chart').parentElement;
  let ch = null;
  try { ch = await jget(`/api/korea/chart?ticker=${encodeURIComponent(c.ticker)}&range=${encodeURIComponent(range)}`, 600000); } catch { ch = null; }
  if (!ch || !ch.dates || ch.dates.length < 2) {
    if (wrap) wrap.setAttribute('data-empty', `No price history for ${c.ticker} over ${range.toUpperCase()}.`);
    return;
  }
  if (wrap) wrap.removeAttribute('data-empty');
  const other = krCompare && cmpCode(krCompare) !== String(c.ticker) ? await seriesFor(krCompare, range) : null;
  if (other && other.dates && other.dates.length > 1) {
    const bmap = new Map(other.dates.map((d, i) => [d, other.closes[i]]));
    const dates = ch.dates.filter((d, i) => ch.closes[i] != null && bmap.get(d) != null);
    if (dates.length > 1) {
      const a0 = ch.closes[ch.dates.indexOf(dates[0])];
      const b0 = bmap.get(dates[0]);
      mountChart('kr-chart', {
        labels: dates,
        datasets: [
          line(`${c.ticker} · ${(c.nameEn || c.name).slice(0, 14)}`, dates.map((d) => (ch.closes[ch.dates.indexOf(d)] / a0) * 100), CT.c1),
          line(`${cmpCode(krCompare)}`, dates.map((d) => (bmap.get(d) / b0) * 100), CT.c2),
        ],
      }, baseOptions({ dp: 0, dateAxis: true, yTitle: 'indexed to 100' }));
      return;
    }
  }
  mountChart('kr-chart', { labels: ch.dates, datasets: [line(`${c.ticker} · KRW · ${range.toUpperCase()}`, ch.closes, CT.c1)] }, baseOptions({ dp: 0, dateAxis: true, log: range === '5y' }));
}

// The pane carries the market's accent colour (the region pills, the active tab, the tag on a company
// page). There used to be a quote strip here too — index name, level, day change, company count — but
// the market view already states all of that, and repeating it above every view was noise.
function syncMarketAccent() {
  const pane = document.getElementById('p-deals');
  if (pane) pane.dataset.market = coRegion;
}

// Prefetch the markets a reader is likely to switch to after the first one paints, so a region
// change is instant instead of a spinner.
let warmed = false;
function warmMarkets(delay = 1500) {
  if (warmed) return;
  // The US screener (~90 KB gzipped) is prefetched so COMPANIES opens instantly. Korea is only
  // ~50 KB gzipped — a fraction of that — and its first click otherwise pays a full round trip
  // behind a "Loading KOSPI…" spinner, so it is warmed too. Japan (~140 KB) still waits for its
  // own renderer: spending it on every first visit was competing with the first screen.
  const conn = (typeof navigator !== 'undefined' && navigator.connection) || {};
  if (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '')) return;
  // A cold start means the instance just woke: it is parsing eleven megabytes of committed JSON and
  // serving its first pages on a tenth of a CPU. Adding Korea's 28 MB parse there is what made the
  // COMPANIES tab crawl on the first visit after a deploy — so on a cold start the warm-up stands
  // down and the reader's own requests get the machine.
  const cold = (() => { try { return window.__coldStart === true; } catch { return false; } })();
  if (cold) return;
  warmed = true;
  setTimeout(() => {
    if (!companiesData) jget('/api/companies', 300000).then((d) => { companiesData = d; }).catch(() => {});
  }, delay);
  // Staggered behind the US list, and after the boot overlay has lifted, so the one-off 28 MB parse
  // the server does for Korea never competes with the first screen. `loadKorea()` de-dupes with the
  // click, so opening KOREA while this is in flight shares the one request instead of a second.
  setTimeout(() => { if (!koreaData) loadKorea().catch(() => {}); }, delay + 1500);
}

function renderCompanies() {
  // A new company starts without the previous company's benchmark. Same-company re-renders (a watch
  // star, a range change) keep it.
  if (coCik !== coOpenCik) { coCompare = ''; coOpenCik = coCik; }
  paintCoViews();
  // Keep the market switch in sync with the remembered choice (it also survives a reload).
  document.querySelectorAll('[data-region]').forEach((b) => b.classList.toggle('on', b.dataset.region === coRegion));
  // Every market change takes a token, the US included. Switching away used to leave an in-flight
  // Japan/Korea render valid, so a slow TOPIX fetch could finish after the US was chosen and paint
  // the Japanese screen over it. The chosen renderer gets this token and bails if another wins.
  const token = takeToken();
  syncMarketAccent();
  if (coRegion === 'jp') return renderJapan(token);
  if (coRegion === 'kr') return renderKorea(token);
  const el = $('co-body');
  if (charts['co-chart']) { try { charts['co-chart'].destroy(); } catch {} delete charts['co-chart']; }
  if (!el) return;
  const noteUs = $('co-note'); if (noteUs && usView === 'screener') noteUs.classList.remove('hidden');
  syncCoTools();
  if (!companiesData) { el.innerHTML = stError('Couldn’t load companies — retrying.'); return; }
  const all = companiesData.companies || [];
  const sub = $('deals-sub');
  if (sub) {
    const cos = new Set(all.filter((c) => c.cik).map((c) => String(c.cik))).size;
    // Say what THIS view is, so "market" and "screener" can never be mistaken for each other.
    const what = usView === 'screener' ? 'filter and sort'
      : usView === 'themes' ? 'curated theme lists'
        : 'breadth, sectors and the index';
    sub.textContent = `${all.length} securities · ${cos} companies · S&P 500 · ${what}`;
  }

  if (coCik) return renderCompanyPage(el, all);
  if (usView === 'market') return renderUsMarket(el, all, token);
  if (usView === 'themes') return renderUsThemes(el, all);

  const q = coQuery.trim().toLowerCase();
  const rows = all.filter((c) => {
    // Warrants, units, rights and preferreds are separate securities, not the company's common stock.
    if (/\b(warrant|unit|right|preferred)\b/i.test(c.name)) return false;
    // A second share class is the same company — Alphabet listed twice reads as a duplicate, not a choice.
    // The class still exists in the data and in the index weights; it just does not get its own row.
    if (c.shareClass) return false;
    if (coSector !== 'all' && c.sector !== coSector) return false;
    if (coMin && (c.marketCap || 0) < coMin) return false;
    if (coPriced && !c.marketCap) return false;
    if (coVerified && c.verification?.status !== 'verified') return false;
    if (coPe !== 'all') {
      const p = c.pe;
      if (p == null) return false;
      if (coPe === 'lt15' && p >= 15) return false;
      if (coPe === '15to25' && (p < 15 || p > 25)) return false;
      if (coPe === 'gt25' && p <= 25) return false;
    }
    if (coMinMargin) { const m = coMarginOf(c); if (m == null || m < coMinMargin) return false; }
    if (coPreset) { const pr = CO_PRESETS.find((x) => x.id === coPreset); if (pr && !pr.test(c)) return false; }
    // Growth is the revenue CAGR from the filings — the `growth` field never existed, so this filter
    // matched nothing until it was pointed at a number that is actually computed.
    if (coGrowth != null) { if (c.revenueCagr == null || c.revenueCagr < coGrowth) return false; }
    if (q) {
      const hay = `${c.name} ${c.ticker || ''} ${c.industry || ''} ${c.indexName || ''} ${(c.brands || []).join(' ')}`.toLowerCase();
      const alias = CO_ALIAS[q];
      if (!hay.includes(q) && (!alias || c.ticker !== alias)) return false;
    }
    return true;
  });
  const sortVal = (c) => (coSort === 'cap' ? c.marketCap : coSort === 'pe' ? c.pe : coSort === 'ev' ? c.evEbitda : coSort === 'margin' ? coMargin(c) : c.revenueCagr);
  rows.sort((a, b) => {
    const av = sortVal(a), bv = sortVal(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;            // blanks always last, whichever direction
    if (bv == null) return -1;
    return (av - bv) * coDir;
  });

  const chips = $('co-chips');
  if (chips) {
    const counts = {};
    for (const c of all) if (c.sector && c.sector !== 'Other') counts[c.sector] = (counts[c.sector] || 0) + 1;
    const sectors = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([x]) => x);
    const active = (coSector !== 'all' ? 1 : 0) + (coMin ? 1 : 0) + (coPe !== 'all' ? 1 : 0) + (coPreset ? 1 : 0)
      + (coMinMargin ? 1 : 0) + (coGrowth != null ? 1 : 0) + (coPriced ? 1 : 0) + (coVerified ? 1 : 0) + (coQuery.trim() ? 1 : 0);
    const sel = (key, label, opts, cur) => `<label class="co-sel"><span>${label}</span><select data-cosel="${key}">`
      + opts.map(([v, t]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${t}</option>`).join('')
      + '</select></label>';
    const tgl = (label, on, attr) => `<button class="co-tgl${on ? ' on' : ''}" ${attr}>${label}</button>`;
    chips.innerHTML = coFilterBar({
      presets: CO_PRESETS, preset: coPreset, presetAttr: 'data-copreset',
      selects: [
        { key: 'sector', label: 'SECTOR', opts: [['all', 'All'], ...sectors.map((x) => [x, x])], cur: coSector, attr: 'data-cosel' },
        { key: 'size', label: 'SIZE', opts: [['0', 'Any'], ['10000000000', '$10B+'], ['100000000000', '$100B+'], ['500000000000', '$500B+']], cur: coMin, attr: 'data-cosel' },
        { key: 'pe', label: 'P/E', opts: [['all', 'Any'], ['lt15', '<15'], ['15to25', '15–25'], ['gt25', '>25']], cur: coPe, attr: 'data-cosel' },
        { key: 'margin', label: 'MARGIN', opts: [['0', 'Any'], ['10', '>10%'], ['20', '>20%']], cur: coMinMargin, attr: 'data-cosel' },
        { key: 'growth', label: 'REV GROWTH', opts: [['any', 'Any'], ['0', '>0%'], ['10', '>10%']], cur: coGrowth === null ? 'any' : coGrowth, attr: 'data-cosel' },
      ],
      extra: '<span class="co-sep"></span>'
        + tgl('Priced', coPriced, 'data-copriced="1"')
        + tgl('Verified', coVerified, 'data-coverified="1"')
        + tgl('Board', coView === 'sectors', 'data-coview="1"')
        + '<button class="co-tgl" data-coexport="1">CSV</button>',
      clearAttr: 'data-coreset', clearValue: '1', active, asOf: asOfText(all, 'priceAsOf'),
    });
  }

  const priced = rows.filter((c) => c.marketCap);
  if (coView === 'sectors') return renderSectorBoard(el, all);

  // A second share class is the same company: include it in the list, exclude it from totals.
  const uniq = priced.filter((c) => !c.shareClass);
  const totalCap = uniq.reduce((a, b) => a + (b.marketCap || 0), 0);
  const max = Math.max(1, ...rows.map((c) => c.marketCap || 0));
  const pe = uniq.map((c) => c.pe).filter((x) => x != null && x > 0 && x < 200).sort((a, b) => a - b);
  const medPe = pe.length ? pe[Math.floor(pe.length / 2)] : null;
  const evs = uniq.map((c) => c.evEbitda).filter((x) => x != null && x > 0 && x < 100).sort((a, b) => a - b);
  const medEv = evs.length ? evs[Math.floor(evs.length / 2)] : null;

  // The aggregates live in the MARKET view now; the screener opens straight on the rows.
  warmMarkets();
  el.innerHTML = usViewsBar()
    + `<div class="co-hrow"><span>#</span><span></span><span>COMPANY</span><span>MARKET CAP</span><span>P/E</span><span>ROE</span></div>`
    + (rows.length ? '' : `<div class="macro-note">No company matches “${esc(coQuery.trim())}”. Try a ticker (AAPL) or a sector name.</div>`)
    + rows.map((c, i) => {
      const m = c.roe != null ? c.roe : null;
      return `<button class="co-row" data-cik="${esc(c.cik)}">
        <span class="co-rank">${i + 1}</span>
        ${coMono(c)}
        <span class="co-id"><b>${esc(c.name)}</b>
          <span class="co-meta">
            <span class="co-tick">${esc(c.ticker || '')}</span>
            ${c.sector ? `<span class="co-sec">${esc(c.sector)}</span>` : ''}
            ${c.price != null ? `<span class="co-px">$${c.price.toFixed(2)}</span>` : ''}
            ${c.chg1d != null ? `<em class="${c.chg1d >= 0 ? 'pos' : 'neg'}">${c.chg1d >= 0 ? '+' : ''}${c.chg1d.toFixed(1)}%</em>` : ''}
            ${c.chgYtd != null ? `<em class="${c.chgYtd >= 0 ? 'pos' : 'neg'}">${c.chgYtd >= 0 ? '+' : ''}${c.chgYtd.toFixed(1)}% YTD</em>` : ''}
            ${c.shareClass ? '<em class="co-cl">2ND CLASS</em>' : ''}
          </span></span>
        <span class="co-cap">${coMoney(c.marketCap)}<i class="co-bar"><i style="width:${Math.max(2, ((c.marketCap || 0) / max) * 100)}%"></i></i></span>
        <span class="co-pe" title="${c.pe != null ? 'trailing P/E: price ÷ latest FY diluted EPS' : 'no positive trailing EPS'}">${c.pe != null ? c.pe.toFixed(1) : '—'}</span>
        <span class="co-mar ${m == null ? 'dimtext' : m >= 0 ? 'pos' : 'neg'}">${m == null ? '—' : `${m.toFixed(1)}%`}</span>
      </button>`;
    }).join('') || '<div class="macro-note">Nothing matches — clear the filters.</div>';
}

// Rebase a series to 100 at its first point, so two stocks of different prices are comparable.
const rebase = (arr) => {
  const first = arr.find((v) => v != null);
  return arr.map((v) => (v == null || !first ? null : +((v / first) * 100).toFixed(2)));
};

// Sector board: one row per sector with count, market cap, median P/E and median margin.
function renderSectorBoard(el, all) {
  const groups = new Map();
  for (const c of all) {
    if (!c.sector || c.sector === 'Other') continue;
    if (!groups.has(c.sector)) groups.set(c.sector, []);
    groups.get(c.sector).push(c);
  }
  const med = (arr) => { const v = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const rows = [...groups.entries()].map(([sector, listAll]) => {
    const list = listAll.filter((c) => !c.shareClass);
    return ({
    sector, n: list.length,
    cap: list.reduce((a, c) => a + (c.marketCap || 0), 0),
    pe: med(list.map((c) => (c.pe != null && c.pe < 200 ? c.pe : null))),
    margin: med(list.map((c) => coMarginOf(c))),
    priced: list.filter((c) => c.marketCap).length,
  });
  }).sort((a, b) => b.cap - a.cap);
  const max = Math.max(1, ...rows.map((r) => r.cap));
  el.innerHTML = `<div class="ma-sumline">${rows.length} sectors · ${new Set(all.filter((c) => c.cik).map((c) => String(c.cik))).size} companies</div>`
    + rows.map((r) => `<button class="ma-sec" data-cosec="${esc(r.sector)}">
        <span class="ma-sec-top"><span class="ma-sec-name">${esc(r.sector)}</span>
          <span class="ma-sec-count">${r.n} companies</span>
          <span class="ma-sec-val">${coMoney(r.cap)}</span></span>
        <span class="ma-sec-bar"><i style="width:${Math.max(2, (r.cap / max) * 100)}%"></i></span>
        <span class="ma-sec-foot"><span class="ma-sec-share">${r.priced} priced</span>
          <span class="ma-sec-share">median P/E ${r.pe != null ? r.pe.toFixed(1) : '—'}</span>
          <span class="ma-sec-share">margin ${r.margin != null ? r.margin.toFixed(1) + '%' : '—'}</span>
          ${(() => {
            const sv = companiesData?.valuation?.sectors?.[r.sector];
            if (!sv || sv.pe == null) return '';
            return `<span class="ma-sec-share" title="Cap-weighted P/E of this sector against its own five fiscal years (${sv.min}–${sv.max}, median ${sv.median})">sector P/E ${sv.pe.toFixed(1)} · ${sv.percentile}th pctile</span>`;
          })()}</span>
      </button>`).join('');
}

// Every window's return at once, from one long series. "How much is it up over 1Y and over 5Y?" is a
// question about several windows at the same time, so one number at a time was the wrong shape.
const CO_WIN = [['1m', '1M', 31], ['3m', '3M', 92], ['6m', '6M', 190], ['ytd', 'YTD', 0], ['1y', '1Y', 366], ['5y', '5Y', 1826], ['10y', '10Y', 3653]];
const coLongCache = new Map();
async function coLong(ref) {
  const k = String(ref || '').toUpperCase();
  if (coLongCache.has(k)) return coLongCache.get(k);
  for (const r of ['10y', '5y']) {
    try {
      const ch = await seriesFor(ref, r);
      if (ch && ch.dates && ch.closes && ch.closes.length >= 2) { coLongCache.set(k, ch); return ch; }
    } catch { /* try the shorter range */ }
  }
  coLongCache.set(k, null);
  return null;
}
function coWindow(ch, range) {
  if (!ch || !ch.dates || !ch.closes || ch.closes.length < 2) return null;
  const w = CO_WIN.find((x) => x[0] === range);
  const last = ch.dates[ch.dates.length - 1];
  const from = range === 'ytd' ? `${last.slice(0, 4)}-01-01`
    : new Date(Date.parse(last) - (w ? w[2] : 366) * 864e5).toISOString().slice(0, 10);
  let i = ch.dates.findIndex((d) => d >= from);
  if (i < 0) i = 0;
  const a = ch.closes[i], b = ch.closes[ch.closes.length - 1];
  if (a == null || b == null || !a) return null;
  return { pct: (b / a - 1) * 100, from: a, to: b };
}
// The windows a series actually covers. Korea's index history is one year, so its strip stops at 1Y
// rather than printing a five-year number built from the first point it happens to hold.
function coWindowsFor(dates) {
  if (!dates || dates.length < 2) return ['1m', '3m', '6m', 'ytd', '1y'];
  const span = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 864e5;
  return WINDOWS_ALL.filter((k) => {
    if (k === 'ytd') return true;
    const w = CO_WIN.find((x) => x[0] === k);
    return w ? span >= w[2] * 0.9 : true;
  });
}
// Slice an in-page series to the window the reader picked (the index series are already loaded, so a
// window change is a redraw, not a round-trip).
function coSlice(ch, range) {
  const w = CO_WIN.find((x) => x[0] === range);
  const dates = (ch && ch.dates) || [], closes = (ch && ch.closes) || [];
  if (!w || dates.length < 2) return ch;
  const last = dates[dates.length - 1];
  const from = range === 'ytd' ? `${last.slice(0, 4)}-01-01`
    : new Date(Date.parse(last) - w[2] * 864e5).toISOString().slice(0, 10);
  let i = dates.findIndex((d) => d >= from);
  if (i < 0) i = 0;
  return { dates: dates.slice(i), closes: closes.slice(i) };
}
// Shared by all three markets: the US uses data-corange, Japan data-jprange, Korea data-krrange, so the
// existing delegated handlers keep working.
const WINDOWS_ALL = ['1m', '3m', '6m', 'ytd', '1y', '5y', '10y'];
const WINDOWS_5Y = ['1m', '3m', '6m', 'ytd', '1y', '5y'];   // Japan and Korea hold five years, not ten
function paintReturns(stripId, bigId, ch, range, keys, attr) {
  const strip = $(stripId);
  if (strip) {
    strip.innerHTML = keys.map((k) => {
      const w = CO_WIN.find((x) => x[0] === k);
      const r = coWindow(ch, k);
      return `<button type="button" class="co-ret${k === range ? ' on' : ''}" data-${attr}="${k}">`
        + `<span>${w ? w[1] : k.toUpperCase()}</span><b class="${r ? (r.pct >= 0 ? 'pos' : 'neg') : 'dimtext'}">${r ? (r.pct >= 0 ? '+' : '') + r.pct.toFixed(1) + '%' : '—'}</b></button>`;
    }).join('');
  }
  const big = $(bigId);
  if (big) {
    const r = coWindow(ch, range);
    big.innerHTML = r
      ? `<b class="${r.pct >= 0 ? 'pos' : 'neg'}">${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(1)}%</b><span>${range.toUpperCase()}</span><em>${r.from.toFixed(2)} &rarr; ${r.to.toFixed(2)}</em>`
      : '';
  }
}
function paintCoReturns(ch, range) { paintReturns('co-rets', 'co-big', ch, range, WINDOWS_ALL, 'corange'); }

// One of the market-view index charts (S&P 500 / TOPIX / KOSPI), drawn from a series already in
// memory. A window change re-slices those dates and updates the chart instance in place — it is a
// redraw, not a page render and not a request, which is what made the range strip feel slow.
function drawMarketIndexChart(prefix, full, range, attr, name) {
  const wins = coWindowsFor(full.dates);
  const use = wins.includes(range) ? range : (wins.includes('1y') ? '1y' : wins[wins.length - 1] || '1y');
  paintReturns(prefix + '-rets', null, full, use, wins, attr);
  const view = coSlice(full, use);
  mountChart(prefix + '-chart', { labels: view.dates, datasets: [line(`${name} · ${use.toUpperCase()}`, view.closes, CT.c1)] }, baseOptions({ dp: 0, dateAxis: true }));
  return use;
}
// The three index series, as the { dates, closes } shape the slicers understand.
function jpIndexSeries() {
  const s = japanData && japanData.topix && japanData.topix.series;
  return s && s.length > 1 ? { dates: s.map((p) => p.d), closes: s.map((p) => p.c) } : null;
}
function redrawJapanIndex(range = jpMktRange) {
  const full = jpIndexSeries();
  if (!full) return false;
  jpMktRange = drawMarketIndexChart('jp-mkt', full, range, 'jpmkt', 'TOPIX');
  return true;
}
function krIndexSeries() {
  const s = koreaData && koreaData.index && koreaData.index.series;
  return s && s.length > 1 ? { dates: s.map((p) => p.d), closes: s.map((p) => p.c) } : null;
}
function redrawKoreaIndex(range = krMktRange) {
  const full = krIndexSeries();
  if (!full) return false;
  krMktRange = drawMarketIndexChart('kr-mkt', full, range, 'krmkt', 'KOSPI');
  return true;
}

async function loadCoChart(ticker, range, compare) {
  if (!ticker) return;
  const cmp = String(compare || '').toLowerCase();
  if (cmp && (cmp === `us:${String(ticker).toLowerCase()}` || cmp === String(ticker).toLowerCase())) compare = '';
  const canvas = $('co-chart');
  const fail = () => {
    const wrap = canvas && canvas.parentElement;
    if (wrap) wrap.setAttribute('data-empty', `No price history for ${ticker} — the ticker may be delisted or not covered by Yahoo.`);
  };
  try {
    // Our labels are 1m/6m/ytd/1y/5y; Yahoo wants 1mo/6mo/ytd/1y/5y.
    const yRange = (r) => (r === '1m' ? '1mo' : r === '6m' ? '6mo' : r);
    // The return strip needs the long series; the line needs the window. Two different requests, so
    // start the long one NOW and only wait for it before the strip is painted — the same order as
    // before, without the second round-trip sitting behind the first.
    const longP = coLong(ticker).catch(() => null);
    let ch = await getJSON(`/api/company-chart?ticker=${encodeURIComponent(ticker)}&range=${yRange(range)}`);
    // A recent listing has fewer than six points over ten years — that is not "no history", it is a
    // shorter life. Step down the range and move the active button with it.
    for (const shorter of ['5y', '1y']) {
      if (ch && ch.dates && ch.dates.length > 5) break;
      if (range === '1y') break;
      if (range === '10y' || (range === '5y' && shorter === '1y')) {
        range = shorter;
        ch = await getJSON(`/api/company-chart?ticker=${encodeURIComponent(ticker)}&range=${yRange(range)}`);
        document.querySelectorAll('[data-corange]').forEach((b) => b.classList.toggle('on', b.dataset.corange === range));
      }
    }
    if (!ch || !ch.dates || ch.dates.length < 2) { fail(); return; }
    const wrap0 = canvas && canvas.parentElement;
    if (wrap0) wrap0.removeAttribute('data-empty');
    // Same idea for the comparison line: start it here, with the strip, rather than after it.
    const cmpP = compare ? seriesFor(compare, range).catch(() => null) : null;
    // The strip is computed from the longest series we hold for this ticker, so every window is on the
    // same source as the line. Cached per ticker, so switching ranges is instant.
    const longSeries = await longP;
    if (longSeries) paintCoReturns(longSeries, range);
    if (!compare) {
      mountChart('co-chart', { labels: ch.dates, datasets: [line(`${ticker} · ${range.toUpperCase()}`, ch.closes, CT.c1)] }, baseOptions({ dp: 2, dateAxis: true, log: range === '5y' || range === '10y' }));
      return;
    }
    const c2 = await cmpP;
    if (!c2 || !c2.dates || c2.dates.length < 2) {
      mountChart('co-chart', { labels: ch.dates, datasets: [line(`${ticker} · ${range.toUpperCase()}`, ch.closes, CT.c1)] }, baseOptions({ dp: 2, dateAxis: true, log: range === '5y' || range === '10y' }));
      return;
    }
    // Align on the union of dates, forward-filling each series, then rebase both to 100.
    const dates = [...new Set([...ch.dates, ...c2.dates])].sort();
    const fill = (src, key) => {
      const m = new Map(src.dates.map((d, i) => [d, src[key][i]]));
      let lastV = null;
      return dates.map((d) => { if (m.has(d) && m.get(d) != null) lastV = m.get(d); return lastV; });
    };
    const a = rebase(fill(ch, 'closes'));
    const b = rebase(fill(c2, 'closes'));
    mountChart('co-chart', { labels: dates, datasets: [line(ticker, a, CT.c1), line(cmpCode(compare), b, CT.c2)] }, baseOptions({ dp: 0, log: true, yTitle: 'indexed to 100', dateAxis: true }));
  } catch {}
}

// Descriptions are truncated at a sentence boundary, never mid-clause ("… or SDKs, and a").
const coDesc = (t) => {
  if (!t) return '';
  const s = String(t).replace(/\s+/g, ' ').replace(/\s+([),.;:])/g, '$1').trim();
  if (s.length <= 300) return s;
  const cut = s.slice(0, 300);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return i > 120 ? cut.slice(0, i + 1) : cut.replace(/[,;\s]+\S*$/, '') + '…';
};

// The US market view: the same shape as Japan's, computed from the 503 constituents.
async function renderUsMarket(el, all, token = renderSeq) {
  const noteUs = $('co-note'); if (noteUs) noteUs.classList.add('hidden');
  const uniq = all.filter((c) => !c.shareClass);
  const median = (xs) => {
    const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(2);
  };
  const totalCap = uniq.reduce((a, c) => a + (c.marketCap || 0), 0);
  const belowBook = uniq.filter((c) => c.pb != null && c.pb < 1).length;
  const adv = uniq.filter((c) => (c.chg1d || 0) > 0).length;
  const dec = uniq.filter((c) => (c.chg1d || 0) < 0).length;
  const v = companiesData.valuation || {};
  const groups = new Map();
  for (const c of uniq) { if (!groups.has(c.sector)) groups.set(c.sector, []); groups.get(c.sector).push(c); }
  const sectors = [...groups].map(([name, list]) => ({
    name, count: list.length, cap: list.reduce((a, c) => a + (c.marketCap || 0), 0),
    pe: median(list.map((c) => c.pe)), pb: median(list.map((c) => c.pb)),
    roe: median(list.map((c) => c.roe)), yield: median(list.map((c) => c.dividendYield)),
    chgYtd: median(list.map((c) => c.chgYtd)),
  })).sort((a, b) => b.cap - a.cap);
  const cell = (k, val, title, cls = '') => `<div class="co-stat" title="${esc(title)}"><span class="co-k">${k}</span><span class="co-v ${cls}">${val}</span></div>`;
  const chg = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  const breadth = adv + dec ? `<div class="jp-breadth"><span class="pos">${adv} up</span><i><i style="width:${Math.round((adv / Math.max(1, adv + dec)) * 100)}%"></i></i><span class="neg">${dec} down</span></div>` : '';
  // The index level comes from the macro quote feed; the changes are cap-weighted from the
  // constituents, which is stated rather than passed off as the official index return.
  // The quote pill must never hold the page. The tape is cached from boot in most sessions; when it
  // is missing, the page paints now and the pill fills in — waiting here is what left the previous
  // market's screen (TOPIX) sitting on screen after a switch to the US.
  const quoteFrom = (items) => {
    const spx = (items || []).find((x) => x.label === 'S&P 500');
    if (!spx || (spx.price == null && spx.last == null)) return '<span class="dimtext">index quote unavailable</span>';
    const px = Number(spx.price != null ? spx.price : spx.last).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return `<span class="jp-market-lvl">${px}</span>${spx.pct != null ? `<span class="${spx.pct >= 0 ? 'pos' : 'neg'}">${chg(spx.pct)} today</span>` : ''}`;
  };

  el.innerHTML = usViewsBar()
    + `<div class="jp-market-head"><span class="ph-t">S&amp;P 500</span>
        <span id="us-mkt-quote">${macroTickers ? quoteFrom(macroTickers) : ''}</span>
        <span class="dimtext">${uniq.length} companies · aggregates computed from the constituent set</span></div>`
    + `<div class="co-stats co-stats-12">
        ${cell('TOTAL MARKET CAP', coMoney(totalCap), 'Sum of every constituent, share classes excluded')}
        ${cell('COMPANIES', String(uniq.length), 'Common stock only')}
        ${cell('MEDIAN P/E', median(uniq.map((c) => c.pe)) != null ? `${median(uniq.map((c) => c.pe)).toFixed(1)}×` : '—', 'Median across constituents — the typical company, not the index')}
        ${cell('MEDIAN P/B', median(uniq.map((c) => c.pb)) != null ? `${median(uniq.map((c) => c.pb)).toFixed(2)}×` : '—', 'Median across constituents')}
        ${cell('MEDIAN ROE', median(uniq.map((c) => c.roe)) != null ? `${median(uniq.map((c) => c.roe)).toFixed(1)}%` : '—', 'Trailing twelve months, median')}
        ${cell('MEDIAN YIELD', median(uniq.map((c) => c.dividendYield)) != null ? `${median(uniq.map((c) => c.dividendYield)).toFixed(2)}%` : '—', 'Median dividend yield')}
        ${cell('BELOW BOOK', String(belowBook), 'Companies trading under 1× book value')}
        ${cell('INDEX P/E', v.pe != null ? `${v.pe.toFixed(1)}×` : '—', 'Cap-weighted: Σ market cap ÷ Σ trailing earnings', '')}
      </div>`
    + breadth
    + `<div class="co-rets" id="us-mkt-rets"></div>`
    + `<div class="co-chartwrap"><canvas id="us-mkt-chart"></canvas></div>`
    + `<div class="co-hrow jp-mkt-hrow"><span>SECTOR</span><span>N</span><span>CAP</span><span>P/E</span><span>P/B</span><span>ROE</span><span>YIELD</span><span>YTD</span></div>`
    + sectors.map((x) => `<div class="jp-mkt-row">
        <span>${esc(x.name)}</span><span>${x.count}</span><span>${coMoney(x.cap)}</span>
        <span>${x.pe != null ? x.pe.toFixed(1) : '—'}</span>
        <span>${x.pb != null ? x.pb.toFixed(2) : '—'}</span>
        <span class="${(x.roe || 0) >= 0 ? 'pos' : 'neg'}">${x.roe != null ? x.roe.toFixed(1) + '%' : '—'}</span>
        <span>${x.yield != null ? x.yield.toFixed(2) + '%' : '—'}</span>
        <span class="${(x.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${chg(x.chgYtd)}</span>
      </div>`).join('')
    + `<div class="macro-note">Constituent medians are equal-weighted; the index P/E is cap-weighted and comes from the annual filings. ${v.percentile != null ? `The index sits at the ${v.percentile}th percentile of ${v.min}–${v.max} over the last ${(v.years || []).length} years.` : ''}</div>`;

  // Fill the quote pill only if this screen is still the one on the page.
  if (!macroTickers) {
    jget('/api/macro-tickers', 900000).then((mt) => {
      if (stale(token) || !el.isConnected) return;
      const q = $('us-mkt-quote');
      if (q && mt && mt.items) q.innerHTML = quoteFrom(mt.items);
    }).catch(() => {});
  }

  // The index's own price history, with the same window strip a company page carries.
  await drawUsMarketChart();
}

// The S&P 500 chart on the market view: one long daily series feeds every window's return and every
// line, so a range change is a local re-slice and never a request.
let usMktRange = (() => { try { return localStorage.getItem('oilbasis.usMktRange') || '1y'; } catch { return '1y'; } })();
let usMktSeries = null;    // { dates, closes } for ^GSPC, ten years daily
let usMktSeq = 0;          // invalidates a slow fetch if the screen is repainted
function redrawUsIndex(range = usMktRange) {
  if (!usMktSeries) return false;
  usMktRange = drawMarketIndexChart('us-mkt', usMktSeries, range, 'usmkt', 'S&P 500');
  return true;
}
async function drawUsMarketChart() {
  const canvas = $('us-mkt-chart');
  if (!canvas) return;
  // Already fetched once this session: redraw in place, keeping the chart instance (and its
  // animation) instead of blanking the frame and going back to the network.
  if (redrawUsIndex()) return;
  const seq = ++usMktSeq;
  const wrap = canvas.parentElement;
  if (wrap) wrap.setAttribute('data-empty', 'Loading the S&P 500…');
  try {
    // Ten years daily. One series covers 1M through 10Y — the route defaults ten years to MONTHLY,
    // and a month-over-month series makes the 1M and 6M cells read 0.0%, so ask for daily bars.
    const long = await jget('/api/company-chart?ticker=%5EGSPC&range=10y&interval=1d', 900000);
    if (seq !== usMktSeq || !canvas.isConnected) return;
    if (!long || !long.dates || long.dates.length < 2) {
      if (wrap) wrap.setAttribute('data-empty', 'No S&P 500 history available right now.');
      return;
    }
    if (wrap) wrap.removeAttribute('data-empty');
    usMktSeries = { dates: long.dates, closes: long.closes };
    redrawUsIndex();
  } catch {
    if (wrap) wrap.setAttribute('data-empty', 'Couldn’t load the S&P 500 chart — try again.');
  }
}

// Curated US themes. The computed screens (buybacks, quality, cash) live in the screener as presets.
let usTheme = (() => { try { return localStorage.getItem('oilbasis.usTheme') || 'ai'; } catch { return 'ai'; } })();
// MAG 7 is a curated list like the others, so it is a preset here rather than a fourth tab that only
// the US had — that keeps the view row to the same three tabs in every region.
const US_MAG7_THEME = { id: 'mag7', label: 'MAG 7', mag7: true, tickers: MAG7 };
const usThemesList = () => [US_MAG7_THEME, ...(companiesData.themes || [])];
const usPresetsHtml = (themes, activeId) => `<div class="jp-presets">${themes.map((t) => `<button type="button" data-ustheme="${t.id}" class="${t.id === activeId ? 'on' : ''}">${t.label}</button>`).join('')}</div>`;
function renderUsThemes(el, all) {
  const noteUs = $('co-note'); if (noteUs) noteUs.classList.add('hidden');
  syncCoTools();
  const themes = usThemesList();
  if (!themes.length) { el.innerHTML = usViewsBar() + '<div class="macro-note">No themes loaded.</div>'; return; }
  const active = themes.find((t) => t.id === usTheme) || themes[0];
  if (active.mag7) return renderUsMag7(el, all, themes);   // weight-led table, kept as it was
  const set = new Set(active.tickers || []);
  const rows = all.filter((c) => set.has(c.ticker)).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  const chg = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  el.innerHTML = usViewsBar()
    + usPresetsHtml(themes, active.id)
    + `<div class="jp-market-head"><span class="ph-t">${esc(active.label)}</span><span class="dimtext">${rows.length} companies · curated list</span></div>`
    + `<div class="co-hrow jp-bank-hrow"><span>#</span><span>COMPANY</span><span>CAP</span><span>P/E</span><span>MARGIN</span><span>ROE</span><span>YIELD</span><span>YTD</span></div>`
    + rows.map((c, i) => `<button class="jp-bank-row" data-cik="${esc(c.cik)}">
        <span>${i + 1}</span>
        <span><b>${esc(c.name)}</b><span class="co-tick">${esc(c.ticker)}</span></span>
        <span>${coMoney(c.marketCap)}</span>
        <span>${c.pe != null ? c.pe.toFixed(1) : '—'}</span>
        <span>${coMargin(c) != null ? coMargin(c).toFixed(1) + '%' : '—'}</span>
        <span class="${(c.roe || 0) >= 0 ? 'pos' : 'neg'}">${c.roe != null ? c.roe.toFixed(1) + '%' : '—'}</span>
        <span>${c.dividendYield != null ? c.dividendYield.toFixed(2) + '%' : '—'}</span>
        <span class="${(c.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${chg(c.chgYtd)}</span>
      </button>`).join('')
    + `<div class="macro-note">${esc(active.note || '')} Screens for buybacks, quality and cash sit in the screener's presets.</div>`;
}

// The seven companies that decide the index's direction.
function renderUsMag7(el, all, themes = usThemesList()) {
  const noteUs = $('co-note'); if (noteUs) noteUs.classList.add('hidden');
  const rows = MAG7.map((t) => all.find((c) => c.ticker === t)).filter(Boolean).sort((a, b) => (b.indexWeight || 0) - (a.indexWeight || 0));
  const uniq = all.filter((c) => !c.shareClass);
  const totalCap = uniq.reduce((a, c) => a + (c.marketCap || 0), 0);
  const weight = rows.reduce((a, c) => a + (c.indexWeight || 0), 0);
  const cap = rows.reduce((a, c) => a + (c.marketCap || 0), 0);
  const chg = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  el.innerHTML = usViewsBar()
    + usPresetsHtml(themes, 'mag7')
    + `<div class="jp-market-head"><span class="ph-t">MAG 7</span><span class="jp-market-lvl">${weight.toFixed(1)}%</span><span class="dimtext">of the S&amp;P 500 by weight · ${coMoney(cap)} of ${coMoney(totalCap)}</span></div>`
    + `<div class="co-hrow jp-bank-hrow"><span>#</span><span>COMPANY</span><span>WEIGHT</span><span>CAP</span><span>1D</span><span>YTD</span><span>P/E</span><span>MARGIN</span></div>`
    + rows.map((c, i) => `<button class="jp-bank-row" data-cik="${esc(c.cik)}">
        <span>${i + 1}</span>
        <span><b>${esc(c.name)}</b><span class="co-tick">${esc(c.ticker)}</span></span>
        <span>${c.indexWeight != null ? c.indexWeight.toFixed(2) + '%' : '—'}</span>
        <span>${coMoney(c.marketCap)}</span>
        <span class="${(c.chg1d || 0) >= 0 ? 'pos' : 'neg'}">${chg(c.chg1d)}</span>
        <span class="${(c.chgYtd || 0) >= 0 ? 'pos' : 'neg'}">${chg(c.chgYtd)}</span>
        <span>${c.pe != null ? c.pe.toFixed(1) : '—'}</span>
        <span>${coMargin(c) != null ? coMargin(c).toFixed(1) + '%' : '—'}</span>
      </button>`).join('')
    + `<div class="macro-note">Weight is the SPDR SPY holding weight, so it is the index's own number rather than a derivation. Seven companies at ${weight.toFixed(1)}% of the index means the other 496 share the remaining ${(100 - weight).toFixed(1)}%.</div>`;
}

// The list payload is a projection; the full record (series, quarters, description, verification) is
// fetched the first time a company is opened and kept for the session.
const coDetailCache = new Map();
async function renderCompanyPage(el, all) {
  const stub = all.find((x) => String(x.cik) === String(coCik));
  if (!stub) { coCik = null; return renderCompanies(); }
  const key = String(stub.cik);
  let full = coDetailCache.get(key);
  if (!full) {
    el.innerHTML = stLoading('Reading the filing…');
    try { full = await jget(`/api/company/${encodeURIComponent(key)}`, 1800000); } catch { full = null; }
    if (full) coDetailCache.set(key, full);
  }
  if (!full) { el.innerHTML = stError('Couldn\u2019t load this company \u2014 retrying.'); return; }
  return renderCompanyPageBody(el, full, all);
}

async function renderCompanyPageBody(el, c, all) {
  // The page shows the same earnings basis as the P/E above it: trailing when we have it, else the
  // fiscal year. The five-year table below stays on reported fiscal years.
  const ni = c.netIncomeTTM != null ? c.netIncomeTTM : c.netIncome;
  const niTag = c.netIncomeTTM != null ? 'TTM' : 'FY';
  const m = c.revenue && ni != null && !c.marginNA ? (ni / c.revenue) * 100 : null;
  const roe = c.equity && ni != null ? (ni / c.equity) * 100 : null;
  const ver = c.verification || {};
  const vfields = ver.fields || {};
  const dsp = (f) => (vfields[f]
    ? ` <em class="co-dispute" title="SEC ${coMoney(vfields[f].ours)} · Nasdaq ${coMoney(vfields[f].alt)} (${Math.round(vfields[f].diff * 100)}% apart)">≠</em>`
    : '');
  const vtext = c.noFilings ? 'NEW LISTING · NO ANNUAL REPORT YET (FORM 10 FILED)'
    : ver.status === 'verified' && ver.method === 'filing-index'
      ? `✓ VERIFIED · ${ver.checked} FIELDS RE-DERIVED FROM THE FILING INDEX`
      : ver.status === 'verified' ? `✓ CROSS-CHECKED · ${ver.checked} FIELDS VS NASDAQ`
    : ver.status === 'definition' ? 'REVENUE BASIS DIFFERS FROM NASDAQ (BANK DEFINITION)'
      : ver.status === 'disputed' ? `${Object.keys(vfields).length} FIELD${Object.keys(vfields).length > 1 ? 'S DIFFER' : ' DIFFERS'} FROM NASDAQ — BOTH VALUES SHOWN`
        : 'NOT CROSS-CHECKED';
  const vcls = ver.status === 'verified' ? ' ok' : ver.status === 'definition' ? '' : ver.status === 'disputed' ? ' bad' : '';
  const series = (c.series || []).slice().sort((a, b) => a.fy - b.fy);
  const val = (v) => coMoney(v);

  el.innerHTML = `<div class="ma-crumb"><button class="ma-back" data-coback="1">← COMPANIES</button> <span>${esc(c.ticker || c.name)}</span><span class="mb-tag">S&amp;P 500</span></div>`
    + `<div class="co-head">
        ${coMono(c)}
        <div><div class="co-name">${esc(c.name)}</div>
        <div class="co-sub">${esc(c.ticker || '')}${c.sector ? ' · ' + esc(c.sector) : ''}${c.industry ? ' · ' + esc(c.industry) : ''}${c.state ? ' · ' + esc(c.state) : ''}</div>
        ${c.description ? `<div class="co-desc">${esc(coDesc(c.description))}</div>` : ''}
        ${c.brands && c.brands.length ? `<div class="jp-brands">${c.brands.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : ''}</div>
        <button class="co-star ${watchlist().includes(c.ticker) ? 'on' : ''}" data-coticker="${esc(c.ticker || '')}" title="${watchlist().includes(c.ticker) ? 'Unpin from watchlist' : 'Pin to watchlist'}">${watchlist().includes(c.ticker) ? '★' : '☆'}</button>
      </div>
      <div class="co-price">
        <span class="co-price-v">${c.price != null ? '$' + c.price.toFixed(2) : '—'}</span>
        <span class="co-price-c ${c.chg1d >= 0 ? 'pos' : 'neg'}">${c.chg1d != null ? `${c.chg1d >= 0 ? '+' : ''}${c.chg1d.toFixed(2)}% today` : ''}</span>
        <span class="co-price-c ${c.chg6m >= 0 ? 'pos' : 'neg'}">${c.chg6m != null ? `${c.chg6m >= 0 ? '+' : ''}${c.chg6m.toFixed(1)}% 6M` : ''}</span>
        <span class="co-price-c ${c.chgYtd >= 0 ? 'pos' : 'neg'}">${c.chgYtd != null ? `${c.chgYtd >= 0 ? '+' : ''}${c.chgYtd.toFixed(1)}% YTD` : ''}</span>
        <span class="dimtext">${c.priceAsOf ? `as of ${dealDateY(c.priceAsOf)}` : ''}</span>
      </div>
      <div class="co-verif${vcls}">${vtext}</div>`
    + (c.restatement ? (() => {
        const r = c.restatement;
        const parts = Object.entries(r.changes || {}).map(([k, v]) => `${k} ${coMoney(v.was)} → ${coMoney(v.now)}`);
        const link = r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">amendment ↗</a>` : '';
        return `<div class="co-restate">RESTATED · ${esc(r.form)} filed ${dealDateY(r.filed)} · ${esc(parts.join(' · '))}${link}</div>`;
      })() : '')
    + (() => {
        // A bank has no current ratio, no enterprise value and no EBITDA. Rather than print "n/a" in a
        // tile, the tile is omitted — the data says which ratios do not exist for this business.
        const na = new Set(c.naRatios || []);
        const tiles = [];
        const add = (key, label, value, title, cls) => {
          if (key && na.has(key)) return;
          tiles.push(`<div class="co-stat"${title ? ` title="${esc(title)}"` : ''}><span class="co-k">${label}</span><span class="co-v ${cls || ''}">${value}</span></div>`);
        };
        add(null, 'MARKET CAP', c.adrNA ? 'ADR' : val(c.marketCap));
        add('pe', `P/E (TRAILING${c.peBasis ? ' · ' + c.peBasis : ''})`,
          c.pe != null ? c.pe.toFixed(1) : (c.peNA ? '<em class="co-approx">n/a</em>' : '—'),
          c.ttmRejected ? 'Quarterly data is inconsistent with the annual filing, so the fiscal year is used.'
            : c.peNA ? 'No trailing profit: the last four quarters are a loss, so a trailing P/E does not exist.'
            : 'Market cap ÷ trailing earnings.');
        add('evEbitda', 'EV / EBITDA', c.evEbitda != null ? c.evEbitda.toFixed(1) : '—', 'Enterprise value ÷ operating income plus D&A');
        add(null, 'P/B', `${c.pb != null ? c.pb.toFixed(1) : '—'}${dsp('equity')}`);
        add('ev', 'ENTERPRISE VALUE', `${val(c.ev)}${c.evApprox ? ` <em class="co-approx" title="${esc(c.evApprox)}">≈</em>` : ''}`, c.evApprox ? `Market cap ${c.evApprox === 'neither debt nor cash is tagged' ? '— this company tags neither line' : 'adjusted for what is tagged'}.` : 'Market cap + debt − cash');
        add('currentRatio', 'CURRENT RATIO', c.currentRatio != null ? c.currentRatio.toFixed(2) : '—', 'Current assets ÷ current liabilities');
        add('debtEquity', 'DEBT / EQUITY', c.debtEquity != null ? c.debtEquity.toFixed(2) : (c.debtNA ? '<em class="co-approx" title="' + esc(c.debtNA) + '">n/d</em>' : '—'), c.debtNA || 'Debt ÷ shareholders’ equity');
        // Revenue on the same trailing basis as the net income beside it. The fiscal-year figure is kept
        // for companies whose quarters are incomplete, labelled with the year it belongs to.
        add(null, `REVENUE · ${c.revenueTTM != null ? 'TTM' : 'FY' + (c.fyRevenue || '')}`,
          `${val(c.revenueTTM ?? c.revenue)}${dsp('revenue')}`,
          c.revenueTTM != null
            ? `Last four quarters to ${c.revenueTTMEnd}. The fiscal-year figure is ${val(c.revenue)} (FY${c.fyRevenue || '—'}).`
            : `us-gaap:${c.revenueTag || 'Revenues'} · fiscal year ${c.fyRevenue || '—'}${c.revenueSource === 'nasdaq' ? ' · exchange total revenue' : ''}`);
        add(null, `NET INCOME · ${niTag}`, `${val(ni)}${dsp('netIncome')}`, `us-gaap:${c.netIncomeTag || 'NetIncomeLoss'} · ${niTag}${c.netIncomeEnd ? ' · period ' + c.netIncomeEnd : ''}`, ni >= 0 ? 'pos' : 'neg');
        add(null, `NET MARGIN · ${niTag}`, m == null ? (c.marginNA ? 'n/a' : '—') : `${m.toFixed(1)}%`, 'Net income ÷ revenue', m >= 0 ? 'pos' : 'neg');
        add(null, 'RETURN ON EQUITY', roe == null ? '—' : `${roe.toFixed(1)}%`, 'Net income ÷ shareholders’ equity', roe >= 0 ? 'pos' : 'neg');
        add(null, 'TOTAL ASSETS', `${val(c.assets)}${dsp('assets')}`, `us-gaap:Assets · ${c.assetsEnd || ''}`);
        if (c.sector === 'Financials') {
          // Only where the figure exists: an insurer has no net interest margin, and a blank tile is noise.
          if (c.ptbv != null) add(null, 'P / TANGIBLE BOOK', c.ptbv.toFixed(2) + '×', 'Market cap ÷ (equity − goodwill − intangibles) — the multiple banks are valued on');
          if (c.efficiencyRatio != null) add(null, 'EFFICIENCY RATIO', c.efficiencyRatio.toFixed(0) + '%', 'Non-interest expense ÷ revenue — the cost of running the bank. Below 55% is strong.');
          if (c.nim != null) add(null, 'NET INTEREST MARGIN', c.nim.toFixed(2) + '%', 'Net interest income ÷ assets — the spread the bank earns');
          add(null, 'SHAREHOLDER YIELD', c.shareholderYield != null ? c.shareholderYield.toFixed(1) + '%' : '—', 'Dividend yield + buybacks ÷ market cap', c.shareholderYield >= 0 ? 'pos' : 'neg');
        } else {
          add('freeCashFlow', `FREE CASH FLOW${c.fcfBasis ? ' · ' + c.fcfBasis : ''}`, val(c.fcfTTM ?? c.fcf), `Operating cash flow ${coMoney(c.operatingCashFlow)} − capex ${coMoney(c.capex)}${c.capexOmitted ? ' (not reported)' : ''}`, (c.fcfTTM ?? c.fcf) >= 0 ? 'pos' : 'neg');
          add('fcfYield', 'FCF YIELD', c.fcfYield != null ? c.fcfYield.toFixed(1) + '%' : '—', 'Free cash flow ÷ market cap', c.fcfYield >= 0 ? 'pos' : 'neg');
          add('cashConversion', 'CASH CONVERSION', c.cashConversion != null ? c.cashConversion.toFixed(2) + '×' : '—', 'Free cash flow ÷ net income — below 1 means profit is not turning into cash');
          add(null, 'SHAREHOLDER YIELD', c.shareholderYield != null ? c.shareholderYield.toFixed(1) + '%' : '—', 'Dividend yield + buybacks ÷ market cap', c.shareholderYield >= 0 ? 'pos' : 'neg');
        }
        add(null, `REVENUE CAGR${c.cagrYears ? ' · ' + c.cagrYears + 'Y' : ''}`, c.revenueCagr != null ? c.revenueCagr.toFixed(1) + '%' : '—', c.cagrNA ? `No growth rate: ${c.cagrNA}.` : `Compound annual growth of revenue over the ${c.cagrYears} fiscal years on file`, c.revenueCagr >= 0 ? 'pos' : 'neg');
        // A CAGR does not exist when either end is a loss, so show the change itself rather than a dash.
        const epsTile = c.epsCagr != null
          ? { v: c.epsCagr.toFixed(1) + '%', cls: c.epsCagr >= 0 ? 'pos' : 'neg', t: `Compound annual growth of earnings per share over ${c.cagrYears} years` }
          : c.epsChange
            ? (() => {
                const money = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
                return { v: `${money(c.epsChange.from)} → ${money(c.epsChange.to)}`, cls: c.epsChange.to >= 0 ? 'pos' : 'neg', t: `No CAGR: ${c.epsCagrNA}. EPS went from ${money(c.epsChange.from)} in FY${c.epsChange.fromFy} to ${money(c.epsChange.to)} in FY${c.epsChange.toFy}.` };
              })()
            : { v: '—', cls: '', t: c.epsCagrNA ? `No EPS growth: ${c.epsCagrNA}.` : 'No EPS growth rate' };
        add(null, `EPS GROWTH${c.cagrYears ? ' · ' + c.cagrYears + 'Y' : ''}`, epsTile.v, epsTile.t, epsTile.cls);
        add('roic', `RETURN ON CAPITAL${c.roicBasis ? ' · ' + c.roicBasis : ''}`, c.roic != null ? c.roic.toFixed(1) + '%' : '—', 'Net income ÷ (equity + debt − cash) — approximate return on capital', c.roic >= 0 ? 'pos' : 'neg');
        add('netDebtEbitda', `NET DEBT / EBITDA${c.netDebtEbitdaBasis ? ' · ' + c.netDebtEbitdaBasis : ''}`, c.netDebtEbitda != null ? c.netDebtEbitda.toFixed(1) + '×' : (c.debtNA ? '<em class="co-approx" title="' + esc(c.debtNA) + '">n/d</em>' : '—'), c.debtNA || '(Debt − cash) ÷ (operating income + D&A) — years of EBITDA to clear net debt');
        if (c.sector !== 'Financials') {
          add('ebitYield', 'EBIT YIELD', c.ebitYield != null ? c.ebitYield.toFixed(1) + '%' : '—', 'Operating income ÷ enterprise value — the cash-flow yield on the whole business', c.ebitYield >= 0 ? 'pos' : 'neg');
          add('assetTurnover', 'ASSET TURNOVER', c.assetTurnover != null ? c.assetTurnover.toFixed(2) + '×' : '—', 'Revenue ÷ assets — how hard the asset base works');
        }
        const note = na.size
          ? `<div class="macro-note" style="padding:6px 12px">${esc(c.sector === 'Financials' && /^6[03]/.test(String(c.sic || ''))
              ? 'No enterprise value, EBITDA, free cash flow, current ratio or return on capital: those ratios do not apply to a bank or an insurer, so they are omitted rather than shown as blanks.'
              : 'Some ratios are omitted because they do not exist for this business.')}</div>`
          : '';
        return `<div class="co-stats co-stats-12">${tiles.join('')}</div>${note}`;
      })()
    + (c.peHistory ? (() => {
        const h = c.peHistory;
        const span = Math.max(0.1, h.max - h.min);
        const at = c.pe != null ? Math.max(0, Math.min(100, ((c.pe - h.min) / span) * 100)) : null;
        return `<div class="co-band" title="Price at each fiscal year end ÷ that year's EPS. Current P/E is market cap ÷ trailing earnings.">
          <span class="co-band-k">P/E vs ITS OWN 5 YEARS</span>
          <span class="co-band-track">${at != null ? `<i style="left:${at.toFixed(1)}%"></i>` : ''}</span>
          <span class="co-band-n">${h.min}–${h.max} · median ${h.median}${h.percentile != null && c.pe != null ? ` · ${h.percentile}th percentile` : ''}</span>
        </div>`;
      })() : '')
    + (!c.peHistory && c.pe == null ? `<div class="co-band"><span class="co-band-k">P/E vs ITS OWN 5 YEARS</span><span class="co-band-n">no band — the company lost money in most of the last five years, so a P/E range does not exist</span></div>` : '')
    + (c.ticker ? `<div class="co-chartwrap">
        <div class="co-ranges">
          <span class="co-cmp-l">COMPARE</span><input class="co-cmp" id="co-cmp" placeholder="company name, e.g. jpmorgan" value="${esc(cmpCode(coCompare))}" autocomplete="off">
          <button class="co-cmp-clear${coCompare ? '' : ' hidden'}" id="us-cmp-clear" data-cmpclear="us" type="button" title="Clear comparison" aria-label="Clear comparison">×</button>
          <div class="co-sugg" id="us-sugg"></div>
          ${['1m', '3m', '6m', 'ytd', '1y', '5y', '10y'].map((r) => `<button class="ma-chip${coRange === r ? ' on' : ''}" data-corange="${r}">${r.toUpperCase()}</button>`).join('')}
        </div>
        <div class="co-rets" id="co-rets"></div>
        <div class="co-canvas"><div class="co-big" id="co-big"></div><canvas id="co-chart"></canvas></div></div>
        <div id="us-peers"></div>` : '')
    + (() => {
        const lf = c.lastFiling;
        const link = lf?.url
          ? `<a href="${esc(lf.url)}" target="_blank" rel="noopener noreferrer">${esc(lf.form)} ↗</a>`
          : `<a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${esc(c.cik)}&type=10-K" target="_blank" rel="noopener noreferrer">filings ↗</a>`;
        // A 10-Q is not a fiscal year: show the filing's own period, not the series year.
        const stamp = lf
          ? ` · ${esc(lf.form)}${lf.period ? ' · period ' + dealDateY(lf.period) : ''} · filed ${dealDateY(lf.filed)}`
          : '';
        return `<div class="macro-note">GAAP, as filed — no estimates, no adjusted figures. Market cap is Nasdaq's quote data; P/E, P/B and EV/EBITDA are computed from it and the filing's own earnings, equity, debt and cash. ${lf ? 'Latest filing' : 'Latest annual report'}${stamp} · ${link}</div>`;
      })()
    + (series.length ? `<div class="gtitle">FIVE-YEAR FINANCIALS</div>
      <div class="co-table">
        <div class="co-tr co-th"><span>FY</span><span>REVENUE</span><span>NET INCOME</span><span>MARGIN</span><span>ASSETS</span><span>EQUITY</span><span>EPS</span></div>
        ${series.map((s) => {
          const mg = s.revenue && s.netIncome != null ? (s.netIncome / s.revenue) * 100 : null;
          return `<div class="co-tr"><span>${s.fy}</span><span>${val(s.revenue)}</span><span class="${s.netIncome >= 0 ? 'pos' : 'neg'}">${val(s.netIncome)}</span><span>${mg == null ? '—' : mg.toFixed(1) + '%'}</span><span>${val(s.assets)}</span><span>${val(s.equity)}</span><span>${s.eps != null ? '$' + s.eps.toFixed(2) : '—'}</span></div>`;
        }).join('')}
      </div>` : '')
    + (() => {
        // Newest first, the same order Japan and Korea use.
        const qs = (c.quarters || []).filter((q) => q.revenue != null || q.netIncome != null).slice().reverse();
        if (!qs.length) return '';
        return `<div class="gtitle">LAST EIGHT QUARTERS</div>
          <div class="co-table co-qtr">
            <div class="co-tr co-th"><span>PERIOD</span><span>REVENUE</span><span>OP INCOME</span><span>MARGIN</span><span>NET INCOME</span></div>
            ${qs.map((q) => {
              // Operating margin where the company reports an operating line; banks do not, so they fall
              // back to net margin rather than showing a blank column.
              const opM = q.margin != null ? q.margin : null;
              const netM = q.netMargin != null ? q.netMargin : (q.revenue && q.netIncome != null ? (q.netIncome / q.revenue) * 100 : null);
              const shown = opM != null ? opM : netM;
              return `<div class="co-tr"><span>${dealDateY(q.end)}</span><span>${val(q.revenue)}</span><span class="${q.operatingIncome >= 0 ? 'pos' : 'neg'}">${val(q.operatingIncome)}</span><span title="${opM != null ? 'operating margin' : 'net margin (no operating line reported)'}">${shown == null ? '—' : shown.toFixed(1) + '%'}</span><span class="${q.netIncome >= 0 ? 'pos' : 'neg'}">${val(q.netIncome)}</span></div>`;
            }).join('')}
          </div>`;
      })()
    + (() => {
        const peers = all.filter((x) => x.sic && x.sic === c.sic && x.cik !== c.cik && x.marketCap).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 6);
        return peers.length ? `<div class="gtitle">PEERS · ${esc(c.industry || 'same industry')}</div>`
          + peers.map((x) => `<button class="co-row" data-cik="${esc(x.cik)}">
              <span class="co-rank"></span>${coMono(x)}
              <span class="co-id"><b>${esc(x.name)}</b><span class="co-tick">${esc(x.ticker || '')}${x.sector ? ' · ' + esc(x.sector) : ''}</span></span>
              <span class="co-cap">${coMoney(x.marketCap)}<i class="co-bar"><i style="width:${Math.max(2, ((x.marketCap || 0) / Math.max(1, peers[0].marketCap)) * 100)}%"></i></i></span>
              <span class="co-pe">${x.pe != null ? x.pe.toFixed(1) : '—'}</span>
              <span class="co-mar ${coMargin(x) >= 0 ? 'pos' : 'neg'}">${coMargin(x) == null ? '—' : coMargin(x).toFixed(1) + '%'}</span>
            </button>`).join('') : '';
      })()
    + `<div class="gtitle">DEALS</div><div id="co-deals" class="macro-note">looking up deals…</div>`;

  // Price chart (1Y, daily) — the only place a price is plotted, so it stays cheap.
  coTicker = c.ticker || null;
  if (coTicker) loadCoChart(coTicker, coRange, coCompare);
  if (coTicker) fillPeers(`us:${coTicker}`, 'us-peers');

  try {
    const d = await jget('/api/deals', 300000);
    const key = String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const mine = (d.deals || []).filter((x) => String(x.acquirer || '').toLowerCase().replace(/[^a-z0-9]/g, '') === key
      || String(x.target || '').toLowerCase().replace(/[^a-z0-9]/g, '') === key);
    const box = $('co-deals');
    if (box) box.outerHTML = mine.length
      ? `<div class="co-deals">${mine.slice(0, 8).map((x) => `<div class="co-deal"><span class="ma-when">${dealDateY(x.date)}</span><span>${esc(maName(x.acquirer) || '—')} <span class="dimtext">→</span> ${esc(maName(x.target) || '—')}</span><span class="ma-val">${valCell(x) || '—'}</span></div>`).join('')}</div>`
      : '<div class="macro-note">No deals for this company in the book.</div>';
  } catch {}
}

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'co-ftoggle') {
    const chips = document.getElementById('co-chips');
    const on = chips ? chips.classList.toggle('open') : false;
    e.target.classList.toggle('on', on);
    e.target.setAttribute('aria-expanded', String(on));
    return;
  }
  const cc = e.target.closest('[data-cmpclear]');
  if (cc) { clearCompare(cc.dataset.cmpclear); return; }
  const sug = e.target.closest('[data-sugg]');
  if (sug) { setCompare(sug.dataset.sugg); return; }
  const peer = e.target.closest('[data-peer]');
  if (peer) { setCompare(peer.dataset.peer); return; }
  const cr = e.target.closest('[data-corange]');
  if (cr) {
    coRange = cr.dataset.corange;
    document.querySelectorAll('[data-corange]').forEach((b) => b.classList.toggle('on', b.dataset.corange === coRange));
    loadCoChart(coTicker, coRange, coCompare);
    return;
  }
  // The index strips on the market views work the same way: a window is a redraw, not a page change.
  const um = e.target.closest('[data-usmkt]');
  if (um) {
    usMktRange = um.dataset.usmkt;
    try { localStorage.setItem('oilbasis.usMktRange', usMktRange); } catch {}
    if (!redrawUsIndex()) drawUsMarketChart();   // no cached series yet → first load
    return;
  }
  const jm = e.target.closest('[data-jpmkt]');
  if (jm) {
    jpMktRange = jm.dataset.jpmkt;
    try { localStorage.setItem('oilbasis.jpMktRange', jpMktRange); } catch {}
    // Slice the TOPIX series already in the page. Re-rendering the whole market view for a window
    // click rebuilt the sector table and remounted the chart, which read as a stutter.
    if (coRegion === 'jp' && jpView === 'market' && redrawJapanIndex()) return;
    renderJapan();
    return;
  }
  const km = e.target.closest('[data-krmkt]');
  if (km) {
    krMktRange = km.dataset.krmkt;
    try { localStorage.setItem('oilbasis.krMktRange', krMktRange); } catch {}
    if (coRegion === 'kr' && krView === 'market' && redrawKoreaIndex()) return;
    renderKorea();
    return;
  }
  const region = e.target.closest('[data-region]');
  if (region) {
    coRegion = region.dataset.region;
    try { localStorage.setItem('oilbasis.coRegion', coRegion); } catch {}
    document.querySelectorAll('[data-region]').forEach((b) => b.classList.toggle('on', b.dataset.region === coRegion));
    coCik = null; jpSel = null;
    const inp = $('co-search'); if (inp) inp.value = '';
    const note = $('co-note'); if (note) note.classList.toggle('hidden', coRegion === 'jp');
    // Drop the old market's screen on the spot. The US render waits for data before it paints, and
    // until this the previous screen (often Japan's TOPIX view) was still the thing on the page.
    const body = $('co-body');
    if (body) body.innerHTML = stLoading(coRegion === 'jp' ? 'Loading Japan…' : coRegion === 'kr' ? 'Loading KOSPI…' : 'Loading the S&P 500…');
    renderCompanies();
    return;
  }
  const krv = e.target.closest('[data-krview]');
  if (krv) { krView = krv.dataset.krview; try { localStorage.setItem('oilbasis.krView', krView); } catch {} krSel = null; renderKorea(); return; }
  const krt = e.target.closest('[data-krtheme]');
  if (krt) { krTheme = krt.dataset.krtheme; try { localStorage.setItem('oilbasis.krTheme', krTheme); } catch {} renderKorea(); return; }
  const krr = e.target.closest('[data-krrange]');
  if (krr) {
    krRange = krr.dataset.krrange;
    try { localStorage.setItem('oilbasis.krRange', krRange); } catch {}
    document.querySelectorAll('[data-krrange]').forEach((b) => b.classList.toggle('on', b.dataset.krrange === krRange));
    const cur = (koreaData && koreaData.companies || []).find((x) => x.code === krSel);
    if (cur) drawKrChart(cur, krRange);
    return;
  }
  const krp = e.target.closest('[data-krpreset]');
  if (krp) {
    const id = krp.dataset.krpreset;
    if (id === 'clear') {
      krPreset = null; krFilter = {}; krSector = 'all'; krQuery = '';
      const inp = $('co-search'); if (inp) inp.value = '';
    } else krPreset = id === krPreset ? null : id;
    saveKrFilter();
    renderKorea();
    return;
  }
  const krrow = e.target.closest('[data-kr]');
  if (krrow) { krSel = krrow.dataset.kr; renderKorea(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (e.target.closest('[data-krback]')) { krSel = null; renderKorea(); return; }
  const jrow = e.target.closest('[data-jp]');
  if (jrow) { jpSel = jrow.dataset.jp; renderJapan(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (e.target.closest('[data-jpback]')) { jpSel = null; renderJapan(); return; }
  const ut = e.target.closest('[data-ustheme]');
  if (ut) {
    usTheme = ut.dataset.ustheme;
    try { localStorage.setItem('oilbasis.usTheme', usTheme); } catch {}
    renderCompanies();
    return;
  }
  const uv = e.target.closest('[data-usview]');
  if (uv) {
    usView = uv.dataset.usview;
    try { localStorage.setItem('oilbasis.usView', usView); } catch {}
    coCik = null;
    renderCompanies();
    return;
  }
  const jt = e.target.closest('[data-jptheme]');
  if (jt) {
    jpTheme = jt.dataset.jptheme;
    try { localStorage.setItem('oilbasis.jpTheme', jpTheme); } catch {}
    renderJapan();
    return;
  }
  const jv = e.target.closest('[data-jpview]');
  if (jv) {
    jpView = jv.dataset.jpview;
    try { localStorage.setItem('oilbasis.jpView', jpView); } catch {}
    jpSel = null;
    renderJapan();
    return;
  }
  const jp = e.target.closest('[data-jppreset]');
  if (jp) {
    const id = jp.dataset.jppreset;
    if (id === 'clear' || id === jpPreset) {
      jpPreset = null; jpFilter = {}; jpQuery = '';
      const inp = $('co-search'); if (inp) inp.value = '';
    }
    else {
      const preset = JP_PRESETS.find((x) => x.id === id);
      jpPreset = id;
      jpFilter = { ...(preset ? preset.f : {}) };
    }
    saveJpFilter();
    renderJapan();
    return;
  }
  const jr = e.target.closest('[data-jprange]');
  if (jr) {
    jpRange = jr.dataset.jprange;
    try { localStorage.setItem('oilbasis.jpRange', jpRange); } catch {}
    document.querySelectorAll('[data-jprange]').forEach((b) => b.classList.toggle('on', b.dataset.jprange === jpRange));
    const cur = ((japanData && japanData.companies) || []).find((x) => x.code === jpSel);
    if (cur) drawJpPrice(cur, jpRange);
    return;
  }
  const jstar = e.target.closest('[data-jpstar]');
  if (jstar) {
    toggleWatch(`jp:${jstar.dataset.jpstar}`);
    const cur = ((japanData && japanData.companies) || []).find((x) => x.code === jpSel);
    if (cur) renderJapanPage(cur);
    renderWatchlist();
    return;
  }
  const jtile = e.target.closest('[data-jpcode]');
  if (jtile) {
    coRegion = 'jp'; try { localStorage.setItem('oilbasis.coRegion', 'jp'); } catch {}
    jpSel = jtile.dataset.jpcode;
    document.querySelector('[data-tab="deals"]')?.click();
    renderJapan();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (e.target.closest('[data-coback]')) { coCik = null; renderCompanies(); return; }
  const star = e.target.closest('[data-coticker]');
  if (star) { toggleWatch(star.dataset.coticker); renderCompanyPage($('co-body'), companiesData.companies || []); renderWatchlist(); return; }
  // Themes and peer tables use .jp-bank-row, so match on the data attribute rather than the class.
  const row = e.target.closest('#co-body [data-cik]');
  if (row && row.dataset.cik) { coCik = row.dataset.cik; renderCompanies(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (e.target.closest('[data-coexport]')) {
    const q = coQuery.trim().toLowerCase();
    const rows = (companiesData.companies || []).filter((c) => (coSector === 'all' || c.sector === coSector) && (!coMin || (c.marketCap || 0) >= coMin)
      && (!q || `${c.name} ${c.ticker || ''}`.toLowerCase().includes(q)));
    const cols = ['name', 'ticker', 'sector', 'marketCap', 'pe', 'evEbitda', 'pb', 'revenue', 'netIncome', 'growth', 'cik'];
    const csv = [cols.join(',')].concat(rows.map((c) => cols.map((k) => JSON.stringify(c[k] ?? '')).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'companies.csv';
    a.click();
    return;
  }
  if (e.target.closest('[data-coreset]')) {
    coSector = 'all'; coMin = 0; coPe = 'all'; coMinMargin = 0; coGrowth = null; coPriced = false; coVerified = false; coQuery = ''; coPreset = null;
    const inp = $('co-search'); if (inp) inp.value = '';
    renderCompanies();
    return;
  }
  if (e.target.closest('[data-coview]')) { coView = coView === 'sectors' ? 'list' : 'sectors'; renderCompanies(); return; }
  const cp = e.target.closest('[data-cope]');
  if (cp) { coPe = cp.dataset.cope; renderCompanies(); return; }
  const cm = e.target.closest('[data-comargin]');
  if (cm) { coMinMargin = Number(cm.dataset.comargin); renderCompanies(); return; }
  const cg = e.target.closest('[data-cogrowth]');
  if (cg) { coGrowth = cg.dataset.cogrowth === 'any' ? null : Number(cg.dataset.cogrowth); renderCompanies(); return; }
  if (e.target.closest('[data-copriced]')) { coPriced = !coPriced; renderCompanies(); return; }
  if (e.target.closest('[data-coverified]')) { coVerified = !coVerified; renderCompanies(); return; }
  const cs = e.target.closest('[data-cosort]');
  if (cs) {
    if (coSort === cs.dataset.cosort) coDir = -coDir; else { coSort = cs.dataset.cosort; coDir = -1; }
    renderCompanies();
    return;
  }
  const pre = e.target.closest('[data-copreset]');
  if (pre) {
    coPreset = coPreset === pre.dataset.copreset ? null : pre.dataset.copreset;
    renderCompanies();
    return;
  }
  const chip = e.target.closest('[data-cosec],[data-comin]');
  if (chip) {
    if (chip.dataset.cosec != null) coSector = chip.dataset.cosec;
    if (chip.dataset.comin != null) coMin = Number(chip.dataset.comin);
    renderCompanies();
  }
});

document.addEventListener('change', (e) => {
  const s = e.target.closest('[data-cosel]');
  if (!s) return;
  const v = s.value;
  if (s.dataset.cosel === 'sector') coSector = v;
  else if (s.dataset.cosel === 'size') coMin = Number(v);
  else if (s.dataset.cosel === 'pe') coPe = v;
  else if (s.dataset.cosel === 'margin') coMinMargin = Number(v);
  else if (s.dataset.cosel === 'growth') coGrowth = v === 'any' ? null : Number(v);
  renderCompanies();
});

// Selects fire 'change' on some browsers where they never fire 'input' — handle both.
document.addEventListener('change', async (e) => {
  if (e.target && e.target.dataset && e.target.dataset.krf) {
    const k = e.target.dataset.krf;
    if (k === 'sector') krSector = e.target.value || 'all';
    else if (k === 'sort') { krSort = e.target.value || 'cap'; try { localStorage.setItem('oilbasis.krSort', krSort); } catch {} }
    else { krFilter[k] = e.target.value; saveKrFilter(); }
    renderKorea();
    return;
  }
  if (e.target && (e.target.id === 'kr-cmp' || e.target.id === 'jp-cmp')) {
    const ref = await resolveCompare(e.target.value);
    if (ref) setCompare(ref);
    return;
  }
  if (!(e.target && e.target.dataset && e.target.dataset.jpf)) return;
  const k = e.target.dataset.jpf;
  if (k === 'sort') { jpSort = e.target.value; try { localStorage.setItem('oilbasis.jpSort', jpSort); } catch {} }
  else { jpFilter[k] = e.target.value; saveJpFilter(); }
  renderJapan();
});

document.addEventListener('keydown', async (e) => {
  if (!(e.target && ['co-cmp', 'jp-cmp', 'kr-cmp'].includes(e.target.id))) return;
  const box = { 'co-cmp': 'us-sugg', 'jp-cmp': 'jp-sugg', 'kr-cmp': 'kr-sugg' }[e.target.id];
  if (e.key === 'Escape') { hideSuggestions(box); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = document.querySelector(`#${box} [data-sugg]`);
  if (first) { setCompare(first.dataset.sugg); return; }
  const ref = await resolveCompare(e.target.value);
  if (ref) setCompare(ref);
});

// A benchmark ref like us:MSFT in the box is replaced by typing, not appended to.
document.addEventListener('focusin', (e) => {
  if (e.target && ['co-cmp', 'jp-cmp', 'kr-cmp'].includes(e.target.id)) e.target.select();
});

document.addEventListener('input', (e) => {
  if (e.target && e.target.dataset && e.target.dataset.jpf) {
    const k = e.target.dataset.jpf;
    if (k === 'sort') { jpSort = e.target.value; try { localStorage.setItem('oilbasis.jpSort', jpSort); } catch {} }
    else { jpFilter[k] = e.target.value; saveJpFilter(); }
    renderJapan();
    return;
  }
  if (e.target && e.target.id === 'co-search') {
    if (coRegion === 'jp') { jpQuery = e.target.value || ''; jpSel = null; renderJapan(); return; }
    if (coRegion === 'kr') { krQuery = e.target.value || ''; krSel = null; renderKorea(); return; }
    coQuery = e.target.value || ''; coCik = null; renderCompanies(); return;
  }
  if (e.target && (e.target.id === 'co-cmp' || e.target.id === 'jp-cmp' || e.target.id === 'kr-cmp')) {
    const box = { 'co-cmp': 'us-sugg', 'jp-cmp': 'jp-sugg', 'kr-cmp': 'kr-sugg' }[e.target.id];
    clearTimeout(suggTimer);
    const input = e.target;
    suggTimer = setTimeout(() => showSuggestions(input, box), 180);
    return;
  }
});
