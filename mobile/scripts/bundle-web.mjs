#!/usr/bin/env node
/**
 * Copie les fichiers du site (liste unique : ../web-files.txt, aussi lue par
 * deploy.sh) dans www/, embarqué dans l'APK : l'application fonctionne hors
 * ligne sans service worker. À lancer avant `cap sync android` (npm run sync).
 * www/ est régénérable et gitignoré.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEST = join(ROOT, 'mobile', 'www');

const files = readFileSync(join(ROOT, 'web-files.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
let bytes = 0;
for (const f of files) {
  copyFileSync(join(ROOT, f), join(DEST, f));
  bytes += statSync(join(DEST, f)).size;
}
// Version embarquee, comparee par l'application a apk-version.json en ligne
const { version } = JSON.parse(readFileSync(join(ROOT, 'mobile', 'package.json'), 'utf8'));
writeFileSync(join(DEST, 'app-version.json'), JSON.stringify({ version }) + '\n');
console.log(`www/ : ${files.length} fichiers, version ${version}, ${(bytes / 1024).toFixed(0)} Ko`);
