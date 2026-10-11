const $ = (id) => document.getElementById(id);
const fmt = (n, dp = 2) => (n == null ? '—' : '$' + Number(n).toFixed(dp));
const signed = (n, dp = 2) => (n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(dp));
const cls = (n) => (n == null ? '' : n >= 0 ? 'pos' : 'neg');
const GAL = 42; // gallons per barrel

let data;    // /api/market
let history; // /api/history
let tankerInfo = { status: {}, count: 0, tankers: [] };
const seenAlerts = new Set();

function showError(msg) {
  const el = $('error');
  el.classList.remove('hidden');
  el.textContent = '⚠ ' + msg;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Derived metrics: crack spreads ($/bbl) from product futures/spot
// ---------------------------------------------------------------------------
function crackSpreads(m) {
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  const w = by.wti;
  const rb = by.rbob;
  const ho = by.ulsd;
  const out = [];
  const add = (label, value) => { if (value != null && !Number.isNaN(value)) out.push({ label, value }); };
  if (rb && w) {
    add('Gasoline crack (paper)', rb.paper != null && w.paper != null ? rb.paper * GAL - w.paper : null);
    add('Gasoline crack (physical)', rb.physical != null && w.physical != null ? rb.physical * GAL - w.physical : null);
  }
  if (ho && w) {
    add('Diesel crack (paper)', ho.paper != null && w.paper != null ? ho.paper * GAL - w.paper : null);
    add('Diesel crack (physical)', ho.physical != null && w.physical != null ? ho.physical * GAL - w.physical : null);
  }
  if (rb && ho && w && rb.paper != null && ho.paper != null && w.paper != null) {
    add('3-2-1 crack (paper)', ((2 * rb.paper + ho.paper) * GAL) / 3 - w.paper);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cards
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

function spreadCard(s, title) {
  return `
    <div class="card">
      <h3>${title || s.label} <span>${s.unit}</span></h3>
      <div class="row"><span class="k">Paper spread</span><span class="v ${cls(s.paper)}">${signed(s.paper, s.dp)}</span></div>
      <div class="row"><span class="k">Physical spread</span><span class="v ${cls(s.physical)}">${signed(s.physical, s.dp)}</span></div>
      <div class="row"><span class="k">Paper − Physical</span><span class="v ${cls(s.paper - s.physical)}">${signed(s.paper - s.physical, s.dp)}</span></div>
    </div>`;
}

function crackCard(c) {
  return `
    <div class="card">
      <h3>${c.label} <span>$/bbl</span></h3>
      <div class="row"><span class="k">Margin</span><span class="v basis ${cls(c.value)}">${signed(c.value)}</span></div>
      <div class="row"><span class="k">Read</span><span class="v" style="font-weight:400;color:var(--dim)">${c.value > 20 ? 'strong' : c.value > 8 ? 'healthy' : 'weak'}</span></div>
    </div>`;
}

function renderCards(m) {
  const cardsHtml = m.benchmarks.map(benchCard).join('');
  const spreadsHtml = Object.values(m.spreads).map(spreadCard).join('');
  const cracks = crackSpreads(m);
  const cracksHtml = cracks.map(crackCard).join('');
  $('cards').innerHTML = `
    <div class="group"><h2 class="gtitle">Benchmarks</h2><div class="cards">${cardsHtml}</div></div>
    ${spreadsHtml ? `<div class="group"><h2 class="gtitle">Crude spreads</h2><div class="cards">${spreadsHtml}</div></div>` : ''}
    ${cracksHtml ? `<div class="group"><h2 class="gtitle">Crack spreads (refining margins)</h2><div class="cards">${cracksHtml}</div></div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Insights — plain-English interpretation
// ---------------------------------------------------------------------------
function marketInsights(m) {
  const out = [];
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  for (const b of m.benchmarks) {
    if (b.basis == null) continue;
    const above = b.basis >= 0;
    out.push(`<b>${b.label}</b>: physical ${fmt(b.physical, b.dp)} trades ${Math.abs(b.basis).toFixed(b.dp)} ${above ? 'ABOVE' : 'BELOW'} paper — ${above ? 'physical tightness (backwardation), supportive of prompt crude.' : 'physical oversupply (contango); storage economics favour holding barrels.'}`);
  }
  const s = m.spreads.brent_wti;
  if (s) {
    const d = s.physical - s.paper;
    out.push(`<b>Brent−WTI</b>: physical spread ${signed(s.physical)} vs paper ${signed(s.paper)} — physical is ${Math.abs(d).toFixed(2)} ${d >= 0 ? 'wider' : 'narrower'}. ${d > 3 ? 'Waterborne Brent is bid relative to landlocked WTI → export pull.' : d < -3 ? 'WTI is bid vs Brent → US domestic tightness.' : 'The two benchmarks are broadly aligned.'}`);
  }
  const cr = crackSpreads(m);
  const d321 = cr.find((c) => c.label.startsWith('3-2-1'));
  if (d321) out.push(`<b>3-2-1 refining margin</b> ${signed(d321.value)} $/bbl — ${d321.value > 20 ? 'very strong; refiners will pull more crude.' : d321.value > 10 ? 'healthy.' : 'thin; run cuts are possible.'}`);
  const diesel = cr.find((c) => c.label.startsWith('Diesel crack (paper)'));
  if (diesel) out.push(`<b>Diesel crack</b> ${signed(diesel.value)} $/bbl — diesel is the ${diesel.value > 25 ? 'engine of the complex right now.' : 'secondary driver vs gasoline.'}`);
  return out;
}

function tankerInsights(t) {
  const out = [];
  const s = t.status || {};
  if (!s.enabled) { out.push('Live tanker tracking is off — add a free AIS key to enable.'); return out; }
  const list = t.tankers || [];
  if (!list.length) { out.push(`Connected to AIS (${(s.messages || 0).toLocaleString()} messages) — identifying tankers… first counts appear within a minute.`); return out; }
  const idlers = list.filter((v) => (v.sog ?? 0) < 1).length;
  const moving = list.length - idlers;
  const avg = list.reduce((a, v) => a + (v.sog || 0), 0) / list.length;
  out.push(`<b>${list.length} tankers</b> tracked: ${moving} under way, ${idlers} nearly stationary.`);
  out.push(`A cluster of <b>stationary tankers</b> can mean floating storage or congestion; lots of <b>fast, laden</b> tankers usually tightens freight (higher Worldscale rates).`);
  out.push(`Average speed ${avg.toFixed(1)} kn. ${avg > 8 ? 'Brisk movement → active trade.' : avg < 4 ? 'Slow movement → subdued/deliberate.' : 'Moderate activity.'}`);
  out.push(`<span class="note">Freight indices (Baltic/Worldscale) are paid data; AIS activity is a free proxy for shipping tightness.</span>`);
  return out;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
function computeAlerts(m, t) {
  const out = [];
  const by = Object.fromEntries(m.benchmarks.map((b) => [b.id, b]));
  if (by.brent?.basis != null && Math.abs(by.brent.basis) > 10) out.push({ level: 'high', text: `Brent basis is extreme (${signed(by.brent.basis)}) — physical market dislocation.` });
  if (by.wti?.basis != null && Math.abs(by.wti.basis) > 3.5) out.push({ level: 'med', text: `WTI basis ${signed(by.wti.basis)} — wider than normal.` });
  const s = m.spreads.brent_wti;
  if (s && Math.abs(s.physical - s.paper) > 5) out.push({ level: 'med', text: `Brent−WTI physical vs paper diverged by ${signed(s.physical - s.paper)}.` });
  const diesel = crackSpreads(m).find((c) => c.label.startsWith('Diesel crack (paper)'));
  if (diesel && diesel.value > 28) out.push({ level: 'high', text: `Diesel crack ${signed(diesel.value)} — very strong refining margins.` });
  if (diesel && diesel.value < 6) out.push({ level: 'high', text: `Diesel crack only ${signed(diesel.value)} — refiner run cuts likely.` });
  const list = t.tankers || [];
  const idlers = list.filter((v) => (v.sog ?? 0) < 1).length;
  if (t.status?.enabled && idlers >= 15) out.push({ level: 'med', text: `${idlers} tankers nearly stationary — watch for floating storage building.` });
  return out;
}

function renderAlerts(alerts) {
  $('alert-count').textContent = String(alerts.length);
  $('alert-count').className = 'pill ' + (alerts.some((a) => a.level === 'high') ? 'warn' : alerts.length ? '' : 'ok');
  $('alerts').innerHTML = alerts.length
    ? alerts.map((a) => `<div class="alert ${a.level}"><span class="badge">${a.level === 'high' ? 'HIGH' : 'WATCH'}</span> ${a.text}</div>`).join('')
    : '<div class="alert none">No alerts — markets within normal ranges.</div>';

  // desktop notifications for new HIGH alerts (if permitted)
  if ('Notification' in window && Notification.permission === 'granted') {
    for (const a of alerts) {
      if (a.level === 'high' && !seenAlerts.has(a.text)) {
        seenAlerts.add(a.text);
        try { new Notification('Oil Basis alert', { body: a.text }); } catch {}
      }
    }
  }
}

function renderInsights(m, t) {
  $('market-insights').innerHTML = marketInsights(m).map((x) => `<li>${x}</li>`).join('');
  $('tanker-insights').innerHTML = tankerInsights(t).map((x) => `<li>${x}</li>`).join('');
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
let chart;

function buildMetricOptions(m) {
  const sel = $('metric');
  const prev = sel.value;
  const opts = [];
  for (const b of m.benchmarks) {
    if (b.paper == null) opts.push(`<option value="${b.id}">${b.label} (spot only)</option>`);
    else {
      opts.push(`<option value="${b.id}">${b.label} — paper vs physical</option>`);
      opts.push(`<option value="basis:${b.id}">${b.label} basis (phys − paper)</option>`);
    }
  }
  for (const key of Object.keys(m.spreads)) opts.push(`<option value="spread:${key}">${m.spreads[key].label} (paper & physical)</option>`);
  sel.innerHTML = opts.join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function line(label, arr, color) {
  return { label, data: arr, borderColor: color, backgroundColor: color + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true, fill: false };
}

function datasetsFor(metric, h, m) {
  const b = m.benchmarks.find((x) => x.id === metric);
  if (b) {
    const s = h.series[metric];
    const sets = [];
    if (b.paper != null) sets.push(line(`${b.label} paper`, s.paper, '#4aa3ff'));
    sets.push(line(`${b.label} physical`, s.physical, '#f0a02a'));
    return sets;
  }
  if (metric.startsWith('basis:')) {
    const id = metric.slice(6);
    const bm = m.benchmarks.find((x) => x.id === id);
    return [line(`${bm.label} basis`, h.basis[id], '#2ecc71')];
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
  const chartData = { labels: history.dates, datasets: datasetsFor($('metric').value, history, data) };
  const opts = {
    responsive: true, maintainAspectRatio: false,
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

async function loadMarket() {
  data = await getJSON('/api/market');
  renderCards(data);
  buildMetricOptions(data);
  renderInsights(data, tankerInfo);
  renderAlerts(computeAlerts(data, tankerInfo));
  $('updated').textContent = 'updated ' + new Date(data.updated).toLocaleTimeString();
  $('notes').innerHTML = '<ul>' + data.notes.map((n) => `<li>${n}</li>`).join('') + '</ul>';
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
  tankerInfo = await getJSON('/api/tankers');
  const s = tankerInfo.status;

  const pill = $('ais-status');
  if (!s.enabled) {
    pill.textContent = 'off'; pill.className = 'pill warn';
    $('ais-help').classList.remove('hidden');
    $('ais-help').innerHTML = `Live tanker tracking is <b>off</b>. Get a free key at <a href="https://aisstream.io" target="_blank">aisstream.io</a>, then restart with <code>AISSTREAM_KEY=yourkey npm start</code>.`;
  } else {
    pill.textContent = s.connected ? `live · ${(s.messages || 0).toLocaleString()} msgs` : 'connecting…';
    pill.className = 'pill ' + (s.connected ? 'ok' : 'warn');
    $('ais-help').classList.add('hidden');
  }

  layer.clearLayers();
  for (const v of tankerInfo.tankers) {
    if (v.lat == null || v.lon == null) continue;
    L.circleMarker([v.lat, v.lon], { radius: 4, color: '#f0a02a', weight: 1, fillColor: '#f0a02a', fillOpacity: 0.7 })
      .bindPopup(`<b>${v.name || 'MMSI ' + v.mmsi}</b><br>${(v.sog ?? 0).toFixed(1)} kn · MMSI ${v.mmsi}`).addTo(layer);
  }

  const rows = tankerInfo.tankers.slice(0, 60).map((v) =>
    `<div class="t"><span>${v.name || '(' + v.mmsi + ')'}</span><span>${(v.sog ?? 0).toFixed(1)} kn</span><span>${v.lat.toFixed(1)}, ${v.lon.toFixed(1)}</span></div>`).join('');
  $('tanker-list').innerHTML = `<div class="t h"><span>vessel (${tankerInfo.count} tracked)</span><span>speed</span><span>position</span></div>` + rows;

  if (data) { renderInsights(data, tankerInfo); renderAlerts(computeAlerts(data, tankerInfo)); }
}

// ---------------------------------------------------------------------------
// Boot  (async IIFE — the old top-level await is what blanked the page)
// ---------------------------------------------------------------------------
$('refresh').addEventListener('click', refreshAll);
$('metric').addEventListener('change', renderChart);

async function refreshAll() {
  try { await loadMarket(); } catch (e) { showError(e.message); console.error(e); }
  try { await loadTankers(); } catch (e) { showError(e.message); console.error(e); }
}

(async function boot() {
  try { initMap(); } catch (e) { console.error(e); }
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  await loadHistory().catch((e) => showError(e.message));
  await refreshAll();
  setInterval(loadTankers, 15000);
  setInterval(loadMarket, 60000);
})();
