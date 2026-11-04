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

import { growthRates } from '../src/growth.js';

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
    // Market cap belongs to today's share count, not the diluted weighted-average the filing used
    // for EPS. A placement after the period end otherwise leaves the cap (and P/E, P/B) stale.
    const sharesForCap = c.sharesCurrent > 0 ? c.sharesCurrent : shares;
    const cap = c.marketCap ?? (price != null && sharesForCap > 0 ? price * sharesForCap : null);   // listing currency
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
    // The same trailing profit the P/E uses, published as its own field so the company page and the
    // list can show it without re-deriving. A company whose vendor page has no trailing column still
    // gets its fiscal-year profit, flagged: a four-quarter figure and a year-end figure are not the
    // same thing, and the label must not pretend they are.
    const niAsOf = ttm.netIncome != null ? (c.ttmEnd || null) : (fy ? fy.end : null);

    // P/B and ROE belong to the ordinary shareholders, so both sides use common equity (excluding
    // non-controlling interests). Dividing a parent-only market cap by total equity (which includes
    // minorities) understates both: BHP's minority is ~10% of book but a quarter of earnings, which
    // turned a 19% ROE into 17.5% on the old total-equity denominator.
    const equity = latest.equityCommon ?? latest.equity ?? (fy ? (fy.equityCommon ?? fy.equity) : null);
    // Total equity is kept only for reconciling against the vendor, whose P/B and ROE divide by it.
    // The published `pb`/`roe` stay on common equity, the ordinary shareholders' claim.
    const equityTotal = latest.equity ?? (fy ? fy.equity : null);
    const cfo = ttm.operatingCashFlow ?? (fy ? fy.operatingCashFlow : null);
    const cfi = ttm.investingCashFlow ?? (fy ? fy.investingCashFlow : null);
    const capex = ttm.capitalExpenditure ?? (fy ? fy.capitalExpenditure : null);
    const fcfReported = ttm.freeCashFlow ?? (fy ? fy.freeCashFlow : null);
    // Free cash flow is operating cash flow minus capital expenditure, not operating plus *all*
    // investing flow: acquisitions and purchases of investments are not maintenance capex. The
    // vendor publishes that exact number, so use it first; the line items are the fallback, and
    // CFO + CFI is only the last resort when neither is available.
    const fcf = fcfReported ?? (cfo != null && capex != null ? cfo - Math.abs(capex) : (cfo != null && cfi != null ? cfo + cfi : null));
    // Which period the cash figures belong to. Income and cash can have different vendor pages, so the
    // label follows the cash line, not the P/E basis.
    const cashTrailing = ttm.operatingCashFlow != null || ttm.investingCashFlow != null
      || ttm.freeCashFlow != null || ttm.capitalExpenditure != null;
    const fcfBasis = fcf == null ? null : (cashTrailing ? 'TTM' : 'FY');
    const fcfMargin = fcf != null && rev > 0 && Math.abs((fcf / rev) * 100) <= 100
      ? round((fcf / rev) * 100, 1) : null;
    // Profit that never becomes cash is not profit — but a loss makes the ratio unreadable, so it is
    // computed against positive earnings only, exactly as the US page does.
    const cashConversion = fcf != null && ni > 0 && Math.abs(fcf / ni) <= 5 ? round(fcf / ni, 2) : null;

    // A P/E under 0.5 is a division by a one-off gain or a rounding artefact, not a cheap stock: a
    // Guangzhou developer emerging from restructuring can print a 0.02× "P/E" on a debt write-back.
    // Withhold it rather than let a reader think the equity is free. A margin beyond ±500% means
    // revenue is too small to be a denominator (a pre-revenue explorer, or a holding company whose
    // income is associates), so it is withheld too instead of printed as 58,000,000%.
    const peRaw = capRep && ni > 0 ? capRep / ni : null;
    const peOk = peRaw != null && peRaw >= 0.5;
    const pbTotal = capRep && equityTotal > 0 ? round(guard(capRep / equityTotal, 0, 50), 2) : null;
    const roeTotal = equityTotal > 0 && ni != null && Math.abs(ni / equityTotal) <= 10
      ? round((ni / equityTotal) * 100, 1) : null;
    // The vendor's ROE can be the prior fiscal year while ours is TTM; these let the audit tell a
    // period difference from a formula error.
    const roeFY = fy && fy.netIncome != null && fy.equity > 0 && Math.abs(fy.netIncome / fy.equity) <= 10
      ? round((fy.netIncome / fy.equity) * 100, 1) : null;
    const priorFY = annual.length >= 2 ? annual[annual.length - 2] : null;
    const roePriorFY = priorFY && priorFY.netIncome != null && priorFY.equity > 0 && Math.abs(priorFY.netIncome / priorFY.equity) <= 10
      ? round((priorFY.netIncome / priorFY.equity) * 100, 1) : null;
    const marginOf = (v) => (rev > 0 && v != null && Math.abs(v / rev) <= 5 ? round((v / rev) * 100, 1) : null);

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
    if (peOk) pes.push(peRaw);
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

    // --- growth (same rules as the US and Japan pages) --------------------------------------------
    // The shared helper handles the split check: a near-integer jump in the average share count
    // restates prior EPS onto the latest basis, so a split is not published as a profit collapse.
    const growthRows = annual.slice(-5).map((r) => ({
      year: Number(String(r.end).slice(0, 4)),
      revenue: r.revenue,
      eps: r.eps,
      shares: r.shares > 0 ? r.shares : (r.netIncome != null && r.eps ? r.netIncome / r.eps : null),
    }));
    const growth = growthRates(growthRows);
    const gFirst = annual.slice(-5)[0] || null;
    const gLast = annual.slice(-5).at(-1) || null;
    const marginDelta = gFirst && gLast && gFirst.revenue > 0 && gLast.revenue > 0
      && gFirst.netIncome != null && gLast.netIncome != null
      ? +(((gLast.netIncome / gLast.revenue) - (gFirst.netIncome / gFirst.revenue)) * 100).toFixed(1)
      : null;
    const epsTTM = ttm.eps != null
      ? ttm.eps
      : (ni != null && shares > 0 && !c.crossListing ? +(ni / shares).toFixed(2) : null);

    // Dividend per share arrives in the statement currency; the price is in the listing currency.
    // Use the latest annual DPS, which is the figure the vendor's own yield uses. The trailing
    // column is not a trailing-twelve-month dividend for every issuer (NAB prints 2× the annual),
    // so it is only the fallback when the annual row has no DPS.
    const dpsAnnual = fy && fy.dividendPerShare != null ? fy.dividendPerShare : null;
    const dps = dpsAnnual ?? ttm.dividendPerShare ?? null;
    const dpsRate = perReport(ccy);
    const yieldRaw = dps > 0 && price > 0 && dpsRate != null ? ((dps * dpsRate) / price) * 100 : null;
    // The vendor's own yield already converts the dividend at the payment-date rate and uses the
    // count it considers current. Use it when the side file has one; the filed DPS is the fallback.
    const vendorYield = Number.isFinite(c.vendorDividendYield) && c.vendorDividendYield >= 0 && c.vendorDividendYield < 30
      ? c.vendorDividendYield : null;
    const dividendYield = vendorYield ?? (yieldRaw != null ? round(guard(yieldRaw, 0, 30), 2) : null);

    out.push({
      ...c,
      marketCap: cap,
      marketCapUsd: cap != null && usdRate ? Math.round(cap / usdRate) : null,
      shares: shares || null,
      sharesCurrent: c.sharesCurrent > 0 ? c.sharesCurrent : null,
      // Preserve a cross-listing / SEC note; a bare "filing" is replaced by the current-share label.
      sharesBasis: (c.sharesBasis && !/^filing$/i.test(c.sharesBasis))
        ? c.sharesBasis
        : (c.sharesCurrent > 0 ? 'current (vendor)' : 'filing'),
      currency: base,
      reportCurrency: ccy,
      pe: peOk ? round(guard(peRaw, 0, 500), 2) : null,
      peBasis: basis,
      netIncomeTTM: ni,
      netIncomeTTMAsOf: niAsOf,
      ...(ttm.netIncome == null && ni != null ? { ttmFromFY: true } : {}),
      pb: round(guard(capRep && equity > 0 ? capRep / equity : null, 0, 50), 2),
      pbTotal,
      // Near-zero book equity turns a small loss into a four-digit "ROE" that says nothing about the
      // business. Publish no ROE instead of a number that reads as a collapse.
      roe: equity > 0 && ni != null && Math.abs(ni / equity) <= 10 ? round((ni / equity) * 100, 1) : null,
      roeTotal,
      roeFY,
      roePriorFY,
      opMargin: marginOf(op),
      netMargin: marginOf(ni),
      fcf,
      fcfBasis,
      fcfYield: capRep && fcf != null ? round((fcf / capRep) * 100, 2) : null,
      fcfMargin,
      cashConversion,
      dividendYield,
      dividendYieldBasis: vendorYield != null ? 'vendor' : (dps == null ? null : (dpsAnnual != null ? 'FY' : 'TTM')),
      ...growth,
      marginDelta,
      epsTTM,
      epsTTMBasis: epsTTM == null ? null : (ttm.eps != null ? 'reported' : 'net income ÷ shares'),
      history: annual.slice(-5).map((r) => ({
        y: r.end, s: r.revenue, o: r.operatingProfit, n: r.netIncome,
        q: r.equity ?? r.equityCommon, ec: r.equityCommon ?? r.equity,
        a: r.assets, c: r.operatingCashFlow, i: r.investingCashFlow, x: r.capitalExpenditure,
      })),
      quarters: (c.quarters || []),
      bands,
    });
  }
  return out;
}
