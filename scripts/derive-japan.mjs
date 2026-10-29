// Japan ratio derivation, separated from fetching so it can be tested without an API key.
//
// Japanese summaries report *fiscal year* figures plus the company's own full-year forecast. We publish
// the FY basis (labelled with the period end) and a forward P/E built from guidance — never consensus.

const guard = (v, lo, hi) => (v != null && v > lo && v < hi ? v : null);
const round = (v, dp) => (v == null ? null : +v.toFixed(dp));

export function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function deriveJapan({ ranked, fins, series, nextByCode = new Map(), fx = null }) {
  const companies = [];
  for (const c of ranked) {
    const rows = fins.get(c.code) || [];
    const fy = rows
      .filter((r) => r.CurPerType === 'FY' && num(r.Sales) != null)
      .sort((a, b) => String(a.CurPerEn).localeCompare(String(b.CurPerEn)));
    const last = fy[fy.length - 1] || null;
    const s = [...(series.get(c.code) || [])].sort((a, b) => a.d.localeCompare(b.d));
    const price = s.length ? s[s.length - 1].c : null;
    const cap = c.cap || null;

    const sales = last ? num(last.Sales) : null;
    const op = last ? num(last.OP) : null;
    const np = last ? num(last.NP) : null;
    const eps = last ? num(last.EPS) : null;
    const bps = last ? num(last.BPS) : null;
    const ta = last ? num(last.TA) : null;
    const eq = last ? num(last.Eq) : null;
    const cfo = last ? num(last.CFO) : null;
    const cfi = last ? num(last.CFI) : null;
    // Investing cash flow contains capex; the summary does not break it out. Label it honestly.
    const fcf = cfo != null && cfi != null ? cfo + cfi : null;

    const guided = rows
      .filter((r) => num(r.FNP) != null || num(r.FEPS) != null)
      .sort((a, b) => String(a.DiscDate).localeCompare(String(b.DiscDate)));
    const g = guided[guided.length - 1] || null;
    const gNp = g ? num(g.FNP) : null;
    const gEps = g ? num(g.FEPS) : null;
    // Shares come from market cap ÷ price, not equity ÷ BPS: Japanese summaries do not restate BPS for
    // splits, so the filing-derived count is wrong for any company that has split (Tokyo Electron, SMFG).
    const shares = cap && price ? cap / price : null;

    const ytdBase = s.find((p) => p.d >= `${new Date().getUTCFullYear()}-01-01`);
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
      series: s.slice(-180).map((p) => ({ d: p.d, c: p.c })),
      chg1d: s.length > 1 ? +(((s[s.length - 1].c / s[s.length - 2].c) - 1) * 100).toFixed(2) : null,
      chg6m: sixBase && sixBase.c ? +(((price / sixBase.c) - 1) * 100).toFixed(2) : null,
      chgYtd: ytdBase && ytdBase.c ? +(((price / ytdBase.c) - 1) * 100).toFixed(2) : null,
      period: last ? last.CurPerEn : null,
      basis: 'FY',
      sales, op, np, eps, bps, ta, eq, cfo, cfi, fcf,
      pe: round(guard(cap && np ? cap / np : null, 0, 500), 2),
      pb: round(guard(cap && eq ? cap / eq : null, 0, 50), 2),
      roe: eq && np ? +((np / eq) * 100).toFixed(1) : null,
      opMargin: sales && op != null ? +((op / sales) * 100).toFixed(1) : null,
      fcfYield: cap && fcf ? +((fcf / cap) * 100).toFixed(2) : null,
      shares,
      guidance: g ? {
        fy: g.CurFYEn || null,
        sales: num(g.FSales), op: num(g.FOP), np: gNp, eps: gEps,
        basis: 'company guidance, not consensus',
      } : null,
      // Only the profit forecast is used: EPS guidance is not split-adjusted either, so dividing the
      // market cap by it would overstate the multiple for any company that has split.
      forwardPe: round(guard(cap && gNp > 0 ? cap / gNp : null, 0, 500), 1),
      earnings: nextByCode.get(c.code) || null,
    });
  }
  return companies;
}
