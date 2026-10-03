#!/usr/bin/env node
/**
 * Annuaires ChatMTX sur le serveur : enregistrer et charger un annuaire par nom de réseau,
 * protégé par un code. Sans dépendance (Node ≥ 18), derrière Caddy :
 *   reverse_proxy /api/* 127.0.0.1:8790
 *
 * POST /api/annuaire/save  {reseau, code, text}  → {ok, reseau, version, savedAt, created}
 * POST /api/annuaire/load  {reseau, code}        → {ok, reseau, text, savedAt}
 *   Le premier enregistrement d'un nom le réserve avec son code ; ensuite, il faut ce code
 *   pour charger comme pour remplacer. Code faux ou réseau inconnu : même réponse (403).
 *   Le code n'est jamais stocké : empreinte scrypt salée. Les 20 versions précédentes
 *   sont gardées (historique/), le fichier doit être un annuaire valide (directory.js).
 *
 * Données : $CHATMTX_DATA (défaut /var/lib/chatmtx) / annuaires / <sha256(nom)>.json
 * Port : $PORT (défaut 8790), écoute sur 127.0.0.1 seulement.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// directory.js copié à côté (installation) ou celui du dépôt (développement)
const { parseDirectory } = require(fs.existsSync(path.join(__dirname, 'directory.js')) ? './directory.js' : '../directory.js');

const PORT = +(process.env.PORT || 8790);
const DATA = path.join(process.env.CHATMTX_DATA || '/var/lib/chatmtx', 'annuaires');
const MAX_BODY = 32 * 1024;     // un annuaire de 98 stations fait ~4 Ko
const KEEP_VERSIONS = 20;
const NAME_RE = /^[A-Z0-9_-]{3,20}$/;
const CODE_MIN = 6, CODE_MAX = 64;
const RATE = { windowMs: 10 * 60 * 1000, max: 30 }; // requêtes par adresse et par 10 min
const FAIL = { windowMs: 60 * 60 * 1000, max: 10 };  // codes faux par adresse et par heure

fs.mkdirSync(path.join(DATA, 'historique'), { recursive: true });

const hits = new Map(), fails = new Map();
function count(map, key, win) {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < win);
  map.set(key, list);
  return list;
}
setInterval(() => { for (const m of [hits, fails]) for (const [k, v] of m) if (!v.length) m.delete(k); }, 60000).unref();

const fileOf = (name) => path.join(DATA, crypto.createHash('sha256').update(name).digest('hex') + '.json');
const hashCode = (code, salt) => crypto.scryptSync(code, salt, 32).toString('hex');

function read(name) {
  try { return JSON.parse(fs.readFileSync(fileOf(name), 'utf8')); } catch (e) { return null; }
}

function codeOk(rec, code) {
  const h = Buffer.from(hashCode(code, rec.salt), 'hex');
  const ref = Buffer.from(rec.codeHash, 'hex');
  return h.length === ref.length && crypto.timingSafeEqual(h, ref);
}

function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function archive(name, rec) {
  const dir = path.join(DATA, 'historique', path.basename(fileOf(name), '.json'));
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, rec.savedAt.replace(/[:.]/g, '-') + '.csv'), rec.text);
  const old = fs.readdirSync(dir).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_VERSIONS))) fs.unlinkSync(path.join(dir, f));
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // Application Android (origine https://localhost) et site : pas de cookie, le code fait foi
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function handle(req, res, body) {
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const h = count(hits, ip, RATE.windowMs);
  if (h.length >= RATE.max) return send(res, 429, { ok: false, error: 'Trop de requêtes : réessayer dans quelques minutes.' });
  h.push(Date.now());
  if (count(fails, ip, FAIL.windowMs).length >= FAIL.max) {
    return send(res, 429, { ok: false, error: 'Trop de codes faux : réessayer dans une heure.' });
  }

  let q;
  try { q = JSON.parse(body); } catch (e) { return send(res, 400, { ok: false, error: 'Requête illisible.' }); }
  const name = String(q.reseau || '').trim().toUpperCase();
  const code = String(q.code || '');
  if (!NAME_RE.test(name)) return send(res, 400, { ok: false, error: 'Nom du réseau : 3 à 20 lettres, chiffres, - ou _.' });
  if (code.length < CODE_MIN || code.length > CODE_MAX) return send(res, 400, { ok: false, error: 'Code : ' + CODE_MIN + ' caractères au moins.' });
  const rec = read(name);
  const denied = () => {
    count(fails, ip, FAIL.windowMs).push(Date.now());
    return send(res, 403, { ok: false, error: 'Réseau inconnu ou code faux.' });
  };

  if (req.url === '/api/annuaire/load') {
    if (!rec || !codeOk(rec, code)) return denied();
    return send(res, 200, { ok: true, reseau: name, text: rec.text, savedAt: rec.savedAt });
  }

  if (req.url === '/api/annuaire/save') {
    const text = String(q.text || '');
    const p = parseDirectory(text);
    if (!p.imported) return send(res, 400, { ok: false, error: 'Ce n\'est pas un annuaire ChatMTX valide.' });
    if (rec && !codeOk(rec, code)) return denied();
    const salt = rec ? rec.salt : crypto.randomBytes(16).toString('hex');
    const next = { name, salt, codeHash: rec ? rec.codeHash : hashCode(code, salt), text, version: p.net.version || '',
      stations: p.imported, savedAt: new Date().toISOString(), createdAt: rec ? rec.createdAt : new Date().toISOString() };
    if (rec) archive(name, rec);
    writeAtomic(fileOf(name), JSON.stringify(next));
    console.log(`[annuaire] ${name} ${rec ? 'remplacé' : 'créé'} : ${p.imported} stations, version ${next.version || '-'} (${ip})`);
    return send(res, 200, { ok: true, reseau: name, version: next.version, stations: p.imported, savedAt: next.savedAt, created: !rec });
  }

  send(res, 404, { ok: false, error: 'Inconnu.' });
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST seulement.' });
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { ok: false, error: 'Annuaire trop grand.' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    try { handle(req, res, Buffer.concat(chunks).toString('utf8')); } catch (e) {
      console.error('[annuaire] erreur', e);
      send(res, 500, { ok: false, error: 'Erreur du serveur.' });
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`[annuaire] écoute sur 127.0.0.1:${PORT}, données ${DATA}`));
