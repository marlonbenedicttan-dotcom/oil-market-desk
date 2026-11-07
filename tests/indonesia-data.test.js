import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTER_FIELDS } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
// The market is built by the indonesia-daily workflow on a runner that can reach Yahoo. Until that
// first build lands, the file is absent and these tests are skipped rather than red on a fresh clone.
const maybe = (f) => { try { return read(f); } catch { return null; } };
const ind = maybe('indonesia.json');
const list = maybe('indonesia-list.json');
const t = ind && list ? test : test.skip;

t('growth is computed from the annual record and survives the list', () => {
  const c = ind.companies.find((x) => x.ticker === 'BBCA');
  assert.ok(c, 'Bank Central Asia is present');
  assert.ok(c.revenueCagr != null, 'revenue CAGR is computed');
  assert.ok(c.epsCagr != null || c.epsChange, 'EPS growth is computed');
  const listed = list.companies.find((x) => x.ticker === 'BBCA');
  assert.ok(listed && 'revenueCagr' in listed, 'growth survives the list projection');
});

t('the IDX build has a real universe', () => {
  assert.ok(ind.companies.length > 500, `only ${ind.companies.length} companies`);
  assert.equal(ind.currency, 'IDR');
  assert.ok(ind.fx && ind.fx.rate > 10000 && ind.fx.rate < 25000, `USD/IDR ${ind.fx && ind.fx.rate}`);
});

t('every code is a four-character IDX symbol', () => {
  for (const c of ind.companies) assert.match(c.code, /^[A-Z0-9]{4}$/, c.code);
});

t('market cap is price × shares', () => {
  for (const c of ind.companies) {
    const shares = c.sharesCurrent > 0 ? c.sharesCurrent : c.shares;
    if (!(c.price > 0) || !(shares > 0)) continue;
    const want = c.price * shares;
    assert.ok(Math.abs(c.marketCap / want - 1) < 0.02, `${c.code}: cap ${c.marketCap} vs ${want}`);
  }
});

t('every published ratio reproduces from its own inputs, or is absent', () => {
  // A few IDX issuers report in USD, so the rupiah cap must be converted before it is divided by their
  // profit — the same cross the build uses.
  const rates = (ind.fx && ind.fx.rates) || {};
  const capReport = (c) => {
    if (!c.reportCurrency || c.reportCurrency === 'IDR') return c.marketCap;
    if (!rates.IDR || !rates[c.reportCurrency]) return null;
    return c.marketCap * (rates[c.reportCurrency] / rates.IDR);
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
      const want = cap / eq;
      // P/B is published to two decimals, so a genuine 0.0945 reads 0.09 — allow half a cent of
      // rounding on top of the 3% tolerance (many IDX small caps trade far below book).
      assert.ok(Math.abs(c.pb - want) <= 0.005 + Math.abs(want) * 0.03, `${c.code}: P/B ${c.pb} vs ${want.toFixed(4)}`);
    }
  }
  assert.ok(checked > 500, `only ${checked} P/Es were checked`);
});

t('a bank ships no operating margin and no free cash flow', () => {
  for (const c of ind.companies) {
    if (c.bankLike) assert.equal(c.opMargin, null, `${c.code} is bank-like with an op margin`);
    if (c.financial) {
      assert.equal(c.fcf, null, `${c.code} is a financial with free cash flow`);
      assert.equal(c.fcfYield, null, `${c.code} is a financial with an FCF yield`);
    }
  }
});

t('the market totals are the sum of the constituents', () => {
  const total = ind.companies.reduce((a, c) => a + (c.marketCap || 0), 0);
  assert.ok(Math.abs(total - ind.market.totalCap) / total < 0.001);
  const sectorCount = (ind.market.sectors || []).reduce((a, s) => a + s.count, 0);
  assert.equal(sectorCount, ind.companies.length);
});

t('the index is dated, ordered and positive', () => {
  const s = ind.index.series || [];
  assert.ok(s.length > 100, `index has ${s.length} points`);
  assert.ok(s.every((p) => p.c > 0));
  for (let i = 1; i < s.length; i++) assert.ok(s[i].d > s[i - 1].d);
  assert.match(ind.index.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ind.indexName, 'IDX Composite');
});

t('the list projection carries the fields the Indonesia filters read', () => {
  const fields = FILTER_FIELDS.id;
  assert.ok(Array.isArray(fields) && fields.length);
  // A field survives projection when at least one company ships it. `brands` is intentionally absent
  // from companies that have none (attach-market-brands deletes the empty key), so asserting it on
  // companies[0] — a bank with no consumer brand — would fail for the wrong reason.
  for (const f of fields) assert.ok(list.companies.some((c) => f in c), `projection is missing ${f}`);
  assert.equal(list.companies.length, ind.companies.length);
});

t('every company has a sector and a report currency', () => {
  for (const c of ind.companies) {
    assert.ok(c.sector && (c.sector !== 'Other' || c.sectorSource === 'other'), `${c.code} has no sector`);
    assert.ok(c.reportCurrency, `${c.code} has no report currency`);
  }
});

t('the curated themes survive the universe filter', () => {
  assert.ok((ind.themes || []).length >= 5, `only ${(ind.themes || []).length} themes`);
  for (const t of ind.themes) {
    assert.ok(t.tickers && t.tickers.length >= 3, `${t.id} has ${t.tickers ? t.tickers.length : 0} members`);
    for (const code of t.tickers) assert.ok(ind.companies.some((c) => c.code === code), `${t.id}: ${code} is not in the market`);
  }
});

t('the universe snapshot agrees with the built market', () => {
  const snap = read('indonesia-universe.json');
  assert.ok(snap.rows.length > 500, `snapshot has ${snap.rows.length} rows`);
  const built = new Set(ind.companies.map((c) => c.code));
  const present = snap.rows.filter((r) => built.has(r.code)).length;
  assert.ok(present / snap.rows.length > 0.9, `only ${present}/${snap.rows.length} snapshot names are in the build`);
});

t('dividend yield uses the vendor statistics page where the filing has no DPS', () => {
  const withYield = ind.companies.filter((c) => c.dividendYield != null).length;
  assert.ok(withYield / ind.companies.length >= 0.45,
    `dividend yield covers only ${withYield}/${ind.companies.length}`);
  assert.ok((ind.audit.vendorYield || 0) > 300, `only ${ind.audit.vendorYield} yields came from the vendor page`);
  // Banks rarely print a Dividend Per Share row; the vendor page still carries the yield.
  for (const code of ['BBNI', 'BYAN', 'TPIA']) {
    const c = ind.companies.find((x) => x.code === code);
    assert.ok(c && c.dividendYield > 0, `${code}: no dividend yield`);
    assert.equal(c.dividendYieldBasis, 'vendor', `${code}: yield is not labelled as the vendor's`);
  }
});

t('the IDX High Shareholding Concentration list is applied and dated', () => {
  const hsc = ind.audit || {};
  const flagged = ind.companies.filter((c) => c.hsc);
  assert.equal(flagged.length, hsc.hsc, 'HSC flag count does not match audit.hsc');
  assert.ok(flagged.length >= 40, `only ${flagged.length} HSC companies`);
  assert.ok(flagged.every((c) => c.hsc.asOf), 'an HSC flag has no as-of date');
  assert.deepEqual(hsc.hscMissing, [], 'HSC codes are missing from the market');
  assert.ok(list.companies.some((c) => c.hsc), 'the list projection does not carry the HSC flag');
  // The published list is 51 names; every one must be in the market and flagged.
  const snap = read('indonesia-hsc.json');
  for (const code of Object.keys(snap.entries)) {
    const c = ind.companies.find((x) => x.code === code);
    assert.ok(c && c.hsc, `${code} is on the HSC list but not flagged`);
  }
});
