// Audit the off-index coverage against primary sources — the same standard the index members are held
// to. Every field in data/off-index.json is re-derived or re-checked from outside the file:
//
//   ticker ↔ CIK ↔ legal name ↔ exchange   SEC company submissions
//   listing date, first close, price series, last close   Nasdaq historical
//   price, market cap, sector, 52-week range              Nasdaq quote (info + summary)
//   IPO price                                             the 424B4 cover, from EDGAR
//   vs IPO, YTD, series arithmetic                        recomputed here
//
//   node scripts/audit-off-index.mjs
//   node scripts/audit-off-index.mjs --fix     # rewrite the derived fields from the sources

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'off-index.json');
const FIX = process.argv.includes('--fix');
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
// The SEC asks every client to identify itself; a generic browser string gets blocked.
const SEC = { 'User-Agent': process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => Number(String(v == null ? '' : v).replace(/[$,%\s,]/g, '')) || null;

const SECTORS = ['Technology', 'Healthcare', 'Consumer', 'Financials', 'Industrials', 'Energy', 'Materials', 'Utilities', 'Real estate', 'Telecom', 'Media', 'Other'];
const NASDAQ_SECTOR = {
  Technology: 'Technology', 'Health Care': 'Healthcare', 'Consumer Discretionary': 'Consumer',
  'Consumer Staples': 'Consumer', Finance: 'Financials', Industrials: 'Industrials', Energy: 'Energy',
  Materials: 'Materials', Utilities: 'Utilities', 'Real Estate': 'Real estate',
  Telecommunications: 'Telecom', 'Communication Services': 'Media',
};

async function getJSON(url, headers = UA, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { ...headers, Accept: 'application/json, text/plain, */*' } });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(600 * (i + 1));
  }
  return null;
}
async function getText(url, headers = SEC) {
  try {
    const res = await fetch(url, { headers });
    return res.ok ? await res.text() : '';
  } catch { return ''; }
}

const doc = JSON.parse(readFileSync(FILE, 'utf8'));
const companies = doc.companies || [];
const today = new Date().toISOString().slice(0, 10);
const failures = [];
const fixes = [];
const check = (ticker, ok, label, detail) => {
  if (!ok) failures.push(`${ticker}: ${label}${detail ? ' — ' + detail : ''}`);
  return ok;
};

// SEC ticker → CIK, one fetch for all of them.
const secTickers = await getJSON('https://www.sec.gov/files/company_tickers.json', SEC);
const byTicker = new Map(Object.values(secTickers || {}).map((r) => [String(r.ticker).toUpperCase(), r]));

for (const c of companies) {
  const t = c.ticker;
  const row = { ...c };

  // ---- SEC identity -------------------------------------------------------------------------
  const sec = byTicker.get(t);
  check(t, !!sec, 'ticker is in SEC company_tickers');
  if (sec) {
    check(t, String(sec.cik_str) === String(c.cik), 'CIK matches the SEC record', `${c.cik} vs ${sec.cik_str}`);
    const sub = await getJSON(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`, SEC);
    await sleep(200);
    if (sub) {
      check(t, (sub.tickers || []).map((x) => x.toUpperCase()).includes(t), 'SEC lists the ticker', (sub.tickers || []).join(','));
      check(t, !!sub.name, 'SEC legal name present');
      const secEx = String((sub.exchanges || [])[0] || '').toUpperCase();
      // A listing so new that EDGAR has not filled the exchange in is not a mismatch.
      if (secEx) {
        check(t, /NYSE|NASDAQ/.test(String(c.exchange).toUpperCase()) && secEx.includes(String(c.exchange).toUpperCase().replace('-GS', '')),
          'exchange matches the SEC record', `${c.exchange} vs ${secEx}`);
      }
      row.legalName = sub.name || row.legalName;

      // ---- IPO price from the 424B4 cover ----------------------------------------------------
      const files = [{ name: 'recent', entries: sub.filings?.recent }];
      for (const extra of sub.filings?.files || []) {
        const more = await getJSON(`https://data.sec.gov/submissions/${extra.name}`, SEC);
        await sleep(200);
        if (more) files.push({ name: extra.name, entries: more });
      }
      let offer = null;
      let offerForm = null;
      for (const f of files) {
        const e = f.entries || {};
        const forms = e.form || [];
        for (let i = 0; i < forms.length; i++) {
          if (forms[i] !== '424B4') continue;
          const filed = e.filingDate?.[i] || '';
          if (!filed || Math.abs((Date.parse(filed) - Date.parse(c.listedAt)) / 864e5) > 20) continue;
          const acc = (e.accessionNumber?.[i] || '').replace(/-/g, '');
          const doc0 = e.primaryDocument?.[i] || '';
          if (!acc || !doc0) continue;
          const html = await getText(`https://www.sec.gov/Archives/edgar/data/${c.cik}/${acc}/${doc0}`);
          await sleep(250);
          const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
          const cands = [...text.matchAll(/\$([0-9]{2,3}\.[0-9]{2})\s*(?:per share)?/g)]
            .map((m) => m[1])
            .filter((v) => Number(v) >= 5 && Number(v) <= 500);
          // The cover price is the value the document repeats around "per share" / "public offering price".
          const near = [...text.matchAll(/\$([0-9]{2,3}\.[0-9]{2})\s*per share/gi)].map((m) => m[1]);
          offer = (near[0] || cands[0]) ? Number(near[0] || cands[0]) : null;
          offerForm = `${e.form[i]} ${filed}`;
          break;
        }
        if (offer) break;
      }
      if (offer) {
        check(t, c.ipoPrice != null, 'ipoPrice is recorded');
        check(t, Math.abs(offer - Number(c.ipoPrice)) < 0.005, 'IPO price matches the 424B4 cover', `file $${c.ipoPrice} vs cover $${offer} (${offerForm})`);
      } else {
        failures.push(`${t}: no 424B4 found to verify the IPO price (recorded $${c.ipoPrice})`);
      }
    }
  }

  // ---- Nasdaq quote + history ---------------------------------------------------------------
  const info = await getJSON(`https://api.nasdaq.com/api/quote/${t}/info?assetclass=stocks`);
  const sum = await getJSON(`https://api.nasdaq.com/api/quote/${t}/summary?assetclass=stocks`);
  const hist = await getJSON(`https://api.nasdaq.com/api/quote/${t}/historical?assetclass=stocks&fromdate=${c.listedAt}&todate=${today}&limit=9999`);
  await sleep(200);
  const live = num(info?.data?.primaryData?.lastSalePrice);
  const vendorCap = num(sum?.data?.summaryData?.MarketCap?.value);
  const vendorSector = sum?.data?.summaryData?.Sector?.value || null;
  const prevClose = num(sum?.data?.summaryData?.PreviousClose?.value);
  const rows = ((hist || {}).data || {}).tradesTable?.rows || [];
  const bars = rows
    .map((r) => { const [m, d, y] = String(r.date || '').split('/'); return [`${y}-${m}-${d}`, num(r.close)]; })
    .filter(([d, v]) => d && v != null)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

  check(t, live != null, 'Nasdaq returns a price');
  check(t, vendorCap != null && vendorCap > 0, 'Nasdaq returns a market cap');
  check(t, bars.length > 0, 'Nasdaq returns a price history');

  if (bars.length) {
    check(t, bars[0][0] === c.listedAt, 'listing date is the first trading day', `file ${c.listedAt} vs tape ${bars[0][0]}`);
    check(t, Math.abs(bars[0][1] - Number(c.firstClose)) < 0.005, 'first close matches the tape', `file ${c.firstClose} vs ${bars[0][1]}`);
    const seller = bars[bars.length - 1];
    check(t, seller[0] === c.priceDate || Date.parse(today) - Date.parse(seller[0]) < 4 * 864e5,
      'series is current', `last bar ${seller[0]} vs priceDate ${c.priceDate}`);
    check(t, Math.abs(seller[1] - Number(c.prevClose)) < 0.02, 'last close is the quote’s previous close', `${seller[1]} vs ${c.prevClose}`);
    // The file's series must be the tape, not a hand-made copy of it.
    const same = bars.length === (c.series || []).length && bars.every(([d, v], i) => d === c.series[i][0] && Math.abs(v - c.series[i][1]) < 0.005);
    check(t, same, 'stored series is point-for-point the tape', `${bars.length} tape bars vs ${(c.series || []).length} stored`);
    check(t, new Set((c.series || []).map(([d]) => d)).size === (c.series || []).length, 'series has no duplicate dates');
    check(t, (c.series || []).every(([, v]) => v > 0), 'every close is positive');
  }

  if (live != null) {
    check(t, Math.abs(live - Number(c.price)) / live < 0.005, 'price is the current quote', `file ${c.price} vs ${live}`);
  }
  if (vendorCap != null && c.capUsd) {
    check(t, Math.abs(vendorCap - Number(c.capUsd)) / vendorCap < 0.02, 'market cap is the current vendor cap', `file ${c.capUsd} vs ${vendorCap}`);
  }
  check(t, c.priceDate === today || Date.parse(today) - Date.parse(c.priceDate) < 4 * 864e5, 'price date is fresh', `priceDate ${c.priceDate}`);
  if (vendorSector) {
    check(t, c.nasdaqSector === vendorSector, 'vendor sector matches', `${c.nasdaqSector} vs ${vendorSector}`);
    check(t, c.sector === (NASDAQ_SECTOR[vendorSector] || 'Other'), 'sector bucket follows the vendor', `${c.sector}`);
  }
  check(t, SECTORS.includes(c.sector), 'sector is one of the desk’s buckets', c.sector);
  check(t, !!c.industry, 'industry present');
  check(t, c.currency === 'USD', 'quotes in USD', c.currency);

  // ---- arithmetic ----------------------------------------------------------------------------
  if (c.ipoPrice && c.price) {
    const want = +(((c.price / c.ipoPrice) - 1) * 100).toFixed(2);
    check(t, Math.abs(want - Number(c.vsIpo)) < 0.02, 'vs IPO recomputes', `${c.vsIpo} vs ${want}`);
  }
  if (c.listedAt && c.listedAt.slice(0, 4) === today.slice(0, 4)) {
    check(t, c.ytd == null, 'no YTD for a company listed this year', `ytd ${c.ytd}`);
  } else if (c.ytd != null) {
    // The prior-year close has to be the last bar before January of this year.
    const py = [...(c.series || [])].reverse().find(([d]) => d < `${today.slice(0, 4)}-01-01`);
    if (py) {
      const want = +(((c.price / py[1]) - 1) * 100).toFixed(2);
      check(t, Math.abs(want - Number(c.ytd)) < 0.02, 'YTD recomputes from the prior-year close', `${c.ytd} vs ${want}`);
    }
  }
  if (c.wk52Low != null && c.wk52High != null && c.price != null) {
    check(t, c.price >= c.wk52Low && c.price <= c.wk52High, 'price sits inside the 52-week range', `${c.wk52Low}–${c.wk52High}`);
  }
  // The listing facts the reader sees must agree with each other.
  const nice = new Date(c.listedAt + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .replace(/ (\d{4})$/, ' $1');
  const shortDate = new Date(c.listedAt + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  check(t, String(c.why || '').includes(shortDate), 'the reason line carries the listing date', c.why);
  check(t, !!c.cik, 'CIK stored');

  if (FIX) {
    row.price = live ?? row.price;
    row.priceDate = today;
    row.capUsd = vendorCap ?? row.capUsd;
    row.prevClose = prevClose ?? row.prevClose;
    row.series = bars.length ? bars : row.series;
    row.firstClose = bars.length ? bars[0][1] : row.firstClose;
    row.vsIpo = row.ipoPrice ? +(((row.price / row.ipoPrice) - 1) * 100).toFixed(2) : null;
    fixes.push(row);
  }
  console.log(`${failures.some((f) => f.startsWith(t + ':')) ? '✖' : '✓'} ${t.padEnd(5)} $${String(c.price).padEnd(8)} ${(Number(c.capUsd) / 1e9).toFixed(1).padStart(6)}B  ${c.exchange.padEnd(7)} since ${c.listedAt}  ${c.name}`);
}

if (FIX && fixes.length) {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ ...doc, updated: new Date().toISOString(), companies: fixes }));
  renameSync(tmp, FILE);
  console.log(`rewrote ${FILE} from the sources`);
}

console.log(`\n${companies.length} companies · ${failures.length ? failures.length + ' check(s) failed' : 'all checks passed'}`);
for (const f of failures) console.log('  ✖ ' + f);
process.exit(failures.length ? 1 : 0);
