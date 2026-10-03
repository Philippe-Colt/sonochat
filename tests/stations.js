// Simulation de bout en bout : 3 stations ChatMTX réelles (Chromium headless) reliées
// par un « air » simulé. Le modem est remplacé : chaque émission est décodée
// (symboles → bits → texte/télémétrie FT8) puis distribuée aux autres stations,
// bloc par bloc pour l'étendu, avec pertes injectables. Temps accéléré ×10.
// 23 scénarios : adressage, en l'air, pertes, répétitions, RPT, 9-line, MIST,
// collationnement, alerte, sélecteur de destinataire. ~6 min.
//
// Prérequis (hors dépôt, pas de dépendance du projet) :
//   npm i -g playwright-core && npx playwright install chromium
// Usage : node tests/stations.js        (CHROMIUM=/chemin/chrome pour un autre navigateur)
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) {
  try { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright-core')); } catch (e2) {
    console.error('playwright-core introuvable : npm i -g playwright-core && npx playwright install chromium');
    process.exit(2);
  }
}
const fs = require('fs'), path = require('path'), http = require('http');
const K = 0.1;               // accélération : durées d'émission et délais SonoLink
const LAT = 0.2;             // s : latence de décodage (2 s réels)
const SR = 12000;
const ROOT = path.join(__dirname, '..');
let URL = '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => { URL = 'http://127.0.0.1:' + srv.address().port + '/index.html'; resolve(srv); });
  });
}
function chromePath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  const dir = fs.existsSync(base) && fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  return dir ? path.join(base, dir, 'chrome-linux64/chrome') : undefined;
}
const STATIONS = ['PC', 'XY', 'ZZ'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pages = {};
let drop = () => false;      // (from, to, desc) → perdre cette trame chez `to` ?
let undecoded = () => false; // trame perdue mais synchro forte → RPT possible
let txLog = [];              // {from, kind, desc}
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;

function teleType(v) {
  const b = BigInt(v);
  const type = Number(b >> 69n);
  return { type: ['data', 'ack', 'rpt', 'pos'][type] || '?', seq: type === 0 ? Number((b >> 60n) & 15n) : type === 2 ? Number((b >> 60n) & 15n) : null };
}

// Appelée par la page émettrice pour chaque séquence de symboles
async function air(from, fr, dur, freq) {
  if (global.__tamper) fr = global.__tamper(from, fr) || fr;
  const start = now();
  const absBase = Math.round((start / K) * SR);
  const desc = fr.telemetry !== null ? { kind: 'tele', ...teleType(fr.telemetry) } : { kind: fr.blocks.length > 1 ? 'ext' : 'text', text: fr.blocks.join('|') };
  txLog.push({ t: start, wall: Date.now(), freq, from, ...desc });
  for (const to of STATIONS) {
    if (to === from) continue;
    const page = pages[to];
    // Comme le modem : trame repérée à l'antenne jusqu'à son décodage (pas d'émission par-dessus)
    page.evaluate((ms) => { window.__busyUntil = Math.max(window.__busyUntil || 0, Date.now() + ms); }, (dur + LAT) * 1000 + 300).catch(() => {});
    if (fr.telemetry !== null || fr.blocks.length === 1) {
      const f = fr.telemetry !== null ? { telemetry: fr.telemetry } : { text: fr.blocks[0] };
      setTimeout(async () => {
        if (drop(from, to, desc)) {
          if (undecoded(from, to, desc)) await page.evaluate((p) => window.__undecoded(p), absBase).catch(() => {});
          return;
        }
        await page.evaluate((x) => window.__deliver(x), { ...f, ext: false, continues: false, absPos: absBase }).catch(() => {});
      }, (dur + LAT) * 1000);
      continue;
    }
    // Étendu : bloc k décodable quand sa fenêtre de 79 symboles est passée ; on livre
    // la suite contiguë de blocs reçus (comme le modem), « continues » sauf au dernier
    let run = [];
    fr.blocks.forEach((b, k) => {
      if (drop(from, to, { ...desc, block: k })) { run = []; return; }
      run.push({ b, k });
      const snap = run.slice();
      const last = k === fr.blocks.length - 1;
      const at = ((k * 72 + 79 + 4) * 0.16 * K + LAT) * 1000;
      setTimeout(() => {
        const alone = snap.length === 1;
        const text = alone ? snap[0].b : snap.map((x, i) => (i < snap.length - 1 ? x.b.padEnd(13) : x.b)).join('').trimEnd();
        page.evaluate((x) => window.__deliver(x), {
          text, ext: !alone, blocks: alone ? null : snap.map((x) => x.b), continues: !last,
          absPos: absBase + Math.round(snap[0].k * 72 * 0.16 * SR),
        }).catch(() => {});
      }, at);
    });
  }
}

async function setupPage(page, name) {
  await page.evaluate(({ K, name }) => {
    for (const k of ['ACK_TIMEOUT', 'ACK_TIMEOUT_EXT', 'ACK_ROUNDTRIP', 'RX_STABLE', 'RX_SESSION_TTL', 'RX_DUP_WINDOW', 'RX_RPT_WINDOW', 'RX_QUIET', 'CLEAR_MAX', 'ACK_WAIT_MAX', 'CLEAR_GRACE']) LINK[k] *= K;
    FT8.MULTI_FRAME_GAP *= K;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const P = FT8Modem.prototype;
    P.startListening = async function () { window.__modem = this; this.listening = true; if (this.onStatusChange) this.onStatusChange('listening'); };
    P.stopListening = function () { this.listening = false; if (this.onStatusChange) this.onStatusChange('idle'); };
    P.cancelTransmit = async function () { this._txAborted = true; };
    P.channelBusy = function () { return this.listening && !this.transmitting && Date.now() < (window.__busyUntil || 0); };
    const decode = (sym) => {
      const n = sym.length === 79 ? 1 : (sym.length - 7) / 72;
      const blocks = [];
      let telemetry = null;
      for (let b = 0; b < n; b++) {
        const s = sym.slice(72 * b, 72 * b + 79);
        const bits = [];
        for (const i of [...Array(29).keys()].map((x) => x + 7).concat([...Array(29).keys()].map((x) => x + 43))) {
          const v = FT8.GRAY_UNMAP[s[i]];
          bits.push((v >> 2) & 1, (v >> 1) & 1, v & 1);
        }
        const payload = bits.slice(0, 77);
        const text = FT8Modem.decodeText(payload);
        if (text === null) telemetry = FT8Modem.decodeTelemetry(payload).toString();
        else blocks.push(text);
      }
      return { blocks, telemetry };
    };
    P.transmitSymbols = async function (list, opts = {}) {
      window.__modem = this;
      if (this.transmitting) throw new Error('Emission deja en cours');
      this.transmitting = true;
      this._txAborted = false;
      if (this.onStatusChange) this.onStatusChange('transmitting');
      for (let i = 0; i < list.length && !this._txAborted; i++) {
        if (opts.onProgress) opts.onProgress(i + 1, list.length);
        const fr = decode(list[i]);
        const dur = (list[i].length === 79 ? 79 : list[i].length) * 0.16 * K;
        await window.__air(name, fr, dur, this.baseFreq);
        await sleep(dur * 1000);
        if (i < list.length - 1) await sleep(FT8.MULTI_FRAME_GAP * 1000);
      }
      const aborted = this._txAborted;
      this.transmitting = false;
      this._txAborted = false;
      if (this.onStatusChange) this.onStatusChange(this.listening ? 'listening' : 'idle');
      return { aborted };
    };
    window.__deliver = (f) => {
      const m = window.__modem;
      if (!m || !m.listening || m.transmitting) return false; // semi-duplex
      m.onFrame({ text: f.text === undefined ? null : f.text, telemetry: f.telemetry ? BigInt(f.telemetry) : null,
        ext: !!f.ext, blocks: f.blocks || null, continues: !!f.continues, absPos: f.absPos, sampleRate: 12000, score: 100 });
      return true;
    };
    window.__undecoded = (absPos) => { const m = window.__modem; if (m && m.listening && !m.transmitting && m.onUndecoded) m.onUndecoded({ absPos, score: 60 }); };
  }, { K, name });
  await page.click('#btn-listen'); // écoute (modem simulé)
}

async function freshAll(extra = {}) {
  for (const name of STATIONS) {
    const page = pages[name];
    await page.evaluate(({ name, extra }) => {
      localStorage.clear();
      localStorage.setItem('sonochat-settings', JSON.stringify({ callsign: name, v: 3, txMode: 'extended', dest: '',
        stationPos: '31U DQ 4825 1193', contactFreq: '145.500', ...(extra[name] || {}) }));
      localStorage.setItem('sonochat-directory', JSON.stringify({ PC: 'F4MTX', XY: 'F4XYZ' }));
    }, { name, extra });
    // Rechargement : parfois un script manque (aléa du banc, service worker en cours) → nouvel essai
    for (let k = 0; k < 3; k++) {
      await page.reload();
      if (await page.evaluate(() => typeof SonoLink === 'function' && typeof LINK === 'object' && typeof TacMap === 'object')) break;
    }
    await setupPage(page, name);
  }
  drop = () => false;
  undecoded = () => false;
  txLog = [];
}

async function setDest(page, call) {
  await page.click('#dest-call');
  await page.waitForSelector('.mv-picker');
  const btn = await page.$(`.mv-picker [data-call="${call}"]`);
  if (btn) await btn.click();
  else { await page.fill('#mv-call-input', call); await page.click('.mv-picker [data-act="other"]'); }
}

async function setMode(page, mode) {
  await page.evaluate((m) => { const s = document.getElementById('setting-tx-mode'); s.value = m; s.dispatchEvent(new Event('change')); }, mode);
}

async function sendText(from, to, text, mode = 'extended') {
  const page = pages[from];
  await setMode(page, mode);
  await setDest(page, to);
  await page.fill('#msg-input', text);
  await page.click('#btn-send');
}

/** Saisie complète d'un 9-line (+ MIST) par l'interface. */
async function send9(from, to, { mist = 0, remark = '' } = {}) {
  const page = pages[from];
  await setDest(page, to);
  await page.click('#btn-medevac');                          // 9-line direct
  await page.click('[data-act="next"]');                     // guerre
  await page.click('[data-act="next"]');                     // 1 position station
  await page.click('[data-act="next"]');                     // 2 fréquence
  await page.click('[data-counter="c0"] [data-d="1"]');
  await page.click('[data-counter="c2"] [data-d="1"]');
  await page.click('[data-counter="c2"] [data-d="1"]');
  await page.click('[data-act="next"]');                     // 3
  await page.click('[data-act="next"]');                     // 4 aucun
  await page.click('[data-counter="litter"] [data-d="1"]');
  await page.click('[data-act="next"]');                     // 5
  await page.click('[data-i="1"]'); await sleep(400);        // 6 → auto
  await page.click('[data-i="2"]'); await sleep(400);        // 7 → auto
  await page.click('[data-i="3"]');
  await page.click('[data-act="next"]');                     // 8
  await page.click('[data-act="next"]');                     // 9 aucune
  for (let p = 0; p < mist; p++) {
    await page.click('[data-act="addmist"]');
    await page.click('[data-act="next"]');                   // n°/urgence
    await page.click('[data-act="next"]');                   // AT : « ? »
    await page.click('[data-i="1"]');                        // explosion
    await page.click('[data-act="next"]');
    await page.click('[data-i="2"]');                        // thorax
    await page.click('[data-act="next"]');
    await page.click('[data-i="1"]'); await sleep(400);      // AVPU V → auto
    await page.click('[data-counter="pulse"] [data-d="5"]');
    await page.click('[data-act="next"]');
    await page.click('[data-i="0"]');                        // garrot
    await page.click('[data-act="next"]');
  }
  if (remark) await page.fill('#mv-remark', remark);
  await page.click('[data-act="next"]');                     // Envoyer
}

/** Remplit un format générique par l'interface (premier choix proposé à chaque écran) et l'envoie. */
async function sendFormat(from, to, marker, { text = '' } = {}) {
  const page = pages[from];
  await setDest(page, to);
  await page.click('#btn-msg');
  await page.click(`[data-act="${marker}"]`);
  for (let i = 0; i < 25; i++) {
    const send = await page.$('.mv-navbtn.mv-send');
    if (send) {
      if (text) await page.fill('#mv-remark', text);
      await send.click();
      return;
    }
    const next = await page.$('[data-act="next"]');
    if (next && await next.isDisabled()) {
      const station = await page.$('[data-pos="station"]');
      const pick = station || await page.$('.mv-body button.mv-big:not(.on):not([data-none]):not([data-pos])');
      await pick.click();
      await sleep(450); // passage automatique éventuel
      continue;
    }
    // Un compteur bougé quand il y en a (effectifs, victimes) : message moins trivial
    const PLUS = '.mv-body [data-counter] [data-d]:not([data-d^="-"]):not([data-d="?"])';
    const nPlus = (await page.$$(PLUS)).length; // chaque clic redessine l'écran : on relocalise
    for (let k = 0; k < nPlus; k++) await page.locator(PLUS).nth(k).click();
    await page.click('[data-act="next"]');
  }
  throw new Error('saisie ' + marker + ' inachevée');
}

async function sendMistOnly(from, to) {
  const page = pages[from];
  await setDest(page, to);
  await page.click('#btn-msg');
  await page.click('[data-act="mist"]');
  await page.click('[data-act="next"]');                     // n°/urgence
  await page.click('[data-act="next"]');                     // AT : laissé « ? » → MIST court
  await page.click('[data-i="0"]');                          // mécanisme
  await page.click('[data-act="next"]');
  await page.click('[data-act="next"]');
  await page.click('[data-i="0"]'); await sleep(400);
  await page.click('[data-act="next"]');
  await page.click('[data-act="next"]');
  await page.click('[data-act="next"]');                     // Envoyer
}

/** État lisible d'une station : bulles, alerte, destinataire, mode. */
async function state(name) {
  return pages[name].evaluate(() => ({
    bubbles: [...document.querySelectorAll('.message')].map((m) => ({
      type: m.classList.contains('sent') ? 'TX' : 'RX',
      head: (m.querySelector('.msg-call') || {}).innerText.replace(/\s+/g, ' ').trim(),
      text: (m.querySelector('.mv-card-title') ? '[' + m.querySelector('.mv-card-title').innerText + '] '
        + [...m.querySelectorAll('.mv-line')].slice(0, 9).map((l) => l.innerText.replace(/\s+/g, ' ')).join(' / ')
        : m.querySelector('.msg-text').innerText).slice(0, 140),
      rb: (m.querySelector('.mv-rb') || {}).innerText || '',
      status: ((m.querySelector('.msg-meta') || {}).innerText || '').replace(/\s+/g, ' '),
      sending: m.classList.contains('sending'), receiving: m.classList.contains('receiving'),
    })),
    alert: document.body.classList.contains('alert-9line'),
    dest: document.getElementById('dest-call').textContent,
    mode: document.getElementById('setting-tx-mode').value,
    busy: window.__modem ? window.__modem.transmitting : false,
  }));
}

async function waitQuiet(maxS = 60) {
  // Fin : plus personne n'émet et plus rien en cours depuis 3 s (temps accéléré)
  let calm = 0;
  for (let i = 0; i < maxS * 4; i++) {
    let busy = false;
    for (const n of STATIONS) {
      const s = await pages[n].evaluate(() => (window.__modem && window.__modem.transmitting)
        || !!document.querySelector('.message.sending, .message.receiving')).catch(() => false);
      if (s) busy = true;
    }
    const lastTx = txLog.length ? now() - txLog[txLog.length - 1].t : 99;
    calm = !busy && lastTx > 3 ? calm + 1 : 0;
    if (calm >= 8) return true;
    await sleep(250);
  }
  return false;
}

let fails = 0, total = 0;
function check(name, cond, detail) {
  total++;
  console.log((cond ? '    ok   ' : '    FAIL ') + name + (cond ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
  if (!cond) fails++;
}
const txBy = (n, pred = () => true) => txLog.filter((x) => x.from === n && pred(x)).length;
const acks = (n) => txBy(n, (x) => x.kind === 'tele' && x.type === 'ack');
const lastOf = (s, type) => s.bubbles.filter((b) => b.type === type).slice(-1)[0] || {};

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
async function scenario(title, fn) {
  if (ONLY.length && !ONLY.includes(title.split('.')[0])) return;
  console.log('\n■ ' + title);
  try { await fn(); } catch (e) { fails++; total++; console.log('    FAIL exception : ' + e.message.split('\n')[0]); }
}

(async () => {
  const srv = await serve();
  const browser = await chromium.launch({ executablePath: chromePath() });
  for (const name of STATIONS) {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, geolocation: { latitude: 48.8530, longitude: 2.3499, accuracy: 5 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`    [${name}] ERREUR JS : ${e.message}`));
    await page.exposeFunction('__air', (from, fr, dur, freq) => air(from, fr, dur, freq));
    await page.goto(URL);
    pages[name] = page;
  }
  const LONG = 'MESSAGE LONG DE TEST POUR VERIFIER LA TRANSMISSION COMPLETE EN PLUSIEURS BLOCS AVEC ACCUSE DE RECEPTION 0123456789 FIN';

  await scenario('1. Standard PC → XY (9 car.)', async () => {
    await freshAll();
    await sendText('PC', 'XY', 'BONJOUR XY', 'standard');
    await waitQuiet();
    const pc = await state('PC'), xy = await state('XY'), zz = await state('ZZ');
    check('PC : confirmé par XY', /recu par F4XYZ/.test(lastOf(pc, 'TX').status), lastOf(pc, 'TX'));
    check('texte limité à 9 car. en standard', lastOf(pc, 'TX').text === 'BONJOUR X', lastOf(pc, 'TX').text);
    check('XY : « FM F4MTX TO moi », accusé envoyé', /FM F4MTX TO moi/.test(lastOf(xy, 'RX').head) && /accuse envoye/.test(lastOf(xy, 'RX').status), lastOf(xy, 'RX'));
    check('ZZ : reçu, « pour F4XYZ · pas de reponse »', /pour F4XYZ · pas de reponse/.test(lastOf(zz, 'RX').head), lastOf(zz, 'RX'));
    check('seul XY a émis un accusé, ZZ rien', acks('XY') === 1 && txBy('ZZ') === 0, txLog);
  });

  await scenario('2. Message en l\'air PC → 99 (étendu)', async () => {
    await freshAll();
    await sendText('PC', '99', 'APPEL GENERAL A TOUTES LES STATIONS');
    await waitQuiet();
    const pc = await state('PC'), xy = await state('XY'), zz = await state('ZZ');
    check('PC : « en l\'air, sans accuse », bulle TO Tous', /en l'air, sans accuse/.test(lastOf(pc, 'TX').status) && /TO Tous/.test(lastOf(pc, 'TX').head), lastOf(pc, 'TX'));
    check('XY et ZZ : « Message en l\'air · pour tous »', /Message en l'air/.test(lastOf(xy, 'RX').head) && /Message en l'air/.test(lastOf(zz, 'RX').head), [lastOf(xy, 'RX'), lastOf(zz, 'RX')]);
    check('personne ne répond', txBy('XY') === 0 && txBy('ZZ') === 0, txLog);
  });

  await scenario('3. Étendu 126 car. PC → XY', async () => {
    await freshAll();
    await sendText('PC', 'XY', LONG);
    await waitQuiet();
    const pc = await state('PC'), xy = await state('XY');
    check('confirmé par XY, 1 seule émission', /recu par F4XYZ/.test(lastOf(pc, 'TX').status) && txBy('PC') === 1, [lastOf(pc, 'TX'), txBy('PC')]);
    check('XY : texte complet intact (126 car.)', lastOf(xy, 'RX').text === LONG.slice(0, 126), lastOf(xy, 'RX').text.length);
  });

  await scenario('4. Multi-trame 126 car. PC → XY', async () => {
    await freshAll();
    await sendText('PC', 'XY', LONG, 'multi-frame');
    await waitQuiet(120);
    const pc = await state('PC'), xy = await state('XY'), zz = await state('ZZ');
    check('confirmé par XY', /recu par F4XYZ/.test(lastOf(pc, 'TX').status), lastOf(pc, 'TX'));
    check('13 trames, 13 accusés de XY, 0 de ZZ', txBy('PC', (x) => x.type === 'data') === 13 && acks('XY') === 13 && txBy('ZZ') === 0, { data: txBy('PC', (x) => x.type === 'data'), ackXY: acks('XY'), zz: txBy('ZZ') });
    check('XY et ZZ ont le texte complet', lastOf(xy, 'RX').text === LONG.slice(0, 126) && lastOf(zz, 'RX').text === LONG.slice(0, 126), [lastOf(xy, 'RX').text, lastOf(zz, 'RX').text]);
  });

  await scenario('5. Multi-trame en l\'air PC → 99', async () => {
    await freshAll();
    await sendText('PC', '99', LONG, 'multi-frame');
    await waitQuiet(120);
    const pc = await state('PC'), xy = await state('XY');
    check('envoyé d\'un trait, sans accusé', /en l'air/.test(lastOf(pc, 'TX').status) && txBy('XY') === 0 && txBy('ZZ') === 0, [lastOf(pc, 'TX'), txLog.length]);
    check('XY : message complet, pour tous', lastOf(xy, 'RX').text === LONG.slice(0, 126) && /Message en l'air/.test(lastOf(xy, 'RX').head), lastOf(xy, 'RX'));
  });

  await scenario('6. Destinataire absent (XY n\'entend rien)', async () => {
    await freshAll();
    drop = (from, to) => to === 'XY';
    await sendText('PC', 'XY', 'TU M ENTENDS');
    await waitQuiet(120);
    const pc = await state('PC');
    check('PC : échec après 1 + 3 répétitions', /non confirme/.test(lastOf(pc, 'TX').status) && txBy('PC') === 4, [lastOf(pc, 'TX'), txBy('PC')]);
    check('ZZ n\'accuse jamais à la place de XY', txBy('ZZ') === 0, txLog);
  });

  await scenario('7. Étendu : 1re émission perdue chez XY', async () => {
    await freshAll();
    let n = 0;
    drop = (from, to, d) => from === 'PC' && to === 'XY' && d.kind === 'ext' && d.block === 0 && n++ === 0;
    await sendText('PC', 'XY', LONG.slice(0, 60));
    await waitQuiet(120);
    const pc = await state('PC'), xy = await state('XY');
    check('confirmé à la 2e émission', /recu par F4XYZ/.test(lastOf(pc, 'TX').status) && txBy('PC') === 2, [lastOf(pc, 'TX'), txBy('PC')]);
    check('XY : une seule bulle, complète (fragment remplacé)', xy.bubbles.filter((b) => b.type === 'RX').length === 1 && lastOf(xy, 'RX').text === LONG.slice(0, 60).trim(), xy.bubbles);
  });

  await scenario('8. Accusé de XY perdu une fois', async () => {
    await freshAll();
    let n = 0;
    drop = (from, to, d) => from === 'XY' && to === 'PC' && d.type === 'ack' && n++ === 0;
    await sendText('PC', 'XY', 'ACCUSE PERDU UNE FOIS');
    await waitQuiet(120);
    const pc = await state('PC'), xy = await state('XY');
    check('PC répète puis confirmé', /recu par F4XYZ/.test(lastOf(pc, 'TX').status) && txBy('PC') === 2, [lastOf(pc, 'TX'), txBy('PC')]);
    check('XY : répétition reconnue, pas de doublon, réaccusée', xy.bubbles.filter((b) => b.type === 'RX').length === 1 && acks('XY') === 2, [xy.bubbles.length, acks('XY')]);
  });

  await scenario('9. Multi-trame : trame 2 perdue chez XY (RPT)', async () => {
    await freshAll();
    let n = 0;
    drop = (from, to, d) => from === 'PC' && to === 'XY' && d.type === 'data' && d.seq === 2 && n++ === 0;
    undecoded = (from, to) => to === 'XY';
    await sendText('PC', 'XY', LONG.slice(0, 60), 'multi-frame');
    await waitQuiet(120);
    const pc = await state('PC'), xy = await state('XY');
    check('confirmé par XY', /recu par F4XYZ/.test(lastOf(pc, 'TX').status), lastOf(pc, 'TX'));
    check('XY a demandé la répétition (RPT), ZZ non', txBy('XY', (x) => x.type === 'rpt') >= 1 && txBy('ZZ') === 0, txLog.filter((x) => x.type === 'rpt'));
    check('XY : texte complet', lastOf(xy, 'RX').text === LONG.slice(0, 60).trim(), lastOf(xy, 'RX').text);
  });

  await scenario('10. Conversation PC ↔ XY, ZZ écoute', async () => {
    await freshAll();
    await sendText('PC', 'XY', 'QRV ?');
    await waitQuiet();
    await sendText('XY', 'PC', 'QRV OUI');
    await waitQuiet();
    await sendText('PC', 'XY', 'MERCI 73');
    await waitQuiet();
    const pc = await state('PC'), xy = await state('XY'), zz = await state('ZZ');
    check('3 messages confirmés', pc.bubbles.filter((b) => /recu par/.test(b.status)).length === 2 && /recu par F4MTX/.test(lastOf(xy, 'TX').status), pc.bubbles.map((b) => b.status));
    check('ZZ voit les 3 échanges, sans répondre', zz.bubbles.filter((b) => b.type === 'RX').length === 3 && txBy('ZZ') === 0, zz.bubbles.map((b) => b.head));
  });

  await scenario('11. ZZ → XY pendant que PC écoute', async () => {
    await freshAll();
    await sendText('ZZ', 'XY', 'MESSAGE DE ZZ');
    await waitQuiet();
    const zz = await state('ZZ'), pc = await state('PC');
    check('confirmé par XY (code court XY affiché F4XYZ)', /recu par F4XYZ/.test(lastOf(zz, 'TX').status), lastOf(zz, 'TX'));
    check('PC : « FM ZZ TO F4XYZ · pour F4XYZ »', /FM ZZ TO F4XYZ/.test(lastOf(pc, 'RX').head) && /pas de reponse/.test(lastOf(pc, 'RX').head), lastOf(pc, 'RX'));
  });

  await scenario('12. 9-line PC → XY : alerte, accusé, collationnement', async () => {
    await freshAll();
    await send9('PC', 'XY');
    await waitQuiet(120);
    const pc = await state('PC'), xy = await state('XY'), zz = await state('ZZ');
    const sent = pc.bubbles.find((b) => b.type === 'TX');
    check('PC : 9-line confirmé par XY', /recu par F4XYZ/.test(sent.status), sent);
    check('PC : « Collationné conforme par F4XYZ »', /Collationné conforme par F4XYZ/.test(sent.rb), sent.rb);
    check('XY : alerte, destinataire = PC, mode étendu', xy.alert && xy.dest === 'F4MTX' && xy.mode === 'extended', [xy.alert, xy.dest, xy.mode]);
    const rb = xy.bubbles.find((b) => b.type === 'TX');
    check('XY : collationnement envoyé à PC et accusé par PC', rb && /COLLATIONNEMENT/.test(rb.text) && /TO F4MTX/.test(rb.head) && /recu par F4MTX/.test(rb.status), rb);
    check('ZZ : 9-line affiché, sans alerte ni réponse', !zz.alert && txBy('ZZ') === 0 && /9-LINE/.test(zz.bubbles[0].text), [zz.alert, zz.bubbles[0]]);
    check('2 blocs seulement pour le 9-line', txLog.find((x) => x.from === 'PC' && x.kind === 'ext').text.split('|').length === 2, txLog.find((x) => x.from === 'PC'));
    check('assis déduits : ligne 5 = L1 A2', /5 L1 A2/.test(sent.text), sent.text);
  });

  await scenario('13. 9-line + 2 MIST + remarque', async () => {
    await freshAll();
    await send9('PC', 'XY', { mist: 2, remark: 'LZ AU NORD DU PONT' });
    await waitQuiet(120);
    const pc = await state('PC'), xy = await state('XY');
    const sent = pc.bubbles.find((b) => b.type === 'TX');
    const got = xy.bubbles.find((b) => b.type === 'RX');
    check('confirmé + collationné conforme', /recu par F4XYZ/.test(sent.status) && /conforme/.test(sent.rb) && !/non conforme/.test(sent.rb), sent);
    check('XY : carte 9-LINE complète', /9-LINE/.test(got.text) && /31U DQ/.test(got.text), got.text);
    const nBlocks = txLog.find((x) => x.from === 'PC' && x.kind === 'ext').text.split('|').length;
    check('taille : ' + nBlocks + ' blocs', nBlocks >= 5 && nBlocks <= 6, nBlocks);
  });

  await scenario('14. MIST seul PC → XY : pas d\'alerte, collationnement', async () => {
    await freshAll();
    await sendMistOnly('PC', 'XY');
    await waitQuiet(120);
    const pc = await state('PC'), xy = await state('XY');
    const sent = pc.bubbles.find((b) => b.type === 'TX');
    check('XY sans alerte', !xy.alert, xy.alert);
    check('PC : MIST confirmé et collationné conforme', /recu par F4XYZ/.test(sent.status) && /conforme/.test(sent.rb), sent);
  });

  await scenario('15. Collationnement altéré → « non conforme »', async () => {
    await freshAll();
    // L'air modifie à chaque fois le dernier caractère du 9-line renvoyé par XY
    // (nationalité). Une altération ponctuelle serait rattrapée par l'empreinte
    // de l'accusé (XY répéterait le collationnement exact).
    const DIG = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
    global.__tamper = (from, fr) => {
      if (from !== 'XY' || fr.telemetry !== null) return fr;
      const all = fr.blocks.map((b, i) => (i < fr.blocks.length - 1 ? b.padEnd(13) : b)).join('');
      const k = all.indexOf('?9');
      if (k < 0) return fr;
      const p = k + 2 + 19; // dernier car. du 9-line
      const c = DIG[(DIG.indexOf(all[p]) + 1) % 41];
      const t = all.slice(0, p) + c + all.slice(p + 1);
      const blocks = [];
      for (let i = 0; i < t.length; i += 13) blocks.push(t.slice(i, i + 13).trimEnd());
      return { ...fr, blocks };
    };
    await send9('PC', 'XY');
    await waitQuiet(120);
    global.__tamper = null;
    const pc = await state('PC');
    const sent = pc.bubbles.find((b) => b.type === 'TX');
    check('PC : « non conforme : 8 »', /non conforme : 8/.test(sent.rb), sent.rb);
    const xy = await state('XY');
    const rb = xy.bubbles.find((b) => b.type === 'TX');
    check('XY : son collationnement n\'est pas confirmé (empreinte différente)', rb && !/recu par/.test(rb.status), rb && rb.status);
  });

  await scenario('16. 9-line pour ZZ, XY écoute : XY ne bouge pas', async () => {
    await freshAll();
    await send9('PC', 'ZZ');
    await waitQuiet(120);
    const xy = await state('XY'), zz = await state('ZZ');
    check('ZZ en alerte, XY non', zz.alert && !xy.alert, [zz.alert, xy.alert]);
    check('XY n\'émet rien', txBy('XY') === 0, txLog.filter((x) => x.from === 'XY'));
    check('XY : « pour ZZ · pas de reponse »', /pour ZZ · pas de reponse/.test(xy.bubbles[0].head), xy.bubbles[0].head);
  });

  await scenario('17. Fin d\'alerte : retour au destinataire et au mode d\'avant', async () => {
    await freshAll({ XY: { dest: '99', txMode: 'standard' } });
    await send9('PC', 'XY');
    await waitQuiet(120);
    let xy = await state('XY');
    check('pendant l\'alerte : TO F4MTX, étendu', xy.dest === 'F4MTX' && xy.mode === 'extended', [xy.dest, xy.mode]);
    await pages.XY.reload();
    await setupPage(pages.XY, 'XY');
    xy = await state('XY');
    check('alerte conservée après rechargement', xy.alert, xy.alert);
    await pages.XY.click('#btn-alert-end');
    xy = await state('XY');
    check('après « Fin d\'alerte » : 99 Tous, standard', !xy.alert && xy.dest === '99 Tous' && xy.mode === 'standard', [xy.alert, xy.dest, xy.mode]);
  });

  await scenario('18. Multi-trame en l\'air, trame 1 perdue chez XY', async () => {
    await freshAll();
    drop = (from, to, d) => to === 'XY' && d.type === 'data' && d.seq === 0;
    await sendText('PC', '99', LONG.slice(0, 40), 'multi-frame');
    await waitQuiet(60);
    const xy = await state('XY');
    check('XY : émetteur et destinataire inconnus, incomplet', /FM \? TO \?/.test(lastOf(xy, 'RX').head) && /incomplet/.test(lastOf(xy, 'RX').status), lastOf(xy, 'RX'));
    check('XY n\'émet rien (pas pour lui)', txBy('XY') === 0, txLog);
  });

  await scenario('19. Premier envoi sans destinataire : sélecteur', async () => {
    await freshAll();
    const page = pages.PC;
    await page.fill('#msg-input', 'SANS DEST');
    await page.click('#btn-send');
    const opened = !!(await page.waitForSelector('.mv-picker', { timeout: 3000 }).catch(() => null));
    check('le sélecteur s\'ouvre', opened);
    await page.click('.mv-picker [data-call="XY"]');
    await waitQuiet();
    const pc = await state('PC');
    check('puis le message part vers XY et est confirmé', /recu par F4XYZ/.test(lastOf(pc, 'TX').status) && /TO F4XYZ/.test(lastOf(pc, 'TX').head), lastOf(pc, 'TX'));
  });

  await scenario('20. Indicatif 99 refusé, 9-line vers 99 refusé', async () => {
    await freshAll();
    const page = pages.PC;
    await page.click('#btn-settings');
    await page.fill('#setting-callsign', '99');
    const mine = await page.evaluate(() => document.getElementById('my-call').textContent);
    check('indicatif 99 : refusé (« Indicatif ? »)', /Indicatif \?/.test(mine), mine);
    await page.fill('#setting-callsign', 'PC');
    await page.click('#btn-close-settings');
    await setDest(page, '99');
    await page.click('#btn-msg');
    const to = await page.textContent('.mv-body [data-act="to"]');
    check('composeur : « TO ? » (99 interdit)', /TO \?/.test(to), to);
    await page.click('[data-act="nine"]');
    const picker = await page.$('.mv-picker [data-call="99"]');
    check('sélecteur du 9-line sans « 99 · TOUS »', !picker);
    await page.fill('#mv-call-input', '99');
    await page.click('.mv-picker [data-act="other"]');
    const msg = await page.textContent('#mv-call-msg');
    check('saisie de 99 refusée', /destinataire précis/.test(msg), msg);
  });

  await scenario('21. Deux messages identiques de suite', async () => {
    await freshAll();
    await sendText('PC', 'XY', 'MEME TEXTE');
    await waitQuiet();
    await sleep(20000); // > fenêtre de doublon (18 s accélérée)
    await sendText('PC', 'XY', 'MEME TEXTE');
    await waitQuiet();
    const pc = await state('PC'), xy = await state('XY');
    check('les deux confirmés', pc.bubbles.filter((b) => /recu par/.test(b.status)).length === 2, pc.bubbles.map((b) => b.status));
    check('XY affiche deux messages', xy.bubbles.filter((b) => b.type === 'RX').length === 2, xy.bubbles.length);
  });

  await scenario('22. Étendu en l\'air, bloc 0 perdu chez XY', async () => {
    await freshAll();
    drop = (from, to, d) => to === 'XY' && d.kind === 'ext' && d.block === 0;
    await sendText('PC', '99', LONG.slice(0, 50));
    await waitQuiet();
    const xy = await state('XY');
    check('XY : « FM ? TO ? », texte précédé de …', /FM \? TO \?/.test(lastOf(xy, 'RX').head) && lastOf(xy, 'RX').text.startsWith('…'), lastOf(xy, 'RX'));
    check('XY n\'émet rien', txBy('XY') === 0, txLog);
  });

  await scenario('23. ZZ écoute un multi-trame PC → XY et perd une trame', async () => {
    await freshAll();
    drop = (from, to, d) => to === 'ZZ' && d.type === 'data' && d.seq === 3;
    await sendText('PC', 'XY', LONG.slice(0, 60), 'multi-frame');
    await waitQuiet(120);
    await sleep(6000); // fin de réception incomplète (RX_RPT_WINDOW accéléré)
    const zz = await state('ZZ'), pc = await state('PC');
    check('PC confirmé par XY', /recu par F4XYZ/.test(lastOf(pc, 'TX').status), lastOf(pc, 'TX'));
    check('ZZ : réception terminée « incomplet », pas bloquée', /incomplet/.test(lastOf(zz, 'RX').status) && !lastOf(zz, 'RX').receiving, lastOf(zz, 'RX'));
    check('ZZ n\'émet rien', txBy('ZZ') === 0, txLog);
  });

  const FMT = { E: ['METHANE', true, 2], R: ['RENSEIGNEMENT', false, 2], S: ['SALUTE', false, 2], K: ['CONTACT', true, 2],
    U: ['9-LINE UXO/IED', true, 2], L: ['LACE', false, 1], P: ['POSREP', false, 1] };
  for (const [marker, [title, alert, blocks]] of Object.entries(FMT)) {
    await scenario(`${23 + Object.keys(FMT).indexOf(marker) + 1}. ${title} PC → XY par le menu MSG`, async () => {
      await freshAll();
      await sendFormat('PC', 'XY', marker);
      await waitQuiet(120);
      const pc = await state('PC'), xy = await state('XY'), zz = await state('ZZ');
      const sent = pc.bubbles.find((b) => b.type === 'TX');
      const got = xy.bubbles.find((b) => b.type === 'RX');
      const tx = txLog.find((x) => x.from === 'PC');
      const nb = tx.kind === 'ext' ? tx.text.split('|').length : 1;
      check(`envoyé en ${blocks} bloc${blocks > 1 ? 's' : ''}`, nb === blocks, tx);
      check('confirmé par XY et collationné conforme', /recu par F4XYZ/.test(sent.status) && /Collationné conforme/.test(sent.rb), sent);
      check(`XY : carte ${title}`, got && got.text.startsWith('[' + title + ']'), got && got.text);
      check(alert ? 'XY en alerte « ALERTE ' + title + ' »' : 'pas d\'alerte', alert
        ? xy.alert && (await pages.XY.textContent('#medevac-alert-title')) === 'ALERTE ' + title : !xy.alert, xy.alert);
      check('ZZ : carte affichée, aucune réponse', txBy('ZZ') === 0 && zz.bubbles.some((b) => b.text.startsWith('[' + title + ']')), zz.bubbles.map((b) => b.text.slice(0, 30)));
    });
  }

  await scenario('31. Renseignement avec texte : 3 blocs au plus', async () => {
    await freshAll();
    await sendFormat('PC', 'XY', 'R', { text: 'IMMEUBLE R+4 FUMEES' });
    await waitQuiet(120);
    const pc = await state('PC');
    const tx = txLog.find((x) => x.from === 'PC');
    check('confirmé, texte transmis', /recu par F4XYZ/.test(lastOf(pc, 'TX').status) && /IMMEUBLE R\+4 FUMEES/.test(tx.text.replace(/\|/g, '')), tx);
    check('3 blocs', tx.text.split('|').length === 3, tx.text);
  });

  await scenario('32. AT-MIST (âge, sexe, hémorragie)', async () => {
    await freshAll();
    const page = pages.PC;
    await setDest(page, 'XY');
    await page.click('#btn-msg');
    await page.click('[data-act="mist"]');
    await page.click('[data-act="next"]');
    await page.click('[data-counter="age"] [data-d="5"]');
    await page.click('[data-sx="1"]'); await page.click('[data-hm="2"]');
    await page.click('[data-act="next"]');
    await page.click('[data-i="0"]'); await page.click('[data-act="next"]');
    await page.click('[data-act="next"]');
    await page.click('[data-i="0"]'); await sleep(400);
    await page.click('[data-act="next"]'); await page.click('[data-act="next"]');
    await page.click('[data-act="next"]');
    await waitQuiet(120);
    const xy = await state('XY');
    const tx = txLog.find((x) => x.from === 'PC');
    check('marqueur /A', /\/A1/.test(tx.text), tx.text);
    check('XY : carte AT-MIST avec âge et sexe', /^\[AT-MIST\]/.test(xy.bubbles[0].text) && /30 ans, Femme/.test(xy.bubbles[0].text), xy.bubbles[0].text);
  });

  await scenario('34. Carte tactique de XY après POSREP ×2, SALUTE, CONTACT', async () => {
    await freshAll();
    await sendFormat('PC', 'XY', 'P');
    await waitQuiet(60);
    await sleep(2000);
    // 2e POSREP ailleurs (saisie MGRS), puis SALUTE et CONTACT
    await setDest(pages.PC, 'XY');
    await pages.PC.click('#btn-msg'); await pages.PC.click('[data-act="P"]');
    await pages.PC.click('[data-pos="edit"]'); await pages.PC.fill('#mv-pos-input', '31U DQ 5000 1500');
    await pages.PC.click('.mv-edit button'); await pages.PC.click('[data-act="next"]');
    await pages.PC.click('.mv-navbtn.mv-send');
    await waitQuiet(60);
    await sendFormat('PC', 'XY', 'S');
    await waitQuiet(60);
    await sendFormat('PC', 'XY', 'K');
    await waitQuiet(60);
    const page = pages.XY;
    await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => false })); // pas de tuiles réseau
    await page.click('#btn-map');
    await sleep(1500);
    const n = await page.evaluate(() => ({
      syms: [...document.querySelectorAll('.tm-sym')].length,
      track: [...document.querySelectorAll('.leaflet-overlay-pane path')].filter((p) => p.getAttribute('stroke') === '#1f6fd1').length,
      contactLine: [...document.querySelectorAll('.leaflet-overlay-pane path')].filter((p) => p.getAttribute('stroke') === '#c62828').length,
    }));
    check('symboles : unité PC, SALUTE, CONTACT (+ moi éventuel)', n.syms >= 3, n);
    check('trajet des 2 POSREP de PC', n.track === 1, n);
    check('trait observateur → contact', n.contactLine === 1, n);
  });

  await scenario('35. Balise de position automatique de PC', async () => {
    await freshAll({ PC: { beaconOn: true, beaconMin: 10, beaconM: 500 } });
    await sleep(6000); // GPS + premier passage (3 s) + émission accélérée
    await waitQuiet(30);
    const beacons = txLog.filter((x) => x.from === 'PC' && x.type === 'pos');
    check('une trame de balise (télémétrie), rien d\'autre', beacons.length === 1 && txLog.filter((x) => x.from === 'PC').length === 1, txLog);
    const posXY = await pages.XY.evaluate(() => JSON.parse(localStorage.getItem('chatmtx-positions') || '{}'));
    const pt = posXY.PC && posXY.PC[posXY.PC.length - 1];
    check('XY : position de PC au mètre', pt && Math.abs(pt[0] - 48.8530) < 2e-5 && Math.abs(pt[1] - 2.3499) < 2e-5, posXY);
    const xy = await state('XY');
    check('XY : rien dans le fil, aucune réponse', xy.bubbles.length === 0 && txBy('XY') === 0 && txBy('ZZ') === 0, xy.bubbles);
    await pages.XY.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
    await pages.XY.click('#btn-map');
    await sleep(1200);
    const lbl = await pages.XY.evaluate(() => [...document.querySelectorAll('.tm-sym')].map((e) => e.textContent).join('|'));
    check('carte de XY : unité F4MTX (balise)', /F4MTX/.test(lbl) && /balise/.test(lbl), lbl);
    await sleep(3000);
    check('pas de 2e balise avant 1 min', txLog.filter((x) => x.from === 'PC' && x.type === 'pos').length === 1);
  });

  await scenario('36. Annuaire : canal d\'émission et créneau de balise', async () => {
    await freshAll();
    const DIR = '#reseau;creneau=13;tour=2;version=7;date=2026-10-03\nPC;F4MTX;infanterie;section;1460;2\nXY;F4XYZ;;;1400;1\nZZ;F1ZZZ\n';
    for (const name of STATIONS) {
      await pages[name].setInputFiles('#directory-file', { name: 'annuaire.csv', mimeType: 'text/csv', buffer: Buffer.from(DIR) });
    }
    await sleep(500);
    const pc = await pages.PC.evaluate(() => ({ f: window.__modem && window.__modem.baseFreq, dis: document.getElementById('setting-base-freq').disabled,
      st: document.getElementById('directory-status').textContent }));
    check('PC émet sur son canal 1460 Hz, réglage manuel verrouillé', pc.f === 1460 && pc.dis, pc);
    check('état : canal, créneau, version', /canal 1460 Hz/.test(pc.st) && /creneau 2\/2/.test(pc.st) && /version 7 du 2026-10-03/.test(pc.st), pc.st);
    const zz = await pages.ZZ.evaluate(() => ({ f: window.__modem.baseFreq, dis: document.getElementById('setting-base-freq').disabled }));
    check('ZZ sans canal : fréquence manuelle', zz.f === 1000 && !zz.dis, zz);
    await sendText('PC', 'XY', 'CANAUX', 'standard');
    await waitQuiet(30);
    const msg = txLog.find((x) => x.from === 'PC' && x.kind !== 'tele'), ack = txLog.find((x) => x.from === 'XY' && x.type === 'ack');
    check('message sur 1460 Hz, accusé de XY sur son canal 1400 Hz', msg && msg.freq === 1460 && ack && ack.freq === 1400, [msg, ack]);
    // Balise : seulement au début du créneau 2 (13-26 s de chaque tour de 26 s)
    const before = txLog.length;
    await pages.PC.evaluate(() => { const c = document.getElementById('setting-beacon'); c.checked = true; c.dispatchEvent(new Event('change')); });
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !txLog.slice(before).some((x) => x.type === 'pos')) await sleep(250);
    const b = txLog.slice(before).find((x) => x.type === 'pos');
    const phase = b ? b.wall % 26000 : -1;
    check('balise de PC au début de son créneau 2 (13 s après le début du tour)', b && phase >= 13000 && phase < 13000 + 1500 + 600, b && 'phase ' + phase + ' ms');
    check('balise sur le canal de PC', b && b.freq === 1460);
    const info = await pages.PC.evaluate(() => document.getElementById('beacon-info').textContent);
    check('paramètres : créneau affiché', /Creneau 2\/2/.test(info), info);
  });

  await scenario('37. Outil d\'annuaire : création, attribution, QR code, lien, collage', async () => {
    await freshAll();
    const P = pages.PC;
    const clickOr = (pg, sel) => pg.click(sel, { timeout: 5000 }).catch((e) => { throw new Error(sel + ' : ' + e.message.split('\n')[0]); });
    const dialogs = [];
    const onDialog = (d) => { dialogs.push(d.message()); d.accept(); };
    for (const name of STATIONS) pages[name].on('dialog', onDialog);
    await P.evaluate(() => document.getElementById('btn-directory-clear').click()); // part d'un annuaire vide (confirmation acceptée)
    await P.evaluate(() => document.getElementById('btn-directory-edit').click());
    const addStation = async (short, long, type) => {
      await clickOr(P, '.dir-tool [data-act="add"]');
      await P.fill('#dir-short', short);
      await P.fill('#dir-long', long);
      if (type) await P.selectOption('#dir-type', type);
      await clickOr(P, '.dir-tool [data-act="ok"]');
    };
    await addStation('ZZ', 'F1ZZZ');
    await addStation('PC', 'F4MTX', 'SFGPUCI--------');
    await addStation('XY', 'F4XYZ');
    // indicatif en double refusé
    await clickOr(P, '.dir-tool [data-act="add"]');
    await P.fill('#dir-short', 'XY');
    await clickOr(P, '.dir-tool [data-act="ok"]');
    check('indicatif en double refusé', /déjà dans l'annuaire/.test(await P.textContent('#dir-err')));
    await clickOr(P, '.dir-tool [data-act="back"]');
    check('avant attribution : stations sans canal signalées', /sans canal ou créneau : PC, XY, ZZ/.test(await P.textContent('.dir-probs')));
    await clickOr(P, '.dir-tool [data-act="alloc"]');
    const rows = await P.$$eval('.dir-row span', (xs) => xs.map((x) => x.textContent));
    check('ATTRIBUER : 1400/1460/1520 Hz, créneaux 1-3, sans conflit', rows.length === 3 && /Infanterie · 1400 Hz · créneau 1/.test(rows[0])
      && /1460 Hz · créneau 2/.test(rows[1]) && /1520 Hz · créneau 3/.test(rows[2]) && await P.$('.dir-ok') !== null, rows);
    await clickOr(P, '.dir-tool [data-act="save"]');
    const st = await P.evaluate(() => ({ f: window.__modem.baseFreq, sub: document.querySelector('.dir-tool .mv-titles p').textContent,
      net: JSON.parse(localStorage.getItem('chatmtx-directory-net')) }));
    check('ENREGISTRER : version 1, PC passe sur son canal', st.f === 1400 && /^Version 1 du \d{4}-\d\d-\d\d/.test(st.sub) && st.net.net.version === '1' && st.net.net.round === 3, st);
    await clickOr(P, '.dir-tool [data-act="qr"]');
    const qr = await P.evaluate(() => ({ svg: !!document.querySelector('.dir-qr svg'), sub: document.querySelector('.dir-tool .mv-titles p').textContent }));
    check('QR code affiché', qr.svg && /Version 1/.test(qr.sub), qr);
    await clickOr(P, '.dir-tool [data-act="back"]');
    await clickOr(P, '.dir-tool [data-act="close"]');
    const link = await P.evaluate(() => {
      const net = JSON.parse(localStorage.getItem('chatmtx-directory-net'));
      const txt = serializeDirectory(toEntries({ map: JSON.parse(localStorage.getItem('sonochat-directory')),
        units: JSON.parse(localStorage.getItem('sonochat-directory-units')), channels: net.channels }), net.net);
      return directoryLink(txt, location.origin + location.pathname.replace(/index\.html$/, ''));
    });
    // XY : le lien du QR code ouvert par l'appareil photo
    await pages.XY.goto('about:blank');
    await pages.XY.goto(link);
    await sleep(1500);
    const xy = await pages.XY.evaluate(() => ({ dir: JSON.parse(localStorage.getItem('sonochat-directory') || '{}'),
      net: JSON.parse(localStorage.getItem('chatmtx-directory-net') || 'null'), hash: location.hash,
      f: document.getElementById('setting-base-freq').value, dis: document.getElementById('setting-base-freq').disabled }));
    check('XY : lien du QR code → import proposé et appliqué, adresse nettoyée', xy.dir.PC === 'F4MTX' && xy.net && xy.net.channels.XY.freq === 1460
      && xy.net.net.version === '1' && xy.hash === '' && dialogs.some((d) => /Importer l'annuaire version 1/.test(d)), [xy, dialogs]);
    check('XY : canal 1460 Hz imposé', xy.f === '1460' && xy.dis, xy);
    // ZZ : lien collé dans l'outil
    await pages.ZZ.evaluate(() => DirectoryUI.open());
    await clickOr(pages.ZZ, '.dir-tool [data-act="paste"]');
    await pages.ZZ.fill('#dir-paste', link);
    await clickOr(pages.ZZ, '.dir-tool [data-act="ok"]');
    const zz = await pages.ZZ.evaluate(() => ({ msg: (document.querySelector('.dir-msg') || {}).textContent, rows: document.querySelectorAll('.dir-row').length,
      net: JSON.parse(localStorage.getItem('chatmtx-directory-net')) }));
    check('ZZ : lien collé → annuaire version 1 appliqué', zz.rows === 3 && /Reçu version 1/.test(zz.msg) && zz.net.channels.ZZ.freq === 1520, zz);
    // Modification puis nouvelle version
    await clickOr(pages.ZZ, '.dir-row >> nth=2');
    await clickOr(pages.ZZ, '.dir-tool [data-f="1"]');
    await clickOr(pages.ZZ, '.dir-tool [data-act="ok"]');
    await clickOr(pages.ZZ, '.dir-tool [data-act="save"]');
    const zz2 = await pages.ZZ.evaluate(() => JSON.parse(localStorage.getItem('chatmtx-directory-net')));
    check('modification : canal suivant (1580 Hz), version 2', zz2.channels.ZZ.freq === 1580 && zz2.net.version === '2', zz2);
    for (const name of STATIONS) pages[name].off('dialog', onDialog);
  });

  await scenario('33. MEDEVAC ouvre directement le 9-line', async () => {
    await freshAll();
    await setDest(pages.PC, 'XY');
    await pages.PC.click('#btn-medevac');
    check('premier écran : guerre / paix', /guerre ou de paix/.test(await pages.PC.textContent('.mv-head h2')));
  });

  console.log(`\n${total - fails}/${total} vérifications réussies` + (fails ? `, ${fails} échec(s)` : ''));
  await browser.close();
  srv.close();
  process.exit(fails ? 1 : 0);
})();
