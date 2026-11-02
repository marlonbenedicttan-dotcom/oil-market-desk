// Taiwan ratio derivation, separated from fetching so the maths can be tested without the network.
//
// Taiwan's statements are cumulative (Q1, H1, Q3, annual), but the statement source already publishes
// a TTM column, so the build carries TTM income/cash figures and the four most recent quarterly rows.
// Everything here is a guard around the same ratios the other three markets use.

const round = (v, dp) => (v == null ? null : +v.toFixed(dp));
const guard = (v, lo, hi) => (v != null && v > lo && v < hi ? v : null);

export function deriveTaiwan({ companies, fx = null }) {
  const out = [];
  for (const c of companies) {
    const price = c.price ?? null;
    const shares = c.shares ?? null;
    const cap = c.marketCap ?? (price != null && shares > 0 ? price * shares : null);
    const ttm = c.ttm || {};
    const latest = c.latest || {};
    const annual = (c.annual || []).filter((r) => r && r.end).sort((a, b) => String(a.end).localeCompare(String(b.end)));
    const fy = annual[annual.length - 1] || null;

    const ni = ttm.netIncome ?? (fy ? fy.netIncome : null);
    const rev = ttm.revenue ?? (fy ? fy.revenue : null);
    const op = ttm.operatingProfit ?? (fy ? fy.operatingProfit : null);
    const basis = ttm.netIncome != null ? 'TTM' : 'FY';

    const equity = latest.equity ?? (fy ? fy.equity : null);
    const cfo = ttm.operatingCashFlow ?? (fy ? fy.operatingCashFlow : null);
    const cfi = ttm.investingCashFlow ?? (fy ? fy.investingCashFlow : null);
    const fcf = cfo != null && cfi != null ? cfo + cfi : (ttm.freeCashFlow ?? null);

    // A P/E under 0.01 is a division by a rounding artefact, not a cheap stock.
    const peRaw = cap && ni > 0 ? cap / ni : null;

    // Five-year P/E band: the price at each fiscal year end against that year's diluted EPS.
    const yearEnd = c.yearEnd || {};
    const pes = [];
    for (const r of annual) {
      const y = String(r.end).slice(0, 4);
      const px = yearEnd[y];
      if (px && r.eps > 0) pes.push(px / r.eps);
    }
    if (peRaw != null && peRaw > 0.01) pes.push(peRaw);
    const a = pes.filter((x) => x > 0 && x < 500).sort((x, y) => x - y);
    let bands = null;
    if (a.length >= 3) {
      const at = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
      bands = {
        pe: {
          min: +at(0).toFixed(2), median: +at(0.5).toFixed(2), max: +at(1).toFixed(2),
          percentile: Math.round((a.filter((x) => x <= peRaw).length / a.length) * 100), n: a.length,
        },
      };
    }

    out.push({
      ...c,
      marketCap: cap,
      marketCapUsd: cap && fx ? Math.round(cap / fx) : null,
      shares: shares || null,
      sharesBasis: 'filing',
      currency: 'TWD',
      pe: peRaw != null && peRaw > 0.01 ? round(guard(peRaw, 0, 500), 2) : null,
      peBasis: basis,
      pb: round(guard(cap && equity > 0 ? cap / equity : null, 0, 50), 2),
      // Near-zero book equity turns a small loss into a four-digit "ROE" that says nothing about the
      // business. Publish no ROE instead of a number that reads as a collapse.
      roe: equity > 0 && ni != null && Math.abs(ni / equity) <= 10 ? round((ni / equity) * 100, 1) : null,
      opMargin: rev && op != null ? round((op / rev) * 100, 1) : null,
      netMargin: rev && ni != null ? round((ni / rev) * 100, 1) : null,
      fcf,
      fcfYield: cap && fcf != null ? round((fcf / cap) * 100, 2) : null,
      years: undefined,      history: annual.slice(-5).map((r) => ({
        y: r.end, s: r.revenue, o: r.operatingProfit, n: r.netIncome, q: r.equity, a: r.assets,
        c: r.operatingCashFlow, i: r.investingCashFlow,
      })),
      quarters: (c.quarters || []).slice(-8),
      bands,
    });
  }
  return out;
}
