// One definition of "are this market's prices current?", shared by the pre-publish guard
// (audit-market-refresh.mjs) and the daily monitor (check-freshness.mjs).
//
// The old monitor only asked when the FILE was written. A job that runs every night, keeps yesterday's
// quotes and rewrites the file passes that test forever — South Africa did exactly that, and a partial
// fetch in Australia or Indonesia was invisible for the same reason. What matters is the date on the
// prices themselves: the session most companies are on, and how many are behind it.

/** Every market spells it differently in one file or another. */
export const priceDateOf = (c) => (c && (c.priceDate || c.priceAsOf)) || null;

/** The company key used to line a build up against the previous one. */
export const companyKey = (c) => String((c && (c.code ?? c.ticker ?? c.cik)) ?? '');

/**
 * Distribution of price dates across a market.
 *
 * `session` is the most common date — the session the market actually published. (A max would be
 * fooled by one bad print: a single Sunday quote made a whole market look current.) `behind` counts
 * the lines still on an older date, which is how a partial fetch shows up.
 */
export function sessionStats(companies, field = null) {
  const dated = [];
  for (const c of Array.isArray(companies) ? companies : []) {
    const d = field ? c[field] : priceDateOf(c);
    if (d) dated.push(d);
  }
  if (!dated.length) return { session: null, total: 0, onSession: 0, behind: 0, behindShare: 0, oldest: null, dates: new Map() };

  const dates = new Map();
  for (const d of dated) dates.set(d, (dates.get(d) || 0) + 1);

  // Most common wins; on a tie the later date is the session (a market moving forward, not back).
  let session = null;
  let best = -1;
  for (const [d, n] of dates) {
    if (n > best || (n === best && d > session)) { session = d; best = n; }
  }
  const behind = dated.filter((d) => d < session).length;
  const ahead = dated.filter((d) => d > session).length;
  return {
    session,
    total: dated.length,
    onSession: dated.length - behind - ahead,
    behind,
    ahead,
    behindShare: behind / dated.length,
    oldest: [...dates.keys()].sort()[0],
    dates,
  };
}

/**
 * Whole trading days between a session and a later date, weekends excluded. Holidays are NOT modelled:
 * a market shut for a holiday reads one session old, which is why callers allow slack. Counting starts
 * the day *after* `from`, so a Monday session read on Tuesday is 0 sessions old, not 1.
 */
export function sessionsBehind(from, to) {
  if (!from || !to) return null;
  const end = Date.parse(`${to}T00:00:00Z`);
  const d = new Date(`${from}T00:00:00Z`);
  if (!Number.isFinite(end) || Number.isNaN(d.getTime()) || d.getTime() >= end) return 0;
  d.setUTCDate(d.getUTCDate() + 1);
  let n = 0;
  for (; d.getTime() < end; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}
