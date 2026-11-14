// A small, targeted secret scan for the files that are actually public.
//
// GitHub secret scanning is the real control. This catches the common case before a commit is
// pushed: a paid API key pasted into a source file or a tracked config. It never prints the value.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SKIP = /^(data\/|public\/vendor\/|public\/.*\.min\.(js|css)$|package-lock\.json$|node_modules\/)/;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => !SKIP.test(f));

const prefixRules = [
  ['Resend key', /\bre_[A-Za-z0-9]{20,}\b/],
  ['GitHub token', /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Private key', /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/],
];
const envRules = /\b(JQUANTS_API_KEY|DART_API_KEY|EIA_API_KEY|RESEND_API_KEY|SMTP_PASS|UPSTASH_REDIS_REST_TOKEN)\s*=\s*([^\s#]+)/g;
const placeholder = (v) => !v || v.startsWith('...') || v.startsWith('${{') || v.startsWith('<') || v.startsWith('your-');

const hits = [];
for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;                 // binary
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of prefixRules) {
      if (re.test(line)) hits.push({ file, line: i + 1, name });
    }
    for (const m of line.matchAll(envRules)) {
      if (!placeholder(m[2])) hits.push({ file, line: i + 1, name: `${m[1]} assignment` });
    }
  });
}

if (hits.length) {
  console.error('Possible secrets in tracked files:');
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.name}`);
  console.error('Keep keys in .env locally and in GitHub/Render secrets. Do not commit them.');
  process.exit(1);
}
console.log(`secret scan: clean (${files.length} tracked files)`);
