// Apply SPY index weights from the fund's own holdings file.
//
// The weights are what make the list sortable by "share of the index" and what caught SKYD's mismatch.
// They used to be applied once during the universe filter and were lost whenever a later pass rebuilt
// the file — VYLR ended up with none.
//
//   node scripts/apply-weights.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');
const XLSX = join(ROOT, 'data', '.spy-holdings.xlsx');

// Parse the sheet with the system Python (stdlib zipfile + ElementTree); no dependency needed.
const py = `
import zipfile, json, sys
import xml.etree.ElementTree as ET
NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
z=zipfile.ZipFile(sys.argv[1])
ss=[]
if 'xl/sharedStrings.xml' in z.namelist():
    root=ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in root.findall(f'{NS}si'):
        ss.append(''.join(t.text or '' for t in si.iter(f'{NS}t')))
sheet=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
out={}
for r in sheet.find(f'{NS}sheetData').findall(f'{NS}row'):
    vals=[]
    for c in r.findall(f'{NS}c'):
        v=c.find(f'{NS}v')
        vals.append(ss[int(v.text)] if c.get('t')=='s' and v is not None else (v.text if v is not None else ''))
    if len(vals) >= 5 and vals[1] and vals[4]:
        try: out[vals[1].strip().upper()] = float(vals[4])
        except ValueError: pass
print(json.dumps(out))
`;

let weights = {};
try {
  weights = JSON.parse(execFileSync('python3', ['-c', py, XLSX], { encoding: 'utf8' }));
} catch (e) {
  console.log('could not read the holdings file:', e.message);
  process.exit(1);
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let set = 0;
let missing = [];
for (const c of data.companies) {
  // SPY writes class shares with a dot (BRK.B); our tickers use a dash (BRK-B).
  const t = String(c.ticker || '').toUpperCase();
  const w = weights[t] ?? weights[t.replace('-', '.')] ?? weights[t.replace('.', '-')];
  if (w == null) { missing.push(c.ticker); continue; }
  if (c.indexWeight !== w) { c.indexWeight = w; set++; }
}

const sum = data.companies.reduce((a, c) => a + (c.indexWeight || 0), 0);
console.log(`weights applied: ${set} updated · ${data.companies.length - missing.length}/${data.companies.length} matched · sum ${sum.toFixed(3)}%`);
if (missing.length) console.log('not in the holdings file:', missing.join(' '));

data.updated = new Date().toISOString();
writeFileSync(FILE + '.tmp', JSON.stringify(data));
renameSync(FILE + '.tmp', FILE);
console.log('written');
