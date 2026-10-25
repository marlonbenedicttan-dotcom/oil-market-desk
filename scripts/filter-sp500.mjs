// Restrict the company dataset to the S&P 500, using the ETF's own published holdings file.
//
// The constituent list comes from State Street's SPY holdings (XLSX, updated daily) rather than a
// scraped list, so membership is authoritative. Everything else in the dataset is filtered out.
//
//   node scripts/filter-sp500.mjs --dry
//   node scripts/filter-sp500.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const XLSX = join(ROOT, 'data', '.spy-holdings.xlsx');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';

async function holdings() {
  const url = 'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('holdings ' + res.status);
  writeFileSync(XLSX, Buffer.from(await res.arrayBuffer()));
  // Parse the XLSX with Python's stdlib (zipfile + ElementTree) — no dependency, no shell parser.
  const py = `
import zipfile, json
from xml.etree import ElementTree as ET
z = zipfile.ZipFile(${JSON.stringify(XLSX)})
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
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
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 8 << 20 });
  const rows = JSON.parse(out);
  const head = rows.findIndex((r) => r[0] === 'Name' && r[1] === 'Ticker');
  if (head < 0) throw new Error('holdings header not found');
  const list = [];
  for (const r of rows.slice(head + 1)) {
    const ticker = String(r[1] || '').trim().toUpperCase();
    const name = String(r[0] || '').trim();
    const weight = parseFloat(r[4]);
    if (!/^[A-Z][A-Z.\-]{0,7}$/.test(ticker)) continue;
    if (!Number.isFinite(weight)) continue;
    list.push({ ticker: ticker.replace(/\./g, '-'), name, weight });
  }
  return list;
}

const members = await holdings();
const set = new Map(members.map((m) => [m.ticker, m]));
console.log(`${members.length} S&P 500 constituents from SPY holdings`);

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const before = data.companies.length;
const kept = [];
const missing = [];
for (const m of members) {
  const c = data.companies.find((x) => x.ticker === m.ticker);
  if (c) { c.indexWeight = m.weight; c.indexName = m.name; kept.push(c); }
  else missing.push(m.ticker);
}
data.companies = kept;
data.universe = { name: 'S&P 500', source: 'SPDR S&P 500 ETF Trust holdings (State Street)', asOf: new Date().toISOString().slice(0, 10), members: members.length };
data.updated = new Date().toISOString();
console.log(`companies ${before} → ${kept.length} · missing from our XBRL set: ${missing.length}`);
if (missing.length) console.log('  missing:', missing.slice(0, 20).join(', '));
if (!DRY) { writeFileSync(FILE + '.tmp', JSON.stringify(data)); renameSync(FILE + '.tmp', FILE); console.log('written'); }
