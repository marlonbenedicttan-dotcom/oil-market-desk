// One-off QA: given a target company and the month a deal was announced, find the 8-K press release
// and print the sentence that states the value. Used to build the verified seed by hand.
//
//   node scripts/verify-deal.mjs "Activision Blizzard" 2022-01
import { writeFileSync } from 'node:fs';

const UA = process.env.SEC_UA || 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, json = false) {
  const wait = Math.max(0, 180 - (Date.now() - last));
  if (wait) await sleep(wait);
  last = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
  if (!res.ok) return null;
  return json ? res.json() : res.text();
}
const textOf = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

const [target, month] = process.argv.slice(2);
if (!target || !month) { console.error('usage: verify-deal.mjs "Target Name" YYYY-MM'); process.exit(1); }
const [y, m] = month.split('-').map(Number);
const startdt = `${y}-${String(m).padStart(2, '0')}-01`;
const enddt = `${y}-${String(m + 2 > 12 ? 12 : m + 2).padStart(2, '0')}-28`;
const q = `"${target}" "valued at"`;
const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=8-K&dateRange=custom&startdt=${startdt}&enddt=${enddt}`;
const j = await get(url, true);
const hits = j?.hits?.hits || [];
console.log(`${target} ${month}: ${hits.length} filings`);
for (const h of hits.slice(0, 4)) {
  const [acc, doc] = String(h._id).split(':');
  const cik = (h._source.ciks || [])[0];
  const nos = acc.replace(/-/g, '');
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${nos}`;
  const idx = await get(`${base}/index.json`, true);
  const ex = (idx?.directory?.item || []).filter((f) => /(?:^|[_-])(?:ex-?99|exhibit-?99)/i.test(f.name || '') || /^EX-99/i.test(f.type || ''));
  const pick = ex.find((f) => /99\.1/i.test(`${f.type} ${f.name}`)) || ex[0];
  if (!pick) continue;
  const body = textOf(await get(`${base}/${pick.name}`));
  if (!body) continue;
  const flat = body.replace(/\n/g, ' ');
  const money = [...flat.matchAll(/[^.]{0,160}\$\s?[\d.,]+\s?(?:billion|million)[^.]{0,80}/gi)]
    .map((x) => x[0].trim()).filter((s) => /valu|price|consideration|transaction|merger|acquire/i.test(s));
  const head = flat.slice(0, 220);
  const adv = ['Goldman Sachs','Morgan Stanley','J.P. Morgan','JPMorgan','Bank of America','Citigroup','Citi','Lazard','Evercore','Centerview Partners','Rothschild','Barclays','UBS','Deutsche Bank','Houlihan Lokey','Jefferies','Qatalyst Partners','PJT Partners','Moelis','Perella Weinberg','Allen & Company','BofA Securities','Wells Fargo']
    .filter((b) => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(flat)
      && new RegExp(`(.{0,80})\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(.{0,80})`, 'i').test(flat)
      && /advis|advisor|financial|acted as/i.test((flat.match(new RegExp(`(.{0,80})\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(.{0,80})`, 'i')) || []).slice(1).join(' ')));
  const rar = (flat.split(/(?<=[.!?])\s+/).find((x) => /synerg|strateg|complement|expand|accelerat|combine/i.test(x) && x.length < 320 && !/forward-looking|safe harbor/i.test(x)) || '').trim();
  console.log(JSON.stringify({ date: h._source.file_date, url: `${base}/${pick.name}`, headline: head.slice(0, 110).replace(/\s+/g, ' '), adv, rationale: rar.slice(0, 240), value: money[0] ? money[0].slice(0, 200) : null }, null, 1));
}
