# SonoChat

Application web PWA de communication texte par modulation sonore FT8 (8-GFSK).

## Architecture

- `ft8-modem.js` — Coeur du protocole FT8 : encodage/décodage, modulation GFSK, démodulation, LDPC, CRC-14
- `app.js` — Interface chat, gestion UI, spectre, historique localStorage
- `index.html` — Structure HTML de l'app
- `style.css` — Styles (thème sombre)
- `sw.js` — Service Worker pour PWA offline
- `manifest.json` — Manifest PWA

## Protocole FT8

- 8-GFSK, 8 tons, espacement 6.25 Hz, symbole 160 ms
- 79 symboles : S7 D29 S7 D29 S7 (Costas sync + data)
- Encodage : 77 bits payload → CRC-14 → LDPC(174,91) → Gray code → 58 symboles data
- Bande passante : 50 Hz, durée : 12.64 s
- Texte libre : jusqu'à 13 caractères, alphabet base-42

## Démodulation (RX)

La démodulation utilise une approche en 2 passes :
1. **Pass grossière** : recherche Costas sur grille (1 symbole temps, 3 Hz fréquence)
2. **Pass fine** : raffinement sub-symbole (nsps/8 temps, 0.5 Hz fréquence) + interpolation parabolique

Détails techniques :
- Fenêtre cosine-taper 5% (pas Hann) pour préserver l'orthogonalité entre tons GFSK
- LLR par max-log MAP (robuste contre l'étalement spectral GFSK)
- LDPC offset min-sum, 50 itérations, early termination
- Multi-candidats : teste les 6 meilleurs candidats Costas
- Le filtre GFSK (BT=2.0) introduit un délai de ~0.75 symbole — le Costas sync le compense

## Commandes de dev

```bash
# Serveur local
python3 -m http.server 8080

# Vérifier la syntaxe JS
node -c ft8-modem.js && node -c app.js
```

## Notes

- Pas de bundler ni de dépendances — JS vanilla, chargé directement par le navigateur
- `FT8` est un objet global de constantes, `FT8Modem` est la classe principale
- L'audio utilise ScriptProcessorNode (pas AudioWorklet) pour la compatibilité
- Le micro demande `echoCancellation: false, noiseSuppression: false, autoGainControl: false`
