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
