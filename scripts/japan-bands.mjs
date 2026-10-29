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

// One pass over the valuation history for both multiples.
export function bandsFromHistory(rows, current) {
  const per = rows.map((r) => r.PER);
  const pbr = rows.map((r) => r.PBR);
  return {
    pe: band(per, current.pe),
    pb: band(pbr, current.pb),
  };
}
