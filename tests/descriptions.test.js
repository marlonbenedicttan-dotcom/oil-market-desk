// The profile cutters, tested once. Four hundred Hong Kong and 230 Australian summaries used to end
// on a semicolon (cut at the last "; " mid-list), and the nightly audit failed the whole refresh over
// one of them. One helper now serves every market, and these are the shapes it must never produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortenDescription } from '../src/desc.js';

test('a summary never ends on a separator', () => {
  const samples = [
    'The company operates through segments: Property Development; Property Investment; Hotels;',
    'Retail; Wholesale; Logistics,',
    'One line of business:',
    'Normal text with a full stop.',
    '',
  ];
  for (const s of samples) {
    const out = shortenDescription(s);
    assert.doesNotMatch(out, /[;,:\s]$/, `ends badly: ${JSON.stringify(out)}`);
  }
});

test('a short source that stops mid-list is trimmed and marked as cut', () => {
  const out = shortenDescription('The company operates through segments: Property Development; Hotels;');
  assert.equal(out, 'The company operates through segments: Property Development; Hotels\u2026');
});

test('a complete short sentence is left alone', () => {
  const s = 'It develops and sells residential property in Hong Kong.';
  assert.equal(shortenDescription(s), s);
});

test('a long summary cuts at the last complete sentence, not mid-clause', () => {
  const first = 'The company develops, sells and leases residential and commercial property across Hong Kong, the mainland and overseas markets.';
  const s = first + ' Its investment portfolio spans retail; offices; hotels; and logistics assets that would run past the limit of a card.';
  const out = shortenDescription(s, 160);
  assert.equal(out, first);
  assert.ok(out.length <= 160);
});

test('a long summary with no sentence break cuts on a word boundary and says so', () => {
  const s = 'no full stop in this description at all just a clause that keeps going and going and '
    + 'going and going and going and going and going and going';
  const out = shortenDescription(s, 60);
  assert.match(out, /\u2026$/);
  assert.ok(out.length <= 61);
  assert.doesNotMatch(out, /[,;]\u2026$/);
});

test('whitespace is collapsed and empty input is empty', () => {
  assert.equal(shortenDescription('  a   b  '), 'a b');
  assert.equal(shortenDescription(''), '');
  assert.equal(shortenDescription(null), '');
});
