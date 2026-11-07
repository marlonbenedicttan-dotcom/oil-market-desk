import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListPage, parseCap, isBdr, isFundName, isOrdinaryLine, baseOf, classOf, classLabel,
  saPage, saProfile, yaSymbol, INDEX_SYMBOL, isFinancialSector, isBankLike, isInsurer,
} from '../scripts/b3.mjs';

test('a B3 list row is read from the exchange table', () => {
  const html = `
    <table><tbody>
      <tr><td>1</td><td><a href="/quote/bvmf/PETR4/">PETR4</a></td><td>Petróleo Brasileiro S.A. - Petrobras</td><td>627.34B</td><td>45.30</td><td>1.2%</td><td>548.49B</td></tr>
      <tr><td>2</td><td><a href="/quote/bvmf/PETR3/">PETR3</a></td><td>Petróleo Brasileiro S.A. - Petrobras</td><td>628.91B</td><td>48.00</td><td>0.5%</td><td>548.49B</td></tr>
      <tr><td>3</td><td><a href="/quote/bvmf/BTLG11/">BTLG11</a></td><td>BTG Pactual Logística Fundo de Investimento Imobiliário</td><td>4.30B</td><td>100.00</td><td>-</td><td>300M</td></tr>
      <tr><td>4</td><td><a href="/quote/bvmf/AAPL34/">AAPL34</a></td><td>Apple Inc.</td><td>27.53T</td><td>70.00</td><td>0.1%</td><td>1.2T</td></tr>
    </tbody></table>`;
  const rows = parseListPage(html);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { code: 'PETR4', name: 'Petróleo Brasileiro S.A. - Petrobras', vendorCap: 627.34e9 });
  assert.equal(rows[2].code, 'BTLG11');
});

test('BDRs end in 31–39, funds are named, and the rest are operating classes', () => {
  assert.ok(isBdr('AAPL34'));
  assert.ok(isBdr('XPBR31'));
  assert.ok(!isBdr('PETR4'));
  assert.ok(!isBdr('RAIZ55'));
  assert.ok(isFundName('Fundo de Investimento Imobiliário - FII BTG Pactual'));
  assert.ok(!isFundName('Petróleo Brasileiro S.A.'));
  assert.ok(isOrdinaryLine('PETR4', 'Petróleo Brasileiro S.A.'));
  assert.ok(!isOrdinaryLine('AAPL34', 'Apple Inc.'));
  assert.ok(!isOrdinaryLine('BTLG11', 'Fundo de Investimento Imobiliário'));
});

test('class suffixes and labels', () => {
  assert.equal(baseOf('PETR4'), 'PETR');
  assert.equal(baseOf('MRSA3B'), 'MRSA');
  assert.equal(baseOf('RAIZ55'), 'RAIZ');
  assert.equal(classOf('ITUB4'), '4');
  assert.equal(classOf('MRSA3B'), '3B');
  assert.equal(classLabel('ITUB4'), 'PN');
  assert.equal(classLabel('PETR3'), 'ON');
  assert.equal(classLabel('BPAC11'), 'UNIT');
  assert.equal(classLabel('MRSA3B'), 'class 3B');
});

test('the vendor cap string is parsed in reais', () => {
  assert.equal(parseCap('627.34B'), 627.34e9);
  assert.equal(parseCap('27.53T'), 27.53e12);
  assert.equal(parseCap('-'), null);
  assert.equal(parseCap('n/a'), null);
});

test('B3 URLs, Yahoo symbol and index', () => {
  assert.equal(saPage('PETR4', 'income-statement'), 'https://stockanalysis.com/quote/bvmf/PETR4/financials/income-statement/');
  assert.equal(saPage('PETR4', 'income-statement', true), 'https://stockanalysis.com/quote/bvmf/PETR4/financials/income-statement/?p=quarterly');
  assert.equal(saProfile('PETR4'), 'https://stockanalysis.com/quote/bvmf/PETR4/company/');
  assert.equal(yaSymbol('PETR4'), 'PETR4.SA');
  assert.equal(INDEX_SYMBOL, '^BVSP');
});

test('a bank is not an insurer, and a non-financial is never a bank', () => {
  assert.ok(isFinancialSector('Financials'));
  assert.ok(!isFinancialSector('Energy'));
  assert.ok(isBankLike({ sector: 'Financials', industry: 'Banks - Regional' }));
  assert.ok(isBankLike({ sector: 'Financials', industry: 'Capital Markets' }));
  assert.ok(isInsurer('Insurance - Life'));
  assert.ok(!isBankLike({ sector: 'Financials', industry: 'Insurance - Life', ttm: { operatingProfit: null } }));
  assert.ok(isBankLike({ sector: 'Financials', ttm: { operatingProfit: null } }));
  assert.ok(!isBankLike({ sector: 'Materials', industry: 'Steel' }));
});
