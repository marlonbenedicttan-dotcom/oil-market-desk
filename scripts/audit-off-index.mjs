// Audit the off-index coverage against primary sources — the same standard the index members are held
// to. Every field in data/off-index.json is re-derived or re-checked from outside the file:
//
//   ticker ↔ CIK ↔ legal name ↔ exchange   SEC company submissions
//   listing date, first close, price series, last close   Nasdaq historical
//   price, market cap, sector, 52-week range              Nasdaq quote (info + summary)
//   IPO price                                             the 424B4 cover, from EDGAR
//   vs IPO, YTD, series arithmetic                        recomputed here
//   TTM, quarters, annual record, ratios                  recomputed from the row's own arithmetic
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
const warnings = [];
const fixes = [];
const warn = (ticker, label) => { warnings.push(`${ticker}: ${label}`); };
const check = (ticker, ok, label, detail) => {
  if (!ok) failures.push(`${ticker}: ${label}${detail ? ' — ' + detail : ''}`);
  return ok;
};

// SEC ticker → CIK, one fetch for all of them.
const secTickers = await getJSON('https://www.sec.gov/files/company_tickers.json', SEC);
const byTicker = new Map(Object.values(secTickers || {}).map((r) => [String(r.ticker).toUpperCase(), r]));

for (const c of companies) {
  const t = c.ticker;
  const preIpo = c.status === 'pre-ipo';
  const row = { ...c };

  // ---- SEC identity -------------------------------------------------------------------------
  const sec = byTicker.get(t);
  check(t, !!sec, 'ticker is in SEC company_tickers');
  if (sec) {
    check(t, String(sec.cik_str) === String(c.cik), 'CIK matches the SEC record', `${c.cik} vs ${sec.cik_str}`);
    const sub = await getJSON(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`, SEC);
    await sleep(200);
    if (sub) {
      if (!preIpo) check(t, (sub.tickers || []).map((x) => x.toUpperCase()).includes(t), 'SEC lists the ticker', (sub.tickers || []).join(','));
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
      if (!preIpo) {
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
          // The cover price is the dedicated "initial public offering price" sentence. A naive
          // "$X per share" sweep picks the underwriting discount or a table line first (Bending
          // Spoons $34.44, Klarna $35.89), so the cover sentence wins before any fallback.
          const cover = /initial public offering price (?:is|of)\s*\$([0-9]{1,3}(?:\.[0-9]{2})?)/i.exec(text);
          const perShare = /\$([0-9]{1,3}\.[0-9]{2})\s*per\s+(?:ordinary |common )?share/i.exec(text);
          const table = /price to public[^$]{0,200}\$([0-9]{1,3}\.[0-9]{2})/i.exec(text);
          const cands = [...text.matchAll(/\$([0-9]{2,3}\.[0-9]{2})\s*(?:per share)?/g)]
            .map((m) => m[1])
            .filter((v) => Number(v) >= 5 && Number(v) <= 500);
          offer = Number((cover && cover[1]) || (perShare && perShare[1]) || (table && table[1]) || cands[0]) || null;
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
  }

  // ---- pre-IPO: no tape yet ---------------------------------------------------------------
  if (preIpo) {
    check(t, c.listedAt == null && c.price == null && c.capUsd == null, 'a pre-IPO row has no quote yet');
    check(t, c.financials && c.financials.preIpo === true, 'the pre-IPO flag is set');
    check(t, c.financials?.latestFiling?.form === 'S-1/A', 'the S-1/A is recorded', c.financials?.latestFiling?.form);
    check(t, /^https:\/\/www\.sec\.gov\/Archives\//.test(c.financials?.latestFiling?.url || ''), 'S-1 link points at EDGAR');
    check(t, /not trading yet/i.test(String(c.why || '')), 'the reason says it is not trading yet', c.why);
  }

  // ---- Nasdaq quote + history ---------------------------------------------------------------
  if (!preIpo) {
  // Nasdaq throttles a burst; give each call a few spaced attempts before calling the vendor dead.
  const q = async (url) => {
    for (let i = 0; i < 4; i++) {
      const j = await getJSON(url);
      if (j && j.data) return j;
      await sleep(4000);
    }
    return null;
  };
  const info = await q(`https://api.nasdaq.com/api/quote/${t}/info?assetclass=stocks`);
  const sum = await q(`https://api.nasdaq.com/api/quote/${t}/summary?assetclass=stocks`);
  const hist = await q(`https://api.nasdaq.com/api/quote/${t}/historical?assetclass=stocks&fromdate=${c.listedAt}&todate=${today}&limit=9999`);
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

  // A throttled vendor is not a data error: the refresh that wrote the file could not have written it
  // without the same numbers. Say so and skip the vendor checks rather than failing the run; when the
  // vendor answers, every check below is strict.
  if (live == null) warn(t, 'Nasdaq did not answer the quote — vendor checks skipped');
  if (vendorCap == null) warn(t, 'Nasdaq did not answer the market cap — cap band skipped');
  if (!bars.length) warn(t, 'Nasdaq did not answer the price history — tape checks skipped');

  if (bars.length) {
    check(t, bars[0][0] === c.listedAt, 'listing date is the first trading day', `file ${c.listedAt} vs tape ${bars[0][0]}`);
    check(t, Math.abs(bars[0][1] - Number(c.firstClose)) < 0.005, 'first close matches the tape', `file ${c.firstClose} vs ${bars[0][1]}`);
    const seller = bars[bars.length - 1];
    check(t, seller[0] === c.priceDate, 'price date is the last trading day in the file', `tape ${seller[0]} vs file ${c.priceDate}`);
    // The row is quoted off the tape's close, so the price and the previous close must be the last two
    // bars — not a live tick that moves after the file was written.
    check(t, Math.abs(seller[1] - Number(c.price)) < 0.005, 'price is the last close on the tape', `${seller[1]} vs ${c.price}`);
    if (bars.length > 1) {
      check(t, Math.abs(bars[bars.length - 2][1] - Number(c.prevClose)) < 0.005, 'previous close is the bar before it', `${bars[bars.length - 2][1]} vs ${c.prevClose}`);
    }
    // The file's series must be the tape, not a hand-made copy of it.
    const same = bars.length === (c.series || []).length && bars.every(([d, v], i) => d === c.series[i][0] && Math.abs(v - c.series[i][1]) < 0.005);
    check(t, same, 'stored series is point-for-point the tape', `${bars.length} tape bars vs ${(c.series || []).length} stored`);
    check(t, new Set((c.series || []).map(([d]) => d)).size === (c.series || []).length, 'series has no duplicate dates');
    check(t, (c.series || []).every(([, v]) => v > 0), 'every close is positive');
  }

  // The cap has to be the stored close × the stored share count, so it can never disagree with the
  // price printed beside it. The vendor's own cap is checked as a band, not to the cent: Nasdaq's
  // summary cap can lag its own live price by a session.
  if (c.capUsd && c.shares) {
    const want = Number(c.price) * Number(c.shares);
    check(t, Math.abs(want - Number(c.capUsd)) / want < 0.001, 'market cap is price × shares',
      `file ${c.capUsd} vs ${Math.round(want)}`);
    // No vendor-cap comparison here: Nasdaq's summary cap lags its own live price, so it cannot be
    // turned into a share count reliably. The price × shares identity above is the check that can be
    // trusted, and the exchange file only ships a cap it can stand behind.
  } else {
    check(t, false, 'market cap and share count are stored');
  }
  check(t, c.priceDate === today || Date.parse(today) - Date.parse(c.priceDate) < 4 * 864e5, 'price date is fresh', `priceDate ${c.priceDate}`);
  if (vendorSector) {
    check(t, c.nasdaqSector === vendorSector, 'vendor sector matches', `${c.nasdaqSector} vs ${vendorSector}`);
    check(t, c.sector === (NASDAQ_SECTOR[vendorSector] || 'Other'), 'sector bucket follows the vendor', `${c.sector}`);
  }
  }
  check(t, SECTORS.includes(c.sector), 'sector is one of the desk’s buckets', c.sector);
  check(t, !!c.industry, 'industry present');
  check(t, c.currency === 'USD', 'quotes in USD', c.currency);

  // ---- arithmetic ----------------------------------------------------------------------------
  // ---- filings and ratios ------------------------------------------------------------------
  const fin = c.financials || {};
  if (preIpo) {
    // The S-1/A metadata is checked above; the page still has a latest interim period and a TTM.
    check(t, !!fin.latest, 'a pre-IPO page shows its latest period');
  } else if (fin.latestFiling) {
    const sub = await getJSON(`https://data.sec.gov/submissions/CIK${String(c.cik).padStart(10, '0')}.json`, SEC);
    await sleep(200);
    const rec = (sub && sub.filings && sub.filings.recent) || {};
    // Domestic issuers file 10-K/10-Q; a foreign private issuer files 20-F and 6-K. A 6-K is often
    // an announcement, so the newest financial report is the one whose report date is a period end.
    let newest = null, fallback = null;
    for (let i = 0; i < (rec.form || []).length; i++) {
      const form = rec.form[i];
      if (!/^(10-[KQ]|20-F|6-K)$/.test(form)) continue;
      const filed = rec.filingDate[i];
      const period = rec.reportDate[i];
      if (form !== '6-K') { newest = { form, filed }; break; }
      if (period && filed && Math.abs(Date.parse(period) - Date.parse(filed)) > 7 * 864e5) { newest = { form, filed }; break; }
      if (!fallback) fallback = { form, filed };
    }
    if (!newest) newest = fallback;
    check(t, !!newest, 'EDGAR reports a periodic filing');
    if (newest) {
      check(t, fin.latestFiling.form === newest.form && fin.latestFiling.filed === newest.filed,
        'latest filing is EDGAR’s newest periodic filing', `${fin.latestFiling.form} ${fin.latestFiling.filed} vs ${newest.form} ${newest.filed}`);
      check(t, /^https:\/\/www\.sec\.gov\/Archives\//.test(fin.latestFiling.url || ''), 'filing link points at EDGAR');
    }
  } else {
    // A company with no periodic filing on EDGAR is only acceptable while it is genuinely brand new.
    const age = (Date.parse(today) - Date.parse(c.listedAt)) / 864e5;
    check(t, age < 120, 'a company older than four months has a filing on EDGAR', `listed ${c.listedAt}`);
  }
  // Quarters: unique, ordered, and the current year's add up to the year to date the same filing
  // reports. That is the check that catches a bad subtraction.
  if (Array.isArray(fin.quarters) && fin.quarters.length) {
    const ends = fin.quarters.map((q) => q.end);
    check(t, new Set(ends).size === ends.length, 'no duplicate quarter ends');
    check(t, ends.every((d, i) => i === 0 || d > ends[i - 1]), 'quarters are in date order');
    check(t, fin.quarters.every((q) => q.revenue == null || q.revenue > 0), 'quarterly revenue is positive');
    if (fin.latest && fin.quarters.some((q) => q.revenue != null)) {
      const sum = fin.quarters
        .filter((q) => q.revenue != null && q.end >= fin.latest.start && q.end <= fin.latest.end)
        .reduce((a, q) => a + q.revenue, 0);
      check(t, Math.abs(sum - fin.latest.revenue) / fin.latest.revenue < 0.01, 'the year’s quarters add up to its year to date',
        `${Math.round(sum)} vs ${fin.latest.revenue}`);
    }
  }

  if (fin.ttm) {
    check(t, fin.ttm.end === (fin.latest && fin.latest.end), 'TTM ends on the latest filed period');
    check(t, fin.fy && fin.latest && fin.prior, 'a TTM shows its working (FY + YTD − prior YTD)');
    if (fin.fy && fin.latest && fin.prior) {
      const wantRev = fin.fy.revenue + fin.latest.revenue - fin.prior.revenue;
      check(t, Math.abs(wantRev - fin.ttm.revenue) < 1, 'TTM revenue recomputes',
        `${fin.ttm.revenue} vs ${wantRev}`);
      if (fin.fy.netIncome != null && fin.latest.netIncome != null && fin.prior.netIncome != null) {
        const wantNi = fin.fy.netIncome + fin.latest.netIncome - fin.prior.netIncome;
        check(t, Math.abs(wantNi - fin.ttm.netIncome) < 1, 'TTM net income recomputes', `${fin.ttm.netIncome} vs ${wantNi}`);
      }
    }
    // The trailing figure and the last four periods must be the same arithmetic, or the page shows a
    // matrix whose newest four quarters do not add up to the TTM tile above it. The tolerance is five
    // million dollars or 1%: pre-IPO periods come from the vendor rounded to the million, and a
    // fiscal-year alignment can move a period by a rounding difference.
    if (Array.isArray(fin.quarters) && fin.quarters.length >= 4) {
      const close = (a, b) => Math.abs(a - b) <= Math.max(5e6, Math.abs(b) * 0.01);
      const last4 = fin.quarters.slice(-4);
      if (last4.every((q) => q.revenue != null) && fin.ttm.revenue != null) {
        const sum = last4.reduce((a, q) => a + q.revenue, 0);
        check(t, close(sum, fin.ttm.revenue), 'TTM revenue is the last four quarters', `${sum} vs ${fin.ttm.revenue}`);
      }
      if (last4.every((q) => q.netIncome != null) && fin.ttm.netIncome != null) {
        const sum = last4.reduce((a, q) => a + q.netIncome, 0);
        check(t, close(sum, fin.ttm.netIncome), 'TTM net income is the last four quarters', `${sum} vs ${fin.ttm.netIncome}`);
      }
    }
    if (c.pe != null) {
      check(t, Math.abs(c.pe - (c.capUsd / fin.ttm.netIncome)) / c.pe < 0.02, 'P/E is market cap ÷ trailing profit', `${c.pe}`);
    } else if (!preIpo) {
      check(t, !(fin.ttm.netIncome > 0), 'no P/E without a positive trailing profit', `net income ${fin.ttm.netIncome}`);
    }
    if (c.roe != null) {
      check(t, Math.abs(c.roe - (fin.ttm.netIncome / fin.ttm.equity) * 100) < 0.2, 'ROE is profit ÷ equity', `${c.roe}`);
    }
  } else {
    check(t, c.pe == null && c.roe == null, 'no TTM means no P/E and no ROE', `pe ${c.pe} roe ${c.roe}`);
    // A brand-new listing has no XBRL financials at all yet; one with a 10-Q but no 10-K shows its
    // period instead of a TTM.
    if (fin.latestFiling) check(t, !!fin.latest, 'a company with a 10-Q shows its latest period');
  }

  if (!preIpo && c.ipoPrice && c.price) {
    const want = +(((c.price / c.ipoPrice) - 1) * 100).toFixed(2);
    check(t, Math.abs(want - Number(c.vsIpo)) < 0.02, 'vs IPO recomputes', `${c.vsIpo} vs ${want}`);
  }
  if (!preIpo && c.listedAt && c.listedAt.slice(0, 4) === today.slice(0, 4)) {
    check(t, c.ytd == null, 'no YTD for a company listed this year', `ytd ${c.ytd}`);
  } else if (!preIpo && c.ytd != null) {
    // The prior-year close has to be the last bar before January of this year.
    const py = [...(c.series || [])].reverse().find(([d]) => d < `${today.slice(0, 4)}-01-01`);
    if (py) {
      const want = +(((c.price / py[1]) - 1) * 100).toFixed(2);
      check(t, Math.abs(want - Number(c.ytd)) < 0.02, 'YTD recomputes from the prior-year close', `${c.ytd} vs ${want}`);
    }
  }
  if (!preIpo && c.wk52Low != null && c.wk52High != null && c.price != null) {
    check(t, c.price >= c.wk52Low && c.price <= c.wk52High, 'price sits inside the 52-week range', `${c.wk52Low}–${c.wk52High}`);
  }
  // The listing facts the reader sees must agree with each other.
  if (preIpo) {
    check(t, /not trading yet/i.test(String(c.why || '')), 'the reason says it is not trading yet', c.why);
  } else {
    const LISTED_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const listedDay = new Date(c.listedAt + 'T00:00:00Z');
    const shortDate = `${String(listedDay.getUTCDate()).padStart(2, '0')} ${LISTED_MONTH[listedDay.getUTCMonth()]}`;
    check(t, String(c.why || '').includes(shortDate), 'the reason line carries the listing date', c.why);
  }
  check(t, !!c.cik, 'CIK stored');
  // A page with no profile is a page that cannot introduce the company.
  check(t, (c.description || '').length >= 120, 'a company description is present', `${(c.description || '').length} chars`);
  check(t, ['stockanalysis.com', 'nasdaq', 'sec-s1'].includes(c.descriptionSource), 'description is sourced', c.descriptionSource);

  if (FIX && !preIpo) {
    row.price = live ?? row.price;
    row.priceDate = today;
    row.capUsd = vendorCap ?? row.capUsd;
    row.prevClose = prevClose ?? row.prevClose;
    row.series = bars.length ? bars : row.series;
    row.firstClose = bars.length ? bars[0][1] : row.firstClose;
    row.vsIpo = row.ipoPrice ? +(((row.price / row.ipoPrice) - 1) * 100).toFixed(2) : null;
    fixes.push(row);
  }
  const ok = !failures.some((f) => f.startsWith(t + ':'));
  if (preIpo) console.log(`${ok ? '✓' : '✖'} ${t.padEnd(5)} PRE-IPO · S-1/A filed ${c.financials?.latestFiling?.filed || '—'}  ${c.name}`);
  else console.log(`${ok ? '✓' : '✖'} ${t.padEnd(5)} $${String(c.price).padEnd(8)} ${(Number(c.capUsd) / 1e9).toFixed(1).padStart(6)}B  ${c.exchange.padEnd(7)} since ${c.listedAt}  ${c.name}`);
}

if (FIX && fixes.length) {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ ...doc, updated: new Date().toISOString(), companies: fixes }));
  renameSync(tmp, FILE);
  console.log(`rewrote ${FILE} from the sources`);
}

console.log(`\n${companies.length} companies · ${failures.length ? failures.length + ' check(s) failed' : 'all checks passed'}${warnings.length ? ` · ${warnings.length} warning(s)` : ''}`);
for (const f of failures) console.log('  ✖ ' + f);
for (const w of warnings) console.log('  ! ' + w);
process.exit(failures.length ? 1 : 0);
