// Service worker — network-first for the app shell (so updates always show),
// with a cache fallback so it still opens offline-ish. API calls are never cached.
const CACHE = 'oil-desk-v2';
const SHELL = ['/', '/style.css', '/app.js', '/icon.svg', '/manifest.json'];

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
  // Never touch API calls or non-GET — always live.
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // Network-first: fresh files when online, cache only as an offline fallback.
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
