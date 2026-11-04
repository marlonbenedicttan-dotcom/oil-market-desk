import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNifty500, isOrdinaryLine, saSlug, yaSymbol, saPage, isFinancialSector, isBankLike } from '../scripts/nse.mjs';

const CSV = '\uFEFFCompany Name,Industry,Symbol,Series,ISIN Code\n' +
  '"Reliance Industries Ltd.",Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018\n' +
  'Mahindra & Mahindra Ltd.,Automobile and Auto Components,M&M,EQ,INE101A01026\n' +
  'Bajaj Auto Ltd.,Automobile and Auto Components,BAJAJ-AUTO,EQ,INE917I01010\n' +
  'Brookfield India Real Estate Trust,Realty,BIRET,RR,INE0FDU25010\n';

test('parseNifty500 reads the BOM, quotes and commas', () => {
  const rows = parseNifty500(CSV);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, 'Reliance Industries Ltd.');
  assert.equal(rows[0].code, 'RELIANCE');
  assert.equal(rows[0].industry, 'Oil Gas & Consumable Fuels');
  // A comma inside a quoted name must not shift the symbol into the industry column.
  assert.equal(rows[1].code, 'M&M');
});

test('the NIFTY file lists exchange series, and only EQ/BE are companies', () => {
  const rows = parseNifty500(CSV);
  assert.deepEqual(rows.filter((r) => isOrdinaryLine(r.series)).map((r) => r.code), ['RELIANCE', 'M&M', 'BAJAJ-AUTO']);
  assert.equal(isOrdinaryLine('RR'), false);   // a REIT/InvIT unit, not a company
});

test('stockanalysis spells & and - as _', () => {
  assert.equal(saSlug('M&M'), 'M_M');
  assert.equal(saSlug('BAJAJ-AUTO'), 'BAJAJ_AUTO');
  assert.equal(saSlug('J&KBANK'), 'J_KBANK');
  assert.match(saPage('M&M', 'income-statement'), /quote\/nse\/M_M\/financials\/income-statement\//);
});

test('Yahoo wants the raw symbol percent-encoded', () => {
  assert.equal(yaSymbol('M&M'), 'M%26M.NS');
  assert.equal(yaSymbol('BAJAJ-AUTO'), 'BAJAJ-AUTO.NS');
  assert.equal(yaSymbol('RELIANCE'), 'RELIANCE.NS');
});

test('Financial Services is the NSE macro sector, not a GICS group', () => {
  assert.equal(isFinancialSector('Financial Services'), true);
  assert.equal(isFinancialSector('Capital Goods'), false);
});

test('a bank is bank-like; an insurer keeps its margin', () => {
  assert.equal(isBankLike({ sector: 'Financial Services', industry: 'Banks - Regional' }), true);
  assert.equal(isBankLike({ sector: 'Financial Services', industry: 'Insurance - Life' }), false);
  // A financial with no industry label and no operating-profit line is a lender until proven otherwise.
  assert.equal(isBankLike({ sector: 'Financial Services', industry: null, ttm: {} }), true);
  // A fee-based financial that does report an operating line is not.
  assert.equal(isBankLike({ sector: 'Financial Services', industry: 'Asset Management', ttm: { operatingProfit: 1e9 } }), false);
  assert.equal(isBankLike({ sector: 'Capital Goods', industry: null, ttm: {} }), false);
});
