// Messages formatés 9-line et MIST (medevac.js) : codage, MGRS, texte en clair.
// Usage : node tests/medevac.js
const M = require('../medevac.js');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

const CHARSET = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
const onAirOk = (s) => [...s].every((c) => CHARSET.includes(c));
const near = (a, b, m) => Math.abs(a - b) < m;

console.log('Longueurs');
check('9-line : 22 caractères', M.NINE_LEN === 22, M.NINE_LEN);
check('MIST : 11 caractères par blessé', M.MIST_LEN === 11, M.MIST_LEN);
check('9-line + indicatif = 26 car. = 2 blocs étendus', 2 + 2 + M.NINE_LEN <= 26);
check('MIST seul : 11 blessés tiennent (≤ 128 avec indicatif)', 2 + 2 + 1 + 11 * 11 <= 128);
check('9-line + 9 MIST tiennent, pas 10', 2 + 24 + 3 + 9 * 11 <= 128 && 2 + 24 + 3 + 10 * 11 > 128);

console.log('MGRS');
{
  // Monument de Washington, référence MGRS publiée : 18S UJ 23487 06483
  const m = M.toMgrs(38.8895, -77.0352);
  check('Washington : 18S UJ 2348 0648', m === '18S UJ 2348 0648', m);
  const p = M.fromMgrs('18SUJ2348706483');
  check('Washington : MGRS → lat/lon', near(p.lat, 38.8895, 2e-4) && near(p.lon, -77.0352, 2e-4), p);
  let worst = 0;
  for (let i = 0; i < 2000; i++) {
    const lat = -79.9 + Math.random() * 163.8, lon = -180 + Math.random() * 359.99;
    const back = M.fromMgrs(M.toMgrs(lat, lon));
    const err = Math.hypot((back.lat - lat) * 111000, (back.lon - lon) * 111000 * Math.cos(lat * Math.PI / 180));
    worst = Math.max(worst, err);
  }
  check('aller-retour sur 2000 points : < 15 m', worst < 15, worst.toFixed(1) + ' m');
  check('Norvège : zone 32V', M.toMgrs(60.39, 5.32).startsWith('32V'), M.toMgrs(60.39, 5.32));
  check('Svalbard : zone 33X', M.toMgrs(78.22, 15.65).startsWith('33X'), M.toMgrs(78.22, 15.65));
  check('hémisphère sud', near(M.fromMgrs(M.toMgrs(-33.8568, 151.2153)).lat, -33.8568, 2e-4));
  check('pôle : pas de MGRS', M.toMgrs(85, 0) === null);
  check('saisie « lat, lon »', JSON.stringify(M.parsePosition('48,8584 ; 2,2945')) === JSON.stringify({ lat: 48.8584, lon: 2.2945 }), M.parsePosition('48,8584 ; 2,2945'));
  check('saisie décimale point', near(M.parsePosition('48.8584, 2.2945').lon, 2.2945, 1e-9));
  check('saisie MGRS avec espaces', near(M.parsePosition('31U DQ 4825 1193').lat, M.fromMgrs('31UDQ48251193').lat, 1e-9));
  check('saisie invalide', M.parsePosition('n importe quoi') === null);
}

console.log('9-line');
const nine = {
  lat: 48.8584, lon: 2.2945, freqKHz: 145500, counts: [1, 0, 2, 0, 0], equip: [0, 2],
  litter: 1, ambul: 2, peace: false, security: 3, marking: 2, nation: [0, 3], nbc: [2],
};
{
  const s = M.encodeNine(nine);
  check('22 caractères, alphabet FT8 sans espace', s.length === 22 && onAirOk(s) && !s.includes(' '), s);
  const d = M.decodeNine(s);
  check('position à 10 m près', near(d.lat, nine.lat, 1e-4) && near(d.lon, nine.lon, 1e-4), d);
  check('champs restitués', d.freqKHz === 145500 && d.counts.join() === '1,0,2,0,0' && d.equip.join() === '0,2'
    && d.litter === 1 && d.ambul === 2 && d.security === 3 && d.marking === 2 && d.nation.join() === '0,3'
    && d.nbc.join() === '2' && !d.peace, d);
  const peace = M.decodeNine(M.encodeNine({ ...nine, peace: true, wounds: [1, 6], terrain: [0, 6] }));
  check('temps de paix : blessures et terrain', peace.peace && peace.wounds.join() === '1,6' && peace.terrain.join() === '0,6' && peace.security === null, peace);
  check('longitude -180/180', near(M.decodeNine(M.encodeNine({ ...nine, lon: 179.99995 })).lon, -180, 1e-3) || near(M.decodeNine(M.encodeNine({ ...nine, lon: 179.99995 })).lon, 180, 1e-3));
  let bad = 0;
  for (let i = 0; i < 500; i++) {
    const r = (n) => Math.floor(Math.random() * n);
    const x = { lat: -90 + Math.random() * 180, lon: -180 + Math.random() * 359.9, freqKHz: r(1000000),
      counts: [r(10), r(10), r(10), r(10), r(10)], equip: [0, 1, 2].filter(() => r(2)), litter: r(32), ambul: r(32),
      peace: !!r(2), security: r(4), wounds: [0, 3, 5].filter(() => r(2)), marking: r(5),
      nation: [0, 1, 4].filter(() => r(2)), nbc: [1, 3].filter(() => r(2)), terrain: [2, 4].filter(() => r(2)) };
    const y = M.decodeNine(M.encodeNine(x));
    if (!y || y.counts.join() !== x.counts.join() || y.litter !== x.litter || y.marking !== x.marking
      || (x.peace ? y.wounds.join() !== x.wounds.join() : y.security !== x.security)) bad++;
  }
  check('500 messages aléatoires : aller-retour exact', bad === 0, bad);
}

console.log('MIST');
const mist = { patient: 2, prec: 0, time: { h: 14, m: 35 }, mech: 1, regions: [2, 6], avpu: 1,
  pulse: 120, resp: 24, spo2: 92, treat: [0, 2] };
{
  const s = M.encodeMist(mist);
  check('11 caractères', s.length === 11 && onAirOk(s) && !s.includes(' '), s);
  const d = M.decodeMist(s);
  check('champs restitués', JSON.stringify(d) === JSON.stringify(mist), d);
  const u = M.decodeMist(M.encodeMist({ patient: 1, prec: 3, time: null, mech: 11, regions: [], avpu: null,
    pulse: null, resp: null, spo2: null, treat: [] }));
  check('valeurs inconnues', u.time === null && u.avpu === null && u.pulse === null && u.spo2 === null, u);
}

console.log('Message complet');
{
  const body = M.encode({ nine, mist: [mist, { ...mist, patient: 3 }], remark: 'lz au nord du pont' });
  check('caractères FT8 seulement', onAirOk(body), body);
  check('marqueurs /9 et /M', body.startsWith('/9') && body.slice(24, 26) === '/M', body);
  check('9-line + 2 MIST + remarque ≤ 128 avec indicatif', body.length + 2 <= 128, body.length + 2);
  const d = M.decode(body);
  check('décodé : 9-line, 2 blessés, remarque', d && d.nine && d.mist.length === 2 && d.remark === 'LZ AU NORD DU PONT', d);
  const only = M.decode(M.encode({ mist: [mist] }));
  check('MIST seul', only && !only.nine && only.mist.length === 1 && only.kind === 'MIST', only);
  const rb = M.encode({ nine, readback: true });
  check('relecture : marqueur ?9', rb.startsWith('?9') && M.decode(rb).readback === true, rb);
  check('texte normal : non formaté', M.decode('BONJOUR') === null && M.decode('/9ABC') === null);
  check('9-line abîmé (trame perdue) : texte simple', M.decode('/9' + '…'.repeat(22)) === null);
  const txt = M.toText(d, 'PC', '14:40');
  check('texte en clair : 9 lignes', /1\. Position : 31U DQ/.test(txt) && /2\. Fréquence \/ indicatif : 145,500 MHz \/ PC/.test(txt)
    && /3\. Blessés par urgence : 1A 2C/.test(txt) && /9\. NRBC : C — Chimique/.test(txt) && /1\. Position : 31U DQ \d{4} \d{4} — 48,8584 N/.test(txt), txt);
  check('texte en clair : MIST', /Blessé 2 · A urgent · blessé à 14:35Z/.test(txt) && /S : AVPU V · pouls 120 · resp. 24 · SpO2 92 %/.test(txt), txt);
  const changed = M.decode(M.encode({ nine: { ...nine, counts: [2, 0, 2, 0, 0], marking: 0 }, mist: [mist, { ...mist, patient: 3 }], remark: 'lz au nord du pont' }));
  check('relecture : lignes différentes', JSON.stringify(M.diff(d, changed)) === JSON.stringify(['3', '7']), M.diff(d, changed));
  check('relecture : conforme', M.diff(d, M.decode(body)).length === 0);
}

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
