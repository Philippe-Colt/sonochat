// Test de l'import d'annuaire (directory.js). Usage : node tests/directory.js
const { parseDirectory, lookupCall } = require('../directory.js');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

{
  const r = parseDirectory('PC;F4MTX\nAB,F1ABC\nXY\tF5XYZ/P\nK1 W1AW  Hiram Maxim\n');
  check('séparateurs ; , tabulation espaces', r.imported === 4 && r.map.PC === 'F4MTX' && r.map.AB === 'F1ABC'
    && r.map.XY === 'F5XYZ/P' && r.map.K1 === 'W1AW', r);
  check('colonnes en plus ignorées', r.map.K1 === 'W1AW' && r.skipped.length === 0, r);
}
{
  const r = parseDirectory('court;long\r\n# commentaire\r\n\r\npc;f4mtx\r\n');
  check('en-tête, commentaire, ligne vide, CRLF, minuscules', r.imported === 1 && r.map.PC === 'F4MTX' && r.skipped.length === 0, r);
}
{
  const r = parseDirectory('﻿"PC";"F4MTX"\n');
  check('BOM et guillemets', r.map.PC === 'F4MTX', r);
}
{
  const r = parseDirectory('PC;F4MTX\nPC;F4ZZZ\n');
  check('doublon : la dernière ligne l\'emporte', r.imported === 1 && r.map.PC === 'F4ZZZ', r);
}
{
  const r = parseDirectory('PC;F4MTX\nPCX;F1ABC\nAB;F1\nAB\nA_;F1ABC\nZZ;F1ABC;x\n');
  check('lignes invalides comptées et numérotées', r.imported === 2 && JSON.stringify(r.skipped) === '[2,3,4,5]', r);
}
{
  const r = parseDirectory('');
  check('fichier vide', r.imported === 0 && r.skipped.length === 0, r);
}
{
  const r = parseDirectory('\x00\x01PNG binaire\n???\n');
  check('fichier quelconque : rien importé', r.imported === 0, r);
}
check('affichage : long si connu', lookupCall({ PC: 'F4MTX' }, 'PC') === 'F4MTX');
{
  const D = require('../directory.js');
  const r = parseDirectory('PC;F4MTX;infanterie;section\nXY;F4XYZ;Pompiers\nZZ;F1ZZZ;SFGPUCE--------;compagnie\nK1;W1AW;Hiram;Maxim\nAB;F1ABC;génie;Régiment\nCD;F1CDE\n');
  check('type et échelon : mots clés, accents, majuscules', r.units.PC.type === 'SFGPUCI--------' && r.units.PC.echelon === 'D'
    && r.units.XY.type === 'EFOPC----------' && r.units.AB.type === 'SFGPUCE--------' && r.units.AB.echelon === 'G', r.units);
  check('type en code SIDC accepté', r.units.ZZ.type === 'SFGPUCE--------' && r.units.ZZ.echelon === 'E', r.units.ZZ);
  check('type inconnu ou absent : pas de type, entrée gardée', !r.units.K1 && !r.units.CD && r.map.K1 === 'W1AW' && r.imported === 6 && r.typed === 4, r);
  check('SIDC avec échelon en position 12', D.unitSidc(r.units.PC) === 'SFGPUCI----D---' && D.unitSidc(r.units.XY) === 'EFOPC----------' && D.unitSidc(null) === null);
  const ms = require('../milsymbol.js');
  const bad = [];
  for (const t of D.UNIT_TYPES) for (const e of [null].concat(D.ECHELONS.map((x) => x.code))) {
    const c = D.unitSidc({ type: t.sidc, echelon: e });
    if (!new ms.Symbol(c, { standard: 'APP6' }).isValid()) bad.push(c);
  }
  check(`${D.UNIT_TYPES.length} types × ${D.ECHELONS.length + 1} échelons : symboles APP-6 valides`, bad.length === 0, bad);
}
check('affichage : court sinon', lookupCall({ PC: 'F4MTX' }, 'AB') === 'AB' && lookupCall(null, 'AB') === 'AB');

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
