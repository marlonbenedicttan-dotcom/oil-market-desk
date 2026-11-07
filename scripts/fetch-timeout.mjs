// Give every outbound fetch a hard timeout.
//
// Node's fetch has no default timeout, so one stalled SEC/Nasdaq socket can hold a 1,500-company
// build open indefinitely. This preload wraps global fetch with `AbortSignal.timeout` unless the
// caller already supplied a signal. Scripts already catch fetch errors and retry, so a timeout
// becomes a retryable failure instead of a hang.
//
//   NODE_OPTIONS="--import=./scripts/fetch-timeout.mjs" node scripts/whatever.mjs
//   FETCH_TIMEOUT_MS=90000 NODE_OPTIONS=... node scripts/whatever.mjs
//
// 60s is deliberately generous: a large 10-K or companyfacts document on a slow runner still fits.

const MS = Number(process.env.FETCH_TIMEOUT_MS || 60000);
const real = globalThis.fetch;

if (typeof real === 'function' && !globalThis.__watchtowerFetchTimeout) {
  globalThis.__watchtowerFetchTimeout = true;
  globalThis.fetch = (input, init = {}) => {
    if (init && init.signal) return real(input, init);
    return real(input, { ...init, signal: AbortSignal.timeout(MS) });
  };
}
