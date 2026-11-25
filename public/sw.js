// Service worker de El Morterito: permite instalar la app y que la pantalla abra sin conexión.
// Siempre intenta la red primero (para no mostrar una versión vieja después de publicar cambios);
// la copia guardada se usa solo si no hay internet. Los datos (/api) nunca se guardan acá.
const CACHE = 'morterito-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
