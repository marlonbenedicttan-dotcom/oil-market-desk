// Pure search helpers for the global company finder.
//
// The index is built once (scripts/build-search-index.mjs) and searched in memory by the server. This
// module has no I/O so the ranking rules can be tested directly.
//
// A query has to survive the ways people name a company:
//   AAPL · 7203 · 72030 · 0700 · 700 · 2330 · BRK.B · BRK-B · NASDAQ:AAPL · TSE:7203
//   Toyota · トヨタ · samsung · 삼성전자 · tsmc · tencent · nubank · petr4 · bank central asia
//
// The rank is deliberately simple: exact ticker/code first, then exact name or alias, then prefixes,
// then fuzzy. Market cap only breaks ties; it never lets a tiny company beat an exact match.

const SUFFIX = new Set(['the', 'a', 'an', 'of', 'and', 'inc', 'corp', 'corporation', 'co', 'ltd',
  'limited', 'plc', 'llc', 'group', 'holdings', 'holding', 'company', 'sa', 'nv', 'ag', 'se', 'spa']);

const EXCHANGE = /^(NASDAQ|NYSE|AMEX|ARCA|TSE|JPX|HKEX|SEHK|KRX|KOSPI|TWSE|TPE|ASX|NSE|BSE|IDX|B3|JSE)\s*[:.]\s*/i;

export const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase();

export const normalize = (s) => fold(s)
  .replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

export const normalizeCode = (s) => String(s || '').toUpperCase()
  .replace(EXCHANGE, '')
  .replace(/[^A-Z0-9]/g, '')
  .trim();

const numeric = (s) => /^\d{1,8}$/.test(s) ? String(Number(s)) : null;

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

export function query(q) {
  const raw = String(q || '').trim().slice(0, 80);
  const qn = normalize(raw);
  const qc = normalizeCode(raw);
  const qnum = numeric(qc);
  return { raw, norm: qn, code: qc, numeric: qnum, empty: !qn && !qc };
}

function entryCodes(e) {
  const out = new Set();
  for (const x of [e.ticker, e.code, e.id]) if (x != null) { const c = normalizeCode(x); if (c) out.add(c); }
  for (const l of e.listings || []) {
    for (const x of [l.ticker, l.code]) if (x != null) { const c = normalizeCode(x); if (c) out.add(c); }
  }
  return [...out];
}

function entryNames(e) {
  const out = new Set();
  for (const x of [e.name, e.nameEn, ...(e.aliases || [])]) {
    const n = normalize(x);
    if (n) out.add(n);
  }
  return [...out];
}

// Normalise the lookup fields once when the index loads; a keystroke must not re-normalise 10k rows.
export function prepareEntries(entries) {
  for (const e of entries) {
    if (!e._codes) e._codes = entryCodes(e);
    if (!e._names) e._names = entryNames(e);
  }
  return entries;
}

// 0 = no match. Returned values are only compared with other entries for the same query.
export function scoreEntry(e, q, fuzzy = true) {
  const qq = typeof q === 'string' ? query(q) : q;
  if (!qq || qq.empty) return 0;
  const codes = e._codes || entryCodes(e);
  const names = e._names || entryNames(e);
  let best = 0;
  let matchedOn = null;

  // Ticker / code. Exact, numeric-equal (700 = 0700), then prefix.
  for (const c of codes) {
    if (c === qq.code) { best = Math.max(best, 1200); matchedOn = 'ticker'; }
    else if (qq.numeric && numeric(c) === qq.numeric) { best = Math.max(best, 1150); matchedOn = 'ticker'; }
    else if (qq.code.length >= 2 && c.startsWith(qq.code)) { best = Math.max(best, 900); matchedOn = 'ticker'; }
  }

  // Name and aliases. Exact, then word-prefix, then substring.
  for (const n of names) {
    if (n === qq.norm) { best = Math.max(best, 1050); matchedOn = 'name'; }
    else if (qq.norm.length >= 2 && n.startsWith(qq.norm)) { best = Math.max(best, 850); matchedOn = matchedOn || 'name'; }
    else if (qq.norm.length >= 3 && n.split(' ').some((w) => w.startsWith(qq.norm))) { best = Math.max(best, 780); matchedOn = matchedOn || 'name'; }
    else if (qq.norm.length >= 3 && n.includes(qq.norm)) { best = Math.max(best, 620); matchedOn = matchedOn || 'name'; }
  }

  // Fuzzy only for real words, and only when the exact/prefix passes found nothing.
  if (!best && fuzzy && qq.norm.length >= 4) {
    let sim = 0;
    for (const n of names) sim = Math.max(sim, similarity(n, qq.norm));
    if (sim >= 0.62) { best = 220 + sim * 180; matchedOn = 'close'; }
  }

  if (!best) return 0;
  // A large company wins a tie, never an exact match. log10 makes the boost bounded.
  const cap = Number(e.capUsd) > 0 ? Math.log10(Number(e.capUsd) + 1) : 0;
  e._matchedOn = matchedOn;
  return best + Math.min(12, cap);
}

export function searchEntries(entries, q, { market = null, limit = 30 } = {}) {
  const qq = query(q);
  if (qq.empty || !Array.isArray(entries) || !entries.length) {
    return { q: qq.raw, total: 0, results: [], counts: {} };
  }
  let counts = {};
  let scored = [];
  for (const e of entries) {
    if (market && e.market !== market) continue;
    const s = scoreEntry(e, qq, false);
    if (!s) continue;
    counts[e.market] = (counts[e.market] || 0) + 1;
    scored.push({ e, s });
  }
  // A typo is the only reason to pay for edit distance. The normal exact/prefix path is a string
  // pass and stays fast; fuzzy runs only when that path found nothing at all.
  if (!scored.length && qq.norm.length >= 4) {
    counts = {};
    for (const e of entries) {
      if (market && e.market !== market) continue;
      const s = scoreEntry(e, qq, true);
      if (!s) continue;
      counts[e.market] = (counts[e.market] || 0) + 1;
      scored.push({ e, s });
    }
  }
  scored.sort((a, b) => b.s - a.s || (b.e.capUsd || 0) - (a.e.capUsd || 0));
  const results = scored.slice(0, Math.max(1, Math.min(50, Number(limit) || 30))).map(({ e }) => ({
    market: e.market, id: e.id, ticker: e.ticker, code: e.code, name: e.name, nameEn: e.nameEn,
    nameLocal: e.nameLocal || null, sector: e.sector, industry: e.industry, exchange: e.exchange, currency: e.currency,
    capLocal: e.capLocal, capUsd: e.capUsd, price: e.price, priceDate: e.priceDate, pe: e.pe,
    roe: e.roe, ytd: e.ytd, securityType: e.securityType, primary: e.primary, noFilings: e.noFilings,
    listings: e.listings || [], issuerKey: e.issuerKey,
    indexSymbol: e.indexSymbol, indexLabel: e.indexLabel,
    matchedOn: e._matchedOn || null,
  }));
  return { q: qq.raw, total: scored.length, results, counts };
}

export function groupByMarket(results, markets = {}) {
  const groups = new Map();
  for (const r of results) {
    if (!groups.has(r.market)) groups.set(r.market, []);
    groups.get(r.market).push(r);
  }
  return [...groups.entries()].map(([market, rows]) => ({
    market,
    label: markets[market]?.label || market,
    flag: markets[market]?.flag || '',
    count: rows.length,
    rows,
  }));
}

export { SUFFIX };
