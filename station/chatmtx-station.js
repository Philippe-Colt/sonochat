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
// Essai (réception seule) : la page émet une trame de test, l'audio qui serait parti au pupitre
// est enregistré dans ce WAV (12 kHz) pour être décodé hors ligne
const TX_WAV = NO_TX && process.env.SELFTEST === '1' ? (process.env.TX_WAV || '/tmp/chatmtx-station-tx.wav') : null;
const txRecord = [];
// Chaque émission réelle est enregistrée telle qu'envoyée au pupitre (donc au poste), mesurée et
// décodée par ChatMTX : preuve de la BF qui part ; les 5 dernières sont gardées
const TX_DIR = path.join(os.homedir(), '.local', 'share', 'chatmtx-station', 'emissions');
let txSent = [];

/** Décode un enregistrement 12 kHz avec le modem du dépôt : textes trouvés. */
async function decodeRecording(frames) {
  const vm = require('vm');
  const ctx = { console: { log() {}, error() {}, warn() {} }, performance, setTimeout, clearTimeout, Math, Float32Array, Float64Array,
    Uint32Array, Uint8Array, Int32Array, Int8Array, Uint16Array, Int16Array, Array, Set, Map, Object, String, Number, Promise, Date, Infinity, NaN, isNaN, parseInt, BigInt };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ft8-modem.js'), 'utf8') + ';this.FT8Modem=FT8Modem;', ctx);
  const pcm = Buffer.concat(frames), n = pcm.length >> 1, SR = 12000, nsps = 1920;
  const L = n + SR * 4, buf = new Float32Array(L);
  for (let i = 0; i < n; i++) buf[SR * 2 + i] = pcm.readInt16LE(i * 2) / 32768;
  const m = new ctx.FT8Modem({ baseFreq: 1000 });
  Object.assign(m, { _sampleRate: SR, _nsps: nsps, _ringBuffer: buf, _ringBufferLen: L, _ringWritePos: 0, listening: true });
  m._resetRxState(); m._absWritten = L; m._toneWindow = new Float32Array(nsps).fill(1);
  const got = [];
  m.onFrame = (f) => got.push((f.text || f.ham || ('télémétrie ' + f.telemetry)) + ' @' + Math.round(f.freq) + ' Hz');
  await m._attemptDecode();
  return got;
}

async function checkEmission(frames) {
  if (!frames.length) return;
  let pk = 0, sq = 0, n = 0;
  for (const f of frames) for (let i = 0; i + 1 < f.length; i += 2) { const v = f.readInt16LE(i) / 32768; pk = Math.max(pk, Math.abs(v)); sq += v * v; n++; }
  fs.mkdirSync(TX_DIR, { recursive: true });
  const file = path.join(TX_DIR, 'emission-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.wav');
  writeWav(file, frames, 12000);
  const old = fs.readdirSync(TX_DIR).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 5))) fs.unlinkSync(path.join(TX_DIR, f));
  const dec = await decodeRecording(frames).catch((e) => ['erreur : ' + e.message]);
  log('BF envoyée au poste : ' + (n / 12000).toFixed(2) + ' s, crête ' + (20 * Math.log10(pk + 1e-9)).toFixed(1) + ' dBFS, efficace '
    + (10 * Math.log10(sq / n + 1e-12)).toFixed(1) + ' dBFS · décodée : ' + (dec.length ? dec.join(' | ') : 'RIEN') + ' · ' + file);
}

function writeWav(file, frames, rate) {
  const pcm = Buffer.concat(frames), b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([b, pcm]));
}
const PTT_MAX_MS = 130000;
const VERSION_CHECK_MS = 5 * 60000;
const PROFILE = path.join(os.homedir(), '.local', 'share', 'chatmtx-station');
const ACCOUNT = path.join(os.homedir(), '.config', 'chatmtx-station', 'compte.json');
// Session du pupitre gardée (7 jours) : se reconnecter à chaque démarrage épuisait la limite de
// 5 connexions par quart d'heure, et chaque nouvel essai prolongeait le blocage
const SESSION = path.join(os.homedir(), '.config', 'chatmtx-station', 'session');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------- Pupitre ----------------

const rig = { cookie: '', state: null, stateWs: null, rxWs: null, txWs: null, ptt: false, pttTimer: null, pttSince: 0, up: false };
let pageSock = null; // WebSocket de la page (pont local)
const stats = { rxFrames: 0, rxSq: 0, rxN: 0, txFrames: 0, page: null };
const dbfs = (sq, n) => (n ? (10 * Math.log10(sq / n + 1e-12)).toFixed(0) + ' dBFS' : '—');

async function login() {
  // Session gardée encore valable ?
  try {
    const saved = fs.readFileSync(SESSION, 'utf8').trim();
    if (saved && await sessionValid(saved)) { rig.cookie = saved; return; }
  } catch (e) { /* pas de session gardée */ }
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
  fs.writeFileSync(SESSION, rig.cookie, { mode: 0o600 });
}

/** La session répond-elle (WebSocket d'état accepté, pas fermé en 4401) ? */
function sessionValid(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl('/ws/state'), { headers: { Cookie: cookie } });
    const t = setTimeout(() => { ws.terminate(); resolve(false); }, 4000);
    ws.on('message', () => { clearTimeout(t); ws.close(); resolve(true); });
    ws.on('close', () => { clearTimeout(t); resolve(false); });
    ws.on('error', () => { clearTimeout(t); resolve(false); });
  });
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
    // Refus pour trop de tentatives : attendre la fin du blocage (15 min) sans le prolonger
    const wait = /trop de tentatives|429/.test(e.message) ? 16 * 60000 : 30000;
    log('pupitre : ' + e.message + ' — nouvel essai dans ' + Math.round(wait / 1000) + ' s');
    setTimeout(connectPupitre, wait);
    return;
  }
  const st = openWs('/ws/state');
  rig.stateWs = st;
  st.on('message', (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === 'state') {
        const was = rig.state && rig.state.present;
        rig.state = { ...(rig.state || {}), ...m };
        // Pendant l'émission : maximum des instruments du poste (preuve que la BF module)
        if (rig.ptt && rig.meters) {
          for (const k of ['po', 'alc', 'swr']) if (typeof m[k] === 'number') rig.meters[k] = Math.max(rig.meters[k] || 0, m[k]);
          if (m.mode) rig.meters.mode = m.mode;
        }
        if ('present' in m && m.present !== was) log(m.present ? 'poste joint par le pupitre' : 'poste NON joint par le pupitre (CI-V)');
      }
    } catch (e) { /* ignoré */ }
  });
  st.on('open', () => { rig.up = true; log('pupitre connecté'); });
  st.on('close', (code) => {
    rig.up = false;
    if (code === 4401) { try { fs.unlinkSync(SESSION); } catch (e) { /* déjà absente */ } }
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
  if (NO_TX) {
    if (on) log('PTT demandé (NO_TX : pas d\'émission)');
    else if (TX_WAV && txRecord.length) {
      setTimeout(() => { writeWav(TX_WAV, txRecord, 12000); log('essai : ' + txRecord.length + ' trames captées → ' + TX_WAV); txRecord.length = 0; }, 800);
    }
    return;
  }
  clearTimeout(rig.pttTimer);
  if (on && !rig.ptt) {
    if (!rig.up) { log('PTT refusé : pupitre non connecté'); return; }
    if (rig.state && rig.state.present === false) {
      log('PTT refusé : le pupitre ne joint pas le poste (CI-V : débit 19200 ou Auto, adresse 94h)');
      return;
    }
    rig.txWs = openWs('/ws/tx');
    rig.txWs.on('error', () => {});
    sendState({ action: 'ptt', on: true });
    rig.ptt = true;
    rig.pttSince = Date.now();
    rig.meters = { mode: rig.state && rig.state.mode };
    txSent = [];
    rig.pttTimer = setTimeout(() => { log('PTT : 130 s, relâché d\'office'); ptt(false, 'minuteur'); }, PTT_MAX_MS);
    log('PTT ON' + (why ? ' (' + why + ')' : ''));
  } else if (!on && rig.ptt) {
    releasePending = false;
    sendState({ action: 'ptt', on: false });
    rig.ptt = false;
    const tx = rig.txWs;
    rig.txWs = null;
    if (tx) setTimeout(() => tx.close(), 200); // fermer le canal fait aussi retomber l'alternat
    const mt = rig.meters || {};
    const sent = txSent;
    txSent = [];
    setTimeout(() => checkEmission(sent), 100);
    log('PTT OFF' + (why ? ' (' + why + ')' : '') + ' après ' + ((Date.now() - rig.pttSince) / 1000).toFixed(1) + ' s · mode '
      + (mt.mode || '?') + ' · Po max ' + (mt.po !== undefined ? mt.po : '?') + ' · ALC max ' + (mt.alc !== undefined ? mt.alc : '?')
      + ' · ROS max ' + (mt.swr !== undefined ? mt.swr : '?')
      + (mt.po === 0 ? ' — AUCUNE PUISSANCE : mode, source de modulation (DATA MOD = USB) ou niveau USB MOD à vérifier' : ''));
  }
}

// ---------------- Émission cadencée ----------------
// La page livre les trames par à-coups (fil principal) : on les rejoue vers le pupitre au
// rythme exact d'une trame toutes les 10 ms, après 0,3 s d'avance, et le PTT n'est relâché
// qu'une fois la file vidée (sinon la fin de la trame FT8 serait coupée).
const txQueue = [];
let txPrimed = false, txNext = 0, releasePending = false;
function txPump() {
  if (!rig.ptt) { txQueue.length = 0; txPrimed = false; return; }
  const now = Date.now();
  if (!txPrimed) {
    if (txQueue.length < 30 && !releasePending) return;
    txPrimed = true;
    txNext = now;
  }
  while (txNext <= now && txQueue.length) {
    const f = txQueue.shift();
    if (rig.txWs && rig.txWs.readyState === 1) { rig.txWs.send(f); stats.txFrames++; txSent.push(Buffer.from(f)); }
    txNext += 10;
  }
  if (txNext < now - 50) txNext = now; // retard de livraison : on reprend la cadence
  if (releasePending && !txQueue.length) { releasePending = false; txPrimed = false; ptt(false, 'ChatMTX'); }
}
setInterval(txPump, 5);

function releaseAfterDrain() {
  if (!rig.ptt) return;
  releasePending = true;
}

// ---------------- Pont local page ↔ lanceur ----------------

function startBridge() {
  return new Promise((resolve) => {
    const srv = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    srv.on('connection', (sock) => {
      pageSock = sock;
      sock.on('message', (d, isBinary) => {
        if (isBinary) { // trame d'émission (PCM 16 bits 12 kHz, 10 ms)
          if (NO_TX) { stats.txFrames++; if (TX_WAV) txRecord.push(Buffer.from(d)); return; } // essai : captée, jamais émise
          if (rig.ptt) txQueue.push(d);
          return;
        }
        try {
          const m = JSON.parse(d.toString());
          if ('ptt' in m) {
            if (m.ptt) ptt(true, 'ChatMTX');
            else if (NO_TX) ptt(false, 'ChatMTX');
            else releaseAfterDrain();
          }
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
  const RATE = 12000;
  // Traitement audio sur le fil audio (AudioWorklet) : un ScriptProcessor sur le fil principal
  // perdait la moitié des échantillons pendant les passes de décodage (trame trouée sur l'air)
  const WORKLET = `
    class RxSrc extends AudioWorkletProcessor {
      constructor() {
        super();
        this.q = []; this.cur = null; this.pos = 0; this.len = 0; this.started = false; this.sq = 0; this.n = 0;
        this.port.onmessage = (e) => {
          const s = e.data; this.q.push(s); this.len += s.length;
          while (this.len > 2 * ${RATE}) this.len -= this.q.shift().length; // au plus 2 s de retard
        };
      }
      process(_, outputs) {
        const out = outputs[0][0];
        // Démarre avec 0,5 s d'avance : absorbe les à-coups de livraison du fil principal
        if (!this.started && this.len >= ${RATE} / 2) this.started = true;
        for (let i = 0; i < out.length; i++) {
          if (this.started && (!this.cur || this.pos >= this.cur.length)) {
            this.cur = this.q.shift() || null; this.pos = 0;
            if (this.cur) this.len -= this.cur.length; else this.started = false;
          }
          out[i] = this.started && this.cur ? this.cur[this.pos++] / 32768 : (Math.random() - 0.5) * 1e-5;
          this.sq += out[i] * out[i]; this.n++;
        }
        if (this.n >= ${RATE} * 10) { this.port.postMessage({ level: 10 * Math.log10(this.sq / this.n + 1e-12), queued: this.len }); this.sq = 0; this.n = 0; }
        return true;
      }
    }
    class TxCap extends AudioWorkletProcessor {
      constructor() { super(); this.acc = new Int16Array(120); this.n = 0; } // 120 échantillons = 10 ms = trame du pupitre (240 octets)
      process(inputs) {
        const x = inputs[0] && inputs[0][0];
        if (!x) return true;
        for (let i = 0; i < x.length; i++) {
          this.acc[this.n++] = Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767)));
          if (this.n === 120) { this.port.postMessage(this.acc.buffer, [this.acc.buffer]); this.acc = new Int16Array(120); this.n = 0; }
        }
        return true;
      }
    }
    registerProcessor('rx-src', RxSrc);
    registerProcessor('tx-cap', TxCap);`;
  const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));

  let sock = null, rxNode = null;
  const connect = () => {
    sock = new WebSocket('ws://127.0.0.1:' + port);
    sock.binaryType = 'arraybuffer';
    sock.onmessage = (e) => {
      if (typeof e.data === 'string' || !rxNode) return;
      const s = new Int16Array(e.data);
      rxNode.port.postMessage(s, [s.buffer]);
    };
    sock.onclose = () => setTimeout(connect, 2000);
  };
  connect();
  const send = (x) => { if (sock && sock.readyState === 1) sock.send(x); };

  // Faux micro : la réception du poste (12 kHz) ; souffle infime quand rien n'arrive (pendant
  // l'émission le pupitre n'envoie rien : pas de « micro coupé » à tort)
  let micReady = null;
  const fakeMic = () => {
    if (micReady) return micReady;
    micReady = (async () => {
      const ctx = new AudioContext({ sampleRate: RATE });
      await ctx.audioWorklet.addModule(workletUrl);
      rxNode = new AudioWorkletNode(ctx, 'rx-src');
      rxNode.port.onmessage = (e) => send(JSON.stringify({ stat: { mic: e.data.level, queued: e.data.queued } }));
      const dest = ctx.createMediaStreamDestination();
      rxNode.connect(dest);
      ctx.resume();
      return dest.stream;
    })();
    return micReady;
  };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => (c && c.audio ? fakeMic().then((s) => s.clone()) : gum(c));

  // Captation de l'émission : contexte et module préparés une fois
  let capReady = null;
  const capture = () => {
    if (capReady) return capReady;
    capReady = (async () => {
      const cap = new AudioContext({ sampleRate: RATE });
      await cap.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(cap, 'tx-cap');
      node.port.onmessage = (e) => send(e.data);
      node.connect(cap.destination); // muet : la sortie du processeur est vide
      cap.resume();
      return { cap, node };
    })();
    return capReady;
  };

  // Émission : PTT par le pupitre, audio du modem capté au lieu des haut-parleurs du PC
  const patch = (C) => {
    if (!C || C.prototype.__station) return;
    C.prototype.__station = true;
    const tx = C.prototype.transmitSymbols;
    C.prototype.transmitSymbols = async function () {
      const m = this;
      if (!m.serialPort || m.serialPort.__station) {
        m.serialPort = { __station: true, setSignals: async (o) => { send(JSON.stringify({ ptt: Object.values(o)[0] === m.pttActiveHigh })); } };
      }
      const { cap, node } = await capture();
      const ctx = m._ensureAudioContext();
      const tap = ctx.createMediaStreamDestination();
      Object.defineProperty(ctx, 'destination', { value: tap, configurable: true });
      const src = cap.createMediaStreamSource(tap.stream);
      src.connect(node);
      window.__stationTx = true;
      try {
        return await tx.apply(this, arguments);
      } finally {
        window.__stationTx = false;
        delete ctx.destination;
        setTimeout(() => src.disconnect(), 300);
      }
    };
  };
  const t = setInterval(() => {
    if (typeof FT8Modem === 'function') { patch(FT8Modem); if (typeof FT8ModemSingle === 'function') patch(FT8ModemSingle); clearInterval(t); }
  }, 100);
}

// ---------------- Écran partagé (ChatMTX distant, par le pupitre) ----------------
// Serveur local seulement : le pupitre (telec-icom, /ws/chatmtx) authentifie les comptes et s'y
// relaie en indiquant « control=1 » pour ceux qui ont le droit d'émettre. Image : capture CDP de
// la page, 5 images/s au plus, partagée, arrêtée sans spectateur. Entrées : coordonnées 0-1.
const SCREEN_PORT = +(process.env.SCREEN_PORT || 8791);
const SCREEN_FPS_MS = 200;
const KEYS = new Set(['Enter', 'Backspace', 'Escape', 'Tab', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function startScreen(page) {
  const clients = new Set();
  let cdp = null, casting = false, last = 0, pending = null, timer = null, size = { w: 480, h: 900 }, lastActor = '', lastActAt = 0;
  const broadcast = (msg) => { const t = JSON.stringify(msg); for (const c of clients) if (c.readyState === 1) c.send(t); };
  const sendFrame = (f) => { last = Date.now(); pending = null; broadcast(f); };
  async function start() {
    if (casting) return;
    casting = true;
    try {
      cdp = cdp || await page.context().newCDPSession(page);
      cdp.removeAllListeners('Page.screencastFrame');
      cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        size = { w: metadata.deviceWidth, h: metadata.deviceHeight };
        const f = { t: 'frame', data, w: size.w, h: size.h };
        const wait = SCREEN_FPS_MS - (Date.now() - last);
        if (wait <= 0) sendFrame(f);
        else { pending = f; if (!timer) timer = setTimeout(() => { timer = null; if (pending) sendFrame(pending); }, wait); }
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 });
    } catch (e) { casting = false; log('écran partagé : ' + e.message); }
  }
  async function stop() {
    if (!casting) return;
    casting = false;
    if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  }
  async function snapshot(sock) { // image immédiate : une page immobile ne produit pas d'image
    try {
      const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      const data = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
      if (sock.readyState === 1) sock.send(JSON.stringify({ t: 'frame', data, w: vp.w, h: vp.h }));
    } catch (e) { /* page en rechargement */ }
  }
  async function input(sock, d) {
    let m;
    try { m = JSON.parse(d.toString()); } catch (e) { return; }
    if (!sock.control) return; // le pupitre ne relaie pas les entrées sans droit d'émettre ; double garde
    if (Date.now() - lastActAt > 30000 || lastActor !== sock.who) log('ChatMTX distant : ' + sock.who + ' agit sur la station');
    lastActor = sock.who; lastActAt = Date.now();
    const X = (v) => Math.max(0, Math.min(1, +v || 0)) * size.w, Y = (v) => Math.max(0, Math.min(1, +v || 0)) * size.h;
    try {
      if (m.t === 'tap') await page.mouse.click(X(m.x), Y(m.y));
      else if (m.t === 'down') { await page.mouse.move(X(m.x), Y(m.y)); await page.mouse.down(); }
      else if (m.t === 'move') await page.mouse.move(X(m.x), Y(m.y));
      else if (m.t === 'up') { await page.mouse.move(X(m.x), Y(m.y)); await page.mouse.up(); }
      else if (m.t === 'wheel') { await page.mouse.move(X(m.x), Y(m.y)); await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, +m.dy || 0))); }
      else if (m.t === 'text' && typeof m.s === 'string') await page.keyboard.insertText(m.s.slice(0, 200));
      else if (m.t === 'key' && KEYS.has(m.k)) await page.keyboard.press(m.k);
    } catch (e) { /* page en rechargement */ }
  }
  const srv = new WebSocket.Server({ host: '127.0.0.1', port: SCREEN_PORT });
  srv.on('connection', (sock, req) => {
    const q = new URL(req.url, 'http://local').searchParams;
    sock.control = q.get('control') === '1';
    sock.who = (q.get('user') || '?').slice(0, 80);
    clients.add(sock);
    log('ChatMTX distant : ' + sock.who + ' connecté (' + (sock.control ? 'contrôle' : 'lecture seule') + ', ' + clients.size + ' spectateur(s))');
    snapshot(sock);
    start();
    sock.on('message', (d) => input(sock, d));
    sock.on('close', () => {
      clients.delete(sock);
      log('ChatMTX distant : ' + sock.who + ' déconnecté');
      if (!clients.size) stop();
    });
    sock.on('error', () => {});
  });
  srv.on('error', (e) => log('écran partagé indisponible : ' + e.message));
  page.on('load', () => { if (casting) { casting = false; start(); } }); // rechargement : capture relancée
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
    viewport: { width: 480, height: 900 }, // format téléphone fixe : le profil mémorisait une autre taille
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
  startScreen(page);
  ctx.on('close', () => { ptt(false, 'fenêtre fermée'); setTimeout(() => process.exit(0), 300); });
  await page.goto(URL_APP);
  if (TX_WAV) {
    // Auto-essai : une trame standard émise par un modem de la page (prototype patché)
    setTimeout(() => page.evaluate(() => {
      const m = new FT8Modem({ baseFreq: 1000 });
      return m.transmitSymbols([FT8Modem.textToSymbols('ESSAI STATION')]);
    }).then(() => log('essai : émission terminée côté page')).catch((e) => log('essai : ' + e.message)), 8000);
  }
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
    const absent = rig.up && rig.state && rig.state.present === false;
    const t = 'ChatMTX — station HF IC-7300' + (!rig.up ? ' · PUPITRE NON CONNECTÉ' : absent ? ' · POSTE NON JOIGNABLE (CI-V)'
      : f ? ' · ' + (f / 1e6).toFixed(3).replace('.', ',') + ' MHz' : '')
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
