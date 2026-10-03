// Plusieurs stations FT8 simultanées sur des fréquences différentes : combien de
// trames le décodeur large bande retrouve-t-il en une passe ? Bruit dans 2 500 Hz,
// chaque station à son SNR, départs décalés d'une fraction de seconde.
// Usage : node tests/multisignal.js [essais, défaut 4]
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'ft8-modem.js'), 'utf8');
const ctx = { console: { log() {}, error: console.error, warn() {} }, performance, setTimeout, clearTimeout, Math, Float32Array, Float64Array,
  Uint8Array, Int32Array, Int8Array, Uint16Array, Int16Array, Array, Set, Map, Object, String, Number, Promise, Date, Infinity, NaN, isNaN, parseInt, BigInt };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.FT8=FT8;this.FT8Modem=FT8Modem;', ctx);
const { FT8, FT8Modem } = ctx;

const SR = 12000;
const N = +(process.argv[2] || 4);
function gauss() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }

/** n stations à freqs[i], snr[i] dB ; mode 'standard' ou 'extended'. */
async function trial(freqs, snrs, mode) {
  const L = Math.round(SR * 60);
  const buf = new Float32Array(L);
  const nsps = Math.round(SR * FT8.SYMBOL_PERIOD);
  const texts = freqs.map((f, i) => (mode === 'extended' ? 'STATION ' + i + ' MESSAGE ETENDU ' + (100 + Math.floor(Math.random() * 900)) : 'ST' + i + ' TEST ' + (100 + Math.floor(Math.random() * 900))));
  // bruit de référence : un signal d'amplitude 1 ↔ SNR 0 dB dans 2 500 Hz
  const sigma = Math.sqrt(0.5 * (SR / 2) / 2500);
  for (let i = 0; i < L; i++) buf[i] = sigma * gauss();
  freqs.forEach((f, i) => {
    const m = new FT8Modem({ baseFreq: f, volume: 1 });
    const syms = mode === 'extended' ? FT8Modem.textToExtendedSymbols(texts[i]) : FT8Modem.textToSymbols(texts[i]);
    const w = m.generateWaveform(syms, SR);
    const a = Math.pow(10, snrs[i] / 20);
    const start = L - w.length - Math.round(SR * (1 + Math.random() * 0.8));
    for (let k = 0; k < w.length; k++) buf[start + k] += a * w[k];
  });
  const m = new FT8Modem({ baseFreq: 1000 });
  Object.assign(m, { _sampleRate: SR, _nsps: nsps, _ringBuffer: buf, _ringBufferLen: L, _ringWritePos: 0, listening: true });
  m._resetRxState(); m._absWritten = L; m.analyser = null; m.onSpectrumData = null;
  const taperLen = Math.round(nsps * 0.05); m._toneWindow = new Float32Array(nsps).fill(1);
  for (let i = 0; i < taperLen; i++) { const e = 0.5 * (1 - Math.cos(Math.PI * i / taperLen)); m._toneWindow[i] = e; m._toneWindow[nsps - 1 - i] = e; }
  const got = new Set();
  m.onFrame = (fr) => { if (fr.text !== null) got.add(fr.text); };
  const t0 = performance.now();
  await m._attemptDecode();
  await m._attemptDecode(); // 2e passe : trames remises (traîne pas encore captée) et suivantes
  return { found: texts.filter((t) => got.has(t)).length, extra: [...got].filter((t) => !texts.includes(t)).length, ms: performance.now() - t0 };
}

(async () => {
  const cases = [
    ['2 stations, 60 Hz d\'écart, -10 dB', [1400, 1460], [-10, -10], 'standard'],
    ['5 stations au pas de 60 Hz, -12 dB', [1400, 1460, 1520, 1580, 1640], [-12, -12, -12, -12, -12], 'standard'],
    ['10 stations sur 500-2500 Hz, -14 dB', [520, 740, 960, 1180, 1400, 1620, 1840, 2060, 2280, 2440], Array(10).fill(-14), 'standard'],
    ['station forte (0 dB) + faible (-16 dB) à 120 Hz', [1500, 1620], [0, -16], 'standard'],
    ['2 étendus simultanés, 60 Hz, -10 dB', [1400, 1460], [-10, -10], 'extended'],
  ];
  for (const [label, freqs, snrs, mode] of cases) {
    let found = 0, extra = 0, ms = 0;
    for (let k = 0; k < N; k++) { const r = await trial(freqs, snrs, mode); found += r.found; extra += r.extra; ms += r.ms; }
    console.log(`${label.padEnd(48)} ${found}/${N * freqs.length} trames${extra ? ', ' + extra + ' fausses' : ''} · ${(ms / N / 2) | 0} ms/passe`);
  }
})();
