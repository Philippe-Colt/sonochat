#!/bin/bash
# Station de test HF ChatMTX : le vrai ChatMTX dans une fenêtre, relié à l'IC-7300 par le
# pupitre telec-icom (qui garde l'exclusivité du poste et ses garde-fous d'émission).
#   station/install.sh      dépendances, compte station du pupitre, service utilisateur
#   systemctl --user start|stop|status chatmtx-station     journalctl --user -u chatmtx-station -f
# Le pupitre se démarre à part : ~/projects/telec-icom/run.sh
set -e
cd "$(dirname "$0")"
npm install --silent --no-audit --no-fund
[ -f ~/.config/chatmtx-station/compte.json ] || ~/projects/telec-icom/venv/bin/python compte.py
mkdir -p ~/.config/systemd/user
cp chatmtx-station.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable chatmtx-station.service
echo "Station installée : systemctl --user start chatmtx-station (démarre aussi avec la session)"
