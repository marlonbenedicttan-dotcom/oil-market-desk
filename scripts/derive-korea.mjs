// Korea ratio derivation, separated from fetching so the maths can be tested without an API key.
//
// DART's `thstrm_amount` is the 3-month figure for an interim income statement; the accumulated
// figure is `thstrm_add_amount`. So the Q1, H1 and Q3 filings already carry standalone quarters and
// only Q4 has to be derived, as the annual report less the first three quarters. Treating the
// interims as year-to-date — the old behaviour — turned Q2 into H1−Q1 and produced negative revenue
// for 507 of 746 filers.

import { growthRates } from '../src/growth.js';

const round = (v, dp) => (v == null ? null : +v.toFixed(dp));
const guard = (v, lo, hi) => (v != null && v > lo && v < hi ? v : null);
const FLOW_FIELDS = ['revenue', 'operatingProfit', 'netIncome'];

// rows: [{ report: 'q1'|'h1'|'q3'|'annual', end: 'YYYY-MM-DD', revenue, operatingProfit, netIncome }]
export function buildQuartersKr(rows) {
  const byYear = new Map();
  for (const r of rows) {
    if (!r.end || !r.report) continue;
    const fy = String(r.end).slice(0, 4);
    if (!byYear.has(fy)) byYear.set(fy, {});
    byYear.get(fy)[r.report] = r;
  }
  const out = [];
  for (const [fy, rec] of byYear) {
    // A quarter is kept when at least one flow line is reported. Banks and insurers have no revenue
    // line, so requiring revenue would silently drop them.
    const add = (q, r) => {
      if (!r || !r.end || FLOW_FIELDS.every((f) => r[f] == null)) return;
      out.push({
        d: r.end, fy, q,
        revenue: r.revenue ?? null, operatingProfit: r.operatingProfit ?? null, netIncome: r.netIncome ?? null,
      });
    };
    add('Q1', rec.q1);
    add('Q2', rec.h1);
    add('Q3', rec.q3);
    // There is no Q4 filing: the annual report is the full year, so Q4 is the remainder. Only compute
    // a field when all four statements carry it; a missing input stays missing rather than becoming a
    // subtraction from null.
    if (rec.annual?.end && rec.q1 && rec.h1 && rec.q3) {
      const q4 = {};
      for (const f of FLOW_FIELDS) {
        q4[f] = [rec.annual, rec.q1, rec.h1, rec.q3].every((r) => r[f] != null)
          ? rec.annual[f] - (rec.q1[f] + rec.h1[f] + rec.q3[f])
          : null;
      }
      if (FLOW_FIELDS.some((f) => q4[f] != null)) {
        out.push({ d: rec.annual.end, fy, q: 'Q4', ...q4 });
      }
    }
  }
  return out.sort((a, b) => a.d.localeCompare(b.d));
}

// A Korean company's fiscal year is December for almost everyone, so TTM = the four most recent
// standalone quarters. A missing quarter leaves a hole: summing the four rows on file would then
// cover more than a year, so the fiscal year is used instead and labelled as such.
export function ttmKr(quarters) {
  const last = quarters.slice(-4);
  const contiguous = last.every((q, i) => {
    if (i === 0) return true;
    const days = (Date.parse(q.d) - Date.parse(last[i - 1].d)) / 864e5;
    return days >= 60 && days <= 130;
  });
  if (last.length === 4 && contiguous) {
    const sum = (f) => (last.every((q) => q[f] != null) ? last.reduce((a, q) => a + q[f], 0) : null);
    return { revenue: sum('revenue'), operatingProfit: sum('operatingProfit'), netIncome: sum('netIncome'), basis: 'TTM', n: 4 };
  }
  return { revenue: null, operatingProfit: null, netIncome: null, basis: 'FY', n: last.length };
}

// A filer sometimes files a period in the wrong unit: DY E&C's 2026 half-year revenue is ₩253T against
// a ₩633B year, a thousand times its own business. The API returns exactly what was filed, so the only
// defence is to compare each report with the company's own annual scale and drop the impossible ones —
// a missing quarter is honest, a fabricated one is not.
export const saneReports = (rows) => {
  const annuals = rows.filter((r) => r.report === 'annual' && r.revenue > 0).sort((a, b) => String(a.end).localeCompare(String(b.end)));
  if (annuals.length < 1) return rows;
  const scale = Math.max(...annuals.slice(-2).map((r) => r.revenue));
  return rows.filter((r) => {
    if (r.report === 'annual') return true;
    if (r.revenue != null && (r.revenue > scale * 20 || r.revenue < scale / 20)) return false;
    if (r.netIncome != null && Math.abs(r.netIncome) > scale * 20) return false;
    if (r.revenue > 0 && r.netIncome != null && Math.abs(r.netIncome) > r.revenue * 20) return false;
    return true;
  });
};

export function deriveKorea({ companies, fx = null }) {
  const out = [];
  for (const c of companies) {
    const price = c.price ?? null;
    // Shares come from DART's stock table: the common line, listed (after retirement and treasury).
    // That is the count the market capitalises and it reconciles with Naver (Hyundai 203.1M, LG Chem
    // 70.6M, Samsung 5.83B). Net income ÷ EPS is only a fallback for funds with no stock table — the
    // EPS feed rounds some filers to ₩1, which produced 13.2B shares for a 72M-share company.
    const annual = (c.reports || []).find((r) => r.report === 'annual') || null;
    // Both figures must agree in sign: a loss year paired with a positive per-share figure (or the
    // reverse) divides to a negative share count, which silently produced a negative market cap.
    const epsShares = annual && annual.netIncome && annual.eps && Math.sign(annual.netIncome) === Math.sign(annual.eps)
      ? annual.netIncome / annual.eps : null;
    let shares = c.shares || (epsShares > 0 ? epsShares : null) || null;
    // A handful of filers put capital where a share count belongs (LS에코에너지 filed 30.6 trillion
    // shares, 조선내화 11.8 billion). If the listed count is impossible beside the company's own revenue,
    // or an order of magnitude above what its EPS implies, the EPS count is the believable one.
    if (shares && epsShares > 0 && price != null) {
      const capGuess = price * shares;
      const absurd = (annual?.revenue && capGuess > annual.revenue * 10000) || shares > epsShares * 20;
      if (absurd) shares = epsShares;
    }
    const sharesDart = shares || null;
    // The market's own cap counts the shares listed today; DART's table is last year's count. When the
    // two disagree the market wins, and the share count is derived back from the cap so that
    // price × shares reproduces it exactly.
    const cap = c.naverCap ?? (price != null && shares > 0 ? price * shares : null);
    if (cap && price) shares = cap / price;

    const q = buildQuartersKr(saneReports(c.reports || []));
    const ttm = ttmKr(q);
    const fy = (c.reports || []).find((r) => r.report === 'annual') || null;
    // A quarterly window can be filed as a cumulative figure (the 2026 Samsung Q1/H1 rows are the
    // clearest case: TTM net income came to 3.3× the annual). If the four-quarter window is more than
    // 2.5× the annual profit — or more than twice its revenue — it is not a trailing year; use the
    // fiscal year and say so, rather than publish a P/E divided by a doubled profit.
    const ttmSuspicious = !!(fy && ttm.netIncome != null && (
      Math.abs(ttm.netIncome) > Math.abs(fy.netIncome || 0) * 2.5 ||
      (fy.revenue > 0 && ttm.revenue > fy.revenue * 2)
    ));
    const ttmUse = ttm.netIncome != null && !ttmSuspicious;

    // Growth uses the same shared helper as the US and Japan pages. DART does not fill a per-year
    // average share count consistently, so derive it from net income ÷ EPS when it is missing; that
    // is exactly the count that produced the reported EPS, and it lets the split check work.
    const annuals = (c.reports || [])
      .filter((r) => r.report === 'annual' && r.end)
      .sort((a, b) => String(a.end).localeCompare(String(b.end)));
    const sharesOf = (r) => {
      if (r.sharesOutstanding > 0) return r.sharesOutstanding;
      if (r.netIncome != null && r.eps && Math.sign(r.netIncome) === Math.sign(r.eps)) return r.netIncome / r.eps;
      return shares > 0 ? shares : null;
    };
    const epsOf = (r) => {
      if (r.eps != null) return r.eps;
      if (r.netIncome != null && shares > 0) return +(r.netIncome / shares).toFixed(2);
      return null;
    };
    const growth = growthRates(annuals.slice(-5).map((r) => ({
      year: Number(String(r.end).slice(0, 4)),
      revenue: r.revenue,
      eps: epsOf(r),
      shares: sharesOf(r),
    })));
    const gFirst = annuals.slice(-5)[0] || null;
    const gLast = annuals.slice(-5).at(-1) || null;
    const marginDelta = gFirst && gLast && gFirst.revenue > 0 && gLast.revenue > 0
      && gFirst.netIncome != null && gLast.netIncome != null
      ? +(((gLast.netIncome / gLast.revenue) - (gFirst.netIncome / gFirst.revenue)) * 100).toFixed(1)
      : null;

    // Keep every flow line on one basis. Falling back per field mixed a fiscal-year operating profit
    // with trailing revenue and printed a margin that belonged to neither period.
    const basis = ttmUse ? 'TTM' : 'FY';
    const ni = basis === 'TTM' ? ttm.netIncome : (fy ? fy.netIncome : null);
    const rev = basis === 'TTM' ? ttm.revenue : (fy ? fy.revenue : null);
    const op = basis === 'TTM' ? ttm.operatingProfit : (fy ? fy.operatingProfit : null);

    const equity = fy ? fy.equity : null;
    const cfo = fy ? fy.operatingCashFlow : null;
    const cfi = fy ? fy.investingCashFlow : null;
    const fcf = cfo != null && cfi != null ? cfo + cfi : null;
    // A P/E under 0.01 is not a cheap stock, it is a division by a rounding artefact (a quarterly profit
    // larger than the whole company). Publish no P/E rather than a zero.
    const peRaw = cap && ni > 0 ? cap / ni : null;

    out.push({
      ...c,
      marketCap: cap,
      marketCapUsd: cap && fx ? Math.round(cap / fx) : null,
      // Publish the count the cap was actually built from, so price × shares reconciles on screen.
      shares: shares || null,
      sharesDart,
      sharesBasis: c.naverCap ? 'market' : 'filing',
      sharesIssued: c.sharesIssued || null,
      currency: 'KRW',
      pe: peRaw != null && peRaw > 0.01 ? round(guard(peRaw, 0, 500), 2) : null,
      peBasis: basis,
      pb: round(guard(cap && equity > 0 ? cap / equity : null, 0, 50), 2),
      // ROE needs positive book equity: dividing by negative equity flips the sign, so a profitable
      // company with negative equity would print a loss-like ROE.
      roe: equity > 0 && ni != null ? round((ni / equity) * 100, 1) : null,
      opMargin: rev && op != null ? round((op / rev) * 100, 1) : null,
      netMargin: rev && ni != null ? round((ni / rev) * 100, 1) : null,
      fcf,
      fcfYield: cap && fcf != null ? round((fcf / cap) * 100, 2) : null,
      ...growth,
      marginDelta,
      quarters: q.slice(-8),
      quartersBasis: 'reported',
      ...(ttmSuspicious ? { ttmSuspicious: true, ttmFromFY: true } : {}),
      history: (c.reports || []).filter((r) => r.report === 'annual').slice(-5).map((r) => ({
        y: r.end, s: r.revenue, o: r.operatingProfit, n: r.netIncome, q: r.equity, a: r.assets,
        c: r.operatingCashFlow, i: r.investingCashFlow, e: r.eps,
      })),
    });
  }
  return out;
}
