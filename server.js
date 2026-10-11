// Oil Basis — paper vs physical crude (WTI & Brent) + live tanker tracking.
// Zero runtime dependencies: uses Node's built-in HTTP, fetch and WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);

const UA = { 'User-Agent': 'Mozilla/5.0 (oil-basis)' };

// ---------------------------------------------------------------------------
// Price sources
//   paper    = futures    -> Yahoo Finance  (CL=F WTI, BZ=F Brent)
//   physical = spot/cash  -> FRED / EIA      (DCOILWTICO, DCOILBRENTEU)
// ---------------------------------------------------------------------------
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function yahooSeries(symbol, range = '6mo', interval = '1d') {
  const res = await fetch(`${YF}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, { headers: UA });
  if (!res.ok) throw new Error(`yahoo ${symbol} -> ${res.status}`);
  const json = await res.json();
  const r = json.chart?.result?.[0];
  if (!r) throw new Error(`yahoo ${symbol} -> no result`);
  const ts = r.timestamp || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  const series = {};
  ts.forEach((t, i) => {
    if (close[i] != null) series[new Date(t * 1000).toISOString().slice(0, 10)] = close[i];
  });
  return { symbol, price: r.meta.regularMarketPrice, series };
}

async function fredSeries(series, days = 220) {
  const cosd = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${cosd}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`fred ${series} -> ${res.status}`);
  const text = await res.text();
  const out = {};
  for (const line of text.trim().split('\n').slice(1)) {
    const [d, v] = line.split(',');
    if (v && v !== '.') out[d] = parseFloat(v);
  }
  return out;
}

const lastEntry = (obj) => {
  const dates = Object.keys(obj).sort();
  const d = dates[dates.length - 1];
  return { date: d, value: obj[d] };
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

async function getMarket() {
  const [wtiPaper, brentPaper, wtiPhys, brentPhys] = await Promise.all([
    cached('wtiPaper', 45_000, () => yahooSeries('CL=F', '5d', '1d')),
    cached('brentPaper', 45_000, () => yahooSeries('BZ=F', '5d', '1d')),
    cached('wtiPhys', 3_600_000, () => fredSeries('DCOILWTICO', 14)),
    cached('brentPhys', 3_600_000, () => fredSeries('DCOILBRENTEU', 14)),
  ]);

  const wp = wtiPaper.price;
  const bp = brentPaper.price;
  const ws = lastEntry(wtiPhys);
  const bs = lastEntry(brentPhys);

  return {
    updated: new Date().toISOString(),
    wti: {
      label: 'WTI',
      paper: wp,
      physical: ws.value,
      physicalDate: ws.date,
      basis: ws.value - wp,
    },
    brent: {
      label: 'Brent',
      paper: bp,
      physical: bs.value,
      physicalDate: bs.date,
      basis: bs.value - bp,
    },
    spread: {
      paper: bp - wp,
      physical: bs.value - ws.value,
    },
    notes: [
      'Paper = front-month futures (Yahoo). Rolls on expiry, which can jump the basis.',
      'Physical = spot/cash assessment (EIA via FRED), published with a ~1 day lag.',
      "Basis = physical - paper. Positive = physical premium (backwardation pressure).",
    ],
  };
}

async function getHistory() {
  const [wtiPaper, brentPaper, wtiPhys, brentPhys] = await Promise.all([
    cached('hWtiPaper', 3_600_000, () => yahooSeries('CL=F', '6mo', '1d')),
    cached('hBrentPaper', 3_600_000, () => yahooSeries('BZ=F', '6mo', '1d')),
    cached('hWtiPhys', 3_600_000, () => fredSeries('DCOILWTICO')),
    cached('hBrentPhys', 3_600_000, () => fredSeries('DCOILBRENTEU')),
  ]);

  const dates = [...new Set([
    ...Object.keys(wtiPaper.series),
    ...Object.keys(brentPaper.series),
    ...Object.keys(wtiPhys),
    ...Object.keys(brentPhys),
  ])].sort().slice(-120);

  const at = (obj, d) => (obj[d] != null ? obj[d] : null);
  return {
    dates,
    wti: {
      paper: dates.map((d) => at(wtiPaper.series, d)),
      physical: dates.map((d) => at(wtiPhys, d)),
    },
    brent: {
      paper: dates.map((d) => at(brentPaper.series, d)),
      physical: dates.map((d) => at(brentPhys, d)),
    },
    basis: {
      wti: dates.map((d) => (at(wtiPhys, d) != null && at(wtiPaper.series, d) != null ? at(wtiPhys, d) - at(wtiPaper.series, d) : null)),
      brent: dates.map((d) => (at(brentPhys, d) != null && at(brentPaper.series, d) != null ? at(brentPhys, d) - at(brentPaper.series, d) : null)),
    },
    spread: {
      paper: dates.map((d) => (at(brentPaper.series, d) != null && at(wtiPaper.series, d) != null ? at(brentPaper.series, d) - at(wtiPaper.series, d) : null)),
      physical: dates.map((d) => (at(brentPhys, d) != null && at(wtiPhys, d) != null ? at(brentPhys, d) - at(wtiPhys, d) : null)),
    },
  };
}

// ---------------------------------------------------------------------------
// Live tanker tracking via aisstream.io (free key required)
//   Tanker ship types are 80-89. We learn MMSIs from ShipStaticData, then
//   keep the latest PositionReport for each tanker.
// ---------------------------------------------------------------------------
const tankers = new Map(); // mmsi -> position
const tankerMMSI = new Set();
const ais = { enabled: false, connected: false, messages: 0, startedAt: null, lastMessage: null, error: null };

const DEFAULT_BOXES = [
  [[18, -98], [31, -80]],  // US Gulf of Mexico
  [[48, -8], [62, 4]],     // North Sea / Rotterdam
  [[-5, 95], [10, 110]],   // Malacca / Singapore
  [[22, 46], [31, 62]],    // Persian Gulf
];

function startAIS() {
  const key = process.env.AISSTREAM_KEY;
  if (!key) {
    ais.error = 'No AISSTREAM_KEY set — add one (free) to enable live tankers.';
    return;
  }
  ais.enabled = true;
  ais.startedAt ||= new Date().toISOString();
  const boxes = process.env.AIS_BOXES ? JSON.parse(process.env.AIS_BOXES) : DEFAULT_BOXES;

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.addEventListener('open', () => {
    ais.connected = true;
    ais.error = null;
    ws.send(JSON.stringify({
      APIKey: key,
      BoundingBoxes: boxes,
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }));
    console.log('[ais] connected, subscribed to', boxes.length, 'regions');
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const meta = msg.MetaData || {};
    ais.messages += 1;
    ais.lastMessage = new Date().toISOString();
    if (msg.MessageType === 'ShipStaticData') {
      const type = msg.Message?.ShipStaticData?.Type;
      if (typeof type === 'number' && type >= 80 && type <= 89) tankerMMSI.add(meta.MMSI);
    } else if (msg.MessageType === 'PositionReport') {
      if (!tankerMMSI.has(meta.MMSI)) return;
      const p = msg.Message?.PositionReport || {};
      tankers.set(meta.MMSI, {
        mmsi: meta.MMSI,
        name: (meta.ShipName || '').trim(),
        lat: meta.latitude,
        lon: meta.longitude,
        sog: p.Sog,
        cog: p.Cog,
        heading: p.TrueHeading,
        ts: meta.time_utc,
      });
      if (tankers.size > 6000) tankers.delete(tankers.keys().next().value);
    }
  });
  ws.addEventListener('close', () => {
    ais.connected = false;
    console.log('[ais] closed, reconnecting in 5s');
    setTimeout(startAIS, 5000);
  });
  ws.addEventListener('error', (e) => { ais.error = String(e.message || e); });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/market') return sendJSON(res, 200, await getMarket());
    if (url.pathname === '/api/history') return sendJSON(res, 200, await getHistory());
    if (url.pathname === '/api/tankers') {
      const list = [...tankers.values()];
      return sendJSON(res, 200, {
        status: ais,
        count: list.length,
        tankers: list.slice(0, 2000),
      });
    }

    // static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  🛢️  Oil Basis running at  http://localhost:${PORT}`);
  console.log(`     prices: FRED (spot) + Yahoo (futures)`);
  console.log(`     tankers: ${process.env.AISSTREAM_KEY ? 'aisstream.io' : 'disabled (set AISSTREAM_KEY)'}\n`);
  startAIS();
});
