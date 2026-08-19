// Dayflow service worker — powers (1) installable PWA + basic offline shell,
// and (2) reminder push notifications (even when the app/tab is closed).

// Bump this on every release that changes index.html / support.js. The fetch
// handler below is cache-first, and `install` only re-runs when THIS file
// changes — so without a bump, an already-installed app keeps serving the old
// shell from cache forever. v4 = read-only offline mode.
const CACHE = 'dayflow-shell-v4';
const SHELL = [
  './',
  './index.html',
  './support.js',
  './manifest.webmanifest',
  './assets/logo.svg',
  './assets/bg.png',
  './assets/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The whole app — markup, logic, everything — lives in index.html and
// support.js. Serving those from cache first means a deploy is invisible until
// the cache name changes, and one forgotten CACHE bump ships a client that talks
// to an API that has moved on. So those two are NETWORK-FIRST: always try the
// network, fall back to the cached copy only when offline. Everything else
// (icons, fonts, the background image) is immutable enough for cache-first.
const NETWORK_FIRST = ['/', '/index.html', '/support.js', '/sw.js', '/manifest.webmanifest'];

// The API must NEVER be cached: on Vercel it is served from the same origin
// (/api/*), so without this guard the SW would serve stale data.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // network-only, never cache

  const scope = new URL(self.registration.scope).pathname.replace(/\/$/, '');
  const rel = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) || '/' : url.pathname;
  const fresh = req.mode === 'navigate' || NETWORK_FIRST.includes(rel);

  const store = (res) => {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };

  if (fresh) {
    // Offline navigations fall back to the cached shell even when the exact
    // request URL was never cached — otherwise a reload offline shows the
    // browser's dinosaur instead of the app.
    e.respondWith(fetch(req).then(store).catch(
      () => caches.match(req).then((c) => c || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
    ));
    return;
  }
  e.respondWith(caches.match(req).then((cached) => cached || fetch(req).then(store).catch(() => cached)));
});

// ---- Reminder push notifications ----
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'Dayflow reminder';
  const options = {
    body: data.body || '',
    tag: data.tag,
    renotify: !!data.tag,
    icon: './assets/icon-192.png',
    badge: './assets/icon-192.png',
    data,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
