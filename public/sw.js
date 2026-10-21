/* CoffeeBuds service worker. Bump VERSION to invalidate old caches. */
const VERSION = 'v1.3.5';
const CACHE = 'coffeebuds-' + VERSION;
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/pwa.js', '/theme.js', '/offline.html', '/offline.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('coffeebuds-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET') return; // never touch POST/PUT (login, logout, writes)
  if (url.origin === location.origin && url.pathname.startsWith('/api')) {
    // Network only for API/auth: responses are user-specific and never stored.
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: 'You appear to be offline' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  if (req.mode === 'navigate') {
    // Network-first for pages so deploys show up immediately; cached shell, then offline page as fallback.
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); } return res; })
      .catch(() => caches.match('/').then((r) => r || caches.match('/offline.html'))));
    return;
  }
  if (url.origin === location.origin || /^(fonts\.(googleapis|gstatic)\.com|unpkg\.com)$/.test(url.hostname)) {
    // Stale-while-revalidate for static assets (CSS/JS/images/fonts/Leaflet).
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
});
