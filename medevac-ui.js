/**
 * Interface des messages formatés (9-line MEDEVAC, MIST) : saisie pas à pas
 * avec de très gros boutons, carte dans le fil de discussion, affichage plein
 * écran, partage, QR code, impression. Le codage est dans medevac.js.
 *
 * MedevacUI.init({ getCall, callLabel, getStation, savePeace, send, isNative, share, getDest, knownStations })
 *   getCall()      indicatif court de la station (ligne 2)
 *   getDest()      destinataire courant ('' : aucun, '99' : en l'air)
 *   knownStations() [{call, label}] : annuaire et stations entendues
 *   callLabel(c)   indicatif affiché (annuaire : court → long)
 *   getStation()   {pos: texte saisi dans les paramètres, freq: MHz, peace: bool}
 *   savePeace(b)   mémorise le dernier choix guerre/paix
 *   send(body, to) émet le corps du message vers `to` (étendu, accusé du destinataire)
 *   share(text)    partage natif (application) ou null
 */
(function () {
  'use strict';
  const M = window.Medevac;
  let opts = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  function init(o) {
    opts = o;
  }

  // ============================================================
  // SAISIE PAS À PAS
  // ============================================================

  let st = null;        // message en cours
  let steps = [];
  let stepIdx = 0;
  let overlay = null;

  function newNine() {
    const station = opts.getStation();
    const pos = M.parsePosition(station.pos);
    const freq = parseFloat(String(station.freq || '').replace(',', '.'));
    return {
      peace: !!station.peace,
      pos: pos ? { ...pos, src: 'station' } : null,
      freqKHz: Number.isFinite(freq) && freq > 0 ? Math.round(freq * 1000) : 0,
      counts: [0, 0, 0, 0, 0], equip: [], litter: 0, ambul: 0,
      security: null, wounds: [], marking: null, nation: [], nbc: [], terrain: [],
    };
  }

  function newPatient(n) {
    const now = new Date();
    return { patient: n, prec: 0, time: { h: now.getUTCHours(), m: Math.floor(now.getUTCMinutes() / 5) * 5 },
      age: null, sex: null, hemo: null, mech: null, regions: [], avpu: null, pulse: null, resp: null, spo2: null, treat: [] };
  }

  /** Nouveau message : destinataire courant s'il est précis (jamais 99, un accusé est exigé). */
  function resetMessage() {
    const d = opts.getDest();
    st = { nine: null, mist: [], fmt: null, data: null, remark: '', to: d && d !== '99' ? d : '' };
  }

  /** Destinataire choisi d'abord s'il manque, puis go(). */
  function withTo(go) {
    if (st.to) { go(); return; }
    pickStation({ title: 'Destinataire du message', current: '', allowBroadcast: false, stations: opts.knownStations(),
      onPick: (c) => { st.to = c; go(); } });
  }

  const startNine = () => { st.nine = newNine(); startSteps(nineSteps()); };
  const startMist = () => { st.mist.push(newPatient(1)); startSteps(mistSteps(0)); };
  const startFormat = (marker) => () => { st.fmt = marker; st.data = newData(M.FORMATS[marker]); startSteps(genericSteps(M.FORMATS[marker])); };

  /** Bouton MEDEVAC : directement le 9-line. */
  function openNine() {
    if (!opts.getCall()) { opts.askCall(); return; }
    resetMessage();
    showOverlay();
    withTo(startNine);
  }

  /** Bouton MSG : tous les messages formatés, rangés par type. */
  function openChooser(keep) {
    if (!opts.getCall()) { opts.askCall(); return; }
    if (!keep || !st) resetMessage();
    showOverlay();
    const entries = {
      sante: [
        { act: 'nine', title: '9-LINE MEDEVAC', desc: 'Demande d\'évacuation sanitaire', red: true },
        { act: 'mist', title: 'MIST', desc: 'Fiche blessé, bilan victime (AT-MIST)' },
      ],
    };
    for (const f of Object.values(M.FORMATS)) (entries[f.family] = entries[f.family] || []).push({ act: f.marker, title: f.title, desc: f.desc, red: f.alert });
    const btn = (e) => `<button type="button" class="mv-big${e.red ? ' mv-red' : ''}" data-act="${e.act}"><b>${esc(e.title)}</b><span>${esc(e.desc)}</span></button>`;
    renderFrame({
      title: 'Messages formatés',
      sub: 'Envoyés en une fois, accusé de réception et collationnement du destinataire',
      body: `<div class="mv-grid mv-grid-1">
        <button type="button" class="mv-big${st.to ? '' : ' mv-red'}" data-act="to"><b>${st.to ? 'TO ' + esc(opts.callLabel(st.to)) : 'TO ?'}</b><span>${st.to ? 'Destinataire (toucher pour changer)' : 'Choisir le destinataire'}</span></button>
      </div>
      ${M.FAMILIES.filter((fa) => entries[fa.id]).map((fa) => `<h3 class="mv-family">${esc(fa.label)}</h3>
        <div class="mv-grid mv-grid-2">${entries[fa.id].map(btn).join('')}</div>`).join('')}`,
      nav: false,
    });
    overlay.querySelector('[data-act="to"]').onclick = () => pickStation({ title: 'Destinataire du message', current: st.to,
      allowBroadcast: false, stations: opts.knownStations(), onPick: (c) => { st.to = c; openChooser(true); } });
    overlay.querySelectorAll('.mv-family + .mv-grid [data-act]').forEach((b) => {
      const a = b.dataset.act;
      b.onclick = () => withTo(a === 'nine' ? startNine : a === 'mist' ? startMist : startFormat(a));
    });
  }

  // ============================================================
  // CHOIX D'UNE STATION (destinataire)
  // ============================================================

  /**
   * Liste à gros boutons : 99 (en l'air, si permis), stations connues, saisie libre.
   * @param {{title, current, allowBroadcast, stations, onPick}} o
   */
  function pickStation(o) {
    const p = el('<div class="mv-overlay mv-picker" role="dialog" aria-modal="true"></div>');
    const btn = (call, big, small, extra = '') => `<button type="button" class="mv-big${call === o.current ? ' on' : ''}${extra}" data-call="${esc(call)}"><b>${esc(big)}</b><span>${esc(small)}</span></button>`;
    p.innerHTML = `
      <div class="mv-head">
        <button type="button" class="mv-x" data-act="close" aria-label="Fermer">&times;</button>
        <div class="mv-titles"><h2>${esc(o.title)}</h2><p>Seul le destinataire accuse réception</p></div>
      </div>
      <div class="mv-body">
        <div class="mv-grid mv-grid-1">
          ${o.allowBroadcast ? btn('99', '99 · TOUS', 'Message en l\'air : tout le monde reçoit, personne n\'accuse') : ''}
        </div>
        <div class="mv-grid mv-grid-2">
          ${o.stations.map((x) => btn(x.call, x.label, x.label !== x.call ? 'code ' + x.call : 'station connue')).join('')}
        </div>
        <div class="mv-edit"><input type="text" id="mv-call-input" maxlength="2" autocapitalize="characters" spellcheck="false" placeholder="Autre : XY"><button type="button" class="mv-navbtn mv-next" data-act="other">OK</button></div>
        <p class="mv-pos-msg" id="mv-call-msg"></p>
      </div>`;
    document.body.appendChild(p);
    const done = (c) => { p.remove(); o.onPick(c); };
    p.querySelector('[data-act="close"]').onclick = () => p.remove();
    p.querySelectorAll('[data-call]').forEach((b) => { b.onclick = () => done(b.dataset.call); });
    const input = p.querySelector('#mv-call-input');
    input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2); };
    p.querySelector('[data-act="other"]').onclick = () => {
      const c = input.value;
      if (!/^[A-Z0-9]{2}$/.test(c) || (c === '99' && !o.allowBroadcast)) {
        p.querySelector('#mv-call-msg').textContent = c === '99' ? 'Un message formaté demande un destinataire précis.' : 'Indicatif court : 2 lettres ou chiffres.';
        return;
      }
      done(c);
    };
  }

  function showOverlay() {
    closeOverlay();
    overlay = el('<div class="mv-overlay" role="dialog" aria-modal="true"></div>');
    document.body.appendChild(overlay);
  }

  function closeOverlay() {
    if (overlay) overlay.remove();
    overlay = null;
  }

  /** @param {function} [onBackAtStart] « Retour » sur la première étape (défaut : choix du message) */
  function startSteps(list, onBackAtStart) {
    steps = list;
    steps.onBackAtStart = onBackAtStart || (() => openChooser(true));
    stepIdx = 0;
    renderStep();
  }

  function renderFrame({ title, sub, body, nav = true, nextLabel = 'Suivant', canNext = true, progress = '' }) {
    overlay.innerHTML = `
      <div class="mv-head">
        <button type="button" class="mv-x" data-act="close" aria-label="Fermer">&times;</button>
        <div class="mv-titles"><span class="mv-progress">${esc(progress)}</span><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
      </div>
      <div class="mv-body">${body}</div>
      ${nav ? `<div class="mv-nav">
        <button type="button" class="mv-navbtn" data-act="back">&larr; Retour</button>
        <button type="button" class="mv-navbtn mv-next" data-act="next"${canNext ? '' : ' disabled'}>${esc(nextLabel)} &rarr;</button>
      </div>` : ''}`;
    overlay.querySelector('[data-act="close"]').onclick = closeOverlay;
    const back = overlay.querySelector('[data-act="back"]');
    if (back) back.onclick = () => { if (stepIdx > 0) { stepIdx--; renderStep(); } else steps.onBackAtStart(); };
    const next = overlay.querySelector('[data-act="next"]');
    if (next) next.onclick = () => { if (stepIdx < steps.length - 1) { stepIdx++; renderStep(); } };
  }

  function renderStep() {
    const s = steps[stepIdx];
    const isLast = stepIdx === steps.length - 1;
    renderFrame({
      title: s.title, sub: typeof s.sub === 'function' ? s.sub() : s.sub, progress: s.progress || '', body: s.body(),
      nav: !isLast || !!s.nav, canNext: s.valid ? s.valid() : true, nextLabel: s.nextLabel || 'Suivant',
    });
    if (s.bind) s.bind(overlay.querySelector('.mv-body'));
    overlay.querySelector('.mv-body').scrollTop = 0;
  }

  const refresh = () => {
    const y = overlay.querySelector('.mv-body').scrollTop;
    renderStep();
    overlay.querySelector('.mv-body').scrollTop = y;
  };

  // --- Widgets ---

  /** Choix unique ou multiple : gros boutons « code + libellé ». */
  function choices(items, isOn, { cols = 2, key = 'i' } = {}) {
    return `<div class="mv-grid mv-grid-${cols}">${items.map((it, i) => {
      const code = typeof it === 'string' ? '' : it.code;
      const label = typeof it === 'string' ? it : it.label;
      return `<button type="button" class="mv-big${isOn(i) ? ' on' : ''}" data-${key}="${i}" aria-pressed="${isOn(i)}">
        ${code ? `<b>${esc(code)}</b>` : ''}<span>${esc(label)}</span></button>`;
    }).join('')}</div>`;
  }

  /** @param {boolean} [autoNext] choix unique : passe à l'étape suivante après la sélection */
  function bindChoices(root, key, onPick, autoNext) {
    root.querySelectorAll(`[data-${key}]`).forEach((b) => {
      b.onclick = () => {
        onPick(+b.dataset[key]);
        refresh();
        if (autoNext) setTimeout(() => { if (stepIdx < steps.length - 1) { stepIdx++; renderStep(); } }, 250);
      };
    });
  }

  const toggle = (list, i) => (list.includes(i) ? list.filter((x) => x !== i) : [...list, i].sort((a, b) => a - b));

  /** Compteur : [ − ] valeur [ + ], avec « ? » facultatif (inconnu). */
  function counter(id, label, value, { unknown = false, step = 1, unit = '' } = {}) {
    const v = value === null ? '?' : value;
    return `<div class="mv-counter" data-counter="${id}">
      <span class="mv-counter-label">${esc(label)}</span>
      <div class="mv-counter-row">
        <button type="button" class="mv-step" data-d="${-step}" aria-label="moins">&minus;</button>
        <output>${esc(v)}${value !== null && unit ? `<small>${esc(unit)}</small>` : ''}</output>
        <button type="button" class="mv-step" data-d="${step}" aria-label="plus">+</button>
        ${unknown ? `<button type="button" class="mv-step mv-unk${value === null ? ' on' : ''}" data-d="?">?</button>` : ''}
      </div>
    </div>`;
  }

  function bindCounters(root, get, set) {
    root.querySelectorAll('[data-counter]').forEach((c) => {
      const id = c.dataset.counter;
      c.querySelectorAll('[data-d]').forEach((b) => {
        b.onclick = () => {
          const d = b.dataset.d;
          set(id, d === '?' ? null : d, get(id));
          refresh();
        };
      });
    });
  }

  // --- Écrans réutilisables : position, fréquence ---

  /** Position (GPS, station, saisie MGRS ou degrés) dans obj[key] = {lat, lon, src, acc}. */
  function positionWidget(obj, key, precisionNote) {
    return {
      body: () => {
        const v = obj[key];
        const mgrs = v ? M.toMgrs(v.lat, v.lon) : null;
        const station = M.parsePosition(opts.getStation().pos);
        return `<div class="mv-pos">
          <div class="mv-pos-value">${v ? esc(mgrs || '') : 'Aucune position'}</div>
          <div class="mv-pos-sub">${v ? esc(M.formatLatLon(v.lat, v.lon)) + ' · ' + esc(v.src === 'gps' ? `GPS ±${Math.round(v.acc || 0)} m` : v.src === 'station' ? 'position de la station' : 'saisie') : ''}</div>
          ${precisionNote ? `<div class="mv-pos-sub">${esc(precisionNote)}</div>` : ''}
          <p class="mv-pos-msg" id="mv-pos-msg"></p>
        </div>
        <div class="mv-grid mv-grid-1">
          <button type="button" class="mv-big mv-red" data-pos="gps"><b>GPS</b><span>Position actuelle du téléphone</span></button>
          ${station ? `<button type="button" class="mv-big" data-pos="station"><b>STATION</b><span>${esc(M.toMgrs(station.lat, station.lon) || M.formatLatLon(station.lat, station.lon))}</span></button>` : ''}
          <button type="button" class="mv-big" data-pos="edit"><b>SAISIR</b><span>MGRS ou « latitude, longitude »</span></button>
        </div>`;
      },
      bind: (r) => {
        const msg = r.querySelector('#mv-pos-msg');
        r.querySelector('[data-pos="gps"]').onclick = () => {
          if (!navigator.geolocation) { msg.textContent = 'Localisation indisponible sur cet appareil.'; return; }
          msg.textContent = 'Recherche de la position...';
          navigator.geolocation.getCurrentPosition(
            (g) => { obj[key] = { lat: g.coords.latitude, lon: g.coords.longitude, acc: g.coords.accuracy, src: 'gps' }; refresh(); },
            (e) => { msg.textContent = 'Position GPS impossible : ' + (e.code === 1 ? 'autorisation refusée.' : 'pas de signal, réessayez à découvert.'); },
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
        };
        const stBtn = r.querySelector('[data-pos="station"]');
        if (stBtn) stBtn.onclick = () => { obj[key] = { ...M.parsePosition(opts.getStation().pos), src: 'station' }; refresh(); };
        r.querySelector('[data-pos="edit"]').onclick = () => {
          const box = el(`<div class="mv-edit"><input type="text" id="mv-pos-input" autocapitalize="characters" spellcheck="false" placeholder="31U DQ 4825 1193"><button type="button" class="mv-navbtn mv-next">OK</button></div>`);
          r.querySelector('.mv-pos').appendChild(box);
          const input = box.querySelector('input');
          input.focus();
          box.querySelector('button').onclick = () => {
            const v = M.parsePosition(input.value);
            if (!v) { msg.textContent = 'Position non reconnue : MGRS (31U DQ 4825 1193) ou degrés (48.8584, 2.2945).'; return; }
            obj[key] = { ...v, src: 'saisie' };
            refresh();
          };
        };
      },
    };
  }

  /** Fréquence en kHz dans obj[key] (0 = non précisée). */
  function freqWidget(obj, key) {
    return {
      body: () => `<div class="mv-freq"><input type="text" id="mv-freq" inputmode="decimal" value="${obj[key] ? (obj[key] / 1000).toFixed(3) : ''}" placeholder="145.500"><span>MHz</span></div>
        <p class="mv-hint" id="mv-freq-sent"></p>
        <p class="mv-hint">Réglable une fois pour toutes dans les paramètres (fréquence de contact). Vide : non précisée. Transmise au kHz près jusqu'à 30 MHz, au pas de 5 kHz au-dessus.</p>`,
      bind: (r) => {
        const i = r.querySelector('#mv-freq');
        const hint = r.querySelector('#mv-freq-sent');
        const show = () => {
          const sent = M.roundFreq(obj[key]);
          hint.textContent = obj[key] && sent !== obj[key] ? 'Sera transmise : ' + M.formatFreq(sent) : '';
        };
        i.oninput = () => {
          const f = parseFloat(i.value.replace(',', '.'));
          obj[key] = Number.isFinite(f) && f > 0 && f < 1000 ? Math.round(f * 1000) : 0;
          show();
        };
        show();
      },
    };
  }

  // --- Étapes du 9-line ---

  function nineSteps() {
    const n = st.nine;
    const p = (k) => `Ligne ${k}/9`;
    return [
      {
        progress: 'Contexte', title: 'Temps de guerre ou de paix ?',
        sub: 'Change le contenu des lignes 6 et 9',
        body: () => choices([{ code: 'GUERRE', label: '6 : sécurité · 9 : NRBC' }, { code: 'PAIX', label: '6 : blessures · 9 : terrain' }],
          (i) => (i === 1) === n.peace, { cols: 1 }),
        bind: (r) => bindChoices(r, 'i', (i) => {
          n.peace = i === 1;
          opts.savePeace(n.peace);
          steps.splice(0, steps.length, ...nineSteps()); // lignes 6 et 9 changent
        }, true),
      },
      { progress: p(1), title: 'Position du point de récupération', ...positionWidget(n, 'pos'), valid: () => !!n.pos },
      { progress: p(2), title: 'Fréquence de contact', sub: 'Indicatif : ' + opts.callLabel(opts.getCall()), ...freqWidget(n, 'freqKHz') },
      {
        progress: p(3), title: 'Blessés par urgence',
        body: () => M.PRECEDENCE.map((x, i) => counter('c' + i, `${x.code} · ${x.label}`, n.counts[i])).join(''),
        bind: (r) => bindCounters(r, (id) => n.counts[+id.slice(1)], (id, d) => {
          const i = +id.slice(1);
          n.counts[i] = Math.max(0, Math.min(M.MAX_COUNT, n.counts[i] + +d));
        }),
        valid: () => n.counts.some((c) => c > 0),
      },
      {
        progress: p(4), title: 'Matériel spécial',
        body: () => `<div class="mv-grid mv-grid-2"><button type="button" class="mv-big${n.equip.length ? '' : ' on'}" data-none="1"><b>A</b><span>Aucun</span></button></div>`
          + choices(M.EQUIPMENT, (i) => n.equip.includes(i)),
        bind: (r) => {
          r.querySelector('[data-none]').onclick = () => { n.equip = []; refresh(); };
          bindChoices(r, 'i', (i) => { n.equip = toggle(n.equip, i); });
        },
      },
      {
        progress: p(5), title: 'Couchés et assis',
        sub: () => `Total des blessés (ligne 3) : ${n.counts.reduce((a, b) => a + b, 0)}`,
        body: () => {
          const total = n.counts.reduce((a, b) => a + b, 0);
          n.litter = Math.min(n.litter, total);
          return counter('litter', 'L · Couchés (brancard)', n.litter)
            + `<div class="mv-counter"><span class="mv-counter-label">A · Assis (valides) : le reste</span><div class="mv-counter-row"><output>${total - n.litter}</output></div></div>`;
        },
        bind: (r) => bindCounters(r, (id) => n[id], (id, d) => {
          n.litter = Math.max(0, Math.min(n.counts.reduce((a, b) => a + b, 0), n.litter + +d));
        }),
      },
      n.peace ? {
        progress: p(6), title: 'Blessures', sub: 'Plusieurs choix possibles',
        body: () => choices(M.WOUNDS, (i) => n.wounds.includes(i)),
        bind: (r) => bindChoices(r, 'i', (i) => { n.wounds = toggle(n.wounds, i); }),
      } : {
        progress: p(6), title: 'Sécurité du point',
        body: () => choices(M.SECURITY, (i) => n.security === i, { cols: 1 }),
        bind: (r) => bindChoices(r, 'i', (i) => { n.security = i; }, true),
        valid: () => n.security !== null,
      },
      {
        progress: p(7), title: 'Balisage du point',
        body: () => choices(M.MARKING, (i) => n.marking === i),
        bind: (r) => bindChoices(r, 'i', (i) => { n.marking = i; }, true),
        valid: () => n.marking !== null,
      },
      {
        progress: p(8), title: 'Nationalité et statut', sub: 'Plusieurs choix possibles',
        body: () => choices(M.NATIONALITY, (i) => n.nation.includes(i), { cols: 1 }),
        bind: (r) => bindChoices(r, 'i', (i) => { n.nation = toggle(n.nation, i); }),
        valid: () => n.nation.length > 0,
      },
      n.peace ? {
        progress: p(9), title: 'Terrain du point', sub: 'Plusieurs choix possibles',
        body: () => choices(M.TERRAIN, (i) => n.terrain.includes(i)),
        bind: (r) => bindChoices(r, 'i', (i) => { n.terrain = toggle(n.terrain, i); }),
      } : {
        progress: p(9), title: 'Contamination NRBC',
        body: () => `<div class="mv-grid mv-grid-2"><button type="button" class="mv-big${n.nbc.length ? '' : ' on'}" data-none="1"><b>&mdash;</b><span>Aucune</span></button></div>`
          + choices(M.NBC, (i) => n.nbc.includes(i)),
        bind: (r) => {
          r.querySelector('[data-none]').onclick = () => { n.nbc = []; refresh(); };
          bindChoices(r, 'i', (i) => { n.nbc = toggle(n.nbc, i); });
        },
      },
      recapStep(),
    ];
  }

  // --- Étapes d'une fiche MIST ---

  function mistSteps(idx) {
    const pt = st.mist[idx];
    const p = (k) => `MIST · blessé ${pt.patient} · ${k}/7`;
    return [
      {
        progress: p(1), title: 'Blessé et urgence',
        body: () => counter('patient', 'Numéro du blessé', pt.patient) + choices(M.PRECEDENCE, (i) => pt.prec === i, { cols: 1 }),
        bind: (r) => {
          bindCounters(r, () => pt.patient, (id, d) => { pt.patient = Math.max(1, Math.min(16, pt.patient + +d)); });
          bindChoices(r, 'i', (i) => { pt.prec = i; });
        },
      },
      {
        progress: p(2), title: 'AT · Âge, sexe, hémorragie', sub: 'Facultatif (bilan victime, AT-MIST) : laisser « ? » garde le message plus court',
        body: () => counter('age', 'Âge', pt.age === null || pt.age === undefined ? null : pt.age, { unknown: true, step: 5, unit: 'ans' })
          + `<h3 class="mv-family">Sexe</h3>` + choices(M.SEX, (i) => pt.sex === i, { key: 'sx' })
          + `<h3 class="mv-family">Hémorragie</h3>` + choices(M.HEMO, (i) => pt.hemo === i, { key: 'hm', cols: 1 }),
        bind: (r) => {
          bindCounters(r, () => pt.age, (id, d) => {
            if (d === null) { pt.age = null; return; }
            pt.age = pt.age === null || pt.age === undefined ? 30 : Math.max(0, Math.min(100, pt.age + +d));
          });
          bindChoices(r, 'sx', (i) => { pt.sex = pt.sex === i ? null : i; });
          bindChoices(r, 'hm', (i) => { pt.hemo = pt.hemo === i ? null : i; });
        },
      },
      {
        progress: p(3), title: 'M · Mécanisme',
        sub: 'Heure de la blessure en UTC (Z)',
        body: () => `<div class="mv-time">${counter('time', 'Heure de la blessure (UTC)', pt.time ? `${String(pt.time.h).padStart(2, '0')}:${String(pt.time.m).padStart(2, '0')}` : null, { unknown: true, step: 5 })}</div>`
          + choices(M.MECHANISM, (i) => pt.mech === i),
        bind: (r) => {
          bindCounters(r, () => pt.time, (id, d) => {
            if (d === null) { pt.time = null; return; }
            const now = new Date();
            const base = pt.time ? pt.time.h * 60 + pt.time.m : now.getUTCHours() * 60 + Math.floor(now.getUTCMinutes() / 5) * 5;
            const t = ((base + +d) % 1440 + 1440) % 1440;
            pt.time = { h: Math.floor(t / 60), m: t % 60 };
          });
          bindChoices(r, 'i', (i) => { pt.mech = i; });
        },
        valid: () => pt.mech !== null,
      },
      {
        progress: p(4), title: 'I · Zones blessées', sub: 'Plusieurs choix possibles',
        body: () => choices(M.REGIONS, (i) => pt.regions.includes(i)),
        bind: (r) => bindChoices(r, 'i', (i) => { pt.regions = toggle(pt.regions, i); }),
      },
      {
        progress: p(5), title: 'S · Conscience (AVPU)',
        body: () => choices(M.AVPU, (i) => pt.avpu === i, { cols: 1 }),
        bind: (r) => bindChoices(r, 'i', (i) => { pt.avpu = pt.avpu === i ? null : i; }, true),
      },
      {
        progress: p(6), title: 'S · Signes vitaux', sub: '« ? » : non mesuré',
        body: () => counter('pulse', 'Pouls', pt.pulse, { unknown: true, step: 5, unit: '/min' })
          + counter('resp', 'Respiration', pt.resp, { unknown: true, step: 2, unit: '/min' })
          + counter('spo2', 'Saturation SpO2', pt.spo2, { unknown: true, step: 1, unit: '%' }),
        bind: (r) => bindCounters(r, (id) => pt[id], (id, d) => {
          const lim = { pulse: [0, 250, 80], resp: [0, 60, 16], spo2: [50, 100, 95] }[id];
          if (d === null) { pt[id] = null; return; }
          pt[id] = pt[id] === null ? lim[2] : Math.max(lim[0], Math.min(lim[1], pt[id] + +d));
        }),
      },
      {
        progress: p(7), title: 'T · Soins effectués', sub: 'Plusieurs choix possibles',
        body: () => choices(M.TREATMENT, (i) => pt.treat.includes(i)),
        bind: (r) => bindChoices(r, 'i', (i) => { pt.treat = toggle(pt.treat, i); }),
      },
      recapStep(),
    ];
  }

  // --- Formats déclarés par leurs champs (medevac.js) : un écran par champ ou groupe ---

  const nowUtc = () => {
    const d = new Date();
    return { d: d.getUTCDate(), h: d.getUTCHours(), m: Math.floor(d.getUTCMinutes() / 5) * 5 };
  };
  const hhmm = (t) => (t ? `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}` : null);

  function newData(fmt) {
    const station = opts.getStation();
    const pos = M.parsePosition(station.pos);
    const freq = parseFloat(String(station.freq || '').replace(',', '.'));
    const data = {};
    for (const f of fmt.fields) {
      data[f.key] = {
        choice: null, multi: [], count: 0, number: null, grid: f.items ? f.items.map(() => 0) : [],
        position: pos ? { ...pos, src: 'station' } : null,
        time: (() => { const t = nowUtc(); return { h: t.h, m: t.m }; })(), dtg: nowUtc(),
        freq: Number.isFinite(freq) && freq > 0 ? Math.round(freq * 1000) : 0,
      }[f.type];
    }
    return data;
  }

  const fieldValid = (f, v) => (f.type === 'choice' && !f.optional ? v !== null : f.type === 'position' ? !!v : true);
  const shortTag = (f) => (f.tag && f.tag.length <= 2 ? f.tag + ' · ' : '');

  function widgetBody(f, data, solo) {
    const v = data[f.key];
    const head = solo ? '' : `<h3 class="mv-family">${esc(f.label)}</h3>`;
    switch (f.type) {
      case 'choice': return head + choices(f.options, (i) => v === i, { key: f.key, cols: f.options.length > 4 ? 2 : 1 });
      case 'multi': return head + (f.none ? `<div class="mv-grid mv-grid-1"><button type="button" class="mv-big${v.length ? '' : ' on'}" data-none="${f.key}"><b>&mdash;</b><span>${esc(f.none)}</span></button></div>` : '')
        + choices(f.options, (i) => v.includes(i), { key: f.key });
      case 'count': return counter(f.key, f.label, v);
      case 'number': return counter(f.key, f.label, v, { unknown: true, step: f.step, unit: f.unit || '' });
      case 'time': return counter(f.key, f.label, hhmm(v), { unknown: true, step: 5 });
      case 'dtg': return counter(f.key + '-d', 'Jour du mois', v ? v.d : null, { unknown: true })
        + counter(f.key + '-t', 'Heure (UTC)', v ? hhmm(v) : null, { step: 5 });
      case 'grid': return f.items.map((it, i) => `<div class="mv-gridrow"><span>${esc(it)}</span><div class="mv-states">${f.states.map((s2, j) =>
        `<button type="button" class="mv-state st-${j}${v[i] === j ? ' on' : ''}" data-gr="${f.key}:${i}:${j}">${esc(s2.label)}</button>`).join('')}</div></div>`).join('');
      default: return '';
    }
  }

  function genericSteps(fmt) {
    const data = st.data;
    const groups = [];
    for (const f of fmt.fields) {
      const id = f.group || f.key;
      let g = groups.find((x) => x.id === id);
      if (!g) groups.push(g = { id, fields: [] });
      g.fields.push(f);
    }
    return groups.map((g, gi) => {
      const f0 = g.fields[0];
      const solo = g.fields.length === 1;
      const progress = `${fmt.title} · ${gi + 1}/${groups.length}`;
      if (solo && f0.type === 'position') {
        return { progress, title: shortTag(f0) + f0.label, ...positionWidget(data, f0.key, f0.precision === 3 ? 'Transmise à 100 m près' : ''), valid: () => !!data[f0.key] };
      }
      if (solo && f0.type === 'freq') return { progress, title: shortTag(f0) + f0.label, ...freqWidget(data, f0.key) };
      return {
        progress, title: shortTag(f0) + (f0.groupTitle || f0.label),
        sub: f0.type === 'multi' ? 'Plusieurs choix possibles' : '',
        body: () => g.fields.map((f, k) => widgetBody(f, data, k === 0)).join(''),
        bind: (r) => {
          const counters = {};
          for (const f of g.fields) {
            if (f.type === 'choice') bindChoices(r, f.key, (i) => { data[f.key] = f.optional && data[f.key] === i ? null : i; }, solo);
            if (f.type === 'multi') {
              bindChoices(r, f.key, (i) => { data[f.key] = toggle(data[f.key], i); });
              const none = r.querySelector(`[data-none="${f.key}"]`);
              if (none) none.onclick = () => { data[f.key] = []; refresh(); };
            }
            if (f.type === 'count') counters[f.key] = (d) => { data[f.key] = Math.max(0, Math.min(f.max, data[f.key] + +d)); };
            if (f.type === 'number') counters[f.key] = (d) => {
              if (d === null) { data[f.key] = null; return; }
              const cur = data[f.key];
              data[f.key] = cur === null ? (f.def !== undefined ? f.def : f.min) : Math.max(f.min, Math.min(f.max, cur + +d));
            };
            if (f.type === 'time') counters[f.key] = (d) => {
              if (d === null) { data[f.key] = null; return; }
              const t0 = data[f.key] || nowUtc();
              const t = ((t0.h * 60 + t0.m + +d) % 1440 + 1440) % 1440;
              data[f.key] = { h: Math.floor(t / 60), m: t % 60 };
            };
            if (f.type === 'dtg') {
              counters[f.key + '-d'] = (d) => {
                if (d === null) { data[f.key] = null; return; }
                const v = data[f.key] || nowUtc();
                data[f.key] = { ...v, d: ((v.d - 1 + +d) % 31 + 31) % 31 + 1 };
              };
              counters[f.key + '-t'] = (d) => {
                const v = data[f.key] || nowUtc();
                const t = ((v.h * 60 + v.m + +d) % 1440 + 1440) % 1440;
                data[f.key] = { ...v, h: Math.floor(t / 60), m: t % 60 };
              };
            }
            if (f.type === 'grid') r.querySelectorAll(`[data-gr^="${f.key}:"]`).forEach((b) => {
              b.onclick = () => { const [, i, j] = b.dataset.gr.split(':'); data[f.key][+i] = +j; refresh(); };
            });
          }
          bindCounters(r, () => null, (id, d) => { if (counters[id]) counters[id](d); });
        },
        valid: () => g.fields.every((f) => fieldValid(f, data[f.key])),
      };
    }).concat([recapStep()]);
  }

  // --- Récapitulatif et envoi ---

  function currentMessage() {
    if (st.fmt) return { fmt: st.fmt, data: st.data, remark: st.remark };
    const n = st.nine;
    return {
      nine: n ? { ...n, lat: n.pos.lat, lon: n.pos.lon, security: n.security || 0, marking: n.marking || 0 } : null,
      mist: st.mist.map((p) => ({ ...p, mech: p.mech || 0 })),
      remark: st.remark,
    };
  }

  function sizeText(onAir) {
    const blocks = Math.ceil(onAir / 13);
    return `${onAir} caractères · ${blocks} bloc${blocks > 1 ? 's' : ''} · environ ${Math.round(blocks * 11.5 + 1)} s · `
      + `${13 * blocks - onAir} car. libres avant un bloc de plus · accusé de réception et collationnement par le destinataire`;
  }

  function recapStep() {
    return {
      recap: true, nav: true, progress: 'Vérification', title: 'Vérifier et envoyer', nextLabel: 'Envoyer',
      body: () => {
        const body = M.encode(currentMessage());
        const dec = M.decode(body);
        const call = opts.getCall();
        const onAir = call.length + st.to.length + body.length;
        const blocks = Math.ceil(onAir / 13);
        const at = st.mist.some(M.isAtMist);
        const max = st.fmt ? 0 : at ? (st.nine ? M.MAX_ATMIST_WITH_NINE : M.MAX_ATMIST) : (st.nine ? M.MAX_MIST_WITH_NINE : M.MAX_MIST);
        const fmt = st.fmt && M.FORMATS[st.fmt];
        const room = Math.min(128, fmt && fmt.textMax ? onAir - st.remark.length + fmt.textMax : 128) - onAir;
        return `<p class="mv-fmto">FM ${esc(opts.callLabel(call))} TO ${esc(opts.callLabel(st.to))}</p>
          ${linesHtml(dec, call)}
          <div class="mv-grid mv-grid-1">
            ${st.mist.length < max ? `<button type="button" class="mv-big" data-act="addmist"><b>+ MIST</b><span>Ajouter une fiche blessé (${st.mist.length}/${max})</span></button>` : ''}
          </div>
          <label class="mv-remark">${fmt && fmt.textMax ? 'Précision en texte libre' : 'Remarque'} (facultative, ${room} car. au plus : le plus court sans)
            <input type="text" id="mv-remark" maxlength="${Math.max(0, room + st.remark.length)}" value="${esc(st.remark)}" autocapitalize="characters" placeholder="LZ AU NORD DU PONT">
          </label>
          <p class="mv-hint" id="mv-size">${sizeText(onAir)}</p>`;
      },
      bind: (r) => {
        const add = r.querySelector('[data-act="addmist"]');
        if (add) add.onclick = () => {
          const used = st.mist.map((p) => p.patient);
          let num = 1;
          while (used.includes(num)) num++;
          st.mist.push(newPatient(num));
          startSteps(mistSteps(st.mist.length - 1), () => {
            st.mist.pop(); // fiche abandonnée
            startSteps([recapStep()], () => {});
          });
        };
        const rem = r.querySelector('#mv-remark');
        const hint = r.querySelector('#mv-size');
        rem.oninput = () => {
          st.remark = M.normalizeRemark(rem.value);
          hint.textContent = sizeText(opts.getCall().length + st.to.length + M.encode(currentMessage()).length);
        };
        const next = overlay.querySelector('[data-act="next"]');
        next.classList.add('mv-send');
        next.onclick = () => {
          const body = M.encode(currentMessage());
          closeOverlay();
          opts.send(body, st.to);
        };
      },
    };
  }

  // ============================================================
  // AFFICHAGE
  // ============================================================

  /** @param {boolean} [compact] bulle du fil : le code seul quand il existe, sans libellé */
  function linesHtml(msg, call, compact) {
    let lastHead = null;
    return `<div class="mv-lines">${M.lines(msg, opts.callLabel(call)).map((l) => {
      let head = '';
      if (l.mist && l.head && l.head !== lastHead) {
        lastHead = l.head;
        head = `<div class="mv-line-head">${esc(l.head)}</div>`;
      }
      const num = l.n ? l.n : l.label;
      const code = l.code ? `<b>${esc(l.code)}</b>` : '';
      const text = compact && l.code ? '' : (code ? ' ' : '') + esc(l.text);
      const label = l.n && !compact ? `<small>${esc(l.label)}</small>` : '';
      return `${head}<div class="mv-line${l.mist ? ' mist' : ''}${l.n ? '' : l.mist ? '' : ' remark'}"><span class="mv-n">${esc(num)}</span>`
        + `<span class="mv-t">${label}${code}${text}</span></div>`;
    }).join('')}</div>`;
  }

  /**
   * Remplit la bulle si le message est formaté. Renvoie false sinon (texte simple).
   * @param {HTMLElement} textEl  .msg-text de la bulle
   * @param {object} info  {call, time, readback: {by, ok, lines}}
   */
  function renderCard(textEl, body, info) {
    const dec = M.decode(body);
    if (!dec) return false;
    const title = (dec.readback ? 'COLLATIONNEMENT · ' : '') + dec.kind;
    const rb = info.readback;
    const rbHtml = rb ? `<div class="mv-rb ${rb.ok ? 'ok' : 'ko'}">${rb.ok
      ? '&#10003; Collationné conforme par ' + esc(opts.callLabel(rb.by))
      : '&#9888; Collationnement de ' + esc(opts.callLabel(rb.by)) + ' non conforme : ' + esc(rb.lines.join(', '))}</div>` : '';
    textEl.innerHTML = `<div class="mv-card${dec.readback ? ' readback' : ''}">
      <div class="mv-card-title">${esc(title)}</div>
      ${linesHtml(dec, info.call, true)}
      ${rbHtml}
      <button type="button" class="mv-open">Plein écran &#8599;</button>
    </div>`;
    textEl.querySelector('.mv-open').onclick = () => openViewer(body, info);
    return true;
  }

  let wakeLock = null;

  function openViewer(body, info) {
    const dec = M.decode(body);
    if (!dec) return;
    const text = M.toText(dec, opts.callLabel(info.call), info.time);
    const title = (dec.readback ? 'COLLATIONNEMENT · ' : '') + dec.kind;
    closeViewer();
    const v = el(`<div class="mv-viewer" role="dialog" aria-modal="true">
      <div class="mv-viewer-head">
        <div><h2>${esc(title)}</h2><p>de ${esc(opts.callLabel(info.call) || '?')}${info.time ? ' · ' + esc(info.time) : ''}</p></div>
        <button type="button" class="mv-x" data-act="close" aria-label="Fermer">&times;</button>
      </div>
      <div class="mv-viewer-body">${linesHtml(dec, info.call)}<div class="mv-qr" hidden></div></div>
      <div class="mv-viewer-actions">
        <button type="button" data-act="share">Partager</button>
        <button type="button" data-act="qr">QR code</button>
        <button type="button" data-act="print">Imprimer</button>
      </div>
    </div>`);
    document.body.appendChild(v);
    v.querySelector('[data-act="close"]').onclick = closeViewer;
    v.querySelector('[data-act="share"]').onclick = () => shareText(title, text);
    v.querySelector('[data-act="qr"]').onclick = () => {
      const box = v.querySelector('.mv-qr');
      if (box.hidden) {
        box.innerHTML = qrSvg(text) + '<p>Scanner pour récupérer le message en clair</p>';
        box.hidden = false;
        box.scrollIntoView({ behavior: 'smooth' });
      } else box.hidden = true;
    };
    const print = v.querySelector('[data-act="print"]');
    if (opts.isNative) print.textContent = 'Imprimer (via partage)';
    print.onclick = () => {
      if (opts.isNative) { shareText(title, text); return; } // pas d'impression dans la WebView Android
      document.body.classList.add('mv-printing');
      window.print();
      setTimeout(() => document.body.classList.remove('mv-printing'), 500);
    };
    // Écran allumé pendant la lecture à voix haute
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  }

  function closeViewer() {
    const v = document.querySelector('.mv-viewer');
    if (v) v.remove();
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  function qrSvg(text) {
    if (!window.qrcode) return '<p>QR code indisponible</p>';
    window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
    const qr = window.qrcode(0, 'L'); // L : modules plus gros, plus facile à scanner sur écran
    qr.addData(text, 'Byte');
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }

  async function shareText(title, text) {
    try {
      if (opts.share && await opts.share(title, text)) return;
      if (navigator.share) {
        await navigator.share({ title, text });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // partage annulé par l'utilisateur
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Message copié : collez-le dans SMS, mail...');
    } catch (e) {
      toast('Partage impossible sur cet appareil');
    }
  }

  function toast(msg) {
    const t = el(`<div class="mv-toast">${esc(msg)}</div>`);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  window.MedevacUI = { init, openChooser, openNine, renderCard, openViewer, pickStation };
})();
