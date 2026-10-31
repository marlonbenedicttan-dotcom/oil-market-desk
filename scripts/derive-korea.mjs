// Korea ratio derivation, separated from fetching so the maths can be tested without an API key.
//
// Korean companies report cumulative figures four times a year — Q1 (3 months), H1 (6), Q3 (9) and the
// annual (12) — exactly like Japan. Standalone quarters are the differences, and the annual report is
// the fourth quarter. There is no Q4 filing.

const round = (v, dp) => (v == null ? null : +v.toFixed(dp));
const guard = (v, lo, hi) => (v != null && v > lo && v < hi ? v : null);

// rows: [{ report: 'q1'|'h1'|'q3'|'annual', end: 'YYYY-MM-DD', revenue, operatingProfit, netIncome }]
export function buildQuartersKr(rows) {
  const byYear = new Map();
  for (const r of rows) {
    if (!r.end) continue;
    const fy = String(r.end).slice(0, 4);
    if (!byYear.has(fy)) byYear.set(fy, {});
    byYear.get(fy)[r.report] = r;
  }
  const out = [];
  for (const [fy, rec] of byYear) {
    const flow = (field) => {
      const q1 = rec.q1 ? rec.q1[field] : null;
      const h1 = rec.h1 ? rec.h1[field] : null;
      const q3 = rec.q3 ? rec.q3[field] : null;
      const fy12 = rec.annual ? rec.annual[field] : null;
      return {
        q1,
        q2: q1 != null && h1 != null ? h1 - q1 : null,
        q3: h1 != null && q3 != null ? q3 - h1 : null,
        q4: q3 != null && fy12 != null ? fy12 - q3 : null,
      };
    };
    const rev = flow('revenue');
    const op = flow('operatingProfit');
    const ni = flow('netIncome');
    const ends = {
      q1: rec.q1?.end, q2: rec.h1?.end, q3: rec.q3?.end, q4: rec.annual?.end,
    };
    for (const k of ['q1', 'q2', 'q3', 'q4']) {
      if (!ends[k] || rev[k] == null) continue;
      out.push({ d: ends[k], fy, q: k.toUpperCase(), revenue: rev[k], operatingProfit: op[k], netIncome: ni[k] });
    }
  }
  return out.sort((a, b) => a.d.localeCompare(b.d));
}

// A Korean company's fiscal year is December for almost everyone, so TTM = the four most recent
// standalone quarters. When a quarter is missing the FY figure is used and labelled as such.
export function ttmKr(quarters) {
  const last = quarters.slice(-4);
  if (last.length === 4) {
    const sum = (f) => (last.every((q) => q[f] != null) ? last.reduce((a, q) => a + q[f], 0) : null);
    return { revenue: sum('revenue'), operatingProfit: sum('operatingProfit'), netIncome: sum('netIncome'), basis: 'TTM', n: 4 };
  }
  return { revenue: null, operatingProfit: null, netIncome: null, basis: 'FY', n: last.length };
}

export function deriveKorea({ companies, fx = null }) {
  const out = [];
  for (const c of companies) {
    const price = c.price ?? null;
    // Shares from net income ÷ basic EPS where both exist: DART's stock table counts issued shares,
    // which for a company that has cancelled treasury stock is not the count the market capitalises.
    const annual = (c.reports || []).find((r) => r.report === 'annual') || null;
    // Both figures must agree in sign: a loss year paired with a positive per-share figure (or the
    // reverse) divides to a negative share count, which silently produced a negative market cap.
    const epsShares = annual && annual.netIncome && annual.eps && Math.sign(annual.netIncome) === Math.sign(annual.eps)
      ? annual.netIncome / annual.eps : null;
    const shares = (epsShares > 0 ? epsShares : null) || c.shares || null;
    const cap = price != null && shares > 0 ? price * shares : null;

    const q = buildQuartersKr(c.reports || []);
    const ttm = ttmKr(q);
    const fy = (c.reports || []).find((r) => r.report === 'annual') || null;

    const ni = ttm.netIncome ?? (fy ? fy.netIncome : null);
    const rev = ttm.revenue ?? (fy ? fy.revenue : null);
    const op = ttm.operatingProfit ?? (fy ? fy.operatingProfit : null);
    const basis = ttm.netIncome != null ? 'TTM' : 'FY';

    const equity = fy ? fy.equity : null;
    const cfo = fy ? fy.operatingCashFlow : null;
    const cfi = fy ? fy.investingCashFlow : null;
    const fcf = cfo != null && cfi != null ? cfo + cfi : null;

    out.push({
      ...c,
      marketCap: cap,
      marketCapUsd: cap && fx ? Math.round(cap / fx) : null,
      // Publish the count the cap was actually built from, so price × shares reconciles on screen.
      shares: shares || null,
      sharesIssued: c.shares || null,
      currency: 'KRW',
      pe: round(guard(cap && ni > 0 ? cap / ni : null, 0, 500), 2),
      peBasis: basis,
      pb: round(guard(cap && equity > 0 ? cap / equity : null, 0, 50), 2),
      // ROE needs positive book equity: dividing by negative equity flips the sign, so a profitable
      // company with negative equity would print a loss-like ROE.
      roe: equity > 0 && ni != null ? round((ni / equity) * 100, 1) : null,
      opMargin: rev && op != null ? round((op / rev) * 100, 1) : null,
      netMargin: rev && ni != null ? round((ni / rev) * 100, 1) : null,
      fcf,
      fcfYield: cap && fcf != null ? round((fcf / cap) * 100, 2) : null,
      quarters: q.slice(-8),
      history: (c.reports || []).filter((r) => r.report === 'annual').slice(-5).map((r) => ({
        y: r.end, s: r.revenue, o: r.operatingProfit, n: r.netIncome, q: r.equity, a: r.assets,
        c: r.operatingCashFlow, i: r.investingCashFlow,
      })),
    });
  }
  return out;
}
