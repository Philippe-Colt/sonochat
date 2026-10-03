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
  check('sans en-tête : défauts, tour = plus grand créneau', d.net.slotS === 15 && d.net.round === 2 && d.net.step === 100, d.net);
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
{
  const D = require('../directory.js');
  const plan = D.channelPlan();
  check('plan : 12 canaux de 1000 à 2100 Hz au pas de 100', plan.length === 12 && plan[0] === 1000 && plan[11] === 2100, plan);
  check('plan au pas de 60 : 1000 → 1660', D.channelPlan({ step: 60 })[11] === 1660);
  const a = D.allocate([{ short: 'PC', freq: 1100, slot: 3 }, { short: 'XY' }, { short: 'ZZ', freq: 1120, slot: 3 }, { short: 'AB', freq: 9000 }], {});
  const by = {}; a.entries.forEach((e) => { by[e.short] = e; });
  check('attribution : choix valides gardés, conflits et manques complétés', by.PC.freq === 1100 && by.PC.slot === 3
    && by.XY.freq === 1000 && by.XY.slot === 1 && by.ZZ.freq === 1200 && by.ZZ.slot === 2 && by.AB.freq === 1300 && by.AB.slot === 4
    && a.net.round === 4 && a.full.length === 0, a.entries);
  check('attribution : aucun conflit restant', D.checkChannels(Object.fromEntries(a.entries.map((e) => [e.short, e]))).length === 0);
  const many = D.allocate(Array.from({ length: 14 }, (_, i) => ({ short: 'S' + i })), {});
  check('14 stations : 12 canaux, 2 sans canal signalées', many.full.length === 2 && many.entries.filter((e) => e.freq).length === 12, many.full);
  check('plus de 12 stations signalé à l\'import', parseDirectory(Array.from({ length: 13 }, (_, i) => 'S' + String.fromCharCode(65 + i) + ';F1AA' + i).join('\n')).warnings.some((w) => /12 au plus/.test(w)));
  const entries = [{ short: 'PC', long: 'F4MTX', type: 'SFGPUCI--------', echelon: 'D', freq: 1400, slot: 1 },
    { short: 'XY', long: 'F4XYZ', freq: 1460, slot: 2 }, { short: 'ZZ', long: 'F1ZZZ' }, { short: 'K1', long: 'W1AW', type: 'SFGPUCE--------' }];
  const net = { slotS: 20, round: 2, version: '8', date: '2026-10-03' };
  const txt = D.serializeDirectory(entries, net);
  check('fichier écrit', txt === '#reseau;creneau=20;tour=2;version=8;date=2026-10-03\nPC;F4MTX;infanterie;section;1400;1\nXY;F4XYZ;;;1460;2\nZZ;F1ZZZ\nK1;W1AW;genie\n', txt);
  const back = parseDirectory(txt);
  check('relu à l\'identique', JSON.stringify(D.toEntries(back)) === JSON.stringify(entries.slice().sort((x, y) => (x.short < y.short ? -1 : 1)))
    && back.net.slotS === 20 && back.net.version === '8' && back.warnings.length === 0, D.toEntries(back));
  const link = D.directoryLink(txt);
  check('lien QR compact, sans caractère à encoder', link === 'https://chatmtx.f4mtx.com/#annuaire=reseau;creneau=20;tour=2;version=8;date=2026-10-03~PC;F4MTX;infanterie;section;1400;1~XY;F4XYZ;;;1460;2~ZZ;F1ZZZ~K1;W1AW;genie', link);
  check('lien relu (même encodé par l\'appareil photo)', D.directoryFromLink(link) === txt && D.directoryFromLink(encodeURI(link).replace(/;/g, '%3B')) === txt
    && D.directoryFromLink('https://exemple.fr/') === null);
}
{
  const D = require('../directory.js');
  const r = parseDirectory(D.TEST_DIRECTORY);
  check('annuaire de test : 12 stations typées, canaux et créneaux, sans incohérence', r.imported === 12 && r.typed === 12
    && Object.keys(r.channels).length === 12 && r.net.round === 12 && r.net.name === 'TEST' && r.warnings.length === 0, r.warnings);
  const re = D.allocate(D.toEntries(r), r.net);
  check('annuaire de test = attribution automatique', JSON.stringify(re.entries) === JSON.stringify(D.toEntries(r)));
  check('annuaire de test relu à l\'identique', D.serializeDirectory(D.toEntries(r), r.net) === D.TEST_DIRECTORY, D.serializeDirectory(D.toEntries(r), r.net));
}
check('affichage : court sinon', lookupCall({ PC: 'F4MTX' }, 'AB') === 'AB' && lookupCall(null, 'AB') === 'AB');

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
