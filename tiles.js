/**
 * Fond de carte Plan IGN hors ligne : tuiles de la Géoplateforme (WMTS, grille
 * Web Mercator « PM » = z/x/y) gardées dans IndexedDB, recompressées en WebP.
 * Sans DOM pour les calculs (tests Node) ; le stockage et le calque Leaflet
 * n'existent que dans le navigateur.
 *
 * Licence ouverte Etalab : réutilisation libre, attribution « © IGN ».
 */
(function (root) {
  'use strict';

  const IGN_URL = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
    + '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/png'
    + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  const ATTRIBUTION = '© IGN Plan IGN';
  const DB_NAME = 'chatmtx-tiles', STORE = 'tiles';
  const ZONE_KEY = 'chatmtx-offline-zone';
  const EST_BYTES = 22000;     // taille moyenne estimée d'une tuile en WebP
  const CONCURRENCY = 4;

  const tileUrl = (z, x, y) => IGN_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);

  // ---------- Calculs (Web Mercator) ----------
  function lonToX(lon, z) { return Math.floor((lon + 180) / 360 * (1 << z)); }
  function latToY(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
  }

  /** Tuiles d'un disque (approché par son carré) de rayon km, zooms zmin..zmax. */
  function tilesAround(lat, lon, radiusKm, zmin, zmax) {
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
    const out = [];
    for (let z = zmin; z <= zmax; z++) {
      const x0 = lonToX(lon - dLon, z), x1 = lonToX(lon + dLon, z);
      const y0 = latToY(lat + dLat, z), y1 = latToY(lat - dLat, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
    }
    return out;
  }

  function estimate(lat, lon, radiusKm, zmin, zmax) {
    const n = tilesAround(lat, lon, radiusKm, zmin, zmax).length;
    return { tiles: n, bytes: n * EST_BYTES };
  }

  // ---------- IndexedDB ----------
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  function op(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    }));
  }
  const getTile = (key) => op('readonly', (s) => s.get(key));
  const putTile = (key, blob) => op('readwrite', (s) => s.put(blob, key));
  const hasTile = (key) => op('readonly', (s) => s.count(key)).then((n) => n > 0);
  const clearTiles = () => op('readwrite', (s) => s.clear());
  const countTiles = () => op('readonly', (s) => s.count());

  /** PNG IGN → WebP (≈ 3 fois plus petit). Sans prise en charge : la PNG telle quelle. */
  function toWebp(blob) {
    if (typeof createImageBitmap !== 'function') return Promise.resolve(blob);
    return createImageBitmap(blob).then((bmp) => new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      c.toBlob((b) => resolve(b && b.size < blob.size ? b : blob), 'image/webp', 0.8);
    })).catch(() => blob);
  }

  // Le serveur IGN refuse parfois une rafale (HTTP 400/429) : nouvel essai, espacé
  function fetchRetry(url, tries) {
    return fetch(url, { mode: 'cors' }).then((r) => {
      if (r.ok) return r.blob();
      if (tries > 1) return new Promise((ok) => setTimeout(ok, 700)).then(() => fetchRetry(url, tries - 1));
      throw new Error('HTTP ' + r.status);
    });
  }

  function fetchTile(z, x, y) {
    return fetchRetry(tileUrl(z, x, y), 3)
      .then(toWebp)
      .then((b) => putTile(z + '/' + x + '/' + y, b).then(() => b));
  }

  /**
   * Télécharge une zone (reprend là où elle s'est arrêtée : tuiles déjà là sautées).
   * @returns {{promise, cancel}}  promise → {done, failed, bytes, cancelled}
   */
  function download(lat, lon, radiusKm, zmin, zmax, onProgress) {
    const list = tilesAround(lat, lon, radiusKm, zmin, zmax);
    let i = 0, done = 0, failed = 0, bytes = 0, cancelled = false;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const worker = () => {
      if (cancelled || i >= list.length) return Promise.resolve();
      const [z, x, y] = list[i++];
      const key = z + '/' + x + '/' + y;
      return hasTile(key)
        .then((has) => (has ? null : fetchTile(z, x, y).then((b) => { bytes += b.size; })))
        .catch(() => { failed++; })
        .then(() => { done++; if (onProgress) onProgress(done, list.length, bytes, failed); })
        .then(worker);
    };
    const promise = Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      const zone = { lat, lon, radiusKm, zmin, zmax, date: Date.now(), tiles: list.length, failed, cancelled };
      try { localStorage.setItem(ZONE_KEY, JSON.stringify(zone)); } catch (e) { /* stockage plein */ }
      return { done, failed, bytes, cancelled };
    });
    return { promise, cancel: () => { cancelled = true; } };
  }

  function zone() {
    try { return JSON.parse(localStorage.getItem(ZONE_KEY) || 'null'); } catch (e) { return null; }
  }
  function clearAll() {
    try { localStorage.removeItem(ZONE_KEY); } catch (e) { /* idem */ }
    return clearTiles();
  }

  /**
   * Calque Leaflet : IndexedDB d'abord ; en ligne, réseau (et mise en cache) ;
   * hors ligne sans tuile : transparent (le fond monde reste visible).
   */
  function layer(L) {
    const Layer = L.GridLayer.extend({
      createTile(coords, done) {
        const img = document.createElement('img');
        img.alt = '';
        const key = coords.z + '/' + coords.x + '/' + coords.y;
        const show = (blob) => {
          // Pas de tuile : emplacement masqué (une image vide garderait un cadre gris)
          if (!blob) { img.style.visibility = 'hidden'; done(null, img); return; }
          const url = URL.createObjectURL(blob);
          img.onload = () => { URL.revokeObjectURL(url); done(null, img); };
          img.onerror = () => { URL.revokeObjectURL(url); done(null, img); };
          img.src = url;
        };
        getTile(key).then((blob) => {
          if (blob) return show(blob);
          if (navigator.onLine === false) return show(null);
          return fetchTile(coords.z, coords.x, coords.y).then(show, () => show(null));
        }, () => show(null));
        return img;
      },
    });
    return new Layer({ attribution: ATTRIBUTION, minZoom: 3, maxZoom: 18, maxNativeZoom: 18 });
  }

  const Tiles = { tilesAround, estimate, download, zone, clearAll, countTiles, layer, tileUrl, ATTRIBUTION, EST_BYTES };
  if (typeof module === 'object' && module.exports) module.exports = Tiles;
  else root.Tiles = Tiles;
})(typeof self !== 'undefined' ? self : this);
