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

## Indicatif, destinataire et annuaire

- Page de chat (barre au-dessus de la saisie) : formule radio **`FM 01 TO 02`** — mon indicatif
  (touché → paramètres), puis le **destinataire** (touché → sélecteur à gros boutons : `99 · TOUS`,
  stations connues — historique et annuaire —, saisie libre). Bouton MEDEVAC. Le **mode de
  transmission est dans les paramètres** (étendu par défaut).
- Chaque station règle un **indicatif court de 2 caractères** (`A-Z0-9`, `99` interdit),
  obligatoire pour émettre. Sur l'air, **en-tête de 4 car. sans séparateur** :
  émetteur + destinataire + texte : `PC` → `XY` : `PCXYBONJOUR` ; en l'air : `PC99BONJOUR`.
  Restent **9 car.** utiles en standard, **126** en multi-trame et en étendu. `app.js` ajoute
  l'en-tête (`sendText`) et le lit (`splitHeader` → `{call, to, body}`) ; SonoLink transporte le
  texte tel quel, empreinte comprise.
- Destinataire enregistré (`settings.dest`, réglages `v: 3`) ; aucun au premier lancement : le
  premier envoi ouvre le sélecteur.
- Bulles : `FM PC TO XY` ; « TO moi » ; `99` → « Message en l'air · pour tous » ; message pour une
  autre station → « pour XY · pas de réponse » (reçu et affiché, atténué, jamais de réponse).
- Trame 1 d'un multi-trame perdue (`…` en tête), ou en-tête invalide (bloc 0 d'un étendu perdu :
  la suite commence au milieu du texte) → émetteur et destinataire `?`, texte précédé de `…`.
- Les accusés portent l'indicatif court de la station qui accuse (11 bits) → « ✓✓ reçu par XY ».
- **Annuaire** (paramètres → Importer) : fichier texte/CSV, `court;long[;type[;échelon]]` par
  ligne (`;` `,` tabulation ou espaces, `#` commentaire, en-tête toléré, dernier doublon gagnant).
  Stocké dans `localStorage` (`sonochat-directory`, et `sonochat-directory-units` pour les types),
  un import valide le remplace.
- **Type d'unité OTAN** (`directory.js` : `UNIT_TYPES`, `ECHELONS`, `unitSidc`) : mot clé sans
  accents (infanterie, blinde, genie, sante, transmissions, commandement, pompiers, samu, police,
  secours…) ou SIDC APP-6 de 15 car. ; échelon (equipe → division) en position 12 du SIDC (pas sur
  les symboles de secours `E`). Type inconnu : ignoré, l'entrée est gardée. La carte dessine les
  unités (POSREP, position connue, moi) avec ce symbole ; bulle « Santé, Compagnie ».
- Traduction **à l'affichage seulement** (`data-call` sur chaque indicatif, `refreshCalls`) :
  l'historique garde le code court, un annuaire importé plus tard s'applique aussi aux anciens
  messages. Code inconnu → code court affiché.

## Accusés de réception (SonoLink, `arq.js`)

**Seul le destinataire accuse, et toujours** ; `99` = message en l'air, aucun accusé attendu ni
envoyé. Plus de case « Accusés ».
- Réception : `ackEnabled(text)` reçoit le texte (étendu/standard : message ; multi-trame :
  texte assemblé ; RPT : texte de la session) ; l'application accuse ⇔ destinataire = mon
  indicatif (`isForMe`) et écoute active. Une station non destinataire ne répond jamais.
- Émission : `link.send(text, mode, { ack, from })`, `ack = destinataire ≠ 99`, `from` =
  destinataire : un accusé (texte ou trame) d'une autre station est ignoré.
- Plusieurs stations peuvent écouter : seul le destinataire répond (testé à 3 stations).
- Bloc 0 d'un étendu perdu : la suite passe d'abord pour un message ; quand la répétition
  complète arrive, `_absorbFragments` retire le fragment (`onRx {id, superseded}` → l'appli
  supprime sa bulle et l'entrée d'historique).
- Multi-trame incomplet (trame perdue sans répétition : en l'air, ou message pour une autre
  station) : sans nouvelle trame pendant `RX_RPT_WINDOW`, la réception se termine « incomplet »
  au lieu de rester « en cours ».

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

## Messages formatés (`medevac.js`, `medevac-ui.js`)

Barre : **MSG** → tous les formats, rangés par type (santé, sécurité civile, contact et engins,
unité), destinataire en tête ; **MEDEVAC** → 9-line directement. Un écran par champ ou groupe,
gros boutons, passage automatique après un choix unique, récapitulatif décodé avant envoi,
taille sur l'air affichée en direct. **Règle : toujours le plus court possible sur l'air.**

| Marqueur | Format | Car. (+ en-tête 4) | Blocs | Alerte |
|---|---|---|---|---|
| `/9` | 9-line MEDEVAC (code dédié, version 1) | 22 | 2 | oui |
| `/M` · `/A` | MIST (11/blessé) · AT-MIST (13/blessé, si âge/sexe/hémorragie renseigné) | 3 + n×11 · n×13 | — | — |
| `/E` | METHANE | 22 | 2 | oui |
| `/R` | Renseignement « Je suis/vois/prévois/fais/demande » + texte ≤ 40 | 16 + texte | 2-3 | — |
| `/S` | SALUTE | 18 | 2 | — |
| `/K` | CONTACT | 15 | 2 | oui |
| `/U` | 9-line UXO/IED | 20 | 2 | oui |
| `/L` | LACE | 5 | 1 | — |
| `/P` | POSREP (100 m) | 9 | 1 | — |

- Formats génériques déclarés par leurs champs (`define`, `FORMATS`) : types `choice` (optional),
  `multi`, `count`, `number` (min/max/step, 0 = inconnu), `position` (précision 4 ou 3),
  `time`, `dtg`, `freq`, `grid` (états par ligne). `group` regroupe des champs sur un écran
  (`groupTitle`). Écrans générés (`genericSteps`), texte en clair par `lines()` du format.
  **Pas de champ version** : un format qui change prend une nouvelle lettre. Listes et ordre
  des champs = format sur l'air, à ne jamais réordonner.
- Alerte (`alertTitle`) dès l'en-tête pour 9-line, METHANE, CONTACT, UXO, destinataire seulement.

Format sur l'air (après l'en-tête de 4 car.) — **à ne jamais réordonner**, seulement étendre :
```
/9 + 20 car.                  9-line (lignes 1 à 9)            → 26 car. = 2 blocs étendus
/M + n + n × 11 car.          MIST, n blessés (1-11, 9 après un 9-line)
? au lieu du premier /        collationnement du message reçu
puis remarque libre facultative (≤ 128 car. au total)
```
- Chaque bloc de champs = un entier en base mixte (`NINE_RADIX`, `MIST_RADIX`), écrit en
  **base 41 = alphabet FT8 sans l'espace** (FT8 rogne les espaces en fin de bloc). Champ `version`
  en tête (9-line : 1, MIST : 0).
- 9-line resserré à 20 car. pour tenir en 2 blocs avec l'en-tête de 4 : **ligne 5 = couchés**
  seulement, assis = total ligne 3 − couchés ; **fréquence** au kHz jusqu'à 30 MHz, au pas de
  5 kHz au-delà (`roundFreq`) ; **lignes 6 et 9 + guerre/paix en un seul rang** (guerre :
  sécurité × NRBC ; paix : blessures × terrain, 6 choix chacun).
- Ligne 1 : 1e-4° (~10 m, comme un MGRS 8 chiffres), GPS du téléphone ou position de la station
  (paramètres, MGRS ou degrés). Ligne 2 : fréquence de contact (paramètres) + indicatif de
  l'émetteur. Lignes 6 et 9 : variante guerre (sécurité, NRBC) ou paix (blessures, terrain).
- Toujours en **étendu**, vers un **destinataire précis** (jamais `99`, choisi en tête de la
  saisie). Le destinataire accuse, puis **renvoie** le message avec `?`, adressé à l'émetteur
  (`onFormattedRx`, une fois par message en 15 min, 2 s après son accusé) ; l'émetteur compare
  (`checkReadback`) → « Collationné conforme par XY » ou les lignes qui diffèrent (`msg.readback`),
  et accuse le collationnement (« ✓✓ reçu par PC » chez le destinataire). Les stations non
  destinataires affichent le 9-line sans rien faire.
- **Alerte** (destinataire seulement) : dès qu'un message reçu **pour moi** commence par `/9`
  (premier bloc, avant la fin), alerte (`enterMedevacAlert`) : fond rouge (`body.alert-9line`),
  bandeau, vibration, mode **étendu** et destinataire = l'émetteur du 9-line (enregistrés).
  « Fin d'alerte » remet le mode et le destinataire d'avant. Survit au rechargement
  (`localStorage` `chatmtx-medevac-alert`).
- Message abîmé (bloc perdu) ou non décodable → affiché en texte simple.
- Plein écran (noir, écran maintenu allumé), Partager (plugin `@capacitor/share` dans l'appli,
  Web Share sinon, presse-papiers en dernier recours), QR code du texte en clair, Imprimer
  (`body.mv-printing` + `@media print` ; dans l'appli : passe par Partager).
- Appli Android : permissions de localisation dans `AndroidManifest.xml`.

## Carte tactique (`tacmap.js`, `tiles.js`)

Bouton carte (en-tête). Symboles **APP-6** (`milsymbol.js` 3.0.4, MIT) posés depuis
l'**historique** (rien de stocké en plus) : 9-line → ambulance (`EFOPAE`), METHANE et
renseignement → incident selon le type (`METHANE_SIDC`, `NATURE_SIDC`), SALUTE → hostile,
CONTACT → hostile/tireur/IED **projeté** (position + azimut + distance, trait depuis
l'observateur), UXO → UXO/IED/mine, POSREP → unité amie à sa dernière position (+ **trajet**),
LACE → état sur l'unité, moi → GPS. Codes SIDC choisis sur planche et validés (`isValid`,
tests). **Vieillissement** : 100 % < 1 h, 60 % < 6 h, 30 % au-delà. **Carroyage MGRS** 100 km /
10 km / 1 km selon le zoom (`gridLines`, `toUtm`/`fromUtm` de `medevac.js`), identifiant **dans
chaque carré** en permanence (`gridCells` : « 31U DQ », « DQ 5 1 », « DQ 52 11 » ; carrés de la zone
UTM voisine non étiquetés). En haut à droite : **coordonnée complète** du centre (petite mire),
MGRS au mètre (`toMgrs(lat, lon, 5)`) + degrés, mise à jour en direct.

**Pointer une position** (`TacMap.pickPosition`) : bouton **CARTE** dans chaque écran de position
des messages (`positionWidget` de `medevac-ui.js`) et pour la position de la station
(paramètres). Mire fixe au centre du cadre de la carte (`.tm-mapwrap`), carte déplacée dessous ou
toucher pour centrer, MGRS en direct, symboles existants en repère, « Valider ce point ».

Fond : **Plan IGN** (Géoplateforme WMTS PM, CORS ouvert, licence Etalab, « © IGN ») dans
**IndexedDB** (`chatmtx-tiles`, clé `z/x/y`), PNG recompressées en **WebP** (~20 Ko/tuile).
« Hors ligne » sur la carte : rayon 20 km, zooms 8-15 (~3 500 tuiles, ~77 Mo estimés à 48° N), 4 requêtes
parallèles, 3 essais par tuile (l'IGN refuse parfois les rafales en HTTP 400), reprise.
Sans tuile : **fond monde embarqué** `world.json` (dans l'APK et précaché par le SW ; Natural
Earth, domaine public ; 1,2 Mo, 393 Ko gzip) : 242 pays (contours 1:50m, noms français),
361 lacs, 255 fleuves, 101 départements français (1:10m), 1 188 villes (grandes villes du monde,
villes françaises ≥ 10 000 hab.). Format compact (lon/lat arrondis, Douglas-Peucker), dessiné en
**canvas** dans le pane `world` (z-index 150, **sous** les tuiles IGN) par `worldLayer` ; noms de
pays (zoom ≤ 7) et de villes selon leur rang et le zoom, 80 au plus. Régénération : script Python
dans l'historique du commit « Fond monde embarqué ». Emplacements de tuiles vides masqués
(`visibility: hidden`, sinon cadre gris). Grille MGRS à partir du zoom 6 seulement. Leaflet 1.9.4 vendorisé (`leaflet.js`, `leaflet.css`).

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

# Carte tactique : SIDC valides, message → symbole, projection CONTACT, carroyage, tuiles
node tests/tacmap.js

# Séquencement PTT (avance/maintien, annulation) et adaptateur natif
node tests/ptt-timing.js

# Bout en bout : 2 FT8Modem réels + SonoLink, air simulé (GFSK + bruit), 12 kHz — ~2,5 min
node tests/link-audio.js        # SNR -10 dB (argument : autre SNR)

# 3 stations ChatMTX complètes (Chromium headless), air simulé avec pertes, temps ×10 — ~6 min
# 23 scénarios : adressage, en l'air, répétitions, RPT, 9-line/MIST, collationnement, alerte
# Prérequis hors dépôt : npm i -g playwright-core && npx playwright install chromium
node tests/stations.js        # ONLY=12,24 : seulement ces scénarios
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
