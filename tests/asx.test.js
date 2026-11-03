// ASX helpers — the CSV parser, the "Not Applic" sector rule and the URL builders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAsxCsv, sectorOf, isNotApplic, isUnclassified, isFundLine, pad, saPage, saProfile, yaSymbol } from '../scripts/asx.mjs';

const CSV = `\uFEFFASX listed companies as at Mon Nov 02 19:41:36 AEDT 2026

Company name,ASX code,GICS industry group
"1414 DEGREES LIMITED","14D","Capital Goods"
"BHP GROUP LIMITED","BHP","Materials"
"NAME, WITH COMMA LIMITED","NMC","Not Applic"
"TOO LONG LIMITED","TOOLONG","Materials"
"","","Materials"
`;

test('the CSV parser skips both preamble lines and keeps the three fields', () => {
  const rows = parseAsxCsv(CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { code: 'BHP', name: 'BHP GROUP LIMITED', gicsIndustryGroup: 'Materials' });
  assert.equal(rows[0].code, '14D', 'a numeric-leading code survives');
  assert.equal(rows[2].name, 'NAME, WITH COMMA LIMITED', 'a quoted comma is not a column break');
  assert.equal(rows[2].gicsIndustryGroup, 'Not Applic');
});

test('the parser drops codes that are not exactly three characters', () => {
  const rows = parseAsxCsv(CSV);
  assert.ok(!rows.some((r) => r.code === 'TOOLONG'));
  assert.ok(!rows.some((r) => r.code === ''));
});

test('"Not Applic" and "Class Pend" are real values and are resolved, never printed', () => {
  assert.equal(isNotApplic('Not Applic'), true);
  assert.equal(isUnclassified('Class Pend'), true);
  assert.equal(isUnclassified('Materials'), false);
  assert.equal(sectorOf('Not Applic', 'Technology'), 'Technology');
  assert.equal(sectorOf('Class Pend', 'Financials'), 'Financials');
  assert.equal(sectorOf('Not Applic', null), 'Other');
  assert.equal(sectorOf('Materials', 'Technology'), 'Materials', 'the CSV industry group is finer');
  assert.equal(sectorOf('', null), 'Other');
});

test('ETFs, listed investment companies and debt trusts are recognised as non-companies', () => {
  assert.equal(isFundLine('BETASHARES AUSTRALIA 200 ETF'), true);
  assert.equal(isFundLine('ACORN CAPITAL INVESTMENT FUND LIMITED'), true);
  assert.equal(isFundLine('AFG 2023-1 TRUST IN RESPECT OF SERIES 2023-1'), true);
  assert.equal(isFundLine('BHP GROUP LIMITED'), false);
  assert.equal(isFundLine('GOODMAN GROUP'), false);
  assert.equal(isFundLine('SCENTRE GROUP'), false);
});

test('ASX codes are already three characters — pad only normalises case', () => {
  assert.equal(pad('bhp'), 'BHP');
  assert.equal(pad('14d'), '14D');
  assert.equal(pad(' A2M '), 'A2M');
});

test('the page and symbol builders match the ASX paths', () => {
  assert.equal(saPage('bhp', 'income-statement'), 'https://stockanalysis.com/quote/asx/BHP/financials/income-statement/');
  assert.equal(saPage('BHP', 'income-statement', true), 'https://stockanalysis.com/quote/asx/BHP/financials/income-statement/?p=trailing');
  assert.equal(saProfile('pls'), 'https://stockanalysis.com/quote/asx/PLS/company/');
  assert.equal(yaSymbol('bhp'), 'BHP.AX');
});
