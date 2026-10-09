// for static hosts that cannot send headers (GitHub Pages, say): adds the COOP/COEP headers
// that make the page cross-origin isolated, so it can use SharedArrayBuffer. index.html
// registers it only when the page is not isolated already
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  // cross-origin requests (the CDN) go straight through: they come with CORS headers
  if (new URL(req.url).origin !== location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith(fetch(req).then(res => {
    if (res.status === 0) return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
