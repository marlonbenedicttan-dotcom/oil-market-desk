// Headless check of the INDIA tab: does it render, does it throw, does it fit a phone.
//
// Runs against the local server with the committed data. Uses Chrome's DevTools protocol over the
// built-in WebSocket (Node 22 has one), so there is no dependency to install.
//
//   node scripts/check-india-ui.mjs http://localhost:4173
//
// Exit 1 if the page throws, the market does not paint, or the phone layout overflows.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:4173';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(CHROME)) { console.error('Chrome not found at', CHROME); process.exit(2); }

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=/tmp/india-ui-${Date.now()}`, 'about:blank',
], { stdio: 'ignore' });

const waitFor = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timed out');
};

const LIST = await waitFor(async () => {
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const j = await r.json();
  return j.length ? j : null;
});

const page = LIST.find((t) => t.type === 'page') || LIST[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text);
};
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id;
  pending.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(3500);
// Chrome can attach to an already-running headless instance and reuse its profile, which would carry
// the previous run's remembered view. Start from a known state.
await evaluate(`try { localStorage.clear(); } catch {}`);
await send('Page.reload', {});
await sleep(3500);

// The app remembers the region, but a cleared profile starts on the S&P. Open COMPANIES then INDIA.
await evaluate(`document.querySelector('[data-tab="deals"]')?.click()`);
await sleep(2500);
await evaluate(`document.querySelector('[data-region="in"]')?.click()`);
// Poll: the free instance can take a few seconds to wake and ship the 348 KB list.
for (let i = 0; i < 40; i++) {
  const txt = await evaluate(`document.querySelector('#co-body')?.innerText || ''`);
  // "Loading the NIFTY 500…" also matches /NIFTY 50/, so wait for the rendered count as well.
  if (/NIFTY 50/.test(txt) && /companies/i.test(txt)) break;
  await sleep(750);
}

const check = async (label, expr) => {
  const v = await evaluate(expr);
  console.log(`${v ? 'ok  ' : 'FAIL'} ${label}${typeof v === 'string' ? ' · ' + v : ''}`);
  return v;
};

let bad = 0;
const want = async (label, expr) => { if (!(await check(label, expr))) bad++; };

await want('INDIA region is selected', `document.querySelector('[data-region="in"]')?.classList.contains('on')`);
await want('market view names the NIFTY 50', `/NIFTY 50/.test(document.querySelector('#co-body')?.innerText || '')`);
await want('a company count is rendered', `/(\\d{3})\\s+companies/i.test(document.querySelector('#co-body')?.innerText || '')`);
await want('sector rows rendered', `(document.querySelectorAll('.jp-mkt-row')||[]).length > 10`);

// Screener view
await evaluate(`document.querySelector('[data-inview="screener"], [data-screen-market="in"]')?.click()`);
await sleep(4000);
const rows = await evaluate(`document.querySelectorAll('[data-in]').length`);
console.log(`${rows > 20 ? 'ok  ' : 'FAIL'} screener rows · ${rows}`);
if (!(rows > 20)) bad++;

// Pagination: the next-page control must stay inside India. This was wired to the Australia pager,
// so one click rendered the ASX screen while the region still said India.
await evaluate(`document.querySelector('[data-inlistpage="2"]')?.click()`);
await sleep(2500);
const afterPage = await evaluate(`document.querySelector('#co-body')?.innerText || ''`);
const pageState = await evaluate(`JSON.stringify({ region: coRegion, view: inView, page: inPage })`);
const rows2 = await evaluate(`document.querySelectorAll('[data-in]').length`);
const pageOk2 = rows2 > 20 && /"region":"in"/.test(pageState) && /"page":2/.test(pageState) && !/ASX/.test(afterPage);
console.log(`  page 2 · ${rows2} rows`);
console.log(`${pageOk2 ? 'ok  ' : 'FAIL'} next page stays on India · ${pageState}`);
if (!pageOk2) bad++;

// Open one company (a bank, so the suppressed ratios are exercised)
await evaluate(`document.querySelector('[data-in]')?.click()`);
await sleep(4500);
const body = await evaluate(`document.querySelector('#co-body')?.innerText || ''`);
const pageOk = /INR|₹/.test(body) && body.length > 200;
console.log(`${pageOk ? 'ok  ' : 'FAIL'} company page rendered · ${body.length} chars${pageOk ? '' : ' · ' + body.replace(/\s+/g, ' ').slice(0, 200)}`);
if (!pageOk) bad++;
await want('returned to the market list control exists', `!!document.querySelector('[data-inback]')`);

// Themes view: the curated lists render and at least one has members.
await evaluate(`document.querySelector('[data-inback]')?.click()`);
await sleep(1200);
// A cold free instance can take several seconds to paint the panel; click, then wait for the chips.
for (let i = 0; i < 8; i++) {
  await evaluate(`document.querySelector('[data-inview="themes"]')?.click()`);
  await sleep(1500);
  if (await evaluate(`document.querySelectorAll('[data-intheme]').length`)) break;
}
const themes = await evaluate(`document.querySelectorAll('[data-intheme]').length`);
const themeBody = await evaluate(`document.querySelector('#co-body')?.innerText || ''`);
console.log(`${themes >= 5 ? 'ok  ' : 'FAIL'} theme presets · ${themes}`);
if (!(themes >= 5)) bad++;
console.log(`${themeBody.length > 400 ? 'ok  ' : 'FAIL'} theme panel rendered · ${themeBody.length} chars`);
if (!(themeBody.length > 400)) bad++;

// Phone layout: no horizontal overflow of the document.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await sleep(2500);
const overflow = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
console.log(`${overflow <= 2 ? 'ok  ' : 'FAIL'} phone width 390 · overflow ${overflow}px`);
if (overflow > 2) bad++;

console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log('  ✗ ' + e);

ws.close();
chrome.kill('SIGKILL');
process.exit(bad || errors.length ? 1 : 0);
