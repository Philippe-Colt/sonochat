#!/bin/bash
# Installe ou met à jour le service des annuaires (sudo). Appelé par deploy.sh.
#   /opt/chatmtx-api : annuaire-server.js + directory.js ; données : /var/lib/chatmtx
#   Caddy : « reverse_proxy /api/* 127.0.0.1:8790 » dans le bloc chatmtx.f4mtx.com
set -e
cd "$(dirname "$0")"
sudo install -d -m 755 /opt/chatmtx-api
changed=0
for f in annuaire-server.js ../directory.js; do
  dst=/opt/chatmtx-api/$(basename "$f")
  if ! cmp -s "$f" "$dst"; then sudo install -m 644 "$f" "$dst"; changed=1; fi
done
if ! cmp -s chatmtx-api.service /etc/systemd/system/chatmtx-api.service; then
  sudo install -m 644 chatmtx-api.service /etc/systemd/system/chatmtx-api.service
  sudo systemctl daemon-reload
  changed=1
fi
sudo systemctl enable --quiet chatmtx-api
if [ $changed = 1 ] || ! systemctl is-active --quiet chatmtx-api; then sudo systemctl restart chatmtx-api; fi

CADDY=/etc/caddy/Caddyfile
if ! grep -q 'reverse_proxy /api/\* 127.0.0.1:8790' "$CADDY"; then
  BAK="$CADDY.bak-$(date +%Y%m%d-%H%M%S)"
  sudo cp "$CADDY" "$BAK"
  sudo sed -i '/^http:\/\/chatmtx\.f4mtx\.com {/a\	# Annuaires enregistres sur le serveur (server/annuaire-server.js)\n\treverse_proxy /api/* 127.0.0.1:8790' "$CADDY"
  sudo caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1 || { sudo cp "$BAK" "$CADDY"; echo "Caddyfile invalide : sauvegarde remise"; exit 1; }
  sudo systemctl reload caddy
  echo "Caddy : /api/* -> 127.0.0.1:8790"
fi
echo "Service des annuaires : $(systemctl is-active chatmtx-api)"
