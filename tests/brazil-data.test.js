import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTER_FIELDS } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
const br = read('brazil.json');
const list = read('brazil-list.json');
const snap = read('brazil-universe.json');

test('the B3 build has a real universe', () => {
  assert.ok(br.companies.length > 200, `only ${br.companies.length} companies`);
  assert.equal(br.currency, 'BRL');
  assert.ok(br.fx && br.fx.rate > 3 && br.fx.rate < 10, `USD/BRL ${br.fx && br.fx.rate}`);
  assert.equal(br.indexName, 'Ibovespa');
});

test('no BDRs, funds or duplicate issuer classes', () => {
  const bases = new Set();
  for (const c of br.companies) {
    assert.match(c.code, /^[A-Z0-9]{4,7}$/, c.code);
    assert.ok(!/3[1-9]$/.test(c.code), `${c.code} is a BDR`);
    assert.ok(!/\b(fundo|fii|fiagro|fidc|etf)\b/i.test(c.name || ''), `${c.code} is a fund`);
    const b = c.code.replace(/\d{1,2}B?$/, '');
    assert.ok(!bases.has(b), `${c.code}: duplicate issuer base ${b}`);
    bases.add(b);
  }
});

test('the cap is the vendor company total, not price × class shares', () => {
  let checked = 0;
  for (const c of br.companies) {
    if (!(c.vendorCap > 0) || !(c.marketCap > 0)) continue;
    checked++;
    assert.ok(Math.abs(c.marketCap / c.vendorCap - 1) < 0.02, `${c.code}: ${c.marketCap} vs ${c.vendorCap}`);
  }
  assert.ok(checked > 200, `only ${checked} caps compared`);
});

test('every published ratio reproduces from its own inputs', () => {
  const rates = (br.fx && br.fx.rates) || {};
  const capReport = (c) => {
    if (!c.reportCurrency || c.reportCurrency === 'BRL') return c.marketCap;
    if (!rates.BRL || !rates[c.reportCurrency]) return null;
    return c.marketCap * (rates[c.reportCurrency] / rates.BRL);
  };
  let checked = 0;
  for (const c of br.companies) {
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
      const want = cap / eq;
      // P/B is published to two decimals; allow half a cent of rounding on top of the 3% tolerance.
      assert.ok(Math.abs(c.pb - want) <= 0.005 + Math.abs(want) * 0.03, `${c.code}: P/B ${c.pb} vs ${want.toFixed(4)}`);
    }
  }
  assert.ok(checked > 150, `only ${checked} P/Es checked`);
});

test('a bank ships no operating margin and no free cash flow', () => {
  for (const c of br.companies) {
    if (c.bankLike) assert.equal(c.opMargin, null, `${c.code} is bank-like with an op margin`);
    if (c.financial) {
      assert.equal(c.fcf, null, `${c.code} is a financial with free cash flow`);
      assert.equal(c.fcfYield, null, `${c.code} is a financial with an FCF yield`);
    }
  }
});

test('market totals are the sum of the constituents', () => {
  const total = br.companies.reduce((a, c) => a + (c.marketCap || 0), 0);
  assert.ok(Math.abs(total - br.market.totalCap) / total < 0.001);
  const sectorCount = (br.market.sectors || []).reduce((a, s) => a + s.count, 0);
  assert.equal(sectorCount, br.companies.length);
  assert.ok((br.market.sectors || []).length >= 8, `only ${(br.market.sectors || []).length} sectors`);
});

test('the index is dated, ordered and positive', () => {
  const s = br.index.series || [];
  assert.ok(s.length > 100, `index has ${s.length} points`);
  assert.ok(s.every((p) => p.c > 0));
  for (let i = 1; i < s.length; i++) assert.ok(s[i].d > s[i - 1].d);
  assert.match(br.index.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('the list projection carries the fields the Brazil filters read', () => {
  const fields = FILTER_FIELDS.br;
  assert.ok(Array.isArray(fields) && fields.length);
  for (const f of fields) assert.ok(list.companies.some((c) => f in c), `projection is missing ${f}`);
  assert.equal(list.companies.length, br.companies.length);
});

test('every company has a sector, a report currency and a class label', () => {
  for (const c of br.companies) {
    assert.ok(c.sector, `${c.code} has no sector`);
    assert.ok(c.reportCurrency, `${c.code} has no report currency`);
    assert.ok(c.shareClass, `${c.code} has no share class`);
    if (c.multiClass) assert.ok(c.shareClass, `${c.code} multi-class without a class label`);
  }
});

test('the trading-quality flags are consistent', () => {
  for (const c of br.companies) {
    if (c.noRecentTrading) {
      assert.ok(c.flatPct >= 90, `${c.code}: no-trade with flat ${c.flatPct}%`);
      assert.equal(c.chg1d, null, `${c.code}: no-trade still has 1D`);
      assert.equal(c.chg6m, null, `${c.code}: no-trade still has 6M`);
      assert.equal(c.chgYtd, null, `${c.code}: no-trade still has YTD`);
    }
    if (c.ttmStale) assert.ok(c.ttmAgeDays > 365, `${c.code}: stale TTM with ${c.ttmAgeDays} days`);
    if (c.thinTrading) assert.ok(c.avgValue30 != null && c.avgValue30 < 1e6, `${c.code}: thin with ${c.avgValue30}`);
  }
  assert.ok(br.audit.noRecentTrading > 0, 'no no-trade flag');
  assert.ok(br.audit.thinTrading > 0, 'no thin flag');
});

test('the curated themes survive the universe filter', () => {
  assert.ok((br.themes || []).length >= 5, `only ${(br.themes || []).length} themes`);
  for (const t of br.themes) {
    assert.ok(t.tickers && t.tickers.length >= 3, `${t.id} has ${t.tickers ? t.tickers.length : 0} members`);
    for (const code of t.tickers) assert.ok(br.companies.some((c) => c.code === code), `${t.id}: ${code} is not in the market`);
  }
});

test('the universe snapshot records the BDR and fund exclusions', () => {
  assert.ok(snap.excludedBdr > 500, `only ${snap.excludedBdr} BDRs excluded`);
  assert.ok(snap.excludedFunds > 0, `no funds excluded`);
  const built = new Set(br.companies.map((c) => c.code.replace(/\d{1,2}B?$/, '')));
  const missing = [...new Set(snap.rows.map((r) => r.code.replace(/\d{1,2}B?$/, '')))].filter((b) => !built.has(b));
  assert.ok(missing.length <= 15, `${missing.length} issuer bases missing: ${missing.slice(0, 8).join(', ')}`);
});
