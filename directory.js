/**
 * Annuaire ChatMTX : indicatif court (2 caractères, celui qui circule sur
 * l'air) -> indicatif long (affiché), et type d'unité OTAN pour la carte.
 * Fonctions pures, testables en Node.
 *
 * Fichier importé : une entrée par ligne, « court long [type [échelon]] »,
 * séparés par ; , une tabulation ou des espaces. Type : mot clé (infanterie,
 * pompiers, sante...) ou code SIDC APP-6 de 15 caractères ; échelon : mot clé
 * (equipe, section, compagnie...). Type ou échelon inconnu : ignoré. Lignes
 * vides ou commençant par # ignorées, ligne d'en-tête tolérée. Doublon : la
 * dernière ligne l'emporte.
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

const SHORT_CALL_RE = /^[A-Z0-9]{2}$/;
const LONG_CALL_RE = /^[A-Z0-9/]{3,12}$/;

/**
 * @param {string} text  contenu du fichier
 * @returns {{map: Object<string, string>, units: Object<string, {type, echelon}>, imported: number,
 *            typed: number, skipped: number[]}}
 *          skipped : numéros (à partir de 1) des lignes invalides ; typed : entrées avec un type reconnu
 */
function parseDirectory(text) {
  const map = {};
  const units = {};
  const skipped = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let firstData = true;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
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
  });

  return { map, units, imported: Object.keys(map).length, typed: Object.keys(units).length, skipped };
}

/** Indicatif à afficher : le long si l'annuaire le connaît, sinon le court. */
function lookupCall(directory, short) {
  return (directory && short && directory[short]) || short;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { parseDirectory, lookupCall, parseUnitType, unitSidc, UNIT_TYPES, ECHELONS, SHORT_CALL_RE, LONG_CALL_RE };
}
