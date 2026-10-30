// Attach a description to every Japanese company.
//
// Curated entries come from data/japan-descriptions.json — what the company actually does, and the
// brands that hide behind the corporate name. Everything else gets a generated line built from the
// filing data, labelled as such so nobody mistakes it for a written profile.
//
//   node scripts/attach-japan-descriptions.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'japan.json');
const DESC = join(ROOT, 'data', 'japan-descriptions.json');

const yen = (v) => {
  if (v == null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a >= 1e12) return `¥${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `¥${(v / 1e9).toFixed(1)}B`;
  return `¥${Math.round(v / 1e6)}M`;
};

// What a company in this exchange sector is, in one noun phrase. Deliberately plain: the generated
// line should never pretend to know more than the sector and the numbers.
const SECTOR_PHRASE = {
  'Fishery, Agriculture & Forestry': 'fishery and agriculture company',
  Mining: 'oil, gas and mining company',
  Construction: 'construction and civil engineering company',
  Foods: 'food and beverage company',
  'Textiles & Apparels': 'textile and apparel company',
  'Pulp & Paper': 'paper and packaging company',
  Chemicals: 'chemicals and materials company',
  Pharmaceutical: 'pharmaceutical company',
  'Oil & Coal Products': 'oil refining and fuel company',
  'Rubber Products': 'rubber products company',
  'Glass & Ceramics': 'glass and ceramics company',
  'Iron & Steel': 'steelmaker',
  'Nonferrous Metals': 'non-ferrous metals producer',
  'Metal Products': 'metal products company',
  Machinery: 'machinery maker',
  'Electric Appliances': 'electronics and electrical equipment maker',
  'Transportation Equipment': 'transport equipment maker',
  'Precision Instruments': 'precision equipment maker',
  'Other Products': 'manufacturer',
  'Electric Power & Gas': 'electric and gas utility',
  'Land Transportation': 'rail and road transport operator',
  'Marine Transportation': 'shipping company',
  'Air Transportation': 'airline',
  'Warehousing & Transport': 'logistics operator',
  'Information & Communication': 'telecom and IT company',
  'Wholesale Trade': 'wholesale and trading company',
  'Retail Trade': 'retailer',
  Banks: 'bank',
  'Securities & Commodity Futures': 'securities and brokerage firm',
  Insurance: 'insurer',
  'Other Financials': 'financial services company',
  'Real Estate': 'property company',
  Services: 'services company',
};

// The long tail has no written profile, so the line is built from what the filings actually say:
// size, scale, the five-year revenue path, how often it made money, and what it pays out.
function generated(c, peers) {
  const phrase = SECTOR_PHRASE[c.sector] || 'listed company';
  const size = (c.marketCap || 0) >= 1e12 ? 'large-cap' : (c.marketCap || 0) >= 2e11 ? 'mid-cap' : 'small-cap';
  const h = (c.history || []).filter((x) => x.s);
  const bits = [`${c.name} is a ${size} ${phrase} on the TSE Prime market`];
  const sales = yen(c.sales);
  if (sales) bits.push(`with ${sales} of sales`);
  if (c.opMargin != null) {
    bits.push(`and a ${c.opMargin.toFixed(1)}% ${c.marginBasis === 'ordinary' ? 'ordinary' : 'operating'} margin`);
  }
  let line = `${bits.join(' ')}.`;

  if (h.length >= 3) {
    const first = h[0], last = h[h.length - 1];
    if (first.s && last.s) {
      const chg = ((last.s / first.s) - 1) * 100;
      line += ` Sales went from ${yen(first.s)} to ${yen(last.s)} over ${h.length} years (${chg >= 0 ? '+' : ''}${chg.toFixed(0)}%).`;
    }
    const profitable = h.filter((x) => x.n != null && x.n > 0).length;
    line += ` Profitable in ${profitable} of the last ${h.length} years.`;
  }

  if (peers > 1) line += ` One of ${peers} companies in the ${c.sector} sector.`;
  if (c.dividend && c.dividend.yield != null) line += ` Pays a ${c.dividend.yield.toFixed(1)}% dividend.`;
  return line;
}

const jp = JSON.parse(readFileSync(FILE, 'utf8'));
const book = JSON.parse(readFileSync(DESC, 'utf8'));
const entries = book.entries || {};
const counts = new Map();
for (const c of jp.companies) counts.set(c.sector, (counts.get(c.sector) || 0) + 1);

let curated = 0;
for (const c of jp.companies) {
  const e = entries[c.code];
  if (e && e.d) {
    c.description = e.d;
    c.brands = e.b || [];
    c.descSource = 'curated';
    c.descReviewed = book.updated;
    curated++;
  } else {
    c.description = generated(c, counts.get(c.sector) || 0);
    c.brands = [];
    c.descSource = 'generated';
  }
}

writeFileSync(FILE + '.tmp', JSON.stringify(jp));
renameSync(FILE + '.tmp', FILE);
console.log(`${curated} curated · ${jp.companies.length - curated} generated · ${jp.companies.length} total`);
const missing = jp.companies.filter((c) => !c.description).length;
console.log(`without any description: ${missing}`);
