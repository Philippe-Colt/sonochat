// Le déploiement (deploy.sh) remplace cette version par une empreinte des
// fichiers servis : chaque mise en ligne invalide le cache sans bump manuel.
const CACHE_NAME = 'chatmtx-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './ft8-modem.js',
  './arq.js',
  './directory.js',
  './native-serial.js',
  './medevac.js',
  './medevac-ui.js',
  './directory-ui.js',
  './qrcode.js',
  './leaflet.js',
  './leaflet.css',
  './milsymbol.js',
  './world.json',
  './tiles.js',
  './tacmap.js',
  './app.js',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // 'reload' contourne le cache HTTP : on précache la version du serveur,
      // pas une copie périmée gardée par le navigateur ou Cloudflare.
      .then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Fichier ouvert directement (chatmtx.apk, apk-version.json) : toujours le
  // réseau. Sinon la navigation vers l'APK recevrait l'app shell, et le
  // navigateur afficherait l'application au lieu de télécharger la mise à jour.
  const path = new URL(req.url).pathname;
  if (/\.(apk|json)$/i.test(path) && !path.endsWith('manifest.json')) return;

  // Navigation (y compris avec paramètres d'URL) : l'app shell, même hors ligne.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(cached => cached || fetch(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true })
      .then(cached => cached || fetch(req))
  );
});
