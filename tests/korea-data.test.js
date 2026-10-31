// Guards on the committed Korea data. These exist because a CI rebuild once wiped every real company
// profile: the fetched text lived only in a gitignored cache, so the daily job fell back to generated
// lines. The profiles now live in data/korea-profiles.json and must stay there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const korea = JSON.parse(readFileSync(join(ROOT, 'data', 'korea.json'), 'utf8'));
const store = JSON.parse(readFileSync(join(ROOT, 'data', 'korea-profiles.json'), 'utf8'));
const companies = korea.companies || [];

test('the profile store is committed and well populated', () => {
  const profiles = store.profiles || {};
  assert.ok(Object.keys(profiles).length > 600, `expected >600 stored profiles, got ${Object.keys(profiles).length}`);
  assert.ok(profiles['005930'], 'Samsung Electronics profile is missing');
});

test('almost every company carries a real profile, not a generated line', () => {
  const profiled = companies.filter((c) => c.descSource === 'profile').length;
  const share = profiled / companies.length;
  assert.ok(share > 0.95, `only ${(share * 100).toFixed(1)}% of companies have a profile description`);
});

test('every company has a description', () => {
  const blank = companies.filter((c) => !c.description || !c.description.trim());
  assert.equal(blank.length, 0, `${blank.length} companies have no description`);
});

test('descriptions read like a company profile, not a placeholder', () => {
  const lazy = companies.filter((c) => /No company profile was available/i.test(c.description));
  assert.equal(lazy.length, 0, `${lazy.length} companies still show the generated fallback line`);
});

test('every company has an English name', () => {
  const missing = companies.filter((c) => !c.nameEn);
  assert.ok(missing.length <= 2, `${missing.length} companies have no English name`);
});

test('no company carries a negative market cap or share count', () => {
  // net income ÷ EPS divides to a negative share count when the two disagree in sign, which showed up
  // as LG Energy Solution with a −₩6.2T market cap.
  const bad = companies.filter((c) => (c.marketCap != null && c.marketCap < 0) || (c.shares != null && c.shares < 0) || (c.price != null && c.price < 0));
  assert.equal(bad.length, 0, `${bad.length} companies have a negative cap, share count or price: ${bad.slice(0, 5).map((c) => c.ticker).join(' ')}`);
});

test('every company with a price has a market cap', () => {
  const missing = companies.filter((c) => c.price != null && c.marketCap == null);
  assert.ok(missing.length <= 5, `${missing.length} companies have a price but no market cap`);
});

test('sectors follow the KSIC division of each company\'s industry code', () => {
  // DART reports KSIC 9th-revision codes. The table was once shifted one division, which filed Kia and
  // Hyundai Motor under Shipbuilding and every shipbuilder under Furniture.
  const byTicker = new Map(companies.map((c) => [c.ticker, c]));
  const expect = {
    '005930': 'Electronics', '000660': 'Electronics',
    '000270': 'Vehicles & Parts', '005380': 'Vehicles & Parts',
    '329180': 'Shipbuilding & Transport Equip',
    '011200': 'Transport & Logistics',
    '105560': 'Finance & Insurance',
  };
  for (const [ticker, sector] of Object.entries(expect)) {
    const c = byTicker.get(ticker);
    if (!c) continue; // a company may leave the index; the rule still holds for the rest
    assert.equal(c.sector, sector, `${ticker} (${c.nameEn}) is filed under ${c.sector}, expected ${sector}`);
  }
});
