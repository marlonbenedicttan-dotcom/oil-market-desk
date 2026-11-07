// Audit the published numbers for all three markets: US, Japan, Korea.
//
// `audit-calculations` and `audit-deep` only look at the US file, and they compare the dashboard with
// itself. This checks each market against the source the figure is supposed to come from — price ×
// shares, the exchange's own ratios, the quarterly table the reader can add up — and fails the build
// when a number cannot be reproduced.
//
//   node scripts/audit-markets.mjs
//   node scripts/audit-markets.mjs --json        # print the report as JSON
//
// Exit code 1 means at least one hard failure. Warnings describe known, labelled differences.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const JSON_ONLY = process.argv.includes('--json');

const load = (f) => {
  try { return JSON.parse(readFileSync(join(DATA, f), 'utf8')); } catch { return null; }
};
const us = load('companies.json');
const jp = load('japan.json');
const kr = load('korea.json');
const caps = load('cache/naver-caps.json');

const report = { checked: new Date().toISOString(), markets: {}, failures: 0, warnings: 0 };
const pct = (a, b) => (a == null || b == null || b === 0 ? null : (a - b) / Math.abs(b));
// A published ratio is rounded (P/B to one or two decimals, a margin to one). A 4% "error" on a P/B of
// 1.2 is that rounding, so a difference only counts when it is both relatively and absolutely large.
const off = (a, b, abs = 0) => a == null || b == null || b === 0 ? false
  : Math.abs(a - b) > abs && Math.abs(a - b) / Math.abs(b) > 0.02;
const finite = (v) => v == null || Number.isFinite(v);
const money = (v) => (v == null ? '—' : Math.abs(v) >= 1e12 ? `$${(v / 1e12).toFixed(2)}T`
  : Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : String(v));

function market(name, rows) {
  const m = { name, rows: rows.length, checks: [], fail: 0, warn: 0, examples: {} };
  const add = (check, severity, detail, items) => {
    m.checks.push({ check, severity, count: items.length, detail });
    if (!items.length) return;
    if (severity === 'fail') { m.fail += items.length; report.failures += items.length; }
    else { m.warn += items.length; report.warnings += items.length; }
    m.examples[check] = items.slice(0, 8).map(([label, extra]) => `${label}${extra ? ` (${extra})` : ''}`);
  };
  m.add = add;
  return m;
}

// ─── US ─────────────────────────────────────────────────────────────────────────────────────────────
{
  const rows = us?.companies || [];
  const m = market('US', rows);
  const day = 86400000;

  const capGap = rows.filter((c) => c.marketCap > 0 && c.price > 0 && c.shares > 0)
    .map((c) => [pct(c.marketCap, c.price * c.shares), c]);
  m.add('market cap vs price × shares', 'warn', 'A share class Nasdaq capitalises but the filing does not count',
    capGap.filter(([d]) => d != null && Math.abs(d) > 0.08).map(([d, c]) => [c.ticker, `${(d * 100).toFixed(1)}%`]));
  m.add('market cap vs price × shares', 'fail', 'Off by more than a share class',
    capGap.filter(([d]) => d != null && Math.abs(d) > 0.25).map(([d, c]) => [c.ticker, `${(d * 100).toFixed(1)}%`]));

  const peGap = rows.filter((c) => c.pe != null && c.marketCap > 0 && c.netIncomeTTM > 0)
    .map((c) => [pct(c.pe, c.marketCap / c.netIncomeTTM), c]);
  m.add('P/E = cap ÷ TTM profit', 'fail', 'P/E does not reproduce from its own inputs',
    peGap.filter(([d]) => d != null && Math.abs(d) > 0.03).map(([d, c]) => [c.ticker, `${(d * 100).toFixed(1)}%`]));

  const pbGap = rows.filter((c) => c.pb != null && c.marketCap > 0 && c.equity > 0)
    .map((c) => [pct(c.pb, c.marketCap / c.equity), c]);
  m.add('P/B = cap ÷ equity', 'fail', 'P/B does not reproduce from its own inputs',
    rows.filter((c) => c.equity > 0 && off(c.pb, c.marketCap / c.equity, 0.06))
      .map((c) => [c.ticker, `${(pct(c.pb, c.marketCap / c.equity) * 100).toFixed(1)}%`]));

  m.add('ROE = TTM profit ÷ equity', 'fail', 'ROE does not reproduce from its own inputs',
    rows.filter((c) => c.equity > 0 && c.netIncomeTTM != null && off(c.roe, (c.netIncomeTTM / c.equity) * 100, 0.15))
      .map((c) => [c.ticker, `${(pct(c.roe, (c.netIncomeTTM / c.equity) * 100) * 100).toFixed(1)}%`]));

  // A P/E on a loss is meaningless. A P/E built from a positive fiscal-year figure is not: the page
  // labels the basis, and 7 companies have no trailing figure but a real, positive FY one.
  m.add('ratio present where it cannot exist', 'fail', 'A P/E on a loss, or a P/B on negative equity',
    rows.filter((c) => (c.pe != null && !(c.netIncomeTTM > 0)
        && !(c.peBasis === 'FY' && ((c.netIncome != null && c.netIncome > 0) || (c.eps != null && c.eps > 0))))
      || (c.pb != null && !(c.equity > 0)))
      .map((c) => [c.ticker, c.pb != null && !(c.equity > 0) ? 'P/B on negative equity' : 'P/E on a loss']));

  // The page shows a trailing profit and a quarterly table. They must add up.
  const contiguous = (q) => q.every((x, i) => i === 0
    || (() => { const d = (Date.parse(x.end) - Date.parse(q[i - 1].end)) / day; return d >= 80 && d <= 100; })());
  const ttmGap = [];
  const quarterBehind = [];
  for (const c of rows) {
    const q = (c.quarters || []).slice(-4);
    if (q.length !== 4 || q.some((x) => x.netIncome == null) || !contiguous(q)) continue;
    const sum = q.reduce((a, x) => a + x.netIncome, 0);
    // A table that stops before the headline window is the stale side; that is reported separately.
    if (c.netIncomeTTM != null && c.netIncomeTTMAsOf && q[3].end >= c.netIncomeTTMAsOf
      && Math.abs(pct(c.netIncomeTTM, sum) ?? 0) > 0.02) {
      ttmGap.push([c.ticker, `headline ${money(c.netIncomeTTM)} vs quarters ${money(sum)}`]);
    }
    if (c.netIncomeTTMAsOf && c.netIncomeTTMAsOf < q[3].end) {
      quarterBehind.push([c.ticker, `TTM ${c.netIncomeTTMAsOf} < last quarter ${q[3].end}`]);
    }
  }
  m.add('TTM profit vs the quarterly table', 'fail', 'The trailing figure is not the four quarters shown',
    ttmGap);
  m.add('TTM older than the last quarter', 'fail', 'Newer quarters exist than the headline window',
    quarterBehind);

  m.add('non-finite or impossible values', 'fail', 'NaN, negative price or negative market cap',
    rows.filter((c) => !finite(c.marketCap) || !finite(c.price) || !finite(c.netIncomeTTM)
      || !(c.marketCap > 0) || !(c.price > 0)).map((c) => [c.ticker]));
  m.add('duplicate tickers', 'fail', 'The same company listed twice',
    (() => { const seen = new Set(), dup = []; for (const c of rows) { if (seen.has(c.ticker)) dup.push([c.ticker]); seen.add(c.ticker); } return dup; })());

  m.coverage = {
    companies: rows.length,
    marketCap: rows.filter((c) => c.marketCap > 0).length,
    pe: rows.filter((c) => c.pe != null).length,
    pb: rows.filter((c) => c.pb != null).length,
    ttm: rows.filter((c) => c.netIncomeTTM != null).length,
    quarters8: rows.filter((c) => (c.quarters || []).length >= 8).length,
  };
  report.markets.us = m;
}

// ─── JAPAN ──────────────────────────────────────────────────────────────────────────────────────────
{
  const rows = jp?.companies || [];
  const m = market('Japan', rows);

  // JPX publishes PER, PBR, EPS and BPS from the same close. If they do not reproduce the price, the
  // ratio and the price are from different days — which is exactly the failure this exists to catch.
  const perPrice = rows.filter((c) => c.jpx?.per > 0 && c.jpx?.eps > 0 && c.price > 0)
    .map((c) => [pct(c.price, c.jpx.per * c.jpx.eps), c]);
  m.add('JPX PER × EPS = price', 'fail', 'The exchange ratio and our price are not the same day',
    perPrice.filter(([d]) => d != null && Math.abs(d) > 0.02).map(([d, c]) => [c.code, `${(d * 100).toFixed(1)}%`]));

  const pbrPrice = rows.filter((c) => c.jpx?.pbr > 0 && c.jpx?.bps > 0 && c.price > 0)
    .map((c) => [pct(c.price, c.jpx.pbr * c.jpx.bps), c]);
  m.add('JPX PBR × BPS = price', 'fail', 'The exchange ratio and our price are not the same day',
    pbrPrice.filter(([d]) => d != null && Math.abs(d) > 0.05).map(([d, c]) => [c.code, `${(d * 100).toFixed(1)}%`]));

  const pbGap = rows.filter((c) => c.pb != null && c.marketCap > 0 && c.eqLatest > 0)
    .map((c) => [pct(c.pb, c.marketCap / c.eqLatest), c]);
  m.add('P/B vs the filing’s equity', 'warn', 'JPX values equity at a later filing date',
    pbGap.filter(([d]) => d != null && Math.abs(d) > 0.05).map(([d, c]) => [c.code, `${(d * 100).toFixed(1)}%`]));
  m.add('P/B vs the filing’s equity', 'fail', 'More than a filing-date difference',
    pbGap.filter(([d]) => d != null && Math.abs(d) > 0.25).map(([d, c]) => [c.code, `${(d * 100).toFixed(1)}%`]));

  m.add('operating margin = op ÷ sales', 'fail', 'Margin does not reproduce from its own inputs',
    rows.filter((c) => c.sales && c.op != null && off(c.opMargin, (c.op / c.sales) * 100, 0.15))
      .map((c) => [c.code, `${(c.opMargin - (c.op / c.sales) * 100).toFixed(2)}pp`]));

  m.add('duplicate fiscal years', 'fail', 'An amended filing printed the same year twice',
    rows.filter((c) => {
      const y = (c.history || []).map((h) => h.y).filter(Boolean);
      return new Set(y).size !== y.length;
    }).map((c) => [c.code]));

  const stale = rows.filter((c) => c.period && (Date.now() - Date.parse(c.period)) / 86400000 > 550);
  m.add('latest fiscal year older than 18 months', 'warn', 'Labelled as stale, not a calculation error',
    stale.map((c) => [c.code, c.period]));

  m.add('non-finite or impossible values', 'fail', 'NaN, negative price or negative market cap',
    rows.filter((c) => !finite(c.marketCap) || !finite(c.price) || !(c.marketCap > 0) || !(c.price > 0))
      .map((c) => [c.code]));

  // A ROE from JPX is trailing while `np` is the fiscal year. Both are correct; the pairing is not.
  const basisMix = rows.filter((c) => c.jpx?.roe != null && c.np != null
    && Math.abs(c.jpx.roe) > 0.005 && Math.sign(c.roe) !== Math.sign(c.np));
  m.add('ROE sign disagrees with the fiscal-year profit', 'warn', 'JPX ROE is trailing; NP is the fiscal year',
    basisMix.map((c) => [c.code, `ROE ${c.roe}% vs NP ${money(c.np)}`]));

  m.coverage = {
    companies: rows.length,
    marketCap: rows.filter((c) => c.marketCap > 0).length,
    pe: rows.filter((c) => c.pe != null).length,
    pb: rows.filter((c) => c.pb != null).length,
    roe: rows.filter((c) => c.roe != null).length,
    jpxRatio: rows.filter((c) => c.jpx?.per != null).length,
  };
  report.markets.japan = m;
}

// ─── KOREA ──────────────────────────────────────────────────────────────────────────────────────────
{
  const rows = kr?.companies || [];
  const m = market('Korea', rows);

  m.add('market cap vs price × shares', 'fail', 'The cap must reproduce from the published count',
    rows.filter((c) => c.marketCap > 0 && c.price > 0 && c.shares > 0
      && Math.abs(pct(c.marketCap, c.price * c.shares) ?? 0) > 0.005)
      .map((c) => [c.ticker, `${((pct(c.marketCap, c.price * c.shares) || 0) * 100).toFixed(2)}%`]));

  // Naver's own cap is the exchange feed the price comes from; it is the only independent count here.
  const naverCaps = caps?.caps || {};
  if (!Object.keys(naverCaps).length) {
    m.add('market cap vs Naver', 'warn', 'No Naver cap feed on disk — the independent cross-check was skipped', [['—']]);
  }
  const naverRows = rows.filter((c) => naverCaps[c.ticker]?.cap > 0 && c.marketCap > 0);
  const nd = naverRows.map((c) => [pct(c.marketCap, naverCaps[c.ticker].cap), c]);
  m.add('market cap vs Naver', 'warn', 'A split or a stale print since the cap was read',
    nd.filter(([d]) => d != null && Math.abs(d) > 0.03).map(([d, c]) => [c.ticker, `${(d * 100).toFixed(1)}%`]));
  m.add('market cap vs Naver', 'fail', 'More than a rounding difference',
    nd.filter(([d]) => d != null && Math.abs(d) > 0.15).map(([d, c]) => [c.ticker, `${(d * 100).toFixed(1)}%`]));

  const annual = (c) => (c.reports || []).find((r) => r.report === 'annual' && r.end);
  const peCalc = (c) => {
    // A company without four dated quarters is valued on its last fiscal year (peBasis FY). Compare it
    // with that annual profit, not with a sum of four undated/interim rows — the old check reported
    // eight false failures on exactly those names.
    if (c.peBasis === 'FY') {
      const a = annual(c);
      return a && a.netIncome > 0 && c.marketCap > 0 ? c.marketCap / a.netIncome : null;
    }
    const q = (c.quarters || []).slice(-4);
    if (q.length < 4 || q.some((x) => x.netIncome == null)) return null;
    const ni = q.reduce((a, x) => a + x.netIncome, 0);
    return ni > 0 && c.marketCap > 0 ? c.marketCap / ni : null;
  };
  m.add('P/E = cap ÷ TTM profit', 'fail', 'P/E does not reproduce from its own inputs',
    rows.filter((c) => off(c.pe, peCalc(c), 0.05))
      .map((c) => [c.ticker, `${(pct(c.pe, peCalc(c)) * 100).toFixed(1)}%`]));

  m.add('P/B = cap ÷ equity', 'fail', 'P/B does not reproduce from its own inputs',
    rows.filter((c) => c.equity > 0 && off(c.pb, c.marketCap / c.equity, 0.03))
      .map((c) => [c.ticker, `${(pct(c.pb, c.marketCap / c.equity) * 100).toFixed(1)}%`]));

  m.add('negative dividend or payout yield', 'fail', 'Dividends paid is a magnitude, never negative',
    rows.filter((c) => c.dividendPaid < 0 || c.payoutYield < 0)
      .map((c) => [c.ticker, `dividend ${money(c.dividendPaid)} · yield ${c.payoutYield}%`]));

  m.add('duplicate annual reports', 'fail', 'The same fiscal year filed twice',
    rows.filter((c) => {
      const y = (c.reports || []).filter((r) => r.report === 'annual').map((r) => r.end);
      return new Set(y).size !== y.length;
    }).map((c) => [c.ticker]));

  m.add('non-finite or impossible values', 'fail', 'NaN, negative price, zero or negative share count',
    rows.filter((c) => !finite(c.marketCap) || !finite(c.price) || !(c.marketCap > 0) || !(c.price > 0)
      || !(c.shares > 0)).map((c) => [c.ticker]));

  // DART's table is last year's count; a difference means a split or consolidation, which is expected
  // and already corrected by the market cap. Reported so the size of the drift is visible.
  const drift = rows.filter((c) => c.sharesDart > 0 && c.shares > 0
    && Math.abs(pct(c.shares, c.sharesDart) ?? 0) > 0.05);
  m.add('share count differs from the filing', 'info', 'A split or consolidation since the last annual report',
    drift.map((c) => [c.ticker, `filing ${Math.round(c.sharesDart).toLocaleString()} → listed ${Math.round(c.shares).toLocaleString()}`]));

  m.coverage = {
    companies: rows.length,
    marketCap: rows.filter((c) => c.marketCap > 0).length,
    pe: rows.filter((c) => c.pe != null).length,
    peTTM: rows.filter((c) => c.pe != null && c.peBasis === 'TTM').length,
    peFY: rows.filter((c) => c.pe != null && c.peBasis === 'FY').length,
    pb: rows.filter((c) => c.pb != null).length,
    roe: rows.filter((c) => c.roe != null).length,
    naverMatched: naverRows.length,
  };
  report.markets.korea = m;
}

// ─── output ─────────────────────────────────────────────────────────────────────────────────────────
if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 1));
} else {
  for (const key of ['us', 'japan', 'korea']) {
    const m = report.markets[key];
    if (!m) continue;
    console.log(`\n${m.name.toUpperCase()} · ${m.rows} companies`);
    for (const c of m.checks) {
      if (!c.count) continue;
      const tag = c.severity === 'fail' ? 'FAIL' : c.severity === 'warn' ? 'WARN' : 'INFO';
      console.log(`  ${tag} ${String(c.count).padStart(4)}  ${c.check}`);
      console.log(`             ${c.detail}`);
      for (const ex of (m.examples[c.check] || []).slice(0, 5)) console.log(`               ${ex}`);
      if (c.count > 5) console.log(`               … ${c.count - 5} more`);
    }
    const clean = m.checks.filter((c) => !c.count);
    console.log(`  ${m.fail ? '✗' : '✓'} ${m.checks.length} checks · ${m.fail} failures · ${m.warn} warnings · ${clean.length} clean`);
    console.log(`    ${Object.entries(m.coverage).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  console.log(`\n${report.failures ? '✗' : '✓'} ${report.failures} failures · ${report.warnings} warnings across 3 markets`);
}

const out = join(DATA, 'audit-markets.json');
writeFileSync(out, JSON.stringify(report, null, 1));
if (!JSON_ONLY) console.log(`wrote ${out}`);
process.exit(report.failures ? 1 : 0);
