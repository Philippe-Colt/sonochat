/**
 * SonoLink — accusés de réception et répétition automatique (ARQ) au-dessus
 * de FT8Modem. Aucune dépendance au DOM ni à l'audio : l'émission, l'horloge
 * et les minuteurs sont injectés, ce qui permet de tester en Node.
 *
 * Modes :
 * - standard (1 trame texte libre) : le récepteur accuse avec l'empreinte du texte
 * - multi-trame (trames DATA télémétrie) : arrêt-et-attente, un accusé par trame,
 *   le dernier porte l'empreinte du message complet
 * - étendu (texte libre multi-blocs) : un accusé pour le message complet
 *
 * Chaque trame FT8 est déjà protégée par LDPC + CRC-14 : une trame décodée est
 * juste. Le protocole ajoute numéro de trame, identifiant de message et
 * empreinte CRC-16 du message complet (confirmation totale).
 */

const LINK = {
  TYPE_DATA: 0,
  TYPE_ACK: 1,
  TYPE_RPT: 2,
  TYPE_POS: 3,              // balise de position (en l'air, sans accusé)

  CHUNK_CHARS: 10,          // caractères par trame DATA (42^10 < 2^54)
  MAX_FRAMES: 16,           // seq sur 4 bits

  ACK_TIMEOUT: 24,          // s après notre émission : décodage (~2,5) + accusé (12,64) + décodage (~2,5) + marge
  ACK_TIMEOUT_EXT: 48,      // s : idem + attente de stabilité (RX_STABLE) si un bloc s'est perdu
  ACK_ROUNDTRIP: 17.6,      // s, pour l'estimation de durée affichée
  MAX_RETRIES: 3,

  // s sans nouveau bloc alors que le signal semblait continuer : le récepteur
  // accuse quand même. > 2 blocs (23 s) : un bloc perdu au milieu d'un étendu
  // ne doit pas faire répondre pendant que l'émetteur parle encore.
  RX_STABLE: 26,
  RX_SESSION_TTL: 180,      // s : sessions gardées pour réaccuser une répétition
  RX_DUP_WINDOW: 180,       // s : même texte = répétition (accusé perdu), pas un nouveau message ;
                            // un étendu de 130 car. répété dure ~2 min 45 (émission + attente)
  RX_RPT_WINDOW: 50,        // s après le début de notre dernier accusé (accusé 12,64 + trame suivante 12,64 + délais)
  RX_QUIET: 30,             // s d'inactivité d'une réception avant d'autoriser notre envoi
  CLEAR_MAX: 150,           // s max d'attente qu'une trame à l'antenne finisse (étendu de 10 blocs : 115 s)
  ACK_WAIT_MAX: 150,
  CLEAR_GRACE: 6,           // s de canal libre après une attente prolongée : l'accusé retenu a le temps d'être repéré        // s max de prolongation de l'attente d'accusé tant qu'une trame arrive
  SAME_FREQ_HZ: 10,         // Hz : trames d'une même station (fréquence affinée à ±1 Hz)
  MISSING: '…',        // affiché à la place d'un bloc ou d'une trame manquant
};

// ============================================================
// Codage des trames (71 bits, conteneur télémétrie FT8)
// ============================================================

function packFields(fields) {
  let v = 0n, used = 0;
  for (const [value, bits] of fields) {
    v = (v << BigInt(bits)) | (BigInt(value) & ((1n << BigInt(bits)) - 1n));
    used += bits;
  }
  if (used > 71) throw new Error('trame trop longue: ' + used + ' bits');
  return v << BigInt(71 - used);
}

function fieldReader(v71) {
  let pos = 0;
  return (bits) => {
    const shift = BigInt(71 - pos - bits);
    pos += bits;
    return (v71 >> shift) & ((1n << BigInt(bits)) - 1n);
  };
}

const CHARSET = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';

function encodeChunk(text) {
  const t = text.toUpperCase().padEnd(LINK.CHUNK_CHARS, ' ').substring(0, LINK.CHUNK_CHARS);
  let v = 0n;
  for (const c of t) {
    const idx = CHARSET.indexOf(c);
    v = v * 42n + BigInt(idx < 0 ? 0 : idx);
  }
  return v;
}

function decodeChunk(v) {
  let s = '';
  for (let i = 0; i < LINK.CHUNK_CHARS; i++) {
    s = CHARSET[Number(v % 42n)] + s;
    v /= 42n;
  }
  return s;
}

/** Indicatif court de la station qui accuse : 2 caractères base 42 (11 bits), '' si aucun. */
function encodeCall(call) {
  const c = (call || '').toUpperCase().padEnd(2, ' ').substring(0, 2);
  return BigInt(Math.max(0, CHARSET.indexOf(c[0])) * 42 + Math.max(0, CHARSET.indexOf(c[1])));
}

function decodeCall(v) {
  const n = Number(v);
  return (CHARSET[Math.floor(n / 42)] + CHARSET[n % 42]).trim();
}

/** CRC-16/CCITT-FALSE sur le texte normalisé. */
function textHash(text) {
  const t = normalizeText(text);
  let crc = 0xFFFF;
  for (let i = 0; i < t.length; i++) {
    crc ^= t.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

/** Texte tel qu'il circule : majuscules, hors alphabet FT8 -> espace (comme encodeText). */
function normalizeText(text) {
  return Array.from(text.toUpperCase(), (c) => (CHARSET.includes(c) ? c : ' ')).join('').trimEnd();
}

const SonoFrame = {
  data(msgId, seq, total, ackReq, chunk) {
    return packFields([[LINK.TYPE_DATA, 2], [msgId, 5], [seq, 4], [total - 1, 4], [ackReq ? 1 : 0, 1], [encodeChunk(chunk), 54]]);
  },
  ackFrame(msgId, seq, final, hash, call = '') {
    return packFields([[LINK.TYPE_ACK, 2], [0, 1], [msgId, 5], [seq, 4], [final ? 1 : 0, 1], [hash, 16], [encodeCall(call), 11]]);
  },
  ackText(hash, call = '') {
    return packFields([[LINK.TYPE_ACK, 2], [1, 1], [hash, 16], [encodeCall(call), 11]]);
  },
  rpt(msgId, seq) {
    return packFields([[LINK.TYPE_RPT, 2], [msgId, 5], [seq, 4]]);
  },
  /** Balise de position : indicatif + position au mètre (1e-5°), 64 bits sur 71, une seule trame FT8. */
  pos(call, lat, lon) {
    const la = Math.round((lat + 90) * 1e5);
    const lo = ((Math.round((lon + 180) * 1e5) % 36000000) + 36000000) % 36000000;
    return packFields([[LINK.TYPE_POS, 2], [encodeCall(call), 11], [la, 25], [lo, 26], [0, 7]]);
  },
  parse(v71) {
    const r = fieldReader(v71);
    const type = Number(r(2));
    if (type === LINK.TYPE_DATA) {
      const msgId = Number(r(5)), seq = Number(r(4)), total = Number(r(4)) + 1, ackReq = r(1) === 1n;
      const chunk = decodeChunk(r(54));
      if (seq >= total) return null;
      return { type: 'data', msgId, seq, total, ackReq, chunk };
    }
    if (type === LINK.TYPE_ACK) {
      if (r(1) === 0n) {
        return { type: 'ack', sub: 'frame', msgId: Number(r(5)), seq: Number(r(4)), final: r(1) === 1n, hash: Number(r(16)), call: decodeCall(r(11)) };
      }
      return { type: 'ack', sub: 'text', hash: Number(r(16)), call: decodeCall(r(11)) };
    }
    if (type === LINK.TYPE_RPT) {
      return { type: 'rpt', msgId: Number(r(5)), seq: Number(r(4)) };
    }
    if (type === LINK.TYPE_POS) {
      const call = decodeCall(r(11)), la = Number(r(25)), lo = Number(r(26));
      if (r(7) !== 0n || la > 18000000 || lo >= 36000000) return null; // réservé : version future
      return { type: 'pos', call, lat: la / 1e5 - 90, lon: lo / 1e5 - 180 };
    }
    return null;
  },
};

function splitChunks(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += LINK.CHUNK_CHARS) {
    chunks.push(text.substring(i, i + LINK.CHUNK_CHARS));
  }
  return chunks.length ? chunks : [''];
}

// ============================================================
// SonoLink
// ============================================================

class SonoLink {
  /**
   * @param {object} io
   * @param {function(object[], object): Promise<{aborted: boolean}>} io.transmit
   *        frames: [{kind: 'text'|'ext', text} | {kind: 'tele', value: BigInt}]
   * @param {function(): void} io.abort  arrête l'émission en cours
   * @param {function(): number} [io.now]  horloge en ms
   * @param {function(function, number): any} [io.setTimer]
   * @param {function(any): void} [io.clearTimer]
   * @param {function(string): boolean} [io.ackEnabled]  accuser ce texte reçu ? (l'application :
   *        seulement s'il nous est adressé)
   * @param {function(): string} [io.callsign]  indicatif court (2 car.) placé dans nos accusés
   * @param {function(): boolean} [io.channelBusy]  une trame est en train d'arriver (pas encore
   *        décodable) : on n'émet rien par-dessus, on décode d'abord
   */
  constructor(io) {
    this.io = io;
    this.now = io.now || (() => Date.now());
    this.setTimer = io.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = io.clearTimer || ((t) => clearTimeout(t));
    this.ackEnabled = io.ackEnabled || (() => true);
    this.callsign = io.callsign || (() => '');  // indicatif court porté par nos accusés
    this.log = io.log || (() => {});
    this.channelBusy = io.channelBusy || (() => false);

    this.onTx = null;   // ({id, state, ...})
    this.onRx = null;   // ({id, text, done, complete, frames?, total?} | {id, ack: 'pending'|'sending'|'sent'|'failed'} | {id, superseded: autreId})
    this.onBeacon = null; // ({call, lat, lon}) : balise de position reçue

    this._txChain = Promise.resolve();
    this._sending = false;
    this._cancelled = false;
    this._waiter = null;
    this._txSeq = 0;
    this._lastMsgId = -1;

    this._rxSeq = 0;
    this._rxMulti = new Map();  // msgId -> session
    this._rxTexts = [];         // standard / étendu
  }

  // ---------------- Estimation ----------------

  static estimateDuration(text, mode, ack) {
    if (!text) return 0;
    const F = FT8Modem, C = FT8;
    if (mode === C.MODE_MULTI_FRAME) {
      const n = Math.ceil(text.length / LINK.CHUNK_CHARS);
      return ack ? n * (C.TX_DURATION + LINK.ACK_ROUNDTRIP)
                 : n * C.TX_DURATION + (n - 1) * C.MULTI_FRAME_GAP;
    }
    const base = mode === C.MODE_EXTENDED ? F.estimateDuration(text, mode) : C.TX_DURATION;
    return base + (ack ? LINK.ACK_ROUNDTRIP : 0);
  }

  // ---------------- Émission ----------------

  get busy() { return this._sending; }

  /**
   * Envoie un message. Résout avec {status: 'confirmed'|'sent'|'failed'|'mismatch'|'cancelled', ...}.
   * @param {object} [opts]
   * @param {boolean} [opts.ack]  attendre un accusé
   * @param {string} [opts.from]  indicatif du destinataire : seuls ses accusés comptent
   */
  async send(text, mode, { ack = true, from = '' } = {}) {
    if (this._sending) throw new Error('Envoi deja en cours');
    this._sending = true;
    this._cancelled = false;
    const id = ++this._txSeq;
    try {
      await this._waitRxQuiet();
      if (this._cancelled) return this._result(id, { status: 'cancelled' });
      if (mode === FT8.MODE_MULTI_FRAME) return await this._sendMulti(id, text, ack, from);
      return await this._sendText(id, text, mode, ack, from);
    } finally {
      this._sending = false;
    }
  }

  /**
   * Balise de position : une trame, en l'air, sans accusé. Jamais pendant un envoi
   * ni par-dessus une réception en cours. Résout avec true si émise.
   */
  async beacon(lat, lon) {
    if (this._sending) return false;
    await this._waitRxQuiet();
    if (this._sending) return false;
    const r = await this._transmit([{ kind: 'tele', value: SonoFrame.pos(this.callsign(), lat, lon) }]);
    return !r.aborted;
  }

  /** Émission possible tout de suite : rien en cours d'envoi, rien qui arrive (émissions en créneau). */
  canTransmitNow() {
    return !this._sending && !this._rxInProgress() && !this.channelBusy();
  }

  cancel() {
    if (!this._sending) return;
    this._cancelled = true;
    this.io.abort();
    if (this._waiter) this._waiter.finish(null);
  }

  async _sendMulti(id, text, ack, from) {
    const chunks = splitChunks(text);
    const total = chunks.length;
    if (total > LINK.MAX_FRAMES) throw new Error('message trop long');
    let msgId;
    do { msgId = Math.floor(Math.random() * 32); } while (msgId === this._lastMsgId);
    this._lastMsgId = msgId;
    const frameOf = (seq) => ({ kind: 'tele', value: SonoFrame.data(msgId, seq, total, ack, chunks[seq]) });

    if (!ack) {
      this._emitTx({ id, state: 'frame', seq: 0, total, attempt: 0 });
      const r = await this._transmit(chunks.map((_, seq) => frameOf(seq)), {
        onProgress: (i) => this._emitTx({ id, state: 'frame', seq: i - 1, total, attempt: 0 }),
      });
      return this._result(id, { status: r.aborted ? 'cancelled' : 'sent' });
    }

    const hash = textHash(text);
    for (let seq = 0; seq < total; seq++) {
      let attempt = 0;
      for (;;) {
        this._emitTx({ id, state: 'frame', seq, total, attempt });
        const r = await this._transmit([frameOf(seq)]);
        if (r.aborted || this._cancelled) return this._result(id, { status: 'cancelled', seq, total });

        this._emitTx({ id, state: 'waitAck', seq, total, attempt });
        const ev = await this._waitFor(
          (e) => (e.type === 'ack' && e.sub === 'frame' && (!from || e.call === from) || e.type === 'rpt')
            && e.msgId === msgId && e.seq === seq,
          LINK.ACK_TIMEOUT);
        if (this._cancelled) return this._result(id, { status: 'cancelled', seq, total });

        if (ev && ev.type === 'ack') {
          if (seq === total - 1) {
            if (ev.final && ev.hash === hash) return this._result(id, { status: 'confirmed', total, by: ev.call });
            return this._result(id, { status: 'mismatch', seq, total });
          }
          break;
        }
        if (++attempt > LINK.MAX_RETRIES) return this._result(id, { status: 'failed', seq, total });
        this._emitTx({ id, state: 'retry', seq, total, attempt, reason: ev ? 'rpt' : 'timeout' });
      }
    }
    return this._result(id, { status: 'failed' }); // inatteignable
  }

  async _sendText(id, text, mode, ack, from) {
    const ext = mode === FT8.MODE_EXTENDED && text.length > 13;
    const frame = { kind: ext ? 'ext' : 'text', text };
    if (!ack) {
      this._emitTx({ id, state: 'frame', seq: 0, total: 1, attempt: 0 });
      const r = await this._transmit([frame]);
      return this._result(id, { status: r.aborted ? 'cancelled' : 'sent' });
    }

    const hash = textHash(text);
    let attempt = 0;
    for (;;) {
      this._emitTx({ id, state: 'frame', seq: 0, total: 1, attempt });
      const r = await this._transmit([frame]);
      if (r.aborted || this._cancelled) return this._result(id, { status: 'cancelled' });

      this._emitTx({ id, state: 'waitAck', seq: 0, total: 1, attempt });
      const ev = await this._waitFor((e) => e.type === 'ack' && e.sub === 'text' && (!from || e.call === from),
        ext ? LINK.ACK_TIMEOUT_EXT : LINK.ACK_TIMEOUT);
      if (this._cancelled) return this._result(id, { status: 'cancelled' });
      if (ev && ev.hash === hash) return this._result(id, { status: 'confirmed', by: ev.call });

      if (++attempt > LINK.MAX_RETRIES) {
        return this._result(id, { status: ev ? 'mismatch' : 'failed' });
      }
      this._emitTx({ id, state: 'retry', seq: 0, total: 1, attempt, reason: ev ? 'mismatch' : 'timeout' });
    }
  }

  _result(id, res) {
    this._emitTx({ id, state: 'done', ...res });
    return res;
  }

  _emitTx(ev) {
    if (ev.state === 'frame') this._lastFrameEv = ev;
    if (this.onTx) this.onTx(ev);
  }

  /**
   * Une seule émission à la fois : trames de message et accusés sont sérialisés.
   * Jamais par-dessus une trame en train d'arriver : on attend qu'elle finisse et
   * soit décodée (elle peut nous être adressée, ou être l'accusé attendu).
   * @param {boolean} [own]  trame de notre envoi (false : accusé, demande de répétition) :
   *        annulée si l'envoi l'est pendant l'attente
   */
  _transmit(frames, opts = {}, own = true) {
    const run = this._txChain
      .then(() => this._waitClear(own))
      .then(() => {
        if (own && this._sending && this._cancelled) return { aborted: true };
        if (opts.onStart) opts.onStart(); // l'émission commence vraiment (canal libre)
        return this.io.transmit(frames, opts);
      });
    this._txChain = run.catch(() => {});
    return run;
  }

  /** Émission automatique (accusé, demande de répétition) : erreurs journalisées. */
  _transmitQuiet(frames) {
    this._transmit(frames, {}, false).catch((e) => this.log('TX erreur: ' + (e && e.message)));
  }

  /**
   * Accusé d'un message reçu, avec son état réel sur ce message (onRx {id, ack}) :
   * 'pending' en attente (canal occupé, autre émission), 'sending' en cours d'émission,
   * 'sent' parti, 'failed' pas parti.
   */
  _sendAck(rxId, frames) {
    this._emitRx({ id: rxId, ack: 'pending' });
    this._transmit(frames, { onStart: () => this._emitRx({ id: rxId, ack: 'sending' }) }, false).then(
      (r) => this._emitRx({ id: rxId, ack: r && r.aborted ? 'failed' : 'sent' }),
      (e) => {
        this.log('TX erreur: ' + (e && e.message));
        this._emitRx({ id: rxId, ack: 'failed' });
      });
  }

  /** Attend que plus aucune trame n'arrive (CLEAR_MAX au plus). */
  async _waitClear(own) {
    if (!this.channelBusy()) return;
    const deadline = this.now() + LINK.CLEAR_MAX * 1000;
    const ev = own && this._sending && this._lastFrameEv;
    if (ev) this._emitTx({ ...ev, state: 'channel' });
    this.log('trame en cours de réception : émission différée');
    while (this.channelBusy() && this.now() < deadline && !(own && this._sending && this._cancelled)) {
      await new Promise((r) => this.setTimer(r, 1000));
    }
    if (ev && !this._cancelled) this._emitTx(ev);
  }

  _waitFor(match, timeoutS) {
    return new Promise((resolve) => {
      const w = {
        match,
        finish: (ev) => {
          if (this._waiter !== w) return;
          this._waiter = null;
          this.clearTimer(w.timer);
          resolve(ev);
        },
      };
      // Délai écoulé pendant qu'une trame arrive (l'accusé, ou une autre station qui
      // le retarde) : on attend qu'elle soit décodée, puis que le canal soit resté
      // libre CLEAR_GRACE s (l'accusé retenu part à ce moment-là) avant de conclure.
      const limit = this.now() + (timeoutS + LINK.ACK_WAIT_MAX) * 1000;
      let lastBusy = -Infinity;
      const expire = () => {
        if (this._waiter !== w) return;
        if (this.channelBusy()) lastBusy = this.now();
        const hold = this.now() - lastBusy < LINK.CLEAR_GRACE * 1000;
        if (hold && this.now() < limit) w.timer = this.setTimer(expire, 1000);
        else w.finish(null);
      };
      w.timer = this.setTimer(expire, timeoutS * 1000);
      this._waiter = w;
    });
  }

  /** Ne pas parler par-dessus un correspondant en train de nous envoyer un message. */
  async _waitRxQuiet() {
    const deadline = this.now() + 2 * LINK.RX_QUIET * 1000;
    while (!this._cancelled && this.now() < deadline && (this._rxInProgress() || this.channelBusy())) {
      await new Promise((r) => this.setTimer(r, 1000));
    }
  }

  _rxInProgress() {
    const now = this.now(), quiet = LINK.RX_QUIET * 1000;
    for (const s of this._rxMulti.values()) {
      if (!s.done && now - s.lastSeen < quiet) return true;
    }
    return this._rxTexts.some((e) => !e.done && now - e.time < quiet);
  }

  // ---------------- Réception ----------------

  /** Trame décodée par le modem (FT8Modem.onFrame). */
  handleFrame(frame) {
    this._prune();
    if (frame.telemetry !== null && frame.telemetry !== undefined) {
      const ev = SonoFrame.parse(frame.telemetry);
      if (!ev) return;
      if (ev.type === 'pos') {
        if (this.onBeacon) this.onBeacon(ev);
      } else if (ev.type === 'data') {
        this._rxData(ev);
      } else if (this._waiter && this._waiter.match(ev)) {
        this.log('RX ' + ev.type + ' ' + JSON.stringify(ev));
        this._waiter.finish(ev);
      }
      return;
    }
    if (frame.text !== null && frame.text !== undefined) this._rxText(frame);
  }

  /** Synchro forte sans décodage (FT8Modem.onUndecoded) : demander la répétition. */
  handleUndecoded() {
    const now = this.now();
    for (const [msgId, s] of this._rxMulti) {
      if (s.done || !s.ackReq || now - s.lastAckAt > LINK.RX_RPT_WINDOW * 1000) continue;
      if (!this.ackEnabled(this._assembleChunks(s.chunks))) continue; // pas pour nous
      if (s.rptSent.has(s.expectSeq)) continue;
      s.rptSent.add(s.expectSeq);
      this.log('TX RPT ' + msgId + '/' + s.expectSeq);
      this._transmitQuiet([{ kind: 'tele', value: SonoFrame.rpt(msgId, s.expectSeq) }]);
    }
  }

  _rxData(d) {
    const now = this.now();
    let s = this._rxMulti.get(d.msgId);
    const stale = s && now - s.lastSeen > LINK.RX_SESSION_TTL * 1000;
    const other = s && (s.total !== d.total
      || (s.chunks[d.seq] !== undefined && s.chunks[d.seq] !== d.chunk));
    if (!s || stale || other) {
      s = {
        rxId: ++this._rxSeq, total: d.total, chunks: new Array(d.total),
        lastSeen: now, lastAckAt: 0, done: false, ackReq: d.ackReq, expectSeq: 0, rptSent: new Set(),
      };
      this._rxMulti.set(d.msgId, s);
    }
    s.lastSeen = now;
    s.ackReq = d.ackReq;
    const isNew = s.chunks[d.seq] === undefined;
    s.chunks[d.seq] = d.chunk;
    s.expectSeq = Math.max(s.expectSeq, d.seq + 1);

    const received = Array.from(s.chunks).filter((c) => c !== undefined).length;
    const complete = received === s.total;
    const text = this._assembleChunks(s.chunks);
    if (complete) s.done = true;

    const willAck = d.ackReq && this.ackEnabled(text);
    if (isNew || willAck) {
      this._emitRx({ id: s.rxId, text, done: complete, complete, frames: received, total: s.total });
    }
    // Plus aucune trame (perdue, message pour une autre station, en l'air) : la
    // réception se termine incomplète au lieu de rester « en cours » ; une
    // répétition qui comble les trous la complète encore.
    this.clearTimer(s.timer);
    if (!complete) {
      s.timer = this.setTimer(() => {
        if (s.done) return;
        const got = Array.from(s.chunks).filter((c) => c !== undefined).length;
        this._emitRx({ id: s.rxId, text: this._assembleChunks(s.chunks), done: true, complete: false, frames: got, total: s.total });
      }, LINK.RX_RPT_WINDOW * 1000);
    }
    if (willAck) {
      s.lastAckAt = now;
      this.log('TX ACK ' + d.msgId + '/' + d.seq + (complete ? ' final' : ''));
      this._sendAck(s.rxId, [{ kind: 'tele', value: SonoFrame.ackFrame(d.msgId, d.seq, complete, complete ? textHash(text) : 0, this.callsign()) }]);
    }
  }

  _assembleChunks(chunks) {
    const last = chunks.length - 1;
    // Array.from : les trames manquantes sont des trous, que map() sauterait
    return Array.from(chunks, (c, i) => (c === undefined ? LINK.MISSING : i < last ? c.padEnd(LINK.CHUNK_CHARS, ' ') : c))
      .join('').trimEnd();
  }

  _rxText(frame) {
    const now = this.now();
    const blocks = frame.ext ? frame.blocks : [frame.text];
    const blockStep = FT8.EXTENDED_BLOCK_SYMBOLS * FT8.SYMBOL_PERIOD * frame.sampleRate;
    // Même station = même fréquence (décodeur large bande : plusieurs stations à la fois)
    const sameFreq = (e) => frame.freq === undefined || e.freq === undefined || Math.abs(e.freq - frame.freq) < LINK.SAME_FREQ_HZ;
    const newest = this._rxTexts.filter((e) => now - e.time < LINK.RX_DUP_WINDOW * 1000 && sameFreq(e));

    // 1. Suite d'un envoi en cours de réception (bloc suivant d'un étendu, ou
    //    fragment après un bloc perdu) : même grille de blocs, moins de 10 blocs.
    let entry = null, offset = 0;
    for (const e of newest) {
      if (e.done) continue;
      const k = (frame.absPos - e.base) / blockStep;
      const idx = Math.round(k);
      if (Math.abs(k - idx) < 0.1 && idx > -FT8.EXTENDED_MAX_BLOCKS && idx < FT8.EXTENDED_MAX_BLOCKS) {
        entry = e; offset = idx; break;
      }
    }

    // 2. Message déjà reçu en entier : c'est une répétition (notre accusé
    //    s'est perdu). Le texte doit être identique, sauf pour un morceau
    //    d'étendu (bloc isolé dont l'émission continue, ou fragment).
    if (!entry) {
      const partOf = frame.ext || frame.continues !== false;
      const dup = newest.find((e) => e.done && e.complete
        && (e.text === frame.text || (partOf && e.text.includes(frame.text))));
      if (dup) {
        dup.time = now; // une répétition longue prolonge la fenêtre
        if (frame.continues === false) this._ackText(dup, true);
        return;
      }
    }

    // 3. Répétition d'un étendu reçu avec des trous : les blocs communs
    //    concordent à un même décalage, on complète le message existant.
    if (!entry) {
      for (const e of newest) {
        if (e.complete || e.blocks.length < 2) continue;
        const o = this._matchBlocks(e.blocks, blocks);
        if (o !== null) {
          entry = e; offset = o;
          e.base = frame.absPos - o * blockStep;
          break;
        }
      }
    }

    if (!entry) {
      entry = { rxId: ++this._rxSeq, base: frame.absPos, blocks: [], text: '', done: false, complete: false, time: now, timer: null, acked: false, freq: frame.freq };
      this._rxTexts.push(entry);
    }

    if (offset < 0) { // un bloc antérieur à la base : on la recule
      entry.blocks = new Array(-offset).concat(entry.blocks);
      entry.base = frame.absPos;
      offset = 0;
    }
    blocks.forEach((b, i) => { entry.blocks[offset + i] = b; });
    const text = this._assembleBlocks(entry.blocks);
    const changed = text !== entry.text;
    entry.text = text;
    entry.complete = entry.blocks.length > 0 && !Array.from(entry.blocks).includes(undefined);
    entry.time = now;
    entry.done = false;
    this._absorbFragments(entry);

    if (changed) this._emitRx({ id: entry.rxId, text, done: false, complete: false });

    this.clearTimer(entry.timer);
    if (frame.continues === false) {
      this._finishText(entry);
    } else {
      // L'émission semble continuer : on attend la suite, sans laisser le
      // correspondant sans réponse si le signal s'est en fait arrêté.
      entry.timer = this.setTimer(() => this._finishText(entry), LINK.RX_STABLE * 1000);
    }
  }

  /**
   * Bloc 0 d'un étendu perdu : la suite arrive seule et passe pour un message
   * entier. Quand la répétition complète arrive, ce fragment fait double emploi :
   * on le retire (l'application supprime sa bulle).
   */
  _absorbFragments(entry) {
    if (!entry.complete) return;
    for (const e of this._rxTexts.slice()) {
      if (e === entry || e.blocks.length >= entry.blocks.length) continue;
      const o = this._matchBlocks(entry.blocks, e.blocks);
      if (o === null || o < 0 || o + e.blocks.length > entry.blocks.length) continue;
      if (Array.from(e.blocks).some((b, j) => b === undefined || entry.blocks[o + j] !== b)) continue;
      this.clearTimer(e.timer);
      this._rxTexts.splice(this._rxTexts.indexOf(e), 1);
      this.log('RX fragment ' + e.rxId + ' remplacé par ' + entry.rxId);
      this._emitRx({ id: e.rxId, superseded: entry.rxId });
    }
  }

  _finishText(entry) {
    this.clearTimer(entry.timer);
    entry.timer = null;
    entry.done = true;
    const willAck = this.ackEnabled(entry.text);
    this._emitRx({ id: entry.rxId, text: entry.text, done: true, complete: entry.complete });
    this._ackText(entry, willAck);
  }

  _ackText(entry, willAck) {
    if (!willAck || !this.ackEnabled(entry.text)) return;
    this.log('TX ACK texte ' + textHash(entry.text).toString(16));
    this._sendAck(entry.rxId, [{ kind: 'tele', value: SonoFrame.ackText(textHash(entry.text), this.callsign()) }]);
  }

  /**
   * Décalage o tel que neu[j] corresponde à old[o + j] : au moins un bloc en
   * commun, aucun désaccord. Le plus grand recouvrement l'emporte ; null sinon.
   */
  _matchBlocks(old, neu) {
    let best = null, bestOverlap = 0;
    for (let o = -(neu.length - 1); o <= old.length - 1; o++) {
      let overlap = 0, ok = true;
      for (let j = 0; j < neu.length && ok; j++) {
        const b = old[o + j];
        if (b === undefined) continue;
        if (b === neu[j]) overlap++; else ok = false;
      }
      if (ok && overlap > bestOverlap) { best = o; bestOverlap = overlap; }
    }
    return best;
  }

  _assembleBlocks(blocks) {
    const last = blocks.length - 1;
    return Array.from(blocks, (b, i) => (b === undefined ? LINK.MISSING : i < last ? b.padEnd(13, ' ') : b))
      .join('').trimEnd();
  }

  _emitRx(ev) {
    if (this.onRx) this.onRx(ev);
  }

  _prune() {
    const now = this.now(), ttl = LINK.RX_SESSION_TTL * 1000;
    for (const [k, s] of this._rxMulti) if (now - s.lastSeen > ttl) this._rxMulti.delete(k);
    this._rxTexts = this._rxTexts.filter((e) => now - e.time < ttl);
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = { SonoLink, SonoFrame, LINK, textHash };
}
