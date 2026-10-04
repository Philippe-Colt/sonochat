#!/usr/bin/env python3
"""Crée (ou remet à jour) le compte « station ChatMTX » du pupitre telec-icom.

Compte machine : adresse vérifiée, approuvé, droit d'émettre, sans second facteur,
mot de passe aléatoire rangé dans ~/.config/chatmtx-station/compte.json (0600).
À lancer avec l'environnement du pupitre :
    ~/projects/telec-icom/venv/bin/python station/compte.py
"""
import asyncio
import json
import os
import secrets
import sys
from pathlib import Path

TELEC = Path(os.environ.get("TELEC_ICOM", Path.home() / "projects" / "telec-icom"))
sys.path.insert(0, str(TELEC))
os.chdir(TELEC)  # la base est relative au projet (data/pupitre.db)
from store import Store, hash_password  # noqa: E402

EMAIL = os.environ.get("STATION_EMAIL", "station-chatmtx@f4mtx.com")
DEST = Path.home() / ".config" / "chatmtx-station" / "compte.json"


async def main():
    store = await Store().open()
    password = secrets.token_urlsafe(24)
    user = await store.user_by_email(EMAIL)
    if user is None:
        uid = await store.create_user(EMAIL, password)
        print("compte créé :", EMAIL)
    else:
        uid = user["id"]
        print("compte existant remis à jour :", EMAIL)
    await store.set_fields(uid, email_verified=1, approved=1, may_transmit=1,
                           totp_enabled=0, password_hash=hash_password(password))
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps({"email": EMAIL, "password": password}))
    DEST.chmod(0o600)
    print("identifiants :", DEST)
    await store.db.close()


asyncio.run(main())
