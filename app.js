/**
 * SonoChat - Application principale
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
  const settingAck = document.getElementById('setting-ack');
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

  // === Init ===
  function init() {
    loadDirectory();
    loadHistory();
    renderHistory();
    initModem();
    initUI();
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
      ackEnabled: () => settingAck.checked && modem.listening,
      callsign: () => myCallsign(),
      log: (m) => console.log('[LINK] ' + m),
    });
    modem.onFrame = (frame) => link.handleFrame(frame);
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
    const { call, body } = splitCallsign(ev.text);
    let b = _rxBubbles.get(ev.id);
    if (!b) {
      const el = addMessage(body, 'received', false, 0, call);
      el.classList.add('receiving');
      b = { el, msg: null };
      _rxBubbles.set(ev.id, b);
      while (_rxBubbles.size > 50) _rxBubbles.delete(_rxBubbles.keys().next().value);
    }
    b.el.querySelector('.msg-text').textContent = body;
    setCallEl(b.el.querySelector('.msg-call'), call);
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
        b.msg = { text: body, call, type: 'received', time: timeNow(), timestamp: Date.now() };
        history.push(b.msg);
      } else {
        b.msg.text = body;
        b.msg.call = call;
      }
      b.msg.status = ev.complete ? '' : 'incomplet';
      saveHistory();
    }
  }

  // === Indicatifs ===
  // Sur l'air, chaque message commence par l'indicatif court (2 caracteres) de
  // son emetteur. L'annuaire le traduit en indicatif long a l'affichage
  // seulement : l'historique garde le court, un annuaire importe plus tard
  // s'applique donc aussi aux anciens messages.
  const CALL_RE = /^[A-Z0-9]{2}$/;

  function myCallsign() {
    return CALL_RE.test(settingCallsign.value) ? settingCallsign.value : '';
  }

  function splitCallsign(text) {
    if (text.startsWith(LINK.MISSING)) return { call: '?', body: text }; // trame 1 perdue
    return { call: text.substring(0, 2).trim() || '?', body: text.substring(2) };
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
    settingAck.addEventListener('change', () => {
      saveAndApplySettings();
      updateInputState();
    });
    settingCallsign.addEventListener('input', () => {
      const v = settingCallsign.value.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 2);
      if (v !== settingCallsign.value) settingCallsign.value = v;
      const ok = CALL_RE.test(v);
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
        const dur = SonoLink.estimateDuration(msgInput.value, mode, settingAck.checked);
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
      document.getElementById('apk-link-info').textContent = 'Telecharge la derniere version depuis sonochat.f4mtx.com, a installer par-dessus.';
    }
    apkLink.addEventListener('click', () => {
      // Parametre unique : jamais une ancienne copie en cache (navigateur, Cloudflare)
      apkLink.href = 'https://sonochat.f4mtx.com/sonochat.apk?t=' + Date.now();
    });
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
    settingTxMode.value = settings.txMode || 'standard';
    settingAck.checked = settings.ack === true;
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

  // 13 ou 130 caracteres sur l'air, dont 2 pour l'indicatif
  function maxTextLength(mode) {
    return (mode === 'standard' ? 13 : 130) - 2;
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

    const callsign = myCallsign();
    if (!callsign) {
      askCallsign();
      return;
    }

    const mode = settingTxMode.value;
    const maxLen = maxTextLength(mode);
    let ack = settingAck.checked;
    msgInput.value = '';
    charCount.textContent = '0/' + maxLen;
    txDurationEl.textContent = '';
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

    const onAir = callsign + text;
    const totalDur = SonoLink.estimateDuration(onAir, mode, ack);
    const msgEl = addMessage(text, 'sent', true, totalDur, callsign);
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
      result = await link.send(onAir, mode, { ack });
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
    let label = r.label + (note || '');
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

  function addMessage(text, type, sending = false, txDuration = 0, call = '') {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const msg = {
      text: text,
      call: call,
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
      ${type === 'received' ? '<div class="msg-call"></div>' : callSpan(call, 'div', 'msg-call')}
      <div class="msg-text">${escapeHtml(text)}</div>
      <div class="msg-meta">${timeStr}${metaExtra}${sourceTag}</div>
    `;
    if (type === 'received') setCallEl(msgEl.querySelector('.msg-call'), call);

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
          <p>Bienvenue sur <strong>SonoChat</strong></p>
          <p class="sub">Communication texte par modulation sonore FT8</p>
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
        ${callSpan(msg.call, 'div', 'msg-call')}
        <div class="msg-text">${escapeHtml(msg.text)}</div>
        <div class="msg-meta">${msg.time}${status}</div>
      `;
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
        'Ouvrez les <b>Parametres</b> Android &rarr; <b>Applications</b> &rarr; <b>SonoChat</b> &rarr; <b>Autorisations</b> &rarr; <b>Micro</b> &rarr; <b>Autoriser seulement si l\'appli est en cours d\'utilisation</b>.',
        'Revenez dans SonoChat : l\'ecoute reprend toute seule, sinon fermez et rouvrez l\'application.'
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
        ? 'Revenez dans SonoChat : l\'ecoute reprend toute seule, sinon fermez et rouvrez l\'application.'
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
      title = 'Le microphone est bloque pour SonoChat';
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
    const defaults = { volume: 80, baseFreq: 1000, pttSignal: 'RTS', pttActiveHigh: true, txMode: 'standard', ack: false, callsign: '', pttLeadMs: 100, pttTailMs: 150, voxTone: false };
    try {
      const saved = localStorage.getItem('sonochat-settings');
      if (!saved) return defaults;
      const settings = { ...defaults, ...JSON.parse(saved) };
      // v1 enregistrait « Accuses » coche par defaut : on repart du nouveau defaut (decoche)
      if (!settings.v) settings.ack = false;
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
      ack: settingAck.checked,
      callsign: myCallsign(),
      pttLeadMs: clampMs(settingPttLead.value, 100),
      pttTailMs: clampMs(settingPttTail.value, 150),
      voxTone: settingVoxTone.checked,
      v: 2,
    };
    localStorage.setItem('sonochat-settings', JSON.stringify(settings));
    modem.updateSettings({ ...settings, volume: settings.volume / 100 });
  }

  // === Annuaire ===
  function loadDirectory() {
    try {
      const saved = localStorage.getItem('sonochat-directory');
      directory = saved ? JSON.parse(saved) : {};
    } catch {
      directory = {};
    }
  }

  function saveDirectory() {
    try {
      localStorage.setItem('sonochat-directory', JSON.stringify(directory));
    } catch (e) {
      console.warn('Annuaire non enregistre:', e);
    }
  }

  function updateDirectoryStatus(extra) {
    const n = Object.keys(directory).length;
    directoryStatus.textContent = (n ? n + ' indicatif' + (n > 1 ? 's' : '') + ' dans l\'annuaire' : 'Annuaire vide')
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
      saveDirectory();
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
  const APK_URL = 'https://sonochat.f4mtx.com/sonochat.apk';
  const APK_VERSION_URL = 'https://sonochat.f4mtx.com/apk-version.json';
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
        <p>Une nouvelle version de SonoChat est disponible : <b>${escapeHtml(remote)}</b> (installee : ${escapeHtml(local)}).</p>
        <p>Telechargez-la puis installez-la par-dessus l'application actuelle. Vos messages et reglages sont conserves.</p>
        <a class="update-gate-btn" href="${APK_URL}">Telecharger la mise a jour</a>
      </div>
    `;
    // Lien externe : Capacitor l'ouvre dans le navigateur, qui telecharge l'APK
    el.querySelector('a').addEventListener('click', (e) => {
      e.currentTarget.href = APK_URL + '?t=' + Date.now();
    });
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
