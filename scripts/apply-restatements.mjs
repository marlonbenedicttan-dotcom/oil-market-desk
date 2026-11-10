// Re-apply every restatement we have already detected.
//
// A rebuild rewrites each field from the original 10-K facts, which silently reverts an amendment: the
// `restatement` record survived, the corrected value did not, and TSLA's equity went back to the
// pre-amendment figure. This runs after any rebuild and is a no-op when nothing was restated.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'companies.json');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let applied = 0, changed = 0, annotated = 0;
for (const c of data.companies) {
  const changes = c.restatement && c.restatement.changes;
  if (!changes) continue;
  applied++;
  for (const [field, v] of Object.entries(changes)) {
    // A later 10-Q/10-K supersedes the amended annual figure. Applying the restatement on top of it
    // would undo the newer book value and leave P/B/ROE computed from a different equity.
    const endKey = field + 'End';
    if (c[endKey] && c.restatement.period && c[endKey] > c.restatement.period) continue;
    let now = v && v.now;
    // A 10-K/A corrects a number; it does not replace annual revenue with one quarter or one segment
    // of itself. The amendment parser occasionally lands on a quarterly tag, which produced CC's
    // $5.8B -> $1.3B, WRLD's $565M -> $176M and TMP's $579M -> $76M "restatements". Reject the scope
    // mismatch and annotate the record; the field keeps whatever the last rebuild wrote from the facts.
    if (field === 'revenue' && now != null && v.was > 0 && (now / v.was < 0.5 || now / v.was > 2)) {
      c.restatement.rejected = {
        ...(c.restatement.rejected || {}),
        [field]: { was: v.was, now, reason: 'amended value is a different scope (quarter/segment), not annual revenue' },
      };
      annotated++;
      console.log(`  ${c.ticker}: rejected revenue restatement ${v.was} -> ${now}`);
      continue;
    }
    // The amendment is sometimes parsed in thousands or millions while the original field is dollars
    // (Visteon's 213 was millions; Sezzle's 133,130 was thousands). Put it on the original's scale
    // when that lands within 3× of the value it replaces; never invent a factor for a genuine collapse.
    if (now != null && v.was != null && Math.abs(v.was) > 0 && Math.abs(now) > 0) {
      const ratio = Math.abs(v.was) / Math.abs(now);
      if (ratio > 100) {
        const scaled = now * 10 ** Math.round(Math.log10(ratio));
        if (Math.abs(scaled) >= Math.abs(v.was) / 3 && Math.abs(scaled) <= Math.abs(v.was) * 3) {
          now = scaled;
          v.now = scaled;          // persist the corrected record the test and the page read
        }
      }
    }
    if (now != null && c[field] !== now) { c[field] = now; changed++; }
    // Keep the five-year table on the same amended figure as the headline; otherwise the deep audit
    // sees FY2025 revenue/net income that disagrees with the value above it.
    if (now != null && Array.isArray(c.series) && c.restatement.period) {
      const fy = Number(String(c.restatement.period).slice(0, 4));
      const s = c.series.find((x) => x.fy === fy);
      if (s && s[field] !== now) { s[field] = now; changed++; }
    }
  }
}
if (changed || annotated) {
  writeFileSync(FILE + '.tmp', JSON.stringify(data));
  renameSync(FILE + '.tmp', FILE);
}
console.log(`${applied} recorded restatements · ${changed} values restored · ${annotated} rejected as a different scope`);
