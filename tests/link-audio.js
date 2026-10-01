// Test de bout en bout : deux FT8Modem réels (vrai décodeur) reliés par SonoLink
// à travers un « air » simulé : formes d'onde GFSK réelles + bruit AWGN, micro
// coupé pendant sa propre émission, passe de décodage toutes les 2 s, horloge
// virtuelle. Des pertes sont forcées en retirant une émission de ce qu'entend
// le récepteur. Usage : node tests/link-audio.js [snr_dB]   (défaut -10)
const fs = require('fs'), vm = require('vm'), path = require('path');

const ctx = { console: { log() {}, error: console.error, warn() {} }, performance, setTimeout, clearTimeout,
  Math, Float32Array, Float64Array, Uint8Array, Int32Array, Int8Array, Array, Set, Map, Object, String,
  Number, Promise, Date, Infinity, NaN, BigInt, Error, JSON };
vm.createContext(ctx);
for (const f of ['ft8-modem.js', 'arq.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('this.FT8 = FT8; this.FT8Modem = FT8Modem; this.SonoLink = SonoLink; this.SonoFrame = SonoFrame;', ctx);
const { FT8, FT8Modem, SonoLink, SonoFrame } = ctx;

const SR = 12000;                 // fréquence d'échantillonnage FT8 native, 4x plus rapide qu'à 48 kHz
const CHUNK = 0.25;               // s par bloc micro (comme onaudioprocess)
const DECODE_EVERY = 2;           // s, comme _startDecoding
const SNR = process.argv[2] !== undefined ? +process.argv[2] : -10;

function gauss() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }

function frameToSymbols(f) {   // identique à app.js
  if (f.kind === 'tele') return FT8Modem.payloadToSymbols(FT8Modem.encodeTelemetry(f.value));
  if (f.kind === 'ext') return FT8Modem.textToExtendedSymbols(f.text);
  return FT8Modem.textToSymbols(f.text);
}

function makeWorld() {
  const w = { t: 0, timers: [], nextId: 1, air: [], stations: [] };
  w.setTimer = (fn, ms) => { const id = w.nextId++; w.timers.push({ id, at: w.t + ms / 1000, fn }); return id; };
  w.clearTimer = (id) => { w.timers = w.timers.filter((x) => x.id !== id); };
  w.now = () => w.t * 1000;

  // Puissance de référence d'un signal (volume 0.8) pour calibrer le bruit
  const ref = new FT8Modem({ baseFreq: 1000 }).generateWaveform(FT8Modem.textToSymbols('REF'), SR);
  let p = 0; for (const x of ref) p += x * x; p /= ref.length;
  w.sigma = Math.sqrt(p / Math.pow(10, SNR / 10) * (SR / 2) / 2500);
  return w;
}

function makeStation(w, name) {
  const m = new FT8Modem({ baseFreq: 1000 });
  const nsps = Math.round(SR * FT8.SYMBOL_PERIOD);
  const len = Math.round(SR * (15 + FT8.EXTENDED_MAX_BLOCKS * FT8.EXTENDED_BLOCK_SYMBOLS * FT8.SYMBOL_PERIOD));
  Object.assign(m, { _sampleRate: SR, _nsps: nsps, _ringBuffer: new Float32Array(len), _ringBufferLen: len, _ringWritePos: 0, listening: true });
  m._resetRxState();
  const taper = Math.round(nsps * 0.05);
  m._toneWindow = new Float32Array(nsps).fill(1);
  for (let i = 0; i < taper; i++) { const e = 0.5 * (1 - Math.cos(Math.PI * i / taper)); m._toneWindow[i] = e; m._toneWindow[nsps - 1 - i] = e; }

  const st = { name, m, txUntil: -1, muteUntil: -1, dropNext: () => false, sent: [], rx: new Map(), txEvents: [], decoding: false };
  st.link = new SonoLink({
    now: w.now, setTimer: w.setTimer, clearTimer: w.clearTimer, ackEnabled: () => true,
    callsign: () => (name === 'A' ? 'PC' : 'K7'),
    abort: () => {},
    transmit: (frames, opts = {}) => new Promise((resolve) => {
      let t = w.t;
      frames.forEach((f, i) => {
        const wave = m.generateWaveform(frameToSymbols(f), SR);
        const deaf = w.stations.filter((o) => o !== st && o.dropNext(f)).map((o) => o.name);
        w.air.push({ from: st, start: t, wave, deaf: new Set(deaf) });
        st.sent.push({ f, start: t, deaf });
        if (opts.onProgress) w.setTimer(() => opts.onProgress(i + 1, frames.length), (t - w.t) * 1000);
        t += wave.length / SR + (i < frames.length - 1 ? FT8.MULTI_FRAME_GAP : 0);
      });
      st.txUntil = t;
      m.transmitting = true;
      w.setTimer(() => {
        m.transmitting = false;
        st.muteUntil = w.t + FT8.TX_MUTE_TAIL_MS / 1000;
        resolve({ aborted: false });
      }, (t - w.t) * 1000);
    }),
  });
  m.onFrame = (f) => st.link.handleFrame(f);
  m.onUndecoded = (i) => st.link.handleUndecoded(i);
  st.link.onRx = (ev) => st.rx.set(ev.id, ev);
  st.link.onTx = (ev) => st.txEvents.push({ t: w.t, ...ev });

  // Micro : écrit l'air (sauf pendant sa propre émission) dans le ring buffer
  st.capture = (t0, n) => {
    const muted = m.transmitting || t0 < st.muteUntil;
    for (let i = 0; i < n; i++) {
      let x = 0;
      if (!muted) {
        const t = t0 + i / SR;
        x = w.sigma * gauss();
        for (const a of w.air) {
          if (a.from === st || a.deaf.has(st.name)) continue;
          const k = Math.round((t - a.start) * SR);
          if (k >= 0 && k < a.wave.length) x += a.wave[k];
        }
      }
      m._ringBuffer[m._ringWritePos] = x;
      m._ringWritePos = (m._ringWritePos + 1) % m._ringBufferLen;
    }
    m._absWritten += n;
  };
  w.stations.push(st);
  return st;
}

async function run(w, until, maxT) {
  const n = Math.round(CHUNK * SR);
  let nextDecode = w.t + DECODE_EVERY;
  while (!until() && w.t < maxT) {
    const tNext = w.t + CHUNK;
    // minuteurs du protocole échus dans ce pas
    for (;;) {
      w.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!w.timers.length || w.timers[0].at > tNext) break;
      const x = w.timers.shift();
      w.t = Math.max(w.t, x.at);
      x.fn();
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    }
    for (const st of w.stations) st.capture(tNext - CHUNK, n);
    w.t = tNext;
    if (w.t >= nextDecode) {
      nextDecode += DECODE_EVERY;
      for (const st of w.stations) if (!st.m.transmitting) await st.m._attemptDecode();
    }
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    w.air = w.air.filter((a) => a.start + a.wave.length / SR > w.t - 200);
  }
}

async function exchange(text, mode, setup, ack = true) {
  const w = makeWorld();
  const A = makeStation(w, 'A'), B = makeStation(w, 'B');
  if (setup) setup(A, B);
  // 3 s de bruit avant l'envoi
  await run(w, () => false, 3);
  let result = null;
  A.link.send(text, mode, { ack }).then((r) => { result = r; });
  await run(w, () => result !== null, 1200);
  await run(w, () => false, w.t + 30);   // derniers accusés éventuels
  return { w, A, B, result };
}

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || !detail ? '' : '  → ' + detail));
  if (!cond) failures++;
}
const done = (st) => [...st.rx.values()].filter((e) => e.done);
const summary = ({ w, A, B, result }) => `${result.status} en ${w.t.toFixed(0)} s, ${A.txEvents.filter((e) => e.state === 'retry').length} répétition(s), B a émis ${B.sent.length} trame(s)`;

(async () => {
  console.log(`SNR ${SNR} dB (réf. 2500 Hz), ${SR} Hz`);
  // Comme app.js : indicatif court de l'émetteur (A = PC) en tête du message
  const LONG = 'PCCQ CQ DE F4MTX TEST ARQ MULTI TRAME 73';
  const EXT = 'PCMESSAGE ETENDU DE BOUT EN BOUT 42';

  {
    const r = await exchange('PCHELLO WORLD', 'standard');
    console.log('Standard : ' + summary(r));
    check('confirmé par K7', r.result.status === 'confirmed' && r.result.by === 'K7', JSON.stringify(r.result));
    check('reçu une fois, intact, indicatif PC en tête', done(r.B).length === 1 && done(r.B)[0].text === 'PCHELLO WORLD', done(r.B).map((e) => e.text).join(' | '));
    check('A ne s\'est pas décodé lui-même', done(r.A).length === 0, done(r.A).map((e) => e.text).join(' | '));
  }
  {
    let dataLost = 0, ackLost = 0;
    const r = await exchange(LONG, 'multi-frame', (A, B) => {
      // trame 3 perdue une fois, accusé de la trame 2 perdu une fois
      B.dropNext = (f) => f.kind === 'tele' && (() => { const d = SonoFrame.parse(f.value); return d.type === 'data' && d.seq === 2 && dataLost++ === 0; })();
      A.dropNext = (f) => f.kind === 'tele' && (() => { const d = SonoFrame.parse(f.value); return d.type === 'ack' && d.seq === 1 && ackLost++ === 0; })();
    });
    console.log('Multi-trame (trame 3 et accusé 2 perdus) : ' + summary(r));
    check('confirmé par K7', r.result.status === 'confirmed' && r.result.by === 'K7', JSON.stringify(r.result));
    check('2 répétitions', r.A.txEvents.filter((e) => e.state === 'retry').length === 2);
    check('reçu une fois, intact', done(r.B).length === 1 && done(r.B)[0].text === LONG, [...r.B.rx.values()].map((e) => e.text).join(' | '));
  }
  {
    const r = await exchange(EXT, 'extended');
    console.log('Étendu : ' + summary(r));
    check('confirmé par K7', r.result.status === 'confirmed' && r.result.by === 'K7', JSON.stringify(r.result));
    check('reçu une fois, intact', done(r.B).length === 1 && done(r.B)[0].text === EXT, [...r.B.rx.values()].map((e) => e.text).join(' | '));
    const aEnd = r.A.sent[0].start + FT8Modem.estimateDuration(EXT, 'extended');
    check('accusé après la fin de l\'émission', r.B.sent.length === 1 && r.B.sent[0].start >= aEnd, r.B.sent.map((s) => s.start.toFixed(1)).join(',') + ' vs ' + aEnd.toFixed(1));
  }
  {
    let n = 0;
    const r = await exchange(EXT, 'extended', (A, B) => {
      B.dropNext = (f) => f.kind === 'ext' && n++ === 0;   // 1re émission entière perdue
    });
    console.log('Étendu (1re émission perdue) : ' + summary(r));
    check('confirmé au 2e envoi', r.result.status === 'confirmed' && r.A.txEvents.filter((e) => e.state === 'retry').length === 1, JSON.stringify(r.result));
    check('reçu une fois, intact', done(r.B).length === 1 && done(r.B)[0].text === EXT);
  }

  {
    // Diffusion sans accusé : rafale de 13 trames dans le buffer. L'ancien
    // décodeur n'essayait que les 2 meilleurs candidats du buffer entier.
    const TEXT130 = 'DIFFUSION SANS ACCUSE. TREIZE TRAMES DE DIX CARACTERES EMISES EN RAFALE. ' +
      'CHACUNE DOIT ETRE DECODEE UNE FOIS ET UNE SEULE 1234567';
    const r = await exchange(TEXT130.substring(0, 130), 'multi-frame', null, false);
    console.log('Diffusion 130 car. (13 trames) : ' + summary(r));
    const m = [...r.B.rx.values()];
    check('envoyé', r.result.status === 'sent');
    check('13 trames décodées, message complet une fois', m.length === 1 && m[0].done && m[0].frames === 13 && m[0].text === TEXT130.substring(0, 130).trimEnd(),
      m.map((e) => e.frames + ' trames: ' + e.text).join(' | '));
    check('le récepteur n\'émet rien', r.B.sent.length === 0);
  }

  console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
  process.exit(failures ? 1 : 0);
})();
