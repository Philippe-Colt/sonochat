// Test du protocole SonoLink (arq.js) : deux stations sur un canal simulé
// semi-duplex, horloge virtuelle, pertes contrôlées. Le décodage progressif
// des trames étendues reproduit celui du modem (bloc par bloc, drapeau
// `continues`). Usage : node tests/arq.js
const fs = require('fs'), vm = require('vm'), path = require('path');

const ctx = { console: { log() {}, error: console.error, warn() {} }, performance, setTimeout, clearTimeout,
  Math, Float32Array, Float64Array, Uint32Array, Uint8Array, Int32Array, Int8Array, Array, Set, Map, Object, String,
  Number, Promise, Date, Infinity, NaN, BigInt, Error, JSON };
vm.createContext(ctx);
for (const f of ['ft8-modem.js', 'arq.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('this.FT8 = FT8; this.FT8Modem = FT8Modem; this.SonoLink = SonoLink; this.SonoFrame = SonoFrame; this.LINK = LINK; this.textHash = textHash;', ctx);
const { FT8, SonoLink, SonoFrame, LINK, textHash } = ctx;

const SR = 48000;
const SYM = FT8.SYMBOL_PERIOD;
const DECODE_LATENCY = 2.0;   // s entre la fin d'une trame et son décodage (passe toutes les 2 s)

// ---------------- Simulation ----------------

function makeSim() {
  const sim = { t: 0, timers: [], nextId: 1 };
  sim.setTimer = (fn, ms) => { const id = sim.nextId++; sim.timers.push({ id, at: sim.t + ms / 1000, fn }); return id; };
  sim.clearTimer = (id) => { sim.timers = sim.timers.filter((x) => x.id !== id); };
  sim.now = () => sim.t * 1000;
  sim.flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  sim.runUntil = async (done, maxT = 3600) => {
    await sim.flush();
    while (!done() && sim.t < maxT) {
      if (sim.timers.length === 0) break;
      sim.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const x = sim.timers.shift();
      sim.t = x.at;
      x.fn();
      await sim.flush();
    }
  };
  return sim;
}

function makeStation(sim, name, opts = {}) {
  const st = { name, tx: [], sent: [], rx: new Map(), rxEvents: [], txEvents: [], ackEnabled: opts.ack !== false, drop: () => false };
  let aborted = false;
  st.link = new SonoLink({
    now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer,
    ackEnabled: (text) => (typeof st.ackEnabled === 'function' ? st.ackEnabled(text) : st.ackEnabled),
    callsign: () => opts.call || '',
    // Comme le modem : trame d'une autre station repérée ~1,5 s après son début, jusqu'à la
    // passe qui la décode
    channelBusy: () => (st.peers || [st.peer]).filter(Boolean).some((p) => p.sent.some((x) =>
      sim.t > x.start + 1.5 && sim.t < x.end + 4 * SYM + DECODE_LATENCY + 0.01)),
    abort: () => { aborted = true; },
    transmit: (frames, o = {}) => new Promise((resolve) => {
      aborted = false;
      let t = sim.t;
      const start = t;
      frames.forEach((f, i) => {
        const len = frameDuration(f);
        const fStart = t;
        st.sent.push({ f, start: fStart, end: fStart + len });
        if (o.onProgress) sim.setTimer(() => o.onProgress(i + 1, frames.length), (fStart - sim.t) * 1000);
        sim.setTimer(() => {
          if (!aborted) (st.peers || [st.peer]).forEach((p) => p.receive(st, f, fStart, fStart + len));
        }, (fStart - sim.t) * 1000);
        t = fStart + len + (i < frames.length - 1 ? FT8.MULTI_FRAME_GAP : 0);
      });
      st.tx.push({ start, end: t });
      sim.setTimer(() => resolve({ aborted }), (t - sim.t) * 1000);
    }),
  });
  st.link.onRx = (ev) => { st.rxEvents.push({ t: sim.t, ...ev }); st.rx.set(ev.id, ev.superseded ? ev : { ...(st.rx.get(ev.id) || {}), ...ev }); };
  st.link.onTx = (ev) => st.txEvents.push({ t: sim.t, ...ev });

  // Réception d'une trame émise par `from` sur [fStart, fEnd]
  st.receive = (from, f, fStart) => {
    const heard = (a, b) => !st.tx.some((x) => x.start < b && x.end > a); // semi-duplex
    if (f.kind === 'ext') {
      // Décodage progressif comme le modem : bloc k décodable quand la fenêtre
      // de 79 symboles qui le porte est complète (+ 4 symboles de traîne).
      const blocks = [];
      for (let i = 0; i < f.text.length; i += 13) blocks.push(f.text.substring(i, i + 13).trimEnd());
      if (blocks.length === 1) return st.receive(from, { kind: 'text', text: f.text }, fStart);
      const lost = new Set(blocks.map((_, i) => i).filter((i) => from.drop({ kind: 'ext', block: i, from: from.name })));
      let run = [];
      blocks.forEach((b, i) => {
        const wStart = fStart + 72 * i * SYM, wEnd = wStart + 79 * SYM;
        if (lost.has(i) || !heard(wStart, wEnd)) { run = []; return; }
        run.push({ b, i, wStart });
        const snapshot = run.slice();
        const last = i === blocks.length - 1;
        sim.setTimer(() => {
          const first = snapshot[0];
          const alone = snapshot.length === 1;
          st.link.handleFrame({
            text: alone ? first.b : snapshot.map((x, k) => (k < snapshot.length - 1 ? x.b.padEnd(13) : x.b)).join('').trimEnd(),
            telemetry: null, ext: !alone, blocks: alone ? null : snapshot.map((x) => x.b),
            continues: !last, absPos: Math.round(first.wStart * SR), sampleRate: SR,
          });
        }, (wEnd + 4 * SYM + DECODE_LATENCY - sim.t) * 1000);
      });
      return;
    }
    const fEnd = fStart + FT8.TX_DURATION;
    const desc = f.kind === 'tele' ? SonoFrame.parse(f.value) : { type: 'text' };
    if (!heard(fStart, fEnd) || from.drop({ ...desc, kind: f.kind, from: from.name })) {
      if (from.dropUndecoded && heard(fStart, fEnd)) {
        sim.setTimer(() => st.link.handleUndecoded(), (fEnd + 3 + DECODE_LATENCY - sim.t) * 1000);
      }
      return;
    }
    sim.setTimer(() => st.link.handleFrame({
      text: f.kind === 'text' ? f.text.toUpperCase().trimEnd() : null,
      telemetry: f.kind === 'tele' ? f.value : null,
      ext: false, blocks: null, continues: false, absPos: Math.round(fStart * SR), sampleRate: SR,
    }), (fEnd + (f.kind === 'text' ? 4 * SYM : 0) + DECODE_LATENCY - sim.t) * 1000);
  };
  return st;
}

function frameDuration(f) {
  if (f.kind === 'ext') {
    const n = Math.ceil(f.text.length / 13);
    return n > 1 ? (n * FT8.EXTENDED_BLOCK_SYMBOLS + 7) * SYM : FT8.TX_DURATION;
  }
  return FT8.TX_DURATION;
}

function pair(opts = {}) {
  const sim = makeSim();
  const A = makeStation(sim, 'A', opts.a || {}), B = makeStation(sim, 'B', opts.b || {});
  A.peer = B; B.peer = A;
  return { sim, A, B };
}

/** Trois stations qui s'entendent toutes ; chacune n'accuse que les messages qui lui sont adressés. */
function trio() {
  const sim = makeSim();
  const A = makeStation(sim, 'A', { call: 'PA' }), B = makeStation(sim, 'B', { call: 'BB' }), C = makeStation(sim, 'C', { call: 'CC' });
  A.peers = [B, C]; B.peers = [A, C]; C.peers = [A, B];
  for (const st of [A, B, C]) {
    const me = { A: 'PA', B: 'BB', C: 'CC' }[st.name];
    st.ackEnabled = (text) => typeof text === 'string' && text.slice(2, 4) === me; // en-tête émetteur + destinataire
  }
  return { sim, A, B, C };
}

async function exchange(sim, A, text, mode, ack = true, from = '') {
  let result = null;
  A.link.send(text, mode, { ack, from }).then((r) => { result = r; });
  await sim.runUntil(() => result !== null);
  // laisser passer les éventuels accusés et minuteurs restants
  await sim.runUntil(() => false, sim.t + 120);
  return result;
}

// ---------------- Cas de test ----------------

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || !detail ? '' : '  → ' + detail));
  if (!cond) failures++;
}
const doneMsgs = (st) => [...st.rx.values()].filter((e) => e.done);
const txCount = (st, pred) => st.sent.filter((s) => pred(s.f)).length;
const isAck = (f) => f.kind === 'tele' && SonoFrame.parse(f.value).type === 'ack';
const isRpt = (f) => f.kind === 'tele' && SonoFrame.parse(f.value).type === 'rpt';
const retries = (st) => st.txEvents.filter((e) => e.state === 'retry');

(async () => {
  const LONG = 'BONJOUR A TOUS. CECI EST UN ESSAI DE MESSAGE LONG 73';
  const EXT = 'MESSAGE ETENDU AVEC ACCUSE DE RECEPTION 42';

  console.log('Trames');
  {
    const v = SonoFrame.data(17, 3, 13, true, 'ABC DEF/9?');
    const d = SonoFrame.parse(v);
    check('DATA aller-retour', d.type === 'data' && d.msgId === 17 && d.seq === 3 && d.total === 13 && d.ackReq && d.chunk === 'ABC DEF/9?', JSON.stringify(d));
    const a = SonoFrame.parse(SonoFrame.ackFrame(31, 15, true, 0xBEEF, 'X9'));
    check('ACK trame aller-retour', a.type === 'ack' && a.sub === 'frame' && a.msgId === 31 && a.seq === 15 && a.final && a.hash === 0xBEEF && a.call === 'X9', JSON.stringify(a));
    const t = SonoFrame.parse(SonoFrame.ackText(0x1234, 'PC'));
    check('ACK texte aller-retour', t.type === 'ack' && t.sub === 'text' && t.hash === 0x1234 && t.call === 'PC', JSON.stringify(t));
    check('ACK sans indicatif', SonoFrame.parse(SonoFrame.ackText(0x1234)).call === '');
    check('ACK avec indicatif sur 71 bits', SonoFrame.ackFrame(31, 15, true, 0xFFFF, '??') < (1n << 71n));
    const r = SonoFrame.parse(SonoFrame.rpt(5, 7));
    check('RPT aller-retour', r.type === 'rpt' && r.msgId === 5 && r.seq === 7);
    check('empreinte normalisée', textHash('hello  ') === textHash('HELLO') && textHash('HELLO') !== textHash('HELLP'));
    check('empreinte : hors alphabet = espace', textHash('A,B') === textHash('A B'));
    check('valeur sur 71 bits', v >= 0n && v < (1n << 71n));
  }

  console.log('Standard');
  {
    const { sim, A, B } = pair();
    const r = await exchange(sim, A, 'HELLO WORLD', 'standard');
    check('confirmé sans perte', r.status === 'confirmed', JSON.stringify(r));
    check('un seul message reçu, intact', doneMsgs(B).length === 1 && doneMsgs(B)[0].text === 'HELLO WORLD');
    check('durée ~ estimation', Math.abs(A.txEvents.at(-1).t - SonoLink.estimateDuration('HELLO WORLD', 'standard', true)) < 3,
      A.txEvents.at(-1).t.toFixed(1) + ' s vs ' + SonoLink.estimateDuration('HELLO WORLD', 'standard', true).toFixed(1));
  }
  {
    const { sim, A, B } = pair();
    let n = 0;
    B.drop = (d) => d.type === 'ack' && n++ === 0;
    const r = await exchange(sim, A, 'CQ TEST 123', 'standard');
    check('accusé perdu : répété puis confirmé', r.status === 'confirmed' && retries(A).length === 1, JSON.stringify(r));
    check('accusé perdu : pas de doublon affiché', doneMsgs(B).length === 1);
    check('accusé perdu : réaccusé', txCount(B, isAck) === 2);
  }
  {
    const { sim, A, B } = pair();
    A.drop = () => true;
    const r = await exchange(sim, A, 'PERDU', 'standard');
    check('correspondant absent : échec après 3 répétitions', r.status === 'failed' && txCount(A, (f) => f.kind === 'text') === 4, JSON.stringify(r));
    void B;
  }

  console.log('Multi-trame (accusé par trame)');
  {
    const { sim, A, B } = pair();
    const r = await exchange(sim, A, LONG, 'multi-frame');
    const n = Math.ceil(LONG.length / 10);
    check('confirmé sans perte', r.status === 'confirmed', JSON.stringify(r));
    check('texte complet', doneMsgs(B).length === 1 && doneMsgs(B)[0].text === LONG, doneMsgs(B).map((m) => m.text).join(' | '));
    check('un accusé par trame', txCount(B, isAck) === n, txCount(B, isAck) + ' / ' + n);
    const est = SonoLink.estimateDuration(LONG, 'multi-frame', true);
    check('durée ~ estimation', Math.abs(A.txEvents.at(-1).t - est) < 3 * n, A.txEvents.at(-1).t.toFixed(0) + ' s vs ' + est.toFixed(0));
  }
  {
    const { sim, A, B } = pair();
    let n = 0;
    A.drop = (d) => d.type === 'data' && d.seq === 2 && n++ === 0;
    const r = await exchange(sim, A, LONG, 'multi-frame');
    check('trame 3 perdue : seule elle est répétée', r.status === 'confirmed' && retries(A).length === 1 && retries(A)[0].seq === 2, JSON.stringify(retries(A)));
    check('trame 3 perdue : texte complet', doneMsgs(B).length === 1 && doneMsgs(B)[0].text === LONG);
  }
  {
    const { sim, A, B } = pair();
    let n = 0;
    B.drop = (d) => d.type === 'ack' && d.seq === 1 && n++ === 0;
    const r = await exchange(sim, A, LONG, 'multi-frame');
    check('accusé 2 perdu : confirmé', r.status === 'confirmed', JSON.stringify(r));
    check('accusé 2 perdu : un seul message affiché', doneMsgs(B).length === 1 && B.rx.size === 1, B.rx.size + ' messages');
  }
  {
    const { sim, A, B } = pair();
    A.drop = (d) => d.type === 'data' && d.seq === 1;
    const r = await exchange(sim, A, LONG, 'multi-frame');
    check('trame 2 toujours perdue : échec sur la trame 2', r.status === 'failed' && r.seq === 1, JSON.stringify(r));
    check('trame 2 toujours perdue : 4 émissions de la trame', txCount(A, (f) => f.kind === 'tele' && SonoFrame.parse(f.value).seq === 1) === 4);
    const m = [...B.rx.values()].at(-1);
    check('récepteur : trou visible', m && m.text.startsWith(LONG.substring(0, 10) + LINK.MISSING), m && m.text);
  }
  {
    const { sim, A, B } = pair();
    let n = 0;
    A.drop = (d) => d.type === 'data' && d.seq === 1 && n++ === 0;
    A.dropUndecoded = true;
    const r = await exchange(sim, A, LONG, 'multi-frame');
    check('synchro sans décodage : RPT envoyé', txCount(B, isRpt) === 1);
    check('RPT : répétition immédiate', retries(A).length === 1 && retries(A)[0].reason === 'rpt', JSON.stringify(retries(A)));
    check('RPT : confirmé', r.status === 'confirmed');
  }

  console.log('Étendu (accusé du message complet)');
  {
    const { sim, A, B } = pair();
    const r = await exchange(sim, A, EXT, 'extended');
    check('confirmé sans perte', r.status === 'confirmed', JSON.stringify(r));
    check('un seul message, complet', doneMsgs(B).length === 1 && doneMsgs(B)[0].text === EXT, doneMsgs(B).map((m) => m.text).join(' | '));
    check('un seul accusé', txCount(B, isAck) === 1);
    const aEnd = A.sent.find((s) => s.f.kind === 'ext').end, bStart = B.sent[0] && B.sent[0].start;
    check('accusé après la fin de l\'émission', bStart >= aEnd, bStart + ' < ' + aEnd);
    check('réception progressive', B.rxEvents.filter((e) => !e.done).length >= 3);
  }
  {
    const { sim, A, B } = pair();
    let n = 0;
    A.drop = (d) => d.kind === 'ext' && d.block === 1 && n++ === 0;
    const r = await exchange(sim, A, EXT, 'extended');
    check('bloc 2 perdu : message renvoyé puis confirmé', r.status === 'confirmed' && retries(A).length === 1 && retries(A)[0].reason === 'mismatch', JSON.stringify(retries(A)));
    check('bloc 2 perdu : une seule bulle, complétée', B.rx.size === 1 && doneMsgs(B)[0].text === EXT, [...B.rx.values()].map((m) => m.text).join(' | '));
    const firstAck = B.sent.find((s) => isAck(s.f));
    const aEnd = A.sent.find((s) => s.f.kind === 'ext').end;
    check('bloc 2 perdu : pas d\'accusé pendant l\'émission', firstAck.start >= aEnd, firstAck.start + ' < ' + aEnd);
  }
  {
    const { sim, A, B } = pair();
    let n = 0;
    B.drop = (d) => d.type === 'ack' && n++ === 0;
    const r = await exchange(sim, A, EXT, 'extended');
    check('accusé perdu : confirmé au 2e envoi', r.status === 'confirmed' && retries(A).length === 1);
    check('accusé perdu : une seule bulle', B.rx.size === 1, [...B.rx.values()].map((m) => m.text).join(' | '));
  }

  console.log('Accusés désactivés (diffusion)');
  {
    const { sim, A, B } = pair({ a: { ack: false }, b: { ack: false } });
    for (const [text, mode] of [['HELLO', 'standard'], [LONG, 'multi-frame'], [EXT, 'extended']]) {
      const r = await exchange(sim, A, text, mode, false);
      check(mode + ' : envoyé sans attente', r.status === 'sent');
    }
    check('le récepteur n\'émet jamais', B.sent.length === 0);
    check('les 3 messages reçus', doneMsgs(B).map((m) => m.text).join('|') === ['HELLO', LONG, EXT].join('|'), doneMsgs(B).map((m) => m.text).join(' | '));
  }
  {
    const { sim, A, B } = pair({ b: { ack: false } });
    const r = await exchange(sim, A, 'HELLO', 'standard', true);
    check('récepteur « Accusés » décoché : il n\'émet pas', B.sent.length === 0 && r.status === 'failed');
  }

  {
    // 9-line adressé (en-tête PC→XY, 26 car. = 2 blocs) puis collationnement XY→PC
    const M = require('../medevac.js');
    const nine = M.encode({ nine: { lat: 48.85, lon: 2.29, counts: [1, 0, 0, 0, 0], litter: 1, security: 0, marking: 2, nation: [3] } });
    const { sim, A, B } = pair({ a: { call: 'PC' }, b: { call: 'XY' } });
    A.ackEnabled = (text) => typeof text === 'string' && text.slice(2, 4) === 'PC';
    B.ackEnabled = (text) => typeof text === 'string' && text.slice(2, 4) === 'XY';
    const r = await exchange(sim, A, 'PCXY' + nine, 'extended', true, 'XY');
    check('9-line adressé : 26 car., confirmé par XY', ('PCXY' + nine).length === 26 && r.status === 'confirmed' && r.by === 'XY', JSON.stringify(r));
    check('9-line : texte reçu intact', doneMsgs(B).some((m) => m.text === 'PCXY' + nine), doneMsgs(B).map((m) => m.text).join(' | '));
    const r2 = await exchange(sim, A, 'PC99BONJOUR', 'standard', false);
    check('message en l\'air : pas d\'accusé', r2.status === 'sent' && B.sent.filter((x) => isAck(x.f)).length === 1, JSON.stringify(r2));
    const r3 = await exchange(sim, B, 'XYPC?' + nine.slice(1), 'extended', true, 'PC');
    check('collationnement ?9 adressé à PC : accusé par PC', r3.status === 'confirmed' && r3.by === 'PC', JSON.stringify(r3));
  }

  console.log('Indicatif de la station qui accuse');
  for (const [text, mode] of [['XXHELLO', 'standard'], ['XX' + LONG, 'multi-frame'], ['XX' + EXT, 'extended']]) {
    const { sim, A } = pair({ b: { call: 'K7' } });
    const r = await exchange(sim, A, text, mode);
    check(mode + ' : confirmé par K7', r.status === 'confirmed' && r.by === 'K7', JSON.stringify(r));
  }

  console.log('Destinataire (3 stations)');
  for (const [text, mode] of [['PACCHELLO', 'standard'], ['PACC' + LONG, 'multi-frame'], ['PACC' + EXT, 'extended']]) {
    const { sim, A, B, C } = trio();
    const r = await exchange(sim, A, text, mode, true, 'CC');
    check(mode + ' vers CC : confirmé par CC', r.status === 'confirmed' && r.by === 'CC', JSON.stringify(r));
    check(mode + ' vers CC : BB reçoit mais ne répond pas', B.sent.length === 0 && doneMsgs(B).some((m) => m.text === text),
      B.sent.length + ' émission(s), ' + doneMsgs(B).map((m) => m.text).join(' | '));
    check(mode + ' vers CC : CC a reçu', doneMsgs(C).some((m) => m.text === text));
  }
  {
    const { sim, A, B, C } = trio();
    const r = await exchange(sim, A, 'PA99' + EXT, 'extended', false);
    check('message en l\'air (99) : envoyé, personne ne répond', r.status === 'sent' && B.sent.length === 0 && C.sent.length === 0, JSON.stringify(r));
    check('message en l\'air : reçu par BB et CC', doneMsgs(B).length === 1 && doneMsgs(C).length === 1);
  }
  {
    // BB accuse tout (station mal réglée), CC absente : l'accusé de BB ne vaut pas celui de CC
    const { sim, A, B, C } = trio();
    B.ackEnabled = true;
    C.ackEnabled = false;
    const r = await exchange(sim, A, 'PACCHELLO', 'standard', true, 'CC');
    check('accusé d\'une autre station ignoré', r.status !== 'confirmed', JSON.stringify(r));
  }
  {
    // Trame multi-trame perdue chez CC : seule CC demande la répétition (RPT)
    const { sim, A, B, C } = trio();
    let lost = false;
    A.drop = (d) => d.type === 'data' && d.seq === 1 && !lost && (lost = true);
    A.dropUndecoded = true;
    const r = await exchange(sim, A, 'PACC' + LONG, 'multi-frame', true, 'CC');
    check('multi-trame adressé, trame perdue : confirmé par CC', r.status === 'confirmed' && r.by === 'CC', JSON.stringify(r));
    check('BB n\'envoie ni accusé ni RPT', B.sent.length === 0, B.sent.length + ' émission(s)');
  }

  console.log('Balise de position');
  {
    const v = SonoFrame.pos('PC', 48.858372, 2.294481);
    const d = SonoFrame.parse(v);
    check('trame pos : 71 bits, indicatif, position au mètre', v < (1n << 71n) && d.type === 'pos' && d.call === 'PC'
      && Math.abs(d.lat - 48.858372) < 1e-5 && Math.abs(d.lon - 2.294481) < 1e-5, JSON.stringify(d));
    const w = SonoFrame.parse(SonoFrame.pos('Z9', -33.8568, -151.2153));
    check('hémisphères sud et ouest', Math.abs(w.lat + 33.8568) < 1e-5 && Math.abs(w.lon + 151.2153) < 1e-5, JSON.stringify(w));
    const { sim, A, B, C } = trio();
    const got = [];
    B.link.onBeacon = (ev) => got.push('B' + ev.call);
    C.link.onBeacon = (ev) => got.push('C' + ev.call);
    let ok = null;
    A.link.beacon(45.1, 5.2).then((r) => { ok = r; });
    await sim.runUntil(() => ok !== null);
    await sim.runUntil(() => false, sim.t + 60);
    check('balise : une seule trame, reçue par BB et CC, personne ne répond', ok === true && A.sent.length === 1
      && got.sort().join() === 'BPA,CPA' && B.sent.length === 0 && C.sent.length === 0, got.join() + ' / ' + A.sent.length);
    const { sim: s2, A: A2 } = trio();
    let r1 = null, rb = 'pas encore';
    A2.link.send('PACC' + LONG, 'multi-frame', { ack: true, from: 'CC' }).then((r) => { r1 = r; });
    await s2.flush();
    A2.link.beacon(45, 5).then((r) => { rb = r; });
    await s2.flush();
    check('pas de balise pendant un envoi', rb === false, String(rb));
    await s2.runUntil(() => r1 !== null);
  }

  console.log('Plusieurs stations simultanées');
  {
    const { sim, B } = pair();
    const ext = (t, abs, freq, cont) => ({ text: t.join(''), telemetry: null, ext: true, blocks: t, continues: cont, absPos: abs, sampleRate: SR, freq });
    // Deux étendus de 2 blocs, départs à 0,2 s d'écart, fréquences 1 400 et 1 460 Hz
    B.link.handleFrame(ext(['PCXYPREMIER M', 'ESSAGE A'], 1000000, 1400, false));
    B.link.handleFrame(ext(['ZZXYSECOND ME', 'SSAGE B'], 1000000 + Math.round(0.2 * SR), 1460, false));
    await sim.runUntil(() => false, sim.t + 60);
    const texts = doneMsgs(B).map((m) => m.text).sort();
    check('deux étendus simultanés sur 2 fréquences : deux messages, non mélangés', texts.length === 2
      && texts[0] === 'PCXYPREMIER MESSAGE A' && texts[1] === 'ZZXYSECOND MESSAGE B', texts.join(' | '));
  }

  console.log('État de l\'accusé sur le message reçu');
  {
    // B reçoit pendant que C diffuse : son accusé attend, puis part, puis est envoyé
    const { sim, A, B, C } = trio();
    C.link.channelBusy = () => false;
    sim.setTimer(() => C.link.send('CC99DIFFUSION LONGUE PENDANT LECHANGE', FT8.MODE_EXTENDED, { ack: false }), 8000);
    await exchange(sim, A, 'PABBBONJOUR', FT8.MODE_STANDARD, true, 'BB');
    const acks = B.rxEvents.filter((e) => e.ack).map((e) => e.ack);
    const bAck = B.sent.find((x) => isAck(x.f));
    const sendingAt = (B.rxEvents.find((e) => e.ack === 'sending') || {}).t;
    check('accusé : en attente, puis en cours d\'émission au départ réel, puis envoyé', acks.join(',') === 'pending,sending,sent'
      && Math.abs(sendingAt - bAck.start) < 0.01, acks.join(',') + ' · émission à ' + sendingAt + ' s, départ ' + (bAck && bAck.start));
    const pendingAt = (B.rxEvents.find((e) => e.ack === 'pending') || {}).t;
    check('« accusé envoyé » seulement à la fin de l\'émission', (B.rxEvents.find((e) => e.ack === 'sent') || {}).t >= bAck.end - 0.01 && pendingAt < sendingAt);
  }

  console.log('Pas d\'émission pendant une réception');
  {
    // A écrit à B ; C (qui n'entend pas A) diffuse un long étendu pendant ce temps.
    // B doit attendre la fin de C et l'avoir décodé avant d'accuser ; A, qui entend
    // C, prolonge son attente d'accusé au lieu de répéter.
    const { sim, A, B, C } = trio();
    C.link.channelBusy = () => false;
    const LONGC = 'CC99' + 'DIFFUSION LONGUE PENDANT LECHANGE DE A ET B';
    sim.setTimer(() => C.link.send(LONGC, FT8.MODE_EXTENDED, { ack: false }), 8000);
    const r = await exchange(sim, A, 'PABBBONJOUR', FT8.MODE_STANDARD, true, 'BB');
    const cEnd = Math.max(...C.sent.map((x) => x.end));
    const bAck = B.sent.find((x) => isAck(x.f));
    check('B accuse après la fin de la diffusion de C', bAck && bAck.start >= cEnd, bAck && `ack ${bAck.start.toFixed(1)} s, fin C ${cEnd.toFixed(1)} s`);
    check('B a décodé le message de C', doneMsgs(B).some((m) => m.text === LONGC), doneMsgs(B).map((m) => m.text).join(' | '));
    check('A confirmé sans répétition (attente prolongée)', r.status === 'confirmed' && retries(A).length === 0, `${r.status}, ${retries(A).length} répétition(s)`);
    check('A n\'a rien différé (pas d\'émission en attente pendant C)', !A.txEvents.some((e) => e.state === 'channel'));
  }
  {
    // B veut écrire pendant que C diffuse : son envoi part après la fin de C.
    const { sim, B, C } = trio();
    const LONGC = 'CC99' + 'UNE AUTRE DIFFUSION LONGUE EN COURS';
    C.link.send(LONGC, FT8.MODE_EXTENDED, { ack: false });
    let r = null;
    sim.setTimer(() => B.link.send('BBPAMESSAGE', FT8.MODE_STANDARD, { ack: false }).then((x) => { r = x; }), 6000);
    await sim.runUntil(() => r !== null);
    const cEnd = Math.max(...C.sent.map((x) => x.end));
    check('envoi de B différé après la diffusion de C, et C décodé avant', B.sent.length === 1 && B.sent[0].start >= cEnd
      && doneMsgs(B).some((m) => m.text === LONGC), B.sent.length && `B à ${B.sent[0].start.toFixed(1)} s, fin C ${cEnd.toFixed(1)} s`);
  }

  console.log('Pertes en début de message');
  {
    // Bloc 0 perdu à la 1re émission : la suite passe pour un message ; la répétition le remplace
    const { sim, A, B } = pair();
    let n = 0;
    A.drop = (d) => d.kind === 'ext' && d.block === 0 && n++ === 0;
    const r = await exchange(sim, A, 'XX' + EXT, 'extended');
    const sup = B.rxEvents.filter((e) => e.superseded);
    check('étendu, bloc 0 perdu : confirmé à la répétition', r.status === 'confirmed', JSON.stringify(r));
    check('le fragment est remplacé (une seule bulle)', sup.length === 1 && doneMsgs(B).length === 1 && doneMsgs(B)[0].text === 'XX' + EXT,
      sup.length + ' remplacement(s) ; ' + doneMsgs(B).map((m) => m.text).join(' | '));
  }
  {
    // Multi-trame en l'air, trame 0 perdue : la réception se termine « incomplète »
    const { sim, A, B } = pair();
    A.drop = (d) => d.type === 'data' && d.seq === 0;
    const r = await exchange(sim, A, LONG, 'multi-frame', false);
    const last = [...B.rx.values()].pop();
    check('multi-trame en l\'air incomplet : réception terminée', r.status === 'sent' && last.done === true && last.complete === false, JSON.stringify(last));
  }

  console.log('Enchaînement');
  {
    const { sim, A, B } = pair();
    const r1 = await exchange(sim, A, 'HELLO', 'standard');
    const r2 = await exchange(sim, B, 'HELLO', 'standard');   // même texte, autre sens
    const r3 = await exchange(sim, A, 'HELLO WORLD', 'standard');
    check('réponses successives confirmées', [r1, r2, r3].every((r) => r.status === 'confirmed'), [r1, r2, r3].map((r) => r.status).join(','));
    check('« HELLO » puis « HELLO WORLD » : deux messages distincts', doneMsgs(B).map((m) => m.text).join('|') === 'HELLO|HELLO WORLD', doneMsgs(B).map((m) => m.text).join(' | '));
  }

  console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
  process.exit(failures ? 1 : 0);
})();
