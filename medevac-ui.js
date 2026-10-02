/**
 * Interface des messages formatés (9-line MEDEVAC, MIST) : saisie pas à pas
 * avec de très gros boutons, carte dans le fil de discussion, affichage plein
 * écran, partage, QR code, impression. Le codage est dans medevac.js.
 *
 * MedevacUI.init({ getCall, callLabel, getStation, savePeace, send, isNative, share })
 *   getCall()      indicatif court de la station (ligne 2)
 *   callLabel(c)   indicatif affiché (annuaire : court → long)
 *   getStation()   {pos: texte saisi dans les paramètres, freq: MHz, peace: bool}
 *   savePeace(b)   mémorise le dernier choix guerre/paix
 *   send(body)     émet le corps du message (étendu, accusé forcé) ; Promise
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
      mech: null, regions: [], avpu: null, pulse: null, resp: null, spo2: null, treat: [] };
  }

  /** Point d'entrée du bouton MEDEVAC : choix 9-line ou MIST seul. */
  function openChooser() {
    if (!opts.getCall()) {
      opts.askCall();
      return;
    }
    st = { nine: null, mist: [], remark: '' };
    showOverlay();
    renderFrame({
      title: 'Message formaté',
      sub: 'Envoyé en une fois, avec accusé de réception et relecture',
      body: `<div class="mv-grid mv-grid-1">
        <button type="button" class="mv-big mv-red" data-act="nine"><b>9-LINE</b><span>Demande d'évacuation sanitaire</span></button>
        <button type="button" class="mv-big" data-act="mist"><b>MIST</b><span>Fiche blessé seule</span></button>
      </div>`,
      nav: false,
    });
    overlay.querySelector('[data-act="nine"]').onclick = () => { st.nine = newNine(); startSteps(nineSteps()); };
    overlay.querySelector('[data-act="mist"]').onclick = () => { st.mist.push(newPatient(1)); startSteps(mistSteps(0)); };
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
    steps.onBackAtStart = onBackAtStart || openChooser;
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
      {
        progress: p(1), title: 'Position du point de récupération',
        body: () => {
          const mgrs = n.pos ? M.toMgrs(n.pos.lat, n.pos.lon) : null;
          const station = M.parsePosition(opts.getStation().pos);
          return `<div class="mv-pos">
            <div class="mv-pos-value">${n.pos ? esc(mgrs || '') : 'Aucune position'}</div>
            <div class="mv-pos-sub">${n.pos ? esc(M.formatLatLon(n.pos.lat, n.pos.lon)) + ' · ' + esc(n.pos.src === 'gps' ? `GPS ±${Math.round(n.pos.acc || 0)} m` : n.pos.src === 'station' ? 'position de la station' : 'saisie') : ''}</div>
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
              (g) => { n.pos = { lat: g.coords.latitude, lon: g.coords.longitude, acc: g.coords.accuracy, src: 'gps' }; refresh(); },
              (e) => { msg.textContent = 'Position GPS impossible : ' + (e.code === 1 ? 'autorisation refusée.' : 'pas de signal, réessayez à découvert.'); },
              { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
          };
          const stBtn = r.querySelector('[data-pos="station"]');
          if (stBtn) stBtn.onclick = () => { n.pos = { ...M.parsePosition(opts.getStation().pos), src: 'station' }; refresh(); };
          r.querySelector('[data-pos="edit"]').onclick = () => {
            const box = el(`<div class="mv-edit"><input type="text" id="mv-pos-input" autocapitalize="characters" spellcheck="false" placeholder="31U DQ 4825 1193"><button type="button" class="mv-navbtn mv-next">OK</button></div>`);
            r.querySelector('.mv-pos').appendChild(box);
            const input = box.querySelector('input');
            input.focus();
            box.querySelector('button').onclick = () => {
              const v = M.parsePosition(input.value);
              if (!v) { msg.textContent = 'Position non reconnue : MGRS (31U DQ 4825 1193) ou degrés (48.8584, 2.2945).'; return; }
              n.pos = { ...v, src: 'saisie' };
              refresh();
            };
          };
        },
        valid: () => !!n.pos,
      },
      {
        progress: p(2), title: 'Fréquence de contact',
        sub: 'Indicatif : ' + opts.callLabel(opts.getCall()),
        body: () => `<div class="mv-freq"><input type="text" id="mv-freq" inputmode="decimal" value="${n.freqKHz ? (n.freqKHz / 1000).toFixed(3) : ''}" placeholder="145.500"><span>MHz</span></div>
          <p class="mv-hint">Réglable une fois pour toutes dans les paramètres (fréquence de contact). Vide : non précisée.</p>`,
        bind: (r) => {
          const i = r.querySelector('#mv-freq');
          i.oninput = () => {
            const f = parseFloat(i.value.replace(',', '.'));
            n.freqKHz = Number.isFinite(f) && f > 0 && f < 1000 ? Math.round(f * 1000) : 0;
          };
        },
      },
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
        sub: () => `Total des blessés : ${n.counts.reduce((a, b) => a + b, 0)}`,
        body: () => counter('litter', 'L · Couchés (brancard)', n.litter) + counter('ambul', 'A · Assis (valides)', n.ambul),
        bind: (r) => bindCounters(r, (id) => n[id], (id, d) => { n[id] = Math.max(0, Math.min(M.MAX_LA, n[id] + +d)); }),
        valid: () => n.litter + n.ambul > 0,
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
    const p = (k) => `MIST · blessé ${pt.patient} · ${k}/6`;
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
        progress: p(2), title: 'M · Mécanisme',
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
        progress: p(3), title: 'I · Zones blessées', sub: 'Plusieurs choix possibles',
        body: () => choices(M.REGIONS, (i) => pt.regions.includes(i)),
        bind: (r) => bindChoices(r, 'i', (i) => { pt.regions = toggle(pt.regions, i); }),
      },
      {
        progress: p(4), title: 'S · Conscience (AVPU)',
        body: () => choices(M.AVPU, (i) => pt.avpu === i, { cols: 1 }),
        bind: (r) => bindChoices(r, 'i', (i) => { pt.avpu = pt.avpu === i ? null : i; }, true),
      },
      {
        progress: p(5), title: 'S · Signes vitaux', sub: '« ? » : non mesuré',
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
        progress: p(6), title: 'T · Soins effectués', sub: 'Plusieurs choix possibles',
        body: () => choices(M.TREATMENT, (i) => pt.treat.includes(i)),
        bind: (r) => bindChoices(r, 'i', (i) => { pt.treat = toggle(pt.treat, i); }),
      },
      recapStep(),
    ];
  }

  // --- Récapitulatif et envoi ---

  function currentMessage() {
    const n = st.nine;
    return {
      nine: n ? { ...n, lat: n.pos.lat, lon: n.pos.lon, security: n.security || 0, marking: n.marking || 0 } : null,
      mist: st.mist.map((p) => ({ ...p, mech: p.mech || 0 })),
      remark: st.remark,
    };
  }

  function recapStep() {
    return {
      recap: true, nav: true, progress: 'Vérification', title: 'Vérifier et envoyer', nextLabel: 'Envoyer',
      body: () => {
        const body = M.encode(currentMessage());
        const dec = M.decode(body);
        const call = opts.getCall();
        const onAir = call.length + body.length;
        const blocks = Math.ceil(onAir / 13);
        const max = st.nine ? M.MAX_MIST_WITH_NINE : M.MAX_MIST;
        const room = 128 - onAir;
        return `${linesHtml(dec, call)}
          <div class="mv-grid mv-grid-1">
            ${st.mist.length < max ? `<button type="button" class="mv-big" data-act="addmist"><b>+ MIST</b><span>Ajouter une fiche blessé (${st.mist.length}/${max})</span></button>` : ''}
          </div>
          <label class="mv-remark">Remarque (facultative, ${room} car. restants)
            <input type="text" id="mv-remark" maxlength="${Math.max(0, room + st.remark.length)}" value="${esc(st.remark)}" autocapitalize="characters" placeholder="LZ AU NORD DU PONT">
          </label>
          <p class="mv-hint">${onAir} caractères · ${blocks} bloc${blocks > 1 ? 's' : ''} · environ ${Math.round(blocks * 11.5 + 1)} s · accusé de réception et relecture par le destinataire</p>`;
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
        rem.oninput = () => { st.remark = M.normalizeRemark(rem.value); };
        const next = overlay.querySelector('[data-act="next"]');
        next.classList.add('mv-send');
        next.onclick = () => {
          const body = M.encode(currentMessage());
          closeOverlay();
          opts.send(body);
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
    const title = (dec.readback ? 'RELECTURE · ' : '') + (dec.nine ? '9-LINE MEDEVAC' : 'MIST');
    const rb = info.readback;
    const rbHtml = rb ? `<div class="mv-rb ${rb.ok ? 'ok' : 'ko'}">${rb.ok
      ? '&#10003; Relu conforme par ' + esc(opts.callLabel(rb.by))
      : '&#9888; Relecture de ' + esc(opts.callLabel(rb.by)) + ' différente : ' + esc(rb.lines.join(', '))}</div>` : '';
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
    const title = (dec.readback ? 'RELECTURE · ' : '') + (dec.nine ? '9-LINE MEDEVAC' : 'MIST');
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

  window.MedevacUI = { init, openChooser, renderCard, openViewer };
})();
