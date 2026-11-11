// Japan ratio derivation, separated from fetching so it can be tested without an API key.
//
// Two sources, and they are not interchangeable:
//   1. JPX's own valuation endpoint — PER and ROE on a TTM basis, FwdPER from company guidance, and a
//      market cap that excludes treasury shares and is split-adjusted. This is what we publish.
//   2. The company's summary of financial statements — the fiscal-year figures we show as the statement
//      block, and the equity we re-derive P/B from as a cross-check.
//
// Where the two disagree on P/B by more than 5%, both values are kept and the page says so.

import { growthRates, fromJapanHistory } from '../src/growth.js';

const guard = (v, lo, hi) => (v != null && v > lo && v < hi ? v : null);
const round = (v, dp) => (v == null ? null : +v.toFixed(dp));

export function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const TOLERANCE = 0.05;

// A few filers report only non-consolidated figures (Cybozu files IFRS with Sales blank and NCSales
// filled), so the consolidated field is preferred but never required.
const pickFig = (r, cons, nonCons) => (r ? (num(r[cons]) ?? num(r[nonCons])) : null);

// One row per fiscal year. An amended filing repeats the year, which otherwise prints the same fiscal
// year twice in the five-year table and can leave an older revision as "latest". Keep the newest filing.
const fiscalYears = (rows) => {
  const byYear = new Map();
  for (const r of rows) {
    if (r.CurPerType !== 'FY') continue;
    // Some summaries carry profit but no revenue line; the year is still a fiscal year.
    if (pickFig(r, 'Sales', 'NCSales') == null && pickFig(r, 'NP', 'NCNP') == null) continue;
    const key = r.CurFYEn || r.CurPerEn;
    if (!key) continue;
    const prev = byYear.get(key);
    if (!prev || String(r.DiscDate || '') > String(prev.DiscDate || '')) byYear.set(key, r);
  }
  return [...byYear.values()].sort((a, b) => String(a.CurPerEn).localeCompare(String(b.CurPerEn)));
};

// Keep every nth point, always the last, so the chart ends on the latest close.
function thin(points, n) {
  if (points.length <= n) return points.map((p) => ({ d: p.d, c: p.c }));
  const step = points.length / n;
  const out = [];
  for (let i = 0; i < n - 1; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out.map((p) => ({ d: p.d, c: p.c }));
}

// Japanese summaries report cumulative year-to-date figures: 1Q is three months, 2Q is six, 3Q is nine,
// FY is twelve. Standalone quarters are the differences between them.
export function buildQuarters(rows) {
  const byFy = new Map();
  for (const r of rows) {
    if (!r.CurFYEn || !['1Q', '2Q', '3Q', 'FY'].includes(r.CurPerType)) continue;
    const rec = byFy.get(r.CurFYEn) || {};
    const prev = rec[r.CurPerType];
    if (!prev || String(r.DiscDate) > String(prev.DiscDate)) rec[r.CurPerType] = r;
    byFy.set(r.CurFYEn, rec);
  }
  const out = [];
  const pick = (r, f) => (r ? pickFig(r, f, `NC${f}`) : null);
  for (const [fyEnd, rec] of byFy) {
    const flow = (f) => {
      const q1 = pick(rec['1Q'], f), q2 = pick(rec['2Q'], f), q3 = pick(rec['3Q'], f), fy = pick(rec.FY, f);
      return {
        q1, q2: q1 != null && q2 != null ? q2 - q1 : null,
        q3: q2 != null && q3 != null ? q3 - q2 : null,
        q4: q3 != null && fy != null ? fy - q3 : null,
      };
    };
    const sales = flow('Sales'), op = flow('OP'), np = flow('NP');
    const dates = {
      q1: rec['1Q']?.CurPerEn, q2: rec['2Q']?.CurPerEn, q3: rec['3Q']?.CurPerEn, q4: rec.FY?.CurPerEn,
    };
    for (const k of ['q1', 'q2', 'q3', 'q4']) {
      // Japanese financials often leave the quarterly sales line blank while reporting profit.
      // Gating on sales alone dropped every such period and left the company page years behind.
      if (!dates[k] || (sales[k] == null && op[k] == null && np[k] == null)) continue;
      out.push({ d: dates[k], fy: fyEnd, q: k.toUpperCase(), sales: sales[k], op: op[k], np: np[k] });
    }
  }
  return out.sort((a, b) => a.d.localeCompare(b.d));
}

// What the company said it would earn, against what it actually earned. Guidance is taken from the
// first forecast published during that fiscal year, so a late-in-the-year revision does not flatter it.
export function guidanceVsDelivered(rows) {
  const fys = fiscalYears(rows)
    .filter((r) => pickFig(r, 'NP', 'NCNP') != null);
  for (let i = fys.length - 1; i >= 0; i--) {
    const fy = fys[i];
    const during = rows
      .filter((r) => r.CurFYEn === fy.CurFYEn && ['1Q', '2Q', '3Q'].includes(r.CurPerType) && pickFig(r, 'FNP', 'FNCNP') != null)
      .sort((a, b) => String(a.DiscDate).localeCompare(String(b.DiscDate)));
    if (!during.length) continue;
    const forecast = pickFig(during[0], 'FNP', 'FNCNP');
    const actual = pickFig(fy, 'NP', 'NCNP');
    if (!forecast || actual == null) continue;
    return {
      fy: fy.CurFYEn,
      forecast,
      actual,
      deltaPct: round(((actual / forecast) - 1) * 100, 1),
      basis: 'first forecast published that fiscal year',
    };
  }
  return null;
}


export function deriveJapan({ ranked, fins, series, val = new Map(), nextByCode = new Map(), fx = null }) {
  const companies = [];
  for (const c of ranked) {
    const rows = fins.get(c.code) || [];
    const fy = fiscalYears(rows);
    const last = fy[fy.length - 1] || null;
    const s = [...(series.get(c.code) || [])].sort((a, b) => a.d.localeCompare(b.d));
    const price = s.length ? s[s.length - 1].c : null;
    const jpx = val.get(c.code) || null;

    // JPX's cap is the authority: ex-treasury, split-adjusted, and the bars field is being retired.
    const cap = jpx?.MktCap ? jpx.MktCap * 1e6 : (c.cap || null);

    const sales = last ? pickFig(last, 'Sales', 'NCSales') : null;
    const op = last ? pickFig(last, 'OP', 'NCOP') : null;
    const odp = last ? pickFig(last, 'OdP', 'NCOdP') : null;
    const np = last ? pickFig(last, 'NP', 'NCNP') : null;
    const ta = last ? pickFig(last, 'TA', 'NCTA') : null;
    // Shareholders' equity attributable to the parent — not total equity including non-controlling
    // interests. Market cap is the parent's value, so P/B must divide by the parent's equity.
    const eqOf = (r) => (r ? (num(r.ShEq) ?? num(r.Eq)) : null);
    const eq = last ? eqOf(last) : null;
    // JPX's BPS uses the most recently disclosed period, which by late in the year is a quarter, not
    // the fiscal year. Comparing our fiscal-year equity against it would look like a 10% dispute.
    const eqRows = new Map();
    for (const r of rows) {
      if (eqOf(r) == null || !r.CurPerEn) continue;
      const prev = eqRows.get(r.CurPerEn);
      if (!prev || String(r.DiscDate || '') > String(prev.DiscDate || '')) eqRows.set(r.CurPerEn, r);
    }
    const latestEqRow = [...eqRows.values()]
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
    // Japanese companies usually pay an interim and a year-end dividend; some pay quarterly. Keep
    // every period the annual row carries, plus the current forecast and next year's forecast.
    const divPeriods = last ? [
      ['Q1', num(last.Div1Q)], ['Interim', num(last.Div2Q)],
      ['Q3', num(last.Div3Q)], ['Year-end', num(last.DivFY)],
    ].filter(([, v]) => v != null) : [];
    const fDivPeriods = g ? [
      ['Q1', num(g.FDiv1Q)], ['Interim', num(g.FDiv2Q)],
      ['Q3', num(g.FDiv3Q)], ['Year-end', num(g.FDivFY)],
    ].filter(([, v]) => v != null) : [];
    const nextDiv = num(last?.NxFDivAnn ?? g?.NxFDivAnn);
    const nextDivPeriods = last ? [
      ['Q1', num(last.NxFDiv1Q)], ['Interim', num(last.NxFDiv2Q)],
      ['Q3', num(last.NxFDiv3Q)], ['Year-end', num(last.NxFDivFY)],
    ].filter(([, v]) => v != null) : [];

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
    // Five years of fiscal-year figures, short keys to keep 1,500 companies inside one payload.
    const history = fy.slice(-5).map((r) => ({
      y: r.CurFYEn || r.CurPerEn,
      s: pickFig(r, 'Sales', 'NCSales'),
      o: pickFig(r, 'OP', 'NCOP') ?? pickFig(r, 'OdP', 'NCOdP'),
      n: pickFig(r, 'NP', 'NCNP'),
      e: pickFig(r, 'EPS', 'NCEPS'), b: pickFig(r, 'BPS', 'NCBPS'),
      a: pickFig(r, 'TA', 'NCTA'), q: eqOf(r),
      c: num(r.CFO), i: num(r.CFI), d: num(r.DivAnn),
      // Average shares produced this year's EPS. A later build uses the year-on-year jump to put the
      // EPS series on one split-adjusted basis.
      sh: num(r.AvgSh),
    }));
    // The same two growth figures the US page publishes, from the same five fiscal years the table
    // below shows. No extra API call: J-Quants already returned net sales and EPS per year.
    const growth = growthRates(fromJapanHistory(history));

    // How many times the company moved its own full-year forecast this year, and in which direction.
    let revisions = null;
    {
      const fys = [...new Set(rows.filter((r) => r.CurFYEn && num(r.FNP) != null).map((r) => r.CurFYEn))].sort();
      const fyEnd = fys[fys.length - 1];
      if (fyEnd) {
        const seq = rows
          .filter((r) => r.CurFYEn === fyEnd && num(r.FNP) != null)
          .sort((a, b) => String(a.DiscDate).localeCompare(String(b.DiscDate)))
          .map((r) => num(r.FNP));
        const distinct = seq.filter((v, i) => i === 0 || v !== seq[i - 1]);
        if (distinct.length > 1) {
          let up = 0, down = 0;
          for (let i = 1; i < distinct.length; i++) {
            if (distinct[i] > distinct[i - 1]) up++;
            else if (distinct[i] < distinct[i - 1]) down++;
          }
          revisions = {
            fy: fyEnd, moves: distinct.length - 1, up, down,
            first: distinct[0], last: distinct[distinct.length - 1],
            deltaPct: distinct[0] ? round(((distinct[distinct.length - 1] / distinct[0]) - 1) * 100, 1) : null,
          };
        }
      }
    }

    // Keep every quarter the filing window holds. merge-history then retains the ones that scroll off,
    // so the table can grow to decades instead of being pinned to the last two years.
    const quarters = buildQuarters(rows);
    const guidedVsActual = guidanceVsDelivered(rows);

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
      // No per-company series here: charts come from /api/japan-chart, which serves daily and weekly
      // blocks on demand. Keeping 1,500 five-year series in the list payload would be ~10 MB.
      series: [],
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
      fcfBasis: fcf == null ? null : 'CFO+CFI',
      shares,
      dividend: divAnn != null || divPeriods.length || nextDiv != null ? {
        perShare: divAnn, total: divTotal, payoutRatio: payout, forecast: fDivAnn,
        yield: price && divAnn ? round((divAnn / price) * 100, 2) : null,
        forecastYield: price && fDivAnn ? round((fDivAnn / price) * 100, 2) : null,
        periods: divPeriods.map(([label, value]) => ({ label, value })),
        forecastPeriods: fDivPeriods.map(([label, value]) => ({ label, value })),
        nextYear: nextDiv,
        nextYearPeriods: nextDivPeriods.map(([label, value]) => ({ label, value })),
        nextYearYield: price && nextDiv ? round((nextDiv / price) * 100, 2) : null,
        growthPct: divAnn && nextDiv ? round(((nextDiv / divAnn) - 1) * 100, 1) : null,
      } : null,
      guidance: g ? {
        fy: g.CurFYEn || null,
        sales: num(g.FSales), op: num(g.FOP), np: gNp, eps: num(g.FEPS),
        next: num(g.FNCSales) != null || num(g.FNCOP) != null || num(g.FNCNP) != null || num(g.FNCEPS) != null ? {
          sales: num(g.FNCSales), op: num(g.FNCOP), np: num(g.FNCNP), eps: num(g.FNCEPS),
        } : null,
        basis: 'company guidance, not consensus',
      } : null,
      jpx: jpx ? {
        per: jpx.PER, pbr: jpx.PBR, roe: jpx.ROE, fwdPer: jpx.FwdPER, fwdRoe: jpx.FwdROE,
        eps: jpx.EPS, bps: jpx.BPS, marketCap: cap,
      } : null,
      verification,
      quarters,
      history,
      ...growth,
      revisions,
      guidanceVsDelivered: guidedVsActual,
      earnings: nextByCode.get(c.code) || null,
    });
  }
  return companies;
}
