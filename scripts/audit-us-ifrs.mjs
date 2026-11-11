// IFRS/20-F pilot: prove the foreign-private-issuer path before adding a new universe to the site.
//
// The US dataset is US-GAAP frames. This scans a representative ADR set, confirms 20-F/40-F filings,
// and extracts the IFRS tags the site would need. It writes data/us-ifrs-pilot.json; it does not mix
// these companies into the verified US-GAAP universe.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const TICKERS = ['SAP','SHEL','AZN','NVS','UL','DEO','BP','HSBC','RY','TD','BNS','CNI','CP','SHOP','TM','HMC','MUFG','SONY','RIO','BHP','VOD','NGG','PUK','HDB','INFY','TSM','ASML','STLA'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 403) { await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) { await sleep(800 * (i + 1)); continue; }
      return res.json();
    } catch { await sleep(800 * (i + 1)); }
  }
  return null;
}
const tickers = await get('https://www.sec.gov/files/company_tickers_exchange.json');
const byTicker = Object.fromEntries((tickers?.data || []).filter((r) => r[2] && r[3]).map((r) => [r[2], { cik: r[0], name: r[1], exchange: r[3] }]));
const out = [];
for (const ticker of TICKERS) {
  const t = byTicker[ticker];
  if (!t) { out.push({ ticker, status: 'no-sec-ticker' }); continue; }
  const subs = await get(`https://data.sec.gov/submissions/CIK${String(t.cik).padStart(10, '0')}.json`);
  const r = subs?.filings?.recent;
  if (!r) { out.push({ ticker, status: 'no-submissions' }); continue; }
  let latest = null;
  for (let i = 0; i < (r.form || []).length; i++) {
    if (!/^(20-F|40-F)/.test(r.form[i])) continue;
    if (!latest || r.filingDate[i] > latest.date) latest = { form: r.form[i], date: r.filingDate[i], period: r.reportDate[i], acc: r.accessionNumber[i] };
  }
  if (!latest) { out.push({ ticker, status: 'not-20F/40F' }); continue; }
  const facts = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(t.cik).padStart(10, '0')}.json`);
  const g = facts?.facts?.['ifrs-full'] || {};
  const latestInstant = (tag) => {
    const rows = (g[tag]?.units?.USD || g[tag]?.units?.EUR || g[tag]?.units?.GBP || []).filter((e) => !e.start && e.end);
    rows.sort((a, b) => a.end.localeCompare(b.end));
    return rows.at(-1) || null;
  };
  const annual = (tag) => {
    const rows = (g[tag]?.units?.USD || g[tag]?.units?.EUR || g[tag]?.units?.GBP || []).filter((e) => e.start && e.end && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300);
    rows.sort((a, b) => a.end.localeCompare(b.end));
    return rows.at(-1) || null;
  };
  const revenue = annual('Revenue') || annual('RevenueFromContractsWithCustomers');
  const profit = annual('ProfitLoss') || annual('ProfitLossAttributableToOwnersOfParent');
  const assets = latestInstant('Assets');
  const equity = latestInstant('Equity') || latestInstant('EquityAttributableToOwnersOfParent');
  out.push({ ticker, name: t.name, exchange: t.exchange, cik: t.cik, filing: latest, tags: { revenue: revenue?.val ?? null, profit: profit?.val ?? null, assets: assets?.val ?? null, equity: equity?.val ?? null }, currency: revenue ? Object.keys(g.Revenue.units)[0] : null, status: 'ifrs' });
  await sleep(180);
}
const report = { generated: new Date().toISOString(), note: 'IFRS pilot only; not merged into the verified US-GAAP universe.', companies: out, ifrs: out.filter((x) => x.status === 'ifrs').length, scanned: out.length };
writeFileSync(join(ROOT, 'data', 'us-ifrs-pilot.json'), JSON.stringify(report, null, 1));
console.log(`IFRS pilot: ${report.ifrs}/${report.scanned} with 20-F/40-F + IFRS facts`);
for (const c of out.filter((x) => x.status === 'ifrs')) console.log(`  ${c.ticker} ${c.filing.form} ${c.filing.period} · revenue ${c.tags.revenue ?? '—'} · profit ${c.tags.profit ?? '—'}`);
