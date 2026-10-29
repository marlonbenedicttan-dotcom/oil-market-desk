// J-Quants API client (JPX's official service).
//
// Auth is a single header, `x-api-key`. The Light plan allows 60 requests a minute, so the client
// paces itself at one request per second — well inside the limit, and fast enough for the whole
// market (prices are fetched one day at a time, all issues per call).
//
//   JQUANTS_API_KEY=... node scripts/build-japan.mjs

const BASE = 'https://api.jquants.com/v2';

export function makeClient(opts = {}) {
  const key = opts.key || process.env.JQUANTS_API_KEY;
  if (!key) {
    throw new Error(
      'JQUANTS_API_KEY is not set. Subscribe to the J-Quants Light plan, then export the key:\n' +
      '  export JQUANTS_API_KEY=...\n' +
      'It is never written to the repository.',
    );
  }
  const gap = opts.gap ?? 1100;          // ms between calls — 60/min is the Light ceiling
  let last = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function once(path, params) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = Math.max(0, last + gap - Date.now());
      if (wait) await sleep(wait);
      last = Date.now();
      const res = await fetch(url, { headers: { 'x-api-key': key } });
      if (res.status === 429) { await sleep(30000 * (attempt + 1)); continue; }
      if (res.status === 401 || res.status === 403) throw new Error(`J-Quants rejected the key (${res.status})`);
      if (!res.ok) { await sleep(1500 * (attempt + 1)); continue; }
      return res.json();
    }
    throw new Error(`J-Quants ${path} failed after 4 attempts`);
  }

  // Every list endpoint paginates with `pagination_key`; follow it to the end.
  async function all(path, params) {
    const out = [];
    let pageKey = null;
    for (let page = 0; page < 200; page++) {
      const j = await once(path, { ...params, pagination_key: pageKey });
      if (Array.isArray(j?.data)) out.push(...j.data);
      pageKey = j?.pagination_key;
      if (!pageKey) break;
    }
    return out;
  }

  return {
    master: (date) => all('/equities/master', { date }),
    barsByDate: (date) => all('/equities/bars/daily', { date }),
    barsByCode: (code, from, to) => all('/equities/bars/daily', { code, from, to }),
    // JPX's own ratios: PER and ROE are TTM, FwdPER uses company guidance, and MktCap excludes
    // treasury shares (the bars endpoint includes them).
    valuation: (date) => all('/equities/valuation', { date }),
    valuationByCode: (code, from, to) => all('/equities/valuation', { code, from, to }),
    finsByCode: (code) => all('/fins/summary', { code }),
    finsByDate: (date) => all('/fins/summary', { date }),
    earningsCalendar: () => all('/equities/earnings-calendar'),
  };
}

// Every numeric field comes back as a string; empty string means "not disclosed", never zero.
export const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
