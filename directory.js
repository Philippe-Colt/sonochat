/**
 * Annuaire ChatMTX : indicatif court (2 caractères, celui qui circule sur
 * l'air) -> indicatif long (affiché), et type d'unité OTAN pour la carte.
 * Fonctions pures, testables en Node.
 *
 * Fichier importé : une entrée par ligne, « court long [type [échelon [canal
 * [créneau]]]] », séparés par ; , une tabulation ou des espaces. Type : mot clé
 * (infanterie, pompiers, sante...) ou code SIDC APP-6 de 15 caractères ;
 * échelon : mot clé (equipe, section, compagnie...). Type ou échelon inconnu :
 * ignoré. Colonne vide ou « - » : non renseignée. Canal : fréquence audio
 * d'émission en Hz (ton 0) ; créneau : rang 1-98 dans le tour des émissions
 * automatiques. Lignes vides ou commençant par # ignorées, sauf l'en-tête réseau
 * « #reseau;creneau=15;tour=12;pas=60;bande=500-2500;version=3;date=2026-10-03 ».
 * Ligne d'en-tête tolérée. Doublon : la dernière ligne l'emporte.
 */

/**
 * Types d'unité : mots clés (sans accents, minuscules) → fonction APP-6
 * (SIDC à lettres, 15 car. ; codes choisis sur planche milsymbol).
 */
const UNIT_TYPES = [
  { keys: ['infanterie', 'inf'], label: 'Infanterie', sidc: 'SFGPUCI--------' },
  { keys: ['motorisee', 'motorise', 'inf-mot'], label: 'Infanterie motorisée', sidc: 'SFGPUCIM-------' },
  { keys: ['mecanisee', 'mecanise', 'inf-meca'], label: 'Infanterie mécanisée', sidc: 'SFGPUCIZ-------' },
  { keys: ['blinde', 'blindee', 'abc', 'chars'], label: 'Blindé', sidc: 'SFGPUCA--------' },
  { keys: ['reconnaissance', 'reco', 'cavalerie'], label: 'Reconnaissance', sidc: 'SFGPUCR--------' },
  { keys: ['artillerie', 'art'], label: 'Artillerie', sidc: 'SFGPUCF--------' },
  { keys: ['genie'], label: 'Génie', sidc: 'SFGPUCE--------' },
  { keys: ['sol-air', 'dsa', 'defense-sol-air'], label: 'Défense sol-air', sidc: 'SFGPUCD--------' },
  { keys: ['aviation', 'alat', 'helicoptere'], label: 'Aviation', sidc: 'SFGPUCV--------' },
  { keys: ['transmissions', 'trans', 'radio'], label: 'Transmissions', sidc: 'SFGPUUS--------' },
  { keys: ['nrbc', 'cbrn'], label: 'NRBC', sidc: 'SFGPUUA--------' },
  { keys: ['renseignement', 'rens'], label: 'Renseignement', sidc: 'SFGPUUM--------' },
  { keys: ['police-militaire', 'prevote', 'mp'], label: 'Police militaire', sidc: 'SFGPUULM-------' },
  { keys: ['sante', 'medical', 'ssa'], label: 'Santé', sidc: 'SFGPUSM--------' },
  { keys: ['logistique', 'ravitaillement', 'log'], label: 'Logistique', sidc: 'SFGPUSS--------' },
  { keys: ['maintenance', 'mat'], label: 'Maintenance', sidc: 'SFGPUSX--------' },
  { keys: ['transport'], label: 'Transport', sidc: 'SFGPUST--------' },
  { keys: ['commandement', 'pc', 'qg', 'etat-major'], label: 'Commandement', sidc: 'SFGPUH---------' },
  { keys: ['pompiers', 'sdis', 'sp', 'sapeurs-pompiers'], label: 'Sapeurs-pompiers', sidc: 'EFOPC----------' },
  { keys: ['samu', 'smur'], label: 'SAMU, SMUR', sidc: 'EFOPAA---------' },
  { keys: ['police', 'gendarmerie'], label: 'Police, gendarmerie', sidc: 'EFOPD----------' },
  { keys: ['secours', 'protection-civile', 'securite-civile', 'associatif'], label: 'Secours, protection civile', sidc: 'EFOPB----------' },
];

/** Échelons (position 12 du SIDC). */
const ECHELONS = [
  { keys: ['equipe', 'equipage'], label: 'Équipe', code: 'A' },
  { keys: ['groupe'], label: 'Groupe', code: 'B' },
  { keys: ['section', 'peloton'], label: 'Section, peloton', code: 'D' },
  { keys: ['compagnie', 'escadron', 'batterie'], label: 'Compagnie', code: 'E' },
  { keys: ['bataillon'], label: 'Bataillon', code: 'F' },
  { keys: ['regiment'], label: 'Régiment', code: 'G' },
  { keys: ['brigade'], label: 'Brigade', code: 'H' },
  { keys: ['division'], label: 'Division', code: 'I' },
];

const SIDC_RE = /^[SEOG][A-Z-][A-Z-][A-Z-][A-Z0-9-]{11}$/;
const norm = (w) => String(w || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const findKey = (list, w) => list.find((t) => t.keys.includes(norm(w))) || null;

/** Type d'unité d'une colonne : mot clé connu ou SIDC ; null sinon. */
function parseUnitType(word) {
  if (!word) return null;
  const up = String(word).toUpperCase();
  if (SIDC_RE.test(up)) return up;
  const t = findKey(UNIT_TYPES, word);
  return t ? t.sidc : null;
}

/** SIDC d'une station : type (mot clé ou SIDC) et échelon de l'annuaire ; null si aucun type. */
function unitSidc(unit) {
  if (!unit || !unit.type) return null;
  const sidc = unit.type;
  const ech = unit.echelon && ECHELONS.find((e) => e.code === unit.echelon);
  if (!ech || sidc[0] !== 'S') return sidc; // pas d'échelon sur les symboles de secours
  return sidc.slice(0, 11) + ech.code + sidc.slice(12);
}

/** Réseau par défaut : créneaux de 15 s (une trame FT8 = 12,64 s), canaux au pas de 60 Hz. */
const NET_DEFAULTS = { slotS: 15, round: 0, step: 60, bandMin: 500, bandMax: 2500, version: '', date: '' };
const FREQ_MIN = 200, FREQ_MAX = 3000;   // canal accepté (Hz)
const SLOT_MAX = 98;
const SLOT_S_MIN = 13, SLOT_S_MAX = 600; // un créneau contient au moins une trame
const MIN_CHANNEL_GAP = 50;              // Hz : un signal FT8 occupe 50 Hz

/** En-tête « #reseau;cle=valeur;... » → réglages du réseau (null si la ligne n'en est pas un). */
function parseNetHeader(line) {
  const m = /^#\s*(r[eé]seau|net)\b(.*)$/i.exec(line.trim());
  if (!m) return null;
  const net = Object.assign({}, NET_DEFAULTS);
  for (const kv of m[2].split(/[;,\s]+/)) {
    const p = /^([a-zé]+)=(.+)$/i.exec(kv);
    if (!p) continue;
    const k = norm(p[1]), v = p[2].trim();
    const n = parseInt(v, 10);
    if (k === 'creneau' && n >= SLOT_S_MIN && n <= SLOT_S_MAX) net.slotS = n;
    else if (k === 'tour' && n >= 1 && n <= SLOT_MAX) net.round = n;
    else if (k === 'pas' && n >= MIN_CHANNEL_GAP && n <= 500) net.step = n;
    else if (k === 'bande') {
      const b = /^(\d+)-(\d+)$/.exec(v);
      if (b && +b[1] >= FREQ_MIN && +b[2] <= FREQ_MAX && +b[1] < +b[2]) { net.bandMin = +b[1]; net.bandMax = +b[2]; }
    } else if (k === 'version') net.version = v.slice(0, 20);
    else if (k === 'date') net.date = v.slice(0, 20);
  }
  return net;
}

/** Colonne vide ou « - » : non renseignée. */
const blank = (c) => c === undefined || c === '' || c === '-';

const SHORT_CALL_RE = /^[A-Z0-9]{2}$/;
const LONG_CALL_RE = /^[A-Z0-9/]{3,12}$/;

/**
 * @param {string} text  contenu du fichier
 * @returns {{map: Object<string, string>, units: Object<string, {type, echelon}>, imported: number,
 *            typed: number, skipped: number[], channels: Object<string, {freq, slot}>,
 *            net: object, warnings: string[]}}
 *          skipped : numéros (à partir de 1) des lignes invalides ; typed : entrées avec un type reconnu ;
 *          channels : canal (Hz) et créneau de chaque station qui en a ; net : en-tête réseau
 *          (défauts sinon, tour = plus grand créneau) ; warnings : incohérences (canaux trop
 *          proches, créneaux en double, valeurs refusées)
 */
function parseDirectory(text) {
  const map = {};
  const units = {};
  const channels = {};
  const skipped = [];
  const warnings = [];
  let net = null;
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let firstData = true;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#')) { const h = parseNetHeader(line); if (h) net = h; return; }
    if (!line) return;
    const raw2 = line.split(/\s*[;,\t]\s*|\s+/).map((c) => c.replace(/^"(.*)"$/, '$1').trim());
    const cols = raw2.map((c) => c.toUpperCase());
    const [short, long] = cols;
    const valid = cols.length >= 2 && SHORT_CALL_RE.test(short) && LONG_CALL_RE.test(long);
    if (!valid) {
      // Première ligne non valide (« court;long », « code,indicatif »...) : en-tête
      if (!firstData) skipped.push(i + 1);
      firstData = false;
      return;
    }
    firstData = false;
    map[short] = long;
    const type = parseUnitType(raw2[2]);
    const ech = findKey(ECHELONS, raw2[3]);
    if (type) units[short] = { type, echelon: ech ? ech.code : null };
    else delete units[short];
    // Canal (Hz) et créneau : refusés hors limites, l'entrée est gardée
    const ch = {};
    if (!blank(raw2[4])) {
      const f = /^\d+$/.test(raw2[4]) ? +raw2[4] : NaN;
      if (f >= FREQ_MIN && f <= FREQ_MAX) ch.freq = f;
      else warnings.push('ligne ' + (i + 1) + ' : canal « ' + raw2[4] + ' » refusé (' + FREQ_MIN + '-' + FREQ_MAX + ' Hz)');
    }
    if (!blank(raw2[5])) {
      const n = /^\d+$/.test(raw2[5]) ? +raw2[5] : NaN;
      if (n >= 1 && n <= SLOT_MAX) ch.slot = n;
      else warnings.push('ligne ' + (i + 1) + ' : créneau « ' + raw2[5] + ' » refusé (1-' + SLOT_MAX + ')');
    }
    if (ch.freq !== undefined || ch.slot !== undefined) channels[short] = ch;
    else delete channels[short];
  });

  net = net || Object.assign({}, NET_DEFAULTS);
  const maxSlot = Object.keys(channels).reduce((m, k) => Math.max(m, channels[k].slot || 0), 0);
  if (!net.round || net.round < maxSlot) {
    if (net.round) warnings.push('tour de ' + net.round + ' créneaux porté à ' + maxSlot + ' (créneau le plus grand)');
    net.round = maxSlot;
  }
  warnings.push(...checkChannels(channels));
  return { map, units, imported: Object.keys(map).length, typed: Object.keys(units).length, skipped, channels, net, warnings };
}

/** Incohérences : deux canaux à moins de 50 Hz (signaux superposés), créneau en double. */
function checkChannels(channels) {
  const out = [];
  const calls = Object.keys(channels).sort();
  for (let a = 0; a < calls.length; a++) {
    for (let b = a + 1; b < calls.length; b++) {
      const x = channels[calls[a]], y = channels[calls[b]];
      if (x.freq !== undefined && y.freq !== undefined && Math.abs(x.freq - y.freq) < MIN_CHANNEL_GAP) {
        out.push('canaux de ' + calls[a] + ' et ' + calls[b] + ' trop proches (' + x.freq + ' et ' + y.freq + ' Hz, < ' + MIN_CHANNEL_GAP + ')');
      }
      if (x.slot !== undefined && x.slot === y.slot) out.push(calls[a] + ' et ' + calls[b] + ' ont le même créneau ' + x.slot);
    }
  }
  return out;
}

/**
 * Début (ms, horloge UTC du téléphone) du prochain créneau `slot` à partir de `now` :
 * tour de `round` créneaux de `slotS` s, le créneau 1 commence à chaque multiple du tour
 * depuis l'origine Unix. Un début dans les `graceMs` passées compte encore (départ immédiat).
 */
function nextSlotStart(now, slot, slotS, round, graceMs = 0) {
  const period = slotS * round * 1000;
  const offset = (slot - 1) * slotS * 1000;
  let t = Math.floor((now - offset) / period) * period + offset;
  if (t < now - graceMs) t += period;
  return t;
}

/** Indicatif à afficher : le long si l'annuaire le connaît, sinon le court. */
function lookupCall(directory, short) {
  return (directory && short && directory[short]) || short;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { parseDirectory, lookupCall, parseUnitType, unitSidc, parseNetHeader, checkChannels, nextSlotStart,
    UNIT_TYPES, ECHELONS, NET_DEFAULTS, MIN_CHANNEL_GAP, SHORT_CALL_RE, LONG_CALL_RE };
}
