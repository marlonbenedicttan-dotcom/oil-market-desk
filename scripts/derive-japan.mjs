// Japan ratio derivation, separated from fetching so it can be tested without an API key.
//
// Two sources, and they are not interchangeable:
//   1. JPX's own valuation endpoint — PER and ROE on a TTM basis, FwdPER from company guidance, and a
//      market cap that excludes treasury shares and is split-adjusted. This is what we publish.
//   2. The company's summary of financial statements — the fiscal-year figures we show as the statement
//      block, and the equity we re-derive P/B from as a cross-check.
//
// Where the two disagree on P/B by more than 5%, both values are kept and the page says so.

const guard = (v, lo, hi) => (v != null && v > lo && v < hi ? v : null);
const round = (v, dp) => (v == null ? null : +v.toFixed(dp));

export function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const TOLERANCE = 0.05;

export function deriveJapan({ ranked, fins, series, val = new Map(), nextByCode = new Map(), fx = null }) {
  const companies = [];
  for (const c of ranked) {
    const rows = fins.get(c.code) || [];
    const fy = rows
      .filter((r) => r.CurPerType === 'FY' && num(r.Sales) != null)
      .sort((a, b) => String(a.CurPerEn).localeCompare(String(b.CurPerEn)));
    const last = fy[fy.length - 1] || null;
    const s = [...(series.get(c.code) || [])].sort((a, b) => a.d.localeCompare(b.d));
    const price = s.length ? s[s.length - 1].c : null;
    const jpx = val.get(c.code) || null;

    // JPX's cap is the authority: ex-treasury, split-adjusted, and the bars field is being retired.
    const cap = jpx?.MktCap ? jpx.MktCap * 1e6 : (c.cap || null);

    const sales = last ? num(last.Sales) : null;
    const op = last ? num(last.OP) : null;
    const odp = last ? num(last.OdP) : null;
    const np = last ? num(last.NP) : null;
    const ta = last ? num(last.TA) : null;
    // Shareholders' equity attributable to the parent — not total equity including non-controlling
    // interests. Market cap is the parent's value, so P/B must divide by the parent's equity.
    const eqOf = (r) => (r ? (num(r.ShEq) ?? num(r.Eq)) : null);
    const eq = last ? eqOf(last) : null;
    // JPX's BPS uses the most recently disclosed period, which by late in the year is a quarter, not
    // the fiscal year. Comparing our fiscal-year equity against it would look like a 10% dispute.
    const latestEqRow = rows
      .filter((r) => eqOf(r) != null && r.CurPerEn)
      .sort((a, b) => String(a.CurPerEn).localeCompare(String(b.CurPerEn)))
      .pop() || null;
    const eqLatest = latestEqRow ? eqOf(latestEqRow) : eq;
    const eqLatestPeriod = latestEqRow ? latestEqRow.CurPerEn : (last ? last.CurPerEn : null);
    const eqAr = last ? num(last.EqAR) : null;
    const cash = last ? num(last.CashEq) : null;
    const cfo = last ? num(last.CFO) : null;
    const cfi = last ? num(last.CFI) : null;
    const cff = last ? num(last.CFF) : null;
    // Investing cash flow contains capex; the summary does not break it out. Label it honestly.
    // For a bank, investing cash flow is loans and securities — not free cash flow, so it is withheld.
    const financial = ['Banks', 'Insurance', 'Securities & Commodity Futures', 'Other Financials'].includes(c.sector);
    const fcf = !financial && cfo != null && cfi != null ? cfo + cfi : null;

    // Banks do not report operating profit; ordinary profit is the line they publish.
    const marginBase = op != null ? op : odp;
    const marginBasis = op != null ? 'operating' : odp != null ? 'ordinary' : null;

    const guided = rows
      .filter((r) => num(r.FNP) != null || num(r.FEPS) != null)
      .sort((a, b) => String(a.DiscDate).localeCompare(String(b.DiscDate)));
    const g = guided[guided.length - 1] || null;
    const gNp = g ? num(g.FNP) : null;

    // Dividends: the latest annual figure, plus the forecast the company published for the next year.
    const divAnn = last ? num(last.DivAnn) : null;
    const divTotal = last ? num(last.DivTotalAnn) : null;
    const payout = last ? num(last.PayoutRatioAnn) : null;
    const fDivAnn = g ? num(g.FDivAnn) : null;

    // JPX ratios where present, otherwise our own fiscal-year derivation.
    const pe = jpx?.PER != null ? round(jpx.PER, 2) : round(guard(cap && np > 0 ? cap / np : null, 0, 500), 2);
    const peBasis = jpx?.PER != null ? 'TTM' : 'FY';
    const pb = jpx?.PBR != null ? round(jpx.PBR, 2) : round(guard(cap && eq > 0 ? cap / eq : null, 0, 50), 2);
    const roe = jpx?.ROE != null ? round(jpx.ROE * 100, 1) : eqLatest && np ? round((np / eqLatest) * 100, 1) : null;
    const forwardPe = jpx?.FwdPER != null ? round(jpx.FwdPER, 1) : round(guard(cap && gNp > 0 ? cap / gNp : null, 0, 500), 1);
    const eps = jpx?.EPS != null ? jpx.EPS : last ? num(last.EPS) : null;
    const bps = jpx?.BPS != null ? jpx.BPS : last ? num(last.BPS) : null;
    const fwdEps = jpx?.FwdEPS != null ? jpx.FwdEPS : g ? num(g.FEPS) : null;

    // Shares come from market cap ÷ price, not equity ÷ BPS: BPS is not restated for splits.
    const shares = cap && price ? cap / price : null;

    // Cross-check: P/B rebuilt from the filing's equity against the exchange's P/B.
    const pbOurs = cap && eqLatest > 0 ? cap / eqLatest : null;
    let verification = { status: 'unchecked', checked: 0 };
    if (jpx?.PBR != null && pbOurs != null) {
      const diff = Math.abs(pbOurs - jpx.PBR) / jpx.PBR;
      verification = {
        status: diff <= TOLERANCE ? 'verified' : 'disputed',
        checked: 1,
        fields: diff <= TOLERANCE ? {} : { equity: { ours: round(pbOurs, 2), alt: jpx.PBR, diff: round(diff, 3) } },
      };
    }

    const jan1 = `${new Date().getUTCFullYear()}-01-01`;
    const ytdBase = s.find((p) => p.d >= jan1);
    // If the history starts after January, say so rather than calling it a year-to-date return.
    const ytdPartial = !!ytdBase && ytdBase.d > `${new Date().getUTCFullYear()}-01-20`;
    const sixBase = s[Math.max(0, s.length - 126)];

    companies.push({
      code: c.code,
      ticker: c.ticker,
      name: c.name,
      nameJa: c.nameJa,
      sector: c.sector,
      size: c.size,
      currency: 'JPY',
      price,
      priceDate: s.length ? s[s.length - 1].d : null,
      marketCap: cap,
      marketCapUsd: cap && fx ? Math.round(cap / fx) : null,
      series: s.map((p) => ({ d: p.d, c: p.c })),
      chg1d: s.length > 1 ? round(((s[s.length - 1].c / s[s.length - 2].c) - 1) * 100, 2) : null,
      chg6m: sixBase && sixBase.c ? round(((price / sixBase.c) - 1) * 100, 2) : null,
      chgYtd: ytdBase && ytdBase.c ? round(((price / ytdBase.c) - 1) * 100, 2) : null,
      chgYtdBasis: ytdPartial ? `since ${ytdBase.d}` : 'YTD',
      period: last ? last.CurPerEn : null,
      basis: 'FY',
      sales, op, odp, np, ta, eq, eqLatest, eqLatestPeriod, eqAr, cash, cfo, cfi, cff, fcf,
      eps, bps, fwdEps,
      pe, peBasis, pb, roe, forwardPe,
      opMargin: sales && marginBase != null ? round((marginBase / sales) * 100, 1) : null,
      marginBasis,
      fcfYield: cap && fcf ? round((fcf / cap) * 100, 2) : null,
      shares,
      dividend: divAnn != null ? {
        perShare: divAnn, total: divTotal, payoutRatio: payout, forecast: fDivAnn,
        yield: price ? round((divAnn / price) * 100, 2) : null,
        forecastYield: price && fDivAnn ? round((fDivAnn / price) * 100, 2) : null,
      } : null,
      guidance: g ? {
        fy: g.CurFYEn || null,
        sales: num(g.FSales), op: num(g.FOP), np: gNp, eps: num(g.FEPS),
        basis: 'company guidance, not consensus',
      } : null,
      jpx: jpx ? {
        per: jpx.PER, pbr: jpx.PBR, roe: jpx.ROE, fwdPer: jpx.FwdPER, fwdRoe: jpx.FwdROE,
        eps: jpx.EPS, bps: jpx.BPS, marketCap: cap,
      } : null,
      verification,
      earnings: nextByCode.get(c.code) || null,
    });
  }
  return companies;
}
