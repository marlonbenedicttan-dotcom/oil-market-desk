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

// Banks and insurers file each interim as a standalone quarter, not a cumulative one: KB Financial's
// Q3 2025 report shows ₩1.66T against a ₩1.75T half-year, which cannot be a nine-month total. Their
// statements also carry no revenue line, so the cumulative builder produces nothing. Read the interims
// directly (Q1, Q2, Q3) and take Q4 as the annual figure less the first three.
export function buildQuartersKrStandalone(rows) {
  const byYear = new Map();
  for (const r of rows) {
    if (!r.end || !r.report) continue;
    const fy = String(r.end).slice(0, 4);
    if (!byYear.has(fy)) byYear.set(fy, {});
    byYear.get(fy)[r.report] = r;
  }
  const out = [];
  for (const [fy, rec] of byYear) {
    const q1 = rec.q1?.netIncome, q2 = rec.h1?.netIncome, q3 = rec.q3?.netIncome;
    const fyNi = rec.annual?.netIncome;
    const q4 = fyNi != null && q1 != null && q2 != null && q3 != null ? fyNi - (q1 + q2 + q3) : null;
    const rowsOut = [
      ['Q1', rec.q1?.end, q1, rec.q1?.revenue ?? null],
      ['Q2', rec.h1?.end, q2, rec.h1?.revenue ?? null],
      ['Q3', rec.q3?.end, q3, rec.q3?.revenue ?? null],
      ['Q4', rec.annual?.end, q4, null],
    ];
    for (const [q, d, ni, rev] of rowsOut) {
      if (!d || ni == null) continue;
      out.push({ d, fy, q, revenue: rev, operatingProfit: null, netIncome: ni });
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

    let q = buildQuartersKr(saneReports(c.reports || []));
    let quartersBasis = 'cumulative';
    if (!q.length) {
      const alt = buildQuartersKrStandalone(saneReports(c.reports || []));
      if (alt.length) { q = alt; quartersBasis = 'standalone'; }
    }
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
      quarters: q.slice(-8),
      quartersBasis,
      history: (c.reports || []).filter((r) => r.report === 'annual').slice(-5).map((r) => ({
        y: r.end, s: r.revenue, o: r.operatingProfit, n: r.netIncome, q: r.equity, a: r.assets,
        c: r.operatingCashFlow, i: r.investingCashFlow,
      })),
    });
  }
  return out;
}
