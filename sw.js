/* offline cache. network-first for local files so edits always show;
   cache-first only for the cross-origin CDN lib. bump VERSION to invalidate. */
const VERSION = "sciencefeed-v0-3";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./feed.json",
  "./manifest.webmanifest",
  "./icon.svg",
  "https://unpkg.com/smiles-drawer@2/dist/smiles-drawer.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;

  if (sameOrigin) {
    // network-first: always try fresh, fall back to cache when offline.
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // cross-origin (CDN lib): cache-first for speed + offline.
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
