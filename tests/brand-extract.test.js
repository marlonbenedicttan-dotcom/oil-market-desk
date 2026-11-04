import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBrands, mergeBrands, profileDescription } from '../src/brand-extract.js';

test('extracts the full ANTA portfolio from the profile sentence', () => {
  const text = 'The company’s products portfolio includes running, basketball and outdoor products under the FILA, FILA KIDS, FILA FUSION, AMER, KOLON SPORT, JACK WOLFSKIN, ANTA, DESCENTE, and ANTA KIDS brands, as well as sports fabrics under MAIA ACTIVE brand name.';
  const { brands } = extractBrands(text);
  assert.deepEqual(brands, [
    'FILA', 'FILA KIDS', 'FILA FUSION', 'AMER', 'KOLON SPORT',
    'JACK WOLFSKIN', 'ANTA', 'DESCENTE', 'ANTA KIDS', 'MAIA ACTIVE',
  ]);
});

test('reads a single brand name and an explicit list introduced by a dash', () => {
  assert.deepEqual(extractBrands('It sells toothpaste under the brand name of Yunnan Baiyao.').brands, ['Yunnan Baiyao']);
  assert.deepEqual(extractBrands('It operates hotels under three brands – Niccolo, Marco Polo and Maqo.').brands, ['Niccolo', 'Marco Polo', 'Maqo']);
});

test('reads a brand portfolio list without treating a title dot as the end', () => {
  const { brands } = extractBrands('The company’s brand portfolio includes agnès b., JILLSTUART, New Balance, Levi’s, and Fila brands.');
  assert.deepEqual(brands, ['agnès b', 'JILLSTUART', 'New Balance', 'Levi’s', 'Fila']);
});

test('does not tag generic brand language or distributor/ODM brand names', () => {
  assert.deepEqual(extractBrands('It sells products under various brands.').brands, []);
  assert.deepEqual(extractBrands('It provides brand management and brand development services.').brands, []);
  assert.deepEqual(extractBrands('It operates as an OEM for various international brand names, such as adidas, Asics and Nike.').brands, []);
});

test('does not let a later brand sentence leak into an earlier list', () => {
  const { brands } = extractBrands('It operates under the brand names SHEIN, MOTF, SHEGLAM, DAZY, ROMWE, Glowmode, Anewsta, Musera, and Aralina. In addition, it runs a marketplace where third-party merchants and brands sell products.');
  assert.deepEqual(brands, ['SHEIN', 'MOTF', 'SHEGLAM', 'DAZY', 'ROMWE', 'Glowmode', 'Anewsta', 'Musera', 'Aralina']);
});

test('trims a brand qualifier and a following sentence', () => {
  assert.deepEqual(extractBrands('It sells toothpaste under the brand name of Yunnan Baiyao manufactured in Thailand.').brands, ['Yunnan Baiyao']);
  assert.deepEqual(extractBrands('It sells memory under the brand names FORESEE, Zilia, and Lexar. Shenzhen Longsys Electronics Co., Ltd. was founded in 1999.').brands, ['FORESEE', 'Zilia', 'Lexar']);
  assert.deepEqual(extractBrands('It operates hotels under the Sukhothai Bangkok and the Sukhothai Shanghai brand.').brands, ['Sukhothai Bangkok', 'Sukhothai Shanghai']);
  assert.deepEqual(extractBrands('It sells water under the Watsons Water and Mr. Juicy brands.').brands, ['Watsons Water', 'Mr. Juicy']);
});

test('caps a long retailer assortment instead of pretending every stocked label is a house brand', () => {
  const labels = Array.from({ length: 30 }, (_, i) => `Acme ${i + 1}`).join(', ');
  const { brands } = extractBrands(`It sells watches under the ${labels} brands.`);
  assert.equal(brands.length, 10);
});

test('expands a parent portfolio once and dedupes case-insensitively', () => {
  const groups = { AMER: ['Amer Sports', "Arc'teryx", 'Salomon', 'Wilson'] };
  assert.deepEqual(mergeBrands([
    ['ANTA', 'FILA', 'Descente'],
    ['FILA', 'AMER', 'KOLON SPORT'],
  ], groups), ['ANTA', 'FILA', 'Descente', 'Amer Sports', "Arc'teryx", 'Salomon', 'Wilson', 'KOLON SPORT']);
});

test('profileDescription reads the vendor description box', () => {
  const html = '<div class="mb-5"><p>Acme makes things.</p><p>It sells them under the ACME brand.</p></div>';
  assert.equal(profileDescription(html), 'Acme makes things. It sells them under the ACME brand.');
});
