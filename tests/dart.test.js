// DART client parsing, tested offline so the Korean pipeline can be verified before a key exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { unzipFirstEntry, parseCorpCodes, mapAccounts, num, ACCOUNTS, REPORTS } from '../scripts/dart.mjs';

// Build a minimal single-entry ZIP (deflate) to exercise the reader without any dependency.
function makeZip(name, text) {
  const data = zlib.deflateRawSync(Buffer.from(text, 'utf8'));
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);          // version needed
  head.writeUInt16LE(0, 6);           // flags
  head.writeUInt16LE(8, 8);           // deflate
  head.writeUInt32LE(0, 10);          // time/date
  head.writeUInt32LE(0, 14);          // crc (not checked by our reader)
  head.writeUInt32LE(data.length, 18); // compressed size
  head.writeUInt32LE(Buffer.byteLength(text), 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, nameBuf, data]);
}

test('unzipFirstEntry reads a deflated entry', () => {
  const zip = makeZip('CORPCODE.xml', '<result><list>hi</list></result>');
  assert.equal(unzipFirstEntry(zip).toString('utf8'), '<result><list>hi</list></result>');
});

test('unzipFirstEntry rejects a non-zip', () => {
  assert.throws(() => unzipFirstEntry(Buffer.from('<html>nope</html>')), /not a zip/);
});

test('parseCorpCodes keeps the stock code and drops unlisted filers', () => {
  const xml = `<result>
    <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><stock_code>005930</stock_code><modify_date>20260101</modify_date></list>
    <list><corp_code>00999999</corp_code><corp_name>비상장회사</corp_name><stock_code> </stock_code><modify_date>20260101</modify_date></list>
  </result>`;
  const rows = parseCorpCodes(xml);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { corp: '00126380', name: '삼성전자', stock: '005930', modified: '20260101' });
  assert.equal(rows[1].stock.trim(), '', 'unlisted company has no stock code');
});

test('Korean amounts parse: separators, parentheses for negatives, blanks', () => {
  assert.equal(num('1,234,567'), 1234567);
  assert.equal(num('(12,000)'), -12000);
  assert.equal(num('-'), null);
  assert.equal(num(''), null);
  assert.equal(num('₩ 4,500'), 4500);
});

test('account ids map to our field names', () => {
  const rows = [
    { account_id: 'ifrs-full_Assets', thstrm_amount: '100,000' },
    { account_id: 'ifrs-full_Equity', thstrm_amount: '40,000' },
    { account_id: 'ifrs-full_Revenue', thstrm_amount: '80,000' },
    { account_id: 'ifrs-full_OperatingIncomeLoss', thstrm_amount: '9,000' },
    { account_id: 'ifrs-full_ProfitLoss', thstrm_amount: '7,000' },
    { account_id: 'ifrs-full_CashFlowsFromUsedInOperatingActivities', thstrm_amount: '8,500' },
  ];
  const m = mapAccounts(rows);
  assert.equal(m.assets, 100000);
  assert.equal(m.equity, 40000);
  assert.equal(m.revenue, 80000);
  assert.equal(m.operatingProfit, 9000);
  assert.equal(m.netIncome, 7000);
  assert.equal(m.operatingCashFlow, 8500);
  assert.equal(m.cash, null, 'a missing account is null, never zero');
});

test('the report codes are the four DART periods, with no Q4', () => {
  assert.deepEqual(Object.keys(REPORTS).sort(), ['annual', 'h1', 'q1', 'q3']);
  assert.equal(REPORTS.annual, '11011');
  assert.ok(ACCOUNTS.netIncome.length >= 1);
});
