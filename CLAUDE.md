# ChatMTX — Messagerie Texte Xtrême

(ex-SonoChat ; dépôt `sono-chat`, identifiant Android `com.f4mtx.sonochat` et clés
`localStorage` `sonochat-*` volontairement inchangés : les changer casserait les mises à jour
et effacerait historique, réglages et annuaire.)

Application web PWA de communication texte par modulation sonore FT8 (8-GFSK).

## Architecture

- `ft8-modem.js` — Couche radio FT8 : encodage/décodage, modulation GFSK, démodulation, LDPC, CRC-14.
  Aucune logique de dialogue : émet des listes de symboles, signale chaque trame décodée (`onFrame`)
- `arq.js` — `SonoLink` : accusés de réception et répétitions (voir plus bas). Sans DOM ni audio
  (émission, horloge, minuteurs injectés), testable en Node
- `medevac.js` — Messages formatés 9-line MEDEVAC et MIST : codage compact, MGRS, texte en clair.
  Sans DOM, testable en Node
- `medevac-ui.js` — Saisie à gros boutons, carte dans le fil, plein écran, partage, QR code, impression
- `qrcode.js` — Générateur de QR code (Kazuhiko Arase, licence MIT, non modifié)
- `directory.js` — Annuaire : `parseDirectory` (import CSV/texte), `lookupCall` (court → long)
- `native-serial.js` — Application Android : `NativePttPort`, même interface que le `SerialPort`
  de Web Serial, au-dessus du plugin natif `UsbSerial`
- `app.js` — Interface chat : relie modem ↔ SonoLink, bulles, indicatifs, spectre, historique localStorage
- `web-files.txt` — Liste unique des fichiers servis (lue par `deploy.sh` et par le bundle de l'appli)
- `mobile/` — Application Android (Capacitor 8), voir plus bas
- `index.html` — Structure HTML de l'app
- `style.css` — Styles (thème sombre)
- `sw.js` — Service Worker pour PWA offline
- `manifest.json` — Manifest PWA

## Protocole FT8

- 8-GFSK, 8 tons, espacement 6.25 Hz, symbole 160 ms
- 79 symboles : S7 D29 S7 D29 S7 (Costas sync + data)
- Encodage : 77 bits payload → CRC-14 → LDPC(174,91) → Gray code → 58 symboles data
- Bande passante : 50 Hz, durée : 12.64 s
- Texte libre : jusqu'à 13 caractères, alphabet base-42 (i3=0, n3=0)
- Télémétrie (i3=0, n3=5) : 71 bits libres, conteneur des trames du protocole SonoLink

## Indicatif et annuaire

- Page de chat (barre au-dessus de la saisie) : son indicatif (touché → paramètres), le mode
  de transmission et la case « Accusés ». Les autres réglages restent dans les paramètres.
- Chaque station règle un **indicatif court de 2 caractères** (`A-Z0-9`), obligatoire pour
  émettre. Sur l'air, il est **en tête de chaque message, sans séparateur** :
  `PC` + `BONJOUR` → `PCBONJOUR`, dans les 3 modes. Il reste donc 11 car. utiles en standard,
  128 en multi-trame et en étendu. `app.js` ajoute le préfixe (`sendMessage`) et le retire
  (`splitCallsign`) ; SonoLink transporte le texte tel quel, empreinte comprise.
- Trame 1 d'un multi-trame perdue (`…` en tête) → indicatif affiché `?`.
- Les accusés portent l'indicatif court de la station qui accuse (11 bits) → « ✓✓ reçu par XY ».
- **Annuaire** (paramètres → Importer) : fichier texte/CSV, `court;long` par ligne (`;` `,`
  tabulation ou espaces, `#` commentaire, en-tête toléré, dernier doublon gagnant). Il est
  stocké dans `localStorage` (`sonochat-directory`), et un import valide le remplace.
- Traduction **à l'affichage seulement** (`data-call` sur chaque indicatif, `refreshCalls`) :
  l'historique garde le code court, un annuaire importé plus tard s'applique aussi aux anciens
  messages. Code inconnu → code court affiché.

## Accusés de réception (SonoLink, `arq.js`)

Case « Accusés » sur la page de chat (**décochée par défaut** ; décochée = diffusion sans accusé,
pour plusieurs récepteurs). Les deux stations doivent la cocher : un récepteur n'accuse que si
sa propre case est cochée. Réglages enregistrés en `v: 2` : ceux de la v1 (sans `v`) repassent
les accusés à décoché. Un seul correspondant à la fois : plusieurs récepteurs accuseraient en même temps.

| Mode | Trames | Accusé | Répétition (3 max) |
|---|---|---|---|
| Standard | texte libre 13 car. | `ACK texte` (CRC-16 du texte) | si pas d'accusé en 24 s |
| Multi-trame | DATA télémétrie, 10 car./trame, ≤ 16 | `ACK trame` après chaque trame (arrêt-et-attente) ; la dernière porte `final` + CRC-16 du message | la trame seule, sur délai ou `RPT` |
| Étendu | texte libre multi-blocs | `ACK texte` du message complet | tout le message si empreinte fausse ou absente (48 s) |

Format des trames (71 bits, MSB d'abord) :
```
DATA      : type=0 (2) | msgId (5) | seq (4) | total-1 (4) | ackReq (1) | 10 car. base-42 (54)
ACK trame : type=1 (2) | 0 (1) | msgId (5) | seq (4) | final (1) | CRC-16 message (16) | indicatif (11)
ACK texte : type=1 (2) | 1 (1) | CRC-16 texte (16) | indicatif (11)
RPT       : type=2 (2) | msgId (5) | seq (4)
```
- Empreinte : CRC-16/CCITT-FALSE du texte normalisé (majuscules, hors alphabet → espace, fin rognée)
- Le récepteur n'accuse **que quand le signal s'arrête** (`frame.continues === false`) : le
  1er bloc d'un étendu se décode seul avant le 2e, y répondre couvrirait l'émetteur. Secours :
  accusé après 26 s sans nouveau bloc (`RX_STABLE`, > 2 blocs pour un bloc perdu au milieu).
- `RPT` : en session multi-trame, synchro Costas forte sans décodage (`onUndecoded`) → demande
  de répétition, une fois par trame attendue.
- Répétition reçue (accusé perdu) : reconnue (msgId/seq, ou même texte < 180 s), pas de
  doublon affiché, réaccusée. Un étendu reçu avec des trous est complété par sa répétition.

## Messages formatés : 9-line MEDEVAC et MIST (`medevac.js`, `medevac-ui.js`)

Bouton **MEDEVAC** (barre au-dessus de la saisie) → 9-line ou MIST seul, un écran par ligne,
gros boutons, passage automatique après un choix unique, récapitulatif décodé avant envoi.

Format sur l'air (après l'indicatif) — **à ne jamais réordonner**, seulement étendre :
```
/9 + 22 car.                  9-line (lignes 1 à 9)            → 26 car. = 2 blocs étendus
/M + n + n × 11 car.          MIST, n blessés (1-11, 9 après un 9-line)
? au lieu du premier /        relecture (collationnement) du message reçu
puis remarque libre facultative (≤ 128 car. au total)
```
- Chaque bloc de champs = un entier en base mixte (`NINE_RADIX`, `MIST_RADIX`), écrit en
  **base 41 = alphabet FT8 sans l'espace** (FT8 rogne les espaces en fin de bloc). Champ `version`
  (0) en tête pour faire évoluer le format.
- Ligne 1 : 1e-4° (~10 m, comme un MGRS 8 chiffres), GPS du téléphone ou position de la station
  (paramètres, MGRS ou degrés). Ligne 2 : fréquence de contact (paramètres) + indicatif de
  l'émetteur. Lignes 6 et 9 : variante guerre (sécurité, NRBC) ou paix (blessures, terrain).
- Toujours en **étendu, accusé forcé** : `ackEnabled(text)` (arq.js passe le texte reçu) accuse
  un message `/9` ou `/M` même case « Accusés » décochée. Puis le récepteur **renvoie** le message
  avec `?` (`onFormattedRx`, une fois par message en 15 min, 2 s après son accusé) ; l'émetteur
  compare (`checkReadback`) → « Relu conforme par XY » ou les lignes qui diffèrent (`msg.readback`).
- **Alerte** : dès qu'un message reçu commence par `/9` (premier bloc, avant la fin), la station
  passe en alerte (`enterMedevacAlert`) : fond rouge (`body.alert-9line`), bandeau, vibration,
  mode **étendu** et case **Accusés** cochée (enregistrés). « Fin d'alerte » remet le mode et les
  accusés d'avant. Survit au rechargement (`localStorage` `chatmtx-medevac-alert`).
- Message abîmé (bloc perdu) ou non décodable → affiché en texte simple.
- Plein écran (noir, écran maintenu allumé), Partager (plugin `@capacitor/share` dans l'appli,
  Web Share sinon, presse-papiers en dernier recours), QR code du texte en clair, Imprimer
  (`body.mv-printing` + `@media print` ; dans l'appli : passe par Partager).
- Appli Android : permissions de localisation dans `AndroidManifest.xml`.

## Démodulation (RX)

Passe de décodage toutes les 2 s sur tout le ring buffer (~130 s) :
1. **Puissances Goertzel** sur une grille d'un symbole, 14 bins (±3 bins autour des 8 tons)
2. **Recherche Costas grossière**, puis sélection de **6 candidats de créneaux distincts**
   (espacement ≥ 20 symboles : < 36, car un étendu a un Costas tous les 36 symboles et une
   fenêtre décalée d'un demi-bloc synchronise aussi bien que la vraie)
3. **Raffinement fin séparable** : fréquence au temps grossier, puis temps à la meilleure
   fréquence (18 évaluations au lieu de 81), + interpolation parabolique
4. LDPC → CRC-14 → texte libre ou télémétrie ; tentative d'étendu (blocs avant **et** arrière)

Dédoublonnage **par position absolue** (`_absWritten`, `_decodedSpans`) : un candidat dont le
centre tombe dans une trame déjà décodée est exclu **avant** la sélection. Une vieille trame
n'est jamais réémise ni ne bloque une nouvelle, et une trame répétée à l'identique (ARQ) est
une nouvelle position, donc décodée.

Autres points :
- Micro coupé (zéros) pendant notre émission + 300 ms (`TX_MUTE_TAIL_MS`) : jamais d'auto-décodage
- Mot de code tout à zéro rejeté : valide pour LDPC et CRC-14, c'est ce que donne le silence
- Continuation (`_signalContinues`) : contraste de tons sur 4 symboles après la trame, comparé
  au bruit (3,9 mesuré) et à la trame ; une trame texte dont la traîne n'est pas encore captée
  est remise à la passe suivante
- Trame perdue (`onUndecoded`) signalée seulement si le signal s'est arrêté après elle (sinon
  c'est une fenêtre décalée sur une trame en cours de réception)
- Fenêtre cosine-taper 5% (pas Hann) pour préserver l'orthogonalité entre tons GFSK
- LLR par max-log MAP ; LDPC offset min-sum, 50 itérations, early termination
- Le filtre GFSK (BT=2.0) introduit un délai de ~0.75 symbole — le Costas sync le compense

## Commandes de dev

```bash
# Serveur local
python3 -m http.server 8080

# Vérifier la syntaxe JS
node -c ft8-modem.js && node -c arq.js && node -c directory.js && node -c app.js

# Test loopback hors navigateur (encodage → GFSK → bruit AWGN → décodage)
# Taux de décodage par SNR (réf. 2500 Hz), 48 et 44,1 kHz — ~2 min
node tests/loopback.js all 5
node tests/loopback.js quick 3   # standard seul, rapide

# Protocole SonoLink : 2 stations, canal simulé, horloge virtuelle, pertes forcées — ~1 s
node tests/arq.js

# Import d'annuaire
node tests/directory.js

# Messages formatés 9-line / MIST : codage, MGRS (référence publiée), texte en clair
node tests/medevac.js

# Séquencement PTT (avance/maintien, annulation) et adaptateur natif
node tests/ptt-timing.js

# Bout en bout : 2 FT8Modem réels + SonoLink, air simulé (GFSK + bruit), 12 kHz — ~2,5 min
node tests/link-audio.js        # SNR -10 dB (argument : autre SNR)
```


## Déploiement — https://chatmtx.f4mtx.com

```bash
./deploy.sh   # vérifie la syntaxe, copie vers /srv/chatmtx (+ legacy/ vers /srv/sonochat) (sudo)
```

- Chaîne : Cloudflare Tunnel (`*.f4mtx.com` → localhost:80) → Caddy (`/etc/caddy/Caddyfile`,
  bloc `http://chatmtx.f4mtx.com`, `file_server` sur `/srv/chatmtx`). Pas de container.
- **Ancienne adresse** `sonochat.f4mtx.com` (bloc Caddy dédié) : `/` et `/index.html` servent
  `legacy/index.html`, qui passe historique/réglages/annuaire dans `#migrate=` (base64) vers
  chatmtx (`importMigration` dans `app.js`, n'écrase jamais) ; `/sw.js` sert `legacy/sw.js`, qui
  remplace l'ancien SW, se désinstalle et recharge les pages ; `/apk-version.json` et
  `/sonochat.apk` servent ceux de `/srv/chatmtx` (applications 1.1.x) ; le reste redirige (301).
- `deploy.sh` remplace `CACHE_NAME` de `sw.js` par une empreinte des fichiers servis :
  pas de bump manuel. Tout nouveau fichier servi doit être ajouté à `FILES` (deploy.sh)
  **et** à `ASSETS` (sw.js), sinon il manquera hors ligne.
- Hors ligne : le SW précache tout à l'installation (`cache: 'reload'`), sert l'app shell
  pour toute navigation (même avec `?query`), **sauf** `.apk` et `.json` (hors manifest) : sinon
  le lien de mise à jour ouvert dans Chrome affichait SonoChat au lieu de télécharger l'APK. À la mise à jour, la page se recharge d'elle-même
  sauf en émission/écoute.
- Cloudflare réécrit `Cache-Control` en `max-age=14400` sur .js/.png (réglage de zone
  « Browser Cache TTL ») ; sans effet sur les mises à jour, le SW contournant le cache HTTP.

## Application Android (`mobile/`)

Pourquoi : dans Chrome Android, Web Serial ne fonctionne qu'en Bluetooth, et le série USB filaire
n'y est pas encore pris en charge. Le navigateur ne peut donc pas actionner RTS/DTR d'une
interface USB-série (Digirig Mobile, poste à USB réglé « PTT par RTS »). L'application le fait
par un plugin natif.

```bash
cd mobile && npm install           # une fois
scripts/build-apk.sh               # www/ <- web-files.txt, cap sync, assembleRelease -> ../dist/chatmtx.apk
cd .. && ./deploy.sh               # publie aussi dist/chatmtx.apk -> https://chatmtx.f4mtx.com/chatmtx.apk
```

- **Avant chaque publication**, incrémenter `version` dans `mobile/package.json` (le
  `versionCode` en dérive : 1.2.3 → 10203). Sinon Android refuse la mise à jour.
- **Mise à jour obligatoire** (depuis 1.1.0) : `bundle-web.mjs` embarque `app-version.json`,
  `build-apk.sh` écrit `dist/apk-version.json`, `deploy.sh` le publie. Au lancement et au retour
  au premier plan (au plus 1×/h), l'appli compare les deux (`checkApkUpdate`) : plus récente en
  ligne → écran bloquant « Télécharger la mise à jour » (reporté de 30 s si émission en cours).
  Hors ligne : rien. CORS ouvert sur `/apk-version.json` dans le Caddyfile (origine `https://localhost`).
  Le site seul (`deploy.sh` sans nouvel APK) ne déclenche rien.
- **Plugin** `mobile/android/app/src/main/java/com/f4mtx/sonochat/UsbSerialPlugin.java`
  (bibliothèque `usb-serial-for-android`, JitPack) : `list`, `open({deviceId, rts, dtr})` (niveaux
  **de repos**, PTT relâché), `setSignals({rts, dtr})`, `close`, événements `detached` et `watchdog`.
  Lignes remises au repos au débranchement, à la destruction de l'activité, et si le PTT reste fermé
  plus de 130 s (minuteur de sécurité : jamais de poste bloqué en émission).
- Le JS ne change pas de chemin : `NativePttPort.setSignals({requestToSend, dataTerminalReady})`
  est appelé par `FT8Modem._pttOn/_pttOff` comme un port Web Serial. En natif, pas de service
  worker (fichiers dans l'APK) et l'aide micro renvoie aux autorisations Android.
- Branchement d'une interface CP210x / FTDI / CH34x / PL2303 : Android propose d'ouvrir ChatMTX
  (`res/xml/usb_device_filter.xml`).
- **Signature** : clé `~/.android-keys/sonochat-release.jks`, mots de passe dans
  `mobile/android/keystore.properties` (gitignoré ; copie dans `~/.android-keys/`).
  **Sauvegarde sur le NAS** : `/mnt/nas/nucbox-backup/android-keys/`. Perdre la clé = plus aucune
  mise à jour possible par-dessus l'application installée (il faudrait la désinstaller).
- Délais PTT (paramètres, web et appli) : `pttLeadMs` (100 ms, PTT fermé avant le son) et
  `pttTailMs` (150 ms, gardé après), appliqués seulement avec un port série ou la tonalité VOX.
  L'annulation relâche immédiatement.
- **PTT par tonalité (VOX)** (case dans les paramètres, `voxTone`) : pour un câble VOX sur la prise
  casque (Digirig VOX PTT, brochage CTIA). Pendant toute l'émission (avance, trames, intervalles,
  maintien), un oscillateur `VOX_TONE_HZ` (2000 Hz) joue sur le canal **droit** et le FT8 passe sur
  le **gauche** seul (`ChannelMerger`). Sortie mono (`maxChannelCount < 2`) : pas de tonalité, sinon
  elle se mélangerait au FT8. Cumulable avec un port série. Sans appli native : marche aussi dans
  Chrome Android et sur iOS.
- iOS : pas d'accès au série USB pour une application ordinaire ; non prévu.
- Test sur émulateur : AVD `sonochat-test` (Android 36, `-gpu swiftshader_indirect` pour ne pas
  solliciter le GPU i915), `adb install -r dist/chatmtx.apk`.

## Notes

- Pas de bundler ni de dépendances — JS vanilla, chargé directement par le navigateur
- `FT8` est un objet global de constantes, `FT8Modem` est la classe principale
- L'audio utilise ScriptProcessorNode (pas AudioWorklet) pour la compatibilité
- Le micro demande `echoCancellation: false, noiseSuppression: false, autoGainControl: false`
