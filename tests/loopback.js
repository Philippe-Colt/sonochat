// Offline loopback: text -> symbols -> waveform -> (+noise, offsets) -> ring buffer -> _attemptDecode
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'ft8-modem.js'), 'utf8');
const ctx = { console: { log(){}, error: console.error, warn(){} }, performance, setTimeout, clearTimeout, Math, Float32Array, Float64Array, Uint8Array, Int32Array, Int8Array, Uint16Array, Int16Array, Array, Set, Map, Object, String, Number, Promise, Date, Infinity, NaN, isNaN, parseInt, BigInt };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.FT8=FT8;this.FT8Modem=FT8Modem;', ctx);
const { FT8, FT8Modem } = ctx;

function gauss(){ let u=0,v=0; while(!u)u=Math.random(); v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }

async function trial(text, mode, snrDb, sr, freqOff, fs2) {
  const m = new FT8Modem({ baseFreq: 1000 });
  const nsps = Math.round(sr * FT8.SYMBOL_PERIOD);
  const syms = mode === 'extended' ? FT8Modem.textToExtendedSymbols(text) : FT8Modem.textToSymbols(text);
  m.baseFreq = 1000 + freqOff;
  let wave = m.generateWaveform(syms, sr);
  m.baseFreq = 1000;
  const maxDur = 15 + FT8.EXTENDED_MAX_BLOCKS * FT8.EXTENDED_BLOCK_SYMBOLS * FT8.SYMBOL_PERIOD;
  const L = Math.round(sr * maxDur);
  const buf = new Float32Array(L);
  // signal power
  let p=0; for (const x of wave) p+=x*x; p/=wave.length;
  // SNR in 2500 Hz reference BW (WSJT-X convention)
  const noiseP = p / Math.pow(10, snrDb/10) * (sr/2) / 2500;
  const sigma = Math.sqrt(noiseP);
  const start = L - wave.length - Math.round(sr * (1.0 + Math.random()*1.5));
  for (let i=0;i<L;i++) buf[i] = sigma*gauss();
  for (let i=0;i<wave.length;i++) buf[start+i] += wave[i];
  Object.assign(m, { _sampleRate: sr, _nsps: nsps, _ringBuffer: buf, _ringBufferLen: L, _ringWritePos: 0, listening: true });
  m._resetRxState(); m._absWritten = L;
  m.analyser = null; m.onSpectrumData = null;
  // replicate window setup from _startDecoding without timers
  const taperLen = Math.round(nsps*0.05); m._toneWindow = new Float32Array(nsps).fill(1);
  for (let i=0;i<taperLen;i++){ const e=0.5*(1-Math.cos(Math.PI*i/taperLen)); m._toneWindow[i]=e; m._toneWindow[nsps-1-i]=e; }
  let got = null; m.onFrame = f => { if (f.text !== null) got = f.text; };
  const t0 = performance.now();
  await m._attemptDecode();
  return { ok: got === text, got, ms: performance.now()-t0 };
}

(async () => {
  const cases = process.argv[2] === 'quick'
    ? [['HELLO WORLD', 'standard']]
    : [['HELLO WORLD', 'standard'], ['CQ TEST 123', 'standard'], ['THIS IS A LONGER MESSAGE 42', 'extended']];
  const snrs = [10, 0, -5, -10, -14, -17, -20];
  const N = +(process.argv[3] || 6);
  for (const sr of [48000, 44100]) for (const [text, mode] of cases) {
    const row = [];
    let tms = 0;
    for (const snr of snrs) {
      let ok = 0;
      for (let k=0;k<N;k++){ const r = await trial(text, mode, snr, sr, (Math.random()-0.5)*20); if (r.ok) ok++; tms += r.ms; }
      row.push(`${snr}dB:${ok}/${N}`);
    }
    console.log(`${sr} ${mode.padEnd(8)} "${text}"  ${row.join('  ')}  avg ${(tms/(N*snrs.length))|0}ms`);
  }
})();
