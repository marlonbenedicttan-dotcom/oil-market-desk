// Build data/ma.json — a US-anchored M&A tape from SEC filings.
//
// Coverage, stated honestly: deals with an SEC 8-K carrying an EX-99 press release that announces an
// acquisition, by a US-listed party, on/after --from, with a disclosed value of at least --min $m.
// Private-to-private and purely non-US deals are out of scope, and the UI says so.
//
//   node scripts/fetch-ma.mjs --from=2026-07-01 --max=60
//   node scripts/fetch-ma.mjs --from=2016-01-01 --min=250 --enrich
//
// SEC wants a descriptive User-Agent with contact details; set SEC_UA to override. Requests are
// serialised at ~6/s (SEC's limit is 10/s) with backoff, and every filing is cached under
// data/.ma-cache so a re-run only fetches what is new.

import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'ma.json');
const CACHE = join(ROOT, 'data', '.ma-cache');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const FROM = arg('from', '2016-01-01');
const TO = arg('to', new Date().toISOString().slice(0, 10));
const MIN = Number(arg('min', 250));
const MAX = Number(arg('max', 6000));
const ENRICH = process.argv.includes('--enrich');
const DEBUG = process.argv.includes('--debug');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(CACHE, { recursive: true });

let last = 0;
async function get(url, json = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = Math.max(0, 165 - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.status === 403 || res.status === 429) { await sleep(1200 * (attempt + 1)); continue; }
      if (!res.ok) return null;
      return json ? res.json() : res.text();
    } catch { await sleep(700 * (attempt + 1)); }
  }
  return null;
}

// ---------------------------------------------------------------- discovery
async function discover() {
  const hits = [];
  for (let from = 0; from < 9900; from += 100) {
    const u = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"has agreed to acquire"')}`
      + `&forms=8-K&dateRange=custom&startdt=${FROM}&enddt=${TO}&from=${from}`;
    const j = await get(u, true);
    const h = (j && j.hits && j.hits.hits) || [];
    if (!h.length) break;
    for (const x of h) {
      const s = x._source || {};
      const [acc, doc] = String(x._id || '').split(':');
      const cik = Number((s.ciks || [])[0] || 0);
      if (!acc || !cik) continue;
      hits.push({ acc, doc, cik, date: s.file_date });
    }
    const total = j?.hits?.total?.value ?? j?.hits?.total ?? 0;
    if (hits.length >= MAX || from + 100 >= Math.min(total || hits.length, 9900)) break;
  }
  return hits.slice(0, MAX);
}

// ---------------------------------------------------------------- text
const textOf = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

async function pressRelease(hit) {
  const file = join(CACHE, hit.acc + '.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const nos = hit.acc.replace(/-/g, '');
  const base = `https://www.sec.gov/Archives/edgar/data/${hit.cik}/${nos}`;
  const idx = await get(`${base}/index.json`, true);
  const items = idx?.directory?.item || [];
  // Only a press release will do. Without one we cannot read the deal on its own terms, so skip it
  // rather than guess from an 8-K cover page.
  // Exhibits are routinely named "tm223212d1_ex99-1.htm" — match anywhere, not just at the start.
  const ex = items.filter((f) => /(?:^|[_-])(?:ex-?99|exhibit-?99)/i.test(String(f.name || '')) || /^EX-99/i.test(String(f.type || '')));
  if (!ex.length) return null;
  const pick = ex.find((f) => /99\.1/i.test(`${f.type} ${f.name}`)) || ex[0];
  const body = await get(`${base}/${pick.name}`);
  if (!body) return null;
  const text = textOf(body);
  try { writeFileSync(file, text); } catch {}
  return text;
}

// ---------------------------------------------------------------- parsing
const stripJunk = (t) => t.replace(/^\s*(false|true)?\s*\d{10}\s*/i, '').replace(/iso4217:\w+|xbrli:\w+/g, ' ');

const cleanName = (s) => String(s || '')
  .replace(/\s+/g, ' ')
  .replace(/^(?:the|a|an|and)\s+/i, '')
  .replace(/[,;:.]+$/g, '')
  .replace(/\s+(?:today|announced|said)$/i, '')
  .trim()
  .slice(0, 70);

const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
  .replace(/\b(Inc|Corp|Co|Lp|Llc|Plc|Ltd|Nv|Sa|Ag|Se)\b/g, (m) => m.toUpperCase());

function headlineNames(text) {
  // Press-release HTML collapses into very long runs, so a whole paragraph can share a line with the
  // headline. Cut each line into headline-sized chunks at sentence ends and at the usual sub-headline
  // markers ("Subject to…", "– CITY, date"), then test each chunk from the start.
  const STOP = /\s+(?:subject to|for\s+\$|for approximately|in (?:a|an|all|cash|stock)|from\s+[A-Z]|at\s+\$|today announced|announced today|said\b|which\b)/i;
  const chunks = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length < 12) continue;
    chunks.push(line);
    if (line.length > 220) {
      for (const sent of line.split(/(?<=[.!?])\s+/).slice(0, 5)) chunks.push(sent.trim());
    }
  }
  const PROSE = /^(today|that|this|we|i|our|the company|it|they|as part|under the|in connection|pursuant)\b/i;
  const pats = [
    /^(.{2,80}?)\s+(?:agrees? to|has agreed to|to|will)\s+(?:acquisition of|acquire|buy|merge with|combine with)\s+(.+)$/i,
    /^(.{2,80}?)\s+(?:announces?|completes?|closes?|completed|closed|declares?)\s+(?:the\s+)?(?:acquisition|merger)\s+of\s+(.+)$/i,
    /^(.{2,80}?)\s+(?:to be acquired by|acquired by|merges? with)\s+(.+)$/i,
    /^acquisition of\s+(.{2,80}?)\s+by\s+(.+)$/i,
  ];
  for (const chunk of chunks.slice(0, 200)) {
    if (PROSE.test(chunk)) continue;
    for (let k = 0; k < pats.length; k++) {
      const m = chunk.match(pats[k]);
      if (!m) continue;
      let a = cleanName(m[1].split(STOP)[0]);
      let b = cleanName(m[2].split(STOP)[0]);
      if (k === 2 || k === 3) [a, b] = [b, a];
      // A company name, not a fragment of prose: no percentages, share counts, money, or verbs.
      const BAD = /%|\bstake\b|\bshares? of\b|\bcommon stock\b|\$\d|\b(?:announced|today|will|has agreed|entered|pursuant)\b/i;
      if (a.length < 3 || b.length < 3 || a.length > 55 || b.length > 55) continue;
      if (BAD.test(a) || BAD.test(b)) continue;
      if (!/^[A-Z0-9]/.test(a) || !/^[A-Z0-9]/.test(b)) continue;
      if (/^(?:inc|corp|the|into|separate|we|it|they)\.?$/i.test(a)) continue;
      if (a.toLowerCase() === b.toLowerCase()) continue;
      return { a, b, headline: chunk };
    }
  }
  return null;
}

function extractValue(text) {
  const re = /\$\s?([\d][\d,.]*)\s*(billion|million|bn|mm)\b/gi;
  let m;
  const out = [];
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const usdM = /^b/i.test(m[2]) ? n * 1000 : n;
    if (usdM < 100 || usdM > 300000) continue;
    const near = text.slice(Math.max(0, m.index - 110), m.index + 70).toLowerCase();
    const far = text.slice(Math.max(0, m.index - 260), m.index + 160).toLowerCase();
    let score = 0;
    if (/purchase price|merger consideration|transaction value|enterprise value|equity value|consideration of|for approximately|valued at/.test(near)) score += 4;
    if (/acquisition|acquire|merger|transaction|deal/.test(far)) score += 2;
    if (/revenue|sales|market cap|market capitalization|backlog|assets under|contract value|annual/.test(near)) score -= 5;
    out.push({ usdM, score });
  }
  out.sort((a, b) => b.score - a.score || b.usdM - a.usdM);
  return out[0] && out[0].score > 0 ? Math.round(out[0].usdM) : null;
}

function extractRationale(text) {
  const body = text.replace(/\n/g, ' ');
  const sentences = body.split(/(?<=[.!?])\s+/);
  return sentences.find((s) => s.length > 70 && s.length < 380
    && /strateg|synerg|complement|accelerat|expand|transform|scale|vertical|adjacen|consolidat|combine/i.test(s)
    && !/forward-looking|safe harbor|risk factor/i.test(s))?.trim().replace(/^["“]|["”]$/g, '') || null;
}

const BANKS = ['Goldman Sachs', 'Morgan Stanley', 'J.P. Morgan', 'JPMorgan', 'Bank of America', 'BofA Securities', 'Citigroup',
  'Citi', 'Lazard', 'Evercore', 'Centerview Partners', 'Rothschild', 'Barclays', 'UBS', 'Deutsche Bank', 'Houlihan Lokey',
  'Jefferies', 'Qatalyst Partners', 'PJT Partners', 'Moelis', 'Perella Weinberg', 'BNP Paribas', 'HSBC', 'Nomura',
  'Macquarie', 'RBC Capital Markets', 'BMO Capital Markets', 'Wells Fargo Securities', 'TD Securities', 'Mizuho',
  'SMBC', 'MUFG', 'Cowen', 'Baird', 'Piper Sandler', 'Raymond James', 'Stifel', 'William Blair', 'Guggenheim',
  'Lincoln International', 'Harris Williams', 'Kroll', 'Duff & Phelps'];
function extractAdvisers(text) {
  const found = new Set();
  for (const b of BANKS) {
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(.{0,90})\\b${esc}\\b(.{0,90})`, 'i');
    const m = text.match(re);
    if (m && /advis|advisor|financial|acted as|exclusive|lead/i.test(m[1] + m[2])) found.add(b);
  }
  return [...found].slice(0, 6);
}

const CONSIDER = (t) => {
  const s = t.toLowerCase();
  const cash = /all[- ]cash|in cash|cash consideration/.test(s);
  const stock = /all[- ]stock|stock[- ]for[- ]stock|shares of (?:the )?(?:acquirer|parent|combined)|common stock of (?:the )?(?:acquirer|parent)/.test(s);
  return cash && stock ? 'mixed' : cash ? 'cash' : stock ? 'stock' : 'unknown';
};

const SIC_SECTOR = (sic) => {
  const n = Number(sic) || 0;
  if (n >= 100 && n < 1000) return 'Agriculture';
  if (n >= 1000 && n < 1500) return 'Mining';
  if (n >= 1500 && n < 1800) return 'Construction';
  if (n >= 2000 && n < 2200) return 'Food & beverage';
  if (n >= 2200 && n < 2400) return 'Textiles';
  if (n >= 2400 && n < 2800) return 'Paper & timber';
  if (n >= 2830 && n < 2840) return 'Healthcare';
  if (n >= 2800 && n < 2900) return 'Chemicals';
  if (n >= 2900 && n < 3200) return 'Energy';
  if (n >= 3200 && n < 3400) return 'Materials';
  if (n >= 3400 && n < 3600) return 'Industrials';
  if (n >= 3600 && n < 3700) return 'Electronics';
  if (n >= 3700 && n < 3800) return 'Transport equipment';
  if (n >= 3800 && n < 4000) return 'Instruments';
  if (n >= 4000 && n < 4900) return 'Transport';
  if (n >= 4900 && n < 5000) return 'Utilities';
  if (n >= 5000 && n < 5200) return 'Wholesale';
  if (n >= 5200 && n < 6000) return 'Retail';
  if (n >= 6000 && n < 6200) return 'Banks';
  if (n >= 6200 && n < 6300) return 'Brokers';
  if (n >= 6300 && n < 6500) return 'Insurance';
  if (n >= 6500 && n < 6600) return 'Real estate';
  if (n >= 6700 && n < 6800) return 'Holdings';
  if (n >= 7000 && n < 7300) return 'Hospitality';
  if (n >= 7300 && n < 8000) return 'Business services';
  if (n >= 8000 && n < 8100) return 'Healthcare';
  if (n >= 8100 && n < 9000) return 'Professional services';
  return 'Other';
};

// ---------------------------------------------------------------- enrichment
let TICKERS = null;   // CIK -> { ticker, name, sic } built from EDGAR's own company file
async function tickerMap() {
  if (TICKERS) return TICKERS;
  TICKERS = new Map();
  const j = await get('https://www.sec.gov/files/company_tickers.json', true);
  for (const r of Object.values(j || {})) {
    if (r && r.cik_str) TICKERS.set(String(r.cik_str).padStart(10, '0'), { ticker: r.ticker, name: r.title });
  }
  return TICKERS;
}

async function priceMove(ticker, date) {
  try {
    const t0 = Math.floor(Date.parse(date) / 1000);
    const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${t0 - 30 * 86400}&period2=${t0 + 10 * 86400}&interval=1d`, true);
    const r = j?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const cl = r?.indicators?.quote?.[0]?.close || [];
    const pairs = ts.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), cl[i]]).filter(([, v]) => v != null);
    const before = pairs.filter(([d]) => d < date);
    const after = pairs.filter(([d]) => d >= date);
    if (!before.length || !after.length) return null;
    const base = before[before.length - 1][1];
    return base ? +(((after[0][1] - base) / base) * 100).toFixed(1) : null;
  } catch { return null; }
}

async function enrich(deal, filerCik) {
  const map = await tickerMap();
  const f = map.get(String(filerCik).padStart(10, '0'));
  if (f) { deal.acquirerTicker = f.ticker; deal.acquirerName = titleCase(f.name); }
  // The target's ticker only when the name matches EDGAR's list EXACTLY — no fuzzy guesses.
  const want = deal.target.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [, v] of map) {
    if (v.name.toLowerCase().replace(/[^a-z0-9]/g, '') === want) { deal.targetTicker = v.ticker; break; }
  }
  if (deal.targetTicker) deal.targetMove = await priceMove(deal.targetTicker, deal.date);
  if (deal.acquirerTicker) deal.acquirerMove = await priceMove(deal.acquirerTicker, deal.date);
  return deal;
}

// ---------------------------------------------------------------- dry run (parser QA, no network)
if (process.argv.includes('--dry')) {
  const files = readdirSync(CACHE).filter((f) => f.endsWith('.txt'));
  let ok = 0;
  for (const f of files) {
    const t = readFileSync(join(CACHE, f), 'utf8');
    const body = stripJunk(t);
    const n = headlineNames(body);
    const v = extractValue(body);
    if (n && v) ok++;
    console.log(`${f.replace('.txt', '')} | $${v || '-'}m | ${n ? n.a + '  ->  ' + n.b : 'NO NAMES'}`);
  }
  console.log(`${ok}/${files.length} parsed names + value`);
  process.exit(0);
}

// ---------------------------------------------------------------- main
const hits = await discover();
console.log(`discovered ${hits.length} filings (${FROM} → ${TO})`);
const deals = [];
const seen = new Set();
let skipped = 0;
for (let i = 0; i < hits.length; i++) {
  const hit = hits[i];
  if (i && i % 100 === 0) console.log(`  ${i}/${hits.length} · ${deals.length} kept · ${skipped} skipped`);
  const text = await pressRelease(hit);
  if (!text || text.length < 400) { skipped++; continue; }
  const body = stripJunk(text);
  const names = headlineNames(body);
  const value = extractValue(body);
  if (DEBUG) {
    const first = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 12)[0] || '';
    console.log(`  · ${hit.date} $${value || '-'}m | ${names ? names.a + ' -> ' + names.b : 'NO NAMES'} | ${first.slice(0, 90)}`);
  }
  if (!value || value < MIN) { skipped++; continue; }
  const target = names ? names.b : null;
  if (!target) { skipped++; continue; }
  const key = `${target.toLowerCase().slice(0, 36)}|${hit.date.slice(0, 7)}`;
  if (seen.has(key)) { skipped++; continue; }
  seen.add(key);
  deals.push({
    id: hit.acc, date: hit.date, filerCik: hit.cik,
    target, acquirer: names.a,
    value, consideration: CONSIDER(body),
    rationale: extractRationale(body),
    advisers: extractAdvisers(body),
    source: '8-K',
    url: `https://www.sec.gov/Archives/edgar/data/${hit.cik}/${hit.acc.replace(/-/g, '')}/${hit.doc}`,
  });
}
console.log(`parsed ${deals.length} deals ≥ $${MIN}m (skipped ${skipped})`);

if (ENRICH) {
  await tickerMap();
  for (let i = 0; i < deals.length; i++) {
    if (i && i % 50 === 0) console.log(`  enrich ${i}/${deals.length}`);
    deals[i] = await enrich(deals[i], deals[i].filerCik);
  }
}
deals.sort((a, b) => (a.date < b.date ? 1 : -1));
writeFileSync(OUT, JSON.stringify({
  updated: new Date().toISOString(),
  coverage: { from: FROM, to: TO, minValueUsdM: MIN, source: 'SEC EDGAR 8-K press releases', scope: 'US-listed parties' },
  count: deals.length,
  deals,
}, null, 1));
console.log(`wrote ${OUT} · ${deals.length} deals · $${Math.round(deals.reduce((s, d) => s + d.value, 0) / 1000)}B`);
