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
{
  const D = require('../directory.js');
  const txt = '#reseau;creneau=20;tour=12;pas=60;bande=500-2500;version=3;date=2026-10-03\n'
    + 'court;long;type;echelon;canal;creneau\n'
    + 'PC;F4MTX;infanterie;section;1400;1\n'
    + 'XY;F4XYZ;;;1460;2\n'
    + 'ZZ F1ZZZ - - 1520 3\n'
    + 'AB;F1ABC;sante\n';
  const r = parseDirectory(txt);
  check('canal et créneau lus (colonnes vides, « - », espaces)', r.imported === 4 && r.channels.PC.freq === 1400 && r.channels.PC.slot === 1
    && r.channels.XY.freq === 1460 && r.channels.ZZ.slot === 3 && !r.channels.AB && r.units.PC && !r.units.XY, r.channels);
  check('en-tête réseau', r.net.slotS === 20 && r.net.round === 12 && r.net.step === 60 && r.net.bandMin === 500 && r.net.version === '3' && r.net.date === '2026-10-03', r.net);
  check('aucune incohérence', r.warnings.length === 0, r.warnings);
  const d = parseDirectory('PC;F4MTX;;;1400;2\nXY;F4XYZ;;;1430;2\nZZ;F1ZZZ;;;99999;0\n');
  check('sans en-tête : défauts, tour = plus grand créneau', d.net.slotS === 15 && d.net.round === 2 && d.net.step === 60, d.net);
  check('canaux trop proches, créneau en double, valeurs refusées signalés',
    d.warnings.some((w) => /trop proches/.test(w)) && d.warnings.some((w) => /même créneau 2/.test(w))
    && d.warnings.some((w) => /canal « 99999 »/.test(w)) && d.warnings.some((w) => /créneau « 0 »/.test(w)) && d.imported === 3 && !d.channels.ZZ, d.warnings);
  const t = parseDirectory('#reseau tour=2\nPC;F4MTX;;;1400;5\n');
  check('tour plus petit que le plus grand créneau : agrandi et signalé', t.net.round === 5 && t.warnings.some((w) => /porté à 5/.test(w)), t);
  check('ancien fichier (2-4 colonnes) inchangé', parseDirectory('PC;F4MTX;infanterie;section\n').warnings.length === 0
    && Object.keys(parseDirectory('PC;F4MTX;infanterie;section\n').channels).length === 0);
  // Créneaux : tour de 3 × 15 s = 45 s depuis l'origine Unix
  const S = D.nextSlotStart;
  check('créneau suivant', S(0, 1, 15, 3) === 0 && S(1, 1, 15, 3) === 45000 && S(1000, 2, 15, 3) === 15000 && S(16000, 2, 15, 3) === 60000
    && S(44000, 3, 15, 3) === 75000 && S(16000, 2, 15, 3, 2000) === 15000, [S(1, 1, 15, 3), S(16000, 2, 15, 3, 2000)]);
}
check('affichage : court sinon', lookupCall({ PC: 'F4MTX' }, 'AB') === 'AB' && lookupCall(null, 'AB') === 'AB');

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
