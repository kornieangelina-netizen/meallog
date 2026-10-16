// Bump CACHE on every change to app.js / styles.css / index.html: the app reloads itself on next open.
const CACHE = 'meallog-v2';
const ASSETS = ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // Only an upgrade (old cache present) reloads open pages; the very first install must not.
  e.waitUntil(
    caches.keys().then((keys) => {
      const old = keys.filter((k) => k !== CACHE);
      return Promise.all(old.map((k) => caches.delete(k))).then(() => old.length > 0);
    })
      .then((upgraded) => self.clients.claim().then(() => upgraded))
      .then((upgraded) => upgraded && self.clients.matchAll({ type: 'window' })
        .then((clients) => clients.forEach((c) => c.postMessage({ type: 'updated', cache: CACHE }))))
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp')
      || url.pathname === '/login') {
    return; // network only
  }
  // network first for the shell so a fresh deploy shows up; cache as offline fallback
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && !res.redirected) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
