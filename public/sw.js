// E-Notes service worker: pre-caches the whole app so it opens offline.
// The build step (vite.config.js) fills in __PRECACHE and __VERSION.
self.__PRECACHE = [];
self.__VERSION = 'dev';

const CACHE = 'enotes-' + self.__VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(self.__PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('enotes-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only handle our own GET requests; Supabase API calls always go to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: network first (get new deploys quickly), fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./', { ignoreSearch: true }))
    );
    return;
  }

  // Assets: cache first, then network (and remember the result, e.g. pdf.js cmaps).
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
