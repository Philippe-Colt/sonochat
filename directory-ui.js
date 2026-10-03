/**
 * Outil de création d'annuaire (paramètres → Annuaire → Créer / modifier) : liste des
 * stations à gros boutons, fiche par station (indicatifs, type, échelon, canal, créneau),
 * attribution automatique des canaux et créneaux, contrôles, puis diffusion à toutes les
 * stations : enregistrer ici, partager le fichier, QR code (lien lu par l'appareil photo de
 * n'importe quel téléphone), importer par collage ou scan. Le format est dans directory.js.
 *
 * DirectoryUI.init({ current, apply, share, isNative })
 *   current()      annuaire en service {map, units, channels, net}
 *   apply(text, label) applique un fichier d'annuaire ; renvoie le compte rendu (null : refusé)
 *   share(title, text) partage natif (application) ou null
 */
(function () {
  'use strict';
  let opts = null;
  let overlay = null;
  let entries = [];     // [{short, long, type?, echelon?, freq?, slot?}]
  let net = null;
  let dirty = false;
  let scanStop = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const today = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  function init(o) { opts = o; }

  function open() {
    const cur = opts.current();
    entries = toEntries(cur);
    net = Object.assign({}, NET_DEFAULTS, cur.net || {});
    dirty = false;
    if (!overlay) {
      overlay = el('<div class="mv-overlay dir-tool" role="dialog" aria-modal="true"></div>');
      document.body.appendChild(overlay);
    }
    renderList();
  }

  function close() {
    stopScan();
    if (overlay) overlay.remove();
    overlay = null;
  }

  function frame({ title, sub, body, back }) {
    stopScan();
    overlay.innerHTML = `
      <div class="mv-head">
        <button type="button" class="mv-x" data-act="close" aria-label="Fermer">&times;</button>
        <div class="mv-titles"><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
      </div>
      <div class="mv-body">${body}</div>
      ${back ? '<div class="mv-nav"><button type="button" class="mv-navbtn" data-act="back">&larr; Retour</button></div>' : ''}`;
    overlay.querySelector('[data-act="close"]').onclick = () => {
      if (dirty && !confirm('Quitter sans enregistrer les modifications ?')) return;
      close();
    };
    const b = overlay.querySelector('[data-act="back"]');
    if (b) b.onclick = back;
    overlay.querySelector('.mv-body').scrollTop = 0;
  }

  const on = (sel, fn) => { const x = overlay.querySelector(sel); if (x) x.onclick = fn; };

  /** Incohérences de la liste en cours. */
  function problems() {
    const ch = {};
    entries.forEach((e) => { ch[e.short] = { freq: e.freq, slot: e.slot }; });
    const out = checkChannels(ch);
    entries.forEach((e) => {
      if (e.freq && (e.freq < net.bandMin || e.freq > net.bandMax)) out.push(e.short + ' : canal ' + e.freq + ' Hz hors de la bande ' + net.bandMin + '-' + net.bandMax);
    });
    const missing = entries.filter((e) => !e.freq || !e.slot).map((e) => e.short);
    if (missing.length) out.push('sans canal ou créneau : ' + missing.join(', ') + ' (ATTRIBUER complète)');
    return out;
  }

  function roundOf() { return entries.reduce((m, e) => Math.max(m, e.slot || 0), 0); }

  function unitText(e) {
    const t = e.type && UNIT_TYPES.find((x) => x.sidc === e.type);
    const ech = e.echelon && ECHELONS.find((x) => x.code === e.echelon);
    return [t ? t.label : e.type ? e.type : '', ech ? ech.label : ''].filter(Boolean).join(', ');
  }

  // ---------------- Liste ----------------

  function renderList(msg) {
    const round = roundOf();
    const probs = problems();
    const rows = entries.map((e, i) => `<button type="button" class="mv-big dir-row${probs.some((p) => p.indexOf(e.short) >= 0) ? ' dir-warn' : ''}" data-i="${i}">
        <b>${esc(e.short)} · ${esc(e.long || e.short)}</b>
        <span>${esc([unitText(e), e.freq ? e.freq + ' Hz' : 'canal ?', e.slot ? 'créneau ' + e.slot : 'créneau ?'].filter(Boolean).join(' · '))}</span>
      </button>`).join('');
    frame({
      title: 'Annuaire du réseau',
      sub: (net.version ? 'Version ' + net.version + (net.date ? ' du ' + net.date : '') : 'Nouvel annuaire') + ' · ' + entries.length + ' station' + (entries.length > 1 ? 's' : '') + (dirty ? ' · non enregistré' : ''),
      body: `
        ${msg ? `<p class="dir-msg">${esc(msg)}</p>` : ''}
        <div class="mv-grid mv-grid-1">${rows || '<p class="mv-pos-msg">Aucune station : AJOUTER, ou IMPORTER un annuaire reçu.</p>'}
          <button type="button" class="mv-big" data-act="add"><b>+ AJOUTER</b><span>Une station du réseau</span></button>
        </div>
        <h3 class="mv-family">Canaux et créneaux</h3>
        <div class="mv-grid mv-grid-1">
          <button type="button" class="mv-big" data-act="alloc"><b>ATTRIBUER</b><span>Canal et créneau à chaque station qui n'en a pas (1 400-2 500 Hz d'abord, pas de 60 Hz)</span></button>
        </div>
        <div class="dir-net">
          <span>Créneau des balises</span>
          <div class="mv-counter-row">
            <button type="button" class="mv-step" data-slot="-1" aria-label="moins">&minus;</button>
            <span class="mv-counter-val">${net.slotS} s</span>
            <button type="button" class="mv-step" data-slot="1" aria-label="plus">+</button>
          </div>
          <span>${round ? 'Tour : ' + round + ' créneau' + (round > 1 ? 'x' : '') + ' = ' + fmt(net.slotS * round) + ' (une balise par station et par tour au plus)' : 'Aucun créneau attribué'}</span>
        </div>
        ${probs.length ? `<div class="dir-probs"><b>À vérifier</b><ul>${probs.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : (entries.length ? '<p class="dir-ok">✓ Canaux et créneaux sans conflit</p>' : '')}
        <h3 class="mv-family">Diffuser à toutes les stations</h3>
        <div class="mv-grid mv-grid-2">
          <button type="button" class="mv-big mv-red" data-act="save"${entries.length ? '' : ' disabled'}><b>ENREGISTRER</b><span>Appliquer sur ce téléphone${dirty ? ' (nouvelle version)' : ''}</span></button>
          <button type="button" class="mv-big" data-act="qr"${entries.length ? '' : ' disabled'}><b>QR CODE</b><span>À scanner par les autres téléphones</span></button>
          <button type="button" class="mv-big" data-act="share"${entries.length ? '' : ' disabled'}><b>PARTAGER</b><span>Le fichier par SMS, mail…</span></button>
          ${opts.isNative ? '' : `<button type="button" class="mv-big" data-act="file"${entries.length ? '' : ' disabled'}><b>FICHIER</b><span>Télécharger le .csv</span></button>`}
        </div>
        <h3 class="mv-family">Recevoir un annuaire</h3>
        <div class="mv-grid mv-grid-2">
          <button type="button" class="mv-big" data-act="scan"><b>SCANNER</b><span>Le QR code d'un autre téléphone</span></button>
          <button type="button" class="mv-big" data-act="paste"><b>COLLER</b><span>Un lien ou un fichier reçu</span></button>
        </div>`,
    });
    overlay.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => renderEdit(+b.dataset.i); });
    on('[data-act="add"]', () => renderEdit(-1));
    on('[data-act="alloc"]', () => {
      const r = allocate(entries, net);
      const changed = JSON.stringify(r.entries) !== JSON.stringify(entries);
      entries = r.entries;
      net.round = r.net.round;
      if (changed) dirty = true;
      renderList(r.full.length ? 'Plus de canal libre pour : ' + r.full.join(', ') + ' (34 au plus au pas de 60 Hz).' : changed ? 'Canaux et créneaux attribués.' : 'Rien à attribuer : tout est déjà réglé.');
    });
    overlay.querySelectorAll('[data-slot]').forEach((b) => {
      b.onclick = () => {
        const v = Math.max(13, Math.min(60, net.slotS + +b.dataset.slot));
        if (v !== net.slotS) { net.slotS = v; dirty = true; }
        renderList();
      };
    });
    on('[data-act="save"]', save);
    on('[data-act="qr"]', renderQr);
    on('[data-act="share"]', () => shareFile());
    on('[data-act="file"]', download);
    on('[data-act="scan"]', renderScan);
    on('[data-act="paste"]', renderPaste);
  }

  function fmt(sec) {
    const m = Math.floor(sec / 60), r = sec % 60;
    return (m ? m + ' min' : '') + (m && r ? ' ' : '') + (r || !m ? r + ' s' : '');
  }

  /** Fichier de l'annuaire en cours ; une modification non enregistrée prend une nouvelle version. */
  function text() {
    if (dirty) {
      net.version = String((parseInt(net.version, 10) || 0) + 1);
      net.date = today();
      dirty = false;
    }
    net.round = roundOf();
    return serializeDirectory(entries, net);
  }

  function save() {
    const report = opts.apply(text(), 'version ' + net.version);
    renderList(report ? 'Enregistré : ' + report : 'Annuaire refusé');
  }

  // ---------------- Fiche station ----------------

  function renderEdit(i) {
    const e = i >= 0 ? Object.assign({}, entries[i]) : { short: '', long: '' };
    const typeOpts = '<option value="">Aucun</option>' + UNIT_TYPES.map((t) => `<option value="${t.sidc}"${t.sidc === e.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')
      + (e.type && !UNIT_TYPES.some((t) => t.sidc === e.type) ? `<option value="${esc(e.type)}" selected>${esc(e.type)}</option>` : '');
    const echOpts = '<option value="">Aucun</option>' + ECHELONS.map((x) => `<option value="${x.code}"${x.code === e.echelon ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
    frame({
      title: i >= 0 ? 'Station ' + e.short : 'Nouvelle station',
      sub: 'Canal et créneau : laisser « auto » puis ATTRIBUER',
      back: () => renderList(),
      body: `<div class="dir-form">
        <label>Indicatif court (sur l'air)<input type="text" id="dir-short" maxlength="2" autocapitalize="characters" spellcheck="false" value="${esc(e.short)}" placeholder="PC"></label>
        <label>Indicatif long (affiché)<input type="text" id="dir-long" maxlength="12" autocapitalize="characters" spellcheck="false" value="${esc(e.long)}" placeholder="F4MTX"></label>
        <label>Type d'unité (carte)<select id="dir-type">${typeOpts}</select></label>
        <label>Échelon<select id="dir-ech">${echOpts}</select></label>
        <div class="dir-net"><span>Canal d'émission</span>
          <div class="mv-counter-row">
            <button type="button" class="mv-step" data-f="-1" aria-label="moins">&minus;</button>
            <span class="mv-counter-val" id="dir-freq">${e.freq ? e.freq + ' Hz' : 'auto'}</span>
            <button type="button" class="mv-step" data-f="1" aria-label="plus">+</button>
            <button type="button" class="mv-step mv-unk" data-f="0">auto</button>
          </div></div>
        <div class="dir-net"><span>Créneau des balises</span>
          <div class="mv-counter-row">
            <button type="button" class="mv-step" data-s="-1" aria-label="moins">&minus;</button>
            <span class="mv-counter-val" id="dir-slot">${e.slot || 'auto'}</span>
            <button type="button" class="mv-step" data-s="1" aria-label="plus">+</button>
            <button type="button" class="mv-step mv-unk" data-s="0">auto</button>
          </div></div>
        <p class="mv-pos-msg" id="dir-err"></p>
        <div class="mv-grid mv-grid-2">
          ${i >= 0 ? '<button type="button" class="mv-big" data-act="del"><b>SUPPRIMER</b><span>Retirer du réseau</span></button>' : ''}
          <button type="button" class="mv-big mv-red" data-act="ok"><b>VALIDER</b><span>${i >= 0 ? 'Garder les changements' : 'Ajouter au réseau'}</span></button>
        </div></div>`,
    });
    const q = (id) => overlay.querySelector('#' + id);
    const plan = channelPlan(net);
    overlay.querySelectorAll('[data-f]').forEach((b) => {
      b.onclick = () => {
        const d = +b.dataset.f;
        if (d === 0) delete e.freq;
        else {
          const sorted = plan.slice().sort((x, y) => x - y);
          const cur = e.freq || (d > 0 ? sorted[0] - net.step : sorted[sorted.length - 1] + net.step);
          const nxt = d > 0 ? sorted.find((f) => f > cur) : sorted.slice().reverse().find((f) => f < cur);
          if (nxt !== undefined) e.freq = nxt;
        }
        q('dir-freq').textContent = e.freq ? e.freq + ' Hz' : 'auto';
      };
    });
    overlay.querySelectorAll('[data-s]').forEach((b) => {
      b.onclick = () => {
        const d = +b.dataset.s;
        if (d === 0) delete e.slot;
        else e.slot = Math.max(1, Math.min(98, (e.slot || 0) + d));
        q('dir-slot').textContent = e.slot || 'auto';
      };
    });
    for (const id of ['dir-short', 'dir-long']) {
      q(id).addEventListener('input', () => {
        const v = q(id).value.toUpperCase().replace(id === 'dir-short' ? /[^A-Z0-9]/g : /[^A-Z0-9/]/g, '');
        if (v !== q(id).value) q(id).value = v;
      });
    }
    on('[data-act="del"]', () => {
      if (!confirm('Retirer ' + e.short + ' de l\'annuaire ?')) return;
      entries.splice(i, 1);
      dirty = true;
      renderList();
    });
    on('[data-act="ok"]', () => {
      const short = q('dir-short').value, long = q('dir-long').value || short;
      const err = !SHORT_CALL_RE.test(short) ? 'Indicatif court : 2 lettres ou chiffres.'
        : short === '99' ? '99 est réservé aux messages en l\'air.'
        : entries.some((x, k) => k !== i && x.short === short) ? short + ' est déjà dans l\'annuaire.'
        : !LONG_CALL_RE.test(long) ? 'Indicatif long : 3 à 12 lettres, chiffres ou /.' : '';
      if (err) { q('dir-err').textContent = err; return; }
      e.short = short;
      e.long = long;
      if (q('dir-type').value) e.type = q('dir-type').value; else delete e.type;
      if (q('dir-ech').value) e.echelon = q('dir-ech').value; else delete e.echelon;
      if (i >= 0) entries[i] = e; else entries.push(e);
      entries.sort((x, y) => (x.short < y.short ? -1 : x.short > y.short ? 1 : 0));
      dirty = true;
      renderList();
    });
  }

  // ---------------- Diffusion ----------------

  function renderQr() {
    const link = directoryLink(text());
    let svg = '';
    try {
      window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
      const qr = window.qrcode(0, 'L'); // L : modules plus gros, plus facile à scanner sur écran
      qr.addData(link, 'Byte');
      qr.make();
      svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    } catch (e) {
      svg = '<p class="mv-pos-msg">Annuaire trop grand pour un QR code : utiliser PARTAGER.</p>';
    }
    frame({
      title: 'QR code de l\'annuaire',
      sub: 'Version ' + net.version + (net.date ? ' du ' + net.date : '') + ' · ' + entries.length + ' stations · ' + link.length + ' car.',
      back: () => renderList(),
      body: `<div class="dir-qr">${svg}</div>
        <p class="setting-info">Sur l'autre téléphone : ChatMTX → Paramètres → Annuaire → Créer / modifier → <b>SCANNER</b>. Ou l'appareil photo : le lien ouvre ChatMTX dans le navigateur, qui propose de l'importer (même hors ligne si ChatMTX y a déjà été ouvert).</p>`,
    });
  }

  async function shareFile() {
    const t = text();
    renderList(); // la version a pu changer
    const title = 'Annuaire ChatMTX version ' + net.version;
    try {
      if (opts.share && await opts.share(title, t)) return;
      if (navigator.share) { await navigator.share({ title, text: t }); return; }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(t);
      renderList('Fichier copié : le coller dans un SMS ou un mail.');
    } catch (e) {
      renderList('Partage impossible sur cet appareil : utiliser le QR code.');
    }
  }

  function download() {
    const t = text();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' }));
    a.download = 'annuaire-chatmtx-v' + net.version + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    renderList('Fichier ' + a.download + ' téléchargé.');
  }

  // ---------------- Réception ----------------

  /** Lien d'annuaire ou fichier collé/scanné → appliqué ici, puis rouvert dans l'outil. */
  function receive(raw, how) {
    const t = directoryFromLink(raw) || String(raw);
    const p = parseDirectory(t);
    if (!p.imported) return 'Pas un annuaire ChatMTX (aucune station reconnue).';
    if (dirty && !confirm('Remplacer la liste en cours (non enregistrée) par l\'annuaire reçu ?')) return 'Import annulé.';
    const report = opts.apply(t, how);
    if (!report) return 'Annuaire refusé.';
    open();
    renderList('Reçu ' + (p.net.version ? 'version ' + p.net.version + ' ' : '') + '(' + how + ') : ' + report);
    return null;
  }

  function renderPaste() {
    frame({
      title: 'Coller un annuaire',
      sub: 'Lien du QR code ou contenu du fichier',
      back: () => renderList(),
      body: `<div class="dir-form"><textarea id="dir-paste" rows="8" spellcheck="false" placeholder="https://chatmtx.f4mtx.com/#annuaire=…&#10;ou&#10;#reseau;creneau=15;…&#10;PC;F4MTX;infanterie;section;1400;1"></textarea>
        <p class="mv-pos-msg" id="dir-err"></p>
        <div class="mv-grid mv-grid-1"><button type="button" class="mv-big mv-red" data-act="ok"><b>IMPORTER</b><span>Remplace l'annuaire de ce téléphone</span></button></div></div>`,
    });
    on('[data-act="ok"]', () => {
      const err = receive(overlay.querySelector('#dir-paste').value, 'collé');
      if (err) overlay.querySelector('#dir-err').textContent = err;
    });
  }

  function renderScan() {
    const supported = 'BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    frame({
      title: 'Scanner un annuaire',
      sub: 'Viser le QR code affiché par l\'autre téléphone',
      back: () => renderList(),
      body: supported ? `<div class="dir-scan"><video id="dir-video" playsinline muted></video></div><p class="mv-pos-msg" id="dir-err">Démarrage de l'appareil photo…</p>`
        : `<p class="mv-pos-msg">Lecture de QR code non disponible dans ${opts.isNative ? 'cette application (navigateur système trop ancien)' : 'ce navigateur'}.</p>
           <p class="setting-info">Scanner le QR code avec l'appareil photo du téléphone : le lien ouvre ChatMTX dans le navigateur et propose l'import. Ou faire PARTAGER sur l'autre téléphone, puis COLLER ici.</p>`,
    });
    if (!supported) return;
    const msg = (t) => { const m = overlay && overlay.querySelector('#dir-err'); if (m) m.textContent = t; };
    let stream = null, timer = null, stopped = false;
    scanStop = () => {
      stopped = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach((tr) => tr.stop());
      scanStop = null;
    };
    let detector;
    try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { msg('Lecteur de QR code indisponible.'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then((s) => {
      if (stopped) { s.getTracks().forEach((tr) => tr.stop()); return; }
      stream = s;
      const v = overlay.querySelector('#dir-video');
      v.srcObject = s;
      v.play();
      msg('');
      const tick = () => {
        if (stopped) return;
        detector.detect(v).then((codes) => {
          if (stopped) return;
          const c = codes.find((x) => /#annuaire=/.test(x.rawValue));
          if (c) {
            const err = receive(c.rawValue, 'scanné');
            if (err) { msg(err); timer = setTimeout(tick, 1000); }
            return;
          }
          if (codes.length) msg('QR code lu, mais ce n\'est pas un annuaire ChatMTX.');
          timer = setTimeout(tick, 250);
        }, () => { timer = setTimeout(tick, 500); });
      };
      tick();
    }, (e) => msg(e && e.name === 'NotAllowedError' ? 'Appareil photo refusé : l\'autoriser dans les réglages.' : 'Appareil photo indisponible.'));
  }

  function stopScan() { if (scanStop) scanStop(); }

  window.DirectoryUI = { init, open, close };
})();
