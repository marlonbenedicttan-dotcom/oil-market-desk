// Boot the server once, with the warmers off, and fail if it cannot reach its listen callback.
//
// This is the guard for the class of deploy that fails after the build: a commit imports a helper
// that has not been added yet (or renames an export), so `node server.js` dies on the import and
// Render reports a failed deploy minutes after the build went green. The 2026-11-04 failure was
// exactly that — server.js imported `inventoryBands` and src/lib.js did not export it until the next
// commit 35 seconds later.
//
//   npm run check:boot
//
// The Dockerfile runs it before the image is accepted, and .githooks/pre-push runs it before a push.
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 10_000;
const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: '0', WARM: 'off', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
let done = false;
let timer;

function finish(ok, why) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  child.kill('SIGKILL');
  if (ok) return process.exit(0);
  console.error(`boot check failed: ${why}`);
  if (log) console.error(log.slice(-2500));
  process.exit(1);
}

timer = setTimeout(() => finish(false, `no listen callback after ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);
child.stdout.on('data', (d) => {
  log += d;
  // The server prints this only after server.listen() has fired and the durable state read is done.
  if (log.includes("running at")) finish(true);
});
child.stderr.on('data', (d) => { log += d; });
child.on('error', (e) => finish(false, e.message));
child.on('exit', (code, signal) => finish(false, `server exited (${code ?? signal}) before it was ready`));
