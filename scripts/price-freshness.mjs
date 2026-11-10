// One definition of "are this market's prices current?", shared by the pre-publish guard
// (audit-market-refresh.mjs) and the daily monitor (check-freshness.mjs).
//
// The old monitor only asked when the FILE was written. A job that runs every night, keeps yesterday's
// quotes and rewrites the file passes that test forever — South Africa did exactly that, and a partial
// fetch in Australia or Indonesia was invisible for the same reason. What matters is the date on the
// prices themselves, and there are two different dates to look at:
//
//   priceDate  the session of the last usable close — what the page shows.
//   priceBar   the newest session the source sent a bar for, even if its close is still null.
//
// They differ whenever the exchange (or Yahoo) has not published a close yet. That is not our failure:
// illiquid ASX lines have a bar and no close most days, and the JSE/B3 feeds lag a session. Only a
// company with no bar for the session was missed by our fetch. Conflating the two made ~24% of the ASX
// look like a broken refresh every single day.

/** The session of the last usable close — the number the dashboard shows. */
export const priceDateOf = (c) => (c && (c.priceDate || c.priceAsOf)) || null;

/** The newest session the source sent anything for, close or not. */
export const barDateOf = (c) => (c && (c.priceBar || c.priceDate || c.priceAsOf)) || null;

/** The company key used to line a build up against the previous one. */
export const companyKey = (c) => String((c && (c.code ?? c.ticker ?? c.cik)) ?? '');

const modal = (dates) => {
  const counts = new Map();
  for (const d of dates) counts.set(d, (counts.get(d) || 0) + 1);
  let best = null;
  let n = -1;
  for (const [d, k] of counts) {
    // Most common wins; on a tie the later date wins — a market moving forward, never back.
    if (k > n || (k === n && d > best)) { best = d; n = k; }
  }
  return best;
};

/**
 * Distribution of price dates across a market.
 *
 * `session` is the most common bar date — the session the market actually published. (A max would be
 * fooled by one bad print: a single Sunday quote made a whole market look current.) `behind` counts
 * the lines with no bar for that session, which is how a partial fetch shows up. `noClose` counts the
 * lines that have the bar but not a close — the source, not us.
 */
export function sessionStats(companies) {
  const bars = [];
  const closes = [];
  for (const c of Array.isArray(companies) ? companies : []) {
    const b = barDateOf(c);
    if (!b) continue;
    bars.push(b);
    closes.push(priceDateOf(c) || b);
  }
  if (!bars.length) {
    return { session: null, close: null, total: 0, onSession: 0, behind: 0, behindShare: 0, noClose: 0, noCloseShare: 0, ahead: 0, oldest: null, dates: new Map() };
  }
  const session = modal(bars);
  const close = modal(closes);
  const behind = bars.filter((d) => d < session).length;
  const ahead = bars.filter((d) => d > session).length;
  // Only lines that DID get the session's bar: the ones behind it have no close because we never asked.
  const noClose = bars.filter((b, i) => b >= session && closes[i] < session).length;
  return {
    session,
    close,
    total: bars.length,
    onSession: bars.length - behind - ahead,
    behind,
    behindShare: behind / bars.length,
    noClose,
    noCloseShare: noClose / bars.length,
    ahead,
    oldest: [...bars].sort()[0],
    dates: new Map([[session, bars.length - behind - ahead]]),
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
