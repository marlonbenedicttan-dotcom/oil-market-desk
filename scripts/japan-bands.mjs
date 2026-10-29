// Five-year valuation bands for a Japanese company: where today's multiple sits against its own history.
//
// The exchange publishes a daily PER/PBR per issue. We keep the distribution, not the 1,200 rows.

export function band(values, current) {
  const a = values.filter((v) => v != null && Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  if (a.length < 60 || current == null || !(current > 0)) return null;
  const at = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  const below = a.filter((v) => v <= current).length;
  return {
    min: +at(0).toFixed(2),
    p25: +at(0.25).toFixed(2),
    median: +at(0.5).toFixed(2),
    p75: +at(0.75).toFixed(2),
    max: +at(1).toFixed(2),
    percentile: Math.round((below / a.length) * 100),
    days: a.length,
    years: +(a.length / 245).toFixed(1),
  };
}

// The cache keeps only the numbers, not 1,220 dated rows per company.
export function seriesFromRows(rows) {
  const keep = (k) => rows.map((r) => r[k]).filter((v) => v != null && Number.isFinite(v) && v > 0);
  return { per: keep('PER'), pbr: keep('PBR') };
}

export function bandsFromHistory(hist, current) {
  return {
    pe: band(hist.per || [], current.pe),
    pb: band(hist.pbr || [], current.pb),
  };
}
