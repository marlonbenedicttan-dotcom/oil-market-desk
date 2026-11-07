import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListPage, parseCap, isOrdinaryLine, pad, saSlug, saPage, saProfile, yaSymbol, INDEX_SYMBOL,
  isFinancialSector, isBankLike, isInsurer, NON_COMPANIES,
} from '../scripts/idx.mjs';

test('an IDX list row is read from the exchange table, not guessed', () => {
  const html = `
    <table><tbody>
      <tr><td>1</td><td><a href="/quote/idx/BBCA/">BBCA</a></td><td>PT Bank Central Asia Tbk</td><td>638.78T</td><td>5,200.00</td><td>1.46%</td><td>111.35T</td></tr>
      <tr><td>2</td><td><a href="/quote/idx/DCII/">DCII</a></td><td>PT DCI Indonesia Tbk</td><td>375.26T</td><td>157,425</td><td>-6.99%</td><td>3.15T</td></tr>
      <tr><td>3</td><td><a href="/quote/idx/XSPI/">XSPI</a></td><td>Dana Investasi Real Estat Simas Plaza Indonesia</td><td>8.53T</td><td>410.00</td><td>-</td><td>431.36B</td></tr>
    </tbody></table>`;
  const rows = parseListPage(html);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { code: 'BBCA', name: 'PT Bank Central Asia Tbk', vendorCap: 638.78e12 });
  assert.equal(rows[1].vendorCap, 375.26e12);
  // The REIT is parsed as a row; the universe step is what excludes it.
  assert.equal(rows[2].code, 'XSPI');
});

test('a table header without a quote link is not a row', () => {
  assert.deepEqual(parseListPage('<tr><th>Symbol</th><th>Company</th></tr>'), []);
});

test('the vendor cap string is parsed in rupiah, and a dash is null', () => {
  assert.equal(parseCap('638.78T'), 638.78e12);
  assert.equal(parseCap('8.53T'), 8.53e12);
  assert.equal(parseCap('87.15B'), 87.15e9);
  assert.equal(parseCap('749.37B'), 749.37e9);
  assert.equal(parseCap('-'), null);
  assert.equal(parseCap(''), null);
  assert.equal(parseCap('n/a'), null);
});

test('IDX symbols are four characters; a table artefact is not a listing', () => {
  assert.ok(isOrdinaryLine('BBCA'));
  assert.ok(isOrdinaryLine('AADI'));
  assert.ok(isOrdinaryLine('GULA'));
  assert.ok(!isOrdinaryLine('BBCA-W'));
  assert.ok(!isOrdinaryLine(''));
  assert.ok(!isOrdinaryLine('TOOLONGTICKER'));
});

test('the three non-companies on the vendor list are named, not fetched', () => {
  assert.deepEqual([...NON_COMPANIES].sort(), ['XBGS', 'XCIS', 'XSPI']);
});

test('the IDX slug and Yahoo symbol are the ticker itself', () => {
  assert.equal(pad(' bbca '), 'BBCA');
  assert.equal(saSlug('BBCA'), 'BBCA');
  assert.equal(saPage('BBCA', 'income-statement'), 'https://stockanalysis.com/quote/idx/BBCA/financials/income-statement/');
  assert.equal(saPage('BBCA', 'income-statement', true), 'https://stockanalysis.com/quote/idx/BBCA/financials/income-statement/?p=quarterly');
  assert.equal(saProfile('BBCA'), 'https://stockanalysis.com/quote/idx/BBCA/company/');
  assert.equal(yaSymbol('BBCA'), 'BBCA.JK');
  assert.equal(INDEX_SYMBOL, '^JKSE');
});

test('a bank is not an insurer, and an insurer is not a bank', () => {
  assert.ok(isFinancialSector('Financials'));
  assert.ok(!isFinancialSector('Energy'));
  assert.ok(isBankLike({ sector: 'Financials', industry: 'Banks - Regional' }));
  assert.ok(isBankLike({ sector: 'Financials', industry: 'Consumer Finance' }));
  assert.ok(isBankLike({ sector: 'Financials', industry: 'Capital Markets' }));
  // An insurer keeps its margin even when the vendor omits an operating line.
  assert.ok(isInsurer('Insurance - Life'));
  assert.ok(!isBankLike({ sector: 'Financials', industry: 'Insurance - Life', ttm: { operatingProfit: null } }));
  // A financial with no industry label and no operating line is a lender until proven otherwise.
  assert.ok(isBankLike({ sector: 'Financials', ttm: { operatingProfit: null } }));
  // A non-financial is never a bank, whatever its industry text says.
  assert.ok(!isBankLike({ sector: 'Energy', industry: 'Oil & Gas' }));
});
