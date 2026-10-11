const $ = (id) => document.getElementById(id);
const fmt = (n, dp = 2, unit = '$') => (n == null ? '—' : unit + Number(n).toFixed(dp));
const signed = (n, dp = 2) => (n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(dp));
const cls = (n) => (n == null ? '' : n >= 0 ? 'pos' : 'neg');

let data; // last /api/market payload

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Cards (grouped, built from the registry)
// ---------------------------------------------------------------------------
function benchCard(b) {
  const spotOnly = b.paper == null;
  return `
    <div class="card">
      <h3>${b.label} <span>${b.unit}${spotOnly ? ' · spot' : ''}</span></h3>
      <div class="row"><span class="k">Paper (futures)</span><span class="v">${spotOnly ? '<span class="k">— none</span>' : fmt(b.paper, b.dp)}</span></div>
      <div class="row"><span class="k">Physical <em>${b.physicalDate || ''}</em></span><span class="v">${fmt(b.physical, b.dp)}</span></div>
      <div class="row"><span class="k">Basis</span><span class="v basis ${cls(b.basis)}">${b.basis == null ? '—' : signed(b.basis, b.dp)}</span></div>
    </div>`;
}

function spreadCard(s) {
  return `
    <div class="card">
      <h3>${s.label} <span>${s.unit}</span></h3>
      <div class="row"><span class="k">Paper spread</span><span class="v ${cls(s.paper)}">${signed(s.paper, s.dp)}</span></div>
      <div class="row"><span class="k">Physical spread</span><span class="v ${cls(s.physical)}">${signed(s.physical, s.dp)}</span></div>
      <div class="row"><span class="k">Paper − Physical</span><span class="v ${cls(s.paper - s.physical)}">${signed(s.paper - s.physical, s.dp)}</span></div>
    </div>`;
}

function renderCards(m) {
  const groups = {};
  for (const b of m.benchmarks) (groups[b.group] ||= []).push(b);
  const cardsHtml = m.benchmarks.map(benchCard).join('');
  const spreadsHtml = Object.values(m.spreads).map(spreadCard).join('');

  $('cards').innerHTML = `
    <div class="group">
      <h2 class="gtitle">Benchmarks</h2>
      <div class="cards">${cardsHtml}</div>
    </div>
    ${spreadsHtml ? `<div class="group"><h2 class="gtitle">Crude spreads</h2><div class="cards">${spreadsHtml}</div></div>` : ''}`;
}

async function loadMarket() {
  data = await getJSON('/api/market');
  renderCards(data);
  buildMetricOptions(data);
  $('updated').textContent = 'updated ' + new Date(data.updated).toLocaleTimeString();
  $('notes').innerHTML = '<ul>' + data.notes.map((n) => `<li>${n}</li>`).join('') + '</ul>';
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
let chart;
let history;

function buildMetricOptions(m) {
  const sel = $('metric');
  const prev = sel.value;
  const opts = [];
  for (const b of m.benchmarks) {
    if (b.paper == null) {
      opts.push(`<option value="${b.id}">${b.label} (spot only)</option>`);
    } else {
      opts.push(`<option value="${b.id}">${b.label} — paper vs physical</option>`);
      opts.push(`<option value="basis:${b.id}">${b.label} basis (phys − paper)</option>`);
    }
  }
  for (const key of Object.keys(m.spreads)) {
    opts.push(`<option value="spread:${key}">${m.spreads[key].label} (paper & physical)</option>`);
  }
  sel.innerHTML = opts.join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function line(label, arr, color) {
  return { label, data: arr, borderColor: color, backgroundColor: color + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true, fill: false };
}

function datasetsFor(metric, h, m) {
  const bench = m.benchmarks.find((b) => b.id === metric);
  if (bench) {
    const s = h.series[metric];
    const sets = [];
    if (bench.paper != null) sets.push(line(`${bench.label} paper`, s.paper, '#4aa3ff'));
    sets.push(line(`${bench.label} physical`, s.physical, '#f0a02a'));
    return sets;
  }
  if (metric.startsWith('basis:')) {
    const id = metric.slice(6);
    const b = m.benchmarks.find((x) => x.id === id);
    return [line(`${b.label} basis`, h.basis[id], '#2ecc71')];
  }
  if (metric.startsWith('spread:')) {
    const key = metric.slice(7);
    const s = h.spreads[key];
    return [line(`${key} paper`, s.paper, '#4aa3ff'), line(`${key} physical`, s.physical, '#f0a02a')];
  }
  return [];
}

function renderChart() {
  if (!history || !data) return;
  const metric = $('metric').value;
  const chartData = { labels: history.dates, datasets: datasetsFor(metric, history, data) };
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#8b9bab', boxWidth: 12 } } },
    scales: {
      x: { ticks: { color: '#8b9bab', maxTicksLimit: 8 }, grid: { color: '#1a232e' } },
      y: { ticks: { color: '#8b9bab' }, grid: { color: '#1a232e' } },
    },
  };
  if (chart) { chart.data = chartData; chart.update(); return; }
  chart = new Chart($('chart'), { type: 'line', data: chartData, options: opts });
}

async function loadHistory() {
  history = await getJSON('/api/history');
  renderChart();
}

// ---------------------------------------------------------------------------
// Tankers
// ---------------------------------------------------------------------------
let map, layer;

function initMap() {
  map = L.map('map', { worldCopyJump: true }).setView([25, 30], 2);
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
      `Live tanker tracking is <b>off</b>. Get a free key at <a href="https://aisstream.io" target="_blank">aisstream.io</a>, then restart with <code>AISSTREAM_KEY=yourkey npm start</code>.`;
  } else {
    pill.textContent = s.connected ? `live · ${s.messages.toLocaleString()} msgs` : 'connecting…';
    pill.className = 'pill ' + (s.connected ? 'ok' : 'warn');
    $('ais-help').classList.add('hidden');
  }

  layer.clearLayers();
  for (const v of t.tankers) {
    if (v.lat == null || v.lon == null) continue;
    L.circleMarker([v.lat, v.lon], { radius: 4, color: '#f0a02a', weight: 1, fillColor: '#f0a02a', fillOpacity: 0.7 })
      .bindPopup(`<b>${v.name || 'MMSI ' + v.mmsi}</b><br>${(v.sog ?? 0).toFixed(1)} kn · MMSI ${v.mmsi}`).addTo(layer);
  }

  const rows = t.tankers.slice(0, 60).map((v) =>
    `<div class="t"><span>${v.name || '(' + v.mmsi + ')'}</span><span>${(v.sog ?? 0).toFixed(1)} kn</span><span>${v.lat.toFixed(1)}, ${v.lon.toFixed(1)}</span></div>`).join('');
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
$('metric').addEventListener('change', renderChart);

initMap();
await loadHistory();
await refreshAll();
setInterval(loadTankers, 15000);
setInterval(loadMarket, 60000);
