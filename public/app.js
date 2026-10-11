const $ = (id) => document.getElementById(id);
const fmt = (n, dp = 2) => (n == null ? '—' : '$' + Number(n).toFixed(dp));
const signed = (n, dp = 2) => (n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(dp));
const pctf = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(1) + '%');
const cls = (n) => (n == null ? '' : n >= 0 ? 'pos' : 'neg');
const GAL = 42;
const ago = (iso) => { if (!iso) return ''; const s = Math.round((Date.now() - new Date(iso)) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

let data, history, analytics;
let tankerInfo = { status: {}, count: 0, tankers: [] };
let nextRefresh = 60;
const seenAlerts = new Set();
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
    <dt>Hedge-fund bets</dt><dd>How much more big funds are betting oil rises vs falls.</dd>
    <dt>Oil-field flames</dt><dd>Satellites see the gas burned off at oil fields — fewer flames = fields shutting down.</dd>
  </dl>`;

function showError(msg) { const el = $('error'); el.classList.remove('hidden'); el.textContent = '⚠ ' + msg; }
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`); return r.json(); }
async function getLongterm(id, years = 10) {
  const k = id + years;
  if (!ltCache[k]) ltCache[k] = await getJSON(`/api/longterm?id=${encodeURIComponent(id)}&years=${years}`);
  return ltCache[k];
}
const rangeCache = {};
async function getRange(id, range) {
  const k = id + range;
  if (!rangeCache[k]) rangeCache[k] = await getJSON(`/api/range?id=${encodeURIComponent(id)}&range=${range}`);
  return rangeCache[k];
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
function renderCards(m) {
  const cracks = crackSpreads(m);
  $('cards').innerHTML = `
    <div class="group"><div class="gtitle">PRICES <span class="dimtext">— click a card for 10 years of history</span></div><div class="cards">${m.benchmarks.map(benchCard).join('')}</div></div>
    ${Object.keys(m.spreads).length ? `<div class="group"><div class="gtitle">OIL-TYPE GAPS</div><div class="cards">${Object.values(m.spreads).map((s) => spreadCard(s)).join('')}</div></div>` : ''}
    ${cracks.length ? `<div class="group"><div class="gtitle">REFINING PROFITS</div><div class="cards">${cracks.map(crackCard).join('')}</div></div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Insights & alerts
// ---------------------------------------------------------------------------
function marketInsights(m) {
  const out = [];
  for (const b of m.benchmarks) {
    if (b.basis == null) continue;
    const above = b.basis >= 0;
    out.push(`<b>${b.label}</b>: real barrels cost ${fmt(b.physical, b.dp)} — <b>${Math.abs(b.basis).toFixed(b.dp)} ${above ? 'more' : 'less'}</b> than futures. ${above ? 'Real barrels are scarce (bullish for oil).' : 'Real barrels are easy to get (bearish for oil).'}`);
  }
  const s = m.spreads.brent_wti;
  if (s) { const d = s.physical - s.paper; out.push(`<b>Brent vs WTI</b>: the real gap is ${signed(s.physical)} vs ${signed(s.paper)} for futures — ${d > 3 ? 'Brent (seaborne) is in demand for export.' : d < -3 ? 'US oil looks relatively tight.' : 'the two are broadly in line.'}`); }
  const d321 = crackSpreads(m).find((c) => c.label.startsWith('3-2-1'));
  if (d321) out.push(`<b>Refining profit</b> ${signed(d321.value)} a barrel — ${d321.value > 20 ? 'excellent — refiners running hard.' : d321.value > 10 ? 'decent.' : 'thin; refiners may cut back.'}`);
  return out;
}
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
function renderInsights(m, t) {
  $('market-insights').innerHTML = marketInsights(m).map((x) => `<li>${x}</li>`).join('');
  $('tanker-insights').innerHTML = tankerInsights(t).map((x) => `<li>${x}</li>`).join('');
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------
function renderTicker(m) {
  $('ticker').innerHTML = m.benchmarks.map((b) => {
    const s = history?.series?.[b.id];
    const arr = b.paper != null ? s?.paper : s?.physical;
    const val = b.paper != null ? b.paper : b.physical;
    const chg = changeOf(arr), pc = pctOf(arr);
    const c = chg == null ? '' : chg >= 0 ? 'pos' : 'neg';
    const arrow = chg == null ? '' : chg >= 0 ? '▲' : '▼';
    const short = b.label.replace(/\s*\(.*\)/, '');
    return `<span class="tk"><b>${short}</b><span class="tk-px">${val == null ? '—' : Number(val).toFixed(b.dp)}</span><span class="tk-chg ${c}">${chg == null ? '' : `${arrow}${Math.abs(chg).toFixed(b.dp)} ${pctf(pc)}`}</span></span>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Chart (6M and 10Y)
// ---------------------------------------------------------------------------
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
  const prev = sel.value || localStorage.getItem('oilbasis.metric');
  const opts = [];
  for (const b of m.benchmarks) {
    if (history && !(b.id in history.series)) continue; // no history available (futures-only instruments)
    if (b.paper == null) opts.push(`<option value="${b.id}">${b.label} (real price only)</option>`);
    else if (b.physical == null) opts.push(`<option value="${b.id}">${b.label} (futures)</option>`);
    else { opts.push(`<option value="${b.id}">${b.label} — futures vs real</option>`); opts.push(`<option value="basis:${b.id}">${b.label} gap (real − futures)</option>`); }
  }
  for (const key of Object.keys(m.spreads)) opts.push(`<option value="spread:${key}">${m.spreads[key].label} (futures & real)</option>`);
  sel.innerHTML = opts.join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
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
          label: (ctx) => {
            const v = ctx.parsed.y, ds = ctx.dataset.data;
            const base = chartAnchor != null && ds[chartAnchor] != null ? ds[chartAnchor] : ds.find((x) => x != null);
            const pct = base && v != null ? ((v - base) / base) * 100 : null;
            const tag = chartAnchor != null ? 'Δ anchor' : 'Δ window';
            return `${ctx.dataset.label}: ${v == null ? '—' : v.toFixed(2)}${pct != null ? `  (${tag} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''}`;
          },
        },
      },
    },
    scales: { x: { ticks: { color: '#7c8a99', maxTicksLimit: 10 }, grid: { color: '#151a20' } }, y: { ticks: { color: '#7c8a99' }, grid: { color: '#151a20' } } } };
}
async function renderChart() {
  if (!history || !data) return;
  const metric = $('metric').value;
  const range = $('range').value;
  const bench = data.benchmarks.find((b) => b.id === metric);
  let labels, datasets, summary = '';

  if (range === '10y' && bench) {
    let lt; try { lt = await getLongterm(bench.id, 10); } catch (e) { showError(e.message); return; }
    labels = lt.months;
    datasets = [];
    if (lt.series.paper.some((v) => v != null)) datasets.push(line(`${bench.label} paper`, lt.series.paper, '#4aa3ff'));
    datasets.push(line(`${bench.label} physical`, lt.series.physical, '#ff9e00'));
    const p = lt.summary.paper, ph = lt.summary.physical;
    summary = `10Y PERFORMANCE — paper ${pctf(p.total)} (5y ${pctf(p.last5y)}, 1y ${pctf(p.last1y)}) · physical ${pctf(ph.total)} (5y ${pctf(ph.last5y)}, 1y ${pctf(ph.last1y)})`;
  } else if ((range === 'ytd' || range === '1y') && bench) {
    const r = await getRange(bench.id, range);
    labels = r.dates;
    datasets = [];
    if (r.series.paper.some((v) => v != null)) datasets.push(line(`${bench.label} paper`, r.series.paper, '#4aa3ff'));
    datasets.push(line(`${bench.label} physical`, r.series.physical, '#ff9e00'));
    summary = `${range.toUpperCase()} PERFORMANCE — paper ${pctf(r.summary.paper)} · physical ${pctf(r.summary.physical)}`;
  } else {
    labels = history.dates;
    datasets = datasetsFor(metric, history, data);
    if (range !== '6m' && !bench) summary = 'Range view is per-benchmark — pick a benchmark above.';
  }

  $('lt-summary').textContent = (summary ? summary + '  ·  ' : '') + 'hover to see % change · click to set an anchor, then drag to measure between two points';
  const chartData = { labels, datasets };
  if (chart) { chart.data = chartData; chart.update(); return; }
  chart = new Chart($('chart'), { type: 'line', data: chartData, options: chartOpts(), plugins: [anchorLine] });
}

async function loadHistory() { history = await getJSON('/api/history'); }
async function loadMarket() {
  data = await getJSON('/api/market');
  renderCards(data); buildMetricOptions(data);
  renderInsights(data, tankerInfo); renderAlerts(computeAlerts(data, tankerInfo)); renderTicker(data);
  await renderChart();   // ← the fix: render AFTER data exists
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
  if (data) { renderInsights(data, tankerInfo); renderAlerts(computeAlerts(data, tankerInfo)); }
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
    `<div class="t inv h"><span class="inv-l">SERIES (million barrels)</span><span class="num">LEVEL</span><span class="num">THIS WEEK</span><span class="num">vs NORMAL</span></div>` + rows;
}
function sparkline(vals, w = 240, h = 40) {
  const xs = vals.filter((v) => v != null);
  if (xs.length < 2) return '';
  const min = Math.min(...xs), max = Math.max(...xs), rng = max - min || 1;
  const pts = xs.map((v, i) => `${(i / (xs.length - 1)) * w},${h - ((v - min) / rng) * h}`).join(' ');
  return `<svg width="${w}" height="${h}" class="spark"><polyline points="${pts}" fill="none" stroke="#ff9e00" stroke-width="1.5"/></svg>`;
}
function renderPositioning(p) {
  if (!p || p.error) { $('positioning').innerHTML = '<div class="dimtext" style="padding:10px 12px">no data</div>'; return; }
  $('positioning').innerHTML =
    `<div class="read-line">How many more bets hedge funds hold that crude will <b>rise</b> vs <b>fall</b>. Extreme highs often come before a pullback.</div>` +
    ctxRow('Hedge-fund net position (WTI)', p.pct, `${p.latest.net.toLocaleString()} contracts`) +
    `<div class="pos-sub dimtext">Changed ${p.wow >= 0 ? '+' : ''}${p.wow.toLocaleString()} contracts this week · as of ${p.latest.date}</div>` +
    (p.oi ? `<div class="read-line">Open interest: <b>${p.oi.toLocaleString()}</b> contracts (${p.oiChange >= 0 ? '+' : ''}${p.oiChange.toLocaleString()} this week). Price up + OI up = fresh conviction; price up + OI down = short-covering.</div>` : '') +
    sparkline(p.history.map((h) => h.net));
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
  const prices = c.contracts.map((x) => x.price);
  const max = Math.max(...prices), min = Math.min(...prices);
  const rows = c.contracts.slice(0, 9).map((x) => {
    const w = ((x.price - min) / (max - min || 1)) * 100;
    return `<div class="cbar"><span class="cl">${mname(x.label)}</span><span class="cb"><i style="width:${Math.max(w, 4)}%"></i></span><span class="cp">${x.price.toFixed(2)}</span></div>`;
  }).join('');
  const shape = c.shape === 'Backwardation' ? 'pricier NOW than later → tight' : 'cheaper now than later → well supplied';
  return `<div class="curve-blk"><div class="curve-h">${name} — <b class="${c.m1m2 >= 0 ? 'pos' : 'neg'}">${shape}</b> · this month vs next <b class="${cls(c.m1m2)}">${signed(c.m1m2, 2)}</b>${c.m1m6 != null ? ` · vs 6 months ahead <b class="${cls(c.m1m6)}">${signed(c.m1m6, 2)}</b>` : ''}</div>${rows}</div>`;
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
function macroTile(label, value, sub, klass) {
  return `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v ${klass || ''}">${value}</div><div class="kpi-s dimtext">${sub || ''}</div></div>`;
}
function renderMacroDash(md, corr, events) {
  const rates = $('macro-rates');
  if (!rates) return;
  if (!md || md.error) { rates.innerHTML = '<div class="dimtext" style="padding:10px 12px">loading…</div>'; return; }
  const r = md.rates, inf = md.inflation, g = md.growth;
  rates.innerHTML = `<div class="kpis">${macroTile('US 2-YEAR', r.us2y != null ? r.us2y + '%' : '—', 'short-term rate')}${macroTile('US 10-YEAR', r.us10y != null ? r.us10y + '%' : '—', 'long-term rate')}${macroTile('2s10s SPREAD', r.spread != null ? signed(r.spread, 2) : '—', r.spread < 0 ? 'inverted — recession signal' : 'normal', cls(r.spread))}${macroTile('FED FUNDS', r.fedfunds != null ? r.fedfunds + '%' : '—', 'policy rate')}</div>`;
  $('macro-growth').innerHTML = `<div class="kpis">${macroTile('US INFLATION (CPI YoY)', inf.cpiYoY != null ? inf.cpiYoY + '%' : '—', inf.asOf || '')}${macroTile('US GDP (QoQ, annualised)', g.gdpQoQ != null ? g.gdpQoQ + '%' : '—', g.asOf || '')}${macroTile('UNEMPLOYMENT', g.unemployment != null ? g.unemployment + '%' : '—', '')}</div>`;
  $('macro-fx').innerHTML = `<div class="kpis">${(md.fx || []).map((f) => macroTile(f.label, f.price != null ? f.price.toFixed(f.price < 10 ? 4 : 2) : '—', f.pct != null ? pctf(f.pct) : '', cls(f.pct))).join('')}</div>`;
  const c = corr || {};
  const cTile = (label, v, note) => macroTile(label, v != null ? v : '—', note, v != null ? (v < 0 ? 'neg' : 'pos') : '');
  $('macro-corr').innerHTML = `<div class="kpis">${cTile('OIL vs US DOLLAR', c.oilVsDollar, 'usually negative')}${cTile('OIL vs VIX', c.oilVsVix, 'risk-off link')}${cTile('OIL vs S&P 500', c.oilVsSp500, 'risk-on link')}</div>`;
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
let curveHistLoaded = false;
async function loadCurveHistory() {
  if (curveHistLoaded) return;
  curveHistLoaded = true;
  try { renderCurveHistory(await getJSON('/api/curvehistory?root=CL')); } catch {}
}
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'curve') { loadCurveHistory(); if (chart) setTimeout(() => chart.resize(), 50); if (curveHistChart) setTimeout(() => curveHistChart.resize(), 60); }
  if (name === 'tankers' && map) setTimeout(() => map.invalidateSize(), 60);
}

async function loadExtra() {
  if (!data) return; // need prices first
  try {
    const [inv, pos, eq, chk, an, cv, tn, fl, pr] = await Promise.all([
      getJSON('/api/inventories').catch(() => null),
      getJSON('/api/positioning').catch(() => null),
      getJSON('/api/equities').catch(() => null),
      getJSON('/api/chokepoints').catch(() => null),
      getJSON('/api/analytics').catch(() => null),
      getJSON('/api/curve').catch(() => null),
      getJSON('/api/tightness').catch(() => null),
      getJSON('/api/flows').catch(() => null),
      getJSON('/api/products').catch(() => null),
    ]);
    const [flr, sar] = await Promise.all([
      getJSON('/api/flares').catch(() => null),
      getJSON('/api/sar').catch(() => null),
    ]);
    const macro = await getJSON('/api/macro').catch(() => null);
    const [md, corr, ev] = await Promise.all([
      getJSON('/api/macrodash').catch(() => null),
      getJSON('/api/correlations').catch(() => null),
      getJSON('/api/events').catch(() => null),
    ]);
    analytics = an;
    renderContext(data, an, macro);
    renderInventories(inv);
    renderPositioning(pos);
    renderSectors(eq, data, an, tankerInfo);
    renderChokepoints(chk);
    renderCurve(cv);
    renderTightness(tn);
    renderFlows(fl);
    renderProducts(pr);
    renderSatellite(sar, flr);
    renderBottomLine(data, tn, fl, flr, sar);
    renderKPIs(data, an, cv, pos);
    renderRegime(data, an, cv);
    renderMacroDash(md, corr, ev);
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
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) showTab(b.dataset.tab); });
$('help-btn').addEventListener('click', () => { const g = $('glossary'); g.innerHTML = GLOSSARY; g.classList.toggle('hidden'); });
$('cards').addEventListener('click', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (!card) return;
  $('metric').value = card.dataset.id;
  localStorage.setItem('oilbasis.metric', card.dataset.id);
  $('range').value = '10y';
  renderChart();
});

(async function boot() {
  try { initMap(); } catch (e) { console.error(e); }
  const tick = () => { $('clock').textContent = new Date().toLocaleTimeString('en-GB'); };
  tick(); setInterval(tick, 1000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  await loadHistory().catch((e) => showError(e.message));
  await refreshLive();        // prices + ships (sets `data` first)
  await loadExtra();          // slow feeds (need `data`)
  loadAnalogue();
  loadReroute();
  setInterval(loadTankers, 15000);                                  // ships
  setInterval(loadReroute, 300000);                                 // reroute index
  setInterval(loadExtra, 600000);                                   // slow feeds every 10 min
  setInterval(() => { nextRefresh -= 5; if (nextRefresh <= 0) { nextRefresh = 60; refreshLive(); } const cd = $('countdown'); if (cd) cd.textContent = `auto ${nextRefresh}s`; }, 5000);
})();
