// One ratio engine for every non-US listing.
//
// Hong Kong taught this market class the hard part: the listing currency and the statement currency are
// not always the same. A Hong Kong listing trades in HKD but Alibaba reports in CNY and HSBC in USD; an
// ASX listing trades in AUD but BHP and RIO report in USD. A market cap in HKD divided by a CNY profit
// is not a P/E, and an AUD cap over a USD profit is wrong by roughly 35%. So every ratio is computed in
// the statement currency, with the listing-currency cap converted at the build's rate; prices, returns
// and the screen's market cap stay in the listing currency.
//
// `baseCurrency` is the listing currency. `fx.rate` is units of the listing currency per USD, and
// `fx.rates` is the er-api USD table (currency per USD), so the cross is rates[base] / rates[report].

const round = (v, dp) => (v == null ? null : +v.toFixed(dp));
const guard = (v, lo, hi) => (v != null && v > lo && v < hi ? v : null);

export function deriveListing({ companies, fx = null, baseCurrency = 'HKD' }) {
  const out = [];
  const base = String(baseCurrency || 'HKD').toUpperCase();
  // FX crosses from one USD table (rates[X] = units of X per USD).
  //   perBase(ccy)   = units of the report currency per unit of the listing currency (cap and price)
  //   perReport(ccy) = units of the listing currency per unit of the report currency (dividend per share)
  // The two are inverses; using one where the other belongs is how a cap ends up ~20% off.
  const rates = (fx && fx.rates) || null;
  const usdRate = (fx && fx.rate) || null;
  const perBase = (ccy) => {
    if (!ccy || ccy === base) return 1;
    if (!rates || !rates[base] || !rates[ccy]) return null;
    return rates[ccy] / rates[base];
  };
  const perReport = (ccy) => {
    if (!ccy || ccy === base) return 1;
    if (!rates || !rates[base] || !rates[ccy]) return null;
    return rates[base] / rates[ccy];
  };

  for (const c of companies) {
    const price = c.price ?? null;
    const shares = c.shares ?? null;
    const cap = c.marketCap ?? (price != null && shares > 0 ? price * shares : null);   // listing currency
    const ccy = c.reportCurrency || base;
    const conv = perBase(ccy);
    // Ratios need a statement currency conversion. A foreign reporter whose rate is missing gets blanks.
    const capRep = cap != null && conv != null ? cap * conv : null;

    const ttm = c.ttm || {};
    const latest = c.latest || {};
    const annual = (c.annual || []).filter((r) => r && r.end).sort((a, b) => String(a.end).localeCompare(String(b.end)));
    const fy = annual[annual.length - 1] || null;

    const ni = ttm.netIncome ?? (fy ? fy.netIncome : null);
    const rev = ttm.revenue ?? (fy ? fy.revenue : null);
    const op = ttm.operatingProfit ?? (fy ? fy.operatingProfit : null);
    const basis = ttm.netIncome != null ? 'TTM' : 'FY';

    // P/B and ROE belong to the ordinary shareholders, so both sides use common equity (excluding
    // non-controlling interests). Dividing a parent-only market cap by total equity (which includes
    // minorities) understates both: BHP's minority is ~10% of book but a quarter of earnings, which
    // turned a 19% ROE into 17.5% on the old total-equity denominator.
    const equity = latest.equityCommon ?? latest.equity ?? (fy ? (fy.equityCommon ?? fy.equity) : null);
    const cfo = ttm.operatingCashFlow ?? (fy ? fy.operatingCashFlow : null);
    const cfi = ttm.investingCashFlow ?? (fy ? fy.investingCashFlow : null);
    const fcf = cfo != null && cfi != null ? cfo + cfi : (ttm.freeCashFlow ?? null);

    // A P/E under 0.01 is a division by a rounding artefact, not a cheap stock.
    const peRaw = capRep && ni > 0 ? capRep / ni : null;

    // Five-year P/E band: the year-end price against that year's diluted EPS. For a foreign-currency
    // reporter both sides are converted at the current rate — an approximation, and the honest one
    // available without a five-year FX history.
    const yearEnd = c.yearEnd || {};
    const pes = [];
    for (const r of annual) {
      const y = String(r.end).slice(0, 4);
      // The price at the fiscal year end, when the build had the series; the calendar year-end is only
      // a fallback (a June-year company would otherwise pair a December price with a June EPS).
      const px = r.px ?? yearEnd[y];
      if (px && r.eps > 0 && conv) pes.push((px * conv) / r.eps);
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

    // Dividend per share arrives in the statement currency; the price is in the listing currency.
    const dps = ttm.dividendPerShare ?? (fy ? fy.dividendPerShare : null);
    const dpsRate = perReport(ccy);
    const yieldRaw = dps > 0 && price > 0 && dpsRate != null ? ((dps * dpsRate) / price) * 100 : null;

    out.push({
      ...c,
      marketCap: cap,
      marketCapUsd: cap != null && usdRate ? Math.round(cap / usdRate) : null,
      shares: shares || null,
      sharesBasis: 'filing',
      currency: base,
      reportCurrency: ccy,
      pe: peRaw != null && peRaw > 0.01 ? round(guard(peRaw, 0, 500), 2) : null,
      peBasis: basis,
      pb: round(guard(capRep && equity > 0 ? capRep / equity : null, 0, 50), 2),
      // Near-zero book equity turns a small loss into a four-digit "ROE" that says nothing about the
      // business. Publish no ROE instead of a number that reads as a collapse.
      roe: equity > 0 && ni != null && Math.abs(ni / equity) <= 10 ? round((ni / equity) * 100, 1) : null,
      opMargin: rev && op != null ? round((op / rev) * 100, 1) : null,
      netMargin: rev && ni != null ? round((ni / rev) * 100, 1) : null,
      fcf,
      fcfYield: capRep && fcf != null ? round((fcf / capRep) * 100, 2) : null,
      dividendYield: round(guard(yieldRaw, 0, 30), 2),
      history: annual.slice(-5).map((r) => ({
        y: r.end, s: r.revenue, o: r.operatingProfit, n: r.netIncome,
        q: r.equity ?? r.equityCommon, ec: r.equityCommon ?? r.equity,
        a: r.assets, c: r.operatingCashFlow, i: r.investingCashFlow,
      })),
      quarters: (c.quarters || []).slice(-8),
      bands,
    });
  }
  return out;
}
