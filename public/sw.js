// Service worker — the versioned assets (app.js?v=…, style.css?v=…) are immutable, so they are served
// from cache and never revalidated; the shell itself stays network-first so a new deploy always shows.
// A few read-only API snapshots are cached stale-while-revalidate: repeat visits paint the market
// board and home summary immediately, then refresh in the background. Everything else stays live.
const CACHE = 'oil-desk-v16';
// Only the document shell is precached. app.js and style.css used to sit here at their UNVERSIONED
// URLs, so install downloaded a second copy of both (~240 KB brotli) that the page never asked for —
// it loads app.js?v=<hash> and style.css?v=<hash>, which are immutable and cached on first use below.
// The old entries also pinned icon/manifest at ?v=3 while the page asks for ?v=4.
const SHELL = ['/'];

const isVersioned = (url) => ['v', 'ver', 'version'].some((k) => url.searchParams.has(k));
const API_SWR = new Set(['/api/market', '/api/home', '/api/markets', '/api/regime', '/api/market-index',
  // First-screen panels a returning reader sees immediately: the calendar, the day's brief and the
  // daily history (deltas + sparklines). Each revalidates in the background, so the copy is never
  // the one they are left with.
  '/api/calendar', '/api/brief', '/api/history']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // The home board and market summary are large and slow on a cold server. Serve the last copy
  // immediately and refresh it in the background; a first visit still waits for the network.
  if (url.pathname.startsWith('/api/')) {
    if (!API_SWR.has(url.pathname)) return;
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then((res) => {
        if (res && res.ok) c.put(e.request, res.clone()).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  // ?v= promises the bytes never change, so a repeat visit can skip the network entirely.
  if (isVersioned(url)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })),
    );
    return;
  }
  // Network-first: fresh files when online, cache as the offline fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
