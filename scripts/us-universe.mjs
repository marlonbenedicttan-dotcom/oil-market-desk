// The US company universe: the S&P 1500, from the ETF that tracks it.
//
// Membership comes from State Street's SPTM holdings (XLSX, updated daily) rather than a scraped
// list, so it is authoritative and the float-adjusted weights are the index's own numbers. SPTM is
// the composite of the S&P 500 + 400 + 600, so one file replaces the old SPY-only filter.
//
// Shared by `filter-us-universe.mjs`, `complete-us-universe.mjs` and `apply-weights.mjs` so the
// membership and the weights can never drift apart.
//
//   import { fetchHoldings, UNIVERSE } from './us-universe.mjs'

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';

export const UNIVERSE = {
  name: 'S&P 1500',
  etf: 'SPTM',
  source: 'SPDR Portfolio S&P 1500 Composite Stock Market ETF (SPTM) holdings (State Street)',
  url: 'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-sptm.xlsx',
  file: join(ROOT, 'data', '.sptm-holdings.xlsx'),
  index: '^SP1500',
};

// SPY/SPTM write class shares with a dot (BRK.B); the SEC and this dataset use a dash (BRK-B).
export const normalizeTicker = (t) => String(t || '').trim().toUpperCase().replace(/\./g, '-');

// The sheet is a real XLSX; parse it with Python's stdlib (zipfile + ElementTree), same as the old
// SPY filter — no dependency, and the column layout is stable across the SPDR fund files.
const PY = `
import zipfile, json, sys
from xml.etree import ElementTree as ET
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
z = zipfile.ZipFile(sys.argv[1])
shared = []
if 'xl/sharedStrings.xml' in z.namelist():
    root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in root.findall(NS + 'si'):
        shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))
sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
rows = []
for row in sheet.iter(NS + 'row'):
    vals = []
    for c in row.findall(NS + 'c'):
        v = c.find(NS + 'v')
        if v is None: vals.append(''); continue
        vals.append(shared[int(v.text)] if c.get('t') == 's' else v.text)
    rows.append(vals)
print(json.dumps(rows))
`;

const TICKER = /^[A-Z][A-Z.\-]{0,7}$/;

// The file carries cash, a money-market sweep, a futures overlay and contingent-value receipts.
// They are rows in the sheet, not index constituents. Cash/money-market/contra rows have no ticker
// ("-") so the ticker test drops them; the futures overlay has a real-looking ticker (ESZ6) and is
// dropped by name. Pathward Financial's ticker is literally "CASH", so never filter on ticker text.
function isCashOrFuture(name) {
  return /\b(FUT|FUTURES|EMINI)\b/i.test(String(name || ''));
}

export function parseHoldings(file) {
  const rows = JSON.parse(execFileSync('python3', ['-c', PY, file], { encoding: 'utf8', maxBuffer: 16 << 20 }));
  const head = rows.findIndex((r) => r[0] === 'Name' && r[1] === 'Ticker');
  if (head < 0) throw new Error('SPTM holdings header not found');
  const list = [];
  for (const r of rows.slice(head + 1)) {
    const raw = String(r[1] || '').trim().toUpperCase();
    const name = String(r[0] || '').trim();
    const weight = parseFloat(r[4]);
    if (!TICKER.test(raw)) continue;
    if (!Number.isFinite(weight)) continue;
    if (isCashOrFuture(name)) continue;
    list.push({ ticker: normalizeTicker(raw), name, weight });
  }
  // A restructured issuer can appear twice (Navient showed a "Holdings" line at 0.00082% and the
  // operating company at 0%). One ticker, one row: keep the line that actually carries weight.
  const unique = new Map();
  for (const m of list) {
    const prev = unique.get(m.ticker);
    if (!prev || Math.abs(m.weight) > Math.abs(prev.weight)) unique.set(m.ticker, m);
  }
  return [...unique.values()];
}

export async function fetchHoldingsAt(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('holdings ' + res.status);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return parseHoldings(file);
}

export async function fetchHoldings() {
  return fetchHoldingsAt(UNIVERSE.url, UNIVERSE.file);
}

export function indexMap(list) {
  return new Map(list.map((m) => [m.ticker, m]));
}

// SEC's ticker→CIK map. Membership is by ticker, but the frames build can pick a sibling class for a
// dual-class company (UA vs UAA, BRK-A vs BRK-B); the CIK is what keeps the filings attached.
export async function fetchSecTickers() {
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)' },
  });
  if (!res.ok) throw new Error('company_tickers ' + res.status);
  const j = await res.json();
  const out = new Map();
  for (const r of Object.values(j || {})) {
    if (r?.ticker && r?.cik_str != null) out.set(normalizeTicker(r.ticker), { cik: String(r.cik_str), title: r.title });
  }
  return out;
}

// Why an index member has no statements, stated on the page instead of leaving a blank table.
// Bank OZK and Preferred Bank file their annual report with the FDIC under the bank exemption, so
// EDGAR has no 10-K/XBRL for them at all; a 2026 spin-off may have a Form 10 but no 10-K yet.
export async function noFilingsReason(cik, sector) {
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, {
      headers: { 'User-Agent': process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const forms = new Set(j?.filings?.recent?.form || []);
    if ([...forms].some((f) => /^(10-K|20-F)/.test(f))) return 'annual report in EDGAR did not resolve into a usable frame';
    if ([...forms].some((f) => /^10-Q/.test(f))) return 'quarterly reports only — no annual report yet';
    if ([...forms].some((f) => /^(10-12|8-12)/.test(f))) return 'Form 10 filed — no 10-K yet';
    if (sector === 'Financials') return 'annual report filed with the FDIC, not EDGAR — no SEC XBRL';
    return 'no annual report in EDGAR yet';
  } catch {
    return 'no annual report in EDGAR yet';
  }
}
