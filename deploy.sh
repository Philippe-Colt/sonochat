#!/usr/bin/env bash
# Publie SonoChat dans /srv/sonochat, servi par Caddy sur sonochat.f4mtx.com.
# La version du cache du Service Worker devient l'empreinte des fichiers servis :
# toute modification déclenche la mise à jour chez les clients, même installés.
set -euo pipefail

cd "$(dirname "$0")"
DEST=/srv/sonochat
mapfile -t FILES < <(grep -v '^\s*\(#\|$\)' web-files.txt)
APK=dist/sonochat.apk

for f in "${FILES[@]}"; do
  case "$f" in *.js) node -c "$f" ;; esac
done

HASH=$(cat "${FILES[@]}" | sha256sum | cut -c1-12)

sudo install -d -m 755 "$DEST"
sudo install -m 644 "${FILES[@]}" "$DEST/"
sudo sed -i "s/const CACHE_NAME = '[^']*';/const CACHE_NAME = 'sonochat-$HASH';/" "$DEST/sw.js"

# Application Android (mobile/scripts/build-apk.sh) : telechargee, jamais mise en cache par le SW
if [ -f "$APK" ]; then
  sudo install -m 644 "$APK" "$DEST/sonochat.apk"
  # Version de l'APK : declenche la mise a jour obligatoire dans les applications plus anciennes
  [ -f dist/apk-version.json ] && sudo install -m 644 dist/apk-version.json "$DEST/apk-version.json"
  echo "APK publie : https://sonochat.f4mtx.com/sonochat.apk ($(du -h "$APK" | cut -f1))"
fi

echo "Déployé dans $DEST (cache sonochat-$HASH) → https://sonochat.f4mtx.com"
