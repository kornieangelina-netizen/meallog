// Bump CACHE and the ?v= in index.html on every change to app.js / styles.css / index.html:
// the app reloads itself on next open, and the new index.html never runs with an old app.js.
const CACHE = 'meallog-v11';
const ASSETS = ['/', '/app.js?v=11', '/styles.css?v=11', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

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
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// phone notifications: the server sends {title, body, tag, url}; a tap opens (or focuses) the app at url
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'MealLog', {
    body: d.body || '', tag: d.tag || 'meallog', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) return c.navigate(url).then((w) => (w || c).focus()).catch(() => c.focus());
    }
    return self.clients.openWindow(url);
  }));
});
