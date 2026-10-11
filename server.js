// Oil Basis — paper vs physical spreads across energy benchmarks + live tankers.
// Zero runtime dependencies: Node's built-in HTTP, fetch and WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const UA = { 'User-Agent': 'Mozilla/5.0 (oil-basis)' };

// ---------------------------------------------------------------------------
// Benchmark registry
//   paper    = futures    -> Yahoo Finance symbol
//   physical = spot/cash  -> FRED / EIA series id
// Add a row to add a benchmark (both feeds must exist for free).
// ---------------------------------------------------------------------------
const BENCHMARKS = [
  { id: 'wti',    label: 'WTI (Cushing)',   group: 'Crude',   unit: '$/bbl',   dp: 2, paper: 'CL=F', physical: 'DCOILWTICO', source: 'fred' },
  { id: 'brent',  label: 'Brent',           group: 'Crude',   unit: '$/bbl',   dp: 2, paper: 'BZ=F', physical: 'DCOILBRENTEU', source: 'fred' },
  { id: 'rbob',   label: 'RBOB Gasoline',   group: 'Refined', unit: '$/gal',   dp: 3, paper: 'RB=F', physical: 'DGASUSGULF', source: 'fred' },
  { id: 'ulsd',   label: 'ULSD / Heating',  group: 'Refined', unit: '$/gal',   dp: 3, paper: 'HO=F', physical: 'DHOILNYH', source: 'fred' },
  { id: 'jet',    label: 'Jet Fuel (USGC)', group: 'Refined', unit: '$/gal',   dp: 3, paper: null,   physical: 'EER_EPJK_PF4_RGC_DPG', source: 'eia' },
  { id: 'propane',label: 'Propane (Mt Belvieu)', group: 'Refined', unit: '$/gal', dp: 3, paper: null, physical: 'EER_EPLLPA_PF4_Y44MB_DPG', source: 'eia' },
  { id: 'natgas', label: 'Natural Gas',     group: 'Gas',     unit: '$/MMBtu', dp: 2, paper: 'NG=F', physical: 'DHHNGSP', source: 'fred' },
];

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function yahooSeries(symbol, range = '6mo', interval = '1d') {
  const res = await fetch(`${YF}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, { headers: UA });
  if (!res.ok) throw new Error(`yahoo ${symbol} -> ${res.status}`);
  const r = (await res.json()).chart?.result?.[0];
  if (!r) throw new Error(`yahoo ${symbol} -> no result`);
  const ts = r.timestamp || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  const series = {};
  ts.forEach((t, i) => { if (close[i] != null) series[new Date(t * 1000).toISOString().slice(0, 10)] = close[i]; });
  return { symbol, price: r.meta.regularMarketPrice, series };
}

async function fredSeries(id, days = 220) {
  const cosd = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, { headers: UA });
  if (!res.ok) throw new Error(`fred ${id} -> ${res.status}`);
  const text = await res.text();
  const out = {};
  for (const line of text.trim().split('\n').slice(1)) {
    const [d, v] = line.split(',');
    if (v && v !== '.') out[d] = parseFloat(v);
  }
  return out;
}

// EIA v2 spot prices — needs a free EIA_API_KEY. Returns {} if the key is absent.
async function eiaSeries(id, days = 220) {
  const key = process.env.EIA_API_KEY;
  if (!key) return {};
  const p = new URLSearchParams();
  p.set('api_key', key);
  p.set('frequency', 'daily');
  p.append('data[0]', 'value');
  p.append('facets[series][]', id);
  p.set('start', new Date(Date.now() - days * 864e5).toISOString().slice(0, 10));
  p.append('sort[0][column]', 'period');
  p.append('sort[0][direction]', 'asc');
  p.set('length', '5000');
  const res = await fetch(`https://api.eia.gov/v2/petroleum/pri/spt/data/?${p}`, { headers: UA });
  if (!res.ok) throw new Error(`eia ${id} -> ${res.status}`);
  const json = await res.json();
  const out = {};
  for (const row of json.response?.data || []) out[row.period] = parseFloat(row.value);
  return out;
}

const spotSeries = (b, days) => (b.source === 'eia' ? eiaSeries(b.physical, days) : fredSeries(b.physical, days));

const lastEntry = (obj) => {
  const dates = Object.keys(obj).sort();
  const d = dates[dates.length - 1];
  return { date: d || null, value: d ? obj[d] : null };
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

const paperFor = (b) => (b.paper ? cached('p:' + b.paper, 45_000, () => yahooSeries(b.paper, '5d', '1d')) : Promise.resolve({ price: null }));
const physFor = (b) => cached('f:' + b.physical, 3_600_000, () => spotSeries(b, 14));
const hPaperFor = (b) => (b.paper ? cached('hp:' + b.paper, 3_600_000, () => yahooSeries(b.paper, '6mo', '1d')) : Promise.resolve({ series: {} }));
const hPhysFor = (b) => cached('hf:' + b.physical, 3_600_000, () => spotSeries(b, 220));

// ---------------------------------------------------------------------------
// Market snapshot
// ---------------------------------------------------------------------------
async function getMarket() {
  const rows = await Promise.all(BENCHMARKS.map(async (b) => {
    const [p, f] = await Promise.all([paperFor(b), physFor(b)]);
    const phys = lastEntry(f);
    const paper = p.price ?? null;
    const physical = phys.value ?? null;
    return {
      id: b.id, label: b.label, group: b.group, unit: b.unit, dp: b.dp,
      paper, physical, physicalDate: phys.date,
      basis: paper != null && physical != null ? physical - paper : null,
    };
  }));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  const spreads = {};
  if (by.brent && by.wti) {
    spreads.brent_wti = {
      label: 'Brent − WTI', unit: '$/bbl', dp: 2,
      paper: by.brent.paper - by.wti.paper,
      physical: by.brent.physical - by.wti.physical,
    };
  }
  return {
    updated: new Date().toISOString(),
    benchmarks: rows,
    spreads,
    notes: [
      'Paper = front-month futures; rolls on expiry, which can jump the basis.',
      'Physical = spot/cash (FRED / EIA), published with ~1 day lag.',
      'Propane & jet fuel are spot-only — no free exchange futures.',
      'Dubai / WTI Midland / Mars need a paid feed; not available for free.',
      'Basis = physical − paper. Positive = physical premium (backwardation pressure).',
    ],
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function getHistory() {
  const maps = {};
  await Promise.all(BENCHMARKS.map(async (b) => {
    const [p, f] = await Promise.all([hPaperFor(b), hPhysFor(b)]);
    maps[b.id] = { paper: p.series, physical: f };
  }));

  const allDates = new Set();
  for (const b of BENCHMARKS) {
    Object.keys(maps[b.id].paper).forEach((d) => allDates.add(d));
    Object.keys(maps[b.id].physical).forEach((d) => allDates.add(d));
  }
  const dates = [...allDates].sort().slice(-120);
  const at = (o, d) => (o[d] != null ? o[d] : null);

  const series = {};
  const basis = {};
  for (const b of BENCHMARKS) {
    const pm = maps[b.id].paper;
    const fm = maps[b.id].physical;
    series[b.id] = { paper: dates.map((d) => at(pm, d)), physical: dates.map((d) => at(fm, d)) };
    basis[b.id] = dates.map((d) => (at(fm, d) != null && at(pm, d) != null ? at(fm, d) - at(pm, d) : null));
  }

  const spreads = {};
  if (maps.brent && maps.wti) {
    spreads.brent_wti = {
      paper: dates.map((d) => (at(maps.brent.paper, d) != null && at(maps.wti.paper, d) != null ? at(maps.brent.paper, d) - at(maps.wti.paper, d) : null)),
      physical: dates.map((d) => (at(maps.brent.physical, d) != null && at(maps.wti.physical, d) != null ? at(maps.brent.physical, d) - at(maps.wti.physical, d) : null)),
    };
  }

  return { dates, series, basis, spreads };
}

// ---------------------------------------------------------------------------
// Live tanker tracking via aisstream.io (free key required)
// ---------------------------------------------------------------------------
const tankers = new Map();
const tankerMMSI = new Set();
const ais = { enabled: false, connected: false, messages: 0, startedAt: null, lastMessage: null, error: null };
const DEFAULT_BOXES = [
  [[18, -98], [31, -80]],
  [[48, -8], [62, 4]],
  [[-5, 95], [10, 110]],
  [[22, 46], [31, 62]],
];

function startAIS() {
  const key = process.env.AISSTREAM_KEY;
  if (!key) { ais.error = 'No AISSTREAM_KEY set — add one (free) to enable live tankers.'; return; }
  ais.enabled = true;
  ais.startedAt ||= new Date().toISOString();
  const boxes = process.env.AIS_BOXES ? JSON.parse(process.env.AIS_BOXES) : DEFAULT_BOXES;

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.addEventListener('open', () => {
    ais.connected = true; ais.error = null;
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: boxes, FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }));
    console.log('[ais] connected, subscribed to', boxes.length, 'regions');
  });
  ws.addEventListener('message', async (ev) => {
    let msg;
    try {
      let text = ev.data;
      if (typeof text !== 'string') text = text instanceof Blob ? await text.text() : Buffer.from(text).toString('utf8');
      msg = JSON.parse(text);
    } catch { return; }
    const meta = msg.MetaData || {};
    ais.messages += 1; ais.lastMessage = new Date().toISOString();
    if (msg.MessageType === 'ShipStaticData') {
      const t = msg.Message?.ShipStaticData?.Type;
      if (typeof t === 'number' && t >= 80 && t <= 89) tankerMMSI.add(meta.MMSI);
    } else if (msg.MessageType === 'PositionReport') {
      if (!tankerMMSI.has(meta.MMSI)) return;
      const p = msg.Message?.PositionReport || {};
      tankers.set(meta.MMSI, { mmsi: meta.MMSI, name: (meta.ShipName || '').trim(), lat: meta.latitude, lon: meta.longitude, sog: p.Sog, cog: p.Cog, ts: meta.time_utc });
      if (tankers.size > 6000) tankers.delete(tankers.keys().next().value);
    }
  });
  ws.addEventListener('close', () => { ais.connected = false; console.log('[ais] closed, reconnecting in 5s'); setTimeout(startAIS, 5000); });
  ws.addEventListener('error', (e) => { ais.error = String(e.message || e); });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const sendJSON = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/market') return sendJSON(res, 200, await getMarket());
    if (url.pathname === '/api/history') return sendJSON(res, 200, await getHistory());
    if (url.pathname === '/api/tankers') {
      const list = [...tankers.values()];
      return sendJSON(res, 200, { status: ais, count: list.length, tankers: list.slice(0, 2000) });
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  🛢️  Oil Basis running at  http://localhost:${PORT}`);
  console.log(`     ${BENCHMARKS.length} benchmarks: ${BENCHMARKS.map((b) => b.label).join(', ')}`);
  console.log(`     tankers: ${process.env.AISSTREAM_KEY ? 'aisstream.io' : 'disabled (set AISSTREAM_KEY)'}\n`);
  startAIS();
});
