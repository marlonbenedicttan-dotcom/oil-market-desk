// Regression tests for the company dataset.
//
// These encode the *classes* of bug that were found and fixed, not exact numbers, so a new filing can
// update the data without breaking the suite — but the specific failures cannot come back silently.
//
//   node --test tests/companies-data.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../data/companies.json', import.meta.url), 'utf8'));
const by = Object.fromEntries(data.companies.filter((c) => c.ticker).map((c) => [c.ticker, c]));

test('universe is the S&P 1500 securities file', () => {
  // Membership comes from SPTM's holdings, and it moves by a name or two between snapshots. Assert
  // the accounting (kept + disclosed absent = members) rather than a hardcoded count: a silent drop
  // or a duplicated CIK is the bug.
  const u = data.universe || {};
  assert.equal(u.name, 'S&P 1500');
  const absent = Array.isArray(u.absent) ? u.absent.length : 0;
  assert.equal(data.companies.length + absent, u.members, 'kept + disclosed absent must equal index members');
  assert.ok(data.companies.length >= 1400, `rows ${data.companies.length}`);
  const ciks = new Set(data.companies.filter((c) => c.cik).map((c) => c.cik));
  assert.equal(ciks.size, u.companies, 'unique CIKs must match the declared company count');
  assert.ok(ciks.size >= 1400, `unique CIKs ${ciks.size}`);
});

test('every row has the identity fields the UI needs', () => {
  for (const c of data.companies) {
    assert.ok(c.ticker, 'ticker');
    assert.ok(c.cik, `cik for ${c.ticker}`);
    assert.ok(c.sector, `sector for ${c.ticker}`);
    assert.ok(c.price > 0, `price for ${c.ticker}`);
    assert.ok(c.marketCap > 0, `market cap for ${c.ticker}`);
  }
});

test('a fiscal year is not mistaken for a quarter (Ford FY2025 loss)', () => {
  const f = by.F;
  assert.ok(f, 'F present');
  assert.ok(f.netIncome < 0, `Ford FY2025 must be a loss, got ${f.netIncome}`);
  assert.ok(f.netIncome > -2e10, 'Ford loss is not absurd');
});

test('revenue is a total, not a component (MetLife)', () => {
  const met = by.MET;
  assert.ok(met.revenue > 5e10, `MetLife revenue must exceed $50B, got ${met.revenue}`);
});

test('a tag that stopped being used does not keep its old value (Broadcom)', () => {
  const avgo = by.AVGO;
  assert.ok(avgo.netIncome > 1.5e10, `Broadcom earnings must exceed $15B, got ${avgo.netIncome}`);
  assert.ok(avgo.pe == null || avgo.pe < 100, `Broadcom P/E must not be the 260x artifact, got ${avgo.pe}`);
});

test('the CIK maps to the live registrant (DTE)', () => {
  assert.equal(String(by.DTE.cik), '936340');
});

test('balance sheet belongs to the earnings year (AutoZone)', () => {
  const azo = by.AZO;
  assert.ok(azo.assets > 2e10, `AutoZone assets must exceed $20B, got ${azo.assets}`);
});

test('share classes share a CIK but not a market cap', () => {
  for (const [cls, sib] of [['GOOG', 'GOOGL'], ['FOX', 'FOXA'], ['NWS', 'NWSA']]) {
    const a = by[cls], b = by[sib];
    assert.ok(a && b, `${cls}/${sib} present`);
    assert.equal(a.cik, b.cik, `${cls} shares the CIK of ${sib}`);
    assert.ok(a.shareClass, `${cls} is marked as a share class`);
    assert.notEqual(a.marketCap, b.marketCap, `${cls} has its own market cap`);
  }
});

test('a TTM figure is plausible against revenue', () => {
  // A profit can turn into a loss (impairment) — that is real. Earnings above revenue are not, and a
  // loss beyond three times revenue means the tags belong to different scopes. Only compare figures
  // built from the same quarter table; annual and quarterly bank/insurer/REIT scopes can differ.
  for (const c of data.companies) {
    if (!c.ttmFromQuarters) continue;
    const revenue = Math.max(c.revenueTTM ?? 0, c.revenue ?? 0);
    if (c.netIncomeTTM == null || !revenue) continue;
    assert.ok(c.netIncomeTTM <= revenue * 1.2, `${c.ticker}: TTM above revenue`);
    assert.ok(c.netIncomeTTM >= revenue * -3, `${c.ticker}: TTM loss beyond 3x revenue`);
  }
});

test('P/E on TTM always has a TTM figure behind it', () => {
  for (const c of data.companies) {
    if (c.peBasis === 'TTM') assert.ok(c.netIncomeTTM != null, `${c.ticker}: TTM P/E without TTM earnings`);
    if (c.pe != null) assert.ok(c.pe > 0 && c.pe < 2000, `${c.ticker}: P/E ${c.pe}`);
  }
});

test('no company has revenue above its own assets by an absurd factor', () => {
  for (const c of data.companies) {
    if (!c.revenue || !c.assets) continue;
    assert.ok(c.revenue < c.assets * 20, `${c.ticker}: revenue ${c.revenue} vs assets ${c.assets}`);
  }
});

test('descriptions are sentences, not table-of-contents residue', () => {
  const residue = /(Item\s+\d+[A-Z]?\.|PART\s+I{1,3}\b|Mine Safety Disclosures|Table of Contents|Market for Registrant)/i;
  for (const c of data.companies) {
    if (!c.description) continue;
    assert.ok(!residue.test(c.description), `${c.ticker}: ${c.description.slice(0, 60)}`);
    assert.ok(/^[A-Za-z0-9"“]/.test(c.description), `${c.ticker}: starts with punctuation`);
  }
});

test('every description passes the quality gate', () => {
  const RESIDUE = /(Item\s+\d+[A-Z]?\.|PART\s+I{1,3}\b|Mine Safety Disclosures|Table of Contents|Market for Registrant|Common Equity, Related|Issuer Purchases|herein by reference)/i;
  // "a nonprofit supported by" is a foundation page; "the foundation of wireless connectivity" is not.
  const NOT_BUSINESS = /(\bfoundation\b[^.]{0,60}\bnonprofit\b|\bpolitical action committee\b|\bPAC\b|employee stock purchase plan)/i;
  for (const c of data.companies) {
    const d = c.description || '';
    assert.ok(d.length >= 80 && d.length <= 420, `${c.ticker}: ${d.length} chars`);
    assert.ok(!RESIDUE.test(d), `${c.ticker}: residue`);
    assert.ok(!NOT_BUSINESS.test(d), `${c.ticker}: not about the business`);
    // The description has to identify the company, but "Lilly is a medicine company" names Eli Lilly
    // perfectly well. Accept any distinctive word from the name, not just the first.
    const STOP = /^(the|and|company|holdings|group|corporation|incorporated|limited|inc|corp|co|plc|ltd)$/i;
    let w = String(c.name || '').split(/\s+/)
      .map((x) => x.replace(/[.,]/g, '').toLowerCase())
      .filter((x) => x.length >= 3 && !STOP.test(x));
    // "HP Inc." has no 3-letter distinctive token; use the short name itself rather than failing a
    // description that plainly starts "HP is a global technology leader".
    if (!w.length) w = [String(c.name || '').split(/\s+/)[0].replace(/[.,]/g, '').toLowerCase()].filter((x) => x.length >= 2);
    if (w.length) {
      // Compare with punctuation removed: "P&G serves consumers…" names Procter & Gamble, and
      // "AMD (NASDAQ: AMD)…" names Advanced Micro Devices.
      const flat = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const head = flat(d.slice(0, 140));
      const tick = flat(c.ticker || '');
      assert.ok(w.some((x) => head.includes(flat(x))) || (tick.length > 1 && head.includes(tick)), `${c.ticker}: does not name the company`);
    }
  }
});

test('a company with no annual report is flagged, not faked', () => {
  const vy = by.VYLR;
  assert.ok(vy.noFilings, 'VYLR is marked noFilings');
  assert.ok(vy.revenue == null, 'VYLR has no revenue');
});

test('a restatement keeps both figures and the amended one wins', () => {
  for (const c of data.companies) {
    if (!c.restatement) continue;
    const changes = c.restatement.changes || {};
    assert.ok(Object.keys(changes).length > 0, `${c.ticker}: restatement with no change recorded`);
    assert.ok(c.restatement.filed, `${c.ticker}: restatement without a filing date`);
    for (const [f, v] of Object.entries(changes)) {
      // An amendment parsed at the wrong scope (a quarter or a segment instead of annual revenue) is
      // recorded but not applied; apply-restatements.mjs names the reason here.
      if (c.restatement.rejected && c.restatement.rejected[f]) {
        assert.ok(c.restatement.rejected[f].reason, `${c.ticker}: rejected ${f} without a reason`);
        continue;
      }
      // A later 10-Q supersedes the amended annual figure; the restatement still lives in the record.
      const end = c[f + 'End'];
      if (end && c.restatement.period && end > c.restatement.period) continue;
      assert.equal(c[f], v.now, `${c.ticker}: ${f} should hold the amended value`);
    }
  }
});

test('free cash flow is cash, not a second earnings figure', () => {
  for (const c of data.companies) {
    if (c.fcf == null) continue;
    assert.ok(c.operatingCashFlow != null, `${c.ticker}: FCF without operating cash flow`);
    assert.ok(c.fcf <= c.operatingCashFlow + 1, `${c.ticker}: FCF above operating cash flow`);
    // A negative FCF is cash burn, not a second earnings figure; a clinical-stage biotech can
    // legitimately burn many times its revenue. The ratio guard is for positive FCF.
    if (c.revenue && c.fcf > 0) assert.ok(c.fcf <= c.revenue * 2, `${c.ticker}: FCF implausible vs revenue`);
  }
  assert.ok(by.AAPL.fcf > 5e10, 'Apple free cash flow should exceed $50B');
});

test('a company without free cash flow still carries its own metrics', () => {
  for (const c of data.companies) {
    if (c.sector !== 'Financials') continue;
    // A no-filing row has no statements to carry a metric by design.
    if (c.noFilings) continue;
    // ROE is undefined on negative book equity (Equitable Holdings carries negative AOCI equity);
    // there is no honest financial metric to demand in that case.
    if (c.equity != null && c.equity <= 0) continue;
    // Banks get tangible book / efficiency / margin; asset managers and exchanges may have none of
    // those, but every financial still has a return on equity.
    assert.ok(c.ptbv != null || c.efficiencyRatio != null || c.nim != null || c.roe != null,
      `${c.ticker}: no financial metric at all`);
  }
});

test('shareholder yield is a percentage in a plausible range', () => {
  for (const c of data.companies) {
    if (c.shareholderYield == null) continue;
    assert.ok(c.shareholderYield > -5 && c.shareholderYield < 40, `${c.ticker}: ${c.shareholderYield}`);
  }
});

test('banks have no free cash flow but do have a margin', () => {
  assert.ok(by.JPM.fcfNA, 'JPM FCF is marked n/a');
  assert.equal(by.JPM.fcf, null, 'JPM FCF is null');
  assert.notEqual(by.AXP.marginNA, true, 'Amex margin is computable');
});

test('the quarterly series is chronological, unique and never empty', () => {
  // The series used to be capped at the vendor's eight quarters. The US build now keeps every filed
  // quarter, so the invariant is the shape of the series, not its length; the client labels the count.
  for (const c of data.companies) {
    const q = c.quarters || [];
    if (!q.length) continue;
    const ends = q.map((x) => x.end);
    assert.deepEqual(ends, [...ends].sort(), `${c.ticker}: quarters out of order`);
    assert.equal(new Set(ends).size, ends.length, `${c.ticker}: duplicate quarter ends`);
    for (const x of q) assert.ok(x.revenue != null || x.netIncome != null, `${c.ticker}: empty quarter ${x.end}`);
  }
});

test('a valuation band is ordered and its percentile is in range', () => {
  for (const c of data.companies) {
    const h = c.peHistory;
    if (!h) continue;
    assert.ok(h.min <= h.median && h.median <= h.max, `${c.ticker}: band ${h.min}/${h.median}/${h.max}`);
    if (h.percentile != null) assert.ok(h.percentile >= 0 && h.percentile <= 100, `${c.ticker}: percentile ${h.percentile}`);
    for (const y of h.years) assert.ok(y.pe > 0, `${c.ticker}: FY${y.fy} P/E ${y.pe}`);
  }
});

test('sector valuation is ordered and covers the main sectors', () => {
  const v = JSON.parse(readFileSync(new URL('../data/valuation.json', import.meta.url), 'utf8'));
  const sectors = v.sectors || {};
  assert.ok(Object.keys(sectors).length >= 8, 'at least eight sectors');
  for (const [name, x] of Object.entries(sectors)) {
    assert.ok(x.min <= x.median && x.median <= x.max, `${name}: ${x.min}/${x.median}/${x.max}`);
    assert.ok(x.percentile == null || (x.percentile >= 0 && x.percentile <= 100), `${name}: percentile`);
    assert.ok(x.pe == null || (x.pe > 3 && x.pe < 200), `${name}: P/E ${x.pe}`);
  }
});

test('the index valuation carries a current P/E and a history', () => {
  const v = JSON.parse(readFileSync(new URL('../data/valuation.json', import.meta.url), 'utf8'));
  assert.ok(v.index.pe > 5 && v.index.pe < 100, `index P/E ${v.index.pe}`);
  assert.ok(v.index.years.length >= 3, 'at least three years of history');
  assert.ok(v.index.min <= v.index.max);
});

test('the index weights sum to about 100', () => {
  const sum = data.companies.reduce((a, c) => a + (c.indexWeight || 0), 0);
  assert.ok(sum > 99 && sum < 101, `weights sum to ${sum}`);
});

test('the most recent eight quarters are complete where the company files eight', () => {
  // The old pass asked for one tag per concept, so 59 companies had eight blank revenue columns.
  // The archive can now be longer than eight; the contract is about the latest eight.
  const short = data.companies.filter((c) => {
    // A bank does not always tag a single total-revenue line; its quarters can carry net profit
    // without a revenue figure. That is an honest blank, not an incomplete series.
    if (c.sector === 'Financials' || /^(60|6199)/.test(String(c.sic || ''))) return false;
    const q = c.quarters || [];
    if (q.length < 8) return false;
    return q.slice(-8).filter((x) => x.revenue != null).length < 8;
  });
  // A 3% tail covers newly listed and foreign filers whose earliest quarters are incomplete; a real
  // regression — the old one-tag pass left 59 companies blank — is larger than this.
  assert.ok(short.length <= Math.max(20, Math.ceil(data.companies.length * 0.03)),
    `${short.length} companies have an incomplete quarter series: ${short.slice(0, 8).map((c) => c.ticker).join(' ')}`);
});

test('a quarterly margin is present wherever revenue and operating income are', () => {
  const bad = [];
  for (const c of data.companies) {
    for (const q of c.quarters || []) {
      if (q.revenue > 0 && q.operatingIncome != null && q.margin == null) bad.push(`${c.ticker} ${q.end}`);
      // A tiny-revenue company can post a −460% operating margin; anything past 1000% is a units bug.
      if (q.margin != null && Math.abs(q.margin) > 1000) bad.push(`${c.ticker} ${q.end} margin ${q.margin}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} quarters have an impossible margin: ${bad.slice(0, 5).join(', ')}`);
});
