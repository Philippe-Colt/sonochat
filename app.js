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

  // === State ===
  let modem = null;
  let history = [];
  let serialPort = null;
  let _recentReceived = [];

  // === Init ===
  function init() {
    loadHistory();
    renderHistory();
    initModem();
    initUI();
    registerServiceWorker();
    resizeCanvas();
  }

  function initModem() {
    const settings = loadSettings();
    modem = new FT8Modem({
      baseFreq: settings.baseFreq,
      volume: settings.volume / 100,
    });

    modem.onReceive = (text) => {
      const now = Date.now();

      // Skip exact duplicates
      const isDup = _recentReceived.some(r =>
        now - r.time < 60000 && r.text === text
      );
      if (isDup) return;

      // Skip if already contained in a longer finalized message
      const dominated = _recentReceived.some(r =>
        now - r.time < 60000 && r.text.includes(text) && r.finalized
      );
      if (dominated) return;

      // Check if this new text supersedes an existing partial bubble
      let updated = false;
      for (let i = _recentReceived.length - 1; i >= 0; i--) {
        const r = _recentReceived[i];
        if (now - r.time > 60000) continue;
        if (text.includes(r.text) && text !== r.text && r.el && r.el.parentNode) {
          // Update the existing bubble in-place
          r.el.querySelector('.msg-text').textContent = text;
          r.el.classList.add('receiving');
          r.text = text;
          r.time = now;
          // Reset finalize timer
          clearTimeout(r.finalizeTimer);
          r.finalizeTimer = setTimeout(() => finalizeRxMessage(r), 15000);
          updated = true;
          scrollToBottom();
          break;
        }
      }

      if (!updated) {
        // New message bubble (shown as "receiving" = in progress)
        const msgEl = addMessage(text, 'received');
        msgEl.classList.add('receiving');
        const entry = { text, time: now, el: msgEl, finalized: false, finalizeTimer: null };
        entry.finalizeTimer = setTimeout(() => finalizeRxMessage(entry), 15000);
        _recentReceived.push(entry);
      }

      // Clean old entries
      while (_recentReceived.length > 30) {
        const old = _recentReceived.shift();
        clearTimeout(old.finalizeTimer);
      }
    };

    function finalizeRxMessage(entry) {
      entry.finalized = true;
      if (entry.el && entry.el.parentNode) {
        entry.el.classList.remove('receiving');
        // Update time to final
        const metaEl = entry.el.querySelector('.msg-meta');
        if (metaEl) {
          const timeStr = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          metaEl.innerHTML = timeStr + ' <span class="rx-source">FT8</span>';
        }
        // Save to history
        history.push({
          text: entry.text,
          type: 'received',
          time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          timestamp: Date.now()
        });
        saveHistory();
      }
    }

    modem.onSpectrumData = (freqData, sampleRate, fftSize) => {
      drawSpectrum(freqData, sampleRate, fftSize);
    };

    modem.onStatusChange = (status) => {
      updateStatus(status);
    };
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

    function updateInputState() {
      const filtered = msgInput.value.toUpperCase().split('').filter(
        c => FT8.CHARSET.includes(c)
      ).join('');
      if (filtered !== msgInput.value.toUpperCase()) {
        msgInput.value = filtered;
      }
      const mode = settingTxMode.value;
      const maxLen = mode === 'standard' ? 13 : 130;
      if (msgInput.value.length > maxLen) {
        msgInput.value = msgInput.value.substring(0, maxLen);
      }
      msgInput.maxLength = maxLen;
      const len = msgInput.value.length;
      charCount.textContent = `${len}/${maxLen}`;
      btnSend.disabled = len === 0 || modem.transmitting;

      if (len > 0) {
        const dur = FT8Modem.estimateDuration(msgInput.value, mode);
        txDurationEl.textContent = '~' + dur.toFixed(1) + 's';
      } else {
        txDurationEl.textContent = '';
      }
    }

    // Listen
    btnListen.addEventListener('click', toggleListen);

    // Settings
    btnSettings.addEventListener('click', () => {
      settingsPanel.classList.remove('hidden');
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
    if ('serial' in navigator) {
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
    settingTxMode.value = settings.txMode || 'standard';

    // Canvas resize
    window.addEventListener('resize', resizeCanvas);
  }

  // === Messages ===
  let _txTimer = null;
  let _txMsgEl = null;

  async function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || modem.transmitting) return;

    const mode = settingTxMode.value;
    const maxLen = mode === 'standard' ? 13 : 130;
    const totalDur = FT8Modem.estimateDuration(text, mode);
    msgInput.value = '';
    charCount.textContent = '0/' + maxLen;
    txDurationEl.textContent = '';
    btnSend.disabled = true;

    // Show cancel button, hide send
    btnSend.classList.add('hidden');
    btnCancel.classList.remove('hidden');

    const msgEl = addMessage(text, 'sent', true, totalDur);
    _txMsgEl = msgEl;

    // Live countdown in the message
    const txStart = Date.now();
    const progressEl = msgEl.querySelector('.tx-progress');
    _txTimer = setInterval(() => {
      const elapsed = (Date.now() - txStart) / 1000;
      const remaining = Math.max(0, totalDur - elapsed);
      if (progressEl) {
        progressEl.textContent = remaining.toFixed(0) + 's';
      }
    }, 500);

    try {
      if (mode === 'multi-frame') {
        await modem.transmitMultiFrame(text);
      } else if (mode === 'extended') {
        await modem.transmitExtended(text);
      } else {
        await modem.transmit(text);
      }
      finishTx(msgEl, modem._txAborted);
    } catch (err) {
      console.error('Erreur transmission:', err);
      finishTx(msgEl, true);
    }
  }

  function finishTx(msgEl, cancelled) {
    clearInterval(_txTimer);
    _txTimer = null;
    _txMsgEl = null;
    btnCancel.classList.add('hidden');
    btnSend.classList.remove('hidden');
    btnSend.disabled = false;
    msgEl.classList.remove('sending');
    const progressEl = msgEl.querySelector('.tx-progress');
    if (progressEl) progressEl.remove();
    if (cancelled) {
      msgEl.classList.add('cancelled');
    }
  }

  async function cancelMessage() {
    await modem.cancelTransmit();
  }

  function addMessage(text, type, sending = false, txDuration = 0) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const msg = {
      text: text,
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
    if (type === 'sent' && sending && txDuration > 0) {
      metaExtra = ' <span class="tx-progress">' + txDuration.toFixed(0) + 's</span>';
    } else if (type === 'sent' && !sending) {
      metaExtra = '';
    }
    const sourceTag = type === 'received' ? ' <span class="rx-source">FT8</span>' : '';
    msgEl.innerHTML = `
      <div class="msg-text">${escapeHtml(text)}</div>
      <div class="msg-meta">${timeStr}${metaExtra}${sourceTag}</div>
    `;

    // Remove system message if it exists
    const sysMsg = messagesEl.querySelector('.system-msg');
    if (sysMsg && history.length > 0) {
      sysMsg.remove();
    }

    messagesEl.appendChild(msgEl);
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
      msgEl.innerHTML = `
        <div class="msg-text">${escapeHtml(msg.text)}</div>
        <div class="msg-meta">${msg.time}</div>
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
      } catch (err) {
        alert('Impossible d\'acceder au microphone.\nVerifiez les permissions.');
      }
    }
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
    const defaults = { volume: 80, baseFreq: 1000, pttSignal: 'RTS', pttActiveHigh: true, txMode: 'standard' };
    try {
      const saved = localStorage.getItem('sonochat-settings');
      return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
    } catch {
      return defaults;
    }
  }

  function saveAndApplySettings() {
    const settings = {
      volume: parseInt(settingVolume.value),
      baseFreq: parseInt(settingBaseFreq.value),
      pttSignal: settingPttSignal.value,
      pttActiveHigh: settingPttLevel.value === 'high',
      txMode: settingTxMode.value,
    };
    localStorage.setItem('sonochat-settings', JSON.stringify(settings));
    modem.updateSettings({ ...settings, volume: settings.volume / 100 });
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

  function updateSerialUI(connected) {
    btnSerialConnect.textContent = connected ? 'Deconnecter' : 'Connecter';
    btnSerialConnect.classList.toggle('connected', connected);
    serialStatusEl.textContent = connected ? 'Connecte' : 'Deconnecte';
    serialStatusEl.classList.toggle('connected', connected);
    serialIndicator.classList.toggle('hidden', !connected);
    serialIndicator.classList.toggle('connected', connected);
  }

  // === Service Worker ===
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('Service Worker enregistre'))
        .catch(err => console.warn('SW erreur:', err));
    }
  }

  // === Start ===
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
