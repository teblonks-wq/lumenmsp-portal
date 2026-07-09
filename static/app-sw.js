/* Lumen MSP PWA service worker — online-first (the app needs a connection).
   Its job is to make the app installable and give a friendly screen when offline,
   not to cache the app (data is always live from the server). */
const VERSION = 'lumen-msp-v1';
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
