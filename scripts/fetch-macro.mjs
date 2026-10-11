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

const [debt, gdp, cpi, unemp] = await Promise.all(Object.values(IND).map(fetchIndicator));
const countries = {};
for (const [id, code] of COUNTRIES) {
  const entry = {};
  if (debt[code]) entry.debtToGdp = latest(debt[code]);
  if (gdp[code]) entry.gdpGrowth = series(gdp[code], MAX_YEAR - 5);
  if (cpi[code]) { entry.inflation = latest(cpi[code]); entry.cpi = series(cpi[code], MAX_YEAR - 24); }
  if (unemp[code]) entry.unemployment = latest(unemp[code]);
  if (Object.keys(entry).length) countries[id] = entry;
}

const out = { updated: new Date().toISOString(), source: 'IMF World Economic Outlook (DataMapper)', maxYear: MAX_YEAR, countries };
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/macro.json', JSON.stringify(out, null, 1) + '\n');
console.log(`wrote data/macro.json — ${Object.keys(countries).length} countries, maxYear ${MAX_YEAR}`);
