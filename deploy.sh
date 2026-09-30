#!/usr/bin/env bash
# Publie SonoChat dans /srv/sonochat, servi par Caddy sur sonochat.f4mtx.com.
# La version du cache du Service Worker devient l'empreinte des fichiers servis :
# toute modification déclenche la mise à jour chez les clients, même installés.
set -euo pipefail

cd "$(dirname "$0")"
DEST=/srv/sonochat
FILES=(index.html style.css ft8-modem.js app.js sw.js manifest.json icon.svg icon-192.png icon-512.png)

node -c ft8-modem.js
node -c app.js
node -c sw.js

HASH=$(cat "${FILES[@]}" | sha256sum | cut -c1-12)

sudo install -d -m 755 "$DEST"
sudo install -m 644 "${FILES[@]}" "$DEST/"
sudo sed -i "s/const CACHE_NAME = '[^']*';/const CACHE_NAME = 'sonochat-$HASH';/" "$DEST/sw.js"

echo "Déployé dans $DEST (cache sonochat-$HASH) → https://sonochat.f4mtx.com"
