/* offline support.
   - app shell + feed manifest: network-first (so pushes and new cards show),
     falling back to cache when offline.
   - feed chunks: cache-first (append-only, never change once written).
   the shell is still precached on install for the very first offline load. */

const VERSION = 'feed-v2';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/ricky.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(request, cacheName, fallbackKey) {
  return fetch(request)
    .then((res) => {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy));
      return res;
    })
    .catch(() => caches.match(fallbackKey || request));
}

function cacheFirst(request, cacheName) {
  return caches.match(request).then((cached) =>
    cached || fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy));
      return res;
    }));
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // navigation: network-first, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(request, SHELL, './index.html'));
    return;
  }

  // feed chunks are append-only — safe and fast to serve from cache.
  if (/\/data\/feed\/chunk-\d+\.json$/.test(url.pathname)) {
    e.respondWith(cacheFirst(request, DATA));
    return;
  }

  // manifest is volatile; shell assets change on every deploy -> network-first.
  const cacheName = url.pathname.includes('/data/feed/') ? DATA : SHELL;
  e.respondWith(networkFirst(request, cacheName));
});
