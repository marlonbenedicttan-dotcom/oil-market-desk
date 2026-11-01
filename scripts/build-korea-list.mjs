// Write the compact list payload the /api/korea endpoint serves.
//
// korea.json is ~28 MB because every company carries five years of daily closes; the list needs
// 241 KB of fields. Parsing the full file to project it cost ~200 ms and ~200 MB of heap on the
// request path, which is what made the KOREA tab slow and heavy. The build writes the same payload
// here once, and the server falls back to the full projection if this file is missing or stale.
//
//   node scripts/build-korea-list.mjs
//
// Run by build-korea.mjs after descriptions are attached (they add brands, which the list ships).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { koreaList } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data', 'korea.json');
const OUT = join(ROOT, 'data', 'korea-list.json');

const data = JSON.parse(readFileSync(SRC, 'utf8'));
const list = koreaList(data);
const body = JSON.stringify(list);
writeFileSync(`${OUT}.tmp`, body);
renameSync(`${OUT}.tmp`, OUT);
// The server compares this stamp with korea.json's own `updated`, so a failed or skipped rebuild
// falls back to the full projection instead of publishing a stale list.
console.log(`${(body.length / 1024).toFixed(0)} KB · ${(list.companies || []).length} companies · ${list.updated}`);
