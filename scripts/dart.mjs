// DART (Financial Supervisory Service, Korea) client.
//
// Korea's equivalent of SEC EDGAR and J-Quants combined: every listed company files its financial
// statements here, quarterly and annually, in structured form. The API needs a free 40-character key
// from https://opendart.fss.or.kr — set it as DART_API_KEY.
//
// Endpoints used:
//   corpCode.xml            every filer: corp_code, name, 6-digit stock code (empty if unlisted)
//   fnlttMultiAcnt.json     main accounts for up to 100 companies in one call — the efficient path
//   fnlttSinglAcntAll.json  the full statement for one company, when the summary is not enough

const BASE = 'https://opendart.fss.or.kr/api';

// DART report codes: annual, half-year, Q1, Q3. There is no Q4 report — the annual statement is the
// fourth quarter, exactly like Japan, so the same cumulative-to-standalone arithmetic applies.
export const REPORTS = { annual: '11011', h1: '11012', q1: '11013', q3: '11014' };

// DART returns Korean account names with XBRL-style ids. Map the ids we need; fall back to the name.
export const ACCOUNTS = {
  assets: ['ifrs-full_Assets', 'ifrs_Assets'],
  liabilities: ['ifrs-full_Liabilities', 'ifrs_Liabilities'],
  equity: ['ifrs-full_Equity', 'ifrs_Equity', 'ifrs-full_EquityAttributableToOwnersOfParent'],
  revenue: ['ifrs-full_Revenue', 'ifrs_Revenue', 'ifrs-full_RevenueFromContractsWithCustomers'],
  operatingProfit: ['ifrs-full_OperatingIncomeLoss', 'ifrs_OperatingIncomeLoss', 'dart_OperatingIncomeLoss'],
  netIncome: ['ifrs-full_ProfitLoss', 'ifrs_ProfitLoss', 'ifrs-full_ProfitLossAttributableToOwnersOfParent'],
  eps: ['ifrs-full_BasicEarningsLossPerShare', 'ifrs_BasicEarningsLossPerShare'],
  cash: ['ifrs-full_CashAndCashEquivalents', 'ifrs_CashAndCashEquivalents'],
  operatingCashFlow: ['ifrs-full_CashFlowsFromUsedInOperatingActivities', 'ifrs_CashFlowsFromUsedInOperatingActivities'],
  investingCashFlow: ['ifrs-full_CashFlowsFromUsedInInvestingActivities', 'ifrs_CashFlowsFromUsedInInvestingActivities'],
  financingCashFlow: ['ifrs-full_CashFlowsFromUsedInFinancingActivities', 'ifrs_CashFlowsFromUsedInFinancingActivities'],
  dividendsPaid: ['ifrs-full_DividendsPaid', 'ifrs_DividendsPaid'],
  sharesOutstanding: ['ifrs-full_NumberOfSharesOutstanding', 'ifrs_NumberOfSharesOutstanding'],
};

// Korean amounts arrive as strings with thousands separators and sometimes a trailing unit.
export const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[,₩\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// A ZIP is a container; the project is zero-dependency, so read the single deflated entry directly.
// (Same approach as the SPY holdings XLSX parser.)
import zlib from 'node:zlib';

export function unzipFirstEntry(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('not a zip file');
  }
  // DART writes the sizes into a data descriptor (flag bit 3), so the local header has zeros.
  // The authoritative sizes live in the central directory, which is what we read here.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no central directory');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad central directory');
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const localOffset = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip method ${method}`);
}

// corpCode.xml → [{ corp, name, stock }]
export function parseCorpCodes(xml) {
  const out = [];
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const grab = (tag) => {
      const t = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
      return t ? t[1].trim() : '';
    };
    const corp = grab('corp_code');
    if (!corp) continue;
    out.push({ corp, name: grab('corp_name'), stock: grab('stock_code'), modified: grab('modify_date') });
  }
  return out;
}

// Map one DART account row set to our field names. Rows look like
// { account_id, account_nm, thstrm_amount, frmtrm_amount, ... }
export function mapAccounts(rows) {
  const pick = (keys) => {
    for (const k of keys) {
      const row = rows.find((r) => r.account_id === k || r.account_nm === k);
      if (row) {
        const v = num(row.thstrm_amount);
        if (v != null) return v;
      }
    }
    return null;
  };
  const out = {};
  for (const [field, keys] of Object.entries(ACCOUNTS)) out[field] = pick(keys);
  return out;
}

export function makeDartClient(opts = {}) {
  const key = opts.key || process.env.DART_API_KEY;
  if (!key) {
    throw new Error(
      'DART_API_KEY is not set. Register a free key at https://opendart.fss.or.kr, then:\n' +
      '  export DART_API_KEY=...\n' +
      'It is never written to the repository.',
    );
  }
  if (String(key).length !== 40) throw new Error(`DART_API_KEY should be 40 characters, got ${String(key).length}`);
  const gap = opts.gap ?? 220;      // DART allows a generous rate; stay polite
  let last = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(path, params, raw = false) {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set('crtfc_key', key);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = Math.max(0, last + gap - Date.now());
      if (wait) await sleep(wait);
      last = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': 'MarlonWatchtower/1.0 (marlonbenedicttan@gmail.com)' } });
      if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
      if (!res.ok) { await sleep(1500 * (attempt + 1)); continue; }
      if (raw) return Buffer.from(await res.arrayBuffer());
      const j = await res.json();
      // 013 = no data for that period, which is normal for young companies.
      if (j.status === '013') return [];
      if (j.status && j.status !== '000') {
        if (j.status === '010' || j.status === '011') throw new Error(`DART key rejected: ${j.message}`);
        await sleep(1200 * (attempt + 1));
        continue;
      }
      return j.list || [];
    }
    throw new Error(`DART ${path} failed after 4 attempts`);
  }

  return {
    // Every filer, with the 6-digit stock code empty for unlisted companies.
    async corpCodes() {
      const zip = await call('corpCode.xml', {}, true);
      return parseCorpCodes(unzipFirstEntry(zip).toString('utf8'));
    },
    // Main accounts for up to 100 companies in one request.
    async multiAccounts(corpCodes, year, report) {
      const rows = await call('fnlttMultiAcnt.json', {
        corp_code: corpCodes.join(','), bsns_year: String(year), reprt_code: report,
      });
      const byCorp = new Map();
      for (const r of rows) {
        if (!byCorp.has(r.corp_code)) byCorp.set(r.corp_code, []);
        byCorp.get(r.corp_code).push(r);
      }
      return byCorp;
    },
    // The full statement for one company.
    async singleAccounts(corpCode, year, report) {
      return call('fnlttSinglAcntAll.json', {
        corp_code: corpCode, bsns_year: String(year), reprt_code: report, fs_div: 'CFS',
      });
    },
  };
}
