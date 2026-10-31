// Every filter in the three company tables, checked against the payload the API actually sends.
//
// This exists because a filter that reads a field the list endpoint does not project silently matches
// nothing — Korea's CHEAP VS ITSELF looked broken for exactly that reason. A filter is only honest if
// (a) the field survives projection, (b) it is populated for most of the market, and (c) it returns a
// plausible number of companies. All three are asserted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectUs, projectKr, projectJp, FILTER_FIELDS } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const us = (read('companies.json').companies || []).filter((c) => !c.shareClass && c.ticker).map(projectUs);
const jp = (read('japan.json').companies || []).map(projectJp);
const kr = (read('korea.json').companies || []).map(projectKr);
const yld = (c) => (c.dividend && c.dividend.yield != null ? c.dividend.yield : null);

// The presets and selects, exactly as public/app.js defines them.
const PRESETS = {
  us: {
    'BUYBACK HEAVY': (c) => c.buybacks && c.marketCap && c.buybacks / c.marketCap > 0.03,
    QUALITY: (c) => (c.roic || 0) > 15 && (c.revenueCagr || 0) > 10,
    'HIGH YIELD': (c) => (c.dividendYield || 0) > 3,
  },
  jp: {
    'BELOW BOOK': (c) => c.pb != null && c.pb <= 0.8 && (c.roe || 0) >= 0 && (c.marketCap || 0) >= 20e9,
    'REGIONAL BANKS': (c) => c.sector === 'Banks' && (c.marketCap || 0) <= 300e9,
    'HIGH YIELD': (c) => (yld(c) || 0) >= 3.5,
    'CASH RICH': (c) => c.cash && c.marketCap && c.cash / c.marketCap >= 0.2,
    'CHEAP VS ITSELF': (c) => c.bands && c.bands.pe && c.bands.pe.percentile <= 20 && (c.roe || 0) >= 0,
  },
  kr: {
    'BELOW BOOK': (c) => c.pb != null && c.pb < 1,
    'HIGH ROE': (c) => (c.roe || 0) > 12,
    'CHEAP VS ITSELF': (c) => c.bands && c.bands.pe && c.bands.pe.percentile <= 20,
  },
};

const SELECTS = {
  us: {
    'SIZE $10B+': (c) => (c.marketCap || 0) >= 1e10,
    'P/E < 15': (c) => c.pe != null && c.pe < 15,
    'MARGIN > 10%': (c) => c.revenue && c.netIncome != null && (c.netIncome / c.revenue) * 100 > 10,
    'REV GROWTH > 10%': (c) => (c.revenueCagr || 0) > 10,
    Priced: (c) => !!c.marketCap,
    Verified: (c) => c.verification && c.verification.status,
  },
  jp: {
    'P/E < 10': (c) => c.pe != null && c.pe < 10,
    'ROE > 10%': (c) => c.roe != null && c.roe >= 10,
    'YIELD > 3%': (c) => yld(c) != null && yld(c) >= 3,
    'SECTOR = Banks': (c) => c.sector === 'Banks',
  },
  kr: {
    'P/E < 10': (c) => c.pe != null && c.pe < 10,
    'ROE > 10%': (c) => c.roe != null && c.roe >= 10,
    'SECTOR = Electronics': (c) => c.sector === 'Electronics',
  },
};

const MARKETS = { us, jp, kr };

test('every field the filter bars read survives the list projection', () => {
  for (const [market, rows] of Object.entries(MARKETS)) {
    const sample = rows[0] || {};
    for (const f of FILTER_FIELDS[market]) {
      assert.ok(f in sample, `${market}: filter field "${f}" is missing from the list projection`);
    }
  }
});

test('filter fields are populated, not shipped as permanent nulls', () => {
  const need = { us: { sector: 0.95, marketCap: 0.9, pe: 0.6 }, jp: { sector: 0.99, pe: 0.7, pb: 0.7, roe: 0.7, cash: 0.8 }, kr: { sector: 0.99, pe: 0.7, pb: 0.7, roe: 0.7 } };
  for (const [market, reqs] of Object.entries(need)) {
    for (const [f, share] of Object.entries(reqs)) {
      const have = MARKETS[market].filter((c) => c[f] != null).length / MARKETS[market].length;
      assert.ok(have >= share, `${market}.${f} populated for only ${(have * 100).toFixed(0)}% of companies`);
    }
  }
});

test('no preset is a dead filter', () => {
  for (const [market, presets] of Object.entries(PRESETS)) {
    for (const [label, fn] of Object.entries(presets)) {
      const n = MARKETS[market].filter(fn).length;
      assert.ok(n > 0, `${market} preset "${label}" matches nothing`);
      assert.ok(n < MARKETS[market].length, `${market} preset "${label}" matches everything, so it screens nothing`);
    }
  }
});

test('no select is a dead filter', () => {
  for (const [market, sels] of Object.entries(SELECTS)) {
    for (const [label, fn] of Object.entries(sels)) {
      const n = MARKETS[market].filter(fn).length;
      assert.ok(n > 0, `${market} filter "${label}" matches nothing`);
    }
  }
});

test('preset counts stay plausible as a share of the market', () => {
  // A screen that suddenly covers half the market is usually a units bug, not a discovery.
  for (const [market, presets] of Object.entries(PRESETS)) {
    for (const [label, fn] of Object.entries(presets)) {
      const share = MARKETS[market].filter(fn).length / MARKETS[market].length;
      assert.ok(share <= 0.75, `${market} preset "${label}" matches ${(share * 100).toFixed(0)}% of the market`);
    }
  }
});
