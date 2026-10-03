/**
 * ChatMTX (Messagerie Texte Xtreme) - Application principale
 * Interface chat pour communication FT8 par modulation sonore
 */
(function () {
  'use strict';

  // === Elements DOM ===
  const messagesEl = document.getElementById('messages');
  const chatContainer = document.getElementById('chat-container');
  const msgInput = document.getElementById('msg-input');
  const btnSend = document.getElementById('btn-send');
  const btnListen = document.getElementById('btn-listen');
  const btnSettings = document.getElementById('btn-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const settingsPanel = document.getElementById('settings-panel');
  const statusIndicator = document.getElementById('status-indicator');
  const charCount = document.getElementById('char-count');
  const spectrumCanvas = document.getElementById('spectrum-canvas');
  const spectrumCtx = spectrumCanvas.getContext('2d');

  // Settings elements
  const settingVolume = document.getElementById('setting-volume');
  const settingBaseFreq = document.getElementById('setting-base-freq');
  const volumeVal = document.getElementById('volume-val');
  const btnClearHistory = document.getElementById('btn-clear-history');

  // Mode, duration & cancel elements
  const settingTxMode = document.getElementById('setting-tx-mode');
  const txDurationEl = document.getElementById('tx-duration');
  const btnCancel = document.getElementById('btn-cancel');

  // Serial PTT elements
  const btnSerialConnect = document.getElementById('btn-serial-connect');
  const serialStatusEl = document.getElementById('serial-status');
  const serialIndicator = document.getElementById('serial-indicator');
  const settingPttSignal = document.getElementById('setting-ptt-signal');
  const settingPttLevel = document.getElementById('setting-ptt-level');
  const settingPttLead = document.getElementById('setting-ptt-lead');
  const settingPttTail = document.getElementById('setting-ptt-tail');
  const settingVoxTone = document.getElementById('setting-vox-tone');
  const settingStationPos = document.getElementById('setting-station-pos');
  const btnStationGps = document.getElementById('btn-station-gps');
  const stationPosInfo = document.getElementById('station-pos-info');
  const settingContactFreq = document.getElementById('setting-contact-freq');
  const btnMedevac = document.getElementById('btn-medevac');
  const medevacAlertEl = document.getElementById('medevac-alert');
  const medevacAlertInfo = document.getElementById('medevac-alert-info');
  const destCallEl = document.getElementById('dest-call');
  const settingBeacon = document.getElementById('setting-beacon');
  const settingBeaconMin = document.getElementById('setting-beacon-min');
  const settingBeaconM = document.getElementById('setting-beacon-m');
  const beaconInfo = document.getElementById('beacon-info');
  const settingCallsign = document.getElementById('setting-callsign');
  const myCallEl = document.getElementById('my-call');
  const btnDirectoryImport = document.getElementById('btn-directory-import');
  const btnDirectoryClear = document.getElementById('btn-directory-clear');
  const directoryFile = document.getElementById('directory-file');
  const directoryStatus = document.getElementById('directory-status');
  const apkVersionsEl = document.getElementById('apk-versions');

  // Application Android (Capacitor) : PTT par port serie USB natif, fichiers dans l'APK
  const usbSerial = nativeUsbSerial();
  const isNative = !!usbSerial;

  // === State ===
  let modem = null;
  let link = null;       // SonoLink : accuses et repetitions (arq.js)
  let history = [];
  let serialPort = null;
  const _rxBubbles = new Map(); // id de reception SonoLink -> { el, msg }
  let directory = {};           // annuaire : indicatif court -> indicatif long
  let directoryUnits = {};      // annuaire : indicatif court -> {type (SIDC), echelon} pour la carte

  // === Init ===
  // Arrivee depuis l'ancienne adresse sonochat.f4mtx.com (legacy/index.html) :
  // historique, reglages et annuaire passes dans l'ancre de l'URL. On ne remplace
  // jamais une donnee deja presente ici.
  function importMigration() {
    if (!location.hash.startsWith('#migrate=')) return;
    try {
      const b64 = decodeURIComponent(location.hash.slice('#migrate='.length));
      const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
      const KEYS = ['sonochat-settings', 'sonochat-directory', 'sonochat-directory-units', 'sonochat-history'];
      for (const k of KEYS) {
        if (typeof data[k] === 'string' && localStorage.getItem(k) === null) {
          JSON.parse(data[k]); // valide avant d'ecrire
          localStorage.setItem(k, data[k]);
        }
      }
      console.log('[MIGRATION] donnees de sonochat.f4mtx.com importees');
    } catch (e) {
      console.warn('[MIGRATION] import impossible : ' + e.message);
    }
    window.history.replaceState(null, '', location.pathname + location.search); // `history` est l'historique des messages
  }

  /**
   * « gap » des flexbox inconnu avant Chrome 84 (Android 9 sans WebView a jour) :
   * classe no-flex-gap, style.css remet des marges a la place.
   */
  function detectFlexGap() {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    d.appendChild(document.createElement('div'));
    d.appendChild(document.createElement('div'));
    document.body.appendChild(d);
    const ok = d.scrollHeight === 1;
    d.remove();
    document.documentElement.classList.toggle('no-flex-gap', !ok);
  }

  function init() {
    detectFlexGap();
    importMigration();
    initMedevac();
    loadDirectory();
    loadHistory();
    renderHistory();
    initModem();
    initUI();
    restoreMedevacAlert();
    registerServiceWorker();
    checkApkUpdate();
    resizeCanvas();
  }

  function initModem() {
    const settings = loadSettings();
    modem = new FT8Modem({
      baseFreq: settings.baseFreq,
      volume: settings.volume / 100,
    });
    modem.updateSettings({ pttLeadMs: settings.pttLeadMs, pttTailMs: settings.pttTailMs, voxTone: settings.voxTone });

    link = new SonoLink({
      transmit: (frames, opts) => modem.transmitSymbols(frames.map(frameToSymbols), opts),
      abort: () => modem.cancelTransmit(),
      // Seul le destinataire accuse (et toujours) ; 99 = message en l'air, personne
      ackEnabled: (text) => modem.listening && isForMe(text),
      callsign: () => myCallsign(),
      log: (m) => console.log('[LINK] ' + m),
    });
    modem.onFrame = (frame) => link.handleFrame(frame);
    link.onBeacon = (ev) => storePosition(ev.call, ev.lat, ev.lon, Date.now());
    modem.onUndecoded = (info) => link.handleUndecoded(info);
    link.onRx = onLinkRx;
    link.onTx = onLinkTx;

    modem.onSpectrumData = (freqData, sampleRate, fftSize) => {
      drawSpectrum(freqData, sampleRate, fftSize);
    };

    modem.onStatusChange = (status) => {
      updateStatus(status);
    };
  }

  function frameToSymbols(f) {
    if (f.kind === 'tele') return FT8Modem.payloadToSymbols(FT8Modem.encodeTelemetry(f.value));
    if (f.kind === 'ext') return FT8Modem.textToExtendedSymbols(f.text);
    return FT8Modem.textToSymbols(f.text);
  }

  const timeNow = () => new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Reception : une bulle par message SonoLink, mise a jour au fil des trames
  function onLinkRx(ev) {
    if (ev.superseded) {
      // Fragment (debut perdu) remplace par le message complet recu ensuite
      const old = _rxBubbles.get(ev.id);
      if (old) {
        old.el.remove();
        if (old.msg) { history = history.filter((m) => m !== old.msg); saveHistory(); }
        _rxBubbles.delete(ev.id);
      }
      return;
    }
    const { call, to, body } = splitHeader(ev.text);
    // En-tete d'un 9-line pour nous (premier bloc, avant la fin du message) : alerte
    // En-tete d'un message d'alerte pour nous (9-line, METHANE, CONTACT, UXO), des le 1er bloc
    const alertTitle = Medevac.alertTitle(body);
    if (alertTitle && to === myCallsign()) enterMedevacAlert(call, alertTitle);
    let b = _rxBubbles.get(ev.id);
    if (!b) {
      const el = addMessage(body, 'received', false, 0, call, to);
      el.classList.add('receiving');
      b = { el, msg: null };
      _rxBubbles.set(ev.id, b);
      while (_rxBubbles.size > 50) _rxBubbles.delete(_rxBubbles.keys().next().value);
    }
    b.el._msg.text = body;
    b.el._msg.call = call;
    b.el._msg.to = to;
    renderBody(b.el);
    renderHeader(b.el);
    b.el.classList.toggle('receiving', !ev.done);
    b.el.classList.toggle('incomplete', ev.done && !ev.complete);

    const parts = [];
    if (ev.total > 1) parts.push(ev.frames + '/' + ev.total + ' trames');
    if (ev.done && !ev.complete) parts.push('incomplet');
    if (ev.ackSent) parts.push('accuse envoye');
    const meta = b.el.querySelector('.msg-meta');
    meta.innerHTML = timeNow() + ' <span class="rx-source">FT8</span>'
      + (parts.length ? ' <span class="link-status">' + escapeHtml(parts.join(' · ')) + '</span>' : '');
    scrollToBottom();

    if (ev.done) {
      // Enregistre une fois, puis met a jour si une repetition complete le message
      if (!b.msg) {
        b.msg = { text: body, call, to, type: 'received', time: timeNow(), timestamp: Date.now() };
        history.push(b.msg);
      } else {
        b.msg.text = body;
        b.msg.call = call;
        b.msg.to = to;
      }
      b.msg.status = ev.complete ? '' : 'incomplet';
      saveHistory();
      if (ev.complete && to === myCallsign()) onFormattedRx(body, call);
    }
  }

  // === Messages formates : 9-line MEDEVAC et MIST (medevac.js, medevac-ui.js) ===
  // Toujours en etendu, avec accuse. Le recepteur renvoie ensuite ce qu'il a recu
  // (marqueur ? au lieu de /) : l'emetteur compare et affiche « collationne conforme »
  // ou les lignes qui different.
  const READBACK_DELAY_MS = 2000;      // apres notre accuse, avant le collationnement
  const READBACK_WINDOW_MS = 15 * 60 * 1000;
  const _readbackDone = new Map();     // corps -> heure : un collationnement par message

  // Alerte 9-line : des l'en-tete d'un 9-line qui nous est adresse, fond rouge,
  // mode etendu et destinataire = l'emetteur (la station va devoir lui repondre).
  // « Fin d'alerte » remet le mode et le destinataire d'avant. Survit a un rechargement.
  const ALERT_KEY = 'chatmtx-medevac-alert';
  let medevacAlert = null;   // {by, time, prevMode, prevDest}

  function enterMedevacAlert(call, title) {
    if (medevacAlert) {
      if ((call && call !== medevacAlert.by) || title !== medevacAlert.title) {
        medevacAlert.by = call || medevacAlert.by;
        medevacAlert.title = title || medevacAlert.title;
        showMedevacAlert();
      }
      return;
    }
    medevacAlert = { by: call || '', title: title || '9-LINE', time: timeNow(), prevMode: settingTxMode.value, prevDest: getDest() };
    setTxMode('extended');
    if (CALL_RE.test(call || '')) setDest(call);
    showMedevacAlert();
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  }

  function endMedevacAlert() {
    if (!medevacAlert) return;
    const { prevMode, prevDest } = medevacAlert;
    medevacAlert = null;
    try { localStorage.removeItem(ALERT_KEY); } catch (e) { /* stockage indisponible */ }
    setTxMode(prevMode || 'extended');
    setDest(prevDest || '');
    document.body.classList.remove('alert-9line');
    medevacAlertEl.classList.add('hidden');
  }

  function showMedevacAlert() {
    try { localStorage.setItem(ALERT_KEY, JSON.stringify(medevacAlert)); } catch (e) { /* idem */ }
    document.body.classList.add('alert-9line');
    medevacAlertEl.classList.remove('hidden');
    const by = medevacAlert.by ? displayCall(medevacAlert.by) : '?';
    document.getElementById('medevac-alert-title').textContent = 'ALERTE ' + (medevacAlert.title || '9-LINE');
    medevacAlertInfo.textContent = `de ${by} a ${medevacAlert.time.slice(0, 5)} · mode etendu, reponse vers ${by}`;
  }

  function restoreMedevacAlert() {
    try {
      const saved = JSON.parse(localStorage.getItem(ALERT_KEY) || 'null');
      if (saved) { medevacAlert = saved; showMedevacAlert(); }
    } catch (e) { /* alerte illisible : ignoree */ }
  }

  /** Change le mode comme si l'utilisateur l'avait fait (enregistrement, compteur). */
  function setTxMode(mode) {
    settingTxMode.value = mode;
    settingTxMode.dispatchEvent(new Event('change'));
  }

  /** Remplit .msg-text : carte si message formate, texte simple sinon. */
  function renderBody(msgEl) {
    const msg = msgEl._msg;
    const textEl = msgEl.querySelector('.msg-text');
    if (!msg || !textEl) return;
    const card = Medevac.isFormatted(msg.text) && MedevacUI.renderCard(textEl, msg.text,
      { call: msg.call, time: msg.time, readback: msg.readback });
    msgEl.classList.toggle('formatted', !!card);
    if (!card) textEl.textContent = msg.text;
  }

  function sendFormatted(body, to) {
    if (link.busy) return;
    sendText(body, 'extended', to);
  }

  function onFormattedRx(body, call) {
    const dec = Medevac.decode(body);
    if (!dec) return;
    if (dec.readback) {
      checkReadback(dec, body, call);
      return;
    }
    // Collationnement : une fois par message, apres notre accuse (sinon on le couvrirait)
    const now = Date.now();
    if (now - (_readbackDone.get(body) || 0) < READBACK_WINDOW_MS) return;
    _readbackDone.set(body, now);
    const readback = '?' + body.slice(1);
    const trySend = () => {
      if (!myCallsign()) return;
      if (modem.transmitting || link.busy) {
        setTimeout(trySend, 1000);
        return;
      }
      sendText(readback, 'extended', call); // adresse a l'emetteur, qui l'accuse : la boucle est fermee
    };
    setTimeout(trySend, READBACK_DELAY_MS);
  }

  /** Collationnement recu : le comparer au dernier message formate envoye du meme type. */
  function checkReadback(dec, body, call) {
    const original = '/' + body.slice(1);
    const now = Date.now();
    const sent = history.filter((m) => m.type === 'sent' && now - m.timestamp < READBACK_WINDOW_MS
      && Medevac.isFormatted(m.text) && m.text[0] === '/' && m.text[1] === original[1]);
    const target = sent.find((m) => m.text === original) || sent[sent.length - 1];
    if (!target) return;
    const mine = Medevac.decode(target.text);
    const lines = target.text === original ? [] : Medevac.diff(mine, Medevac.decode(original));
    target.readback = { by: call, ok: lines.length === 0, lines };
    saveHistory();
    messagesEl.querySelectorAll('.message.sent').forEach((el) => {
      if (el._msg === target) renderBody(el);
    });
  }

  // === Indicatifs ===
  // Sur l'air, chaque message commence par l'indicatif court (2 caracteres) de
  // son emetteur. L'annuaire le traduit en indicatif long a l'affichage
  // seulement : l'historique garde le court, un annuaire importe plus tard
  // s'applique donc aussi aux anciens messages.
  const CALL_RE = /^[A-Z0-9]{2}$/;

  function myCallsign() {
    // 99 est reserve aux messages en l'air
    return CALL_RE.test(settingCallsign.value) && settingCallsign.value !== '99' ? settingCallsign.value : '';
  }

  // En-tete sur l'air : emetteur (2) + destinataire (2), 99 = message en l'air
  const BROADCAST = '99';

  function splitHeader(text) {
    if (text.startsWith(LINK.MISSING)) return { call: '?', to: '?', body: text }; // trame 1 perdue
    const call = text.substring(0, 2), to = text.substring(2, 4);
    // En-tete invalide : debut du message perdu (fragment d'etendu), on n'invente rien
    if (!CALL_RE.test(call) || !CALL_RE.test(to)) return { call: '?', to: '?', body: LINK.MISSING + text };
    return { call, to, body: text.substring(4) };
  }

  function isForMe(text) {
    const me = myCallsign();
    return typeof text === 'string' && !!me && splitHeader(text).to === me;
  }

  // === Destinataire ===
  function getDest() {
    return loadSettings().dest || '';
  }

  function setDest(call) {
    const s = loadSettings();
    s.dest = call;
    try { localStorage.setItem('sonochat-settings', JSON.stringify(s)); } catch (e) { /* stockage indisponible */ }
    updateDestBadge();
  }

  function updateDestBadge() {
    const d = getDest();
    destCallEl.classList.toggle('missing', !d);
    destCallEl.classList.toggle('broadcast', d === BROADCAST);
    destCallEl.textContent = !d ? 'Destinataire ?' : d === BROADCAST ? '99 Tous' : displayCall(d);
    destCallEl.title = !d ? 'Choisir le destinataire'
      : d === BROADCAST ? 'Message en l\'air, pour tous : aucun accuse' : 'Destinataire : il accusera reception';
    if (typeof updateInputStateHook === 'function') updateInputStateHook();
  }
  let updateInputStateHook = null;

  /** Stations connues : annuaire et indicatifs vus dans l'historique (les plus recents d'abord). */
  function knownStations() {
    const me = myCallsign();
    const seen = [];
    for (let i = history.length - 1; i >= 0; i--) {
      for (const c of [history[i].call, history[i].to]) {
        if (c && CALL_RE.test(c) && c !== BROADCAST && c !== me && !seen.includes(c)) seen.push(c);
      }
    }
    for (const c of Object.keys(directory)) if (c !== me && !seen.includes(c)) seen.push(c);
    return seen.slice(0, 16).map((c) => ({ call: c, label: displayCall(c) }));
  }

  function pickDest(then) {
    MedevacUI.pickStation({
      title: 'Destinataire', current: getDest(), allowBroadcast: true, stations: knownStations(),
      onPick: (c) => { setDest(c); if (then) then(c); },
    });
  }

  /** En-tete de bulle, formule radio « FM emetteur TO destinataire » + precision (moi, en l'air, autre station). */
  function renderHeader(msgEl) {
    const msg = msgEl._msg;
    const el = msgEl.querySelector('.msg-call');
    if (!msg || !el) return;
    const me = myCallsign();
    const to = msg.to;
    let html = '<span class="fmto">FM</span> ' + callSpan(msg.call, 'span', 'call-ref');
    let tag = '';
    if (to) {
      let toHtml;
      if (to === BROADCAST) {
        toHtml = '<span class="to-all">Tous</span>';
        tag = 'Message en l\'air · pour tous';
      } else if (to === me && msg.type === 'received') {
        toHtml = '<span class="to-me">moi</span>';
      } else {
        toHtml = callSpan(to, 'span', 'call-ref');
        if (msg.type === 'received' && to !== '?') tag = 'pour ' + displayCall(to) + ' · pas de reponse';
      }
      html += ' <span class="fmto">TO</span> ' + toHtml;
    }
    el.innerHTML = html + (tag ? `<span class="msg-to-tag">${escapeHtml(tag)}</span>` : '');
    msgEl.classList.toggle('not-for-me', msg.type === 'received' && !!to && to !== me && to !== BROADCAST && to !== '?');
  }


  function displayCall(call) {
    return lookupCall(directory, call);
  }

  /** Indicatif de la station, toujours visible sur la page de chat. */
  function updateMyCall() {
    const call = myCallsign();
    const long = call ? displayCall(call) : '';
    myCallEl.textContent = call ? long : 'Indicatif ?';
    myCallEl.classList.toggle('missing', !call);
    myCallEl.title = !call ? 'Definir mon indicatif (parametres)'
      : long !== call ? 'Mon indicatif : ' + long + ' (code court ' + call + ')'
      : 'Mon indicatif (modifiable dans les parametres)';
  }

  function callSpan(call, tag, cls) {
    if (!call) return '';
    const long = displayCall(call);
    const title = long !== call ? ` title="Indicatif court ${escapeHtml(call)}"` : '';
    return `<${tag} class="${cls}" data-call="${escapeHtml(call)}"${title}>${escapeHtml(long)}</${tag}>`;
  }

  function setCallEl(el, call) {
    if (!el) return;
    el.dataset.call = call;
    const long = displayCall(call);
    el.textContent = long;
    el.title = long !== call ? 'Indicatif court ' + call : '';
  }

  /** Applique l'annuaire a tous les indicatifs affiches (bulles, « recu par »). */
  function refreshCalls() {
    messagesEl.querySelectorAll('[data-call]').forEach((el) => setCallEl(el, el.dataset.call));
    updateMyCall();
    updateDestBadge();
  }

  function txStatusHtml(label, by) {
    return escapeHtml(label) + (by ? ' par ' + callSpan(by, 'span', 'call-ref') : '');
  }

  // Emission : etat de l'echange sur la bulle envoyee
  let _txBubble = null;

  function onLinkTx(ev) {
    if (!_txBubble) return;
    const statusEl = _txBubble.querySelector('.link-status');
    const frame = ev.total > 1 ? 'trame ' + (ev.seq + 1) + '/' + ev.total : '';
    const retry = ev.attempt ? 'repetition ' + ev.attempt + '/' + LINK.MAX_RETRIES : '';
    let text = '';
    switch (ev.state) {
      case 'frame': text = [frame || 'emission', retry].filter(Boolean).join(' · '); break;
      case 'waitAck': text = [frame, 'attente accuse', retry].filter(Boolean).join(' · '); break;
      case 'retry': text = [frame, ev.reason === 'rpt' ? 'repetition demandee' : ev.reason === 'mismatch' ? 'message incomplet chez le correspondant' : 'pas d\'accuse'].filter(Boolean).join(' · '); break;
      default: return;
    }
    if (statusEl) statusEl.textContent = text;
  }

  function initUI() {
    // Send & Cancel
    btnSend.addEventListener('click', sendMessage);
    document.getElementById('btn-alert-end').addEventListener('click', endMedevacAlert);
    btnMedevac.addEventListener('click', () => {
      if (link.busy) return;
      MedevacUI.openNine(); // 9-line direct
    });
    TacMap.init({
      history: () => history,
      myCall: myCallsign,
      callLabel: (c) => (c && c !== '?' ? displayCall(c) : '?'),
      station: () => ({ pos: loadSettings().stationPos }),
      unitSidc: (c) => unitSidc(directoryUnits[c]),
      positions: () => positions,
      unitLabel: (c) => {
        const u = directoryUnits[c];
        const t = u && UNIT_TYPES.find((x) => x.sidc === u.type);
        const e = u && u.echelon && ECHELONS.find((x) => x.code === u.echelon);
        return [t && t.label, e && e.label].filter(Boolean).join(', ');
      },
      openViewer: (body, info) => MedevacUI.openViewer(body, info),
    });
    document.getElementById('btn-map').addEventListener('click', () => TacMap.open());
    document.getElementById('btn-msg').addEventListener('click', () => {
      if (link.busy) return;
      MedevacUI.openChooser(); // tous les messages formates, par type
    });
    settingStationPos.addEventListener('change', () => { saveAndApplySettings(); updateStationPosInfo(); });
    settingContactFreq.addEventListener('change', saveAndApplySettings);
    document.getElementById('btn-station-map').addEventListener('click', () => {
      TacMap.pickPosition({
        title: 'Position de la station', initial: Medevac.parsePosition(settingStationPos.value),
        onPick: (p) => {
          settingStationPos.value = Medevac.toMgrs(p.lat, p.lon) || p.lat.toFixed(5) + ', ' + p.lon.toFixed(5);
          saveAndApplySettings();
          updateStationPosInfo();
        },
      });
    });
    btnStationGps.addEventListener('click', () => {
      if (!navigator.geolocation) return;
      stationPosInfo.textContent = 'Recherche de la position...';
      navigator.geolocation.getCurrentPosition((g) => {
        settingStationPos.value = Medevac.toMgrs(g.coords.latitude, g.coords.longitude)
          || g.coords.latitude.toFixed(5) + ', ' + g.coords.longitude.toFixed(5);
        saveAndApplySettings();
        updateStationPosInfo();
      }, (e) => {
        stationPosInfo.textContent = 'Position GPS impossible : ' + (e.code === 1 ? 'autorisation refusee.' : 'pas de signal.');
      }, { enableHighAccuracy: true, timeout: 20000 });
    });
    btnCancel.addEventListener('click', cancelMessage);
    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !btnSend.disabled) {
        sendMessage();
      }
    });

    // Filter input to FT8 charset, adapt to mode
    msgInput.addEventListener('input', updateInputState);
    settingTxMode.addEventListener('change', () => {
      saveAndApplySettings();
      updateInputState();
    });
    destCallEl.addEventListener('click', () => pickDest());
    updateInputStateHook = updateInputState;
    settingCallsign.addEventListener('input', () => {
      const v = settingCallsign.value.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 2);
      if (v !== settingCallsign.value) settingCallsign.value = v;
      const ok = CALL_RE.test(v) && v !== '99'; // 99 : messages en l'air
      settingCallsign.classList.toggle('required', !ok);
      if (ok) {
        const info = settingCallsign.parentElement.querySelector('.setting-info');
        if (info) info.classList.remove('warning');
      }
      saveAndApplySettings();
      updateMyCall();
    });
    myCallEl.addEventListener('click', askCallsign);

    // Annuaire
    btnDirectoryImport.addEventListener('click', () => directoryFile.click());
    directoryFile.addEventListener('change', importDirectory);
    btnDirectoryClear.addEventListener('click', () => {
      if (!Object.keys(directory).length || !confirm('Effacer l\'annuaire ?')) return;
      directory = {};
      directoryUnits = {};
      saveDirectory();
      refreshCalls();
      updateDirectoryStatus();
    });

    function updateInputState() {
      const filtered = msgInput.value.toUpperCase().split('').filter(
        c => FT8.CHARSET.includes(c)
      ).join('');
      if (filtered !== msgInput.value.toUpperCase()) {
        msgInput.value = filtered;
      }
      const mode = settingTxMode.value;
      const maxLen = maxTextLength(mode);
      if (msgInput.value.length > maxLen) {
        msgInput.value = msgInput.value.substring(0, maxLen);
      }
      msgInput.maxLength = maxLen;
      const len = msgInput.value.length;
      charCount.textContent = `${len}/${maxLen}`;
      btnSend.disabled = len === 0 || link.busy;

      if (len > 0) {
        const d = getDest();
        const dur = SonoLink.estimateDuration(myCallsign() + d + msgInput.value, mode, !!d && d !== BROADCAST);
        txDurationEl.textContent = '~' + formatDuration(dur);
      } else {
        txDurationEl.textContent = '';
      }
    }

    // Listen
    btnListen.addEventListener('click', toggleListen);

    // Settings
    btnSettings.addEventListener('click', () => {
      settingsPanel.classList.remove('hidden');
      updateApkVersionInfo();
    });
    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.classList.add('hidden');
    });

    settingVolume.addEventListener('input', () => {
      volumeVal.textContent = settingVolume.value + '%';
      saveAndApplySettings();
    });
    settingBaseFreq.addEventListener('change', saveAndApplySettings);

    btnClearHistory.addEventListener('click', () => {
      if (confirm('Effacer tout l\'historique ?')) {
        history = [];
        saveHistory();
        renderHistory();
      }
    });

    // Serial / PTT
    settingPttLead.addEventListener('change', saveAndApplySettings);
    settingPttTail.addEventListener('change', saveAndApplySettings);
    settingVoxTone.addEventListener('change', saveAndApplySettings);
    // Raccourci APK en tete des parametres. Dans l'application, il sert a la
    // mise a jour : l'URL est externe (https://localhost dans l'appli), Capacitor
    // l'ouvre donc dans le navigateur du telephone, qui gere le telechargement.
    const apkLink = document.getElementById('apk-link');
    if (isNative) {
      apkLink.removeAttribute('download'); // la WebView ne telecharge pas : on laisse Capacitor ouvrir le navigateur
      document.getElementById('apk-link-label').textContent = 'Mettre a jour l\'application (APK)';
      document.getElementById('apk-link-info').textContent = 'Telecharge la derniere version depuis chatmtx.f4mtx.com, a installer par-dessus.';
    }
    guardApkLink(apkLink, document.getElementById('apk-link-info'));
    if (isNative || 'serial' in navigator) {
      btnSerialConnect.addEventListener('click', connectSerial);
      settingPttSignal.addEventListener('change', saveAndApplySettings);
      settingPttLevel.addEventListener('change', saveAndApplySettings);
    } else {
      btnSerialConnect.disabled = true;
      btnSerialConnect.textContent = 'WebSerial non supporte';
    }

    // Load settings into UI
    const settings = loadSettings();
    settingVolume.value = settings.volume;
    volumeVal.textContent = settings.volume + '%';
    settingBaseFreq.value = settings.baseFreq;
    settingPttSignal.value = settings.pttSignal || 'RTS';
    settingPttLevel.value = settings.pttActiveHigh !== false ? 'high' : 'low';
    settingPttLead.value = settings.pttLeadMs;
    settingPttTail.value = settings.pttTailMs;
    settingVoxTone.checked = settings.voxTone === true;
    settingStationPos.value = settings.stationPos || '';
    settingBeacon.checked = settings.beaconOn === true;
    settingBeaconMin.value = String(settings.beaconMin);
    settingBeaconM.value = String(settings.beaconM);
    for (const el of [settingBeacon, settingBeaconMin, settingBeaconM]) {
      el.addEventListener('change', () => { saveAndApplySettings(); applyBeacon(); });
    }
    applyBeacon();
    settingContactFreq.value = settings.contactFreq || '';
    updateStationPosInfo();
    settingTxMode.value = settings.txMode || 'extended';
    updateDestBadge();
    settingCallsign.value = settings.callsign || '';
    updateMyCall();
    updateDirectoryStatus();
    updateInputState(); // limite et compteur du mode enregistre (11 ou 128)

    // Canvas resize
    window.addEventListener('resize', resizeCanvas);
  }

  // === Messages ===
  let _txTimer = null;

  function formatDuration(sec) {
    sec = Math.round(sec);
    return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'min' + String(sec % 60).padStart(2, '0');
  }

  const TX_RESULT = {
    confirmed: { label: '\u2713\u2713 recu', cls: 'confirmed' },
    sent: { label: 'envoye sans accuse', cls: '' },
    failed: { label: '\u2717 non confirme', cls: 'failed' },
    mismatch: { label: '\u2717 incoherence', cls: 'failed' },
    cancelled: { label: 'annule', cls: 'cancelled' },
  };

  // 13 ou 130 caracteres sur l'air, dont 4 pour l'en-tete (emetteur + destinataire)
  function maxTextLength(mode) {
    return (mode === 'standard' ? 13 : 130) - 4;
  }

  function askCallsign() {
    settingsPanel.classList.remove('hidden');
    settingCallsign.classList.add('required');
    settingCallsign.focus();
    const info = settingCallsign.parentElement.querySelector('.setting-info');
    if (info) info.classList.add('warning');
  }

  async function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || link.busy) return;
    if (!myCallsign()) {
      askCallsign();
      return;
    }
    const to = getDest();
    if (!to) {
      pickDest(() => sendMessage()); // premier envoi : choisir a qui
      return;
    }
    const mode = settingTxMode.value;
    msgInput.value = '';
    charCount.textContent = '0/' + maxTextLength(mode);
    txDurationEl.textContent = '';
    await sendText(text, mode, to);
  }

  /**
   * Emet un texte (sans l'en-tete, ajoute ici) et suit son sort dans une bulle.
   * Accuse attendu du seul destinataire ; 99 = message en l'air, sans accuse.
   */
  async function sendText(text, mode, to) {
    let ack = !!to && to !== BROADCAST;
    if (link.busy) return;
    const callsign = myCallsign();
    if (!callsign) {
      askCallsign();
      return;
    }
    btnSend.disabled = true;

    // Show cancel button, hide send
    btnSend.classList.add('hidden');
    btnCancel.classList.remove('hidden');

    // L'emetteur doit entendre les accuses : ecoute demarree si besoin
    let note = '';
    if (ack && !modem.listening) {
      await toggleListen();
      if (!modem.listening) {
        ack = false;
        note = ' (micro inactif)';
      }
    }

    const onAir = callsign + to + text;
    const totalDur = SonoLink.estimateDuration(onAir, mode, ack);
    const msgEl = addMessage(text, 'sent', true, totalDur, callsign, to);
    _txBubble = msgEl;

    // Live countdown in the message
    const txStart = Date.now();
    const progressEl = msgEl.querySelector('.tx-progress');
    _txTimer = setInterval(() => {
      const remaining = Math.max(0, totalDur - (Date.now() - txStart) / 1000);
      if (progressEl) progressEl.textContent = '~' + formatDuration(remaining);
    }, 500);

    let result;
    try {
      result = await link.send(onAir, mode, { ack, from: ack ? to : '' });
    } catch (err) {
      console.error('Erreur transmission:', err);
      result = { status: 'failed' };
    }
    finishTx(msgEl, result, note);
  }

  function finishTx(msgEl, result, note) {
    clearInterval(_txTimer);
    _txTimer = null;
    _txBubble = null;
    btnCancel.classList.add('hidden');
    btnSend.classList.remove('hidden');
    btnSend.disabled = msgInput.value.length === 0;

    const r = TX_RESULT[result.status] || TX_RESULT.failed;
    const inAir = msgEl._msg && msgEl._msg.to === BROADCAST && result.status === 'sent';
    let label = (inAir ? 'en l\'air, sans accuse' : r.label) + (note || '');
    if (result.status === 'failed' && result.total > 1) label += ' (trame ' + (result.seq + 1) + ')';
    const progressEl = msgEl.querySelector('.tx-progress');
    if (progressEl) progressEl.remove();
    const by = result.status === 'confirmed' ? result.by || '' : '';
    const statusEl = msgEl.querySelector('.link-status');
    if (statusEl) statusEl.innerHTML = txStatusHtml(label, by);
    if (r.cls) msgEl.classList.add(r.cls);
    if (msgEl._msg) {
      msgEl._msg.status = label;
      if (by) msgEl._msg.ackBy = by;
    }
    msgEl.classList.remove('sending'); // declenche l'enregistrement dans l'historique
  }

  async function cancelMessage() {
    link.cancel();
  }

  function addMessage(text, type, sending = false, txDuration = 0, call = '', to = '') {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const msg = {
      text: text,
      call: call,
      to: to,
      type: type,
      time: timeStr,
      timestamp: now.getTime()
    };

    if (!sending && type !== 'received') {
      history.push(msg);
      saveHistory();
    }

    const msgEl = document.createElement('div');
    msgEl.className = `message ${type}${sending ? ' sending' : ''}`;

    let metaExtra = '';
    if (type === 'sent' && sending) {
      metaExtra = ' <span class="link-status"></span>'
        + (txDuration > 0 ? ' <span class="tx-progress">~' + formatDuration(txDuration) + '</span>' : '');
    }
    const sourceTag = type === 'received' ? ' <span class="rx-source">FT8</span>' : '';
    msgEl.innerHTML = `
      <div class="msg-call"></div>
      <div class="msg-text"></div>
      <div class="msg-meta">${timeStr}${metaExtra}${sourceTag}</div>
    `;
    msgEl._msg = msg;
    renderHeader(msgEl);
    renderBody(msgEl);

    // Remove system message if it exists
    const sysMsg = messagesEl.querySelector('.system-msg');
    if (sysMsg && history.length > 0) {
      sysMsg.remove();
    }

    messagesEl.appendChild(msgEl);
    msgEl._msg = msg;
    scrollToBottom();

    // Save when transmission is done
    if (sending) {
      const checkDone = setInterval(() => {
        if (!msgEl.classList.contains('sending')) {
          clearInterval(checkDone);
          history.push(msg);
          saveHistory();
        }
      }, 200);
    }

    return msgEl;
  }

  function renderHistory() {
    messagesEl.innerHTML = '';

    if (history.length === 0) {
      messagesEl.innerHTML = `
        <div class="system-msg">
          <p>Bienvenue sur <strong>ChatMTX</strong></p>
          <p class="sub">Messagerie Texte Xtreme par modulation sonore FT8</p>
          <p class="sub">8-GFSK | LDPC(174,91) | 79 symboles | 12.64 s</p>
          <p class="sub">Activez le micro pour recevoir, tapez un message pour envoyer.</p>
        </div>
      `;
      return;
    }

    history.forEach(msg => {
      const msgEl = document.createElement('div');
      msgEl.className = `message ${msg.type}`;
      const status = msg.status ? ` <span class="link-status">${txStatusHtml(msg.status, msg.ackBy)}</span>` : '';
      msgEl.innerHTML = `
        <div class="msg-call"></div>
        <div class="msg-text"></div>
        <div class="msg-meta">${msg.time}${status}</div>
      `;
      msgEl._msg = msg;
      renderHeader(msgEl);
      renderBody(msgEl);
      messagesEl.appendChild(msgEl);
    });

    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }

  // === Listen toggle ===
  async function toggleListen() {
    if (modem.listening) {
      modem.stopListening();
      btnListen.classList.remove('active');
      clearSpectrum();
    } else {
      try {
        await modem.startListening();
        btnListen.classList.add('active');
        hideMicHelp();
      } catch (err) {
        showMicHelp(err);
      }
    }
  }

  // === Aide permission micro ===
  // Une fois l'origine bloquee (refus explicite, ou 3 fermetures de la demande
  // sous Chromium), le navigateur ne reaffiche plus jamais la demande et aucune
  // API ne permet a la page de la relancer : seul l'utilisateur peut debloquer
  // dans les reglages. On explique ou, puis on reprend l'ecoute des que la
  // permission change.
  let micPermWatch = null;

  function micHelpSteps() {
    const ua = navigator.userAgent;
    const android = /Android/i.test(ua);
    const brave = !!navigator.brave;
    const installed = matchMedia('(display-mode: standalone)').matches;
    const host = location.host;
    const browser = brave ? 'Brave' : 'le navigateur';

    if (isNative) {
      return [
        'Ouvrez les <b>Parametres</b> Android &rarr; <b>Applications</b> &rarr; <b>ChatMTX</b> &rarr; <b>Autorisations</b> &rarr; <b>Micro</b> &rarr; <b>Autoriser seulement si l\'appli est en cours d\'utilisation</b>.',
        'Revenez dans ChatMTX : l\'ecoute reprend toute seule, sinon fermez et rouvrez l\'application.'
      ];
    }
    if (android) {
      const steps = [];
      if (brave) {
        steps.push(`Ouvrez Brave &rarr; <b>&#8942;</b> &rarr; <b>Parametres</b> &rarr; <b>Parametres des sites</b> &rarr; <b>Microphone</b>, touchez <b>${host}</b> et choisissez <b>Autoriser</b>.`);
      } else {
        steps.push(`Dans ${browser} : <b>&#8942;</b> &rarr; <b>Parametres</b> &rarr; <b>Parametres des sites</b> &rarr; <b>Microphone</b> &rarr; <b>${host}</b> &rarr; <b>Autoriser</b>.`);
      }
      steps.push(`Verifiez aussi Android : <b>Parametres</b> &rarr; <b>Applications</b> &rarr; <b>${brave ? 'Brave' : 'votre navigateur'}</b> &rarr; <b>Autorisations</b> &rarr; <b>Micro</b> &rarr; <b>Autoriser seulement si l'appli est en cours d'utilisation</b>.`);
      steps.push(installed
        ? 'Revenez dans ChatMTX : l\'ecoute reprend toute seule, sinon fermez et rouvrez l\'application.'
        : 'Revenez sur cette page : l\'ecoute reprend toute seule, sinon rechargez-la.');
      return steps;
    }
    return [
      `Cliquez sur l'icone a gauche de l'adresse <b>${host}</b> &rarr; <b>Microphone</b> &rarr; <b>Autoriser</b>.`,
      'L\'ecoute reprend toute seule, sinon rechargez la page.'
    ];
  }

  function showMicHelp(err) {
    const name = err && err.name;
    let title, steps;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      title = 'Le microphone est bloque pour ChatMTX';
      steps = micHelpSteps();
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      title = 'Aucun microphone detecte';
      steps = ['Branchez ou activez un microphone, puis touchez a nouveau le bouton micro.'];
    } else if (name === 'NotReadableError' || name === 'AbortError') {
      title = 'Le microphone est deja utilise';
      steps = ['Fermez l\'application qui l\'utilise (appel, dictaphone...), puis touchez a nouveau le bouton micro.'];
    } else {
      title = 'Impossible d\'acceder au microphone';
      steps = [escapeHtml(String(err && err.message || err))];
    }

    hideMicHelp();
    const el = document.createElement('div');
    el.className = 'mic-help';
    el.id = 'mic-help';
    el.innerHTML = `
      <p class="mic-help-title">${title}</p>
      <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
      <div class="mic-help-actions">
        <button type="button" class="mic-help-retry">Reessayer</button>
        <button type="button" class="mic-help-close">Fermer</button>
      </div>
    `;
    el.querySelector('.mic-help-retry').addEventListener('click', toggleListen);
    el.querySelector('.mic-help-close').addEventListener('click', hideMicHelp);
    messagesEl.appendChild(el);
    scrollToBottom();

    if (name === 'NotAllowedError') watchMicPermission();
  }

  function hideMicHelp() {
    const el = document.getElementById('mic-help');
    if (el) el.remove();
  }

  // Reprend l'ecoute automatiquement quand l'utilisateur debloque le micro
  // (retour depuis les reglages). Permissions API absente : bouton Reessayer.
  async function watchMicPermission() {
    if (micPermWatch || !navigator.permissions) return;
    try {
      micPermWatch = await navigator.permissions.query({ name: 'microphone' });
    } catch (e) {
      return;
    }
    micPermWatch.addEventListener('change', () => {
      if (micPermWatch.state !== 'denied' && !modem.listening) toggleListen();
    });
    // Sur Android, revenir des reglages ne declenche pas toujours 'change'
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && micPermWatch.state === 'granted'
          && !modem.listening && document.getElementById('mic-help')) {
        toggleListen();
      }
    });
  }

  // === Status ===
  function updateStatus(status) {
    statusIndicator.className = 'status ' + status;
    const textEl = statusIndicator.querySelector('.status-text');
    switch (status) {
      case 'listening':
        textEl.textContent = 'Ecoute...';
        break;
      case 'transmitting':
        textEl.textContent = 'Emission FT8...';
        break;
      default:
        textEl.textContent = 'Pret';
    }
  }

  // === Spectrum ===
  function resizeCanvas() {
    const rect = spectrumCanvas.parentElement.getBoundingClientRect();
    spectrumCanvas.width = rect.width * window.devicePixelRatio;
    spectrumCanvas.height = rect.height * window.devicePixelRatio;
    spectrumCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  function drawSpectrum(freqData, sampleRate, fftSize) {
    const w = spectrumCanvas.width / window.devicePixelRatio;
    const h = spectrumCanvas.height / window.devicePixelRatio;
    const binWidth = sampleRate / fftSize;

    spectrumCtx.fillStyle = '#16213e';
    spectrumCtx.fillRect(0, 0, w, h);

    // Show the FT8 band: baseFreq - 20 Hz to baseFreq + 70 Hz (~90 Hz window)
    const freqMin = modem.baseFreq - 20;
    const freqMax = modem.baseFreq + 70;
    const binMin = Math.floor(freqMin / binWidth);
    const binMax = Math.ceil(freqMax / binWidth);
    const binRange = binMax - binMin;

    // Frequency bars
    const barWidth = w / binRange;
    for (let i = 0; i < binRange; i++) {
      const bin = binMin + i;
      if (bin >= freqData.length) break;

      const db = freqData[bin];
      const normalized = Math.max(0, (db + 100) / 60);
      const barHeight = normalized * h;
      const x = i * barWidth;

      const hue = 220 - normalized * 180;
      spectrumCtx.fillStyle = `hsla(${hue}, 80%, 55%, 0.8)`;
      spectrumCtx.fillRect(x, h - barHeight, barWidth + 0.5, barHeight);
    }

    // Mark the 8 FT8 tone frequencies
    spectrumCtx.strokeStyle = 'rgba(233, 69, 96, 0.5)';
    spectrumCtx.lineWidth = 1;
    spectrumCtx.font = '8px sans-serif';
    spectrumCtx.fillStyle = 'rgba(233, 69, 96, 0.7)';
    for (let s = 0; s < 8; s++) {
      const freq = modem.baseFreq + s * FT8.TONE_SPACING;
      const x = ((freq - freqMin) / (freqMax - freqMin)) * w;
      spectrumCtx.beginPath();
      spectrumCtx.moveTo(x, 0);
      spectrumCtx.lineTo(x, h);
      spectrumCtx.stroke();
      spectrumCtx.fillText(s.toString(), x + 2, 10);
    }
  }

  function clearSpectrum() {
    const w = spectrumCanvas.width / window.devicePixelRatio;
    const h = spectrumCanvas.height / window.devicePixelRatio;
    spectrumCtx.fillStyle = '#16213e';
    spectrumCtx.fillRect(0, 0, w, h);
  }

  // === Settings ===
  function loadSettings() {
    const defaults = { volume: 80, baseFreq: 1000, pttSignal: 'RTS', pttActiveHigh: true, txMode: 'extended', dest: '', callsign: '', beaconOn: false, beaconMin: 10, beaconM: 500, pttLeadMs: 100, pttTailMs: 150, voxTone: false, stationPos: '', contactFreq: '', medevacPeace: false };
    try {
      const saved = localStorage.getItem('sonochat-settings');
      if (!saved) return defaults;
      const settings = { ...defaults, ...JSON.parse(saved) };
      // v1 enregistrait « Accuses » coche par defaut : on repart du nouveau defaut (decoche)
      // v3 : destinataire sur chaque message ; etendu par defaut, la case Accuses disparait
      if (!settings.v || settings.v < 3) { settings.txMode = 'extended'; delete settings.ack; settings.v = 3; }
      return settings;
    } catch {
      return defaults;
    }
  }

  function clampMs(v, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : dflt;
  }

  function saveAndApplySettings() {
    const settings = {
      volume: parseInt(settingVolume.value),
      baseFreq: parseInt(settingBaseFreq.value),
      pttSignal: settingPttSignal.value,
      pttActiveHigh: settingPttLevel.value === 'high',
      txMode: settingTxMode.value,
      dest: getDest(),
      callsign: myCallsign(),
      pttLeadMs: clampMs(settingPttLead.value, 100),
      pttTailMs: clampMs(settingPttTail.value, 150),
      voxTone: settingVoxTone.checked,
      stationPos: settingStationPos.value.trim(),
      beaconOn: settingBeacon.checked,
      beaconMin: parseInt(settingBeaconMin.value, 10) || 0,
      beaconM: parseInt(settingBeaconM.value, 10) || 0,
      contactFreq: settingContactFreq.value.trim(),
      medevacPeace: loadSettings().medevacPeace,
      v: 3,
    };
    localStorage.setItem('sonochat-settings', JSON.stringify(settings));
    modem.updateSettings({ ...settings, volume: settings.volume / 100 });
  }

  // === Annuaire ===
  function loadDirectory() {
    try {
      const saved = localStorage.getItem('sonochat-directory');
      directory = saved ? JSON.parse(saved) : {};
      directoryUnits = JSON.parse(localStorage.getItem('sonochat-directory-units') || '{}');
    } catch {
      directory = {};
      directoryUnits = {};
    }
  }

  function saveDirectory() {
    try {
      localStorage.setItem('sonochat-directory', JSON.stringify(directory));
      localStorage.setItem('sonochat-directory-units', JSON.stringify(directoryUnits));
    } catch (e) {
      console.warn('Annuaire non enregistre:', e);
    }
  }

  function updateDirectoryStatus(extra) {
    const n = Object.keys(directory).length;
    const t = Object.keys(directoryUnits).length;
    directoryStatus.textContent = (n ? n + ' indicatif' + (n > 1 ? 's' : '') + ' dans l\'annuaire'
      + (t ? ', ' + t + ' avec type d\'unite' : '') : 'Annuaire vide')
      + (extra ? ' — ' + extra : '');
    btnDirectoryClear.disabled = n === 0;
  }

  function importDirectory() {
    const file = directoryFile.files && directoryFile.files[0];
    directoryFile.value = ''; // permet de reimporter le meme fichier
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const r = parseDirectory(reader.result);
      let report = r.imported + ' entree' + (r.imported > 1 ? 's' : '') + ' importee' + (r.imported > 1 ? 's' : '');
      if (r.skipped.length) {
        const lines = r.skipped.slice(0, 10).join(', ') + (r.skipped.length > 10 ? '...' : '');
        report += ', ' + r.skipped.length + ' ligne' + (r.skipped.length > 1 ? 's' : '') + ' ignoree' + (r.skipped.length > 1 ? 's' : '') + ' (' + lines + ')';
      }
      if (r.imported === 0) {
        updateDirectoryStatus('aucune entree valide, annuaire inchange');
        return;
      }
      directory = r.map; // un import remplace l'annuaire
      directoryUnits = r.units;
      saveDirectory();
      TacMap.refresh();
      refreshCalls();
      updateDirectoryStatus(report);
    };
    reader.onerror = () => updateDirectoryStatus('lecture du fichier impossible');
    reader.readAsText(file);
  }

  // === History persistence ===
  function loadHistory() {
    try {
      const saved = localStorage.getItem('sonochat-history');
      history = saved ? JSON.parse(saved) : [];
    } catch {
      history = [];
    }
  }

  function saveHistory() {
    if (history.length > 200) {
      history = history.slice(-200);
    }
    localStorage.setItem('sonochat-history', JSON.stringify(history));
    TacMap.refresh(); // carte tactique ouverte : nouveaux symboles
  }

  // === Utils ===
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // === Serial / PTT ===
  async function connectSerial() {
    try {
      if (serialPort) {
        await disconnectSerial();
        return;
      }

      if (isNative) {
        await connectNativeSerial();
        return;
      }

      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: 9600 });

      modem.serialPort = serialPort;
      await modem._pttOff();
      updateSerialUI(true);

      navigator.serial.addEventListener('disconnect', (e) => {
        if (e.target === serialPort) handleSerialDisconnect();
      });
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        console.error('Erreur port serie:', err);
      }
    }
  }

  // Application Android : port serie USB via le plugin natif UsbSerial
  let usbDetachListener = null;

  async function connectNativeSerial() {
    let ports;
    try {
      ({ ports } = await usbSerial.list());
    } catch (e) {
      serialStatusEl.textContent = 'Erreur USB';
      console.error('UsbSerial.list:', e);
      return;
    }
    if (!ports.length) {
      serialStatusEl.textContent = 'Aucune interface USB';
      return;
    }
    const port = ports.length === 1 ? ports[0] : await chooseUsbPort(ports);
    if (!port) return;
    // Niveaux de repos (PTT relache) transmis au natif : il y revient seul au
    // debranchement, a la fermeture de l'appli ou si le PTT reste ferme trop longtemps
    const idle = !modem.pttActiveHigh;
    const useDtr = modem.pttSignal === 'DTR';
    try {
      await usbSerial.open({ deviceId: port.deviceId, rts: useDtr ? false : idle, dtr: useDtr ? idle : false });
    } catch (e) {
      serialStatusEl.textContent = /permission/i.test(e && e.message) ? 'Autorisation USB refusee' : 'Ouverture impossible';
      console.error('UsbSerial.open:', e);
      return;
    }
    serialPort = new NativePttPort(usbSerial, port);
    modem.serialPort = serialPort;
    await modem._pttOff();
    updateSerialUI(true, port.name);
    if (!usbDetachListener) {
      usbDetachListener = await usbSerial.addListener('detached', () => {
        if (serialPort instanceof NativePttPort) handleSerialDisconnect();
      });
      await usbSerial.addListener('watchdog', () => {
        console.warn('PTT relache par securite (emission trop longue)');
        serialStatusEl.textContent = 'PTT relache par securite';
      });
    }
  }

  /** Plusieurs interfaces branchees : choix dans le panneau Parametres. */
  function chooseUsbPort(ports) {
    return new Promise((resolve) => {
      const list = document.createElement('div');
      list.className = 'usb-port-list';
      ports.forEach((p) => {
        const b = document.createElement('button');
        b.className = 'serial-btn';
        b.textContent = p.name;
        b.addEventListener('click', () => { list.remove(); resolve(p); });
        list.appendChild(b);
      });
      const cancel = document.createElement('button');
      cancel.className = 'serial-btn';
      cancel.textContent = 'Annuler';
      cancel.addEventListener('click', () => { list.remove(); resolve(null); });
      list.appendChild(cancel);
      btnSerialConnect.parentElement.after(list);
    });
  }

  async function disconnectSerial() {
    if (!serialPort) return;
    try {
      await modem._pttOff();
      await serialPort.close();
    } catch (e) {
      console.warn('Erreur fermeture port:', e);
    }
    handleSerialDisconnect();
  }

  function handleSerialDisconnect() {
    serialPort = null;
    modem.serialPort = null;
    updateSerialUI(false);
  }

  function updateSerialUI(connected, name) {
    btnSerialConnect.textContent = connected ? 'Deconnecter' : 'Connecter';
    btnSerialConnect.classList.toggle('connected', connected);
    serialStatusEl.textContent = connected ? 'Connecte' + (name ? ' (' + name + ')' : '') : 'Deconnecte';
    serialStatusEl.classList.toggle('connected', connected);
    serialIndicator.classList.toggle('hidden', !connected);
    serialIndicator.classList.toggle('connected', connected);
  }

  function initMedevac() {
    MedevacUI.init({
      getCall: myCallsign,
      askCall: askCallsign,
      callLabel: (c) => (c ? displayCall(c) : ''),
      getStation: () => {
        const s = loadSettings();
        return { pos: s.stationPos, freq: s.contactFreq, peace: s.medevacPeace };
      },
      savePeace: (peace) => {
        const s = loadSettings();
        s.medevacPeace = peace;
        localStorage.setItem('sonochat-settings', JSON.stringify(s));
      },
      send: sendFormatted,
      getDest,
      knownStations,
      isNative,
      share: nativeShare,
    });
  }

  /** Partage natif (application : plugin Capacitor Share). false : non disponible. */
  async function nativeShare(title, text) {
    const share = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
    if (!isNative || !share) return false;
    await share.share({ title, text, dialogTitle: title });
    return true;
  }

  function updateStationPosInfo() {
    const v = settingStationPos.value.trim();
    const p = Medevac.parsePosition(v);
    stationPosInfo.textContent = !v ? 'Utilisee par defaut pour la ligne 1 du 9-line.'
      : p ? (Medevac.toMgrs(p.lat, p.lon) || '') + ' · ' + Medevac.formatLatLon(p.lat, p.lon)
      : 'Position non reconnue : MGRS (31U DQ 4825 1193) ou degres (48.8584, 2.2945).';
  }

  // === Balise de position automatique (trame 'pos' de SonoLink, en l'air) ===
  // Envoi si le temps OU la distance depuis la derniere balise est atteint, jamais
  // plus d'une fois par minute, jamais pendant un envoi ou une reception.
  const BEACON_MIN_GAP_MS = 60000;
  const BEACON_CHECK_MS = 15000;
  const POS_KEY = 'chatmtx-positions';
  const POS_PER_STATION = 100;
  let positions = {};        // indicatif -> [[lat, lon, t]] (balises recues et emises)
  try { positions = JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch (e) { positions = {}; }
  let beaconWatch = null, beaconTimer = null, beaconFix = null, beaconBusy = false;
  let beaconLast = null;
  try { beaconLast = JSON.parse(localStorage.getItem('chatmtx-beacon-last') || 'null'); } catch (e) { beaconLast = null; }

  function storePosition(call, lat, lon, t) {
    if (!call || call === '?') return;
    const list = positions[call] = positions[call] || [];
    list.push([Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6, t]);
    if (list.length > POS_PER_STATION) list.splice(0, list.length - POS_PER_STATION);
    try { localStorage.setItem(POS_KEY, JSON.stringify(positions)); } catch (e) { /* stockage plein */ }
    TacMap.refresh();
  }

  function distanceM(a, b) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function applyBeacon() {
    const s = loadSettings();
    const on = s.beaconOn && (s.beaconMin > 0 || s.beaconM > 0) && !!navigator.geolocation;
    if (on && beaconWatch === null) {
      beaconWatch = navigator.geolocation.watchPosition((g) => {
        beaconFix = { lat: g.coords.latitude, lon: g.coords.longitude, acc: g.coords.accuracy };
        updateBeaconInfo();
      }, (e) => { beaconFix = null; updateBeaconInfo(e.code === 1 ? 'GPS refuse : autoriser la localisation.' : 'pas de position GPS.'); },
      { enableHighAccuracy: true, maximumAge: 15000 });
      beaconTimer = setInterval(beaconTick, BEACON_CHECK_MS);
      setTimeout(beaconTick, 3000);
    } else if (!on && beaconWatch !== null) {
      navigator.geolocation.clearWatch(beaconWatch);
      clearInterval(beaconTimer);
      beaconWatch = beaconTimer = null;
      beaconFix = null;
    }
    updateBeaconInfo();
  }

  function beaconTick() {
    const s = loadSettings();
    if (!s.beaconOn || !beaconFix || beaconBusy || !myCallsign() || link.busy || modem.transmitting) return;
    const now = Date.now();
    if (beaconLast && now - beaconLast.t < BEACON_MIN_GAP_MS) return;
    const dueTime = !beaconLast || (s.beaconMin > 0 && now - beaconLast.t >= s.beaconMin * 60000);
    const dueDist = !!beaconLast && s.beaconM > 0 && distanceM(beaconLast, beaconFix) >= s.beaconM;
    if (!dueTime && !dueDist) return;
    const fix = beaconFix;
    beaconBusy = true;
    link.beacon(fix.lat, fix.lon).then((sent) => {
      beaconBusy = false;
      if (!sent) return;
      beaconLast = { t: Date.now(), lat: fix.lat, lon: fix.lon };
      try { localStorage.setItem('chatmtx-beacon-last', JSON.stringify(beaconLast)); } catch (e) { /* idem */ }
      storePosition(myCallsign(), fix.lat, fix.lon, beaconLast.t);
      updateBeaconInfo();
    }, () => { beaconBusy = false; });
  }

  function updateBeaconInfo(err) {
    if (!beaconInfo) return;
    const s = loadSettings();
    const base = 'Une trame FT8 (12,6 s), en l\'air pour tous, sans accuse, position GPS au metre. Les autres stations la voient sur la carte, pas dans le fil.';
    if (!s.beaconOn) { beaconInfo.textContent = base; return; }
    if (!(s.beaconMin > 0 || s.beaconM > 0)) { beaconInfo.textContent = 'Choisir un intervalle de temps ou une distance.'; return; }
    const last = beaconLast ? 'Derniere balise a ' + new Date(beaconLast.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      + ' (' + (Medevac.toMgrs(beaconLast.lat, beaconLast.lon) || '') + ')' : 'Aucune balise encore';
    beaconInfo.textContent = last + ' · ' + (err ? err : beaconFix ? 'GPS ±' + Math.round(beaconFix.acc || 0) + ' m' : 'en attente du GPS...');
  }

  // === Service Worker ===
  function registerServiceWorker() {
    if (isNative) return; // application : les fichiers sont dans l'APK
    if ('serviceWorker' in navigator) {
      // Une nouvelle version prend le controle : on recharge pour l'utiliser,
      // sauf en pleine emission/ecoute (elle s'appliquera au prochain lancement).
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return; // premiere installation, rien a recharger
        if (modem && (modem.transmitting || modem.listening || (link && link.busy))) return;
        location.reload();
      });
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('Service Worker enregistre'))
        .catch(err => console.warn('SW erreur:', err));
    }
  }

  // === Mise a jour obligatoire de l'application ===
  // L'APK embarque ses fichiers : un deploiement du site ne la met pas a jour.
  // On compare la version embarquee (app-version.json, ecrit par bundle-web.mjs)
  // a celle publiee par deploy.sh (apk-version.json, CORS ouvert par Caddy).
  // Plus recente en ligne : ecran bloquant jusqu'a l'installation. Hors ligne
  // ou serveur muet : on laisse passer.
  const APK_URL = 'https://chatmtx.f4mtx.com/chatmtx.apk';
  const APK_VERSION_URL = 'https://chatmtx.f4mtx.com/apk-version.json';
  const APK_CHECK_INTERVAL_MS = 3600 * 1000;
  let apkCheckedAt = 0;

  function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return Math.sign(d);
    }
    return 0;
  }

  // Versions de l'APK : embarquee (application seulement) et publiee sur le serveur.
  // null = inconnue (navigateur, hors ligne, serveur muet).
  async function fetchApkVersions() {
    const read = async (url, opts) => {
      try {
        const res = await fetch(url, opts);
        return res.ok ? (await res.json()).version || null : null;
      } catch (e) {
        return null;
      }
    };
    const local = isNative ? await read('app-version.json') : null;
    const remote = await read(APK_VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' });
    return { local, remote };
  }

  // Ligne de version dans les parametres (rafraichie a chaque ouverture)
  async function updateApkVersionInfo() {
    apkVersionsEl.className = 'setting-info apk-versions';
    apkVersionsEl.textContent = 'Verification de la version...';
    const { local, remote } = await fetchApkVersions();
    const server = 'serveur : ' + (remote || 'injoignable');
    if (!isNative) {
      apkVersionsEl.textContent = 'Version de l\'application sur le ' + server;
      return;
    }
    let state = '';
    if (local && remote) {
      const up = compareVersions(remote, local) <= 0;
      state = up ? ' \u2014 a jour' : ' \u2014 mise a jour disponible';
      apkVersionsEl.classList.add(up ? 'up-to-date' : 'outdated');
    }
    apkVersionsEl.textContent = 'Installee : ' + (local || '?') + ' \u00b7 ' + server + state;
  }

  async function checkApkUpdate() {
    if (!isNative || document.getElementById('update-gate')) return;
    apkCheckedAt = Date.now();
    const { local, remote } = await fetchApkVersions();
    if (!local || !remote || compareVersions(remote, local) <= 0) return;
    // Pas en pleine emission ou reception : on reessaie un peu plus tard
    if (modem && (modem.transmitting || (link && link.busy))) {
      setTimeout(checkApkUpdate, 30000);
      return;
    }
    showUpdateGate(local, remote);
  }

  const APK_INSTALL_HELP = 'Telechargement lance dans le navigateur. Ouvrez la notification '
    + '<b>chatmtx.apk</b> puis touchez <b>Installer</b> (Android peut demander d\'autoriser le navigateur '
    + 'a installer des applications). Inutile de retoucher le bouton : chaque toucher relance un telechargement.';
  const APK_GUARD_MS = 60000;

  /**
   * Lien de telechargement de l'APK : un seul telechargement par minute. Le
   * telechargement part en silence dans le navigateur ; sans retour visible, on
   * retouchait et on accumulait chatmtx (1).apk, (2).apk...
   */
  function guardApkLink(a, helpEl) {
    let lockedUntil = 0;
    const label = a.textContent;
    a.addEventListener('click', (e) => {
      if (Date.now() < lockedUntil) { e.preventDefault(); return; }
      lockedUntil = Date.now() + APK_GUARD_MS;
      // Parametre unique : jamais une ancienne copie en cache (navigateur, Cloudflare)
      a.href = APK_URL + '?t=' + Date.now();
      a.classList.add('locked');
      const span = a.querySelector('span') || a;
      span.textContent = 'Telechargement lance...';
      if (helpEl) { helpEl.innerHTML = APK_INSTALL_HELP; helpEl.classList.remove('hidden'); }
      setTimeout(() => {
        a.classList.remove('locked');
        span.textContent = a.querySelector('span') ? 'Relancer le telechargement (APK)' : 'Relancer le telechargement';
      }, APK_GUARD_MS);
    });
    return label;
  }

  function showUpdateGate(local, remote) {
    if (modem && modem.listening) modem.stopListening();
    const el = document.createElement('div');
    el.className = 'update-gate';
    el.id = 'update-gate';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-labelledby', 'update-gate-title');
    el.innerHTML = `
      <div class="update-gate-box">
        <p class="update-gate-title" id="update-gate-title">Mise a jour obligatoire</p>
        <p>Une nouvelle version de ChatMTX est disponible : <b>${escapeHtml(remote)}</b> (installee : ${escapeHtml(local)}).</p>
        <p>Telechargez-la puis installez-la par-dessus l'application actuelle. Vos messages et reglages sont conserves.</p>
        <a class="update-gate-btn" href="${APK_URL}">Telecharger la mise a jour</a>
        <p class="update-gate-steps hidden">${APK_INSTALL_HELP}</p>
      </div>
    `;
    // Lien externe : Capacitor l'ouvre dans le navigateur, qui telecharge l'APK
    guardApkLink(el.querySelector('a'), el.querySelector('.update-gate-steps'));
    document.body.appendChild(el);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - apkCheckedAt > APK_CHECK_INTERVAL_MS) checkApkUpdate();
  });

  // === Start ===
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
