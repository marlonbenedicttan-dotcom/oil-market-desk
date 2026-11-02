// Refuse to publish a Taiwan build whose universe or chart history collapsed.
//
// The build writes before it commits. A rate-limited Yahoo run returns a one-point series for most
// codes, and publishing that would wipe every chart while the page still looked current. Compare the
// new file with the version in git and fail before the workflow stages anything.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const now = JSON.parse(readFileSync('data/taiwan.json', 'utf8'));
let old = null;
try {
  old = JSON.parse(execFileSync('git', ['show', 'HEAD:data/taiwan.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
} catch {
  console.log('no previous data/taiwan.json in HEAD — first build, nothing to compare');
  process.exit(0);
}

const companies = now.companies || [];
const before = old.companies || [];
const with6m = companies.filter((c) => c.chg6m != null).length;
const with6mBefore = before.filter((c) => c.chg6m != null).length;

const shrunk = before.length > 0 && companies.length < before.length * 0.9;
const historyGone = with6mBefore > 100 && with6m < with6mBefore * 0.7;

console.log(`companies ${companies.length} (was ${before.length}) · 6M returns ${with6m} (was ${with6mBefore})`);
if (shrunk || historyGone) {
  console.error('refusing to publish a collapsed Taiwan build — keeping the previous dataset');
  process.exit(1);
}
