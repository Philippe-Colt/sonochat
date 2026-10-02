// Test du séquencement PTT (FT8Modem.transmitSymbols) et de l'adaptateur natif
// NativePttPort. Faux port série et fausse lecture audio, temps réel court.
// Usage : node tests/ptt-timing.js
const fs = require('fs'), vm = require('vm'), path = require('path');

const ctx = { console: { log() {}, error: console.error, warn() {} }, performance, setTimeout, clearTimeout,
  Math, Float32Array, Float64Array, Uint8Array, Int32Array, Int8Array, Array, Set, Map, Object, String,
  Number, Promise, Date, Infinity, NaN, BigInt, Error, JSON };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ft8-modem.js'), 'utf8') + ';this.FT8Modem = FT8Modem;', ctx);
const { FT8Modem } = ctx;
const { NativePttPort } = require('../native-serial.js');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

const PLAY_MS = 120;

function makeModem(log, t0) {
  const m = new FT8Modem({ baseFreq: 1000 });
  m.pttLeadMs = 100;
  m.pttTailMs = 150;
  m.serialPort = { setSignals: async (s) => { log.push({ ev: 'signals', s, t: performance.now() - t0 }); } };
  m._ensureAudioContext = () => ({ sampleRate: 12000 });
  m.generateWaveform = () => new Float32Array(1);
  m._playWaveform = () => new Promise((resolve) => {
    log.push({ ev: 'play', t: performance.now() - t0 });
    const timer = setTimeout(() => { m._txSource = null; log.push({ ev: 'end', t: performance.now() - t0 }); resolve(); }, PLAY_MS);
    m._txSource = { stop: () => { clearTimeout(timer); m._txSource = null; log.push({ ev: 'stopped', t: performance.now() - t0 }); resolve(); } };
  });
  return m;
}

(async () => {
  console.log('Séquencement PTT');
  {
    const log = [], t0 = performance.now();
    const m = makeModem(log, t0);
    const r = await m.transmitSymbols([new Uint8Array(79)]);
    const on = log.find((e) => e.ev === 'signals' && e.s.requestToSend === true);
    const play = log.find((e) => e.ev === 'play');
    const end = log.find((e) => e.ev === 'end');
    const off = log.find((e) => e.ev === 'signals' && e.s.requestToSend === false);
    check('ordre : PTT on → son → fin → PTT off', on && play && end && off && on.t <= play.t && play.t <= end.t && end.t <= off.t, log.map((e) => e.ev));
    check('avance ≥ 100 ms', play.t - on.t >= 95, (play.t - on.t).toFixed(0));
    check('maintien ≥ 150 ms', off.t - end.t >= 145, (off.t - end.t).toFixed(0));
    check('pas annulé', r.aborted === false && m.transmitting === false);
  }
  {
    const log = [], t0 = performance.now();
    const m = makeModem(log, t0);
    const p = m.transmitSymbols([new Uint8Array(79)]);
    await new Promise((r) => setTimeout(r, 150)); // pendant le son
    await m.cancelTransmit();
    const r = await p;
    const stopped = log.find((e) => e.ev === 'stopped');
    const off = log.find((e) => e.ev === 'signals' && e.s.requestToSend === false);
    check('annulation : signalée', r.aborted === true);
    check('annulation : PTT relâché sans maintien', stopped && off && off.t - stopped.t < 40, off && stopped && (off.t - stopped.t).toFixed(0));
  }
  {
    const log = [], t0 = performance.now();
    const m = makeModem(log, t0);
    m.serialPort = null; // VOX ou pas de PTT série : aucun délai ajouté
    const before = performance.now();
    await m.transmitSymbols([new Uint8Array(79)]);
    check('sans port série : pas d\'avance ni de maintien', performance.now() - before < PLAY_MS + 60, (performance.now() - before).toFixed(0));
  }
  {
    const log = [], t0 = performance.now();
    const m = makeModem(log, t0);
    m.pttSignal = 'DTR';
    m.pttActiveHigh = false;
    await m.transmitSymbols([new Uint8Array(79)]);
    const sig = log.filter((e) => e.ev === 'signals').map((e) => e.s);
    check('DTR, actif bas : on = false, off = true', sig.length === 2 && sig[0].dataTerminalReady === false && sig[1].dataTerminalReady === true, sig);
  }
  console.log('PTT par tonalité (VOX)');
  // Faux AudioContext : journalise le démarrage et l'arrêt de la tonalité
  function voxCtx(log, t0, channels = 2) {
    const node = () => ({ connect() {}, disconnect() {} });
    return {
      sampleRate: 12000,
      destination: { maxChannelCount: channels },
      createChannelMerger: node,
      createGain: () => ({ ...node(), gain: { value: 0 } }),
      createOscillator: () => ({ ...node(), frequency: { value: 0 },
        start() { log.push({ ev: 'tone-on', f: this.frequency.value, t: performance.now() - t0 }); },
        stop() { log.push({ ev: 'tone-off', t: performance.now() - t0 }); } }),
    };
  }
  {
    const log = [], t0 = performance.now();
    const m = makeModem(log, t0);
    m.serialPort = null;
    m.voxTone = true;
    const c = voxCtx(log, t0);
    m._ensureAudioContext = () => c;
    await m.transmitSymbols([new Uint8Array(79), new Uint8Array(79)], { gap: 0.05 });
    const ev = log.map((e) => e.ev);
    const on = log.find((e) => e.ev === 'tone-on'), off = log.find((e) => e.ev === 'tone-off');
    const plays = log.filter((e) => e.ev === 'play'), ends = log.filter((e) => e.ev === 'end');
    check('tonalité → 2 trames → arrêt, une seule tonalité', JSON.stringify(ev) === JSON.stringify(['tone-on', 'play', 'end', 'play', 'end', 'tone-off']), ev);
    check('tonalité à 2000 Hz', on && on.f === 2000, on && on.f);
    check('avance ≥ 100 ms sans port série', plays[0].t - on.t >= 95, (plays[0].t - on.t).toFixed(0));
    check('maintien ≥ 150 ms sans port série', off.t - ends[1].t >= 145, (off.t - ends[1].t).toFixed(0));
    check('tonalité libérée', m._vox === null && m.transmitting === false);
  }
  {
    const log = [], t0 = performance.now();
    const m = makeModem(log, t0);
    m.serialPort = null;
    m.voxTone = true;
    const c = voxCtx(log, t0);
    m._ensureAudioContext = () => c;
    const p = m.transmitSymbols([new Uint8Array(79)]);
    await new Promise((r) => setTimeout(r, 150));
    await m.cancelTransmit();
    await p;
    const stopped = log.find((e) => e.ev === 'stopped'), off = log.find((e) => e.ev === 'tone-off');
    check('annulation : tonalité coupée sans maintien', stopped && off && off.t - stopped.t < 40, off && stopped && (off.t - stopped.t).toFixed(0));
  }
  {
    const log = [], t0 = performance.now();
    const m = makeModem(log, t0);
    m.voxTone = true;
    const c = voxCtx(log, t0);
    m._ensureAudioContext = () => c;
    await m.transmitSymbols([new Uint8Array(79)]);
    const sig = log.filter((e) => e.ev === 'signals');
    check('VOX + port série : les deux commandent le PTT', sig.length === 2 && log.some((e) => e.ev === 'tone-on'), log.map((e) => e.ev));
  }
  {
    const log = [], t0 = performance.now();
    const m = makeModem(log, t0);
    m.serialPort = null;
    m.voxTone = true;
    const c = voxCtx(log, t0, 1);
    m._ensureAudioContext = () => c;
    const before = performance.now();
    await m.transmitSymbols([new Uint8Array(79)]);
    check('sortie mono : pas de tonalité ni de délai', !log.some((e) => e.ev === 'tone-on') && performance.now() - before < PLAY_MS + 60);
  }
  {
    const m = new FT8Modem({});
    m.updateSettings({ voxTone: true });
    check('updateSettings applique voxTone', m.voxTone === true);
  }
  {
    const m = new FT8Modem({});
    m.updateSettings({ pttLeadMs: 40, pttTailMs: 0 });
    check('updateSettings applique les délais', m.pttLeadMs === 40 && m.pttTailMs === 0);
  }

  console.log('Adaptateur natif');
  {
    const calls = [];
    const plugin = { setSignals: async (a) => calls.push(['set', a]), close: async () => calls.push(['close']) };
    const port = new NativePttPort(plugin, { deviceId: 7, name: 'CP2102' });
    await port.setSignals({ requestToSend: true });
    await port.setSignals({ dataTerminalReady: false });
    await port.setSignals({ requestToSend: 1, dataTerminalReady: 0 });
    await port.close();
    check('requestToSend → rts', JSON.stringify(calls[0]) === JSON.stringify(['set', { rts: true }]), calls[0]);
    check('dataTerminalReady → dtr', JSON.stringify(calls[1]) === JSON.stringify(['set', { dtr: false }]), calls[1]);
    check('les deux, booléens', JSON.stringify(calls[2]) === JSON.stringify(['set', { rts: true, dtr: false }]), calls[2]);
    check('close', calls[3][0] === 'close');
  }
  {
    const log = [];
    const m = makeModem(log, performance.now());
    const plugin = { setSignals: async (a) => log.push({ ev: 'native', a }), close: async () => {} };
    m.serialPort = new NativePttPort(plugin, { deviceId: 1, name: 'x' });
    await m.transmitSymbols([new Uint8Array(79)]);
    const nat = log.filter((e) => e.ev === 'native').map((e) => e.a);
    check('modem + port natif : rts true puis false', nat.length === 2 && nat[0].rts === true && nat[1].rts === false, nat);
  }

  console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
  process.exit(failures ? 1 : 0);
})();
