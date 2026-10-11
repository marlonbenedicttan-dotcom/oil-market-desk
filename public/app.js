const $ = (id) => document.getElementById(id);
const fmt = (n, dp = 2) => (n == null ? '—' : '$' + Number(n).toFixed(dp));
const signed = (n, dp = 2) => (n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(dp));
const pctf = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(1) + '%');
const cls = (n) => (n == null ? '' : n >= 0 ? 'pos' : 'neg');
const GAL = 42;
const ago = (iso) => { if (!iso) return ''; const s = Math.round((Date.now() - new Date(iso)) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

let data, history;
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
    <dt>% performance</dt><dd>Change vs the start of the window (10Y = since ~10 years ago), not just day-on-day.</dd>
    <dt>Worldscale / freight</dt><dd>The tanker-rate index (paid data); here we use live AIS ship behaviour as a free proxy.</dd>
  </dl>`;

function showError(msg) { const el = $('error'); el.classList.remove('hidden'); el.textContent = '⚠ ' + msg; }
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`); return r.json(); }
async function getLongterm(id, years = 10) {
  const k = id + years;
  if (!ltCache[k]) ltCache[k] = await getJSON(`/api/longterm?id=${encodeURIComponent(id)}&years=${years}`);
  return ltCache[k];
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
  return `
    <div class="card clickable" data-id="${b.id}" title="Click for 10-year performance">
      <h3 title="${b.label}">${b.label} <span>${b.unit}${spotOnly ? ' · spot' : ''}</span></h3>
      <div class="row"><span class="k">Paper (futures)</span><span class="v">${spotOnly ? '<span class="k">— none</span>' : fmt(b.paper, b.dp)}</span></div>
      <div class="row"><span class="k">Physical <em>${b.physicalDate || ''}</em></span><span class="v">${fmt(b.physical, b.dp)}</span></div>
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
    plugins: { legend: { labels: { color: '#7c8a99', boxWidth: 12, font: { family: 'monospace' } } } },
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
  } else {
    labels = history.dates;
    datasets = datasetsFor(metric, history, data);
    if (range === '10y' && !bench) summary = '10Y view is per-benchmark — pick a benchmark above.';
  }

  $('lt-summary').textContent = summary;
  const chartData = { labels, datasets };
  if (chart) { chart.data = chartData; chart.update(); return; }
  chart = new Chart($('chart'), { type: 'line', data: chartData, options: chartOpts() });
}

async function loadHistory() { history = await getJSON('/api/history'); }
async function loadMarket() {
  data = await getJSON('/api/market');
  renderCards(data); buildMetricOptions(data);
  renderInsights(data, tankerInfo); renderAlerts(computeAlerts(data, tankerInfo)); renderTicker(data);
  await renderChart();   // ← the fix: render AFTER data exists
  $('updated').textContent = 'prices ' + new Date(data.updated).toLocaleTimeString();
  $('notes').innerHTML = '<ul>' + data.notes.map((n) => `<li>${n}</li>`).join('') + '</ul>';
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
// Boot
// ---------------------------------------------------------------------------
async function refreshAll() {
  try { await loadMarket(); } catch (e) { showError(e.message); console.error(e); }
  try { await loadTankers(); } catch (e) { showError(e.message); console.error(e); }
}
$('refresh').addEventListener('click', () => { nextRefresh = 60; refreshAll(); });
$('metric').addEventListener('change', () => { localStorage.setItem('oilbasis.metric', $('metric').value); renderChart(); });
$('range').addEventListener('change', renderChart);
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
  setInterval(loadTankers, 15000);
  setInterval(() => { nextRefresh -= 5; if (nextRefresh <= 0) { nextRefresh = 60; loadMarket().catch((e) => showError(e.message)); } $('countdown').textContent = `auto ${nextRefresh}s`; }, 5000);
})();
