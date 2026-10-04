#!/usr/bin/env node
/**
 * Station de test HF : le vrai ChatMTX (https://chatmtx.f4mtx.com, le même code que l'APK)
 * dans une fenêtre Chromium sur le bureau, reliée à l'IC-7300 PAR LE PUPITRE telec-icom
 * (~/projects/telec-icom), qui garde l'exclusivité du poste (CI-V et carte son) et ses
 * garde-fous d'émission (perte de liaison 1,5 s, plus de modulation 10 s, durée maximale) :
 *   - réception : flux /ws/rx du pupitre (PCM 16 bits mono 12 kHz, trames de 10 ms) → faux
 *     micro de la page (getUserMedia remplacé) ;
 *   - émission : PTT de l'appli (faux port série, comme Web Serial / NativePttPort) → ordre
 *     « ptt » sur /ws/state ; l'audio du modem est capté pendant l'envoi (au lieu des
 *     haut-parleurs du PC) et envoyé sur /ws/tx ;
 *   - fréquence du poste lue dans l'état du pupitre (titre de la fenêtre) ; aucun ordre de
 *     fréquence ni de mode n'est jamais envoyé ;
 *   - écoute lancée automatiquement ; nouvelle version en ligne (CACHE_NAME de sw.js) →
 *     page rechargée dès que la station n'émet pas et n'attend pas d'accusé.
 * Compte station : ~/.config/chatmtx-station/compte.json {email, password} (station/compte.py).
 * Variables : NO_TX=1 (réception seule), PUPITRE (http://127.0.0.1:8000), STATION_URL.
 */
'use strict';
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const os = require('os');
const path = require('path');
const fs = require('fs');

const URL_APP = process.env.STATION_URL || 'https://chatmtx.f4mtx.com/';
const PUPITRE = process.env.PUPITRE || 'http://127.0.0.1:8000';
const NO_TX = process.env.NO_TX === '1';
const PTT_MAX_MS = 130000;
const VERSION_CHECK_MS = 5 * 60000;
const PROFILE = path.join(os.homedir(), '.local', 'share', 'chatmtx-station');
const ACCOUNT = path.join(os.homedir(), '.config', 'chatmtx-station', 'compte.json');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------- Pupitre ----------------

const rig = { cookie: '', state: null, stateWs: null, rxWs: null, txWs: null, ptt: false, pttTimer: null, pttSince: 0, up: false };
let pageSock = null; // WebSocket de la page (pont local)
const stats = { rxFrames: 0, rxSq: 0, rxN: 0, txFrames: 0, page: null };
const dbfs = (sq, n) => (n ? (10 * Math.log10(sq / n + 1e-12)).toFixed(0) + ' dBFS' : '—');

async function login() {
  const acc = JSON.parse(fs.readFileSync(ACCOUNT, 'utf8'));
  const r = await fetch(PUPITRE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(acc),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('connexion au pupitre refusée : ' + (j.error || r.status));
  const c = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).join(';');
  const m = /pupitre_session=([^;]+)/.exec(c);
  if (!m) throw new Error('pas de cookie de session');
  rig.cookie = 'pupitre_session=' + m[1];
}

function wsUrl(p) { return PUPITRE.replace(/^http/, 'ws') + p; }

function openWs(p) {
  return new WebSocket(wsUrl(p), { headers: { Cookie: rig.cookie } });
}

async function connectPupitre() {
  try {
    await login();
  } catch (e) {
    rig.up = false;
    log('pupitre : ' + e.message + ' — nouvel essai dans 10 s');
    setTimeout(connectPupitre, 10000);
    return;
  }
  const st = openWs('/ws/state');
  rig.stateWs = st;
  st.on('message', (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === 'state') rig.state = { ...(rig.state || {}), ...m };
    } catch (e) { /* ignoré */ }
  });
  st.on('open', () => { rig.up = true; log('pupitre connecté'); });
  st.on('close', () => {
    rig.up = false;
    if (rig.stateWs === st) { log('pupitre : liaison perdue — reconnexion dans 5 s'); setTimeout(connectPupitre, 5000); }
  });
  st.on('error', () => {});
  const rx = openWs('/ws/rx');
  rig.rxWs = rx;
  rx.on('message', (d) => {
    stats.rxFrames++;
    for (let i = 0; i + 1 < d.length; i += 2) { const v = d.readInt16LE(i) / 32768; stats.rxSq += v * v; stats.rxN++; }
    if (pageSock && pageSock.readyState === 1) pageSock.send(d);
  });
  rx.on('error', () => {});
}

function sendState(obj) {
  if (rig.stateWs && rig.stateWs.readyState === 1) rig.stateWs.send(JSON.stringify(obj));
}

function ptt(on, why) {
  if (NO_TX) { if (on) log('PTT demandé (NO_TX : pas d\'émission)'); return; }
  clearTimeout(rig.pttTimer);
  if (on && !rig.ptt) {
    if (!rig.up) { log('PTT refusé : pupitre non connecté'); return; }
    rig.txWs = openWs('/ws/tx');
    rig.txWs.on('error', () => {});
    sendState({ action: 'ptt', on: true });
    rig.ptt = true;
    rig.pttSince = Date.now();
    rig.pttTimer = setTimeout(() => { log('PTT : 130 s, relâché d\'office'); ptt(false, 'minuteur'); }, PTT_MAX_MS);
    log('PTT ON' + (why ? ' (' + why + ')' : ''));
  } else if (!on && rig.ptt) {
    sendState({ action: 'ptt', on: false });
    rig.ptt = false;
    const tx = rig.txWs;
    rig.txWs = null;
    if (tx) setTimeout(() => tx.close(), 200); // fermer le canal fait aussi retomber l'alternat
    log('PTT OFF' + (why ? ' (' + why + ')' : '') + ' après ' + ((Date.now() - rig.pttSince) / 1000).toFixed(1) + ' s');
  }
}

// ---------------- Pont local page ↔ lanceur ----------------

function startBridge() {
  return new Promise((resolve) => {
    const srv = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    srv.on('connection', (sock) => {
      pageSock = sock;
      sock.on('message', (d, isBinary) => {
        if (isBinary) { // trame d'émission (PCM 16 bits 12 kHz)
          if (NO_TX) { stats.txFrames++; return; } // essai : captée et comptée, jamais émise
          if (rig.ptt && rig.txWs && rig.txWs.readyState === 1) { rig.txWs.send(d); stats.txFrames++; }
          return;
        }
        try {
          const m = JSON.parse(d.toString());
          if ('ptt' in m) ptt(!!m.ptt, 'ChatMTX');
          if (m.stat) stats.page = m.stat;
        } catch (e) { /* ignoré */ }
      });
      sock.on('close', () => { if (pageSock === sock) { pageSock = null; ptt(false, 'page fermée'); } });
    });
    srv.on('listening', () => resolve(srv.address().port));
  });
}

// ---------------- Page : faux micro, captation de l'émission, PTT ----------------

function initScript(port) {
  if (window.__stationInit) return;
  window.__stationInit = true;
  const RATE = 12000, FRAME = 240;
  let sock = null;
  const rxQueue = [];
  let rxLen = 0;
  const connect = () => {
    sock = new WebSocket('ws://127.0.0.1:' + port);
    sock.binaryType = 'arraybuffer';
    sock.onmessage = (e) => {
      if (typeof e.data === 'string') return;
      const s = new Int16Array(e.data);
      rxQueue.push(s);
      rxLen += s.length;
      while (rxLen > RATE) rxLen -= rxQueue.shift().length; // pas plus d'1 s de retard
    };
    sock.onclose = () => setTimeout(connect, 2000);
  };
  connect();
  window.__stationSend = (x) => { if (sock && sock.readyState === 1) sock.send(x); };

  // Faux micro : la réception du poste (12 kHz), un souffle infime quand rien n'arrive
  // (pendant l'émission le pupitre n'envoie rien : pas de « micro coupé » à tort)
  let micStream = null, micSq = 0, micN = 0;
  setInterval(() => {
    window.__stationSend(JSON.stringify({ stat: { mic: micN ? 10 * Math.log10(micSq / micN + 1e-12) : null, queued: rxLen } }));
    micSq = 0; micN = 0;
  }, 10000);
  const fakeMic = () => {
    if (micStream) return micStream;
    const ctx = new AudioContext({ sampleRate: RATE });
    const sp = ctx.createScriptProcessor(1024, 1, 1);
    let cur = null, pos = 0;
    sp.onaudioprocess = (ev) => {
      const out = ev.outputBuffer.getChannelData(0);
      for (let i = 0; i < out.length; i++) {
        if (!cur || pos >= cur.length) { cur = rxQueue.shift() || null; pos = 0; if (cur) rxLen -= cur.length; }
        out[i] = cur ? cur[pos++] / 32768 : (Math.random() - 0.5) * 1e-5;
        micSq += out[i] * out[i]; micN++;
      }
    };
    const dest = ctx.createMediaStreamDestination();
    sp.connect(dest);
    micStream = dest.stream;
    return micStream;
  };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => (c && c.audio ? Promise.resolve(fakeMic().clone()) : gum(c));

  // Émission : PTT par le pupitre, audio du modem capté au lieu des haut-parleurs du PC
  const patch = (C) => {
    if (!C || C.prototype.__station) return;
    C.prototype.__station = true;
    const tx = C.prototype.transmitSymbols;
    C.prototype.transmitSymbols = async function () {
      const m = this;
      if (!m.serialPort || m.serialPort.__station) {
        m.serialPort = { __station: true, setSignals: async (o) => { window.__stationSend(JSON.stringify({ ptt: Object.values(o)[0] === m.pttActiveHigh })); } };
      }
      const ctx = m._ensureAudioContext();
      const tap = ctx.createMediaStreamDestination();
      Object.defineProperty(ctx, 'destination', { value: tap, configurable: true });
      const cap = new AudioContext({ sampleRate: RATE });
      const src = cap.createMediaStreamSource(tap.stream);
      const sp = cap.createScriptProcessor(1024, 1, 1);
      let acc = new Int16Array(FRAME), n = 0;
      sp.onaudioprocess = (ev) => {
        const x = ev.inputBuffer.getChannelData(0);
        for (let i = 0; i < x.length; i++) {
          acc[n++] = Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767)));
          if (n === FRAME) { window.__stationSend(acc.buffer.slice(0)); n = 0; }
        }
      };
      src.connect(sp);
      sp.connect(cap.destination); // muet : il n'y a aucun signal à cet endroit du graphe
      window.__stationTx = true;
      try {
        return await tx.apply(this, arguments);
      } finally {
        window.__stationTx = false;
        delete ctx.destination;
        setTimeout(() => cap.close(), 500);
      }
    };
  };
  const t = setInterval(() => {
    if (typeof FT8Modem === 'function') { patch(FT8Modem); if (typeof FT8ModemSingle === 'function') patch(FT8ModemSingle); clearInterval(t); }
  }, 100);
}

async function autoListen(page) {
  try {
    await page.waitForSelector('#btn-listen', { timeout: 30000 });
    await page.waitForTimeout(1500);
    if (!(await page.$eval('#btn-listen', (b) => b.classList.contains('active')))) { await page.click('#btn-listen'); log('écoute lancée'); }
  } catch (e) { log('écoute : ' + e.message); }
}

function idle(page) {
  return page.evaluate(() => !window.__stationTx && !document.querySelector('.status.transmitting')
    && ![...document.querySelectorAll('.link-status')].some((e) => /attente|emission|reception en cours/i.test(e.textContent)));
}

async function cacheName() {
  try {
    const t = await (await fetch(new URL('sw.js', URL_APP), { cache: 'no-store' })).text();
    const m = /CACHE_NAME\s*=\s*['"]([^'"]+)/.exec(t);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

(async () => {
  log('station ChatMTX : ' + URL_APP + ' via le pupitre ' + PUPITRE + (NO_TX ? ' (RÉCEPTION SEULE)' : ''));
  const port = await startBridge();
  connectPupitre();
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: process.env.CHROMIUM || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
    viewport: null,
    // LocalNetworkAccessChecks : la page (https) doit joindre le pont local ws://127.0.0.1 ; ce
    // Chromium est réservé à la station et ne sert qu'à ChatMTX
    args: ['--window-size=480,900', '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    permissions: ['microphone', 'geolocation'],
    ignoreDefaultArgs: ['--mute-audio'],
  });
  await ctx.addInitScript(initScript, port);
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /\[(PTT|LINK|MIC|BALISE)\]/.test(m.text())) log('page :', m.text()); });
  page.on('pageerror', (e) => log('erreur page :', e.message));
  page.on('crash', () => { log('page plantée : PTT relâché, rechargement'); ptt(false, 'plantage'); page.reload().catch(() => {}); });
  page.on('load', () => autoListen(page));
  ctx.on('close', () => { ptt(false, 'fenêtre fermée'); setTimeout(() => process.exit(0), 300); });
  await page.goto(URL_APP);
  let version = await cacheName();
  log('version en ligne : ' + version);

  setInterval(() => {
    const p = stats.page;
    log('réception : ' + (stats.rxFrames / 30).toFixed(0) + ' trames/s, ' + dbfs(stats.rxSq, stats.rxN)
      + ' · micro ChatMTX : ' + (p && p.mic !== null ? p.mic.toFixed(0) + ' dBFS' : '—')
      + (stats.txFrames ? ' · émission : ' + stats.txFrames + ' trames' + (NO_TX ? ' captées (NON émises)' : '') : ''));
    stats.rxFrames = 0; stats.rxSq = 0; stats.rxN = 0; stats.txFrames = 0;
  }, 30000);

  setInterval(() => {
    const f = rig.state && rig.state.frequency;
    const t = 'ChatMTX — station HF IC-7300' + (rig.up ? (f ? ' · ' + (f / 1e6).toFixed(3).replace('.', ',') + ' MHz' : '') : ' · PUPITRE NON CONNECTÉ')
      + (NO_TX ? ' · RÉCEPTION SEULE' : '');
    page.evaluate((x) => { document.title = x; }, t).catch(() => {});
  }, 2000);

  setInterval(async () => {
    const v = await cacheName();
    if (!v || v === version) return;
    for (let k = 0; k < 60 && !(await idle(page).catch(() => false)); k++) await new Promise((r) => setTimeout(r, 5000));
    log('nouvelle version ' + v + ' : rechargement');
    version = v;
    ptt(false, 'mise à jour');
    await page.reload().catch((e) => log('rechargement : ' + e.message));
  }, VERSION_CHECK_MS);
})().catch((e) => { log('ARRÊT : ' + e.message); ptt(false, 'erreur'); setTimeout(() => process.exit(1), 300); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { ptt(false, 'arrêt'); setTimeout(() => process.exit(0), 300); });
}
