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
let marketRead = null;         // /api/marketread payload for currentMarket
let lastFx = null;             // latest FX quotes (for the top ticker)
let macroMd = null;            // /api/macrodash payload (macro tab)
let macroRegion = 'us';        // selected macro region
let macroCountries = null;     // /api/countries — country lists per region
let macroCountry = 'us';       // selected country
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
    <dt>Futures ("paper")</dt><dd>A contract to buy oil later — a financial bet, not real barrels.</dd>
    <dt>Real barrels ("physical")</dt><dd>The going rate to actually deliver oil now.</dd>
    <dt>The gap</dt><dd>Real price − futures price. Positive = real barrels cost <b>more</b> than futures → market is <b>tight</b>. Negative = the opposite (plenty of oil).</dd>
    <dt>Pricier now than later</dt><dd>Called “backwardation” — a sign oil is scarce today. The opposite means well supplied.</dd>
    <dt>Refining profit</dt><dd>What a refiner earns turning crude into fuel (a “crack spread”). Higher = better for refiners.</dd>
    <dt>Brent vs WTI</dt><dd>The two main oil types. A wide gap means seaborne Brent is in demand for export.</dd>
    <dt>Prices for later months</dt><dd>The list of prices for each future month — the shape tells you if oil is tight or well supplied.</dd>
    <dt>% change</dt><dd>How much a price moved over the chosen window, not just today.</dd>
    <dt>How extreme</dt><dd>Where today’s number sits vs the last 2 years (90+/100 = near a record).</dd>
    <dt>Stockpiles</dt><dd>Weekly US oil inventories. A surprise <b>drop</b> is bullish for oil; a surprise <b>build</b> is bearish.</dd>
    <dt>Oil-field flames</dt><dd>Satellites see the gas burned off at oil fields — fewer flames = fields shutting down.</dd>
  </dl>`;

function showError(msg) { const el = $('error'); el.classList.remove('hidden'); el.textContent = '⚠ ' + msg; }
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`); return r.json(); }
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
    : '<div class="dimtext" style="padding:12px">Nothing pinned yet — open <b>COMMODITIES</b> and click <b>☆</b> on any instrument to pin it here.</div>';
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
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
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
  const mk = markets.find((x) => x.id === $('bp-metric').value);
  const b = data.benchmarks.find((x) => x.id === (mk ? mk.primary : $('bp-metric').value));
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
    [`${(mk ? mk.label : b.label).toUpperCase()} PRICE`, val == null ? '—' : `${Number(val).toFixed(dp)} <span class="dimtext">${b.unit}</span>`, ''],
    ['TODAY', day == null ? '—' : pctf(day), cls(day)],
    ['PAST 6 MONTHS', six == null ? '—' : pctf(six), cls(six)],
    ['30-DAY JUMPINESS', vol == null ? '—' : vol.toFixed(1) + '%', ''],
    ['IN 6-MONTH RANGE', pos == null ? '—' : `${pos.toFixed(0)}/100`, pctClass(pos)],
    [b.physical != null ? 'REAL vs FUTURES' : 'SOURCE', b.physical != null ? signed(b.basis, dp) : 'futures only', cls(b.basis)],
  ];
  const bits = [];
  if (day != null) bits.push(`${mk ? mk.label : b.label} is ${day >= 0 ? 'up' : 'down'} <b>${Math.abs(day).toFixed(1)}%</b> today`);
  if (six != null) bits.push(`${Math.abs(six).toFixed(0)}% ${six >= 0 ? 'higher' : 'lower'} over 6 months`);
  if (pos != null) bits.push(pos >= 70 ? 'near the top of its range' : pos <= 30 ? 'near the bottom of its range' : 'mid-range');
  if (vol != null) bits.push(vol > 35 ? 'very jumpy' : vol > 20 ? 'fairly jumpy' : 'calm');
  if (b.basis != null) bits.push(`real barrels ${b.basis >= 0 ? 'above' : 'below'} futures by ${Math.abs(b.basis).toFixed(dp)}`);
  // components strip (only when a market bundles more than one instrument)
  const comps = (mk ? mk.components.map((c) => data.benchmarks.find((x) => x.id === c.id)) : []).filter(Boolean);
  const compStrip = comps.length > 1 ? `<div class="bp-comps">${comps.map((c) => {
    const a = c.paper != null ? history?.series?.[c.id]?.paper : history?.series?.[c.id]?.physical;
    const pc = pctOf(a); const v = c.paper != null ? c.paper : c.physical;
    return `<span class="bp-comp"><span class="bp-comp-l">${c.label.replace(/\s*\(.*\)/, '')}</span><b>${v == null ? '—' : Number(v).toFixed(c.dp)}</b> <em class="${cls(pc)}">${pc == null ? '' : pctf(pc)}</em></span>`;
  }).join('')}</div>` : '';
  const spreadLine = (mk && mk.id === 'crude' && data.spreads?.brent_wti)
    ? `<div class="read-line">Brent − WTI spread: <b>${signed(data.spreads.brent_wti.paper, 2)}</b> futures · <b>${signed(data.spreads.brent_wti.physical, 2)}</b> real barrels.</div>` : '';
  el.innerHTML = `<div class="bp-head">${mk ? mk.label : b.label}</div>`
    + `<div class="bp-grid">${cells.map(([k, v, c]) => `<div class="bp-cell"><div class="bp-k">${k}</div><div class="bp-v ${c || ''}">${v}</div></div>`).join('')}</div>`
    + `<div class="bp-deltas">${deltaStrip(headDeltas(b))}${freshStrip(b)}</div>`
    + compStrip + spreadLine
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
  try { marketRead = await getJSON('/api/marketread?id=' + encodeURIComponent(currentMarket)); } catch { marketRead = null; }
  renderAdaptive();
}
function renderAdaptive() {
  const mk = markets.find((x) => x.id === currentMarket);
  setTitle('tightness-title', '⚡ ' + (mk ? `IS ${mk.label.toUpperCase()} TIGHT / STRETCHED?` : 'READING…'));
  setTitle('tightness-sub', 'range · volatility · positioning · curve');
  if (!marketRead || marketRead.id !== currentMarket || marketRead.error) {
    $('bottomline').innerHTML = '<div class="dimtext" style="padding:10px 12px">reading the market…</div>';
    $('tightness').innerHTML = '<div class="dimtext" style="padding:10px 12px">loading…</div>';
    return;
  }
  const r = marketRead, v = r.verdict;
  const score = v.score;
  const ph = v.physical || { score: null, label: '—', parts: [], note: '' };
  const kl = score == null ? 'elevated' : score >= 70 ? 'high' : score >= 40 ? 'elevated' : 'low';
  const phCls = ph.score == null ? '' : ph.score >= 58 ? 'pos' : ph.score <= 42 ? 'neg' : '';
  const vk = ph.score == null ? (score == null ? 'mixed' : score >= 55 ? 'tight' : score >= 35 ? 'mixed' : 'loose') : ph.score >= 58 ? 'tight' : ph.score <= 42 ? 'loose' : 'mixed';
  if ($('regime')) $('regime').textContent = regLine(r);
  const next = [...(v.catalysts || []).map((c) => `Watch: <b>${c}</b>`), ...(v.watch || [])];
  const chips = [...(v.tickersUp || []).map((t) => `<span class="chip up">▲ ${t}</span>`), ...(v.tickersDown || []).map((t) => `<span class="chip down">▼ ${t}</span>`)].join('');
  const kp = (r.takeaways || []).length ? r.takeaways.map((t) => `<li>${t}</li>`).join('') : '<li class="dimtext">No key points yet.</li>';
  $('bottomline').innerHTML = `<div class="bl">
      <div class="bl-score ${kl}"><div class="bl-num">${score == null ? '—' : score}<span>/100</span></div><div class="bl-lbl">PRICE STRETCH<div class="bl-tag">${v.label}</div></div>
        <div class="bl-phys"><div class="bl-phys-k">PHYSICAL TIGHTNESS</div><div class="bl-phys-v ${phCls}">${ph.score == null ? 'no free data' : `${ph.score}<span>/100</span> ${ph.label}`}</div></div>
      </div>
      <div class="bl-sec"><div class="gtitle">WHAT HAPPENED</div><p>${v.meaning} ${(v.notes || []).join(' ')}</p></div>
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
  if (r.macro?.usd != null) push('Link to the US dollar', `${r.macro.usd}`, 'MID', '3-month correlation (negative = moves against the dollar)');
  const physChips = (ph.parts && ph.parts.length) ? `<div class="phys-parts">${ph.parts.map((p) => `<span class="phys-part ${p.score >= 58 ? 'tight' : p.score <= 42 ? 'loose' : ''}">${p.label} <b>${p.score}</b> ${p.score >= 58 ? 'TIGHT' : p.score <= 42 ? 'LOOSE' : 'BALANCED'}</span>`).join('')}</div>` : '';
  const physNote = ph.note ? `<div class="phys-note dimtext">${ph.note}</div>` : '';
  const psParts = (v.priceStretch && v.priceStretch.parts) || [];
  const psChips = psParts.length ? `<div class="phys-parts"><span class="dimtext" style="align-self:center">price stretch:</span>${psParts.map((p) => `<span class="phys-part">${p.label} <b>${p.score}</b></span>`).join('')}</div>` : '';
  const priceLine = score == null ? 'price stretch unavailable' : `price is <b>${v.label.toLowerCase()}</b> (${score}/100)`;
  const physLine = ph.score == null ? 'physical tightness unavailable' : `the physical market is <b>${ph.label.toLowerCase()}</b> (${ph.score}/100)`;
  $('tightness').innerHTML = `<div class="verdict ${vk}">${r.label}: ${priceLine} · ${physLine}.</div>${psChips}${physChips}${physNote}<div class="ev-list">${ev.map((e) => `<div class="ev"><span class="ev-l">${e.label}</span><span class="ev-v">${e.value}</span><span class="tag ${e.dir.toLowerCase()}">${e.dir}</span><span class="ev-n dimtext">${e.note}</span></div>`).join('')}</div>`;
  const si = $('ships-insights');
  if (si) si.innerHTML = r.hasShips ? tankerInsights(tankerInfo).map((x) => `<li>${x}</li>`).join('') : '';
  renderAlerts(marketAlerts(r));
  renderMarketContext(r);
  setTitle('xa-seg', mk ? mk.label.toUpperCase() : '');
  const xa = $('crossasset');
  if (xa) xa.innerHTML = crossAssetBlock((i) => (i.segments || []).includes(currentMarket));
}
async function loadNews() {
  const el = $('news');
  if (!el) return;
  el.innerHTML = '<div class="dimtext" style="padding:8px 12px">loading headlines…</div>';
  try { renderNews(await getJSON('/api/news?id=' + encodeURIComponent(currentMarket))); }
  catch { el.innerHTML = '<div class="dimtext" style="padding:8px 12px">headlines unavailable right now</div>'; }
}
function renderNews(n, elId = 'news', subId = 'news-sub') {
  const el = $(elId);
  if (!el) return;
  const items = (n && n.items) || [];
  const sub = $(subId);
  const lbl = (n && n.label) || '';
  if (sub) sub.textContent = lbl + ' · tier-1 wire · refreshes daily';
  if (!items.length) { el.innerHTML = '<div class="dimtext" style="padding:8px 12px">No recent tier-1 headlines for this segment.</div>'; return; }
  el.innerHTML = items.map((it) => `<a class="news-item" href="${it.url}" target="_blank" rel="noopener noreferrer"><span class="news-src">${it.source || 'wire'}</span><span class="news-t">${it.kind ? `<em class="news-k">${it.kind}</em> ` : ''}${it.title}</span><span class="news-d dimtext">${ago(it.date)}</span></a>`).join('')
    + '<div class="dimtext" style="padding:6px 12px;font-size:10px">Headlines via Google News · © the respective publishers · links open at the source.</div>';
}
function selectMarket(id) {
  currentMarket = id;
  renderSnapshot();
  renderMarketState();
  toggleMarketBlocks();
  if (data) { renderCards(data); buildMetricOptions(data); }
  setCardsTitle();
  renderCurveForSegment();   // the curve follows the segment
  loadCurveHistory();        // and so does the curve-over-time (or hides)
  loadSeasonal();            // and the seasonality grade (gas/grains/softs)
  renderAdaptive();
  loadMarketRead();
  loadNews();
  loadFundamentals();
  renderChart();
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
  $('alerts').innerHTML = alerts.length ? alerts.map((a) => `<div class="alert ${a.level}"><span class="badge">${a.level === 'high' ? 'HIGH' : 'WATCH'}</span> ${a.text}</div>`).join('') : '<div class="alert none">✅ No alerts — markets within normal ranges.</div>';
  if ('Notification' in window && Notification.permission === 'granted') for (const a of alerts) if (a.level === 'high' && !seenAlerts.has(a.text)) { seenAlerts.add(a.text); try { new Notification('Oil market alert', { body: a.text }); } catch {} }
}
// Home: every alert firing, from both engines, severity-sorted.
const ALERT_RANK = { high: 0, med: 1, watch: 2 };
function allAlerts() {
  const out = serverAlerts.map((a) => ({ level: a.level, text: a.text }));
  if (data) for (const a of computeAlerts(data, tankerInfo)) out.push({ level: a.level, text: a.text });
  return out.sort((x, y) => (ALERT_RANK[x.level] ?? 3) - (ALERT_RANK[y.level] ?? 3));
}
function renderHomeAlerts() {
  const el = $('home-alerts');
  if (!el) return;
  const list = data ? allAlerts() : [];
  const c = $('home-alert-count');
  if (c) { c.textContent = String(list.length); c.className = 'pill ' + (list.some((a) => a.level === 'high') ? 'warn' : list.length ? '' : 'ok'); }
  const sub = $('home-alert-sub');
  if (sub) sub.textContent = 'server checks (basis extremes, data quality, idle ships) + your own thresholds · edit thresholds in COMMODITIES → MORE DETAIL';
  el.innerHTML = list.length
    ? list.map((a) => `<div class="alert ${a.level}"><span class="badge">${a.level === 'high' ? 'HIGH' : a.level === 'watch' ? 'CHECK' : 'WATCH'}</span> ${a.text}</div>`).join('')
    : '<div class="alert none">✅ No alerts — markets within normal ranges.</div>';
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
  // Reuse the existing track element so the marquee animation never restarts (only its
  // children are refreshed). Rebuilding #ticker.innerHTML would reset the scroll.
  const track = ticker.querySelector('.ticker-track');
  if (track) track.innerHTML = `${one}${one}`;
  else ticker.innerHTML = `<div class="ticker-track">${one}${one}</div>`;   // two copies → seamless marquee
}

// ---------------------------------------------------------------------------
// Chart (6M and 10Y)
// ---------------------------------------------------------------------------
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
function chartOpts() {
  return { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#7c8a99', boxWidth: 12, font: { family: 'monospace' } } },
      tooltip: {
        callbacks: {
          title: (items) => (items && items.length ? String(items[0].label) : ''),
          label: (ctx) => {
            const v = ctx.parsed.y, ds = ctx.dataset.data;
            if (v == null) return `${ctx.dataset.label}: —`;
            let out = `${ctx.dataset.label}: ${Number(v).toFixed(chartDp || 2)}`;
            const first = ds.find((x) => x != null);
            if (first) out += `   ${signed(((v - first) / first) * 100, 1)}% vs start`;
            if (chartAnchor != null && ds[chartAnchor] != null) out += `  ·  ${signed(((v - ds[chartAnchor]) / ds[chartAnchor]) * 100, 1)}% vs ●`;
            return out;
          },
        },
      },
    },
    scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 10 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99' }, grid: { color: '#151a20' } } } };
}
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
    catch (e) { showError(e.message); return; }
    if (!r || r.error || (!r.dates && !r.months)) { showError('No chart data for ' + metric.replace(/^fx:|^basis:/, '')); return; }
    labels = r.dates || r.months;
    chartDp = r.dp ?? chartDp;
    datasets = seriesLines(r);
    summary = chartSummary(r, RANGE_YEARS[range] ? RANGE_YEARS[range] + 'Y' : range.toUpperCase());
    if (r.kind === 'basis') bands = basisBands(r.series.paper);
  }

  $('lt-summary').textContent = (summary ? summary + '  ·  ' : '') + 'hover any point for its % change · click to drop an anchor (●), hover again to measure between two';
  const chartData = { labels, datasets };
  if (chart) { chart.$bands = bands; chart.data = chartData; chart.update(); return; }
  chart = new Chart($('chart'), { type: 'line', data: chartData, options: chartOpts(), plugins: [anchorLine, bandsPlugin] });
  chart.$bands = bands;
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
    datasets = [line(A.label, ia, '#4aa3ff'), line(B.label, ib, '#c06bff')];
    const rateNote = (A.kind === 'rate' || B.kind === 'rate') ? ' · a yield is already a %, so this is its % change (not pp)' : '';
    summary = `${A.label} ${pctf(pct(a2))} vs ${B.label} ${pctf(pct(b2))} over ${label} · both start at 100${rateNote}`;
  }
  if (sum) sum.textContent = summary;
  const opts = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#7c8a99', boxWidth: 12, font: { family: 'monospace' } } },
      tooltip: { callbacks: { title: (it) => (it.length ? String(it[0].label) : ''), label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? '—' : Number(ctx.parsed.y).toFixed(chartDp)}` } } },
    scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 10 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99' }, grid: { color: '#151a20' } } } };
  const chartData = { labels: axis, datasets };
  if (cmpChart) { cmpChart.data = chartData; cmpChart.options = opts; cmpChart.update(); return; }
  cmpChart = new Chart(cv, { type: 'line', data: chartData, options: opts, plugins: [] });
}

async function loadHistory() { history = await getJSON('/api/history'); }
// Re-pull the daily history and redraw everything that depends on it (the 1D/1W/1M/YTD/1Y
// strips + sparklines), so they keep up as new daily bars arrive — not just at page load.
async function reloadHistory() {
  try { await loadHistory(); } catch { return; }
  if (!data) return;
  renderCards(data); renderSnapshot(); renderMarketState(); renderTicker(data); renderWatchlist();
  if ($('range') && $('range').value === '6m') renderChart();
}
async function loadMarket() {
  data = await getJSON('/api/market');
  renderCards(data); buildMetricOptions(data); buildBpOptions();
  renderMarketState(); renderSnapshot(); setCardsTitle(); renderTicker(data);
  renderWatchlist(); renderHomeAlerts();
  await renderChart();   // ← render AFTER data exists
  buildCompareOptions(); renderCompare();
  loadSeasonal();
  loadMarketRead();      // populate the adaptive Big Picture (hero line + panels)
  loadNews();
  $('updated').textContent = 'prices ' + new Date(data.updated).toLocaleTimeString();
  $('notes').innerHTML = `<details class="fold"><summary>SOURCES, NOTES &amp; DISCLAIMER</summary><div class="note-body"><ul>` +
    data.notes.map((n) => `<li>${n}</li>`).join('') + '</ul>' +
    '<div class="disc">Sources: FRED/EIA (spot), Yahoo (futures), aisstream.io (AIS), CFTC (positioning). For information only — <b>not investment advice</b>. Figures may be delayed or indicative.</div></div></details>';
}

// ---------------------------------------------------------------------------
// Tankers
// ---------------------------------------------------------------------------
let map, layer;
function initMap() {
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
  tankerInfo = await getJSON('/api/tankers');
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
function renderContext(m, a, macro) {
  if (!a) { $('context').innerHTML = '<div class="dimtext" style="padding:10px 12px">loading…</div>'; return; }
  const rows = [];
  for (const b of m.benchmarks) {
    const an = a.benchmarks?.[b.id];
    if (!an || an.basisPct == null) continue;
    rows.push(ctxRow(`${b.label}: real vs futures`, an.basisPct, `<span class="${cls(b.basis)}">${signed(b.basis, b.dp)}</span>`));
  }
  if (a.spread?.pct != null) rows.push(ctxRow('Brent vs WTI (real)', a.spread.pct, signed(a.spread.brentWtiPhysical, 2)));
  const arb = a.arb ? `<div class="arb">💡 <b>Export read (rough):</b> US crude is ${signed(a.arb.spread, 2)}/bbl cheaper than Brent. Even after an assumed ${a.arb.freight.toFixed(2)}/bbl shipping cost, that’s ${signed(a.arb.net, 2)}/bbl — ${a.arb.open ? 'a wide gap that <b>normally</b> pulls US barrels to Europe' : 'too thin to encourage exports'}. <span class="warn">A gap this wide is unusual — likely inflated by slightly old real-barrel prices, so treat it as a rough guide, not a real trade.</span></div>` : '';
  const vols = m.benchmarks.map((b) => { const an = a.benchmarks?.[b.id]; return an && an.vol30 != null ? `<span class="choke"><b>${an.vol30.toFixed(1)}%</b> ${b.label.replace(/\s*\(.*\)/, '')}</span>` : ''; }).filter(Boolean).join('');
  const volStrip = vols ? `<div class="chokes"><div class="chokes-h">HOW JUMPY PRICES HAVE BEEN (last 30 days, yearly pace)</div>${vols}</div>` : '';
  const qf = data?.quality?.flags || [];
  const quality = `<div class="qflags"><div class="chokes-h">DATA CHECKS</div>${
    qf.length ? qf.map((f) => `<div class="qflag ${f.level}">⚠ ${f.text}</div>`).join('')
      : '<div class="qflag ok">✓ Everything checks out — real prices and futures line up.</div>'}</div>`;
  const macroItems = (macro?.items || []).map((x) => `<span class="choke"><b class="${cls(x.pct)}">${x.pct != null ? pctf(x.pct) : '—'}</b> ${x.label}</span>`).join('');
  const macroStrip = macroItems ? `<div class="chokes"><div class="chokes-h">MACRO CONTEXT (oil rarely moves alone)</div>${macroItems}</div>` : '';
  $('context').innerHTML = rows.join('') + arb + volStrip + macroStrip + quality;
}
function renderInventories(d) {
  if (!d || !d.items?.length) { $('inventories').innerHTML = '<div class="dimtext" style="padding:10px 12px">EIA key needed, or no data.</div>'; return; }
  const LBL = { crude: 'Crude oil', cushing: 'Cushing (delivery hub)', gasoline: 'Gasoline', distillate: 'Diesel & heating oil', spr: 'Strategic reserve' };
  $('inv-date').textContent = 'weekly US stockpiles · week of ' + d.items[0].period;
  const fmtN = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  const crude = d.items.find((i) => i.key === 'crude');
  const read = crude?.surprise != null
    ? (crude.surprise < 0 ? '🛢️ Crude stocks <b>fell more than usual</b> this week → bullish for oil.' : '🛢️ Crude stocks <b>built more than usual</b> → bearish for oil.')
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
    (d.gas ? `<div class="read-line" style="border-top:1px solid var(--line)">🔥 Natural gas storage: <b>${d.gas.value.toLocaleString()} BCF</b> (${d.gas.wow >= 0 ? '+' : ''}${d.gas.wow} this week${d.gas.surprise != null ? `, vs a normal ${d.gas.surprise >= 0 ? '+' : ''}${d.gas.surprise}` : ''}) — ${d.gas.wow < 0 ? 'a draw is bullish for gas' : 'a build is bearish for gas'}.</div>` : '');
}
function sparkline(vals, w = 240, h = 40) {
  const xs = vals.filter((v) => v != null);
  if (xs.length < 2) return '';
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
  const data = { labels: d.dates, datasets: [{ label: 'WTI: this month − next month', data: d.m1m2, borderColor: '#ff9e00', backgroundColor: '#ff9e0022', borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false }] };
  const opts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#7c8a99', boxWidth: 10, font: { family: 'monospace' } } } }, scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 8 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99' }, grid: { color: '#151a20' } } } };
  if (curveHistChart) { curveHistChart.data = data; curveHistChart.update(); return; }
  curveHistChart = new Chart(cv, { type: 'line', data, options: opts });
}
function renderCurve(d) { if (!d) return; $('curve').innerHTML = curveBlock('WTI', d.wti) + curveBlock('Brent', d.brent); }
// The curve ALWAYS follows the selected segment (no second picker).
async function renderCurveForSegment() {
  const mk = markets.find((x) => x.id === currentMarket);
  setTitle('curve-title', mk ? mk.label.toUpperCase() : '');
  const el = $('curve');
  if (!el) return;
  if (currentMarket === 'crude') { try { renderCurve(await getJSON('/api/curve')); return; } catch {} }
  const comps = ((mk ? mk.components : []).map((c) => data.benchmarks.find((x) => x.id === c.id))).filter((b) => b && b.curve);
  el.innerHTML = '<div class="dimtext" style="padding:10px 12px">loading curve…</div>';
  const results = await Promise.all(comps.map((b) => getJSON('/api/termstructure?id=' + encodeURIComponent(b.id)).catch(() => null)));
  const html = results.filter((r) => r && r.available).map((r) => curveBlock(r.label, r)).join('');
  el.innerHTML = html || '<div class="dimtext" style="padding:10px 12px">No free month-by-month curve for this segment — only a front-month price.</div>';
}
// Seasonality — where the price sits vs its 5-year day-of-year band (gas/grains/softs).
async function loadSeasonal() {
  const el = $('seasonal');
  if (!el || !data) return;
  const mk = markets.find((x) => x.id === currentMarket);
  const b = mk ? data.benchmarks.find((x) => x.id === mk.primary) : null;
  if (!b) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="dimtext" style="padding:10px 12px">reading 5-year seasonality…</div>';
  let sea; try { sea = await getSeasonal(b.id); } catch { sea = null; }
  renderSeasonal(sea, b);
}
function renderSeasonal(sea, b) {
  const el = $('seasonal');
  if (!el) return;
  const sub = $('seasonal-sub');
  if (sub) sub.textContent = b ? `${b.label} · 5-year, day-of-year` : '';
  const g = sea && !sea.error ? sea.grade : null;
  if (!g) { el.innerHTML = '<div class="dimtext" style="padding:10px 12px">No 5-year seasonal history for this instrument.</div>'; return; }
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
  if (!a || a.error) { $('analogue').innerHTML = `<div class="dimtext" style="padding:10px 12px">${a?.error || 'loading…'}</div>`; return; }
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
function renderBottomLine(m, tn, fl, flares, sar) {
  if (!m || !tn) return;
  const total = tn.evidence?.length || 1;
  const stress = fl?.marketStress?.score ?? 0;
  const gulfDark = (fl?.dark || []).some((n) => /Persian|Hormuz|Oman|Arabian|Red Sea/.test(n));
  let flareNote = '', flareTight = 0;
  if (flares?.trend?.length >= 2) {
    const today = flares.trend[flares.trend.length - 1].count;
    const prev = flares.trend.slice(0, -1);
    const avg = prev.reduce((a, b) => a + b.count, 0) / prev.length;
    const pct = Math.round(((today - avg) / avg) * 100);
    if (pct <= -15) { flareTight = 8; flareNote = `Oil-field flames are <b>down ${Math.abs(pct)}%</b> — production being shut in.`; }
    else if (pct >= 15) flareNote = `Oil-field flames are <b>up ${pct}%</b> — production rising.`;
    else flareNote = `Oil-field flames steady (${today} seen).`;
  } else if (flares?.total != null) {
    flareNote = `Satellites see <b>${flares.total}</b> oil-field flames in the Gulf.`;
  }
  const score = Math.round(Math.min(100, (tn.tight / total) * 55 + (stress / 3) * 27 + (gulfDark ? 10 : 0) + flareTight));
  const label = score >= 70 ? 'HIGH' : score >= 40 ? 'ELEVATED' : 'LOW';
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const tight = (by.brent?.basis ?? 0) > 0;
  const meaning = `Real barrels are ${tight ? '<b>scarce and pricier than futures</b> (a tight market)' : '<b>plentiful</b> (a well-supplied market)'}, and Gulf shipping is ${gulfDark ? '<b>going dark — ships switching off trackers</b>' : 'flowing normally'}. ${sar?.latest ? `Our last radar look at the Gulf was ${new Date(sar.latest.time).toLocaleDateString()}. ` : ''}${flareNote} ${score >= 70 ? 'Bottom line: the market is pricing a real supply squeeze — expect sharp swings.' : score >= 40 ? 'Some tightness, but not extreme.' : 'No major tightness right now.'}`;
  const watch = ['<b>Weekly US oil stocks</b> — every Wednesday, 10:30am New York time (the week\u2019s biggest mover)'];
  if (tight) watch.push('The <b>price gap between this month and next</b> — if it shrinks, tightness is fading');
  if (gulfDark) watch.push('The <b>next satellite radar pass</b> over the Gulf (Ships tab) — our tracker-independent look');
  watch.push('Whether ships are <b>avoiding the Red Sea</b> and going around Africa (Ships tab)');
  if (flares) watch.push('The <b>oil-field flames</b> (Ships tab) — fewer flames = production being cut');
  const impact = tight || score >= 60
    ? 'Typically <b>helps</b> oil producers and refiners, and <b>hurts</b> heavy fuel users like airlines and trucking.'
    : 'Typically <b>eases</b> the squeeze on airlines and trucking, and <b>weighs on</b> producers.';
  const companies = tight || score >= 60 ? ['COP', 'EOG', 'OXY', 'VLO', 'PSX', 'MPC'] : ['DAL', 'UAL', 'AAL', 'LUV'];
  $('bottomline').innerHTML = `
    <div class="bl">
      <div class="bl-score ${label.toLowerCase()}"><div class="bl-num">${score}<span>/100</span></div><div class="bl-lbl">OIL MARKET STRESS<div class="bl-tag">${label}</div></div></div>
      <div class="bl-sec"><div class="gtitle">WHAT IT MEANS</div><p>${meaning}</p></div>
      <div class="bl-sec"><div class="gtitle">WHAT TO WATCH NEXT</div><ul>${watch.map((w) => `<li>${w}</li>`).join('')}</ul></div>
      <div class="bl-sec"><div class="gtitle">WHO IT HELPS / HURTS</div><p>${impact}</p><div class="bl-chips">${companies.map((c) => `<span class="chip">${c}</span>`).join('')}</div></div>
    </div>`;
}
function renderTightness(d) {
  if (!d || d.error) { $('tightness').innerHTML = '<div class="dimtext" style="padding:10px 12px">loading…</div>'; return; }
  const k = d.tight > d.loose ? 'tight' : d.loose > d.tight ? 'loose' : 'mixed';
  const rows = d.evidence.map((e) => `<div class="ev"><span class="ev-l">${e.label}</span><span class="ev-v ${e.direction === 'TIGHT' ? 'pos' : e.direction === 'LOOSE' ? 'neg' : ''}">${e.value}</span><span class="tag ${e.direction.toLowerCase()}">${e.direction}</span><span class="ev-n dimtext">${e.note}</span></div>`).join('');
  $('tightness').innerHTML = `<div class="verdict ${k}">${d.verdict}</div><div class="ev-list">${rows}</div>`;
}
function renderFlows(d) {
  if (!d?.regions) { $('flows').innerHTML = ''; return; }
  const regions = d.regions.map((r) => `<span class="choke"><b>${r.count}</b> ${r.name}</span>`).join('');
  const rates = (d.rates || []).map((r) => `<span class="choke ${r.perMin === 0 ? 'cold' : ''}"><b>${r.perMin}</b>/min ${r.name}</span>`).join('');
  const e = d.exit; const total = (e.eastbound + e.westbound) || 1;
  const ew = (e.eastbound / total * 100).toFixed(0), ww = (e.westbound / total * 100).toFixed(0);
  const darkNote = (d.dark && d.dark.length)
    ? `<div class="qflag watch" style="margin:8px 12px">⚠ <b>No ship signals</b> in: ${d.dark.join(', ')} — this area has gone quiet (ships may be switching off trackers, or the feed is limited).</div>`
    : '';
  const ms = d.marketStress;
  const stressHtml = ms ? `<div class="chokes-h dimtext" style="padding:10px 12px 0">WHAT PRICES ARE SAYING (ships go dark, but prices can't)</div>
    <div style="padding:6px 12px 0"><div class="verdict ${ms.score >= 2 ? 'tight' : 'mixed'}">${ms.verdict}</div>
    ${ms.signals.map((s) => `<div class="ev"><span class="ev-l">${s.label}</span><span class="ev-v ${s.hot ? 'pos' : ''}">${s.value != null ? (s.value >= 0 ? '+' : '') + Number(s.value).toFixed(2) : '—'}</span><span class="tag ${s.hot ? 'tight' : 'neutral'}">${s.hot ? 'STRESS' : 'ok'}</span><span class="ev-n dimtext">${s.hot ? 'pricing disruption' : 'normal'}</span></div>`).join('')}</div>` : '';
  const an = d.anomalies || {};
  const anHtml = (an.spoof || an.darkGap) ? `<div class="chokes-h dimtext" style="padding:0 12px">TRACKER ODDITIES (ships we can still see)</div>
    <div class="chokes"><span class="choke"><b>${an.spoof || 0}</b> fake jumps (spoofing)</span><span class="choke"><b>${an.darkGap || 0}</b> went silent (hidden trips)</span></div>` : '';
  const routes = (d.routes || []).map((r) => `<span class="choke ${r.perMin === 0 ? 'cold' : ''}"><b>${r.count}</b> ${r.name} <span class="dimtext">${r.perMin}/min</span></span>`).join('');
  const routesHtml = `<div class="chokes-h dimtext" style="padding:0 12px">ARE SHIPS DODGING CHOKEPOINTS?</div><div class="chokes">${routes}</div>`;
  const divHtml = d.diversion ? `<div class="qflag watch" style="margin:8px 12px">🧭 ${d.diversion}</div>` : '';
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
    { label: 'Diesel', data: h.diesel, borderColor: '#ff9e00', borderWidth: 2, pointRadius: 0, tension: 0.25 },
    { label: 'Gasoline', data: h.gasoline, borderColor: '#4aa3ff', borderWidth: 2, pointRadius: 0, tension: 0.25 },
    { label: '3-2-1', data: h.c321, borderColor: '#00c853', borderWidth: 1.5, pointRadius: 0, tension: 0.25 },
  ] };
  const opts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#7c8a99', boxWidth: 10, font: { family: 'monospace' } } } }, scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 8 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99' }, grid: { color: '#151a20' } } } };
  if (crackHistChart) { crackHistChart.data = data; crackHistChart.update(); return; }
  crackHistChart = new Chart(cv, { type: 'line', data, options: opts });
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
  img.onerror = () => { const s = $('sar-count'); if (s) s.textContent = 'image unavailable right now'; };
  img.src = '/api/sar/image';
}

function renderSatellite(sar, flares) {
  let html = '';
  if (sar && !sar.error) {
    const latest = sar.latest ? new Date(sar.latest.time).toLocaleString() : '—';
    html += `<div class="read-line">👁️ <b>How we can still see the Gulf from space.</b> This is <b>radar, not a photo</b> — so it works at night and through cloud. Latest pass: <b>${latest}</b>.</div>
      <div class="legend"><span class="lg"><i class="sw bright"></i> bright = a solid object (ship, platform) or land</span><span class="lg"><i class="sw dark"></i> dark = open water</span><span class="lg"><i class="sw circle"></i> red circle = a small object we spotted</span></div>
      <div class="sarimg"><canvas id="sar-canvas"></canvas><div id="sar-count" class="dimtext">reading the image…</div></div>`;
  }
  if (flares && !flares.error) {
    const regions = Object.entries(flares.byRegion || {}).map(([k, v]) => `<span class="choke"><b>${v}</b> ${k}</span>`).join('');
    html += `<div class="read-line" style="border-top:1px solid var(--line)">🔥 <b>Gas flames = how much oil is being produced.</b> Oil fields burn off gas in flames satellites can see from orbit. More flames ≈ more output; fewer ≈ fields shut down. Right now: <b>${flares.total}</b> flames seen in the last day.</div>
      <div class="chokes">${regions}</div>`;
    if (flares.trend?.length > 1) html += `<div class="dimtext" style="padding:4px 12px 10px">flames seen per day: ${flares.trend.map((t) => `${t.date.slice(5)}: ${t.count}`).join(' · ')}</div>`;
  }
  $('satellite').innerHTML = html || '<div class="dimtext" style="padding:10px 12px">no data</div>';
  if (sar && !sar.error) processSar();
}
function renderReroute(d) {
  const cv = $('reroute');
  if (!cv || !d?.series?.length) return;
  const s = d.series;
  const labels = s.map((x) => new Date(x.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const data = { labels, datasets: [
    { label: 'Cape of Good Hope', data: s.map((x) => x.cape), borderColor: '#ff9e00', borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true },
    { label: 'Red Sea / Suez', data: s.map((x) => x.suez), borderColor: '#4aa3ff', borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true },
  ] };
  if (rerouteChart) { rerouteChart.data = data; rerouteChart.update(); return; }
  rerouteChart = new Chart(cv, { type: 'line', data, options: { responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#7c8a99', boxWidth: 10, font: { family: 'monospace' } } } },
    scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 6 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99' }, grid: { color: '#151a20' } } } } });
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
    macroCountry = list[0] ? list[0].id : 'us';
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
  el.innerHTML = '<div class="dimtext" style="padding:8px 12px">loading…</div>';
  const req = macroRegion;
  let items = null;
  try { items = (await getJSON('/api/region-quotes?id=' + req)).items || []; } catch {}
  if (req !== macroRegion) return;
  const scope = $('fx-scope'); if (scope) scope.textContent = req.toUpperCase();
  const seen = new Set();
  const fx = (items || []).filter((i) => i.kind === 'fx').filter((i) => { if (seen.has(i.label)) return false; seen.add(i.label); return true; });
  el.innerHTML = fx.length
    ? '<div class="kpis">' + fx.map((f) => macroTile(f.label, f.price == null ? '—' : Number(f.price).toFixed(f.price < 10 ? 4 : 2), f.pct != null ? pctf(f.pct) : '', cls(f.pct), null, f.deltas ? deltaStrip(f.deltas) : '')).join('') + '</div><div class="macro-note">the chosen region\'s currencies · moves over 1D/1W/1M/YTD/1Y</div>'
    : '<div class="dimtext" style="padding:8px 12px">no currencies for this region</div>';
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
  el.innerHTML = `<div class="macro-note">${label.toUpperCase()}</div><div class="dimtext" style="padding:6px 12px">loading…</div>`;
  const c = await fetchCountry(req);
  if (req !== macroCountry) return;
  if (!c || c.error) { el.innerHTML = `<div class="macro-note">${label.toUpperCase()}</div><div class="dimtext" style="padding:6px 12px">data unavailable for this country</div>`; return; }
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

  if (!c.policy && c.policyNote) html += `<div class="macro-note">🏦 ${c.policyNote}</div>`;
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
  if (d.index && d.index.some((v) => v != null)) datasets.push(line(`${d.indexLabel} (indexed)`, norm(d.index), '#4aa3ff'));
  if (d.fx && d.fx.some((v) => v != null)) datasets.push(line(`${d.fxLabel} (indexed)`, norm(d.fx), '#c06bff'));
  const note = $('macro-chart-note');
  if (note) note.textContent = `${d.label} — both lines start at 100; hover any point for its % change. ${d.indexLabel ? '' : 'Index unavailable free.'}`;
  const data = { labels: d.dates, datasets };
  if (macroChart) { macroChart.data = data; macroChart.update(); return; }
  macroChart = new Chart(cv, { type: 'line', data, options: chartOpts(), plugins: [] });
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
  const data = { labels: policy.history.map((h) => h.date), datasets: [{ label: 'policy rate', data: policy.history.map((h) => h.value), borderColor: '#ff9e00', backgroundColor: '#ff9e0022', borderWidth: 2, pointRadius: 0, stepped: true, fill: false }] };
  const opts = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => (it.length ? it[0].label : ''), label: (ctx) => `policy rate ${ctx.parsed.y}%` } } }, scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 8 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99', callback: (v) => v + '%' }, grid: { color: '#151a20' } } } };
  if (policyChart) { policyChart.data = data; policyChart.update(); return; }
  policyChart = new Chart(cv, { type: 'line', data, options: opts });
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
  const data = { labels: cpi.map((d) => String(d.year)), datasets: [{ label: 'CPI YoY %', data: cpi.map((d) => d.value), borderColor: '#c06bff', backgroundColor: '#c06bff22', borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false }] };
  const opts = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => (it.length ? it[0].label : ''), label: (ctx) => `inflation ${ctx.parsed.y}%` } } }, scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 10 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99', callback: (v) => v + '%' }, grid: { color: '#151a20' } } } };
  if (cpiChart) { cpiChart.data = data; cpiChart.update(); return; }
  cpiChart = new Chart(cv, { type: 'line', data, options: opts });
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
  if (d.short) datasets.push(line(`${d.short.label} yield`, arr(d.short), '#4aa3ff'));
  if (d.long) datasets.push(line(`${d.long.label} yield`, arr(d.long), '#ff9e00'));
  const opts = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#7c8a99', boxWidth: 12, font: { family: 'monospace' } } },
      tooltip: { callbacks: { title: (it) => (it.length ? String(it[0].label) : ''), label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? '—' : Number(ctx.parsed.y).toFixed(2)}%` } } },
    scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 10 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99', callback: (v) => v + '%' }, grid: { color: '#151a20' } } } };
  const chartData = { labels: dates, datasets };
  if (yieldsChart) { yieldsChart.data = chartData; yieldsChart.options = opts; yieldsChart.update(); return; }
  yieldsChart = new Chart(cv, { type: 'line', data: chartData, options: opts, plugins: [] });
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
  if (!cv || !ul || !jl) { if (sum) sum.textContent = 'US or Japan 10-year data unavailable right now.'; return; }
  const dates = [...new Set([...ul.dates, ...jl.dates])].sort();
  const raw = (s) => { const m = new Map(); s.dates.forEach((dt, i) => m.set(dt, s.values[i])); return dates.map((dt) => (m.has(dt) ? m.get(dt) : null)); };
  const usArr = raw(ul);
  const jpArr = []; { let last = null; for (const v of raw(jl)) { if (v != null) last = v; jpArr.push(last); } }
  const spread = ul.latest != null && jl.latest != null ? +(ul.latest - jl.latest).toFixed(2) : null;
  if (note) note.textContent = `US daily · Japan monthly (OECD, carried forward)${us.asOf ? ' · as of ' + us.asOf : ''}`;
  if (sum) sum.textContent = `US 10-yr ${ul.latest == null ? '—' : ul.latest.toFixed(2) + '%'} · Japan 10-yr ${jl.latest == null ? '—' : jl.latest.toFixed(2) + '%'}${spread != null ? ` · US–Japan spread ${spread >= 0 ? '+' : ''}${spread}pp (the carry gap)` : ''}`;
  const datasets = [line('US 10-yr', usArr, '#4aa3ff'), line('Japan 10-yr', jpArr, '#c06bff')];
  const opts = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#7c8a99', boxWidth: 12, font: { family: 'monospace' } } },
      tooltip: { callbacks: {
        title: (it) => (it.length ? String(it[0].label) : ''),
        label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? '—' : Number(ctx.parsed.y).toFixed(2)}%`,
        afterBody: (items) => { const u = items.find((i) => /US/.test(i.dataset.label)); const j = items.find((i) => /Japan/.test(i.dataset.label)); return (u && j && u.parsed.y != null && j.parsed.y != null) ? [`spread: ${(u.parsed.y - j.parsed.y).toFixed(2)}pp`] : []; },
      } } },
    scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 10 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99', callback: (v) => v + '%' }, grid: { color: '#151a20' } } } };
  const chartData = { labels: dates, datasets };
  if (usjpChart) { usjpChart.data = chartData; usjpChart.options = opts; usjpChart.update(); return; }
  usjpChart = new Chart(cv, { type: 'line', data: chartData, options: opts, plugins: [] });
}
async function loadUsJp() {
  if (!$('usjp-chart')) return;
  try { const [us, jp] = await Promise.all([getJSON('/api/yields?id=us'), getJSON('/api/yields?id=jp')]); renderUsJp(us, jp); } catch {}
}
// Cross-asset transmission block — shared by segments and macro regions.
function crossAssetBlock(pred, title) {
  const ideas = ((transmission && transmission.ideas) || []).filter(pred);
  if (!ideas.length) return '<div class="dimtext" style="padding:8px 12px">No strong cross-asset signal right now — moves are within normal ranges.</div>';
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
  el.innerHTML = '<div class="dimtext" style="padding:8px 12px">scanning fundamentals…</div>';
  try { renderFundamentals(await getJSON('/api/fundamentals?id=' + encodeURIComponent(currentMarket))); }
  catch { el.innerHTML = '<div class="dimtext" style="padding:8px 12px">unavailable right now</div>'; }
}
function renderFundamentals(f) {
  const el = $('fundamentals');
  if (!el) return;
  const sub = $('fund-sub');
  if (sub) sub.textContent = (f && f.label ? f.label + ' · ' : '') + 'past-year highlights + recent · auto-tagged from the news';
  const items = (f && f.items) || [];
  if (!items.length) { el.innerHTML = '<div class="dimtext" style="padding:8px 12px">No supply/demand shocks detected in coverage for this segment right now.</div>'; return; }
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
  if (!b || b.error) { el.innerHTML = '<div class="dimtext" style="padding:12px">brief unavailable right now</div>'; return; }
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
  if (el && !el.innerHTML) el.innerHTML = '<div class="dimtext" style="padding:12px">reading the day…</div>';
  try { renderBrief(await getJSON('/api/brief')); } catch { renderBrief(null); }
}
// Live important headlines (hero board).
async function loadHeadlines() {
  const el = $('headlines');
  if (!el) return;
  try { renderHeadlines(await getJSON('/api/headlines')); }
  catch { el.innerHTML = '<div class="dimtext" style="padding:8px 12px">headlines unavailable</div>'; }
}
function renderHeadlines(h) {
  const el = $('headlines');
  if (!el) return;
  const items = (h && h.items) || [];
  if (!items.length) { el.innerHTML = '<div class="dimtext" style="padding:8px 12px">No major commodity headlines right now.</div>'; return; }
  el.innerHTML = items.map((i) => `<a class="hl ${i.effect === 'down' ? 'down' : 'up'}" href="${i.url}" target="_blank" rel="noopener noreferrer"><span class="hl-tag">${i.effect === 'down' ? '▼' : '▲'} ${i.kind}</span><span class="hl-t">${i.title}</span><span class="hl-s dimtext">${i.source}</span></a>`).join('');
}
async function loadMacroNews() {
  const el = $('macro-news');
  if (!el) return;
  const req = macroCountry;
  el.innerHTML = '<div class="dimtext" style="padding:8px 12px">loading headlines…</div>';
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
  $('macro-events').innerHTML = (events || []).map((e) => `<div class="read-line">📅 <b>${e.name}</b>${e.date ? ` — ${e.date}` : ''} <span class="dimtext">${e.note || ''}</span></div>`).join('');
}
function renderRegime(m, a, c) {
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const parts = [];
  if (c?.brent) parts.push(c.brent.shape === 'Backwardation'
    ? '<span title="Prices are higher for sooner delivery — a sign oil is scarce right now.">oil is <b>tight</b> (worth more sooner)</span>'
    : '<span title="Prices are lower for sooner delivery — plenty of oil available.">oil is <b>well supplied</b></span>');
  const bb = by.brent?.basis;
  if (bb != null) parts.push(bb > 0
    ? '<span title="The real (physical) price of Brent is above the futures price.">real barrels cost <span class="pos">more</span> than futures</span>'
    : '<span title="The real price is below the futures price.">real barrels cost <span class="neg">less</span> than futures</span>');
  if (a?.arb) parts.push(a.arb.open
    ? '<span title="US crude is cheaper than Brent by more than a rough shipping estimate — which normally encourages exports to Europe. Rough estimate only.">US oil is much cheaper than Brent → exports to Europe likely</span>'
    : '<span title="US crude is not cheap enough vs Brent to cover rough shipping costs — exports less attractive.">US oil isn’t cheap enough to ship to Europe</span>');
  const dq = (m.quality?.flags || []).length;
  if (dq) parts.push(`<span class="warn" title="Some real-barrel prices are a few days old, so the gap can look off.">⚠ ${dq} data check${dq > 1 ? 's' : ''}</span>`);
  $('regime').innerHTML = `<span class="regime-k">MARKET STATE</span> ${parts.join(' · ')}`;
}
function kpiTile(label, value, sub, klass) {
  return `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v ${klass || ''}">${value}</div><div class="kpi-s dimtext">${sub}</div></div>`;
}
function renderKPIs(m, a, c, pos) {
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const d321 = crackSpreads(m).find((x) => x.label.startsWith('3-2-1'));
  const extreme = (id) => { const v = a?.benchmarks?.[id]?.basisPct; return v == null ? '—' : `${Math.round(v)}/100 extreme vs 2 years`; };
  const shape = c?.brent?.shape === 'Backwardation' ? 'oil pricier now than later' : 'oil cheaper now than later';
  const t = [];
  if (by.brent) t.push(kpiTile('BRENT — REAL vs FUTURES', signed(by.brent.basis, 2), extreme('brent'), cls(by.brent.basis)));
  if (by.wti) t.push(kpiTile('WTI — REAL vs FUTURES', signed(by.wti.basis, 2), extreme('wti'), cls(by.wti.basis)));
  if (m.spreads.brent_wti) t.push(kpiTile('BRENT vs WTI', signed(m.spreads.brent_wti.physical, 2), 'real-barrel gap', cls(m.spreads.brent_wti.physical)));
  if (d321) t.push(kpiTile('REFINING PROFIT', signed(d321.value, 2), d321.value > 18 ? 'very good' : d321.value > 8 ? 'ok' : 'poor', cls(d321.value)));
  if (c?.brent?.m1m2 != null) t.push(kpiTile('PRICE NOW vs NEXT MONTH', signed(c.brent.m1m2, 2), shape, cls(c.brent.m1m2)));
  if (pos?.latest) t.push(kpiTile('HEDGE-FUND NET BET', pos.latest.net.toLocaleString(), `${pos.pct.toFixed(0)}/100 extreme vs 3 years`, cls(pos.latest.net)));
  $('kpis').innerHTML = t.join('');
}
// Curve-over-time only exists for the NYMEX energy roots (CL/BZ/NG/RB/HO);
// it self-hides for metals/ags where the contract-month history isn't free.
const CURVE_ROOT = { crude: { root: 'CL', name: 'CRUDE OIL' }, refined: { root: 'RB', name: 'GASOLINE' }, gas: { root: 'NG', name: 'NATURAL GAS' } };
let curveHistRoot = null;
async function loadCurveHistory() {
  const spec = CURVE_ROOT[currentMarket];
  const block = $('curvehist-block');
  if (!spec) { if (block) block.style.display = 'none'; return; }
  if (block) block.style.display = '';
  if (curveHistRoot === spec.root) return;
  curveHistRoot = spec.root;
  const t = $('curvehist-title');
  if (t) t.textContent = `IS ${spec.name} GETTING TIGHTER OR LOOSER? — this month vs next, over time (above 0 = tight)`;
  try { renderCurveHistory(await getJSON('/api/curvehistory?root=' + spec.root)); } catch {}
}
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'commodities') {
    loadCurveHistory();
    if (chart) setTimeout(() => chart.resize(), 50);
    if (cmpChart) setTimeout(() => cmpChart.resize(), 55);
    if (curveHistChart) setTimeout(() => curveHistChart.resize(), 60);
    if (map) setTimeout(() => map.invalidateSize(), 80);
    if (crackHistChart && currentMarket === 'refined') setTimeout(() => crackHistChart.resize(), 80);
  }
  if (name === 'macro') { loadMacroTickers(); if (macroChart) setTimeout(() => macroChart.resize(), 60); if (policyChart) setTimeout(() => policyChart.resize(), 70); if (cpiChart) setTimeout(() => cpiChart.resize(), 80); if (yieldsChart) setTimeout(() => yieldsChart.resize(), 85); if (usjpChart) setTimeout(() => usjpChart.resize(), 90); }
  if (data) renderTicker(data);
}

async function loadExtra() {
  if (!data) return; // need prices first
  reloadHistory();   // refresh the deltas + sparklines (fire-and-forget)
  try {
    const [inv, eq, chk, an, fl, pr] = await Promise.all([
      getJSON('/api/inventories').catch(() => null),
      getJSON('/api/equities').catch(() => null),
      getJSON('/api/chokepoints').catch(() => null),
      getJSON('/api/analytics').catch(() => null),
      getJSON('/api/flows').catch(() => null),
      getJSON('/api/products').catch(() => null),
    ]);
    const [flr, sar] = await Promise.all([
      getJSON('/api/flares').catch(() => null),
      getJSON('/api/sar').catch(() => null),
    ]);
    const [md, corr, ev] = await Promise.all([
      getJSON('/api/macrodash').catch(() => null),
      getJSON('/api/correlations').catch(() => null),
      getJSON('/api/events').catch(() => null),
    ]);
    analytics = an;
    renderInventories(inv);
    renderSectors(eq, data, an, tankerInfo);
    renderChokepoints(chk);
    renderCurveForSegment();
    loadCurveHistory();
    renderFlows(fl);
    renderProducts(pr);
    renderSatellite(sar, flr);
    renderMacroDash(md, corr, ev);
    if (md?.fx) { lastFx = md.fx; renderTicker(data); }
    renderMarketState();
    renderAdaptive();
    loadTransmission();
    loadAlerts();
    loadBrief();
  } catch (e) { showError(e.message); }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function refreshLive() {
  try { await loadMarket(); } catch (e) { showError(e.message); console.error(e); }
  try { await loadTankers(); } catch (e) { showError(e.message); console.error(e); }
}
$('refresh').addEventListener('click', () => { nextRefresh = 60; refreshLive(); loadExtra(); });
$('metric').addEventListener('change', () => { localStorage.setItem('oilbasis.metric', $('metric').value); chartAnchor = null; renderChart(); });
$('range').addEventListener('change', () => { chartAnchor = null; renderChart(); });
$('cmp-a')?.addEventListener('change', renderCompare);
$('cmp-b')?.addEventListener('change', renderCompare);
$('cmp-range')?.addEventListener('change', renderCompare);
$('cmp-view')?.addEventListener('change', renderCompare);
$('cmp-presets')?.addEventListener('click', (e) => { const btn = e.target.closest('.cmp-preset'); if (!btn) return; $('cmp-a').value = btn.dataset.a; $('cmp-b').value = btn.dataset.b; $('cmp-view').value = btn.dataset.v; renderCompare(); });
$('bp-metric')?.addEventListener('change', () => selectMarket($('bp-metric').value));

$('marketstate')?.addEventListener('click', (e) => { const t = e.target.closest('[data-market]'); if (t) { showTab('commodities'); selectMarket(t.dataset.market); } });
$('macro-region')?.addEventListener('change', () => { macroRegion = $('macro-region').value; renderMacroRegion(); });
$('macro-region-panel')?.addEventListener('click', (e) => { const el = e.target.closest('[data-metric]'); if (el) pickMetric(el.dataset.metric, '1y'); });
$('macro-country')?.addEventListener('change', () => { macroCountry = $('macro-country').value; loadCountry(); });
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const showOnboard = () => $('onboarding')?.classList.remove('hidden');
  const hideOnboard = () => { localStorage.setItem('oilbasis.seenOnboard', '1'); $('onboarding')?.classList.add('hidden'); };
  if (!localStorage.getItem('oilbasis.seenOnboard')) showOnboard();
  $('onboard-close')?.addEventListener('click', hideOnboard);
  $('help-open')?.addEventListener('click', showOnboard);
  $('onboarding')?.addEventListener('click', (e) => { if (e.target.id === 'onboarding') hideOnboard(); });
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  await loadHistory().catch((e) => showError(e.message));
  fxList = await getJSON('/api/fx').catch(() => []);
  rateList = await getJSON('/api/rates').catch(() => []);
  renderCmpPresets();
  markets = await getJSON('/api/markets').catch(() => []);
  macroCountries = await getJSON('/api/countries').catch(() => null);
  await refreshLive();        // prices + ships (sets `data` first)
  await loadExtra();          // slow feeds (need `data`)
  loadAnalogue();
  loadReroute();
  loadHeadlines();
  setInterval(loadHeadlines, 600000);   // refresh the live headline board
  setInterval(loadTankers, 15000);                                  // ships
  setInterval(loadReroute, 300000);                                 // reroute index
  setInterval(loadExtra, 600000);                                   // slow feeds every 10 min
  setInterval(() => { nextRefresh -= 5; if (nextRefresh <= 0) { nextRefresh = 60; refreshLive(); } const cd = $('countdown'); if (cd) cd.textContent = `auto ${nextRefresh}s`; }, 5000);
})();
