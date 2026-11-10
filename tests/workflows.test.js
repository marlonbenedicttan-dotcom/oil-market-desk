// Guard the scheduled pipeline against a silent edit.
//
// More than one agent works in this repo, and the daily workflows are edited often. A step deleted by
// a rewrite does not fail anything: the job stays green while the history stops accumulating. These
// assertions are cheap and they fail loudly if one disappears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = (f) => readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8');

test('every market workflow still keeps the history it accumulates', () => {
  const cd = wf('companies-daily.yml');
  assert.match(cd, /merge-history\.mjs jp kr/, 'companies-daily no longer keeps Japanese/Korean periods');
  assert.match(cd, /merge-history\.mjs us/, 'companies-daily no longer keeps US quarters');
  assert.match(wf('companies-weekly.yml'), /merge-history\.mjs us/, 'companies-weekly no longer keeps US quarters');
  assert.match(cd, /merge-series\.mjs us jp kr/, 'companies-daily no longer keeps US/Japan/Korea sessions');

  for (const [file, id] of [['taiwan-daily.yml', 'tw'], ['hongkong-daily.yml', 'hk'], ['australia-daily.yml', 'au'], ['india-daily.yml', 'in'], ['indonesia-daily.yml', 'id'], ['brazil-daily.yml', 'br'], ['south-africa-daily.yml', 'za']]) {
    const y = wf(file);
    assert.match(y, new RegExp(`merge-history\\.mjs ${id}`), `${file} no longer keeps filed periods`);
    assert.match(y, new RegExp(`merge-series\\.mjs ${id}`), `${file} no longer keeps traded sessions`);
  }
});

test('the all-markets audit covers Indonesia, Brazil and South Africa deep, and every market', () => {
  const a = readFileSync(join(ROOT, 'scripts', 'audit-all-markets.mjs'), 'utf8');
  for (const script of ['audit-taiwan.mjs', 'audit-hongkong.mjs', 'audit-australia.mjs', 'audit-india.mjs', 'audit-indonesia.mjs', 'audit-indonesia-deep.mjs', 'audit-brazil.mjs', 'audit-brazil-deep.mjs', 'audit-southafrica.mjs', 'audit-southafrica-deep.mjs', 'audit-markets.mjs', 'check-freshness.mjs']) {
    assert.ok(a.includes(script), `all-markets audit is missing ${script}`);
  }
  assert.match(wf('markets-audit-daily.yml'), /audit:all|audit-all-markets/, 'the scheduled all-markets audit lost its command');
});

test('the new-listing profile fetchers are still wired and capped', () => {
  const cd = wf('companies-daily.yml');
  assert.match(cd, /fetch-japan-profiles\.mjs --limit=25/, 'Japan new listings would never get a profile');
  assert.match(cd, /fetch-korea-descriptions\.mjs --only-missing --limit=25/, 'Korea new listings would never get a description');
});

test('every market workflow still audits before it commits', () => {
  const audit = {
    'companies-daily.yml': /audit-markets\.mjs/,
    'taiwan-daily.yml': /audit-taiwan\.mjs/,
    'hongkong-daily.yml': /audit:hongkong|audit-hongkong\.mjs/,
    'australia-daily.yml': /audit:australia|audit-australia\.mjs/,
    'india-daily.yml': /audit:india|audit-india\.mjs/,
    'indonesia-daily.yml': /audit:indonesia|audit-indonesia\.mjs/,
    'brazil-daily.yml': /audit:brazil|audit-brazil\.mjs/,
    'south-africa-daily.yml': /audit:southafrica|audit-southafrica\.mjs/,
  };
  for (const [file, re] of Object.entries(audit)) assert.match(wf(file), re, `${file} lost its audit`);
});

test('every market that publishes prices runs the price guard before it commits', () => {
  // The guard is what notices a partial price fetch (companies present, quotes on an older session).
  for (const file of ['australia-daily.yml', 'hongkong-daily.yml', 'india-daily.yml', 'indonesia-daily.yml', 'brazil-daily.yml', 'south-africa-daily.yml']) {
    assert.match(wf(file), /audit-market-refresh\.mjs/, `${file} no longer runs the refresh guard`);
  }
});

test('every Yahoo price build records the bar date, not only the close date', () => {
  // Without priceBar a source that has not published a close is indistinguishable from a fetch we
  // dropped, which is what made a quarter of the ASX look stale every day.
  for (const f of ['build-australia', 'build-hongkong', 'build-india', 'build-brazil', 'build-indonesia', 'build-southafrica']) {
    const src = readFileSync(join(ROOT, 'scripts', `${f}.mjs`), 'utf8');
    assert.match(src, /c\.priceBar = /, `${f} no longer records priceBar`);
    assert.match(src, /lastBar/, `${f} no longer caches the newest bar`);
  }
});

test('Hong Kong retries the quotation report later in the day', () => {
  // A short HKEX page makes the build refuse to publish, and the exchange replaces it hours later.
  const y = wf('hongkong-daily.yml');
  assert.match(y, /cron: '10 12 \* \* 1-5'/, 'the evening HKEX run is gone');
  assert.match(y, /cron: '10 16 \* \* 1-5'/, 'the later retry of the HKEX report is gone');
});

test('the Brazil commit stages every artifact the build writes', () => {
  // A hand-kept list dropped brazil-bdr-data.json and brazil-themes.json; the dirty tree then made
  // `git pull --rebase` refuse, so the job failed on every single run.
  const y = wf('brazil-daily.yml');
  assert.match(y, /git add data\/brazil\*/, 'Brazil went back to a hand-kept add list');
  assert.match(y, /brazil-bdr-data\.json|data\/brazil\*/, 'the BDR artifact is not staged');
  assert.match(y, /brazil-themes\.json|data\/brazil\*/, 'the themes artifact is not staged');
});

test('every market workflow carries forward companies a partial source omitted', () => {
  for (const [file, id] of [['hongkong-daily.yml', 'hk'], ['australia-daily.yml', 'au'], ['india-daily.yml', 'in'], ['indonesia-daily.yml', 'id'], ['brazil-daily.yml', 'br'], ['south-africa-daily.yml', 'za']]) {
    assert.match(wf(file), new RegExp(`merge-market-refresh\\.mjs ${id}`), `${file} would publish a shrunken market`);
  }
});

test('Render runs native Node and waits for the checks before deploying', () => {
  const r = readFileSync(join(ROOT, 'render.yaml'), 'utf8');
  assert.match(r, /^\s*runtime: node$/m, 'Render is not on the native Node runtime');
  assert.match(r, /^\s*startCommand: "node server\.js"$/m, 'Render lost its start command');
  assert.match(r, /^\s*autoDeployTrigger: checksPass$/m, 'Render would deploy a commit whose tests failed');
  assert.doesNotMatch(r, /env:\s*docker/, 'Render still builds the Docker image');
});

test('the global search index is rebuilt and committed after the market refreshes', () => {
  const y = wf('search-index-daily.yml');
  assert.match(y, /build-search-index\.mjs/, 'the search index build is missing');
  assert.match(y, /tests\/search\.test\.js/, 'the ranking tests are missing');
  assert.match(y, /tests\/search-index\.test\.js/, 'the built-index tests are missing');
  assert.match(y, /data\/search-index\.json/, 'the search index is not committed');
  assert.match(y, /data\/market-index\.json/, 'the country index series are not committed');
  assert.match(y, /data\/search-quick\.json/, 'the local-first search index is not committed');
  assert.match(y, /contents:\s*write/, 'the workflow cannot commit');
});
