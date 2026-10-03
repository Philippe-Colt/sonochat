// Service des annuaires (server/annuaire-server.js) : lancé sur un port et un dossier
// temporaires. Usage : node tests/annuaire-server.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { TEST_DIRECTORY } = require('../directory.js');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

const PORT = 18790 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmtx-api-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'annuaire-server.js')],
  { env: Object.assign({}, process.env, { PORT, CHATMTX_DATA: DATA }), stdio: ['ignore', 'pipe', 'inherit'] });

let ip = 0;
async function call(op, body, opts = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/annuaire/${op}`, {
    method: opts.method || 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': opts.ip || '10.0.0.' + (++ip % 200) },
    body: opts.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, cors: r.headers.get('access-control-allow-origin'), ...(r.status === 204 ? {} : await r.json()) };
}

(async () => {
  await new Promise((r) => srv.stdout.once('data', r));
  const V1 = TEST_DIRECTORY.replace(/version=\d+/, 'version=1');
  const V2 = TEST_DIRECTORY.replace(/version=\d+/, 'version=2').replace('LIMA', 'MIKE');

  let r = await call('save', { reseau: 'test-1', code: 'secret42', text: V1 });
  check('création : nom réservé avec son code (nom en majuscules)', r.status === 200 && r.created && r.reseau === 'TEST-1' && r.stations === 12 && r.version === '1', r);
  check('CORS ouvert (application Android)', r.cors === '*');
  r = await call('load', { reseau: 'TEST-1', code: 'secret42' });
  check('chargement avec le bon code : fichier identique', r.status === 200 && r.text === V1, r);
  r = await call('load', { reseau: 'TEST-1', code: 'mauvais1' });
  const r2 = await call('load', { reseau: 'INCONNU', code: 'secret42' });
  check('code faux et réseau inconnu : même refus', r.status === 403 && r2.status === 403 && r.error === r2.error, [r, r2]);
  r = await call('save', { reseau: 'TEST-1', code: 'mauvais1', text: V2 });
  check('remplacement avec un code faux refusé', r.status === 403);
  r = await call('save', { reseau: 'TEST-1', code: 'secret42', text: V2 });
  check('remplacement avec le bon code', r.status === 200 && !r.created && r.version === '2', r);
  r = await call('load', { reseau: 'test-1', code: 'secret42' });
  check('nouvelle version chargée', r.text === V2);
  const hist = fs.readdirSync(path.join(DATA, 'annuaires', 'historique'));
  check('version précédente gardée dans l\'historique', hist.length === 1 && fs.readdirSync(path.join(DATA, 'annuaires', 'historique', hist[0])).length === 1);
  const stored = fs.readFileSync(path.join(DATA, 'annuaires', fs.readdirSync(path.join(DATA, 'annuaires')).find((f) => f.endsWith('.json'))), 'utf8');
  check('code jamais stocké en clair', !/secret42/.test(stored));
  r = await call('save', { reseau: 'TEST-2', code: 'secret42', text: 'bonjour\n' });
  check('fichier qui n\'est pas un annuaire refusé', r.status === 400, r);
  r = await call('save', { reseau: 'X', code: 'secret42', text: TEST_DIRECTORY });
  const r3 = await call('save', { reseau: 'TEST-3', code: '123', text: TEST_DIRECTORY });
  check('nom trop court, code trop court refusés', r.status === 400 && r3.status === 400, [r, r3]);
  r = await call('save', { reseau: 'TEST-4', code: 'secret42', text: 'PC;F4MTX\n'.repeat(5000) });
  check('requête trop grande refusée', r.status === 413, r.status);
  r = await call('load', 'pas du json');
  check('requête illisible', r.status === 400);
  r = await call('load', null, { method: 'GET' });
  check('GET refusé', r.status === 405);
  // Codes faux répétés depuis une même adresse : bloquée
  for (let i = 0; i < 10; i++) await call('load', { reseau: 'TEST-1', code: 'mauvais' + i }, { ip: '10.9.9.9' });
  r = await call('load', { reseau: 'TEST-1', code: 'secret42' }, { ip: '10.9.9.9' });
  check('10 codes faux : adresse bloquée une heure, même avec le bon code', r.status === 429, r);

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
