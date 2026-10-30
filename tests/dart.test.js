// DART client parsing, tested offline so the Korean pipeline can be verified before a key exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { unzipFirstEntry, parseCorpCodes, mapAccounts, num, ACCOUNTS, REPORTS } from '../scripts/dart.mjs';

// Build a complete single-entry ZIP, the way DART ships one: sizes in the central directory and a
// data descriptor flag on the local header (so the local sizes are zero).
function makeZip(name, text) {
  const data = zlib.deflateRawSync(Buffer.from(text, 'utf8'));
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = zlib.crc32 ? zlib.crc32(Buffer.from(text, 'utf8')) : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0008, 6);     // bit 3: sizes follow in a data descriptor
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(0, 18);         // compressed size unknown here, as DART does
  local.writeUInt32LE(0, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(data.length, 8);
  descriptor.writeUInt32LE(Buffer.byteLength(text), 12);

  const cdOffset = 30 + nameBuf.length + data.length + 16;
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0008, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);        // compressed size — the authoritative one
  cd.writeUInt32LE(Buffer.byteLength(text), 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42);                  // local header offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([local, nameBuf, data, descriptor, cd, nameBuf, eocd]);
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
