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
check('9-line : 20 caractères', M.NINE_LEN === 20, M.NINE_LEN);
check('MIST : 11 caractères par blessé', M.MIST_LEN === 11, M.MIST_LEN);
check('en-tête (4) + /9 + 9-line = 26 car. = 2 blocs étendus', 4 + 2 + M.NINE_LEN === 26);
check('MIST seul : 11 blessés tiennent (≤ 128 avec en-tête)', 4 + 3 + 11 * 11 <= 128);
check('9-line + 9 MIST tiennent, pas 10', 4 + 22 + 3 + 9 * 11 <= 128 && 4 + 22 + 3 + 10 * 11 > 128);

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
  check('20 caractères, alphabet FT8 sans espace', s.length === 20 && onAirOk(s) && !s.includes(' '), s);
  const d = M.decodeNine(s);
  check('position à 10 m près', near(d.lat, nine.lat, 1e-4) && near(d.lon, nine.lon, 1e-4), d);
  check('champs restitués, assis déduits (3 − 1)', d.freqKHz === 145500 && d.counts.join() === '1,0,2,0,0' && d.equip.join() === '0,2'
    && d.litter === 1 && d.ambul === 2 && d.security === 3 && d.marking === 2 && d.nation.join() === '0,3'
    && d.nbc.join() === '2' && !d.peace, d);
  const peace = M.decodeNine(M.encodeNine({ ...nine, peace: true, wounds: [1, 5], terrain: [0, 5] }));
  check('temps de paix : blessures et terrain (6 choix)', peace.peace && peace.wounds.join() === '1,5' && peace.terrain.join() === '0,5' && peace.security === null
    && M.WOUNDS.length === 6 && M.TERRAIN.length === 6, peace);
  check('fréquence HF au kHz près', M.decodeNine(M.encodeNine({ ...nine, freqKHz: 14074 })).freqKHz === 14074);
  check('fréquence VHF au pas de 5 kHz', M.decodeNine(M.encodeNine({ ...nine, freqKHz: 145512 })).freqKHz === 145510 && M.roundFreq(433502) === 433500);
  check('couchés plafonnés au total', M.decodeNine(M.encodeNine({ ...nine, litter: 9 })).litter === 3);
  check('longitude -180/180', near(M.decodeNine(M.encodeNine({ ...nine, lon: 179.99995 })).lon, -180, 1e-3) || near(M.decodeNine(M.encodeNine({ ...nine, lon: 179.99995 })).lon, 180, 1e-3));
  let bad = 0;
  for (let i = 0; i < 500; i++) {
    const r = (n) => Math.floor(Math.random() * n);
    const x = { lat: -90 + Math.random() * 180, lon: -180 + Math.random() * 359.9, freqKHz: r(1000000),
      counts: [r(10), r(10), r(10), r(10), r(10)], equip: [0, 1, 2].filter(() => r(2)), litter: r(46),
      peace: !!r(2), security: r(4), wounds: [0, 3, 5].filter(() => r(2)), marking: r(5),
      nation: [0, 1, 4].filter(() => r(2)), nbc: [1, 3].filter(() => r(2)), terrain: [2, 4].filter(() => r(2)) };
    const y = M.decodeNine(M.encodeNine(x));
    const tot = x.counts.reduce((a, b) => a + b, 0);
    if (!y || y.counts.join() !== x.counts.join() || y.litter !== Math.min(x.litter, tot) || y.litter + y.ambul !== tot || y.marking !== x.marking
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
  check('marqueurs /9 et /M', body.startsWith('/9') && body.slice(22, 24) === '/M', body);
  check('9-line + 2 MIST + remarque ≤ 128 avec en-tête', body.length + 4 <= 128, body.length + 4);
  const d = M.decode(body);
  check('décodé : 9-line, 2 blessés, remarque', d && d.nine && d.mist.length === 2 && d.remark === 'LZ AU NORD DU PONT', d);
  const only = M.decode(M.encode({ mist: [mist] }));
  check('MIST seul', only && !only.nine && only.mist.length === 1 && only.kind === 'MIST', only);
  const rb = M.encode({ nine, readback: true });
  check('collationnement : marqueur ?9', rb.startsWith('?9') && M.decode(rb).readback === true, rb);
  check('texte normal : non formaté', M.decode('BONJOUR') === null && M.decode('/9ABC') === null);
  check('9-line abîmé (trame perdue) : texte simple', M.decode('/9' + '…'.repeat(20)) === null);
  const txt = M.toText(d, 'PC', '14:40');
  check('texte en clair : 9 lignes', /1\. Position : 31U DQ/.test(txt) && /2\. Fréquence \/ indicatif : 145,500 MHz \/ PC/.test(txt)
    && /3\. Blessés par urgence : 1A 2C/.test(txt) && /9\. NRBC : C — Chimique/.test(txt) && /1\. Position : 31U DQ \d{4} \d{4} — 48,8584 N/.test(txt), txt);
  check('texte en clair : MIST', /Blessé 2 · A urgent · blessé à 14:35Z/.test(txt) && /S : AVPU V · pouls 120 · resp. 24 · SpO2 92 %/.test(txt), txt);
  const changed = M.decode(M.encode({ nine: { ...nine, counts: [2, 0, 2, 0, 0], marking: 0 }, mist: [mist, { ...mist, patient: 3 }], remark: 'lz au nord du pont' }));
  check('collationnement : lignes différentes (5 suit le total)', JSON.stringify(M.diff(d, changed)) === JSON.stringify(['3', '5', '7']), M.diff(d, changed));
  check('collationnement : conforme', M.diff(d, M.decode(body)).length === 0);
}

console.log('AT-MIST');
{
  const at = { ...mist, age: 34, sex: 1, hemo: 2 };
  const body = M.encode({ mist: [at] });
  check('AT-MIST : marqueur /A, 13 car. par blessé', body.startsWith('/A1') && body.length === 3 + 13, body);
  const d = M.decode(body).mist[0];
  check('âge, sexe, hémorragie restitués', d.age === 34 && d.sex === 1 && d.hemo === 2 && d.pulse === 120 && d.mech === 1, d);
  check('sans âge/sexe/hémorragie : MIST, plus court', M.encode({ mist: [mist] }).startsWith('/M1'));
  const txt = M.toText(M.decode(body), 'PC');
  check('texte : titre AT-MIST, âge et sexe', /^AT-MIST/.test(txt) && /AT : 34 ans, Femme/.test(txt) && /hémorragie active/.test(txt), txt);
  check('9-line + 7 AT-MIST tiennent', 4 + M.encode({ nine, mist: Array(7).fill(at) }).length <= 128);
}

console.log('Formats déclarés');
{
  const r = (n) => Math.floor(Math.random() * n);
  const sample = (f) => {
    switch (f.type) {
      case 'choice': return f.optional && r(3) === 0 ? null : r(f.options.length);
      case 'multi': return f.options.map((_, i) => i).filter(() => r(2));
      case 'count': return r(f.max + 1);
      case 'number': return r(4) === 0 ? null : f.min + r(Math.round((f.max - f.min) / f.step) + 1) * f.step;
      case 'position': return { lat: -80 + Math.random() * 160, lon: -180 + Math.random() * 359 };
      case 'time': return r(4) === 0 ? null : { h: r(24), m: r(12) * 5 };
      case 'dtg': return r(4) === 0 ? null : { d: 1 + r(31), h: r(24), m: r(12) * 5 };
      case 'freq': return [0, 14074, 145500, 433500][r(4)];
      case 'grid': return f.items.map(() => r(f.states.length));
      default: throw new Error(f.type);
    }
  };
  const same = (f, a, b) => {
    if (f.type === 'position') {
      const k = 10 ** -f.precision;
      return Math.abs(a.lat - b.lat) <= k && Math.abs(((a.lon - b.lon + 540) % 360) - 180) <= k;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  };
  for (const [marker, fmt] of Object.entries(M.FORMATS)) {
    let bad = 0, maxLen = 0;
    for (let i = 0; i < 300; i++) {
      const data = Object.fromEntries(fmt.fields.map((f) => [f.key, sample(f)]));
      const body = M.encode({ fmt: marker, data });
      maxLen = Math.max(maxLen, body.length);
      const d = M.decode(body);
      if (!d || d.fmt !== marker || !onAirOk(body) || body.slice(2).includes(' ')
        || fmt.fields.some((f) => !same(f, data[f.key], d.data[f.key]))) { bad++; if (bad === 1) console.log('   ', marker, JSON.stringify(data), d && JSON.stringify(d.data)); }
      M.toText(d, 'PC', '12:00');
    }
    const blocks = Math.ceil((4 + maxLen) / 13);
    check(`${fmt.title} (/${marker}) : 300 aller-retour exacts, ${4 + maxLen} car. = ${blocks} bloc(s)`, bad === 0 && blocks <= 2, bad + ' erreur(s)');
  }
  check('POSREP et LACE : 1 bloc', 4 + 2 + M.fieldsLen(M.FORMATS.P) <= 13 && 4 + 2 + M.fieldsLen(M.FORMATS.L) <= 13);
  const pos = M.decode(M.encode({ fmt: 'P', data: { pos: { lat: 48.85837, lon: 2.29448 } } })).data.pos;
  check('POSREP : position à 100 m près', Math.abs(pos.lat - 48.858) < 1e-6 && Math.abs(pos.lon - 2.294) < 1e-6, pos);
  const rs = M.encode({ fmt: 'R', data: { pos: { lat: 45, lon: 5 }, nature: 0, victims: 2, trend: 2, actions: [0, 1], request: [0, 2] }, remark: 'immeuble r+4' });
  const rd = M.decode(rs);
  check('renseignement + texte court', rd.remark === 'IMMEUBLE R+4' && /JE DEMANDE · Moyens : Engin pompe \(FPT\), Ambulance \(VSAV\)/.test(M.toText(rd, 'PC')), M.toText(rd, 'PC'));
  check('alerte : 9-line, METHANE, CONTACT, UXO ; pas SALUTE ni MIST ni collationnement',
    M.alertTitle('/9X') === '9-LINE' && M.alertTitle('/EX') === 'METHANE' && M.alertTitle('/KX') === 'CONTACT'
    && M.alertTitle('/UX') === '9-LINE UXO/IED' && !M.alertTitle('/SX') && !M.alertTitle('/MX') && !M.alertTitle('?9X'));
  check('isFormatted : marqueurs connus seulement', M.isFormatted('/E1') && M.isFormatted('?L1') && !M.isFormatted('/ZZZ') && !M.isFormatted('/7AB'));
  const m1 = M.decode(M.encode({ fmt: 'E', data: { major: 0, pos: { lat: 45, lon: 5 }, type: 4, hazards: [0], access: [1], ua: 2, ur: 5, imp: 10, dcd: 0, onsite: [0], need: [1, 3] } }));
  const m2 = M.decode(M.encode({ fmt: 'E', data: { ...m1.data, ua: 3 } }));
  check('collationnement seulement pour 9-line, MIST, AT-MIST, METHANE', M.needsReadback('/9ABC') && M.needsReadback('/MXYZ')
    && M.needsReadback('/AXYZ') && M.needsReadback('/EXYZ') && !['S', 'K', 'U', 'L', 'P', 'R'].some((c) => M.needsReadback('/' + c + 'XYZ'))
    && !M.needsReadback('BONJOUR'));
  check('METHANE : collationnement, ligne N différente', JSON.stringify(M.diff(m1, m2)) === JSON.stringify(['N']), M.diff(m1, m2));
  check('METHANE : texte en clair', /^METHANE/.test(M.toText(m1, 'PC')) && /N · Victimes : UA2 UR5 I10 D0/.test(M.toText(m1, 'PC')), M.toText(m1, 'PC'));
}

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
