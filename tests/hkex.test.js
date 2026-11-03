// HKEX report parsing — pure, fixture-based, no network.
//
// Two real bugs are pinned here. The report right-aligns the code field to six characters, so a
// one-digit code arrives as "     5 HSBC HOLDINGS" and a naive "\s{0,3}" prefix skipped every code
// below 100 — HSBC, CKH, CLP, HK & China Gas. And capping the universe at 7999 to exclude GEM also
// excluded the 9000–9999 main-board codes, which is where Alibaba (9988) and Baidu (9888) live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotations, isCompanyRow, pad4, saPage, yahooSymbol, dailyUrl } from '../scripts/hkex.mjs';

// Copied from the real report: same column widths, same two-line shape, CRLF line endings.
const REPORT = [
  '<a name = "quotations">QUOTATIONS</a>',
  '',
  ' CODE  NAME OF STOCK    CUR PRV.CLO./    ASK/    HIGH/      SHARES TRADED/',
  '                            CLOSING      BID     LOW        TURNOVER ($)',
  '',
  '     1 CKH HOLDINGS     HKD   65.45    66.20    66.20            8,117,147',
  '                              66.20    66.15    64.65          534,037,708',
  '     5 HSBC HOLDINGS    HKD  135.50   135.80   136.60           10,731,702',
  '                             135.70   135.70   135.10        1,459,279,843',
  '* 700 TENCENT          HKD  377.60   380.00   383.60           22,269,954',
  '                             383.60   383.40   375.20        8,540,915,574',
  '  9988 BABA-W          HKD   96.10    97.00    97.60           60,402,093',
  '                              97.05    97.00    95.10        5,868,785,461',
  '  1293 GRAND BAOXIN     HKD TRADING SUSPENDED',
  '  2608#SUNSHINE 100    HKD    0.10     0.10     0.105           100,000',
  '                               0.105    0.105    0.10            10,500',
  '  2800 TRACKER FUND     HKD   23.07    23.40    23.42          489,669,461',
  '                              23.42    23.42    23.06       11,451,318,103',
  '   823 LINK REIT        HKD   39.26    39.80    39.82           12,991,297',
  '                              39.82    39.82    39.02          517,882,000',
  '  8001 GEM SAMPLE       HKD    0.50     0.51     0.52            1,000,000',
  '                               0.52     0.52     0.50              520,000',
  ' 57883 JP#HSI RP2901S   HKD    0.054    0.02     0.021       10,850,320,000',
  '                               0.021    0.02     0.01          370,252,080',
  '',
  '<a name = "sales_all">NOT PART OF THE QUOTATIONS TABLE</a>',
  ' 99999 SHOULD NOT BE PARSED   HKD   1.00    1.00    1.00                1,000',
  '                               1.00    1.00    1.00                1,000',
].join('\r\n');

const rows = parseQuotations(REPORT);
const byCode = new Map(rows.map((r) => [r.hkexCode, r]));

test('a one-digit code survives the six-character right-aligned code field', () => {
  const hsbc = byCode.get('5');
  assert.ok(hsbc, 'HSBC (code 5) is missing');
  assert.equal(hsbc.name, 'HSBC HOLDINGS');
  assert.equal(hsbc.prevClose, 135.5);
  assert.equal(hsbc.close, 135.7, 'the closing price is on the second line');
  assert.equal(hsbc.low, 135.1);
  assert.equal(hsbc.turnover, 1459279843);
  assert.equal(isCompanyRow(hsbc), true);
});

test('the previous close and the close are read from different lines', () => {
  const ckh = byCode.get('1');
  assert.equal(ckh.prevClose, 65.45);
  assert.equal(ckh.close, 66.2);
  assert.equal(ckh.sharesTraded, 8117147);
});

test('a flagged line keeps the code and the name intact', () => {
  const tencent = byCode.get('700');
  assert.equal(tencent.flag, '*');
  assert.equal(tencent.name, 'TENCENT');
  assert.equal(tencent.close, 383.6);
});

test('9000–9999 is main board, not GEM', () => {
  const baba = byCode.get('9988');
  assert.ok(baba, 'Alibaba (9988) is missing');
  assert.equal(isCompanyRow(baba), true, '9988 must be accepted — it is a main-board code');
});

test('GEM, ETFs, REITs, warrants and suspended lines are not companies', () => {
  assert.equal(isCompanyRow(byCode.get('8001')), false, '8000–8999 is GEM');
  assert.equal(isCompanyRow(byCode.get('2800')), false, 'TRACKER FUND is an ETF');
  assert.equal(isCompanyRow(byCode.get('823')), false, 'LINK REIT is a trust');
  assert.equal(isCompanyRow(byCode.get('57883')), false, 'a 5-digit # warrant');
  const suspended = byCode.get('1293');
  assert.equal(suspended.suspended, true);
  assert.equal(suspended.close, null);
  assert.equal(isCompanyRow(suspended), false, 'a suspended line has no price to show');
});

test('a hash marker after the code is a marker, not part of the name', () => {
  const marked = byCode.get('2608');
  assert.ok(marked, 'a #-marked line is missing');
  assert.equal(marked.name, 'SUNSHINE 100');
  assert.equal(marked.flag, '#');
  assert.equal(isCompanyRow(marked), true, 'a #-marked company with a price is still a company');
});

test('a suspended line is parsed so the quoted count stays honest', () => {
  const s = byCode.get('1293');
  assert.ok(s, 'the suspended line was dropped by the parser');
  assert.equal(s.name, 'GRAND BAOXIN');
  assert.equal(s.close, null);
});

test('only the QUOTATIONS table is parsed', () => {
  assert.equal(byCode.has('99999'), false, 'a sales-record line leaked in');
});

test('codes map to the four-digit form the profile and price sources use', () => {
  assert.equal(pad4('5'), '0005');
  assert.equal(pad4('700'), '0700');
  assert.equal(pad4('0700'), '0700');
  assert.equal(pad4('9988'), '9988');
  assert.equal(yahooSymbol('700'), '0700.HK');
  assert.equal(saPage('700', 'income-statement'), 'https://stockanalysis.com/quote/hkg/0700/financials/income-statement/');
  assert.equal(saPage('700', 'income-statement', true), 'https://stockanalysis.com/quote/hkg/0700/financials/income-statement/?p=quarterly');
});

test('the daily report URL is the session date', () => {
  assert.equal(dailyUrl('2026-10-30'), 'https://www.hkex.com.hk/eng/stat/smstat/dayquot/d261030e.htm');
});
