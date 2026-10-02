#!/usr/bin/env bash
# Publie ChatMTX dans /srv/chatmtx, servi par Caddy sur chatmtx.f4mtx.com.
# La version du cache du Service Worker devient l'empreinte des fichiers servis :
# toute modification déclenche la mise à jour chez les clients, même installés.
# L'ancienne adresse sonochat.f4mtx.com sert legacy/ (migration vers la nouvelle).
set -euo pipefail

cd "$(dirname "$0")"
DEST=/srv/chatmtx
LEGACY=/srv/sonochat
mapfile -t FILES < <(grep -v '^\s*\(#\|$\)' web-files.txt)
APK=dist/chatmtx.apk

for f in "${FILES[@]}"; do
  case "$f" in *.js) node -c "$f" ;; esac
done
node -c legacy/sw.js

HASH=$(cat "${FILES[@]}" | sha256sum | cut -c1-12)

sudo install -d -m 755 "$DEST"
sudo install -m 644 "${FILES[@]}" "$DEST/"
sudo sed -i "s/const CACHE_NAME = '[^']*';/const CACHE_NAME = 'chatmtx-$HASH';/" "$DEST/sw.js"

# Ancienne adresse : page de migration et Service Worker qui se désinstalle.
# Caddy y sert aussi apk-version.json et l'APK de $DEST (applications 1.1.x).
sudo install -d -m 755 "$LEGACY"
sudo install -m 644 legacy/index.html legacy/sw.js "$LEGACY/"

# Application Android (mobile/scripts/build-apk.sh) : telechargee, jamais mise en cache par le SW
if [ -f "$APK" ]; then
  sudo install -m 644 "$APK" "$DEST/chatmtx.apk"
  # Version de l'APK : declenche la mise a jour obligatoire dans les applications plus anciennes
  [ -f dist/apk-version.json ] && sudo install -m 644 dist/apk-version.json "$DEST/apk-version.json"
  echo "APK publie : https://chatmtx.f4mtx.com/chatmtx.apk ($(du -h "$APK" | cut -f1))"
fi

echo "Déployé dans $DEST (cache chatmtx-$HASH) → https://chatmtx.f4mtx.com"
