/**
 * Messages formatés ChatMTX : demande d'évacuation sanitaire « 9-line » (OTAN)
 * et fiche blessé MIST. Sans DOM : codage, décodage, MGRS, texte en clair.
 *
 * Sur l'air, après l'indicatif court (2 car.) de l'émetteur :
 *   /9 + 22 car.                    9-line (lignes 1 à 9)
 *   /M + n + n × 11 car.            MIST, n blessés (n codé sur 1 car., 1 à 11)
 *   /9 + 22 car. + /M + n + ...     9-line suivi de ses fiches MIST
 * puis une remarque libre facultative. Le marqueur ? au lieu du premier /
 * signale un collationnement : le récepteur renvoie ce qu'il a reçu.
 *
 * Chaque bloc de champs est un entier en base mixte (un rang par champ), écrit
 * en base 41 avec l'alphabet FT8 sans l'espace : FT8 rogne les espaces en fin
 * de bloc, un chiffre « espace » serait perdu. Longueur fixe, aucun séparateur.
 */
(function (root) {
  'use strict';

  const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?'; // 41 : alphabet FT8 sans espace
  const BASE = BigInt(DIGITS.length);
  const VERSION = 0;

  // ============================================================
  // Listes de choix (l'ordre fait partie du format : ne jamais réordonner,
  // seulement ajouter à la fin dans la limite du rang)
  // ============================================================

  const PRECEDENCE = [
    { code: 'A', label: 'Urgent' },
    { code: 'B', label: 'Urgent chirurgical' },
    { code: 'C', label: 'Prioritaire' },
    { code: 'D', label: 'Routine' },
    { code: 'E', label: 'Convenance' },
  ];
  const EQUIPMENT = [ // A = aucun (aucun bit)
    { code: 'B', label: 'Treuil' },
    { code: 'C', label: 'Désincarcération' },
    { code: 'D', label: 'Respirateur' },
  ];
  const SECURITY = [
    { code: 'N', label: 'Pas d\'ennemi' },
    { code: 'P', label: 'Ennemi possible' },
    { code: 'E', label: 'Ennemi présent, prudence' },
    { code: 'X', label: 'Ennemi présent, escorte armée' },
  ];
  const WOUNDS = [ // ligne 6 en temps de paix
    { code: 'T', label: 'Traumatisme' },
    { code: 'B', label: 'Plaie par balle' },
    { code: 'R', label: 'Brûlure' },
    { code: 'F', label: 'Fracture' },
    { code: 'C', label: 'Trauma crânien' },
    { code: 'H', label: 'Hémorragie' },
    { code: 'M', label: 'Maladie, malaise' },
  ];
  const MARKING = [
    { code: 'A', label: 'Panneaux' },
    { code: 'B', label: 'Pyrotechnie' },
    { code: 'C', label: 'Fumigène' },
    { code: 'D', label: 'Aucun' },
    { code: 'E', label: 'Autre' },
  ];
  const NATIONALITY = [
    { code: 'A', label: 'Militaire coalition' },
    { code: 'B', label: 'Civil coalition' },
    { code: 'C', label: 'Militaire hors coalition' },
    { code: 'D', label: 'Civil hors coalition' },
    { code: 'E', label: 'Prisonnier de guerre' },
  ];
  const NBC = [ // ligne 9 en temps de guerre (aucun bit = aucune contamination)
    { code: 'N', label: 'Nucléaire' },
    { code: 'B', label: 'Biologique' },
    { code: 'C', label: 'Chimique' },
    { code: 'R', label: 'Radiologique' },
  ];
  const TERRAIN = [ // ligne 9 en temps de paix
    { code: 'P', label: 'Plat, dégagé' },
    { code: 'S', label: 'En pente' },
    { code: 'F', label: 'Boisé' },
    { code: 'U', label: 'Urbain' },
    { code: 'M', label: 'Montagne' },
    { code: 'W', label: 'Eau, marais' },
    { code: 'O', label: 'Obstacles (câbles)' },
  ];

  const MECHANISM = [
    'Balle', 'Explosion, éclat', 'Accident véhicule', 'Chute', 'Brûlure', 'Écrasement',
    'Arme blanche', 'Noyade', 'Électrisation', 'Froid, hypothermie', 'Malaise, maladie', 'Autre',
  ];
  const REGIONS = [
    'Tête', 'Cou', 'Thorax', 'Abdomen', 'Bassin', 'Dos',
    'Bras G', 'Bras D', 'Jambe G', 'Jambe D',
  ];
  const AVPU = [
    { code: 'A', label: 'Alerte' },
    { code: 'V', label: 'Réagit à la voix' },
    { code: 'P', label: 'Réagit à la douleur' },
    { code: 'U', label: 'Inconscient' },
  ];
  const TREATMENT = [
    'Garrot', 'Pansement hémostatique', 'Pansement thoracique', 'Canule (NPA)', 'Exsufflation',
    'Perfusion, IO', 'Antalgique', 'Attelle', 'Couverture (hypothermie)', 'Acide tranexamique',
  ];

  const MAX_COUNT = 9;       // blessés par catégorie d'urgence (ligne 3)
  const MAX_LA = 31;         // couchés, assis (ligne 5)
  const MAX_MIST = 11;       // fiches MIST seules par message (2 + 3 + 11 × 11 ≤ 128)
  const MAX_MIST_WITH_NINE = 9; // après un 9-line (2 + 24 + 3 + 9 × 11 ≤ 128)

  // Rangs des champs, du plus significatif au moins significatif
  const NINE_RADIX = [
    ['version', 4], ['peace', 2],
    ['lat', 1800001], ['lon', 3600000], ['freq', 1000000],
    ['cA', 10], ['cB', 10], ['cC', 10], ['cD', 10], ['cE', 10],
    ['equip', 8], ['litter', 32], ['ambul', 32],
    ['l6', 128], ['marking', 5], ['nation', 32], ['l9', 128],
  ];
  const MIST_RADIX = [
    ['version', 4], ['patient', 16], ['prec', 5], ['time', 289], ['mech', 12],
    ['regions', 1024], ['avpu', 5], ['pulse', 52], ['resp', 32], ['spo2', 52], ['treat', 1024],
  ];

  function digitsFor(radix) {
    let max = 1n;
    for (const [, r] of radix) max *= BigInt(r);
    let n = 0;
    for (let p = 1n; p < max; p *= BASE) n++;
    return n;
  }
  const NINE_LEN = digitsFor(NINE_RADIX);   // 22
  const MIST_LEN = digitsFor(MIST_RADIX);   // 11

  function pack(radix, values, len) {
    let n = 0n;
    for (const [name, r] of radix) {
      const v = values[name];
      if (!Number.isInteger(v) || v < 0 || v >= r) throw new Error('Champ hors limites : ' + name + '=' + v);
      n = n * BigInt(r) + BigInt(v);
    }
    let s = '';
    for (let i = 0; i < len; i++) {
      s = DIGITS[Number(n % BASE)] + s;
      n /= BASE;
    }
    return s;
  }

  function unpack(radix, str) {
    let n = 0n;
    for (const ch of str) {
      const d = DIGITS.indexOf(ch);
      if (d < 0) return null;
      n = n * BASE + BigInt(d);
    }
    const out = {};
    for (let i = radix.length - 1; i >= 0; i--) {
      const [name, r] = radix[i];
      out[name] = Number(n % BigInt(r));
      n /= BigInt(r);
    }
    return n === 0n ? out : null; // reste non nul : pas un message de ce format
  }

  const bitsOf = (mask, n) => Array.from({ length: n }, (_, i) => i).filter((i) => mask & (1 << i));
  const maskOf = (list) => (list || []).reduce((m, i) => m | (1 << i), 0);

  // ============================================================
  // 9-LINE
  // ============================================================

  /**
   * @param {object} d
   *   lat, lon (degrés) · freqKHz (0 = non précisée) · counts [A..E] · equip [indices EQUIPMENT]
   *   litter, ambul · peace (bool) · security (indice SECURITY, guerre) · wounds [indices WOUNDS, paix]
   *   marking (indice) · nation [indices] · nbc [indices NBC, guerre] · terrain [indices TERRAIN, paix]
   * @returns {string} 22 caractères
   */
  function encodeNine(d) {
    const latI = Math.round((d.lat + 90) * 1e4);
    const lonI = ((Math.round((d.lon + 180) * 1e4) % 3600000) + 3600000) % 3600000;
    const c = d.counts || [];
    return pack(NINE_RADIX, {
      version: VERSION, peace: d.peace ? 1 : 0,
      lat: latI, lon: lonI, freq: Math.round(d.freqKHz || 0),
      cA: c[0] || 0, cB: c[1] || 0, cC: c[2] || 0, cD: c[3] || 0, cE: c[4] || 0,
      equip: maskOf(d.equip), litter: d.litter || 0, ambul: d.ambul || 0,
      l6: d.peace ? maskOf(d.wounds) : (d.security || 0),
      marking: d.marking || 0, nation: maskOf(d.nation),
      l9: d.peace ? maskOf(d.terrain) : maskOf(d.nbc),
    }, NINE_LEN);
  }

  function decodeNine(str) {
    const v = unpack(NINE_RADIX, str);
    if (!v || v.version !== VERSION) return null;
    const peace = v.peace === 1;
    if (!peace && v.l6 >= SECURITY.length) return null;
    if (!peace && v.l9 >= 1 << NBC.length) return null;
    return {
      lat: v.lat / 1e4 - 90, lon: v.lon / 1e4 - 180, freqKHz: v.freq,
      counts: [v.cA, v.cB, v.cC, v.cD, v.cE],
      equip: bitsOf(v.equip, EQUIPMENT.length), litter: v.litter, ambul: v.ambul,
      peace,
      security: peace ? null : v.l6, wounds: peace ? bitsOf(v.l6, WOUNDS.length) : [],
      marking: v.marking, nation: bitsOf(v.nation, NATIONALITY.length),
      nbc: peace ? [] : bitsOf(v.l9, NBC.length), terrain: peace ? bitsOf(v.l9, TERRAIN.length) : [],
    };
  }

  // ============================================================
  // MIST
  // ============================================================

  /**
   * @param {object} p
   *   patient (1-16) · prec (indice PRECEDENCE) · time ({h, m} UTC, ou null) · mech (indice MECHANISM)
   *   regions [indices] · avpu (indice AVPU ou null) · pulse, resp, spo2 (nombres ou null) · treat [indices]
   * @returns {string} 11 caractères
   */
  function encodeMist(p) {
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    const time = p.time ? 1 + Math.round((p.time.h * 60 + p.time.m) / 5) % 288 : 0;
    return pack(MIST_RADIX, {
      version: VERSION, patient: clamp((p.patient || 1) - 1, 0, 15), prec: p.prec || 0, time,
      mech: p.mech || 0, regions: maskOf(p.regions),
      avpu: p.avpu === null || p.avpu === undefined ? 0 : p.avpu + 1,
      pulse: p.pulse === null || p.pulse === undefined ? 0 : 1 + clamp(Math.round(p.pulse / 5), 0, 50),
      resp: p.resp === null || p.resp === undefined ? 0 : 1 + clamp(Math.round(p.resp / 2), 0, 30),
      spo2: p.spo2 === null || p.spo2 === undefined ? 0 : 1 + clamp(Math.round(p.spo2) - 50, 0, 50),
      treat: maskOf(p.treat),
    }, MIST_LEN);
  }

  function decodeMist(str) {
    const v = unpack(MIST_RADIX, str);
    if (!v || v.version !== VERSION || v.mech >= MECHANISM.length) return null;
    const minutes = (v.time - 1) * 5;
    return {
      patient: v.patient + 1, prec: v.prec,
      time: v.time ? { h: Math.floor(minutes / 60), m: minutes % 60 } : null,
      mech: v.mech, regions: bitsOf(v.regions, REGIONS.length),
      avpu: v.avpu ? v.avpu - 1 : null,
      pulse: v.pulse ? (v.pulse - 1) * 5 : null,
      resp: v.resp ? (v.resp - 1) * 2 : null,
      spo2: v.spo2 ? v.spo2 + 49 : null,
      treat: bitsOf(v.treat, TREATMENT.length),
    };
  }

  // ============================================================
  // MESSAGE COMPLET
  // ============================================================

  /**
   * Corps du message (sans l'indicatif) : 9-line et/ou fiches MIST + remarque.
   * @param {{nine?: object, mist?: object[], remark?: string, readback?: boolean}} m
   */
  function encode(m) {
    let s = '';
    if (m.nine) s += '/9' + encodeNine(m.nine);
    const mist = (m.mist || []).slice(0, m.nine ? MAX_MIST_WITH_NINE : MAX_MIST);
    if (mist.length) s += '/M' + DIGITS[mist.length] + mist.map(encodeMist).join('');
    if (!s) throw new Error('Message vide');
    if (m.readback) s = '?' + s.slice(1);
    const remark = normalizeRemark(m.remark);
    return remark ? s + remark : s;
  }

  function normalizeRemark(text) {
    return String(text || '').toUpperCase().replace(/[^ 0-9A-Z+\-./?]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Un message commence-t-il par un marqueur de message formaté ? (avant décodage complet) */
  function isFormatted(body) {
    return /^[/?][9M]/.test(body || '');
  }

  /**
   * @returns {{nine: object|null, mist: object[], remark: string, readback: boolean, kind: string}|null}
   *   null : pas un message formaté (ou abîmé) → à afficher en texte simple
   */
  function decode(body) {
    if (!isFormatted(body)) return null;
    const readback = body[0] === '?';
    let s = '/' + body.slice(1);
    let nine = null;
    const mist = [];
    if (s.startsWith('/9')) {
      if (s.length < 2 + NINE_LEN) return null;
      nine = decodeNine(s.slice(2, 2 + NINE_LEN));
      if (!nine) return null;
      s = s.slice(2 + NINE_LEN);
    }
    if (s.startsWith('/M')) {
      const n = DIGITS.indexOf(s[2]);
      if (n < 1 || n > MAX_MIST || s.length < 3 + n * MIST_LEN) return null;
      for (let i = 0; i < n; i++) {
        const p = decodeMist(s.substr(3 + i * MIST_LEN, MIST_LEN));
        if (!p) return null;
        mist.push(p);
      }
      s = s.slice(3 + n * MIST_LEN);
    }
    if (!nine && !mist.length) return null;
    return { nine, mist, remark: s.trim(), readback, kind: nine ? '9-LINE' : 'MIST' };
  }

  // ============================================================
  // MGRS (WGS84, UTM) : affichage de la ligne 1 et saisie de la position
  // ============================================================

  const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
  const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
  const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
  const ROWS = 'ABCDEFGHJKLMNPQRSTUV';
  const COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
  const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;

  function utmZone(lat, lon) {
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;
    if (lat >= 72 && lat < 84 && lon >= 0 && lon < 42) {
      if (lon < 9) return 31;
      if (lon < 21) return 33;
      if (lon < 33) return 35;
      return 37;
    }
    return Math.floor((lon + 180) / 6) % 60 + 1;
  }

  function meridionalArc(phi) {
    const e4 = E2 * E2, e6 = e4 * E2;
    return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
      - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
      - (35 * e6 / 3072) * Math.sin(6 * phi));
  }

  function toUtm(lat, lon, zone) {
    zone = zone || utmZone(lat, lon);
    const phi = rad(lat), lam = rad(lon - ((zone - 1) * 6 - 180 + 3));
    const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
    const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, Aa = c * lam;
    const easting = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
    let northing = K0 * (meridionalArc(phi) + N * t * (Aa * Aa / 2
      + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
    if (lat < 0) northing += 10000000;
    return { zone, easting, northing };
  }

  function fromUtm(zone, easting, northing, south) {
    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    const x = easting - 500000, y = south ? northing - 10000000 : northing;
    const mu = y / K0 / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256));
    const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
      + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
    const N1 = A / Math.sqrt(1 - E2 * s * s), T1 = t * t, C1 = EP2 * c * c;
    const R1 = A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5), D = x / (N1 * K0);
    const lat = phi1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
    return { lat: deg(lat), lon: (zone - 1) * 6 - 180 + 3 + deg(lon) };
  }

  /** MGRS à 10 m près (8 chiffres), ex. « 31U DQ 4825 1193 » ; null hors UTM (pôles). */
  function toMgrs(lat, lon) {
    if (!(lat >= -80 && lat < 84)) return null;
    const { zone, easting, northing } = toUtm(lat, lon);
    const band = BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
    const set = zone % 3; // 1, 2, 0 → lettres de colonnes A-H, J-R, S-Z
    const col = COLS[(set + 2) % 3][Math.floor(easting / 100000) - 1];
    const rowOffset = zone % 2 === 0 ? 5 : 0;
    const row = ROWS[(Math.floor(northing / 100000) + rowOffset) % 20];
    const e = String(Math.floor(easting % 100000 / 10)).padStart(4, '0');
    const n = String(Math.floor(northing % 100000 / 10)).padStart(4, '0');
    return `${zone}${band} ${col}${row} ${e} ${n}`;
  }

  /** « 31U DQ 4825 1193 », « 31UDQ48251193 », 2 à 10 chiffres → {lat, lon} (centre de la case) ou null. */
  function fromMgrs(text) {
    const m = String(text).toUpperCase().replace(/\s+/g, '').match(/^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d{2,10})$/);
    if (!m || m[5].length % 2) return null;
    const zone = +m[1], band = m[2];
    if (zone < 1 || zone > 60) return null;
    const half = m[5].length / 2, scale = 10 ** (5 - half);
    const e = +m[5].slice(0, half) * scale + scale / 2, n = +m[5].slice(half) * scale + scale / 2;
    const set = zone % 3;
    const colIdx = COLS[(set + 2) % 3].indexOf(m[3]);
    if (colIdx < 0) return null;
    const rowOffset = zone % 2 === 0 ? 5 : 0;
    const rowIdx = (ROWS.indexOf(m[4]) - rowOffset + 20) % 20;
    const easting = (colIdx + 1) * 100000 + e;
    const south = band < 'N';
    const bandLat = -80 + BANDS.indexOf(band) * 8;
    const minNorthing = toUtm(bandLat, (zone - 1) * 6 - 180 + 3, zone).northing - 100000;
    let northing = rowIdx * 100000 + n;
    while (northing < minNorthing) northing += 2000000;
    return fromUtm(zone, easting, northing, south);
  }

  /** Position saisie : MGRS ou « lat, lon » en degrés décimaux → {lat, lon} ou null. */
  function parsePosition(text) {
    const s = String(text || '').trim();
    const dec = s.match(/^(-?\d+(?:[.,]\d+)?)\s*[;,\s]\s*(-?\d+(?:[.,]\d+)?)$/);
    if (dec) {
      const lat = parseFloat(dec[1].replace(',', '.')), lon = parseFloat(dec[2].replace(',', '.'));
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
      return null;
    }
    return fromMgrs(s);
  }

  // ============================================================
  // TEXTE EN CLAIR (affichage, partage, QR code, impression)
  // ============================================================

  const pick = (list, idx) => idx.map((i) => list[i]);
  const codes = (items) => items.map((x) => x.code).join('');
  const labels = (items) => items.map((x) => x.label).join(', ');
  const pad2 = (x) => String(x).padStart(2, '0');

  function formatFreq(kHz) {
    if (!kHz) return 'non précisée';
    return (kHz / 1000).toFixed(3).replace('.', ',') + ' MHz';
  }

  function formatLatLon(lat, lon) {
    const f = (v, p, n) => Math.abs(v).toFixed(4).replace('.', ',') + ' ' + (v >= 0 ? p : n);
    return f(lat, 'N', 'S') + ' ' + f(lon, 'E', 'O');
  }

  /**
   * Lignes en clair : [{n, label, code, text}] pour le 9-line, puis les fiches MIST.
   * @param {object} msg  résultat de decode()
   * @param {string} call indicatif de l'émetteur (ligne 2)
   */
  function lines(msg, call) {
    const out = [];
    const d = msg.nine;
    if (d) {
      const mgrs = toMgrs(d.lat, d.lon);
      const prec = PRECEDENCE.map((p, i) => ({ ...p, n: d.counts[i] })).filter((p) => p.n);
      const equip = pick(EQUIPMENT, d.equip);
      const nation = pick(NATIONALITY, d.nation);
      out.push({ n: 1, label: 'Position', code: mgrs || '', text: formatLatLon(d.lat, d.lon) });
      out.push({ n: 2, label: 'Fréquence / indicatif', code: '', text: formatFreq(d.freqKHz) + ' / ' + (call || '?') });
      out.push({ n: 3, label: 'Blessés par urgence', code: prec.map((p) => p.n + p.code).join(' '),
        text: prec.length ? prec.map((p) => p.n + ' × ' + p.label.toLowerCase()).join(', ') : 'aucun' });
      out.push({ n: 4, label: 'Matériel spécial', code: equip.length ? codes(equip) : 'A',
        text: equip.length ? labels(equip) : 'Aucun' });
      out.push({ n: 5, label: 'Couchés / assis', code: `L${d.litter} A${d.ambul}`,
        text: `${d.litter} couché${d.litter > 1 ? 's' : ''}, ${d.ambul} assis` });
      if (d.peace) {
        const w = pick(WOUNDS, d.wounds);
        out.push({ n: 6, label: 'Blessures', code: codes(w), text: w.length ? labels(w) : 'non précisé' });
      } else {
        const s = SECURITY[d.security];
        out.push({ n: 6, label: 'Sécurité du point', code: s.code, text: s.label });
      }
      const mk = MARKING[d.marking];
      out.push({ n: 7, label: 'Balisage', code: mk.code, text: mk.label });
      out.push({ n: 8, label: 'Nationalité / statut', code: codes(nation), text: nation.length ? labels(nation) : 'non précisé' });
      if (d.peace) {
        const t = pick(TERRAIN, d.terrain);
        out.push({ n: 9, label: 'Terrain', code: codes(t), text: t.length ? labels(t) : 'non précisé' });
      } else {
        const c = pick(NBC, d.nbc);
        out.push({ n: 9, label: 'NRBC', code: codes(c), text: c.length ? labels(c) : 'Aucune contamination' });
      }
    }
    msg.mist.forEach((p) => {
      const pr = PRECEDENCE[p.prec];
      const head = `Blessé ${p.patient} · ${pr.code} ${pr.label.toLowerCase()}`
        + (p.time ? ` · blessé à ${pad2(p.time.h)}:${pad2(p.time.m)}Z` : '');
      const signs = [
        p.avpu !== null ? 'AVPU ' + AVPU[p.avpu].code : null,
        p.pulse !== null ? 'pouls ' + p.pulse : null,
        p.resp !== null ? 'resp. ' + p.resp : null,
        p.spo2 !== null ? 'SpO2 ' + p.spo2 + ' %' : null,
      ].filter(Boolean);
      out.push({ mist: true, head, label: 'M', text: MECHANISM[p.mech] });
      out.push({ mist: true, label: 'I', text: p.regions.length ? p.regions.map((i) => REGIONS[i]).join(', ') : 'non précisé' });
      out.push({ mist: true, label: 'S', text: signs.length ? signs.join(' · ') : 'non relevés' });
      out.push({ mist: true, label: 'T', text: p.treat.length ? p.treat.map((i) => TREATMENT[i]).join(', ') : 'aucun' });
    });
    if (msg.remark) out.push({ label: 'Remarque', text: msg.remark });
    return out;
  }

  /** Texte en clair complet, pour partager, imprimer ou le QR code. */
  function toText(msg, call, when) {
    const title = (msg.readback ? 'COLLATIONNEMENT ' : '') + (msg.nine ? '9-LINE MEDEVAC' : 'MIST')
      + (call ? ' de ' + call : '') + (when ? ' · ' + when : '');
    const out = [title];
    let lastHead = null;
    for (const l of lines(msg, call)) {
      if (l.mist && l.head && l.head !== lastHead) {
        out.push('', l.head);
        lastHead = l.head;
      }
      if (l.n) out.push(`${l.n}. ${l.label} : ${l.code ? l.code + ' — ' : ''}${l.text}`);
      else if (l.mist) out.push(`${l.label} : ${l.text}`);
      else out.push('', `${l.label} : ${l.text}`);
    }
    return out.join('\n');
  }

  /** Lignes qui diffèrent entre deux messages décodés (collationnement), ex. ['3', '6', 'Blessé 1']. */
  function diff(a, b) {
    const la = lines(a, ''), lb = lines(b, '');
    const key = (l) => (l.n ? String(l.n) : l.label);
    const out = new Set();
    const n = Math.max(la.length, lb.length);
    for (let i = 0; i < n; i++) {
      const x = la[i], y = lb[i];
      if (!x || !y || x.text !== y.text || x.code !== y.code) {
        const l = x || y;
        out.add(l.mist ? (l.head || 'MIST') : key(l));
      }
    }
    return Array.from(out);
  }

  const Medevac = {
    DIGITS, NINE_LEN, MIST_LEN, MAX_COUNT, MAX_LA, MAX_MIST, MAX_MIST_WITH_NINE,
    PRECEDENCE, EQUIPMENT, SECURITY, WOUNDS, MARKING, NATIONALITY, NBC, TERRAIN,
    MECHANISM, REGIONS, AVPU, TREATMENT,
    encode, decode, isFormatted, encodeNine, decodeNine, encodeMist, decodeMist,
    toMgrs, fromMgrs, parsePosition, formatLatLon, formatFreq, lines, toText, diff, normalizeRemark,
  };
  if (typeof module === 'object' && module.exports) module.exports = Medevac;
  else root.Medevac = Medevac;
})(typeof self !== 'undefined' ? self : this);
