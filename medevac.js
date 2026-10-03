/**
 * Messages formatés ChatMTX : demande d'évacuation sanitaire « 9-line » (OTAN)
 * et fiche blessé MIST. Sans DOM : codage, décodage, MGRS, texte en clair.
 *
 * Sur l'air, après l'en-tête (émetteur 2 car. + destinataire 2 car.) :
 *   /9 + 20 car.                    9-line (lignes 1 à 9) : 26 car. en tout, 2 blocs étendus
 *   /M + n + n × 11 car.            MIST, n blessés (n codé sur 1 car., 1 à 11)
 *   /9 + 20 car. + /M + n + ...     9-line suivi de ses fiches MIST
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
  const VERSION = 0;        // MIST
  const NINE_VERSION = 1;   // 9-line resserré à 20 car. (destinataire dans l'en-tête)

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
    { code: 'T', label: 'Traumatisme, fracture' },
    { code: 'B', label: 'Plaie par balle' },
    { code: 'R', label: 'Brûlure' },
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
    { code: 'S', label: 'Pente, montagne' },
    { code: 'F', label: 'Boisé' },
    { code: 'U', label: 'Urbain' },
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

  const SEX = [{ code: 'H', label: 'Homme' }, { code: 'F', label: 'Femme' }];
  const HEMO = [
    { code: 'N', label: 'Pas d\'hémorragie' },
    { code: 'C', label: 'Hémorragie contrôlée' },
    { code: 'A', label: 'Hémorragie active' },
  ];

  const MAX_COUNT = 9;       // blessés par catégorie d'urgence (ligne 3)
  const MAX_TOTAL = 5 * MAX_COUNT; // ligne 5 : couchés ≤ total ligne 3, assis = le reste
  const MAX_MIST = 11;       // fiches MIST seules par message (en-tête 4 + 3 + 11 × 11 = 128)
  const MAX_MIST_WITH_NINE = 9; // après un 9-line (4 + 22 + 3 + 9 × 11 = 128)
  const MAX_ATMIST = 9;      // AT-MIST seules (4 + 3 + 9 × 13 = 124)
  const MAX_ATMIST_WITH_NINE = 7; // après un 9-line (4 + 22 + 3 + 7 × 13 = 120)

  // Rangs des champs, du plus significatif au moins significatif
  // Lignes 6 et 9 et guerre/paix en un seul rang : guerre = sécurité × NRBC (4 × 16),
  // paix = blessures × terrain (2^6 × 2^6), à la suite
  const WAR_L69 = SECURITY.length * (1 << NBC.length);
  const PEACE_BITS = 6;
  const NINE_RADIX = [
    ['version', 2],
    ['lat', 1800001], ['lon', 3600000], ['freq', 224001],
    ['cA', 10], ['cB', 10], ['cC', 10], ['cD', 10], ['cE', 10],
    ['equip', 8], ['litter', MAX_TOTAL + 1],
    ['l69', WAR_L69 + (1 << (2 * PEACE_BITS))], ['marking', 5], ['nation', 32],
  ];
  const MIST_RADIX = [
    ['version', 4], ['patient', 16], ['prec', 5], ['time', 289], ['mech', 12],
    ['regions', 1024], ['avpu', 5], ['pulse', 52], ['resp', 32], ['spo2', 52], ['treat', 1024],
  ];

  // AT-MIST (bilan victime) : MIST + âge, sexe, hémorragie ; sans version (marqueur /A).
  // Choisi automatiquement si l'un de ces champs est renseigné, sinon MIST (plus court)
  const ATMIST_RADIX = [
    ['patient', 16], ['prec', 5], ['time', 289], ['age', 102], ['sex', 3], ['mech', 12],
    ['regions', 1024], ['avpu', 5], ['hemo', 4], ['pulse', 52], ['resp', 32], ['spo2', 52], ['treat', 1024],
  ];

  function digitsFor(radix) {
    let max = 1n;
    for (const [, r] of radix) max *= BigInt(r);
    let n = 0;
    for (let p = 1n; p < max; p *= BASE) n++;
    return n;
  }
  const NINE_LEN = digitsFor(NINE_RADIX);   // 20
  const MIST_LEN = digitsFor(MIST_RADIX);   // 11
  const ATMIST_LEN = digitsFor(ATMIST_RADIX); // 13

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

  // Fréquence : 0 = non précisée ; jusqu'à 30 MHz au kHz près (HF), au-delà au pas de 5 kHz
  const HF_MAX_KHZ = 30000, VHF_STEP_KHZ = 5;
  function encodeFreq(kHz) {
    kHz = Math.round(kHz || 0);
    if (kHz <= 0) return 0;
    if (kHz <= HF_MAX_KHZ) return kHz;
    return HF_MAX_KHZ + Math.min(194000, Math.max(1, Math.round((kHz - HF_MAX_KHZ) / VHF_STEP_KHZ)));
  }
  function decodeFreq(v) {
    return v <= HF_MAX_KHZ ? v : HF_MAX_KHZ + (v - HF_MAX_KHZ) * VHF_STEP_KHZ;
  }
  /** Fréquence telle qu'elle sera transmise (arrondi au pas de 5 kHz au-dessus de 30 MHz). */
  const roundFreq = (kHz) => decodeFreq(encodeFreq(kHz));

  /**
   * @param {object} d
   *   lat, lon (degrés) · freqKHz (0 = non précisée) · counts [A..E] · equip [indices EQUIPMENT]
   *   litter (couchés ; assis = total ligne 3 − couchés) · peace (bool)
   *   security (indice SECURITY, guerre) · wounds [indices WOUNDS, paix]
   *   marking (indice) · nation [indices] · nbc [indices NBC, guerre] · terrain [indices TERRAIN, paix]
   * @returns {string} 20 caractères
   */
  function encodeNine(d) {
    const latI = Math.round((d.lat + 90) * 1e4);
    const lonI = ((Math.round((d.lon + 180) * 1e4) % 3600000) + 3600000) % 3600000;
    const c = d.counts || [];
    const total = [0, 1, 2, 3, 4].reduce((a, i) => a + (c[i] || 0), 0);
    const l69 = d.peace
      ? WAR_L69 + (maskOf(d.wounds) << PEACE_BITS) + maskOf(d.terrain)
      : (d.security || 0) * (1 << NBC.length) + maskOf(d.nbc);
    return pack(NINE_RADIX, {
      version: NINE_VERSION,
      lat: latI, lon: lonI, freq: encodeFreq(d.freqKHz),
      cA: c[0] || 0, cB: c[1] || 0, cC: c[2] || 0, cD: c[3] || 0, cE: c[4] || 0,
      equip: maskOf(d.equip), litter: Math.min(d.litter || 0, total),
      l69, marking: d.marking || 0, nation: maskOf(d.nation),
    }, NINE_LEN);
  }

  function decodeNine(str) {
    const v = unpack(NINE_RADIX, str);
    if (!v || v.version !== NINE_VERSION) return null;
    const counts = [v.cA, v.cB, v.cC, v.cD, v.cE];
    const total = counts.reduce((a, b) => a + b, 0);
    if (v.litter > total) return null;
    const peace = v.l69 >= WAR_L69;
    const p = v.l69 - WAR_L69;
    return {
      lat: v.lat / 1e4 - 90, lon: v.lon / 1e4 - 180, freqKHz: decodeFreq(v.freq),
      counts, equip: bitsOf(v.equip, EQUIPMENT.length), litter: v.litter, ambul: total - v.litter,
      peace,
      security: peace ? null : Math.floor(v.l69 / (1 << NBC.length)),
      wounds: peace ? bitsOf(p >> PEACE_BITS, WOUNDS.length) : [],
      marking: v.marking, nation: bitsOf(v.nation, NATIONALITY.length),
      nbc: peace ? [] : bitsOf(v.l69 % (1 << NBC.length), NBC.length),
      terrain: peace ? bitsOf(p & ((1 << PEACE_BITS) - 1), TERRAIN.length) : [],
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

  const isAtMist = (p) => (p.age !== null && p.age !== undefined) || (p.sex !== null && p.sex !== undefined)
    || (p.hemo !== null && p.hemo !== undefined);

  function encodeAtMist(p) {
    const base = unpack(MIST_RADIX, encodeMist(p));
    const opt = (x) => (x === null || x === undefined ? 0 : x + 1);
    return pack(ATMIST_RADIX, {
      ...base, age: p.age === null || p.age === undefined ? 0 : 1 + Math.max(0, Math.min(100, Math.round(p.age))),
      sex: opt(p.sex), hemo: opt(p.hemo),
    }, ATMIST_LEN);
  }

  function decodeAtMist(str) {
    const v = unpack(ATMIST_RADIX, str);
    if (!v || v.mech >= MECHANISM.length) return null;
    const p = decodeMist(pack(MIST_RADIX, { ...v, version: VERSION }, MIST_LEN));
    if (!p) return null;
    return { ...p, age: v.age ? v.age - 1 : null, sex: v.sex ? v.sex - 1 : null, hemo: v.hemo ? v.hemo - 1 : null };
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
  // FORMATS DÉCLARÉS PAR LEURS CHAMPS (METHANE, renseignement, SALUTE...)
  // Pas de champ version : un format qui change prend une nouvelle lettre.
  // Ordre des champs et des listes = format sur l'air : ne jamais réordonner.
  // ============================================================

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const opt = (v) => v === null || v === undefined;

  /** Types de champs : rangs (un ou plusieurs), valeur → entiers, entiers → valeur. */
  const TYPES = {
    choice: { // indice dans options ; optional : null possible (« ? »)
      radix: (f) => [f.options.length + (f.optional ? 1 : 0)],
      enc: (f, v) => [f.optional ? (opt(v) ? 0 : v + 1) : (v || 0)],
      dec: (f, [n]) => (f.optional ? (n ? n - 1 : null) : n),
    },
    multi: {
      radix: (f) => [1 << f.options.length],
      enc: (f, v) => [maskOf(v)],
      dec: (f, [n]) => bitsOf(n, f.options.length),
    },
    count: {
      radix: (f) => [f.max + 1],
      enc: (f, v) => [clamp(Math.round(v || 0), 0, f.max)],
      dec: (f, [n]) => n,
    },
    number: { // min..max au pas step ; 0 = inconnu
      radix: (f) => [Math.round((f.max - f.min) / f.step) + 2],
      enc: (f, v) => [opt(v) ? 0 : 1 + clamp(Math.round((v - f.min) / f.step), 0, Math.round((f.max - f.min) / f.step))],
      dec: (f, [n]) => (n ? f.min + (n - 1) * f.step : null),
    },
    position: { // precision : 4 → 1e-4° (~10 m), 3 → 1e-3° (~100 m)
      radix: (f) => [180 * 10 ** f.precision + 1, 360 * 10 ** f.precision],
      enc: (f, v) => {
        const k = 10 ** f.precision;
        return [Math.round((v.lat + 90) * k), ((Math.round((v.lon + 180) * k) % (360 * k)) + 360 * k) % (360 * k)];
      },
      dec: (f, [a, b]) => ({ lat: a / 10 ** f.precision - 90, lon: b / 10 ** f.precision - 180 }),
    },
    time: { // {h, m} UTC au pas de 5 min ; 0 = inconnue
      radix: () => [289],
      enc: (f, v) => [opt(v) ? 0 : 1 + Math.round((v.h * 60 + v.m) / 5) % 288],
      dec: (f, [n]) => (n ? { h: Math.floor((n - 1) * 5 / 60), m: (n - 1) * 5 % 60 } : null),
    },
    dtg: { // {d, h, m} jour du mois + heure UTC ; 0 = inconnu
      radix: () => [31 * 288 + 1],
      enc: (f, v) => [opt(v) ? 0 : 1 + (clamp(v.d, 1, 31) - 1) * 288 + Math.round((v.h * 60 + v.m) / 5) % 288],
      dec: (f, [n]) => {
        if (!n) return null;
        const t = (n - 1) % 288;
        return { d: Math.floor((n - 1) / 288) + 1, h: Math.floor(t * 5 / 60), m: t * 5 % 60 };
      },
    },
    freq: {
      radix: () => [224001],
      enc: (f, v) => [encodeFreq(v)],
      dec: (f, [n]) => decodeFreq(n),
    },
    grid: { // un état par ligne (LACE : vert/orange/rouge/noir)
      radix: (f) => [f.states.length ** f.items.length],
      enc: (f, v) => [(v || []).reduce((a, x) => a * f.states.length + (x || 0), 0)],
      dec: (f, [n]) => {
        const out = [];
        for (let i = 0; i < f.items.length; i++) { out.unshift(n % f.states.length); n = Math.floor(n / f.states.length); }
        return out;
      },
    },
  };

  const radixOf = (fmt) => fmt.fields.flatMap((f) => TYPES[f.type].radix(f).map((r, i) => [f.key + '.' + i, r]));
  const fieldsLen = (fmt) => fmt.len || (fmt.len = digitsFor(radixOf(fmt)));

  function packFields(fmt, data) {
    const values = {};
    for (const f of fmt.fields) TYPES[f.type].enc(f, data[f.key]).forEach((v, i) => { values[f.key + '.' + i] = v; });
    return pack(radixOf(fmt), values, fieldsLen(fmt));
  }

  function unpackFields(fmt, str) {
    const v = unpack(radixOf(fmt), str);
    if (!v) return null;
    const out = {};
    for (const f of fmt.fields) {
      const parts = TYPES[f.type].radix(f).map((_, i) => v[f.key + '.' + i]);
      if (f.type === 'choice' && !f.optional && parts[0] >= f.options.length) return null;
      out[f.key] = TYPES[f.type].dec(f, parts);
    }
    return out;
  }

  // --- Aides d'affichage communes ---
  const L = (list) => list.map((x) => (typeof x === 'string' ? { code: '', label: x } : x));
  const one = (opts, i) => (i === null || i === undefined ? null : opts[i]);
  const many = (opts, idx) => idx.map((i) => opts[i]);
  const lbl = (items, none) => (items.length ? items.map((x) => x.label).join(', ') : none);
  const cds = (items) => items.map((x) => x.code).filter(Boolean).join('');
  const posLine = (n, label, p) => {
    const m = toMgrs(p.lat, p.lon);
    return { n, label, code: m || '', text: formatLatLon(p.lat, p.lon) };
  };
  const hhmm = (t) => (t ? `${pad2(t.h)}:${pad2(t.m)}Z` : 'inconnue');

  const COLORS = [
    { code: 'V', label: 'Vert' }, { code: 'O', label: 'Orange' }, { code: 'R', label: 'Rouge' }, { code: 'N', label: 'Noir' },
  ];
  const DIR8 = [['N', 'le nord'], ['NE', 'le nord-est'], ['E', 'l\'est'], ['SE', 'le sud-est'], ['S', 'le sud'],
    ['SO', 'le sud-ouest'], ['O', 'l\'ouest'], ['NO', 'le nord-ouest']].map(([code, label]) => ({ code, label }));

  /** Registre des formats génériques, par lettre de marqueur. */
  const FORMATS = {};
  function define(fmt) { FORMATS[fmt.marker] = fmt; return fmt; }

  define({
    marker: 'E', title: 'METHANE', family: 'sante', alert: true,
    desc: 'Événement majeur : lieu, type, dangers, accès, victimes, moyens',
    fields: [
      { key: 'major', type: 'choice', tag: 'M', label: 'Événement majeur', options: L([
        { code: 'D', label: 'Déclaré' }, { code: 'P', label: 'Pré-alerte' }]) },
      { key: 'pos', type: 'position', precision: 4, tag: 'E', label: 'Lieu exact' },
      { key: 'type', type: 'choice', tag: 'T', label: 'Type', options: L([
        'Accident routier', 'Ferroviaire', 'Aérien', 'Maritime', 'Incendie', 'Explosion', 'Effondrement',
        'NRBC', 'Inondation', 'Tempête', 'Séisme', 'Attentat, tuerie', 'Mouvement de foule',
        'Accident industriel', 'Autre']) },
      { key: 'hazards', type: 'multi', tag: 'H', label: 'Dangers', none: 'Aucun', options: L([
        'Incendie', 'Explosion', 'Produits chimiques', 'Gaz', 'Électricité', 'Effondrement', 'Eau',
        'Tireur, menace', 'Radiologique', 'Circulation']) },
      { key: 'access', type: 'multi', tag: 'A', label: 'Accès', none: 'Non précisé', options: L([
        'Par le nord', 'Par l\'est', 'Par le sud', 'Par l\'ouest', 'Hélicoptère possible', 'Accès difficile']) },
      { key: 'ua', type: 'count', max: 99, tag: 'N', label: 'UA · urgences absolues', group: 'N', groupTitle: 'Nombre de victimes' },
      { key: 'ur', type: 'count', max: 99, tag: 'N', label: 'UR · urgences relatives', group: 'N' },
      { key: 'imp', type: 'count', max: 99, tag: 'N', label: 'Impliqués', group: 'N' },
      { key: 'dcd', type: 'count', max: 99, tag: 'N', label: 'Décédés', group: 'N' },
      { key: 'onsite', type: 'multi', tag: 'E', label: 'Moyens sur place', none: 'Aucun', group: 'E', groupTitle: 'Moyens sur place et demandés', options: L([
        'Pompiers', 'SMUR', 'Police, gendarmerie', 'Hélicoptère', 'Équipe NRBC', 'Secouristes']) },
      { key: 'need', type: 'multi', tag: 'E', label: 'Moyens demandés', none: 'Aucun', group: 'E', options: L([
        'Pompiers', 'SMUR', 'Police, gendarmerie', 'Hélicoptère', 'Équipe NRBC', 'Secouristes']) },
    ],
    lines(d) {
      const f = this.fields;
      return [
        { n: 'M', label: 'Événement majeur', code: one(f[0].options, d.major).code, text: one(f[0].options, d.major).label },
        posLine('E', 'Lieu exact', d.pos),
        { n: 'T', label: 'Type', code: '', text: one(f[2].options, d.type).label },
        { n: 'H', label: 'Dangers', code: '', text: lbl(many(f[3].options, d.hazards), 'Aucun') },
        { n: 'A', label: 'Accès', code: '', text: lbl(many(f[4].options, d.access), 'Non précisé') },
        { n: 'N', label: 'Victimes', code: `UA${d.ua} UR${d.ur} I${d.imp} D${d.dcd}`,
          text: `${d.ua} UA, ${d.ur} UR, ${d.imp} impliqué${d.imp > 1 ? 's' : ''}, ${d.dcd} décédé${d.dcd > 1 ? 's' : ''}` },
        { n: 'E', label: 'Moyens', code: '', text: 'sur place : ' + lbl(many(f[9].options, d.onsite), 'aucun')
          + ' · demandés : ' + lbl(many(f[10].options, d.need), 'aucun') },
      ];
    },
  });

  define({
    marker: 'R', title: 'RENSEIGNEMENT', family: 'secours', textMax: 40,
    desc: 'Je suis · Je vois · Je prévois · Je fais · Je demande',
    fields: [
      { key: 'pos', type: 'position', precision: 4, tag: 'JE SUIS', label: 'Je suis (position)' },
      { key: 'nature', type: 'choice', tag: 'JE VOIS', label: 'Je vois (nature)', options: L([
        'Feu d\'habitation', 'Feu d\'établissement', 'Feu industriel', 'Feu de véhicule', 'Feu de végétation',
        'Accident de circulation', 'Secours à personne', 'Fuite de gaz', 'Produit dangereux, pollution',
        'Effondrement', 'Inondation', 'Explosion', 'Sauvetage, noyade', 'Autre']) },
      { key: 'victims', type: 'count', max: 99, tag: 'JE VOIS', label: 'Victimes', group: 'nature' },
      { key: 'trend', type: 'choice', tag: 'JE PRÉVOIS', label: 'Je prévois', options: L([
        'Maîtrisé', 'Stable', 'Extension possible', 'Extension certaine', 'Risque d\'explosion', 'Évacuation à prévoir']) },
      { key: 'actions', type: 'multi', tag: 'JE FAIS', label: 'Je fais', none: 'Reconnaissance seule', options: L([
        'Sauvetages', 'Extinction', 'Établissement de lances', 'Périmètre de sécurité', 'Évacuation',
        'Soins aux victimes', 'Protection des biens', 'Coupure énergies']) },
      { key: 'request', type: 'multi', tag: 'JE DEMANDE', label: 'Je demande', none: 'Rien', options: L([
        'Engin pompe (FPT)', 'Échelle (EPA)', 'Ambulance (VSAV)', 'SMUR', 'Police, gendarmerie',
        'Équipe NRBC', 'Hélicoptère', 'Renfort important', 'Gaz, électricité', 'Chef de groupe']) },
    ],
    lines(d) {
      const f = this.fields;
      return [
        posLine('JE SUIS', 'Position', d.pos),
        { n: 'JE VOIS', label: 'Nature, victimes', code: '', text: one(f[1].options, d.nature).label + ' · ' + d.victims + ' victime' + (d.victims > 1 ? 's' : '') },
        { n: 'JE PRÉVOIS', label: 'Évolution', code: '', text: one(f[3].options, d.trend).label },
        { n: 'JE FAIS', label: 'Actions', code: '', text: lbl(many(f[4].options, d.actions), 'Reconnaissance') },
        { n: 'JE DEMANDE', label: 'Moyens', code: '', text: lbl(many(f[5].options, d.request), 'Rien') },
      ];
    },
  });

  define({
    marker: 'S', title: 'SALUTE', family: 'contact',
    desc: 'Observation : effectif, activité, lieu, unité, heure, équipement',
    fields: [
      { key: 'size', type: 'number', min: 1, max: 999, step: 1, tag: 'S', label: 'Effectif' },
      { key: 'activity', type: 'choice', tag: 'A', label: 'Activité', groupTitle: 'Activité et direction', options: L([
        'Statique', 'Déplacement', 'Observation', 'Creuse, fortifie', 'Patrouille', 'Attaque', 'Défense',
        'Repli', 'Ravitaillement', 'Embuscade', 'Pose d\'engin', 'Rassemblement', 'Autre']) },
      { key: 'heading', type: 'choice', optional: true, tag: 'A', label: 'Direction du déplacement', options: DIR8, group: 'activity' },
      { key: 'pos', type: 'position', precision: 4, tag: 'L', label: 'Lieu' },
      { key: 'unit', type: 'choice', tag: 'U', label: 'Unité, tenue', options: L([
        'Militaires en uniforme', 'Paramilitaires', 'Civils armés', 'Police', 'Civils', 'Véhicules seuls',
        'Uniforme inconnu', 'Autre']) },
      { key: 'time', type: 'time', tag: 'T', label: 'Heure (UTC)' },
      { key: 'equip', type: 'multi', tag: 'E', label: 'Équipement', none: 'Non vu', options: L([
        'Armes légères', 'Mitrailleuse', 'Lance-roquettes', 'Mortier', 'Artillerie', 'Véhicule léger',
        'Véhicule blindé', 'Char', 'Drone', 'Radio', 'Engins explosifs', 'Optiques']) },
    ],
    lines(d) {
      const f = this.fields;
      const h = one(f[2].options, d.heading);
      return [
        { n: 'S', label: 'Effectif', code: '', text: d.size === null ? 'inconnu' : String(d.size) },
        { n: 'A', label: 'Activité', code: '', text: one(f[1].options, d.activity).label + (h ? ' vers ' + h.label : '') },
        posLine('L', 'Lieu', d.pos),
        { n: 'U', label: 'Unité, tenue', code: '', text: one(f[4].options, d.unit).label },
        { n: 'T', label: 'Heure', code: '', text: hhmm(d.time) },
        { n: 'E', label: 'Équipement', code: '', text: lbl(many(f[6].options, d.equip), 'Non vu') },
      ];
    },
  });

  define({
    marker: 'K', title: 'CONTACT', family: 'contact', alert: true,
    desc: 'Contact immédiat : position, azimut, distance, nature',
    fields: [
      { key: 'pos', type: 'position', precision: 4, tag: '1', label: 'Ma position' },
      { key: 'bearing', type: 'number', min: 0, max: 355, step: 5, unit: '°', tag: '2', label: 'Azimut du contact', groupTitle: 'Azimut et distance' },
      { key: 'dist', type: 'number', min: 0, max: 5000, step: 50, unit: 'm', tag: '2', label: 'Distance', group: 'bearing' },
      { key: 'nature', type: 'choice', tag: '3', label: 'Nature', options: L([
        'Tirs armes légères', 'Tirs indirects', 'Embuscade', 'Engin explosif', 'Mines', 'Tireur isolé',
        'Véhicule hostile', 'Drone', 'Mouvement suspect', 'Autre']) },
      { key: 'cas', type: 'count', max: 99, tag: '4', label: 'Blessés amis' },
    ],
    lines(d) {
      const f = this.fields;
      return [
        posLine('1', 'Ma position', d.pos),
        { n: '2', label: 'Azimut, distance', code: '', text: (d.bearing === null ? 'azimut ?' : d.bearing + '°') + ' · ' + (d.dist === null ? 'distance ?' : d.dist + ' m') },
        { n: '3', label: 'Nature', code: '', text: one(f[3].options, d.nature).label },
        { n: '4', label: 'Blessés amis', code: '', text: String(d.cas) },
      ];
    },
  });

  define({
    marker: 'U', title: '9-LINE UXO/IED', family: 'contact', alert: true,
    desc: 'Engin explosif ou non explosé',
    fields: [
      { key: 'dtg', type: 'dtg', tag: '1', label: 'Date-heure de découverte (UTC)' },
      { key: 'pos', type: 'position', precision: 4, tag: '2', label: 'Position' },
      { key: 'freq', type: 'freq', tag: '3', label: 'Contact (fréquence)' },
      { key: 'type', type: 'choice', tag: '4', label: 'Type d\'engin', options: L([
        { code: 'D', label: 'Largué' }, { code: 'P', label: 'Projeté' }, { code: 'L', label: 'Posé' },
        { code: 'T', label: 'Lancé' }, { code: 'I', label: 'Engin explosif improvisé' }, { code: 'M', label: 'Mine' },
        { code: 'U', label: 'Munition non explosée' }, { code: '?', label: 'Inconnu' }]) },
      { key: 'nbc', type: 'multi', tag: '5', label: 'Contamination NRBC', none: 'Aucune', options: NBC },
      { key: 'threat', type: 'multi', tag: '6', label: 'Ressources menacées', none: 'Aucune', options: L([
        'Personnel', 'Véhicules', 'Installations', 'Itinéraire', 'Population', 'Infrastructure']) },
      { key: 'impact', type: 'choice', tag: '7', label: 'Impact sur la mission', options: L([
        'Aucun', 'Mineur', 'Majeur', 'Mission arrêtée']) },
      { key: 'protect', type: 'multi', tag: '8', label: 'Mesures de protection', none: 'Aucune', options: L([
        'Bouclage', 'Évacuation', 'Mise à l\'abri', 'Itinéraire dévié', 'Marquage']) },
      { key: 'priority', type: 'choice', tag: '9', label: 'Priorité', options: L([
        { code: 'I', label: 'Immédiate' }, { code: 'N', label: 'Indirecte' }, { code: 'M', label: 'Mineure' },
        { code: 'S', label: 'Sans menace' }]) },
    ],
    lines(d, call) {
      const f = this.fields;
      const t = d.dtg;
      return [
        { n: '1', label: 'Date-heure', code: '', text: t ? `le ${t.d} à ${pad2(t.h)}:${pad2(t.m)}Z` : 'inconnue' },
        posLine('2', 'Position', d.pos),
        { n: '3', label: 'Contact', code: '', text: formatFreq(d.freq) + ' / ' + (call || '?') },
        { n: '4', label: 'Type', code: one(f[3].options, d.type).code, text: one(f[3].options, d.type).label },
        { n: '5', label: 'NRBC', code: cds(many(NBC, d.nbc)), text: lbl(many(NBC, d.nbc), 'Aucune') },
        { n: '6', label: 'Menacé', code: '', text: lbl(many(f[5].options, d.threat), 'Rien') },
        { n: '7', label: 'Impact mission', code: '', text: one(f[6].options, d.impact).label },
        { n: '8', label: 'Protection', code: '', text: lbl(many(f[7].options, d.protect), 'Aucune') },
        { n: '9', label: 'Priorité', code: one(f[8].options, d.priority).code, text: one(f[8].options, d.priority).label },
      ];
    },
  });

  define({
    marker: 'L', title: 'LACE', family: 'unite',
    desc: 'État de l\'unité : liquides, munitions, blessés, équipement',
    fields: [
      { key: 'state', type: 'grid', tag: 'LACE', label: 'État', groupTitle: 'État de l\'unité', states: COLORS,
        items: ['L · Liquides (eau, carburant)', 'A · Munitions', 'C · Blessés', 'E · Équipement'] },
      { key: 'cas', type: 'count', max: 99, tag: 'C', label: 'Nombre de blessés', group: 'state' },
    ],
    lines(d) {
      const names = ['Liquides', 'Munitions', 'Blessés', 'Équipement'];
      return d.state.map((x, i) => ({ n: 'LACE'[i], label: names[i], code: COLORS[x].code,
        text: COLORS[x].label + (i === 2 ? ' · ' + d.cas + ' blessé' + (d.cas > 1 ? 's' : '') : '') }));
    },
  });

  define({
    marker: 'P', title: 'POSREP', family: 'unite',
    desc: 'Position de la station (100 m), 1 bloc',
    fields: [{ key: 'pos', type: 'position', precision: 3, tag: 'P', label: 'Position' }],
    lines(d) { return [posLine('P', 'Position (±100 m)', d.pos)]; },
  });

  /** Familles, dans l'ordre du menu « messages formatés ». */
  const FAMILIES = [
    { id: 'sante', label: 'Santé' },
    { id: 'secours', label: 'Sécurité civile' },
    { id: 'contact', label: 'Contact et engins' },
    { id: 'unite', label: 'Unité' },
  ];

  // ============================================================
  // MESSAGE COMPLET
  // ============================================================

  /**
   * Corps du message (sans l'indicatif) : 9-line et/ou fiches MIST + remarque.
   * @param {{nine?: object, mist?: object[], remark?: string, readback?: boolean}} m
   */
  function encode(m) {
    let s = '';
    if (m.fmt) {
      const f = FORMATS[m.fmt];
      s = '/' + f.marker + packFields(f, m.data);
    }
    if (m.nine) s += '/9' + encodeNine(m.nine);
    const at = (m.mist || []).some(isAtMist);
    const mist = (m.mist || []).slice(0, at ? (m.nine ? MAX_ATMIST_WITH_NINE : MAX_ATMIST) : (m.nine ? MAX_MIST_WITH_NINE : MAX_MIST));
    if (mist.length) s += (at ? '/A' : '/M') + DIGITS[mist.length] + mist.map(at ? encodeAtMist : encodeMist).join('');
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
    return /^[/?][0-9A-Z]/.test(body || '') && (body[1] in FORMATS || body[1] === '9' || body[1] === 'M' || body[1] === 'A');
  }

  /** Format qui déclenche l'alerte chez le destinataire, dès l'en-tête : son titre, sinon null. */
  function alertTitle(body) {
    if (!/^\/[0-9A-Z]/.test(body || '')) return null;
    if (body[1] === '9') return '9-LINE';
    const f = FORMATS[body[1]];
    return f && f.alert ? f.title : null;
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
    const gen = FORMATS[s[1]];
    if (gen) {
      const len = fieldsLen(gen);
      if (s.length < 2 + len) return null;
      const data = unpackFields(gen, s.slice(2, 2 + len));
      if (!data) return null;
      return { fmt: gen.marker, data, nine: null, mist: [], remark: s.slice(2 + len).trim(), readback, kind: gen.title };
    }
    if (s.startsWith('/9')) {
      if (s.length < 2 + NINE_LEN) return null;
      nine = decodeNine(s.slice(2, 2 + NINE_LEN));
      if (!nine) return null;
      s = s.slice(2 + NINE_LEN);
    }
    if (s.startsWith('/M') || s.startsWith('/A')) {
      const at = s[1] === 'A';
      const len = at ? ATMIST_LEN : MIST_LEN;
      const n = DIGITS.indexOf(s[2]);
      if (n < 1 || n > (at ? MAX_ATMIST : MAX_MIST) || s.length < 3 + n * len) return null;
      for (let i = 0; i < n; i++) {
        const p = (at ? decodeAtMist : decodeMist)(s.substr(3 + i * len, len));
        if (!p) return null;
        mist.push(p);
      }
      s = s.slice(3 + n * len);
    }
    if (!nine && !mist.length) return null;
    return { nine, mist, remark: s.trim(), readback, kind: nine ? '9-LINE MEDEVAC' : (mist.some(isAtMist) ? 'AT-MIST' : 'MIST') };
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
    if (msg.fmt) {
      const out = FORMATS[msg.fmt].lines(msg.data, call);
      if (msg.remark) out.push({ label: 'Remarque', text: msg.remark });
      return out;
    }
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
        p.hemo !== null && p.hemo !== undefined ? HEMO[p.hemo].label.toLowerCase() : null,
      ].filter(Boolean);
      const at = [p.age !== null && p.age !== undefined ? p.age + ' ans' : null, p.sex !== null && p.sex !== undefined ? SEX[p.sex].label : null]
        .filter(Boolean).join(', ');
      if (at) out.push({ mist: true, head, label: 'AT', text: at });
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
    const title = (msg.readback ? 'COLLATIONNEMENT ' : '') + msg.kind
      + (call ? ' de ' + call : '') + (when ? ' · ' + when : '');
    const out = [title];
    let lastHead = null;
    for (const l of lines(msg, call)) {
      if (l.mist && l.head && l.head !== lastHead) {
        out.push('', l.head);
        lastHead = l.head;
      }
      if (l.n) out.push(`${l.n}${/^\d+$/.test(l.n) ? '.' : ' ·'} ${l.label} : ${l.code ? l.code + ' — ' : ''}${l.text}`);
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
    DIGITS, NINE_LEN, MIST_LEN, ATMIST_LEN, MAX_COUNT, MAX_TOTAL, MAX_MIST, MAX_MIST_WITH_NINE,
    MAX_ATMIST, MAX_ATMIST_WITH_NINE, roundFreq, FORMATS, FAMILIES, fieldsLen, alertTitle, isAtMist, SEX, HEMO, COLORS,
    PRECEDENCE, EQUIPMENT, SECURITY, WOUNDS, MARKING, NATIONALITY, NBC, TERRAIN,
    MECHANISM, REGIONS, AVPU, TREATMENT,
    encode, decode, isFormatted, encodeNine, decodeNine, encodeMist, decodeMist,
    toMgrs, fromMgrs, parsePosition, toUtm, fromUtm, utmZone, formatLatLon, formatFreq, lines, toText, diff, normalizeRemark,
  };
  if (typeof module === 'object' && module.exports) module.exports = Medevac;
  else root.Medevac = Medevac;
})(typeof self !== 'undefined' ? self : this);
