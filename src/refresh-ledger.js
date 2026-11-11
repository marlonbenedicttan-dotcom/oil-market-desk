// Pure helpers for the per-company freshness ledger. The ledger answers one question for every
// covered line: is the published statement period the newest period the source has, or is it behind?
// It deliberately does not rewrite data; a `repair` entry is a queue item for the market refresh.

const DAY = 864e5;

export const ageDays = (date, today) => {
  if (!date) return null;
  const t = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(now)) return null;
  return Math.round((now - t) / DAY);
};

export const latestPeriod = (c) => {
  const dates = (c.quarters || []).map((q) => String(q.end || q.d || '').slice(0, 10)).filter(Boolean);
  if (dates.length) return dates.sort().at(-1);
  return String(c.latestEnd || c.ttmEnd || '').slice(0, 10) || null;
};

// DART report codes: 11013 Q1, 11012 H1, 11014 Q3, 11011 annual. Korean fiscal years are normally
// December, so this is the expected period end; a non-December filer is still flagged by the same
// date comparison rather than silently treated as current.
export const dartPeriodEnd = (year, reportCode) => {
  const y = Number(year);
  if (!Number.isInteger(y)) return null;
  const md = { 11013: '03-31', 11012: '06-30', 11014: '09-30', 11011: '12-31' }[String(reportCode)];
  return md ? `${y}-${md}` : null;
};

export const classify = ({ published, sourceLatest, priceDate, today }) => {
  const publishedAge = ageDays(published, today);
  const priceAge = ageDays(priceDate, today);
  if (!published) return { status: 'unknown', publishedAge, priceAge, sourceNewer: false };
  if (priceAge == null || priceAge > 45) return { status: 'inactive', publishedAge, priceAge, sourceNewer: false };
  if (sourceLatest && sourceLatest > published) return { status: 'repair', publishedAge, priceAge, sourceNewer: true };
  if (publishedAge != null && publishedAge > 450) return { status: 'stale', publishedAge, priceAge, sourceNewer: false };
  return { status: 'fresh', publishedAge, priceAge, sourceNewer: false };
};
