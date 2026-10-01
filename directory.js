/**
 * Annuaire SonoChat : indicatif court (2 caractères, celui qui circule sur
 * l'air) -> indicatif long (affiché). Fonctions pures, testables en Node.
 *
 * Fichier importé : une entrée par ligne, « court long », séparés par ; , une
 * tabulation ou des espaces. Colonnes suivantes ignorées, lignes vides ou
 * commençant par # ignorées, ligne d'en-tête tolérée. Doublon : la dernière
 * ligne l'emporte.
 */

const SHORT_CALL_RE = /^[A-Z0-9]{2}$/;
const LONG_CALL_RE = /^[A-Z0-9/]{3,12}$/;

/**
 * @param {string} text  contenu du fichier
 * @returns {{map: Object<string, string>, imported: number, skipped: number[]}}
 *          skipped : numéros (à partir de 1) des lignes invalides
 */
function parseDirectory(text) {
  const map = {};
  const skipped = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let firstData = true;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cols = line.split(/\s*[;,\t]\s*|\s+/).map((c) => c.replace(/^"(.*)"$/, '$1').trim().toUpperCase());
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
  });

  return { map, imported: Object.keys(map).length, skipped };
}

/** Indicatif à afficher : le long si l'annuaire le connaît, sinon le court. */
function lookupCall(directory, short) {
  return (directory && short && directory[short]) || short;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { parseDirectory, lookupCall, SHORT_CALL_RE, LONG_CALL_RE };
}
