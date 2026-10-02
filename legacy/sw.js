// Ancienne adresse sonochat.f4mtx.com : ce Service Worker remplace celui de
// SonoChat, se désinstalle et recharge les pages ouvertes. Sans Service Worker,
// la navigation atteint la page de migration (legacy/index.html), qui emporte
// l'historique et les réglages vers chatmtx.f4mtx.com.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate('/');
    }
  })());
});
