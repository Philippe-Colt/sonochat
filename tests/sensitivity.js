// Sensibilité en conditions réelles d'écoute : flux continu passé par paquets de 4096
// échantillons à 48 kHz, passe de décodage toutes les 2 s comme l'application (capture
// décimée à 12 kHz par le même filtre), et défauts réalistes : écart d'horloge entre
// téléphones (±150 ppm : durée et fréquence), décalage de fréquence ±10 Hz, départ quelconque.
// Compare à un autre ft8-modem.js (ex. la version d'avant le décodage large bande) :
//   git show eeb6e19:ft8-modem.js > /tmp/ancien.js
//   node tests/sensitivity.js [essais par point, défaut 20] [/tmp/ancien.js]
// SNRS=-16,-18,-20 pour d'autres niveaux. F0=1000 : fréquence du signal (défaut 1400).
// BRUIT=ambiant : bruit d'une pièce au lieu du bruit blanc (couplage acoustique) — bruit rose,
// brouhaha de voix, sifflements de ventilation, clics — à la même puissance que le bruit
// blanc dans la bande 300-2 800 Hz (SNR comparables).
const fs = require('fs'), vm = require('vm'), path = require('path');

function load(file) {
  const ctx = { console: { log() {}, error() {}, warn() {} }, performance, setTimeout, clearTimeout, Math, Float32Array, Float64Array, Uint32Array, Uint8Array,
    Int32Array, Int8Array, Uint16Array, Int16Array, Array, Set, Map, Object, String, Number, Promise, Date, Infinity, NaN, isNaN, parseInt, BigInt };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8') + ';this.FT8=FT8;this.FT8Modem=FT8Modem;', ctx);
  return ctx;
}

const N = +(process.argv[2] || 20);
const F0 = +(process.env.F0 || 1400);
const AMBIENT = process.env.BRUIT === 'ambiant';
// BRUIT=chemin.wav : bruit réel enregistré (ex. sortie de réception d'un poste HF), extrait
// différent à chaque essai, même puissance dans 300-2 800 Hz que le bruit blanc
const NOISE_FILE = process.env.BRUIT && /\.wav$/i.test(process.env.BRUIT) ? readWav(process.env.BRUIT) : null;

/** WAV PCM 16 bits mono → {sr, x: Float32Array}. */
function readWav(file) {
  const b = fs.readFileSync(file);
  let o = 12, fmt = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error(file + ' : WAV PCM 16 bits attendu');
      const n = Math.floor(size / 2 / fmt.ch), x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 8 + i * 2 * fmt.ch) / 32768;
      return { sr: fmt.sr, x };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error(file + ' : pas de données');
}

/** Extrait de `len` échantillons du bruit enregistré (bouclé), puissance 1 dans 300-2 800 Hz. */
function fileNoise(len, sr, r) {
  if (NOISE_FILE.sr !== sr) throw new Error('bruit enregistré à ' + NOISE_FILE.sr + ' Hz, ' + sr + ' attendu');
  const src = NOISE_FILE.x, out = new Float32Array(len);
  const off = Math.floor(r() * src.length);
  for (let i = 0; i < len; i++) out[i] = src[(off + i) % src.length];
  return normalizeBand(out, sr);
}

/**
 * Bruit ambiant de `len` échantillons à `sr` : rose + voix (complexes harmoniques à hauteur
 * glissante, formants, syllabes) + sifflements fixes + clics. Puissance totale 1 dans 300-2 800 Hz.
 */
function ambientNoise(len, sr, r) {
  const gauss = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const out = new Float32Array(len);
  // Rose (Paul Kellet)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = gauss();
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.4;
    b6 = w * 0.115926;
  }
  // Voix : 4 locuteurs
  for (let v = 0; v < 4; v++) {
    let ph = 0, f0 = 100 + r() * 150, drift = 0;
    const formants = [500 + r() * 300, 1200 + r() * 600, 2400 + r() * 400];
    const syl = 3 + r() * 2, sylPh = r() * 6.28;
    for (let i = 0; i < len; i++) {
      if (i % 480 === 0) { drift += (r() - 0.5) * 0.06; drift *= 0.98; }
      const t = i / sr;
      const fNow = f0 * (1 + 0.15 * Math.sin(2 * Math.PI * 0.4 * t + v) + drift);
      ph += 2 * Math.PI * fNow / sr;
      const env = Math.max(0, Math.sin(2 * Math.PI * syl * t + sylPh)) ** 2 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.13 * t + v * 2));
      if (env < 0.01) continue;
      let x = 0;
      for (let k = 1; k * fNow < 3500; k++) {
        const fk = k * fNow;
        let a = 0;
        for (const fm of formants) a += 1 / (1 + ((fk - fm) / 120) ** 2);
        x += a * Math.sin(k * ph) / Math.sqrt(k);
      }
      out[i] += 0.35 * env * x;
    }
  }
  // Sifflements de ventilation (2) et clics
  const whistles = [[700 + r() * 1800, 0.25], [700 + r() * 1800, 0.15]];
  for (let i = 0; i < len; i++) {
    for (const [f, a] of whistles) out[i] += a * (1 + 0.3 * Math.sin(2 * Math.PI * 0.2 * i / sr)) * Math.sin(2 * Math.PI * f * i / sr);
    if (r() < 2 / sr) for (let k = 0; k < 200 && i + k < len; k++) out[i + k] += 3 * Math.exp(-k / 30) * gauss();
  }
  return normalizeBand(out, sr);
}

/** Ramène la puissance du bruit dans 300-2 800 Hz à 1 (FFT par segments de 1 s). */
function normalizeBand(out, sr) {
  const len = out.length;
  const seg = sr, k0 = Math.round(300 * seg / sr), k1 = Math.round(2800 * seg / sr);
  const re = new Float64Array(seg);
  let band = 0, nseg = 0;
  for (let o = 0; o + seg <= len; o += seg * 4, nseg++) {
    for (let i = 0; i < seg; i++) re[i] = out[o + i];
    const pw = FFTP(re, k0, k1);
    for (let k = 0; k < pw.length; k++) band += pw[k];
  }
  // Parseval : variance dans la bande = 2·Σ|X|²/n²
  const bandVar = 2 * band / nseg / (seg * seg);
  const g = 1 / Math.sqrt(bandVar);
  for (let i = 0; i < len; i++) out[i] *= g;
  return out;
}
let FFTP = null;
const MODEMS = [['actuel', path.join(__dirname, '..', 'ft8-modem.js')]];
if (process.env.NODEC) MODEMS.push(['actuel 48k', path.join(__dirname, '..', 'ft8-modem.js'), true]); // sans décimation
// Autres versions à comparer (étiquette = nom du fichier sans extension)
for (const f of process.argv.slice(3)) MODEMS.push([path.basename(f).replace(/\.js$/, ''), f]);
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
  const f0 = F0 + (r() - 0.5) * 20;          // canal ± 10 Hz
  const tx = new FT8Modem({ baseFreq: f0 });
  // Émis à sr·(1+ppm), joué à sr : symboles un peu plus longs/courts, tons décalés d'autant
  const w = tx.generateWaveform(FT8Modem.textToSymbols(text), CTX_RATE * (1 + ppm));
  let p = 0; for (const x of w) p += x * x; p /= w.length;
  const total = CTX_RATE * 40;
  const sigma = Math.sqrt(p / Math.pow(10, snr / 10) * (CTX_RATE / 2) / 2500);
  // Bruit ambiant : même puissance que le blanc dans 300-2 800 Hz (2 500 Hz de bande)
  const sigmaBand = sigma * Math.sqrt(2500 / (CTX_RATE / 2));
  const amb = NOISE_FILE ? fileNoise(CTX_RATE * 40, CTX_RATE, rng(seed ^ 0x5a5a))
    : AMBIENT ? ambientNoise(CTX_RATE * 40, CTX_RATE, rng(seed ^ 0x5a5a)) : null;
  const start = Math.floor(CTX_RATE * (8 + r() * 10));

  // Récepteur comme startListening (ancien : pas de décimation)
  const m = new FT8Modem({ baseFreq: F0 });
  const D = FT8.RX_RATE && !lib.noDecim ? Math.max(1, Math.round(CTX_RATE / FT8.RX_RATE)) : 1;
  const sr = CTX_RATE / D;
  const nsps = Math.round(sr * FT8.SYMBOL_PERIOD);
  const len = Math.round(sr * (15 + FT8.EXTENDED_MAX_BLOCKS * FT8.EXTENDED_BLOCK_SYMBOLS * FT8.SYMBOL_PERIOD));
  Object.assign(m, { _sampleRate: sr, _nsps: nsps, _ringBuffer: new Float32Array(len), _ringBufferLen: len, _ringWritePos: 0, listening: true });
  m._resetRxState();
  if (m.setChannels && !process.env.NOCHAN) m.setChannels([F0]); // canal connu (annuaire)
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
      let x = amb ? sigmaBand * amb[n] : sigma * gauss();
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

module.exports = { ambientNoise, normalizeBand, readWav, load, rng, setFFT: (f) => { FFTP = f; } };
if (require.main === module) (async () => {
  FFTP = load(path.join(__dirname, '..', 'ft8-modem.js'))._fftPowers;
  const libs = MODEMS.map(([name, file, noDecim]) => { const l = load(file); l.noDecim = !!noDecim; return [name, l]; });
  console.log((NOISE_FILE ? 'BRUIT ENREGISTRÉ ' + path.basename(process.env.BRUIT) + ' · ' : AMBIENT ? 'BRUIT AMBIANT (rose, voix, sifflements, clics) · ' : 'Bruit blanc · ') + `signal à ${F0} Hz · ` + `Flux continu 48 kHz, passe toutes les 2 s, horloge ±150 ppm, fréquence ±10 Hz, ${N} essais par point`);
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
