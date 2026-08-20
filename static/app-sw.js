/* Lumen MSP PWA service worker — online-first (the app needs a connection).
   v2 adds Web Push: the push handler draws the notification, the click handler
   deep-links into the exact actionable card. Data stays live from the server;
   this file still deliberately caches nothing. */
const VERSION = 'lumen-msp-v2';
const OFFLINE_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f1f5f9;color:#0f172a;' +
  'display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;margin:0;}' +
  'div{max-width:320px}h1{font-size:20px;margin:0 0 8px}p{color:#64748b;font-size:14px;margin:0 0 16px}' +
  'button{font-size:16px;font-weight:700;padding:12px 20px;border:0;border-radius:10px;background:#2563eb;color:#fff}</style>' +
  '<div><h1>You’re offline</h1><p>Lumen MSP needs a connection. Check your signal and try again.</p>' +
  '<button onclick="location.reload()">Retry</button></div>';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never interfere with form posts / uploads
  // For page navigations, try the network; if it fails, show the offline screen.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } }))
    );
  }
});

/* ── Web Push ─────────────────────────────────────────────────────────────────
   The payload is JSON: { title, body, url, tag }. The covenant lives server-side
   (what gets pushed at all); this end just renders honestly. The tag means a
   re-send of the same card replaces its notification instead of stacking. */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Lumen MSP', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Lumen MSP', {
    body: d.body || '',
    tag: d.tag || 'lumen-pulse',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    data: { url: d.url || '/m' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/m';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Reuse an open app window if there is one - focus beats a second copy.
      for (const c of list) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return clients.openWindow(url);
    })
  );
});
