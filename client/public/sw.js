/* SimpliGame service worker.
 *
 * Strategy:
 * - App shell + static assets (JS/CSS/images/fonts): cache-first, with
 *   runtime caching for Vite's hashed filenames.
 * - /api/* GETs: network-first, stale cache as an offline fallback.
 * - Mutations (POST/PATCH/DELETE) are NEVER cached or replayed here.
 *   Offline stat events are queued by the client (localStorage) and
 *   retried on reconnect — that is the one retry path, so an event can
 *   never be sent twice by two mechanisms.
 * - Third-party origins (YouTube embeds, etc.) are left alone entirely.
 */

const CACHE = 'simpligame-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg?v=2', '/favicon.svg?v=2'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GETs. Everything else (YouTube, mutations)
  // passes through untouched.
  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    // Network-first: fresh data when online, stale cache when offline.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  if (request.mode === 'navigate') {
    // Navigation: network-first, fall back to the cached shell offline so
    // the app still opens (with its own loading/error states).
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/index.html').then((cached) => cached ?? new Response('Offline', { status: 503 })),
      ),
    );
    return;
  }

  // Static assets: cache-first, populate on first fetch.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return res;
      });
    }),
  );
});
