// Bande son d'essai à jouer devant les téléphones (couplage acoustique) : bruit ambiant
// (tests/sensitivity.js : rose, voix, sifflements, clics) et une trame FT8 toutes les 15 s,
// de plus en plus faible. Chaque trame annonce son niveau : « PC99SNR -14 » (de PC, en l'air).
// Usage : node tests/test-audio.js [sortie.wav] [fréquence, défaut 1000]
//   BRUIT=blanc, ou BRUIT=enregistrement.wav (ex. réception d'un poste HF) ; NIVEAUX=-10,-14,...
const fs = require('fs'), path = require('path');
const { ambientNoise, normalizeBand, readWav, load, rng, setFFT } = require('./sensitivity.js');
const lib = load(path.join(__dirname, '..', 'ft8-modem.js'));
setFFT(lib._fftPowers);
const { FT8Modem } = lib;

const out = process.argv[2] || 'chatmtx-essai.wav';
const F0 = +(process.argv[3] || 1000);
const SR = 48000;
const LEVELS = (process.env.NIVEAUX || '-6,-10,-14,-16,-18,-20').split(',').map(Number);
const len = SR * (15 * LEVELS.length + 3);
const r = rng(2026);
const gauss = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };

// Bruit : puissance 1 dans 300-2 800 Hz
const file = process.env.BRUIT && /\.wav$/i.test(process.env.BRUIT) ? readWav(process.env.BRUIT) : null;
const noise = file
  ? normalizeBand(Float32Array.from({ length: len }, (_, i) => file.x[i % file.x.length]), SR)
  : process.env.BRUIT === 'blanc'
    ? Float32Array.from({ length: len }, () => gauss() / Math.sqrt(2500 / (SR / 2)))
    : ambientNoise(len, SR, r);
const tx = new FT8Modem({ baseFreq: F0 });
const mix = Float32Array.from(noise);
LEVELS.forEach((snr, k) => {
  const w = tx.generateWaveform(FT8Modem.textToSymbols('PC99SNR ' + snr), SR);
  let p = 0; for (const x of w) p += x * x; p /= w.length;
  // SNR dans 2 500 Hz : puissance du signal / puissance du bruit dans la bande (= 1)
  const a = Math.sqrt(Math.pow(10, snr / 10) / p);
  const start = Math.round(SR * (1.5 + 15 * k));
  for (let i = 0; i < w.length; i++) mix[start + i] += a * w[i];
});
let peak = 0; for (const x of mix) peak = Math.max(peak, Math.abs(x));
const g = 0.8 / peak * Math.pow(10, (+process.env.GAIN_DB || 0) / 20); // GAIN_DB=-20 : entrée micro (sortie ligne trop forte)

// WAV 16 bits mono
const buf = Buffer.alloc(44 + len * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + len * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(len * 2, 40);
for (let i = 0; i < len; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(mix[i] * g * 32767))), 44 + i * 2);
fs.writeFileSync(out, buf);
console.log(`${out} : ${(len / SR).toFixed(0)} s, trames à ${F0} Hz : ${LEVELS.map((l, k) => `${(1.5 + 15 * k).toFixed(1)} s → ${l} dB`).join(', ')}`);
