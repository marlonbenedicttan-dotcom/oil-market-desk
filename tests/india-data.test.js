import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTER_FIELDS } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const ind = read('india.json');
const list = read('india-list.json');

test('the NIFTY 500 build has a real universe', () => {
  assert.ok(ind.companies.length > 300, `only ${ind.companies.length} companies`);
  assert.equal(ind.currency, 'INR');
  assert.ok(ind.fx && ind.fx.rate > 50 && ind.fx.rate < 200, `USD/INR ${ind.fx && ind.fx.rate}`);
});

test('market cap is price × shares', () => {
  for (const c of ind.companies) {
    const shares = c.sharesCurrent > 0 ? c.sharesCurrent : c.shares;
    if (!(c.price > 0) || !(shares > 0)) continue;
    const want = c.price * shares;
    assert.ok(Math.abs(c.marketCap / want - 1) < 0.02, `${c.code}: cap ${c.marketCap} vs ${want}`);
  }
});

test('every published ratio reproduces from its own inputs, or is absent', () => {
  // Infosys and HCL Tech file in USD on the NSE page, so the rupee cap must be converted before it is
  // divided by their profit — the same cross the build uses.
  const rates = (ind.fx && ind.fx.rates) || {};
  const capReport = (c) => {
    if (!c.reportCurrency || c.reportCurrency === 'INR') return c.marketCap;
    if (!rates.INR || !rates[c.reportCurrency]) return null;
    return c.marketCap * (rates[c.reportCurrency] / rates.INR);
  };
  let checked = 0;
  for (const c of ind.companies) {
    const cap = capReport(c);
    const ni = c.netIncomeTTM;
    if (c.pe != null && cap != null) {
      checked++;
      assert.ok(ni > 0, `${c.code}: a P/E on a loss`);
      assert.ok(Math.abs(c.pe - cap / ni) / (cap / ni) < 0.03, `${c.code}: P/E ${c.pe} vs ${(cap / ni).toFixed(2)}`);
    }
    const eq = c.reports && c.reports.latest && (c.reports.latest.equityCommon ?? c.reports.latest.equity);
    if (c.pb != null && cap != null) {
      assert.ok(eq > 0, `${c.code}: P/B on negative equity`);
      assert.ok(Math.abs(c.pb - cap / eq) / (cap / eq) < 0.03, `${c.code}: P/B ${c.pb}`);
    }
  }
  assert.ok(checked > 300, `only ${checked} P/Es were checked`);
});

test('a bank ships no operating margin and no free cash flow', () => {
  for (const c of ind.companies) {
    if (c.bankLike) assert.equal(c.opMargin, null, `${c.code} is bank-like with an op margin`);
    if (c.financial) {
      assert.equal(c.fcf, null, `${c.code} is a financial with free cash flow`);
      assert.equal(c.fcfYield, null, `${c.code} is a financial with an FCF yield`);
    }
  }
});

test('the market totals are the sum of the constituents', () => {
  const total = ind.companies.reduce((a, c) => a + (c.marketCap || 0), 0);
  assert.ok(Math.abs(total - ind.market.totalCap) / total < 0.001);
  const sectorCount = (ind.market.sectors || []).reduce((a, s) => a + s.count, 0);
  assert.equal(sectorCount, ind.companies.length);
});

test('the index is dated, ordered and positive', () => {
  const s = ind.index.series || [];
  assert.ok(s.length > 100, `index has ${s.length} points`);
  assert.ok(s.every((p) => p.c > 0));
  for (let i = 1; i < s.length; i++) assert.ok(s[i].d > s[i - 1].d);
  assert.match(ind.index.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('the list projection carries the fields the India filters read', () => {
  const fields = FILTER_FIELDS.in;
  assert.ok(Array.isArray(fields) && fields.length);
  const sample = list.companies[0];
  for (const f of fields) assert.ok(f in sample, `projection is missing ${f}`);
  assert.equal(list.companies.length, ind.companies.length);
});

test('every company has a sector and a report currency', () => {
  for (const c of ind.companies) {
    assert.ok(c.sector && c.sector !== 'Other' || c.sectorSource === 'other', `${c.code} has no sector`);
    assert.ok(c.reportCurrency, `${c.code} has no report currency`);
  }
});
