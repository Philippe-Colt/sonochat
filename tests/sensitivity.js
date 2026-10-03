// Sensibilité en conditions réelles d'écoute : flux continu passé par paquets de 4096
// échantillons à 48 kHz, passe de décodage toutes les 2 s comme l'application (capture
// décimée à 12 kHz par le même filtre), et défauts réalistes : écart d'horloge entre
// téléphones (±150 ppm : durée et fréquence), décalage de fréquence ±10 Hz, départ quelconque.
// Compare à un autre ft8-modem.js (ex. la version d'avant le décodage large bande) :
//   git show eeb6e19:ft8-modem.js > /tmp/ancien.js
//   node tests/sensitivity.js [essais par point, défaut 20] [/tmp/ancien.js]
// SNRS=-16,-18,-20 pour d'autres niveaux.
const fs = require('fs'), vm = require('vm'), path = require('path');

function load(file) {
  const ctx = { console: { log() {}, error() {}, warn() {} }, performance, setTimeout, clearTimeout, Math, Float32Array, Float64Array, Uint32Array, Uint8Array,
    Int32Array, Int8Array, Uint16Array, Int16Array, Array, Set, Map, Object, String, Number, Promise, Date, Infinity, NaN, isNaN, parseInt, BigInt };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8') + ';this.FT8=FT8;this.FT8Modem=FT8Modem;', ctx);
  return ctx;
}

const N = +(process.argv[2] || 20);
const MODEMS = [['actuel', path.join(__dirname, '..', 'ft8-modem.js')]];
if (process.env.NODEC) MODEMS.push(['actuel 48k', path.join(__dirname, '..', 'ft8-modem.js'), true]); // sans décimation
if (process.argv[3]) MODEMS.push(['comparé', process.argv[3]]);
const SNRS = (process.env.SNRS || '-14,-16,-17,-18,-19,-20').split(',').map(Number);
const CTX_RATE = 48000;

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }

/** Un essai : 40 s d'écoute, une trame quelque part dedans ; rendu : décodée ou non. */
async function trial(lib, snr, seed) {
  const { FT8, FT8Modem } = lib;
  const r = rng(seed);
  const gauss = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const text = 'TEST ' + String(10000 + Math.floor(r() * 89999));
  const ppm = (r() - 0.5) * 300e-6;          // horloge de l'émetteur
  const f0 = 1400 + (r() - 0.5) * 20;        // canal ± 10 Hz
  const tx = new FT8Modem({ baseFreq: f0 });
  // Émis à sr·(1+ppm), joué à sr : symboles un peu plus longs/courts, tons décalés d'autant
  const w = tx.generateWaveform(FT8Modem.textToSymbols(text), CTX_RATE * (1 + ppm));
  let p = 0; for (const x of w) p += x * x; p /= w.length;
  const total = CTX_RATE * 40;
  const sigma = Math.sqrt(p / Math.pow(10, snr / 10) * (CTX_RATE / 2) / 2500);
  const start = Math.floor(CTX_RATE * (8 + r() * 10));

  // Récepteur comme startListening (ancien : pas de décimation)
  const m = new FT8Modem({ baseFreq: 1400 });
  const D = FT8.RX_RATE && !lib.noDecim ? Math.max(1, Math.round(CTX_RATE / FT8.RX_RATE)) : 1;
  const sr = CTX_RATE / D;
  const nsps = Math.round(sr * FT8.SYMBOL_PERIOD);
  const len = Math.round(sr * (15 + FT8.EXTENDED_MAX_BLOCKS * FT8.EXTENDED_BLOCK_SYMBOLS * FT8.SYMBOL_PERIOD));
  Object.assign(m, { _sampleRate: sr, _nsps: nsps, _ringBuffer: new Float32Array(len), _ringBufferLen: len, _ringWritePos: 0, listening: true });
  m._resetRxState();
  if (m.setChannels && !process.env.NOCHAN) m.setChannels([1400]); // canal connu (annuaire)
  const tl = Math.round(nsps * 0.05); m._toneWindow = new Float32Array(nsps).fill(1);
  for (let i = 0; i < tl; i++) { const e = 0.5 * (1 - Math.cos(Math.PI * i / tl)); m._toneWindow[i] = e; m._toneWindow[nsps - 1 - i] = e; }
  let got = false;
  m.onFrame = (f) => { if (f.text === text) got = true; };
  const fir = D > 1 ? FT8Modem.decimationFilter(CTX_RATE, D) : new Float32Array([1]);
  const T = fir.length, hist = new Float32Array(T);
  let hpos = 0, phase = 0, n = 0, nextPass = CTX_RATE * 2;
  const chunk = new Float32Array(4096);
  while (n < total && !got) {
    for (let i = 0; i < chunk.length; i++, n++) {
      let x = sigma * gauss();
      const k = n - start;
      if (k >= 0 && k < w.length) x += w[k];
      chunk[i] = x;
    }
    for (let i = 0; i < chunk.length; i++) {
      hist[hpos] = chunk[i];
      hpos = hpos + 1 === T ? 0 : hpos + 1;
      if (++phase < D) continue;
      phase = 0;
      let acc = 0, idx = hpos;
      for (let j = 0; j < T; j++) { idx = idx === 0 ? T - 1 : idx - 1; acc += fir[j] * hist[idx]; }
      m._ringBuffer[m._ringWritePos] = acc;
      m._ringWritePos = (m._ringWritePos + 1) % len;
      m._absWritten++;
    }
    if (n >= nextPass) { nextPass += CTX_RATE * 2; await m._attemptDecode(); }
  }
  return got;
}

(async () => {
  const libs = MODEMS.map(([name, file, noDecim]) => { const l = load(file); l.noDecim = !!noDecim; return [name, l]; });
  console.log(`Flux continu 48 kHz, passe toutes les 2 s, horloge ±150 ppm, fréquence ±10 Hz, ${N} essais par point`);
  for (const snr of SNRS) {
    const cells = [];
    for (const [name, lib] of libs) {
      let ok = 0;
      for (let k = 0; k < N; k++) if (await trial(lib, snr, 1000 * (snr + 100) + k)) ok++;
      cells.push(`${name} ${String(ok).padStart(2)}/${N}`);
    }
    console.log(`${String(snr).padStart(4)} dB   ${cells.join('   ')}`);
  }
})();
