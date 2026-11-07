// Build the US price series the company chart reads, so the chart never depends on a live Yahoo call.
//
// The chart used to be fetched from Yahoo at request time. Yahoo rate-limits this host, and one month and
// six months came back with a single point for every company — the graph simply did not draw. The daily
// closes are already cached from Nasdaq for the valuation windows, so the chart is built from those and
// committed: ~500 points per ticker (daily for the last year, weekly before that), about 2 MB in total.
//
//   node scripts/build-us-charts.mjs
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const CHARTS = join(ROOT, 'data', 'cache', 'charts');
const OUT = join(ROOT, 'data', 'us-charts.json');
const DAY = 86400000;

// Daily for the last ~400 sessions, weekly before that: enough for every window the page offers and
// small enough that a browser draws it instantly. Used for the companies and for the index below, so
// the two cannot drift into different resolutions.
function compactRows(rows) {
  const cutoff = new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10);
  const kept = [];
  let lastWeekly = null;
  for (const [d, v] of rows) {
    if (d >= cutoff) { kept.push([d, v]); lastWeekly = null; continue; }
    if (!lastWeekly || Date.parse(d) - Date.parse(lastWeekly) >= 6.5 * DAY) { kept.push([d, v]); lastWeekly = d; }
    else kept[kept.length - 1] = [d, v];   // keep the last close of the week
  }
  return kept;
}

// Yahoo is reached over https with an explicit IPv4 preference: Node's fetch/undici fingerprints are
// rejected for these symbols, and a dual-stack host can hang on IPv6 from this machine. curl works,
// and so does this.
function httpsGet(url, timeout = 30000) {
  return new Promise((resolve) => {
    const req = https.get(url, { family: 4, headers: { 'User-Agent': 'Mozilla/5.0 (oil-basis)', Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, text: '' }); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: 200, text: body }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, text: '' }));
  });
}

// The index's own history. It is part of the same committed file and chart store as the companies, so
// the US market chart is a byte read rather than a live Yahoo call on every cold cache. The fetch is
// cached for six hours; a failed fetch keeps whatever is already committed.
const INDEX_DIR = join(ROOT, 'data', 'cache', 'index');
const indexFile = (symbol) => join(INDEX_DIR, `${symbol.replace(/[^\w.-]/g, '_')}.json`);

async function fetchIndexRaw(symbol, allowThin = false) {
  mkdirSync(INDEX_DIR, { recursive: true });
  const f = indexFile(symbol);
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (j.fetched && Date.now() - Date.parse(j.fetched) < 6 * 3600e3 && Array.isArray(j.rows) && j.rows.length) return j.rows;
  } catch { /* fetch */ }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d`;
  const r = await httpsGet(url);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const res = JSON.parse(r.text)?.chart?.result?.[0];
  const ts = res?.timestamp || [];
  const closes = res?.indicators?.quote?.[0]?.close || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c != null && Number.isFinite(+c)) rows.push([new Date(ts[i] * 1000).toISOString().slice(0, 10), +c]);
  }
  if (!allowThin && rows.length < 100) throw new Error('thin index series');
  if (rows.length) writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), rows }));
  return rows;
}

async function fetchIndex(symbol) {
  // Yahoo publishes only a live quote for ^SP1500, no daily history. SPTM is the ETF that tracks the
  // same index, so use its real history and scale the closes to the index's own level: the chart keeps
  // the index's number and the shape is the fund's, not a fabricated series.
  if (symbol !== '^SP1500') return fetchIndexRaw(symbol);
  mkdirSync(INDEX_DIR, { recursive: true });
  const f = indexFile('^SP1500-scaled');
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (j.fetched && Date.now() - Date.parse(j.fetched) < 6 * 3600e3 && Array.isArray(j.rows) && j.rows.length) return j.rows;
  } catch { /* fetch */ }
  const [proxy, quote] = await Promise.all([fetchIndexRaw('SPTM'), fetchIndexRaw('^SP1500', true)]);
  if (!proxy.length) throw new Error('no SPTM history');
  const level = quote.at(-1)?.[1];
  const factor = level && proxy.at(-1)?.[1] ? level / proxy.at(-1)[1] : 1;
  const rows = proxy.map(([d, v]) => [d, +(v * factor).toFixed(2)]);
  writeFileSync(f, JSON.stringify({ fetched: new Date().toISOString(), rows, proxy: 'SPTM', factor }));
  return rows;
}

const toIso = (mdY) => {
  const [m, d, y] = String(mdY).split('/').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const data = JSON.parse(readFileSync(FILE, 'utf8'));
// The chart cache is gitignored, so CI starts with none. A build there used to write `series: {}`
// over the committed file, which silently broke every company chart in production. Start from what is
// committed and only replace the tickers this run actually has data for.
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { series: {} };
const prevSeries = prev.series || {};
const out = { ...prevSeries };
let built = 0, skipped = 0;
for (const c of data.companies) {
  if (!c.ticker) continue;
  const f = join(CHARTS, `${c.ticker}.json`);
  if (!existsSync(f)) { skipped++; continue; }
  let rows;
  try { rows = JSON.parse(readFileSync(f, 'utf8')); } catch { skipped++; continue; }
  if (!Array.isArray(rows) || rows.length < 5) { skipped++; continue; }

  const dated = rows
    .filter((r) => Array.isArray(r) && r[0] && r[1] != null)
    .map((r) => [toIso(r[0]), +r[1]])
    .sort((a, b) => a[0].localeCompare(b[0]));

  out[c.ticker] = compactRows(dated);
  built++;
}

// The US MARKET view's index charts: S&P 1500 composite (SPTM proxy, scaled), and the three size
// indices Yahoo publishes directly. Keep them in this same file so the chart store serves each cohort
// from disk instead of a live call on every cold start.
const INDEX_SYMBOLS = ['^SP1500', '^GSPC', '^SP400', '^SP600'];
let indexBuilt = 0;
for (const sym of INDEX_SYMBOLS) {
  let kept = [];
  try { kept = compactRows(await fetchIndex(sym)); } catch (e) { kept = []; console.log(`  ${sym}: ${e.message}`); }
  if (kept.length > 100) { out[sym] = kept; indexBuilt++; }
  else if (prevSeries[sym]) out[sym] = prevSeries[sym];
  else console.log(`  ${sym}: no index history (Yahoo unavailable and nothing committed)`);
}

// Never trade a good committed series for a thinner one: a partial cache or an API hiccup must not
// delete history that is already published.
if (built === 0 && indexBuilt === 0 && Object.keys(prevSeries).length > 0) {
  console.log(`no chart cache found — keeping the ${Object.keys(prevSeries).length} committed series`);
  process.exit(0);
}
const prevCount = Object.keys(prevSeries).length;
if (!prevCount) console.log('no committed chart series yet — building a fresh file');
if (built > 0) for (const t of Object.keys(out)) if (!INDEX_SYMBOLS.includes(t) && !data.companies.some((c) => c.ticker === t)) delete out[t];
const nextCount = Object.keys(out).length;

writeFileSync(OUT + '.tmp', JSON.stringify({ updated: new Date().toISOString().slice(0, 10), series: out }));
renameSync(OUT + '.tmp', OUT);
// Re-index the per-company chart store so a chart reads its own line, not the whole file.
try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-chart-store.mjs'), 'us'], { stdio: 'inherit' }); }
catch (e) { console.log(`  chart store: ${e.message}`); }
const size = JSON.stringify(out).length;
console.log(`charts for ${built} companies · ${skipped} without a cache · ${nextCount - built} carried over · ${(size / 1024 / 1024).toFixed(1)} MB`);
