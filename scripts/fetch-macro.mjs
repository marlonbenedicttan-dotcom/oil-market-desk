// Snapshot fetcher — pulls annual macro from the IMF World Economic Outlook (DataMapper)
// and writes data/macro.json for the app to serve.
//
// Why a snapshot: the IMF API is blocked from the deploy host (Render gets a 403 WAF), so we
// fetch it from CI (GitHub Actions) on a schedule and commit the result. The app then reads the
// file — decoupling "where we fetch" from "where we serve". Re-run: node scripts/fetch-macro.mjs
import fs from 'node:fs';

const IND = { debt: 'GGXWDG_NGDP', gdp: 'NGDP_RPCH', cpi: 'PCPIPCH', unemployment: 'LUR' };
// Our country id -> IMF DataMapper code (ISO3, except the euro-area aggregate = EURO).
const COUNTRIES = [
  ['us', 'USA'], ['ea', 'EURO'], ['de', 'DEU'], ['uk', 'GBR'], ['fr', 'FRA'],
  ['jp', 'JPN'], ['cn', 'CHN'], ['hk', 'HKG'], ['in', 'IND'], ['sg', 'SGP'],
  ['id', 'IDN'], ['th', 'THA'], ['my', 'MYS'], ['ph', 'PHL'], ['vn', 'VNM'],
  ['kr', 'KOR'], ['au', 'AUS'], ['tw', 'TWN'],
  // Added with the Gulf + Africa macro countries. Countries whose IMF series has gaps (the Gulf and
  // Kenya have no unemployment line) simply omit that field — the app falls back to World Bank.
  ['sa', 'SAU'], ['ae', 'ARE'], ['qa', 'QAT'],
  ['za', 'ZAF'], ['ng', 'NGA'], ['ke', 'KEN'],
  ['br', 'BRA'], ['ve', 'VEN'], ['mx', 'MEX'], ['ar', 'ARG'],   // Venezuela has no debt series and a stale unemployment line — both omitted
];

// Completed years only — never store an IMF projection as if it were data.
const MAX_YEAR = new Date().getUTCFullYear() - 1;
const round2 = (v) => +(+v).toFixed(2);
const latest = (s) => {
  const ys = Object.keys(s || {}).map(Number).filter((y) => y <= MAX_YEAR).sort((a, b) => a - b);
  const y = ys[ys.length - 1];
  return y ? { year: y, value: round2(s[y]) } : null;
};
const series = (s, fromYear) => Object.keys(s || {}).map(Number)
  .filter((y) => y >= fromYear && y <= MAX_YEAR).sort((a, b) => a - b)
  .map((y) => ({ year: y, value: round2(s[y]) }));

async function fetchIndicator(ind) {
  let lastErr;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(`https://www.imf.org/external/datamapper/api/v1/${ind}`, { headers: { 'User-Agent': 'Mozilla/5.0 (marlons-watchtower snapshot)' } });
      if (!r.ok) throw new Error(`${ind} -> HTTP ${r.status}`);
      const j = await r.json();
      const m = j.values?.[ind];
      if (!m || !Object.keys(m).length) throw new Error(`${ind} -> empty`);
      return m;
    } catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 1500 * (a + 1))); }
  }
  throw lastErr;
}

// The DataMapper answers 503 for one indicator now and then (seen on NGDP_RPCH and GGXWDG_NGDP in
// November 2026). One flaky series used to abort the whole snapshot and turn the daily run red even
// though the other three had arrived. Now a miss falls back to the series already committed in
// data/macro.json; only a total loss fails the run, which is the case worth an email.
const prev = (() => {
  try { return JSON.parse(fs.readFileSync('data/macro.json', 'utf8')); } catch { return null; }
})();

// Rebuild the raw {country: {year: value}} map an indicator would have returned, from the shape the file
// stores. A WEO vintage is annual, so the committed copy is enough to stand in for a bad afternoon.
function carriedMap(field) {
  const out = {};
  const pair = (p) => (p && p.year != null ? { [p.year]: p.value } : null);
  for (const [id, code] of COUNTRIES) {
    const e = prev?.countries?.[id];
    if (!e) continue;
    const s = field === 'debt' ? pair(e.debtToGdp)
      : field === 'unemployment' ? pair(e.unemployment)
        : field === 'gdp' ? Object.fromEntries((e.gdpGrowth || []).map((p) => [p.year, p.value]))
          : Object.fromEntries((e.cpi || []).map((p) => [p.year, p.value]));
    if (s && Object.keys(s).length) out[code] = s;
  }
  return out;
}

async function fetchAll() {
  const results = await Promise.all(Object.entries(IND).map(async ([field, ind]) => {
    try { return [field, await fetchIndicator(ind), false]; }
    catch (e) {
      const carry = carriedMap(field);
      if (!Object.keys(carry).length) throw e;
      console.warn(`warning: ${e.message} — carrying the committed ${field} series (${Object.keys(carry).length} countries)`);
      return [field, carry, true];
    }
  }));
  return {
    maps: Object.fromEntries(results.map(([field, map]) => [field, map])),
    carried: results.filter(([, , wasCarried]) => wasCarried).map(([field]) => field),
  };
}

const { maps, carried } = await fetchAll();
// Carrying every indicator means the DataMapper answered nothing at all: the file would ship as a
// perfectly unchanged copy of itself and nobody would know the feed had stopped. That is the one case
// worth failing the run (and sending the email).
if (carried.length === Object.keys(IND).length) {
  throw new Error('IMF DataMapper returned nothing for any indicator — every series would be carried');
}
const { debt, gdp, cpi, unemployment: unemp } = maps;
const countries = {};
for (const [id, code] of COUNTRIES) {
  const entry = {};
  if (debt[code]) entry.debtToGdp = latest(debt[code]);
  if (gdp[code]) entry.gdpGrowth = series(gdp[code], MAX_YEAR - 5);
  if (cpi[code]) { entry.inflation = latest(cpi[code]); entry.cpi = series(cpi[code], MAX_YEAR - 24); }
  if (unemp[code]) entry.unemployment = latest(unemp[code]);
  if (Object.keys(entry).length) countries[id] = entry;
}

// Which countries lag the latest completed year, per field. `latest()` walks back to the newest year the
// IMF has, so a country whose series stopped in 2018 would otherwise ship as if it were current. The app
// backfills some of these from the World Bank at request time, but the gap should be visible in the file
// (and in the freshness check) rather than living in someone's head.
const seriesYear = (s) => (s && s.length ? s[s.length - 1].year : null);
const gaps = {};
for (const [id, e] of Object.entries(countries)) {
  const lag = {};
  if (e.debtToGdp && e.debtToGdp.year < MAX_YEAR) lag.debtToGdp = e.debtToGdp.year;
  if (e.inflation && e.inflation.year < MAX_YEAR) lag.inflation = e.inflation.year;
  if (seriesYear(e.cpi) != null && seriesYear(e.cpi) < MAX_YEAR) lag.cpi = seriesYear(e.cpi);
  if (e.unemployment && e.unemployment.year < MAX_YEAR) lag.unemployment = e.unemployment.year;
  if (Object.keys(lag).length) gaps[id] = lag;
}

const payload = {
  source: 'IMF World Economic Outlook (DataMapper)',
  maxYear: MAX_YEAR,
  countries,
  gaps,
  // Only present when an indicator had to be carried, so a stale leg is visible in the file rather than
  // living in the CI log. It is deliberately outside the unchanged check: carrying adds no new numbers.
  ...(carried.length ? { carried } : {}),
};

// Write only when the numbers move. The IMF publishes a WEO vintage about twice a year, so nearly every
// run re-reads identical data. Rewriting the file anyway makes the timestamp the only diff — and each of
// those commits is a Render deploy for a field nobody reads. Compare the data and leave the file alone.
const unchanged = (() => {
  try {
    const before = JSON.parse(fs.readFileSync('data/macro.json', 'utf8'));
    // Compare the numbers only: `updated` is a write timestamp and `carried` describes how this run went,
    // so neither belongs in the "did anything move" test.
    const numbers = (p) => JSON.stringify({
      source: p.source, maxYear: p.maxYear, countries: p.countries, gaps: p.gaps ?? {},
    });
    return numbers(before) === numbers(payload);
  } catch { return false; }
})();

const n = Object.keys(countries).length;
if (unchanged) {
  console.log(`data/macro.json unchanged — ${n} countries, maxYear ${MAX_YEAR} (left as is)`);
} else {
  const out = { updated: new Date().toISOString(), ...payload };
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/macro.json', JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote data/macro.json — ${n} countries, maxYear ${MAX_YEAR}`);
  if (Object.keys(gaps).length) {
    console.log(`  lagging ${MAX_YEAR}: ${Object.entries(gaps)
      .map(([id, fields]) => `${id}(${Object.entries(fields).map(([f, y]) => `${f}=${y}`).join(' ')})`)
      .join(', ')}`);
  }
}
