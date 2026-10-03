/**
 * Carte tactique : chaque message formaté envoyé ou reçu (historique) devient un
 * symbole APP-6 (milsymbol) sur fond Plan IGN hors ligne (tiles.js) ou, à défaut,
 * sur un fond monde minimal (world.json). Carroyage MGRS, trajets POSREP,
 * vieillissement des symboles.
 *
 * Le noyau (correspondance message → symbole, projection, carroyage) est sans DOM
 * et testé en Node (tests/tacmap.js) ; l'écran n'existe que dans le navigateur.
 */
(function (root) {
  'use strict';
  const M = root.Medevac || (typeof require === 'function' ? require('./medevac.js') : null);

  // ============================================================
  // SYMBOLES APP-6 (SIDC 15 car., lettres ; choisis sur planche milsymbol)
  // ============================================================

  const FRIEND = 'SFGPU----------';
  const HOSTILE = 'SHGPU----------';
  const HOSTILE_INF = 'SHGPUCI--------';
  const UNKNOWN = 'SUGPU----------';
  const MEDEVAC = 'EFOPAE---------';   // opération médicale d'urgence : ambulance
  const EMS = 'EFOPAA---------';       // secours médical d'urgence
  const EMERGENCY = 'EFOPB----------'; // opération de secours (générique)
  const UXO = 'EFIPDO---------';
  const IED = 'OHVPEI---------';
  const MINE = 'OHVPM----------';
  const SNIPER = 'OHVPS----------';
  const BLAST = 'OHVPE----------';

  // METHANE : index du type (medevac.js) → symbole d'incident
  const METHANE_SIDC = [
    'EFIPHA---------', // Accident routier
    'EFIPGA---------', // Ferroviaire
    'EFIPEA---------', // Aérien
    'EFIPFA---------', // Maritime
    'EFIPC----------', // Incendie
    'EFIPDD---------', // Explosion
    'EFNPA----------', // Effondrement (géologique, libellé)
    'EFIPDN---------', // NRBC
    'EFNPBC---------', // Inondation
    'EFNPB----------', // Tempête (hydro-météo, libellé)
    'EFNPAC---------', // Séisme
    'EFIPBF---------', // Attentat, tuerie
    'EFIPA----------', // Mouvement de foule
    'EFIPD----------', // Accident industriel
    EMERGENCY,         // Autre
  ];
  // Renseignement : nature (Je vois) → symbole
  const NATURE_SIDC = [
    'EFIPCD---------', // Feu d'habitation
    'EFIPCB---------', // Feu d'établissement
    'EFIPCB---------', // Feu industriel
    'EFIPC----------', // Feu de véhicule
    'EFIPCH---------', // Feu de végétation
    'EFIPHA---------', // Accident de circulation
    EMS,               // Secours à personne
    'EFIPDE---------', // Fuite de gaz
    'EFIPD----------', // Produit dangereux, pollution
    'EFNPA----------', // Effondrement
    'EFNPBC---------', // Inondation
    'EFIPDD---------', // Explosion
    'EFIPFA---------', // Sauvetage, noyade
    EMERGENCY,         // Autre
  ];
  // CONTACT : nature → symbole
  const CONTACT_SIDC = [HOSTILE_INF, BLAST, HOSTILE_INF, IED, MINE, SNIPER, HOSTILE, 'SHAPMFQ--------', UNKNOWN, HOSTILE];
  // UXO : type d'engin → symbole (IED et mine ont le leur)
  const UXO_SIDC = [UXO, UXO, UXO, UXO, IED, MINE, UXO, UXO];

  /** Point d'arrivée depuis (lat, lon), azimut en degrés, distance en mètres (sphère). */
  function destinationPoint(lat, lon, bearingDeg, distM) {
    const R = 6371008.8, d = distM / R, b = bearingDeg * Math.PI / 180;
    const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * 180 / Math.PI, lon: ((l2 * 180 / Math.PI + 540) % 360) - 180 };
  }

  /**
   * Symboles à poser pour un message décodé.
   * @returns {Array<{sidc, lat, lon, label, info, from?}>}  vide si pas de position
   */
  function symbolsFor(dec, msg) {
    if (!dec || dec.readback) return [];
    const call = msg.call || '?';
    const out = [];
    const add = (sidc, pos, label, info, extra) => { if (pos) out.push(Object.assign({ sidc, lat: pos.lat, lon: pos.lon, label, info: info || '' }, extra || {})); };
    if (dec.nine) {
      const c = dec.nine.counts;
      const prec = ['A', 'B', 'C', 'D', 'E'].map((k, i) => (c[i] ? c[i] + k : '')).filter(Boolean).join(' ');
      add(MEDEVAC, dec.nine, '9-LINE ' + call, prec);
    }
    if (!dec.fmt) return out;
    const d = dec.data;
    switch (dec.fmt) {
      case 'E': {
        const t = M.FORMATS.E.fields[2].options[d.type].label;
        add(METHANE_SIDC[d.type] || EMERGENCY, d.pos, 'METHANE ' + call, `${t} · UA${d.ua} UR${d.ur} I${d.imp} D${d.dcd}`);
        break;
      }
      case 'R':
        add(NATURE_SIDC[d.nature] || EMERGENCY, d.pos, 'RENS. ' + call,
          M.FORMATS.R.fields[1].options[d.nature].label + (d.victims ? ` · ${d.victims} vict.` : ''));
        break;
      case 'S':
        add(d.unit === 0 ? HOSTILE_INF : d.unit === 4 ? UNKNOWN : HOSTILE, d.pos, 'SALUTE ' + call,
          (d.size === null ? '?' : d.size) + ' · ' + M.FORMATS.S.fields[1].options[d.activity].label);
        break;
      case 'K': {
        const known = d.bearing !== null && d.dist !== null;
        const p = known ? destinationPoint(d.pos.lat, d.pos.lon, d.bearing, d.dist) : d.pos;
        add(CONTACT_SIDC[d.nature] || HOSTILE, p, 'CONTACT ' + call, M.FORMATS.K.fields[3].options[d.nature].label
          + (known ? ` · ${d.bearing}° ${d.dist} m` : ' · position de l\'observateur'), known ? { from: d.pos } : null);
        break;
      }
      case 'U':
        add(UXO_SIDC[d.type] || UXO, d.pos, 'UXO ' + call, M.FORMATS.U.fields[3].options[d.type].label
          + ' · priorité ' + M.FORMATS.U.fields[8].options[d.priority].label.toLowerCase());
        break;
      case 'P':
        add(FRIEND, d.pos, call, 'POSREP', { unit: call, posrep: true });
        break;
      default:
    }
    return out;
  }

  /** Position connue d'une station d'après ses messages (POSREP, CONTACT, renseignement). */
  function selfPosition(dec) {
    if (!dec || !dec.fmt) return null;
    if (dec.fmt === 'P' || dec.fmt === 'K' || dec.fmt === 'R') return dec.data.pos;
    return null;
  }

  /** Opacité selon l'âge : 100 % < 1 h, 60 % < 6 h, 30 % au-delà. */
  const ageOpacity = (ageMs) => (ageMs < 3600e3 ? 1 : ageMs < 6 * 3600e3 ? 0.6 : 0.3);

  /**
   * Tout ce que montre la carte, depuis l'historique.
   * @returns {{marks, tracks: {call: [[lat, lon]]}, units: {call: {lat, lon, t, lace}}}}
   */
  function collect(history, now) {
    const marks = [], tracks = {}, units = {};
    for (const msg of history) {
      if (!msg || msg.status === 'incomplet' || !M.isFormatted(msg.text)) continue;
      const dec = M.decode(msg.text);
      if (!dec || dec.readback) continue;
      const age = now - (msg.timestamp || now);
      const call = msg.call || '?';
      const pos = selfPosition(dec);
      if (pos) {
        units[call] = { lat: pos.lat, lon: pos.lon, t: msg.timestamp, lace: (units[call] || {}).lace || null, age };
        if (dec.fmt === 'P') (tracks[call] = tracks[call] || []).push([pos.lat, pos.lon]);
      }
      if (dec.fmt === 'L') {
        const lace = dec.data.state.map((x) => M.COLORS[x].code).join('');
        units[call] = Object.assign(units[call] || {}, { lace: 'LACE ' + lace + (dec.data.cas ? ' · ' + dec.data.cas + ' blessés' : ''), age });
      }
      if (dec.fmt === 'P') continue; // l'unité est dessinée une fois, à sa dernière position
      for (const s of symbolsFor(dec, msg)) marks.push(Object.assign(s, { msg, opacity: ageOpacity(age), title: dec.kind }));
    }
    for (const call of Object.keys(units)) {
      const u = units[call];
      if (u.lat === undefined) continue;
      marks.push({ sidc: FRIEND, lat: u.lat, lon: u.lon, label: call, info: u.lace || 'dernière position', unit: call,
        opacity: ageOpacity(u.age || 0), title: 'UNITÉ' });
    }
    return { marks, tracks, units };
  }

  // ============================================================
  // CARROYAGE MGRS
  // ============================================================

  /** Pas du carroyage (m) selon le zoom : 100 km, 10 km, 1 km. */
  const gridStep = (z) => (z <= 9 ? 100000 : z <= 12 ? 10000 : 1000);

  /**
   * Lignes du carroyage dans un rectangle (zone UTM de son centre).
   * @returns {Array<{pts: [[lat, lon]], label, kind: 'e'|'n'}>}
   */
  function gridLines(south, west, north, east, zoom) {
    const step = gridStep(zoom);
    const cLat = (south + north) / 2, cLon = (west + east) / 2;
    if (cLat < -80 || cLat >= 84) return [];
    const zone = M.utmZone(cLat, cLon);
    const sh = cLat < 0;
    const corners = [[south, west], [south, east], [north, west], [north, east]].map(([la, lo]) => M.toUtm(la, lo, zone));
    const e0 = Math.floor(Math.min.apply(null, corners.map((c) => c.easting)) / step) * step;
    const e1 = Math.ceil(Math.max.apply(null, corners.map((c) => c.easting)) / step) * step;
    const n0 = Math.floor(Math.min.apply(null, corners.map((c) => c.northing)) / step) * step;
    const n1 = Math.ceil(Math.max.apply(null, corners.map((c) => c.northing)) / step) * step;
    if ((e1 - e0) / step > 60 || (n1 - n0) / step > 60) return [];
    // Libellés usuels : chiffre des 100 km, puis dizaines ou kilomètres dans le carré de 100 km
    const label = (v) => (step === 100000 ? String(Math.round(v / 100000))
      : String(Math.round((((v % 100000) + 100000) % 100000) / step)).padStart(step === 1000 ? 2 : 1, '0'));
    const lines = [];
    const SAMPLES = 8;
    for (let e = e0; e <= e1; e += step) {
      const pts = [];
      for (let k = 0; k <= SAMPLES; k++) {
        const p = M.fromUtm(zone, e, n0 + (n1 - n0) * k / SAMPLES, sh);
        pts.push([p.lat, p.lon]);
      }
      lines.push({ pts, label: label(e), kind: 'e' });
    }
    for (let n = n0; n <= n1; n += step) {
      const pts = [];
      for (let k = 0; k <= SAMPLES; k++) {
        const p = M.fromUtm(zone, e0 + (e1 - e0) * k / SAMPLES, n, sh);
        pts.push([p.lat, p.lon]);
      }
      lines.push({ pts, label: label(n), kind: 'n' });
    }
    return lines;
  }

  /**
   * Identifiant MGRS de chaque carré visible, posé dans son coin sud-ouest :
   * « 31U DQ » (100 km), « DQ 5 1 » (10 km), « DQ 52 11 » (1 km).
   * @returns {Array<{lat, lon, label}>}  vide si trop de carrés
   */
  function gridCells(south, west, north, east, zoom) {
    const step = gridStep(zoom);
    const cLat = (south + north) / 2, cLon = (west + east) / 2;
    if (cLat < -80 || cLat >= 84) return [];
    const zone = M.utmZone(cLat, cLon);
    const sh = cLat < 0;
    const corners = [[south, west], [south, east], [north, west], [north, east]].map(([la, lo]) => M.toUtm(la, lo, zone));
    const e0 = Math.floor(Math.min.apply(null, corners.map((c) => c.easting)) / step) * step;
    const e1 = Math.max.apply(null, corners.map((c) => c.easting));
    const n0 = Math.floor(Math.min.apply(null, corners.map((c) => c.northing)) / step) * step;
    const n1 = Math.max.apply(null, corners.map((c) => c.northing));
    if (((e1 - e0) / step) * ((n1 - n0) / step) > 300) return [];
    const digits = step === 1000 ? 2 : 1;
    const out = [];
    for (let e = e0; e < e1; e += step) {
      for (let n = n0; n < n1; n += step) {
        const c = M.fromUtm(zone, e + step / 2, n + step / 2, sh);   // centre : bonne lettre de carré
        if (M.utmZone(c.lat, c.lon) !== zone) continue;              // carré de la zone voisine : grille non tracée
        const sw = M.fromUtm(zone, e, n, sh);
        const m = M.toMgrs(c.lat, c.lon, 5);
        if (!m) continue;
        const [gzd, sq, ee, nn] = m.split(' ');
        const label = step === 100000 ? gzd + ' ' + sq : sq + ' ' + ee.slice(0, digits) + ' ' + nn.slice(0, digits);
        out.push({ lat: sw.lat, lon: sw.lon, label });
      }
    }
    return out;
  }

  const Core = { symbolsFor, collect, destinationPoint, ageOpacity, gridLines, gridCells, gridStep, METHANE_SIDC, NATURE_SIDC, CONTACT_SIDC, UXO_SIDC, FRIEND };
  if (typeof module === 'object' && module.exports) { module.exports = Core; return; }

  // ============================================================
  // ÉCRAN (navigateur)
  // ============================================================

  let opts = null, overlay = null, map = null, symbols = null, tracksLayer = null, gridLayer = null, meMarker = null;
  let gridOn = true, watchId = null, me = null, world = null, dl = null, coordCtl = null;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function init(o) { opts = o; }

  const iconCache = {};
  function icon(sidc, label, info) {
    const key = sidc + '|' + label + '|' + info;
    if (iconCache[key]) return iconCache[key];
    const s = new root.ms.Symbol(sidc, { size: 26, standard: 'APP6', uniqueDesignation: label, additionalInformation: info });
    const a = s.getAnchor(), sz = s.getSize();
    return (iconCache[key] = root.L.divIcon({ className: 'tm-sym', html: s.asSVG(), iconSize: [sz.width, sz.height], iconAnchor: [a.x, a.y] }));
  }

  function open() {
    const L = root.L;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'tm-overlay';
      overlay.innerHTML = `
        <div class="tm-bar">
          <b>Carte tactique</b>
          <button type="button" data-act="me" title="Centrer sur ma position">Moi</button>
          <button type="button" data-act="grid" title="Carroyage MGRS">MGRS</button>
          <button type="button" data-act="dl" title="Télécharger la zone pour le hors ligne">Hors ligne</button>
          <button type="button" class="tm-x" data-act="close" aria-label="Fermer">&times;</button>
        </div>
        <div class="tm-map" id="tm-map"></div>
        <div class="tm-panel hidden" id="tm-panel"></div>`;
      document.body.appendChild(overlay);
      map = baseMap(overlay.querySelector('#tm-map'));
      // Coordonnée complète (MGRS au mètre + degrés) du centre, en haut à droite
      const Coord = L.Control.extend({ onAdd: () => { const d = L.DomUtil.create('div', 'tm-coord'); L.DomEvent.disableClickPropagation(d); return d; } });
      coordCtl = new Coord({ position: 'topright' }).addTo(map);
      const centerMark = document.createElement('div');
      centerMark.className = 'tm-center';
      overlay.querySelector('#tm-map').appendChild(centerMark);
      map.on('move', showCoord);
      tracksLayer = L.layerGroup().addTo(map);
      gridLayer = L.layerGroup().addTo(map);
      symbols = L.layerGroup().addTo(map);
      map.on('moveend zoomend', drawGrid);
      overlay.querySelector('[data-act="close"]').onclick = close;
      overlay.querySelector('[data-act="me"]').onclick = () => { if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 14)); };
      overlay.querySelector('[data-act="grid"]').onclick = () => { gridOn = !gridOn; drawGrid(); };
      overlay.querySelector('[data-act="dl"]').onclick = showDownload;
    }
    overlay.classList.remove('hidden');
    map.invalidateSize();
    refresh(true);
    if (navigator.geolocation && watchId === null) {
      watchId = navigator.geolocation.watchPosition((g) => {
        me = { lat: g.coords.latitude, lon: g.coords.longitude };
        drawMe();
      }, () => {}, { enableHighAccuracy: true, maximumAge: 30000 });
    }
  }

  /** Carte de base : fond monde sous les tuiles IGN (sinon il les recouvre), tuiles hors ligne. */
  function baseMap(el) {
    const L = root.L;
    const m = L.map(el, { zoomControl: true, attributionControl: true, worldCopyJump: true });
    m.attributionControl.setPrefix(false);
    m.createPane('world').style.zIndex = 150;
    fetch('world.json').then((r) => r.json()).then((g) => {
      L.geoJSON(g, { pane: 'world', style: { color: '#7a8a99', weight: 1, fillColor: '#d9d4c7', fillOpacity: 1 }, interactive: false }).addTo(m);
    }).catch(() => {});
    root.Tiles.layer(L).addTo(m);
    return m;
  }

  /**
   * Pointer une position sur la carte : mire fixe au centre, la carte se déplace
   * dessous (ou toucher un point pour l'y amener). Symboles existants pour repère.
   * @param {{title, initial: {lat, lon}|null, onPick: function({lat, lon})}} o
   */
  function pickPosition(o) {
    const L = root.L;
    const p = document.createElement('div');
    p.className = 'tm-overlay tm-picker';
    p.innerHTML = `
      <div class="tm-bar">
        <b>${esc(o.title || 'Pointer la position')}</b>
        <button type="button" data-act="me">Moi</button>
        <button type="button" class="tm-x" data-act="close" aria-label="Fermer">&times;</button>
      </div>
      <div class="tm-mapwrap"><div class="tm-map"></div><div class="tm-cross" aria-hidden="true"></div></div>
      <div class="tm-pick">
        <div class="tm-pick-pos"></div>
        <button type="button" data-act="ok">Valider ce point</button>
      </div>`;
    document.body.appendChild(p);
    const m = baseMap(p.querySelector('.tm-map'));
    const st = root.Medevac.parsePosition((opts.station() || {}).pos);
    const start = o.initial || me || st;
    m.setView(start ? [start.lat, start.lon] : [46.6, 2.5], start ? 15 : 5);
    // Symboles déjà connus, pour se repérer
    const ref = L.layerGroup().addTo(m);
    for (const s2 of collect(opts.history(), Date.now()).marks) {
      L.marker([s2.lat, s2.lon], { icon: icon(s2.sidc, s2.unit ? opts.callLabel(s2.unit) : s2.label, ''), opacity: 0.7, interactive: false }).addTo(ref);
    }
    const posEl = p.querySelector('.tm-pick-pos');
    const show = () => {
      const c = m.getCenter();
      posEl.innerHTML = `<b>${esc(root.Medevac.toMgrs(c.lat, c.lng) || '')}</b><br>${esc(root.Medevac.formatLatLon(c.lat, c.lng))}`;
    };
    m.on('move', show);
    m.on('click', (e) => m.panTo(e.latlng));
    show();
    const done = () => { m.remove(); p.remove(); };
    p.querySelector('[data-act="close"]').onclick = done;
    p.querySelector('[data-act="me"]').onclick = () => {
      if (me) { m.setView([me.lat, me.lon], Math.max(m.getZoom(), 15)); return; }
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition((g) => {
        me = { lat: g.coords.latitude, lon: g.coords.longitude };
        m.setView([me.lat, me.lon], Math.max(m.getZoom(), 15));
      }, () => {}, { enableHighAccuracy: true, timeout: 15000 });
    };
    p.querySelector('[data-act="ok"]').onclick = () => {
      const c = m.getCenter();
      done();
      o.onPick({ lat: c.lat, lon: ((c.lng + 540) % 360) - 180 });
    };
  }

  function close() {
    if (overlay) overlay.classList.add('hidden');
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  const isOpen = () => !!overlay && !overlay.classList.contains('hidden');

  function drawMe() {
    if (!map || !me) return;
    const L = root.L;
    const call = opts.myCall() || 'MOI';
    if (!meMarker) meMarker = L.marker([me.lat, me.lon], { icon: icon(FRIEND, call, 'moi'), zIndexOffset: 1000 }).addTo(map);
    else meMarker.setLatLng([me.lat, me.lon]);
  }

  /** Redessine les symboles depuis l'historique ; first : cadrage initial. */
  function refresh(first) {
    if (!map) return;
    const L = root.L;
    const { marks, tracks } = collect(opts.history(), Date.now());
    symbols.clearLayers();
    tracksLayer.clearLayers();
    for (const call of Object.keys(tracks)) {
      if (tracks[call].length > 1) L.polyline(tracks[call], { color: '#1f6fd1', weight: 3, opacity: 0.8, dashArray: '6 4' }).addTo(tracksLayer);
    }
    const pts = [];
    for (const m of marks) {
      const label = m.unit ? opts.callLabel(m.unit) : m.label.replace(/ (\S+)$/, (x, c) => ' ' + opts.callLabel(c));
      const mk = L.marker([m.lat, m.lon], { icon: icon(m.sidc, label, m.info), opacity: m.opacity }).addTo(symbols);
      if (m.from) L.polyline([[m.from.lat, m.from.lon], [m.lat, m.lon]], { color: '#c62828', weight: 2, dashArray: '4 4', opacity: m.opacity }).addTo(symbols);
      const when = m.msg ? m.msg.time : '';
      const html = `<b>${esc(m.title)}</b><br>${esc(label)}${when ? ' · ' + esc(when) : ''}<br>${esc(m.info)}`
        + (m.msg ? '<br><button type="button" class="tm-open">Fiche</button>' : '');
      mk.bindPopup(html);
      if (m.msg) mk.on('popupopen', (e) => {
        const b = e.popup.getElement().querySelector('.tm-open');
        if (b) b.onclick = () => opts.openViewer(m.msg.text, { call: m.msg.call, time: m.msg.time });
      });
      pts.push([m.lat, m.lon]);
    }
    if (first) {
      if (pts.length) map.fitBounds(pts, { maxZoom: 14, padding: [40, 40] });
      else {
        const z = root.Tiles.zone();
        const st = root.Medevac.parsePosition((opts.station() || {}).pos);
        const c = me || st || (z ? { lat: z.lat, lon: z.lon } : { lat: 46.6, lon: 2.5 });
        map.setView([c.lat, c.lon], me || st || z ? 12 : 5);
      }
    }
    drawGrid();
    drawMe();
  }

  function showCoord() {
    if (!coordCtl) return;
    const c = map.getCenter();
    const lon = ((c.lng + 540) % 360) - 180;
    const m = root.Medevac.toMgrs(c.lat, lon, 5);
    coordCtl.getContainer().innerHTML = (m ? `<b>${esc(m)}</b><br>` : '') + esc(root.Medevac.formatLatLon(c.lat, lon));
  }

  function drawGrid() {
    showCoord();
    if (!gridLayer) return;
    gridLayer.clearLayers();
    overlay.querySelector('[data-act="grid"]').classList.toggle('on', gridOn);
    if (!gridOn) return;
    const L = root.L, b = map.getBounds();
    const box = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), map.getZoom()];
    for (const ln of gridLines.apply(null, box)) {
      L.polyline(ln.pts, { color: '#0d47a1', weight: 1, opacity: 0.55, interactive: false }).addTo(gridLayer);
    }
    // Identifiant MGRS dans chaque carré, en permanence
    for (const c of gridCells.apply(null, box)) {
      L.marker([c.lat, c.lon], { interactive: false, icon: L.divIcon({ className: 'tm-grid-lbl', html: c.label, iconSize: null, iconAnchor: [-3, 16] }) }).addTo(gridLayer);
    }
  }

  // ---------- Téléchargement de la zone ----------
  function showDownload() {
    const panel = overlay.querySelector('#tm-panel');
    const st = root.Medevac.parsePosition((opts.station() || {}).pos);
    const c = me || st || (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : null);
    const zone = root.Tiles.zone();
    const est = root.Tiles.estimate(c.lat, c.lon, 20, 8, 15);
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <p><b>Carte hors ligne (Plan IGN)</b></p>
      <p>Autour de ${me ? 'ma position GPS' : st ? 'la position de la station' : 'le centre de la carte'} :
        rayon 20 km, jusqu'au zoom 15 (rue). Environ ${est.tiles} tuiles, ~${Math.round(est.bytes / 1e6)} Mo.</p>
      ${zone ? `<p class="tm-muted">Zone déjà téléchargée le ${new Date(zone.date).toLocaleDateString('fr-FR')} (${zone.tiles} tuiles${zone.failed ? ', ' + zone.failed + ' en échec' : ''}).</p>` : ''}
      <div class="tm-progress hidden"><div></div></div>
      <p class="tm-status"></p>
      <div class="tm-actions">
        <button type="button" data-act="go">Télécharger</button>
        <button type="button" data-act="erase">Effacer</button>
        <button type="button" data-act="hide">Fermer</button>
      </div>`;
    const status = panel.querySelector('.tm-status'), bar = panel.querySelector('.tm-progress');
    panel.querySelector('[data-act="hide"]').onclick = () => { if (dl) dl.cancel(); panel.classList.add('hidden'); };
    panel.querySelector('[data-act="erase"]').onclick = () => root.Tiles.clearAll().then(() => { status.textContent = 'Carte hors ligne effacée.'; });
    panel.querySelector('[data-act="go"]').onclick = (e) => {
      if (dl) { dl.cancel(); return; }
      if (navigator.onLine === false) { status.textContent = 'Pas de réseau : téléchargez avant de partir.'; return; }
      e.target.textContent = 'Arrêter';
      bar.classList.remove('hidden');
      dl = root.Tiles.download(c.lat, c.lon, 20, 8, 15, (done, total, bytes, failed) => {
        bar.firstElementChild.style.width = (100 * done / total).toFixed(1) + '%';
        status.textContent = `${done} / ${total} tuiles · ${(bytes / 1e6).toFixed(1)} Mo${failed ? ' · ' + failed + ' en échec' : ''}`;
      });
      dl.promise.then((r) => {
        dl = null;
        e.target.textContent = 'Télécharger';
        status.textContent = r.cancelled ? `Arrêté : ${r.done} tuiles faites, la suite reprendra au prochain téléchargement.`
          : `Terminé : ${(r.bytes / 1e6).toFixed(1)} Mo ajoutés${r.failed ? ', ' + r.failed + ' tuiles en échec (relancer pour compléter)' : ''}. La carte fonctionne hors ligne dans cette zone.`;
      });
    };
  }

  root.TacMap = Object.assign({ init, open, close, pickPosition, refresh: () => { if (isOpen()) refresh(false); }, isOpen }, Core);
})(typeof self !== 'undefined' ? self : this);
