// Carte tactique (tacmap.js, tiles.js) : symboles APP-6, projection CONTACT,
// carroyage MGRS, tuiles d'une zone, vieillissement. Usage : node tests/tacmap.js
const M = require('../medevac.js');
const T = require('../tacmap.js');
const Tiles = require('../tiles.js');
const ms = require('../milsymbol.js');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
const near = (a, b, e) => Math.abs(a - b) < e;

console.log('Symboles APP-6');
{
  const all = new Set([T.FRIEND].concat(T.METHANE_SIDC, T.NATURE_SIDC, T.CONTACT_SIDC, T.UXO_SIDC,
    ['EFOPAE---------', 'EFOPAA---------', 'SHGPU----------', 'SUGPU----------', 'OHVPEI---------']));
  const bad = [...all].filter((c) => !new ms.Symbol(c, { standard: 'APP6' }).isValid());
  check(`${all.size} codes SIDC valides pour milsymbol`, bad.length === 0, bad);
  check('une entrée par type METHANE, nature de renseignement, nature de contact, type d\'engin',
    T.METHANE_SIDC.length === M.FORMATS.E.fields[2].options.length && T.NATURE_SIDC.length === M.FORMATS.R.fields[1].options.length
    && T.CONTACT_SIDC.length === M.FORMATS.K.fields[3].options.length && T.UXO_SIDC.length === M.FORMATS.U.fields[3].options.length);
}

console.log('Message → symbole');
const pos = { lat: 48.8584, lon: 2.2945 };
const msg = (body, extra) => Object.assign({ text: body, call: 'XY', type: 'received', time: '12:00:00', timestamp: 1e12 }, extra || {});
const enc = (fmt, data) => M.encode({ fmt, data });
{
  const nine = M.encode({ nine: { lat: pos.lat, lon: pos.lon, counts: [1, 0, 2, 0, 0], litter: 1, security: 0, marking: 2, nation: [3] } });
  const s9 = T.symbolsFor(M.decode(nine), msg(nine));
  check('9-line : point MEDEVAC (ambulance) à la ligne 1, « 1A 2C »', s9.length === 1 && s9[0].sidc === 'EFOPAE---------' && near(s9[0].lat, pos.lat, 2e-4) && s9[0].info === '1A 2C', s9);
  const me = T.symbolsFor(M.decode(enc('E', { major: 0, pos, type: 4, hazards: [], access: [], ua: 1, ur: 2, imp: 3, dcd: 0, onsite: [], need: [] })), msg(''));
  check('METHANE incendie : symbole feu, victimes', me[0].sidc === 'EFIPC----------' && /UA1 UR2 I3 D0/.test(me[0].info), me);
  const rs = T.symbolsFor(M.decode(enc('R', { pos, nature: 0, victims: 2, trend: 0, actions: [], request: [] })), msg(''));
  check('renseignement feu d\'habitation : symbole maison en feu', rs[0].sidc === 'EFIPCD---------', rs);
  const sa = T.symbolsFor(M.decode(enc('S', { size: 12, activity: 1, heading: null, pos, unit: 0, time: null, equip: [] })), msg(''));
  check('SALUTE militaires : unité hostile infanterie, effectif', sa[0].sidc === 'SHGPUCI--------' && /^12 ·/.test(sa[0].info), sa);
  const ct = T.symbolsFor(M.decode(enc('K', { pos, bearing: 90, dist: 1000, nature: 5, cas: 0 })), msg(''));
  check('CONTACT tireur isolé : 1 km à l\'est de l\'observateur, trait depuis lui',
    ct[0].sidc === 'OHVPS----------' && near(ct[0].lat, pos.lat, 1e-3) && near((ct[0].lon - pos.lon) * 111.32 * Math.cos(pos.lat * Math.PI / 180), 1.0, 0.02) && ct[0].from, ct);
  const cu = T.symbolsFor(M.decode(enc('K', { pos, bearing: null, dist: 500, nature: 0, cas: 0 })), msg(''));
  check('CONTACT sans azimut : à la position de l\'observateur', near(cu[0].lat, pos.lat, 2e-4) && !cu[0].from, cu);
  const ux = T.symbolsFor(M.decode(enc('U', { dtg: null, pos, freq: 0, type: 4, nbc: [], threat: [], impact: 0, protect: [], priority: 0 })), msg(''));
  check('UXO de type IED : symbole IED', ux[0].sidc === 'OHVPEI---------', ux);
  check('collationnement ignoré', T.symbolsFor(M.decode('?' + enc('S', { size: 1, activity: 0, heading: null, pos, unit: 0, time: null, equip: [] }).slice(1)), msg('')).length === 0);
}

console.log('Historique → carte');
{
  const now = 2e12;
  const h = [
    msg(enc('P', { pos: { lat: 45.0, lon: 5.0 } }), { call: 'PC', timestamp: now - 7 * 3600e3 }),
    msg(enc('P', { pos: { lat: 45.01, lon: 5.01 } }), { call: 'PC', timestamp: now - 2 * 3600e3 }),
    msg(enc('L', { state: [0, 1, 2, 0], cas: 3 }), { call: 'PC', timestamp: now - 600e3 }),
    msg(enc('S', { size: 5, activity: 0, heading: null, pos: { lat: 45.02, lon: 5.0 }, unit: 1, time: null, equip: [] }), { timestamp: now - 60e3 }),
    msg('BONJOUR', { timestamp: now }),
    msg(enc('P', { pos: { lat: 46, lon: 6 } }), { status: 'incomplet', timestamp: now }),
  ];
  const c = T.collect(h, now);
  const unit = c.marks.find((m) => m.unit === 'PC');
  check('POSREP : une seule unité, à la dernière position', c.marks.filter((m) => m.unit === 'PC').length === 1 && near(unit.lat, 45.01, 1e-3), c.marks);
  check('LACE sur l\'unité', /LACE VORV · 3 blessés/.test(unit.info), unit.info);
  check('trajet des POSREP', c.tracks.PC.length === 2, c.tracks);
  check('message incomplet et texte libre ignorés', c.marks.length === 2, c.marks.map((m) => m.title));
  check('vieillissement : récent 100 %, 2 h 60 %, 7 h 30 %', T.ageOpacity(60e3) === 1 && T.ageOpacity(2 * 3600e3) === 0.6 && T.ageOpacity(7 * 3600e3) === 0.3);
}

console.log('Carroyage MGRS');
{
  const lines = T.gridLines(48.80, 2.25, 48.90, 2.35, 13);
  const es = lines.filter((l) => l.kind === 'e');
  const okE = es.every((l) => { const u = M.toUtm(l.pts[4][0], l.pts[4][1], 31); return Math.abs(u.easting / 1000 - Math.round(u.easting / 1000)) < 0.01; });
  check('zoom 13 : lignes au kilomètre exact', T.gridStep(13) === 1000 && es.length > 5 && okE, es.length);
  check('libellés à 2 chiffres', lines.every((l) => /^\d\d$/.test(l.label)), lines.slice(0, 3).map((l) => l.label));
  check('zoom 10 : 10 km ; zoom 8 : 100 km', T.gridStep(10) === 10000 && T.gridStep(8) === 100000);
  check('trop de lignes : rien plutôt qu\'une carte illisible', T.gridLines(40, -5, 50, 10, 13).length === 0);
  check('MGRS complet au mètre (5 + 5 chiffres)', /^31U DQ \d{5} \d{5}$/.test(M.toMgrs(48.853, 2.3499, 5)) && M.toMgrs(48.853, 2.3499) === '31U DQ 5231 1131', M.toMgrs(48.853, 2.3499, 5));
  const cells = T.gridCells(48.84, 2.33, 48.87, 2.37, 13);
  const okCell = cells.every((c) => { const m = M.toMgrs(c.lat + 0.002, c.lon + 0.003, 5).split(' '); return c.label === m[1] + ' ' + m[2].slice(0, 2) + ' ' + m[3].slice(0, 2); });
  check('1 km : « DQ 52 11 » dans chaque carré, cohérent avec un point du carré', cells.length > 10 && okCell, cells.slice(0, 3));
  check('10 km : « DP 2 7 » ; 100 km : « 31U DQ », zone voisine non étiquetée',
    /^[A-Z]{2} \d \d$/.test(T.gridCells(48.5, 2, 49.2, 2.8, 10)[0].label) && T.gridCells(45, 0, 50, 6, 7).every((c) => /^31[TU] [A-Z]{2}$/.test(c.label)),
    T.gridCells(45, 0, 50, 6, 7).map((c) => c.label));
}

console.log('Tuiles hors ligne');
{
  const z15 = Tiles.tilesAround(48.85, 2.29, 20, 15, 15).length;
  const all = Tiles.estimate(48.85, 2.29, 20, 8, 15);
  check('rayon 20 km au zoom 15 : ~2 000 tuiles', z15 > 1500 && z15 < 3000, z15);
  check('zooms 8 à 15 : estimation affichée', all.tiles > z15 && all.bytes === all.tiles * Tiles.EST_BYTES, all);
  check('URL IGN Plan IGN v2, grille PM', /LAYER=GEOGRAPHICALGRIDSYSTEMS\.PLANIGNV2/.test(Tiles.tileUrl(15, 16597, 11272)) && /TILEMATRIX=15&TILEROW=11272&TILECOL=16597/.test(Tiles.tileUrl(15, 16597, 11272)));
}

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
