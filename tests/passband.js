// Efficacité selon la fréquence audio d'émission, à travers une chaîne BLU simulée :
// distorsion douce de l'étage audio (harmoniques), filtre de bande latérale
// 300-2 700 Hz à flancs raides à l'émission et à la réception, bruit dans 2 500 Hz.
// Mesure : taux de décodage par fréquence et niveau des harmoniques dans la bande.
// Usage : node tests/passband.js [essais par point, défaut 8]
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'ft8-modem.js'), 'utf8');
const ctx = { console: { log() {}, error: console.error, warn() {} }, performance, setTimeout, clearTimeout, Math, Float32Array, Float64Array,
  Uint8Array, Int32Array, Int8Array, Uint16Array, Int16Array, Array, Set, Map, Object, String, Number, Promise, Date, Infinity, NaN, isNaN, parseInt, BigInt };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.FT8=FT8;this.FT8Modem=FT8Modem;', ctx);
const { FT8, FT8Modem } = ctx;

const SR = 12000;
const LOW = 300, HIGH = 2700;          // filtre de bande latérale typique (2,4 kHz)
const A2 = 0.03, A3 = 0.03;            // distorsion douce (≈ -30 dBc par harmonique)
const N = +(process.argv[2] || 8);

function gauss() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }

// Biquads RBJ ; Butterworth d'ordre 8 = 4 sections de Q 1/(2 sin((2k-1)π/16))
function biquad(type, f0, Q) {
  const w = 2 * Math.PI * f0 / SR, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
  const b = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + al, a = [-2 * c / a0, (1 - al) / a0];
  return { b: b.map((x) => x / a0), a, z1: 0, z2: 0 };
}
function filterChain() {
  const qs = [1, 2, 3, 4].map((k) => 1 / (2 * Math.sin((2 * k - 1) * Math.PI / 16)));
  return qs.map((q) => biquad('hp', LOW, q)).concat(qs.map((q) => biquad('lp', HIGH, q)));
}
function applyFilter(x) {
  const chain = filterChain();
  const y = Float32Array.from(x);
  for (const f of chain) {
    for (let i = 0; i < y.length; i++) {
      const v = f.b[0] * y[i] + f.z1;
      f.z1 = f.b[1] * y[i] - f.a[0] * v + f.z2;
      f.z2 = f.b[2] * y[i] - f.a[1] * v;
      y[i] = v;
    }
  }
  return y;
}

/** Puissance d'une raie (Goertzel) sur tout le signal. */
function tonePower(x, f) {
  const k = 2 * Math.cos(2 * Math.PI * f / SR);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s = x[i] + k * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (x.length * x.length);
}

async function trial(f, snrDb) {
  const m = new FT8Modem({ baseFreq: f });
  const nsps = Math.round(SR * FT8.SYMBOL_PERIOD);
  const text = 'CQ TEST ' + (100 + Math.floor(Math.random() * 900));
  const raw = m.generateWaveform(FT8Modem.textToSymbols(text), SR);
  let p = 0; for (const x of raw) p += x * x; p /= raw.length;
  const tx = applyFilter(raw.map((x) => x + A2 * x * x + A3 * x * x * x)); // étage audio puis filtre TX
  const L = Math.round(SR * 20);
  const buf = new Float32Array(L);
  const sigma = Math.sqrt(p / Math.pow(10, snrDb / 10) * (SR / 2) / 2500);
  const start = L - tx.length - Math.round(SR * (1 + Math.random()));
  for (let i = 0; i < L; i++) buf[i] = sigma * gauss();
  for (let i = 0; i < tx.length; i++) buf[start + i] += tx[i];
  const rx = applyFilter(buf); // filtre RX
  Object.assign(m, { _sampleRate: SR, _nsps: nsps, _ringBuffer: rx, _ringBufferLen: L, _ringWritePos: 0, listening: true });
  m._resetRxState(); m._absWritten = L; m.analyser = null; m.onSpectrumData = null;
  const taperLen = Math.round(nsps * 0.05); m._toneWindow = new Float32Array(nsps).fill(1);
  for (let i = 0; i < taperLen; i++) { const e = 0.5 * (1 - Math.cos(Math.PI * i / taperLen)); m._toneWindow[i] = e; m._toneWindow[nsps - 1 - i] = e; }
  let got = null; m.onFrame = (fr) => { if (fr.text !== null) got = fr.text; };
  await m._attemptDecode();
  return got === text;
}

/** Harmoniques 2 et 3 d'un ton pur f qui passent le filtre d'émission (dBc). */
function harmonics(f) {
  const n = SR * 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.8 * Math.sin(2 * Math.PI * f * i / SR);
  const y = applyFilter(x.map((v) => v + A2 * v * v + A3 * v * v * v));
  const p1 = tonePower(y, f);
  const db = (h) => (h * f >= SR / 2 ? -99 : 10 * Math.log10(tonePower(y, h * f) / p1 + 1e-12));
  return { p1, h2: db(2), h3: db(3) };
}

(async () => {
  const snrs = [-16, -18, -20];
  const ref = harmonics(1500).p1;
  console.log(`Chaîne BLU simulée : filtre ${LOW}-${HIGH} Hz (Butterworth 8+8), distorsion a2=a3=${A2}, ${N} essais par point, ${SR} Hz`);
  console.log('Fréq.  atténuation  H2 dans bande  H3 dans bande   ' + snrs.map((s) => `${s} dB`.padStart(7)).join(' '));
  for (let f = 300; f <= 2700; f += 100) {
    const h = harmonics(f);
    const att = 10 * Math.log10(h.p1 / ref);
    const cells = [];
    for (const snr of snrs) {
      let ok = 0;
      for (let k = 0; k < N; k++) if (await trial(f, snr)) ok++;
      cells.push(`${ok}/${N}`.padStart(7));
    }
    const hb = (v) => (v <= -90 ? '      —' : (v.toFixed(0) + ' dBc').padStart(7));
    console.log(`${String(f).padStart(4)} Hz ${att.toFixed(1).padStart(8)} dB   ${hb(h.h2)}        ${hb(h.h3)}        ${cells.join(' ')}`);
  }
})();
