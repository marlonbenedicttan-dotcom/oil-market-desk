import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (file, key) => {
  const d = JSON.parse(readFileSync(join(ROOT, 'data', file), 'utf8'));
  return d.companies || d;
};

const MARKETS = {
  US: load('companies.json'),
  Japan: load('japan.json'),
  Korea: load('korea.json'),
  Taiwan: load('taiwan.json'),
  Australia: load('australia.json'),
};

test('every market keeps brand chips unique and bounded', () => {
  for (const [market, companies] of Object.entries(MARKETS)) {
    for (const c of companies) {
      if (!c.brands) continue;
      assert.ok(Array.isArray(c.brands), `${market} ${c.ticker || c.code}: brands is an array`);
      assert.ok(c.brands.length > 0, `${market} ${c.ticker || c.code}: empty arrays are omitted`);
      assert.ok(c.brands.length <= 16, `${market} ${c.ticker || c.code}: too many chips`);
      const seen = new Set();
      for (const b of c.brands) {
        assert.equal(typeof b, 'string', `${market} ${c.ticker || c.code}: brand is text`);
        assert.equal(b, b.trim(), `${market} ${c.ticker || c.code}: brand has edge whitespace`);
        const key = b.toLowerCase();
        assert.ok(!seen.has(key), `${market} ${c.ticker || c.code}: duplicate ${b}`);
        seen.add(key);
      }
    }
  }
});

test('the structural extractor reaches the major brand owners in every market', () => {
  const find = (market, code) => MARKETS[market].find((c) => c.ticker === code || c.code === code);
  const has = (c, brand) => c && (c.brands || []).some((b) => b.toLowerCase() === brand.toLowerCase());

  assert.ok(has(find('US', 'NKE'), 'Converse'), 'US: Nike carries Converse');
  assert.ok(has(find('Japan', '67580'), 'PlayStation'), 'Japan: Sony carries PlayStation');
  assert.ok(has(find('Korea', '005930'), 'Galaxy'), 'Korea: Samsung carries Galaxy');
  assert.ok(has(find('Taiwan', '1234'), 'HeySong Soda'), 'Taiwan: Hey Song carries its product brands');
  assert.ok(has(find('Australia', 'JBH'), 'The Good Guys'), 'Australia: JB Hi-Fi carries The Good Guys');
});
