/* offline support.
   - app shell + feed manifest: network-first (so pushes and new cards show),
     falling back to cache when offline.
   - feed chunks: cache-first (append-only, never change once written).
   the shell is still precached on install for the very first offline load. */

const VERSION = 'feed-v4';
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

// Only the newest chunk is still being rewritten (the pipeline appends to it
// until it fills, then rolls over); older chunks are frozen. So serve the
// current chunk network-first — otherwise nightly updates never reach an
// already-cached reader — and keep the frozen ones cache-first for speed and
// offline. The manifest (network-first, fetched before any chunk on load)
// tells us which chunk is current.
async function chunkStrategy(request) {
  let current = null;
  const manifestUrl = new URL('./data/feed/manifest.json', self.location).toString();
  const cachedManifest = await caches.match(manifestUrl);
  if (cachedManifest) {
    try {
      const m = await cachedManifest.json();
      if (Array.isArray(m.chunks) && m.chunks.length) {
        current = m.chunks[m.chunks.length - 1];
      }
    } catch (_) { /* fall through to cache-first */ }
  }
  const isCurrent = current && new URL(request.url).pathname.endsWith('/' + current);
  return isCurrent ? networkFirst(request, DATA) : cacheFirst(request, DATA);
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

  // feed chunks: current one network-first (still changing), rest cache-first.
  if (/\/data\/feed\/chunk-\d+\.json$/.test(url.pathname)) {
    e.respondWith(chunkStrategy(request));
    return;
  }

  // manifest is volatile; shell assets change on every deploy -> network-first.
  const cacheName = url.pathname.includes('/data/feed/') ? DATA : SHELL;
  e.respondWith(networkFirst(request, cacheName));
});
