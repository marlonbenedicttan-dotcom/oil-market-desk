// Growth rates over a company's fiscal-year history.
//
// The US page computes revenue CAGR and EPS growth from the five fiscal years it already carries.
// Japan's five-year record has the same two inputs (net sales and EPS, per J-Quants), so the same
// rules apply: a CAGR only exists when both ends are positive and the span is at least two years;
// when EPS crosses a loss, the change itself is shown instead of a meaningless percentage.
//
// EPS needs one extra step in Japan. J-Quants reports EPS as filed for each year, and does not
// restate prior years for a later split — Fast Retailing's FY2022 EPS is ¥2,675 and FY2023 is ¥966
// because of a 3-for-1 split, not a collapse in profit. The reported average share count moves with
// the split, so a near-integer jump in shares is used to put every year on the latest share basis.
// Without it, a quarter of the market would publish a false growth rate.

const SPLITS = [2, 3, 4, 5, 10, 20];

// A split multiplies the share count by a small integer. A buyback or an ordinary issuance moves it a
// few percent, so requiring a 1.5× jump AND a near-integer ratio keeps those out. If a company really
// doubled its shares by issuing stock, treating it as a split makes EPS comparable per share, which is
// the question this tile asks.
const splitBetween = (prev, next) => {
  const a = Number(prev);
  const b = Number(next);
  if (!(a > 0 && b > 0)) return 1;
  const r = b / a;
  for (const k of SPLITS) {
    if (r >= 1.5 && Math.abs(r / k - 1) <= 0.06) return k;
    if (r <= 0.67 && Math.abs(r * k - 1) <= 0.06) return 1 / k;
  }
  return 1;
};

const cagr = (from, to, years) => {
  if (!(from > 0 && to > 0 && years >= 2)) return null;
  const v = +(((to / from) ** (1 / years) - 1) * 100).toFixed(1);
  return Object.is(v, -0) ? 0 : v;
};

// rows: [{ year, revenue, eps, shares }] — `year` is the fiscal year the figures belong to and
// `shares` is the average share count that produced that year's EPS.
export function growthRates(rows) {
  const h = (rows || [])
    .filter((r) => r && r.year != null && Number.isFinite(Number(r.year)))
    .slice()
    .sort((a, b) => Number(a.year) - Number(b.year));
  const first = h[0];
  const last = h[h.length - 1];
  const span = first && last ? Number(last.year) - Number(first.year) : 0;

  // Put every year's EPS on the latest share basis. Walk backwards so a split accumulates over all
  // the years after it, not just its own pair.
  let divisor = 1;
  let adjusted = false;
  const eps = new Array(h.length).fill(null);
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].eps != null) eps[i] = h[i].eps / divisor;
    if (i > 0) {
      const f = splitBetween(h[i - 1].shares, h[i].shares);
      if (f !== 1) { divisor *= f; adjusted = true; }
    }
  }
  // Whether the split check was even possible: a year with EPS but no share count cannot be verified.
  const sharesKnown = h.every((r) => r.eps == null || Number(r.shares) > 0);

  const revenueCagr = cagr(first && first.revenue, last && last.revenue, span);
  const epsCagrRaw = cagr(eps[0], eps[eps.length - 1], span);

  // Without the share counts there is no way to tell a split from a real fall in earnings, so the
  // EPS figure is withheld rather than published unadjusted.
  const epsCagr = sharesKnown ? epsCagrRaw : null;
  const epsMissing = eps[0] == null || eps[eps.length - 1] == null;
  const epsCagrNA = !sharesKnown ? 'share counts are missing, so splits cannot be adjusted for'
    : epsCagrRaw == null ? (span < 2 ? 'history too short' : epsMissing ? 'EPS was not reported in the first or last year' : 'a loss in the first or last year')
      : null;

  const out = {
    revenueCagr,
    epsCagr,
    cagrYears: span >= 2 ? span : null,
    // Say why a growth rate is absent rather than leaving a dash with no explanation.
    cagrNA: revenueCagr == null ? (span < 2 ? 'history too short' : 'revenue was not positive in both years') : null,
    epsCagrNA,
    // The page says which basis the growth figure uses; the table keeps EPS as filed.
    epsSplitAdjusted: sharesKnown && adjusted,
    epsSplitUnverified: !sharesKnown,
  };
  // A percentage is the wrong shape when an end is a loss: "−¥12.50 → ¥40.00" is the fact. This is
  // only meaningful when the series is split-verified; otherwise it would repeat the same distortion.
  if (sharesKnown && epsCagrRaw == null && span >= 2 && h.length >= 2 && eps[0] != null && eps[eps.length - 1] != null) {
    const clean = (v) => (Object.is(v, -0) ? 0 : v);
    out.epsChange = {
      from: clean(+eps[0].toFixed(2)), to: clean(+eps[eps.length - 1].toFixed(2)),
      years: span, fromFy: Number(first.year), toFy: Number(last.year),
    };
  }
  return out;
}

// Japan's history uses short keys (y/s/e) and a fiscal-year end date. Normalise it once here so the
// build and the server cannot disagree about what "year" means.
export const fromJapanHistory = (history) => (history || []).map((r) => ({
  year: r && r.y ? new Date(r.y).getUTCFullYear() : null,
  revenue: r ? r.s : null,
  eps: r ? r.e : null,
  shares: r ? r.sh : null,
}));

// Build growth rows from a market's annual statement table (Hong Kong, Australia, Korea, Taiwan).
// The per-year share count is the EPS denominator when the vendor supplies it; otherwise net income
// ÷ EPS is the count that produced that year's EPS, which is what makes the split check work where a
// row carries no share count (Taiwan's stock dividends, DART's inconsistent ShOutFY).
export function growthFromAnnuals(annuals, fallbackShares = null) {
  const rows = (annuals || [])
    .filter((r) => r && r.end)
    .slice()
    .sort((a, b) => String(a.end).localeCompare(String(b.end)))
    .map((r) => {
      const shares = r.shares > 0 ? r.shares
        : r.sharesOutstanding > 0 ? r.sharesOutstanding
          : (r.netIncome != null && r.eps && Math.sign(r.netIncome) === Math.sign(r.eps)
            ? r.netIncome / r.eps
            : fallbackShares);
      const eps = r.eps != null
        ? r.eps
        : (r.netIncome != null && fallbackShares > 0 ? r.netIncome / fallbackShares : null);
      return { year: Number(String(r.end).slice(0, 4)), revenue: r.revenue, eps, shares };
    });
  return growthRates(rows);
}

// Net margin change between the first and last annual period on file — the same window as the CAGR.
export function marginDeltaFromAnnuals(annuals) {
  const a = (annuals || [])
    .filter((r) => r && r.end)
    .slice()
    .sort((x, y) => String(x.end).localeCompare(String(y.end)));
  if (a.length < 2) return null;
  const first = a[0];
  const last = a[a.length - 1];
  if (!(first.revenue > 0) || !(last.revenue > 0)) return null;
  if (first.netIncome == null || last.netIncome == null) return null;
  return +(((last.netIncome / last.revenue) - (first.netIncome / first.revenue)) * 100).toFixed(1);
}
