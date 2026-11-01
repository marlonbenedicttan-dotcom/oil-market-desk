// Service worker — the versioned assets (app.js?v=…, style.css?v=…) are immutable, so they are served
// from cache and never revalidated; the shell itself stays network-first so a new deploy always shows.
// API calls are never cached.
const CACHE = 'oil-desk-v3';
const SHELL = ['/', '/style.css', '/app.js', '/icon.svg', '/manifest.json'];

const isVersioned = (url) => ['v', 'ver', 'version'].some((k) => url.searchParams.has(k));

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
