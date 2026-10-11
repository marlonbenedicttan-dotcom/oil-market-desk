const $ = (id) => document.getElementById(id);
const money = (n) => (n == null ? '—' : '$' + Number(n).toFixed(2));
const signed = (n) => (n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2));
const cls = (n) => (n >= 0 ? 'pos' : 'neg');

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Price cards
// ---------------------------------------------------------------------------
function basisCard(d) {
  return `
    <div class="card">
      <h3>${d.label} <span>futures / spot</span></h3>
      <div class="row"><span class="k">Paper (futures)</span><span class="v">${money(d.paper)}</span></div>
      <div class="row"><span class="k">Physical (spot) <em>${d.physicalDate || ''}</em></span><span class="v">${money(d.physical)}</span></div>
      <div class="row"><span class="k">Basis (phys − paper)</span>
        <span class="v basis ${cls(d.basis)}">${signed(d.basis)}</span></div>
    </div>`;
}

function spreadCard(m) {
  return `
    <div class="card">
      <h3>Brent − WTI <span>the intra-complex spread</span></h3>
      <div class="row"><span class="k">Paper spread</span><span class="v ${cls(m.spread.paper)}">${signed(m.spread.paper)}</span></div>
      <div class="row"><span class="k">Physical spread</span><span class="v ${cls(m.spread.physical)}">${signed(m.spread.physical)}</span></div>
      <div class="row"><span class="k">Paper − Physical</span><span class="v ${cls(m.spread.paper - m.spread.physical)}">${signed(m.spread.paper - m.spread.physical)}</span></div>
    </div>`;
}

async function loadMarket() {
  const m = await getJSON('/api/market');
  $('cards').innerHTML = basisCard(m.wti) + basisCard(m.brent) + spreadCard(m);
  $('updated').textContent = 'updated ' + new Date(m.updated).toLocaleTimeString();
  $('notes').innerHTML = '<ul>' + m.notes.map((n) => `<li>${n}</li>`).join('') + '</ul>';
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
let chart;
let history;

function datasetsFor(metric, h) {
  const line = (label, data, color) => ({
    label, data, borderColor: color, backgroundColor: color + '22',
    borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true, fill: false,
  });
  switch (metric) {
    case 'brent':
      return [line('Brent paper', h.brent.paper, '#4aa3ff'), line('Brent physical', h.brent.physical, '#f0a02a')];
    case 'basisWti':
      return [line('WTI basis', h.basis.wti, '#2ecc71')];
    case 'basisBrent':
      return [line('Brent basis', h.basis.brent, '#b07cff')];
    case 'spreadPaper':
      return [line('Brent−WTI paper', h.spread.paper, '#4aa3ff')];
    case 'spreadPhysical':
      return [line('Brent−WTI physical', h.spread.physical, '#f0a02a')];
    case 'wti':
    default:
      return [line('WTI paper', h.wti.paper, '#4aa3ff'), line('WTI physical', h.wti.physical, '#f0a02a')];
  }
}

function renderChart(metric) {
  const data = {
    labels: history.dates,
    datasets: datasetsFor(metric, history),
  };
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#8b9bab', boxWidth: 12 } } },
    scales: {
      x: { ticks: { color: '#8b9bab', maxTicksLimit: 8 }, grid: { color: '#1a232e' } },
      y: { ticks: { color: '#8b9bab', callback: (v) => '$' + v }, grid: { color: '#1a232e' } },
    },
  };
  if (chart) { chart.data = data; chart.update(); return; }
  chart = new Chart($('chart'), { type: 'line', data, options: opts });
}

async function loadHistory() {
  history = await getJSON('/api/history');
  renderChart($('metric').value);
}

// ---------------------------------------------------------------------------
// Tankers
// ---------------------------------------------------------------------------
let map, layer;

function initMap() {
  map = L.map('map', { worldCopyJump: true, attributionControl: true }).setView([25, 30], 2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 18,
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
}

async function loadTankers() {
  const t = await getJSON('/api/tankers');
  const s = t.status;

  const pill = $('ais-status');
  if (!s.enabled) {
    pill.textContent = 'off'; pill.className = 'pill warn';
    $('ais-help').classList.remove('hidden');
    $('ais-help').innerHTML =
      `Live tanker tracking is <b>off</b>. Get a free key at ` +
      `<a href="https://aisstream.io" target="_blank">aisstream.io</a>, then restart with ` +
      `<code>AISSTREAM_KEY=yourkey npm start</code>.`;
  } else {
    pill.textContent = s.connected ? `live · ${s.messages.toLocaleString()} msgs` : 'connecting…';
    pill.className = 'pill ' + (s.connected ? 'ok' : 'warn');
    $('ais-help').classList.add('hidden');
  }

  layer.clearLayers();
  for (const v of t.tankers) {
    if (v.lat == null || v.lon == null) continue;
    L.circleMarker([v.lat, v.lon], {
      radius: 4, color: '#f0a02a', weight: 1, fillColor: '#f0a02a', fillOpacity: 0.7,
    }).bindPopup(`<b>${v.name || 'MMSI ' + v.mmsi}</b><br>${(v.sog ?? 0).toFixed(1)} kn · MMSI ${v.mmsi}`).addTo(layer);
  }

  const rows = t.tankers.slice(0, 60).map((v) =>
    `<div class="t"><span>${v.name || '(' + v.mmsi + ')'}</span>` +
    `<span>${(v.sog ?? 0).toFixed(1)} kn</span><span>${v.lat.toFixed(1)}, ${v.lon.toFixed(1)}</span></div>`).join('');
  $('tanker-list').innerHTML =
    `<div class="t h"><span>vessel (${t.count} tracked)</span><span>speed</span><span>position</span></div>` + rows;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function refreshAll() {
  try { await loadMarket(); } catch (e) { console.error(e); }
  try { await loadTankers(); } catch (e) { console.error(e); }
}

$('refresh').addEventListener('click', refreshAll);
$('metric').addEventListener('change', () => renderChart($('metric').value));

initMap();
await loadHistory();
await refreshAll();
setInterval(loadTankers, 15000);   // tanker positions
setInterval(loadMarket, 60000);    // prices
