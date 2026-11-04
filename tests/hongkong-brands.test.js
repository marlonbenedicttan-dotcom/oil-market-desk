import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hk = JSON.parse(readFileSync(join(ROOT, 'data', 'hongkong.json'), 'utf8'));
const profiles = JSON.parse(readFileSync(join(ROOT, 'data', 'hongkong-profiles.json'), 'utf8'));

test('Hong Kong brand chips are unique, bounded and never placeholders', () => {
  const generic = /^(?:various|other|own|brand|brands|third[- ]party|private[- ]label|n\/a)$/i;
  for (const c of hk.companies) {
    if (!c.brands) continue;
    assert.ok(Array.isArray(c.brands), `${c.code}: brands is an array`);
    assert.ok(c.brands.length > 0, `${c.code}: an empty array is omitted`);
    assert.ok(c.brands.length <= 16, `${c.code}: brand chips are bounded`);
    const seen = new Set();
    for (const b of c.brands) {
      assert.equal(typeof b, 'string', `${c.code}: brand is text`);
      assert.equal(b, b.trim(), `${c.code}: brand has no edge whitespace`);
      assert.ok(b.length >= 2, `${c.code}: brand is not a single character`);
      assert.ok(!generic.test(b), `${c.code}: ${b} is not a placeholder`);
      const key = b.toLowerCase();
      assert.ok(!seen.has(key), `${c.code}: duplicate brand ${b}`);
      seen.add(key);
    }
  }
});

test('ANTA carries the full portfolio, including the Amer Sports brands', () => {
  const anta = hk.companies.find((c) => c.code === '2020');
  assert.ok(anta, 'ANTA is in the Hong Kong dataset');
  for (const b of ['ANTA', 'FILA', 'FILA KIDS', 'FILA FUSION', 'DESCENTE', 'KOLON SPORT', 'JACK WOLFSKIN', 'MAIA ACTIVE', 'Amer Sports', "Arc'teryx", 'Salomon', 'Wilson']) {
    assert.ok(anta.brands.some((x) => x.toLowerCase() === b.toLowerCase()), `ANTA is tagged ${b}`);
  }
});

test('every extracted profile brand is backed by the sentence it came from', () => {
  let checked = 0;
  for (const [code, entry] of Object.entries(profiles.entries || {})) {
    if (!entry || !Array.isArray(entry.brands) || !entry.brands.length) continue;
    assert.equal(typeof entry.brandQuote, 'string', `${code}: auto brands carry a quote`);
    const quote = entry.brandQuote.toLowerCase();
    for (const b of entry.brands) {
      assert.ok(quote.includes(b.toLowerCase()), `${code}: ${b} appears in its source quote`);
    }
    checked++;
  }
  assert.ok(checked > 200, 'the extractor covers a meaningful slice of the market');
});
