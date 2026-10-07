// Bump these whenever the shell changes, so `activate` drops the old entries.
// (v9: design-foundations rewrite of shared.css + the new motion.js engine.)
const STATIC_V = 'tri-static-v9';
const DATA_V   = 'tri-data-v9';

const SHELL = [
  '/', '/login.html', '/hub.html', '/rental.html', '/store.html',
  '/agriculture.html', '/profile.html', '/ai.html', '/admin.html',
  '/shared.css', '/shared.js', '/motion.js', '/manifest.json',
  '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png'
];

// ── INSTALL: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(STATIC_V)
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== STATIC_V && k !== DATA_V).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API calls: network-first, fall back to cached response
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request.clone())
        .then(resp => {
          if (resp.ok) caches.open(DATA_V).then(c => c.put(request, resp.clone()));
          return resp;
        })
        .catch(() =>
          caches.match(request).then(cached =>
            cached || new Response(
              JSON.stringify({ error: 'You are offline. Cached data may be stale.' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            )
          )
        )
    );
    return;
  }

  // Page navigations: cache-first, then network, then ALWAYS fall back to a
  // cached page so the browser never shows "site can't be reached" offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      caches.match(request).then(cached =>
        cached || fetch(request).then(resp => {
          if (resp.ok) caches.open(STATIC_V).then(c => c.put(request, resp.clone()));
          return resp;
        }).catch(() =>
          caches.match('/hub.html').then(h => h || caches.match('/login.html'))
        )
      )
    );
    return;
  }

  // Other static assets: cache-first, then network
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request.clone()).then(resp => {
        if (resp.ok || resp.type === 'opaque') {
          const bucket = url.hostname === self.location.hostname ? STATIC_V : DATA_V;
          caches.open(bucket).then(c => c.put(request, resp.clone()));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});

// ── BACKGROUND SYNC ──────────────────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'flush-offline-queue') {
    e.waitUntil(notifyClients('TRIGGER_SYNC'));
  }
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'sync-data') {
    e.waitUntil(notifyClients('TRIGGER_SYNC'));
  }
});

async function notifyClients(type) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type }));
}

// ── MESSAGES FROM PAGE ───────────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
