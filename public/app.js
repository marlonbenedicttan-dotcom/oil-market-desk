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
    <dt>Paper</dt><dd>The front-month <b>futures</b> contract — financial exposure, settled on expiry.</dd>
    <dt>Physical</dt><dd>The <b>spot/cash</b> price for actual barrels (assessed by price-reporting agencies).</dd>
    <dt>Basis</dt><dd><b>Physical − Paper.</b> Positive = physical above futures (backwardation → tight). Negative = contango → well supplied.</dd>
    <dt>Backwardation / Contango</dt><dd>Backwardation: prompt barrels pricier than later (tight). Contango: the reverse (oversupply, storage pays).</dd>
    <dt>Crack spread</dt><dd>Refining margin: product (gasoline/diesel) × 42 gallons minus crude, per barrel.</dd>
    <dt>Brent − WTI</dt><dd>The spread between the two crude benchmarks; a wide physical spread signals export pull.</dd>
    <dt>Term structure (curve)</dt><dd>The prices of futures for successive delivery months — shown as bars (M1, M2, M3…). <b>Backwardation</b> = later months cheaper = tight now. <b>Contango</b> = later months dearer = well supplied. It's the single best physical signal.</dd>
    <dt>% performance</dt><dd>Change vs the start of the window (10Y = since ~10 years ago), not just day-on-day.</dd>
    <dt>Percentile</dt><dd>Where today's value ranks within the last 2 years (80th+ = historically high, 20th- = low).</dd>
    <dt>Inventories</dt><dd>EIA weekly US stocks. Draws (negative) are bullish for crude; builds are bearish.</dd>
    <dt>Positioning</dt><dd>CFTC speculative net length. Extremes often precede reversals.</dd>
    <dt>Chokepoints</dt><dd>Straits where tanker congestion lifts freight (Hormuz, Malacca, Suez, Panama…).</dd>
    <dt>Worldscale / freight</dt><dd>The tanker-rate index (paid data); here we use live AIS ship behaviour as a free proxy.</dd>
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
  if (rb && w) { add('Gasoline crack (paper)', rb.paper != null && w.paper != null ? rb.paper * GAL - w.paper : null); add('Gasoline crack (physical)', rb.physical != null && w.physical != null ? rb.physical * GAL - w.physical : null); }
  if (ho && w) { add('Diesel crack (paper)', ho.paper != null && w.paper != null ? ho.paper * GAL - w.paper : null); add('Diesel crack (physical)', ho.physical != null && w.physical != null ? ho.physical * GAL - w.physical : null); }
  if (rb && ho && w && rb.paper != null && ho.paper != null && w.paper != null) add('3-2-1 crack (paper)', ((2 * rb.paper + ho.paper) * GAL) / 3 - w.paper);
  return out;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
function benchCard(b) {
  const spotOnly = b.paper == null;
  const s = history?.series?.[b.id];
  const arr = b.paper != null ? s?.paper : s?.physical;
  const day = changeOf(arr), dayPct = pctOf(arr);
  const stale = b.spotLagDays != null && b.spotLagDays >= 3;
  return `
    <div class="card clickable" data-id="${b.id}" title="Click for 10-year performance">
      <h3 title="${b.label}">${b.label} <span>${b.unit}${spotOnly ? ' · spot' : ''}</span></h3>
      <div class="row"><span class="k">Paper (futures)</span><span class="v">${spotOnly ? '<span class="k">— none</span>' : fmt(b.paper, b.dp)}</span></div>
      <div class="row"><span class="k">Physical <em>${b.physicalDate || ''}</em>${stale ? ` <span class="qb">${b.spotLagDays}d lag</span>` : ''}</span><span class="v">${fmt(b.physical, b.dp)}</span></div>
      <div class="row"><span class="k">Basis <span class="qi" title="Physical − Paper">ⓘ</span></span><span class="v basis ${cls(b.basis)}">${b.basis == null ? '—' : signed(b.basis, b.dp)}</span></div>
      <div class="row"><span class="k">Today</span><span class="v ${cls(day)}">${day == null ? '—' : `${signed(day, b.dp)} (${pctf(dayPct)})`}</span></div>
    </div>`;
}
function spreadCard(s) {
  return `<div class="card"><h3>${s.label} <span>${s.unit}</span></h3>
      <div class="row"><span class="k">Paper spread</span><span class="v ${cls(s.paper)}">${signed(s.paper, s.dp)}</span></div>
      <div class="row"><span class="k">Physical spread</span><span class="v ${cls(s.physical)}">${signed(s.physical, s.dp)}</span></div>
      <div class="row"><span class="k">Paper − Physical</span><span class="v ${cls(s.paper - s.physical)}">${signed(s.paper - s.physical, s.dp)}</span></div></div>`;
}
function crackCard(c) {
  const read = c.value > 20 ? 'strong' : c.value > 8 ? 'healthy' : 'weak';
  return `<div class="card"><h3>${c.label} <span>$/bbl</span></h3>
      <div class="row"><span class="k">Margin</span><span class="v basis ${cls(c.value)}">${signed(c.value)}</span></div>
      <div class="row"><span class="k">Read</span><span class="v dimtext" style="font-weight:400">${read}</span></div></div>`;
}
function renderCards(m) {
  const cracks = crackSpreads(m);
  $('cards').innerHTML = `
    <div class="group"><div class="gtitle">BENCHMARKS <span class="dimtext">— click a card for 10Y performance</span></div><div class="cards">${m.benchmarks.map(benchCard).join('')}</div></div>
    ${Object.keys(m.spreads).length ? `<div class="group"><div class="gtitle">CRUDE SPREADS</div><div class="cards">${Object.values(m.spreads).map((s) => spreadCard(s)).join('')}</div></div>` : ''}
    ${cracks.length ? `<div class="group"><div class="gtitle">CRACK SPREADS (REFINING MARGINS)</div><div class="cards">${cracks.map(crackCard).join('')}</div></div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Insights & alerts
// ---------------------------------------------------------------------------
function marketInsights(m) {
  const out = [];
  for (const b of m.benchmarks) {
    if (b.basis == null) continue;
    const above = b.basis >= 0;
    out.push(`<b>${b.label}</b>: physical ${fmt(b.physical, b.dp)} is ${Math.abs(b.basis).toFixed(b.dp)} ${above ? 'ABOVE' : 'BELOW'} paper — ${above ? 'tight physical market (backwardation).' : 'loose market (contango); storage pays.'}`);
  }
  const s = m.spreads.brent_wti;
  if (s) { const d = s.physical - s.paper; out.push(`<b>Brent−WTI</b>: physical ${signed(s.physical)} vs paper ${signed(s.paper)} — physical ${Math.abs(d).toFixed(2)} ${d >= 0 ? 'wider' : 'narrower'}. ${d > 3 ? 'Brent bid → export pull.' : d < -3 ? 'WTI bid → US tightness.' : 'Broadly aligned.'}`); }
  const d321 = crackSpreads(m).find((c) => c.label.startsWith('3-2-1'));
  if (d321) out.push(`<b>3-2-1 refining margin</b> ${signed(d321.value)} $/bbl — ${d321.value > 20 ? 'very strong; refiners pull more crude.' : d321.value > 10 ? 'healthy.' : 'thin; run cuts possible.'}`);
  return out;
}
function tankerInsights(t) {
  const out = []; const s = t.status || {};
  if (!s.enabled) { out.push('Live tanker tracking is off. Add a free AIS key to enable.'); return out; }
  const list = t.tankers || [];
  if (!list.length) { out.push(`Connected to AIS (${(s.messages || 0).toLocaleString()} messages) — identifying tankers…`); return out; }
  const idlers = list.filter((v) => (v.sog ?? 0) < 1).length;
  const avg = list.reduce((a, v) => a + (v.sog || 0), 0) / list.length;
  out.push(`<b>${list.length} tankers</b> tracked: ${list.length - idlers} under way, ${idlers} nearly stationary.`);
  out.push(`Stationary clusters hint at floating storage or congestion; fast, laden tankers usually tighten freight (higher Worldscale).`);
  out.push(`Average speed ${avg.toFixed(1)} kn — ${avg > 8 ? 'brisk (active trade).' : avg < 4 ? 'sluggish.' : 'moderate activity.'}`);
  out.push('<span class="note">Freight indices (Baltic/Worldscale) are paid; AIS activity is a free proxy.</span>');
  return out;
}
function computeAlerts(m, t) {
  const out = []; const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  if (by.brent?.basis != null && Math.abs(by.brent.basis) > 10) out.push({ level: 'high', text: `Brent basis is extreme (${signed(by.brent.basis)}) — physical dislocation.` });
  if (by.wti?.basis != null && Math.abs(by.wti.basis) > 3.5) out.push({ level: 'med', text: `WTI basis ${signed(by.wti.basis)} — wider than normal.` });
  const s = m.spreads.brent_wti;
  if (s && Math.abs(s.physical - s.paper) > 5) out.push({ level: 'med', text: `Brent−WTI physical vs paper diverged by ${signed(s.physical - s.paper)}.` });
  const diesel = crackSpreads(m).find((c) => c.label.startsWith('Diesel crack (paper)'));
  if (diesel && diesel.value > 28) out.push({ level: 'high', text: `Diesel crack ${signed(diesel.value)} — very strong refining margins.` });
  if (diesel && diesel.value < 6) out.push({ level: 'high', text: `Diesel crack only ${signed(diesel.value)} — refiner run cuts likely.` });
  const idlers = (t.tankers || []).filter((v) => (v.sog ?? 0) < 1).length;
  if (t.status?.enabled && idlers >= 15) out.push({ level: 'med', text: `${idlers} tankers nearly stationary — watch floating storage.` });
  return out;
}
function renderAlerts(alerts) {
  $('alert-count').textContent = String(alerts.length);
  $('alert-count').className = 'pill ' + (alerts.some((a) => a.level === 'high') ? 'warn' : alerts.length ? '' : 'ok');
  $('alerts').innerHTML = alerts.length ? alerts.map((a) => `<div class="alert ${a.level}"><span class="badge">${a.level === 'high' ? 'HIGH' : 'WATCH'}</span> ${a.text}</div>`).join('') : '<div class="alert none">✅ No alerts — markets within normal ranges.</div>';
  if ('Notification' in window && Notification.permission === 'granted') for (const a of alerts) if (a.level === 'high' && !seenAlerts.has(a.text)) { seenAlerts.add(a.text); try { new Notification('Oil Basis alert', { body: a.text }); } catch {} }
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
    if (b.paper == null) opts.push(`<option value="${b.id}">${b.label} (spot only)</option>`);
    else { opts.push(`<option value="${b.id}">${b.label} — paper vs physical</option>`); opts.push(`<option value="basis:${b.id}">${b.label} basis (phys − paper)</option>`); }
  }
  for (const key of Object.keys(m.spreads)) opts.push(`<option value="spread:${key}">${m.spreads[key].label} (paper & physical)</option>`);
  sel.innerHTML = opts.join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
function line(label, arr, color) { return { label, data: arr, borderColor: color, backgroundColor: color + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true, fill: false }; }
function datasetsFor(metric, h, m) {
  const b = m.benchmarks.find((x) => x.id === metric);
  if (b) { const s = h.series[metric]; const sets = []; if (b.paper != null) sets.push(line(`${b.label} paper`, s.paper, '#4aa3ff')); sets.push(line(`${b.label} physical`, s.physical, '#ff9e00')); return sets; }
  if (metric.startsWith('basis:')) { const id = metric.slice(6); return [line(`${id} basis`, h.basis[id], '#00c853')]; }
  if (metric.startsWith('spread:')) { const s = h.spreads[metric.slice(7)]; return [line('paper', s.paper, '#4aa3ff'), line('physical', s.physical, '#ff9e00')]; }
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
  map = L.map('map', { worldCopyJump: true, minZoom: 1 }).setView([25, 40], 2);
  const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri', maxZoom: 16 });
  esri.addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(map);
  let fellBack = false;
  esri.on('tileerror', () => { if (fellBack) return; fellBack = true; map.eachLayer((l) => { if (l instanceof L.TileLayer && l !== layer) map.removeLayer(l); }); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(map); });
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
  return `<div class="ctx-row"><span class="ctx-k">${k}</span><span class="ctx-bar"><i style="width:${pct == null ? 0 : pct}%"></i></span><span class="ctx-p ${pctClass(pct)}">${pct == null ? '—' : pct.toFixed(0) + 'th pct'}</span><span class="ctx-v">${value}</span></div>`;
}
function renderContext(m, a) {
  if (!a) { $('context').innerHTML = '<div class="dimtext" style="padding:10px 12px">loading…</div>'; return; }
  const rows = [];
  for (const b of m.benchmarks) {
    const an = a.benchmarks?.[b.id];
    if (!an || an.basisPct == null) continue;
    rows.push(ctxRow(`${b.label} basis`, an.basisPct, `<span class="${cls(b.basis)}">${signed(b.basis, b.dp)}</span>`));
  }
  if (a.spread?.pct != null) rows.push(ctxRow('Brent−WTI physical', a.spread.pct, signed(a.spread.brentWtiPhysical, 2)));
  const arb = a.arb ? `<div class="arb">EXPORT ARB (WTI → Europe): spread ${signed(a.arb.spread, 2)} − freight ${a.arb.freight.toFixed(2)} = <b class="${a.arb.open ? 'pos' : 'neg'}">${signed(a.arb.net, 2)} → ${a.arb.open ? 'OPEN' : 'CLOSED'}</b></div>` : '';
  const vols = m.benchmarks.map((b) => { const an = a.benchmarks?.[b.id]; return an && an.vol30 != null ? `<span class="choke"><b>${an.vol30.toFixed(1)}%</b> ${b.label.replace(/\s*\(.*\)/, '')}</span>` : ''; }).filter(Boolean).join('');
  const volStrip = vols ? `<div class="chokes"><div class="chokes-h">REALISED 30D VOLATILITY (ANNUALISED)</div>${vols}</div>` : '';
  const qf = data?.quality?.flags || [];
  const quality = `<div class="qflags"><div class="chokes-h">DATA QUALITY</div>${
    qf.length ? qf.map((f) => `<div class="qflag ${f.level}">⚠ ${f.text}</div>`).join('')
      : '<div class="qflag ok">✓ No data-quality issues flagged. Physical vs futures aligned.</div>'}</div>`;
  $('context').innerHTML = rows.join('') + arb + volStrip + quality;
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
    const tag = sur == null ? '<span class="dimtext">—</span>'
      : sur < 0 ? `<span class="pos">drew ${Math.abs(sur).toLocaleString()} more than usual</span>`
        : `<span class="neg">built ${sur.toLocaleString()} vs usual</span>`;
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
  if (!d?.chokepoints) return;
  $('chokepoints').innerHTML = '<div class="chokes-h dimtext">TANKERS IN CHOKEPOINTS (live)</div>' +
    d.chokepoints.map((c) => `<span class="choke"><b>${c.count}</b> ${c.name}</span>`).join('');
}
function curveBlock(name, c) {
  if (!c?.contracts || c.contracts.length < 2) return '';
  const prices = c.contracts.map((x) => x.price);
  const max = Math.max(...prices), min = Math.min(...prices);
  const rows = c.contracts.slice(0, 9).map((x) => {
    const w = ((x.price - min) / (max - min || 1)) * 100;
    return `<div class="cbar"><span class="cl">${x.label}</span><span class="cb"><i style="width:${Math.max(w, 4)}%"></i></span><span class="cp">${x.price.toFixed(2)}</span></div>`;
  }).join('');
  return `<div class="curve-blk"><div class="curve-h">${name} — <b class="${c.m1m2 >= 0 ? 'pos' : 'neg'}">${c.shape}</b> · M1−M2 <b class="${cls(c.m1m2)}">${signed(c.m1m2, 2)}</b>${c.m1m6 != null ? ` · M1−M6 <b class="${cls(c.m1m6)}">${signed(c.m1m6, 2)}</b>` : ''}${c.rollYieldAnn != null ? ` · roll ${signed(c.rollYieldAnn, 1)}%/yr` : ''}</div>${rows}</div>`;
}
function renderCurve(d) { if (!d) return; $('curve').innerHTML = curveBlock('WTI (CL)', d.wti) + curveBlock('Brent (BZ)', d.brent); }
function renderAnalogue(a) {
  if (!a || a.error) { $('analogue').innerHTML = `<div class="dimtext" style="padding:10px 12px">${a?.error || 'loading…'}</div>`; return; }
  const rows = a.horizons.map((h) => (h.n
    ? `<tr><td>${h.h}d</td><td>${h.n}</td><td class="${cls(h.median)}">${signed(h.median, 2)}</td><td>${h.q25.toFixed(2)} … ${h.q75.toFixed(2)}</td><td>${h.pctUp.toFixed(0)}%</td></tr>`
    : `<tr><td>${h.h}d</td><td colspan="4" class="dimtext">no analogues</td></tr>`)).join('');
  const h20 = a.horizons.find((x) => x.h === 20);
  let verdict = '';
  if (h20 && h20.n) {
    const side = a.pct >= 80 ? (h20.median < 0 ? 'mean-reversion DOWN' : 'momentum UP') : a.pct <= 20 ? (h20.median > 0 ? 'mean-reversion UP' : 'momentum DOWN') : 'no strong edge';
    verdict = `<b>TRADE IDEA:</b> at the ${a.pct.toFixed(0)}th pctile, 20-day history favours <b>${side}</b> — median ${signed(h20.median, 2)}, ${h20.pctUp.toFixed(0)}% up, IQR ${h20.q25.toFixed(2)} … ${h20.q75.toFixed(2)}.`;
  }
  $('analogue').innerHTML =
    `<div class="an-head">Current = <b>${a.current.toFixed(2)}</b> · ${a.pct.toFixed(0)}th pctile · z ${a.z.toFixed(2)} · <b>${a.analogN}</b> analogous days in ${a.years}y</div>` +
    `<table class="antable"><thead><tr><th>Horizon</th><th>N</th><th>Median fwd</th><th>IQR</th><th>P(up)</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="an-verdict">${verdict}</div>`;
}
async function loadAnalogue() {
  try { renderAnalogue(await getJSON('/api/analogue?metric=' + encodeURIComponent($('an-metric').value))); }
  catch (e) { showError(e.message); }
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
    ? `<div class="qflag watch" style="margin:8px 12px">⚠ <b>No AIS activity</b> in: ${d.dark.join(', ')} — the feed is dark here (possible disruption / dark fleet, or limited coverage).</div>`
    : '';
  const ms = d.marketStress;
  const stressHtml = ms ? `<div class="chokes-h dimtext" style="padding:10px 12px 0">MARKET-IMPLIED GULF STRESS — ships go dark, but prices can't lie</div>
    <div style="padding:6px 12px 0"><div class="verdict ${ms.score >= 2 ? 'tight' : 'mixed'}">${ms.verdict}</div>
    ${ms.signals.map((s) => `<div class="ev"><span class="ev-l">${s.label}</span><span class="ev-v ${s.hot ? 'pos' : ''}">${s.value != null ? (s.value >= 0 ? '+' : '') + Number(s.value).toFixed(2) : '—'}</span><span class="tag ${s.hot ? 'tight' : 'neutral'}">${s.hot ? 'STRESS' : 'ok'}</span><span class="ev-n dimtext">${s.hot ? 'pricing disruption' : 'normal'}</span></div>`).join('')}</div>` : '';
  const an = d.anomalies || {};
  const anHtml = `<div class="chokes-h dimtext" style="padding:0 12px">AIS ANOMALIES (visible vessels, M.E. only)</div>
    <div class="chokes"><span class="choke"><b>${an.spoof || 0}</b> spoof / teleport</span><span class="choke"><b>${an.darkGap || 0}</b> dark gaps → inferred transits</span></div>`;
  const routes = (d.routes || []).map((r) => `<span class="choke ${r.perMin === 0 ? 'cold' : ''}"><b>${r.count}</b> ${r.name} <span class="dimtext">${r.perMin}/min</span></span>`).join('');
  const routesHtml = `<div class="chokes-h dimtext" style="padding:0 12px">ROUTE MIX — are tankers dodging chokepoints?</div><div class="chokes">${routes}</div>`;
  const divHtml = d.diversion ? `<div class="qflag watch" style="margin:8px 12px">🧭 ROUTING: ${d.diversion}</div>` : '';
  $('flows').innerHTML =
    `<div class="chokes-h dimtext">MIDDLE-EAST FLOWS (live AIS)</div>
     <div class="chokes">${regions}</div>
     <div class="chokes-h dimtext" style="padding:0 12px">AIS ACTIVITY (reports/min · 5-min window)</div>
     <div class="chokes">${rates}</div>
     ${darkNote}
     ${routesHtml}
     ${divHtml}
     ${stressHtml}
     ${anHtml}
     <div class="flowbar"><div class="dimtext">Gulf of Oman / Arabian Sea — direction of travel</div>
       <div class="fb"><span class="fb-e" style="width:${ew}%">${e.eastbound} east → Asia</span><span class="fb-w" style="width:${ww}%">${e.westbound} west → Suez</span></div>
       <div class="dimtext">${e.total} tankers in the exit corridor · ${e.moving} under way · ${e.idle} idle</div></div>`;
}
function renderProducts(d) {
  if (!d?.items) { $('products').innerHTML = ''; return; }
  const cards = d.items.map((i) => {
    const read = i.crack == null ? '—' : i.crack > 25 ? 'very strong' : i.crack > 12 ? 'strong' : i.crack > 5 ? 'ok' : 'weak';
    return `<div class="card"><h3>${i.label} <span>crack $/bbl</span></h3>
      <div class="row"><span class="k">Crack</span><span class="v basis ${cls(i.crack)}">${signed(i.crack, 2)}</span></div>
      <div class="row"><span class="k">2-yr pctile</span><span class="v">${i.pct != null ? i.pct.toFixed(0) + 'th' : '—'}</span></div>
      <div class="row"><span class="k">Read <span class="qi" title="${i.note}">ⓘ</span></span><span class="v dimtext" style="font-weight:400">${read}</span></div></div>`;
  }).join('');
  $('products').innerHTML = `<div class="cards">${cards}</div>`;
}
let rerouteChart;
function renderSatellite(sar, flares) {
  let html = '';
  if (sar && !sar.error) {
    const latest = sar.latest ? new Date(sar.latest.time).toLocaleString() : '—';
    html += `<div class="read-line">🛰️ <b>Radar eyes (Sentinel-1 SAR)</b> — radar sees <b>every</b> ship regardless of AIS, day/night, through cloud. Last pass over the Gulf: <b>${latest}</b> · <b>${sar.passes}</b> passes in the last 7 days.<br><span class="dimtext">(Full dark-vessel detection = SAR image → ship detection → diff against AIS. Blueprint: github.com/kelu124/OrmuzOsint.)</span></div>`;
    if (sar.recent?.length) html += `<div class="chokes">${sar.recent.map((r) => `<span class="choke">${r.platform} · ${new Date(r.time).toLocaleDateString()}</span>`).join('')}</div>`;
  }
  if (flares && !flares.error) {
    const regions = Object.entries(flares.byRegion || {}).map(([k, v]) => `<span class="choke"><b>${v}</b> ${k}</span>`).join('');
    html += `<div class="chokes-h dimtext" style="padding:8px 12px 0">GULF GAS-FLARE ACTIVITY (production proxy — flares fade when output is shut in)</div>
      <div class="chokes"><span class="choke"><b>${flares.total}</b> detections / 24h</span>${regions}</div>`;
    if (flares.trend?.length > 1) html += `<div class="dimtext" style="padding:4px 12px">flare counts by day: ${flares.trend.map((t) => `${t.date.slice(5)}:${t.count}`).join(' · ')}</div>`;
  }
  $('satellite').innerHTML = html || '<div class="dimtext" style="padding:10px 12px">no data</div>';
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
function renderRegime(m, a, c) {
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const parts = [];
  if (c?.brent) parts.push(`<b>${c.brent.shape.toUpperCase()}</b>`);
  const bb = by.brent?.basis;
  if (bb != null) parts.push(bb > 0 ? 'physical <span class="pos">tight</span>' : 'physical <span class="neg">loose</span>');
  if (a?.arb) parts.push(`export arb <b class="${a.arb.open ? 'pos' : 'neg'}">${a.arb.open ? 'OPEN' : 'CLOSED'}</b>`);
  const dq = (m.quality?.flags || []).length;
  if (dq) parts.push(`<span class="warn">⚠ ${dq} data caveat${dq > 1 ? 's' : ''}</span>`);
  $('regime').innerHTML = `<span class="regime-k">REGIME</span> ${parts.join(' · ')}`;
}
function kpiTile(label, value, sub, klass) {
  return `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v ${klass || ''}">${value}</div><div class="kpi-s dimtext">${sub}</div></div>`;
}
function renderKPIs(m, a, c, pos) {
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const d321 = crackSpreads(m).find((x) => x.label.startsWith('3-2-1'));
  const pct = (id) => (a?.benchmarks?.[id]?.basisPct != null ? Math.round(a.benchmarks[id].basisPct) + 'th pct' : '—');
  const t = [];
  if (by.brent) t.push(kpiTile('BRENT BASIS', signed(by.brent.basis, 2), `${pct('brent')} · phys−paper`, cls(by.brent.basis)));
  if (by.wti) t.push(kpiTile('WTI BASIS', signed(by.wti.basis, 2), `${pct('wti')} · phys−paper`, cls(by.wti.basis)));
  if (m.spreads.brent_wti) t.push(kpiTile('BRENT − WTI', signed(m.spreads.brent_wti.physical, 2), 'physical spread', cls(m.spreads.brent_wti.physical)));
  if (d321) t.push(kpiTile('3-2-1 CRACK', signed(d321.value, 2), d321.value > 18 ? 'strong' : d321.value > 8 ? 'healthy' : 'weak', cls(d321.value)));
  if (c?.brent?.m1m2 != null) t.push(kpiTile('BRENT M1−M2', signed(c.brent.m1m2, 2), c.brent.shape, cls(c.brent.m1m2)));
  if (pos?.latest) t.push(kpiTile('WTI SPEC NET', pos.latest.net.toLocaleString(), `${pos.pct.toFixed(0)}th pct · CFTC`, cls(pos.latest.net)));
  $('kpis').innerHTML = t.join('');
}
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'curve' && chart) setTimeout(() => chart.resize(), 50);
  if (name === 'tankers' && map) setTimeout(() => map.invalidateSize(), 60);
}

async function loadExtra() {
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
    analytics = an;
    renderContext(data, an);
    renderInventories(inv);
    renderPositioning(pos);
    renderSectors(eq, data, an, tankerInfo);
    renderChokepoints(chk);
    renderCurve(cv);
    renderTightness(tn);
    renderFlows(fl);
    renderProducts(pr);
    renderSatellite(sar, flr);
    renderKPIs(data, an, cv, pos);
    renderRegime(data, an, cv);
  } catch (e) { showError(e.message); }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function refreshAll() {
  try { await loadMarket(); } catch (e) { showError(e.message); console.error(e); }
  try { await loadTankers(); } catch (e) { showError(e.message); console.error(e); }
  await loadExtra();
}
$('refresh').addEventListener('click', () => { nextRefresh = 60; refreshAll(); });
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
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  await loadHistory().catch((e) => showError(e.message));
  await refreshAll();
  loadAnalogue();
  loadReroute();
  setInterval(loadTankers, 15000);
  setInterval(() => { nextRefresh -= 5; if (nextRefresh <= 0) { nextRefresh = 60; refreshAll(); } const cd = $('countdown'); if (cd) cd.textContent = `auto ${nextRefresh}s`; }, 5000);
})();
