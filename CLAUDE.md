# ChatMTX — Messagerie Texte Xtrême

(ex-SonoChat ; dépôt `sono-chat`, identifiant Android `com.f4mtx.sonochat` et clés
`localStorage` `sonochat-*` volontairement inchangés : les changer casserait les mises à jour
et effacerait historique, réglages et annuaire.)

Application web PWA de communication texte par modulation sonore FT8 (8-GFSK).

## Architecture

- `ft8-modem.js` — Couche radio FT8 : encodage/décodage, modulation GFSK, démodulation, LDPC, CRC-14.
  Aucune logique de dialogue : émet des listes de symboles, signale chaque trame décodée (`onFrame`)
- `ft8-modem-single.js` — **Mode fréquence unique** : le modem d'avant le décodage large bande
  (commit `eeb6e19`) à l'identique, renommé `FT8_SINGLE` / `FT8ModemSingle` pour cohabiter
- `arq.js` — `SonoLink` : accusés de réception et répétitions (voir plus bas). Sans DOM ni audio
  (émission, horloge, minuteurs injectés), testable en Node
- `medevac.js` — Messages formatés 9-line MEDEVAC et MIST : codage compact, MGRS, texte en clair.
  Sans DOM, testable en Node
- `medevac-ui.js` — Saisie à gros boutons, carte dans le fil, plein écran, partage, QR code, impression
- `qrcode.js` — Générateur de QR code (Kazuhiko Arase, licence MIT, non modifié)
- `directory.js` — Annuaire : `parseDirectory` (import CSV/texte), `lookupCall` (court → long),
  création (`channelPlan`, `allocate`, `serializeDirectory`, `directoryLink`/`directoryFromLink`)
- `directory-ui.js` — Outil de création d'annuaire (gros boutons, attribution, QR code, scan, serveur)
- `server/annuaire-server.js` — Service des annuaires sur le serveur (Node sans dépendance, systemd)
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
- **Canal et créneau** (colonnes 5 et 6, `court;long;type;échelon;canal;créneau`, colonne
  vide ou `-` = non renseignée) : canal = fréquence audio d'émission en Hz (ton 0, 200-3 000),
  créneau = rang 1-98 des émissions automatiques. En-tête facultatif
  `#reseau;creneau=15;tour=12;pas=60;bande=500-2500;version=3;date=2026-10-03` (`parseNetHeader` ;
  créneau 13-600 s, défaut 15 ; tour = nombre de créneaux, défaut = plus grand créneau, agrandi
  s'il est trop petit). Contrôles à l'import (`warnings`, affichés) : canaux à moins de 50 Hz,
  créneau en double, valeurs refusées. Stocké dans `chatmtx-directory-net` `{channels, net}`.
  - **Ma ligne** (mon indicatif) : son canal **remplace la fréquence manuelle** (`txFreq`,
    champ verrouillé, réglage manuel gardé) ; messages, accusés et balises partent sur mon canal.
    Toutes les stations reçoivent tous les canaux (décodeur large bande).
  - **Balise dans mon créneau** (`mySlot`, `nextSlotStart`, horloge UTC du téléphone : le
    créneau k commence à `(k-1)·créneau` s dans chaque tour depuis l'origine Unix) : due → elle
    attend le début de mon créneau (1,5 s de tolérance) et ne part que si `link.canTransmitNow()`
    (sinon tour suivant) ; au plus une balise par tour. Les messages manuels ne sont pas
    soumis aux créneaux.
  - **Réseau limité à 12 stations et 12 canaux** (`MAX_STATIONS`) : plan `channelPlan` =
    **1 000 → 2 100 Hz au pas de 100 Hz** (en-tête `pas=` pour un autre pas ; sous 1 000 Hz
    si la bande ne suffit pas). Le modem reçoit ces canaux (`setChannels`, appli :
    `networkFreqs`) et y cherche à seuil bas. Décodage plat 500-2 500 Hz (`tests/passband.js`) ;
    sous ~1 350 Hz l'harmonique 2 d'un étage audio saturé tombe dans la bande (-38 dBc), sans
    effet sauf station locale très forte. Plus de 12 stations : refusé par l'outil, signalé à l'import.
- **Outil de création** (paramètres → Annuaire → **Créer / modifier**, `DirectoryUI`) : liste des
  stations à gros boutons (bordure rouge = à vérifier), fiche par station (indicatifs, type et
  échelon en listes, canal ± au pas du plan ou « auto », créneau ± ou « auto » ; doublon et `99`
  refusés), **ATTRIBUER** (`allocate` : choix valides gardés, conflits et manques complétés dans
  l'ordre de `channelPlan` — 1 000 → 2 100 Hz, 12 canaux —, créneaux libres les
  plus bas, tour = plus grand créneau), durée du créneau 13-60 s, contrôles en direct.
  **ENREGISTRER** applique ici (`applyDirectoryText`, comme un import) ; toute modification prend
  une **nouvelle version** (+1) datée du jour, portée par l'en-tête. Diffusion : **QR CODE**
  (lien `https://chatmtx.f4mtx.com/#annuaire=reseau;…~PC;F4MTX;…` : lignes séparées par `~`, `#`
  de l'en-tête retiré, aucun caractère à encoder ; ~150 car. pour 3 stations, ~450 pour 12),
  **PARTAGER** (texte : partage natif, Web Share, presse-papiers), **FICHIER** (.csv, web
  seulement). Réception : **SCANNER** (`BarcodeDetector` + caméra arrière, si le navigateur le
  permet ; permission CAMERA facultative dans l'APK), **COLLER** (lien ou fichier), ou appareil
  photo du téléphone → le lien ouvre ChatMTX dans le navigateur (`importDirectoryLink` : confirmation
  avec version et nombre de stations, adresse nettoyée).
- **Annuaire de test** (`TEST_DIRECTORY`, réseau `TEST`) : 12 stations `01` ALPHA → `12` LIMA
  (commandement, infanterie ×2, reco, génie, santé, logistique, transmissions, pompiers, SAMU,
  police, secours), canaux **1 000 → 2 100 Hz**, créneaux 1-12, version 2. **Appliqué au premier
  lancement** (clé `sonochat-directory` absente) et à la place de l'ancienne version 1 (canaux
  1 400 → 2 060 Hz, reconnue par nom `TEST`, version 1, date 2026-10-03) ; un annuaire effacé est
  enregistré vide et le reste.
  Bouton **TEST** dans l'outil pour y revenir. En-tête : clé `nom=` (nom du réseau, `net.name`).
- **Serveur** (outil → section Serveur ; `server/annuaire-server.js`, service `chatmtx-api`,
  `/opt/chatmtx-api`, données `/var/lib/chatmtx/annuaires`, Caddy `reverse_proxy /api/*
  127.0.0.1:8790`) : annuaire rangé sous un **nom de réseau** (3-20 car. `A-Z0-9_-`) et protégé
  par un **code** (≥ 6 car.). Le premier envoi réserve le nom ; ensuite le code est exigé pour
  charger comme pour remplacer (code faux et réseau inconnu : même 403). Code stocké en
  empreinte scrypt salée, 20 versions précédentes gardées (`historique/`), fichier validé par
  `parseDirectory`, 32 Ko max, 30 requêtes / 10 min et 10 codes faux / h par adresse
  (`CF-Connecting-IP`), CORS ouvert (appli : `apiBase` = `https://chatmtx.f4mtx.com/`).
  **ENVOYER** met le nom du réseau dans l'en-tête (nouvelle version), enregistre sur le serveur
  et applique ici ; **CHARGER** applique celui du serveur. Nom et code mémorisés
  (`chatmtx-directory-server`). `deploy.sh` appelle `server/install.sh` (copie si changé,
  unité systemd durcie `DynamicUser`, ajout de la route Caddy avec sauvegarde du Caddyfile).
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
POS       : type=3 (2) | indicatif (11) | lat×1e5 (25) | lon×1e5 (26) | 0 (7)  → balise, en l'air
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
- **État réel de l'accusé** sur le message reçu (`_sendAck` → `onRx {id, ack}`) :
  `pending` « accuse en attente (canal occupe) » (autre émission ou trame qui arrive),
  `sending` « emission de l'accuse... » (clignote, au départ réel : `opts.onStart` de
  `_transmit`, après `_waitClear`), `sent` « accuse envoye » (fin de l'émission), `failed`.
- Répétition reçue (accusé perdu) : reconnue (msgId/seq, ou même texte < 180 s), pas de
  doublon affiché, réaccusée. Un étendu reçu avec des trous est complété par sa répétition.
- **Jamais d'émission pendant une réception** : toute émission (message, répétition, accusé,
  RPT, balise) passe par `_transmit` → `_waitClear`, qui attend que `modem.channelBusy()` soit
  faux (`CLEAR_MAX` 150 s) : on décode tout ce qui arrive avant de répondre, quelle que soit la
  fréquence. Un envoi attend en plus la fin des réceptions en cours (`_waitRxQuiet`). L'état
  `channel` s'affiche sur la bulle (« reception en cours, emission differee »).
- Attente d'accusé prolongée tant qu'une trame arrive (`_waitFor`, `ACK_WAIT_MAX`), puis
  `CLEAR_GRACE` (6 s) de canal libre : l'accusé, retenu par une 3e station, part à sa fin.
- Assemblage des étendus par fréquence (`frame.freq`, `SAME_FREQ_HZ` 10 Hz) : deux stations
  simultanées ne sont jamais mélangées.

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
  saisie). Le destinataire accuse. **Collationnement seulement pour 9-line MEDEVAC, MIST, AT-MIST
  et METHANE** (`needsReadback`, `READBACK_MARKERS` `9MAE`) ; les autres formats (renseignement,
  SALUTE, CONTACT, UXO, LACE, POSREP) n'ont que l'accusé. Pour les premiers, le destinataire
  **renvoie** le message avec `?`, adressé à l'émetteur
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

## Balise de position automatique

Paramètres : case « Balise de position automatique », **toutes les N min** et/ou **après D m**
parcourus (l'un ou l'autre déclenche), jamais plus d'une fois par minute (`BEACON_MIN_GAP_MS`),
jamais pendant un envoi ni par-dessus une réception (`SonoLink.beacon` attend `_waitRxQuiet`).
Trame **POS** de télémétrie : **une seule trame FT8, position au mètre**, en l'air, sans accusé
(plus court qu'un POSREP texte, qui ne fait que 100 m). GPS par `watchPosition` (appli au premier
plan). Reçue : `onBeacon` → `positions` (`localStorage` `chatmtx-positions`, 100 points par
station), **pas dans le fil** ; la carte place l'unité à sa dernière position (« balise HH:MM »)
et prolonge son trajet (`collect(..., positions)`). Les versions sans type 3 l'ignorent.

**Barre « Balise » de l'écran principal** (`#auto-bar`, `renderAutoBar`, chaque seconde, sous la
barre des canaux) : « Balise dans 2:35 (21:04:30) · creneau 3/12 ou apres 500 m »
(`nextBeaconAt` : dernière balise + intervalle, écart minimal, puis début de mon créneau),
« emission en cours... », « emise a … », ou la raison du blocage (`beaconBlock` : pas
d'indicatif, en attente du GPS, envoi en cours ; « creneau precedent manque : canal occupe »
quand le canal n'était pas libre au début du créneau → tour suivant). À droite : **dernière
balise reçue** (« Balise recue : F4MTX a 21:03:12 »), puisqu'une balise n'apparaît pas dans le fil.

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
**404 « No data found »** (trous de l'IGN, ex. 2 tuiles sur 3 425 autour de Paris) : gardée comme
tuile vide (`'empty'`), comptée faite, jamais redemandée. Bouton **« Carte HL »** : affiche d'abord
l'**état de la zone** (`zoneStatus` : clés IndexedDB) — « ✓ Zone prête hors ligne » ou « incomplète,
N manquantes » + **Compléter** — puis « Télécharger ici » ; hors réseau, état seul.
Sans tuile : **fond monde embarqué** `world.json` (dans l'APK et précaché par le SW ; Natural
Earth, domaine public ; 1,2 Mo, 393 Ko gzip) : 242 pays (contours 1:50m, noms français),
361 lacs, 255 fleuves, 101 départements français (1:10m), 1 188 villes (grandes villes du monde,
villes françaises ≥ 10 000 hab.). Format compact (lon/lat arrondis, Douglas-Peucker), dessiné en
**canvas** dans le pane `world` (z-index 150, **sous** les tuiles IGN) par `worldLayer` ; noms de
pays (zoom ≤ 7) et de villes selon leur rang et le zoom, 80 au plus. Régénération : script Python
dans l'historique du commit « Fond monde embarqué ». Emplacements de tuiles vides masqués
(`visibility: hidden`, sinon cadre gris). Grille MGRS à partir du zoom 6 seulement. Leaflet 1.9.4 vendorisé (`leaflet.js`, `leaflet.css`).

## Mode de réception (paramètres → Réception)

Pour comparer sur le terrain, `settings.rxMode` :
- **Multifréquence** (`multi`, défaut) : `FT8Modem` (décodage large bande 12 kHz, canaux de
  l'annuaire, OSD, détection des trames en cours, barre des canaux).
- **Fréquence unique** (`single`) : `FT8ModemSingle` (`ft8-modem-single.js`), le décodeur d'avant
  à l'identique — capture à 48 kHz, recherche à ±3 tons autour de `baseFreq`, 6 candidats par
  passe, BP seule. Émission et réception sur la **fréquence de base** des paramètres (canaux de
  l'annuaire ignorés, `txFreq`), ancien spectre de 90 Hz (`drawSpectrumSingle`). Méthodes
  ajoutées vides : `channelBusy` (faux : seule la protection SonoLink `_rxInProgress` reste
  contre l'émission par-dessus une réception), `rxActivity`, `setChannels`. Les créneaux de
  balise de l'annuaire restent appliqués. Les deux stations doivent être dans le même mode.
- Changer de mode enregistre et **recharge** l'application (nouveau modem ; refusé pendant un envoi).

## Garder la main sur le micro (`holdMic`, `app.js`)

Depuis Android 9, une appli qui passe en arrière-plan (assistant vocal Gemini ouvert par-dessus,
autre appli, écran éteint) reçoit du **silence** du micro, sans erreur (AppOps `RECORD_AUDIO`
arrêté). Pendant l'écoute :
- **Application** : service au premier plan `ListenService` (type `microphone`, notification
  « ChatMTX écoute », verrou partiel du processeur), plugin `ListenService` (`ListenPlugin.java`,
  `start`/`stop`, demande `POST_NOTIFICATIONS` sur Android 13+). Vérifié sur émulateur API 36 :
  en arrière-plan, AppOps `RECORD_AUDIO` reste « running » avec le service, s'arrête sans.
  Plugins natifs : `Capacitor.Plugins.X` (pas de `registerPlugin` sans @capacitor/core empaqueté).
- **Jamais de mise en veille** tant que ChatMTX est ouvert (pas seulement à l'écoute) :
  appli → `FLAG_KEEP_SCREEN_ON` (`MainActivity`) ; navigateur → `navigator.wakeLock`
  (`keepAwake`), redemandé au retour sur la page et au premier toucher.
- **Partout, surveillance toutes les 0,5 s** (`micCheck`) : zéros exacts > 2 s sur l'analyseur
  (le système coupe le micro), piste `muted`/`ended`, contexte audio suspendu (`resume`) →
  bandeau orange « Micro pris par une autre application » (`#mic-lost`) et, au premier plan,
  **nouvelle capture** après 4 s (au plus une toutes les 10 s, jamais pendant une émission).
  L'assistant reste prioritaire tant qu'il écoute lui-même : seule la reprise est possible.

## FT8 radioamateur (messages standard WSJT-X, FT8CN)

Même modulation, autre charge utile : avant, une trame ni texte libre ni télémétrie était jetée.
`FT8Modem.decodeStandard(bits77)` donne le texte affiché par WSJT-X : i3 = 1/2 (« CQ F4ABC
JN18 », « F4ABC K1XYZ -12 », R-08, RRR, RR73, 73, /R, /P, CQ DX/POTA/nnn, QRZ, DE), i3 = 4
(indicatif non standard « CQ PJ4/K1ABC », hachage 12 bits), i3 = 0 n3 = 1 (DXpedition) ;
Field Day et RTTY Roundup partiels (« [FD] », « [RU] » : section/État non décodés), autres
types « [FT8 i3.n3] ». Hachages (`ft8Hash` = ihashcall de WSJT-X, 10/12/22 bits) des indicatifs
entendus en clair (`rememberCall`) : `<PJ4/K1ABC>` résolu, sinon `<...>`. Dans `_attemptDecode` :
`frame.ham` ; dans `app.js` : **jamais SonoLink** (ni accusé ni assemblage), bulle `.message.ham`
au texte brut + « FT8 radioamateur · 1234 Hz », 200 gardées dans l'historique, option
« Afficher le FT8 radioamateur » (cochée ; `body.hide-ham`). Mode multifréquence seulement.
Le **texte libre** radioamateur reste à SonoLink (émetteur « ? ») : sans en-tête, il ne se
distingue pas d'un fragment d'étendu ChatMTX (bloc 0 perdu) qu'une répétition doit remplacer.
Test : `node tests/ft8-standard.js` (vecteurs officiels `ft8code` de WSJT-X : 24/26 identiques,
2 formats de concours partiels ; hachages ; chaîne modulation → frame.ham).

## Barre des canaux (au-dessus de la saisie)

Remplace l'ancien spectre autour d'une seule fréquence (`drawChannels` dans `app.js`). Une
case par canal de l'annuaire, avec l'indicatif de la station et sa fréquence, plus mon canal
s'il n'y est pas (encadré rouge). Remplissage bleu discret : niveau audio du canal (analyseur,
dB au-dessus de la médiane de la bande). **Vert** : trame FT8 en train d'arriver sur ce canal
(`modem.rxActivity().onAir` : synchro partielle `_framesInProgress`, étendu qui continue,
traîne attendue) ; **vert clair** : trame décodée depuis moins de 4 s ; **rouge « TX »** : mon
canal pendant que j'émets. Trame hors canal connu : case « ? » à droite avec sa fréquence.
L'analyseur tourne à la fréquence du contexte audio (48 kHz), pas à celle de la capture décimée.

## Démodulation (RX)

Capture micro décimée à **12 kHz** (`RX_RATE`, FIR Blackman 65 coefs à 48 kHz, `decimationFilter`).
Passe de décodage toutes les 2 s, **large bande** (`RX_BAND_MIN`-`MAX` 200-3 000 Hz) : plusieurs
stations simultanées sur des fréquences différentes sont toutes décodées (comme WSJT-X).
1. **Spectrogramme FFT** (`_fftPowers`, longueur quelconque) : une ligne par **demi-symbole**,
   raies au **demi-pas** (3,125 Hz), sur les 40 dernières s (`RX_SEARCH_WINDOW`) + une trame.
   Lignes alignées sur la position absolue, **gardées en cache** (`_specRows`) avec la somme
   glissante des 8 tons : une passe ne calcule que les 2 s nouvelles
2. **Recherche Costas temps × fréquence** : score brut = Σ log(p ton attendu / moyenne des 7
   autres) sur les 21 cases Costas, **tous** les scores gardés par ligne de départ
   (`_coarseCache`, `Float32Array`). **Normalisé par le bruit de fond de chaque fréquence** :
   score − médiane des départs de la fenêtre pour cette demi-raie (`_columnMedians`, fond brut
   ≈ -10,4). Seuils normalisés : `RX_COARSE_MIN_SCORE` 25 (bruit max 23-26),
   `RX_CHANNEL_MIN_SCORE` 19 sur les canaux (bruit max 18-21) ; signal à -20 dB : 20-37.
   Mesuré et écarté : le score de **ft8_lib** (FT8CN, écarts en dB aux voisins en temps et en
   fréquence) sépare bien moins les signaux faibles (-20 dB : 4-7 pour un bruit jusqu'à 5) ;
   blanchir le spectre par fréquence n'apporte rien ; une raie continue sur un ton Costas ne
   gêne pas notre score. Sélection de
   **20 cases distinctes** (temps ≥ 20 symboles **ou** fréquence ≥ 30 Hz). Case affinée sans
   succès mémorisée (`_tried`) : jamais réessayée, laisse sa place aux suivantes
   **Canaux connus** (`setChannels`, annuaire) : seuil d'admission bas `RX_CHANNEL_MIN_SCORE`
   9 à ±15 Hz d'un canal (comme l'ancien décodeur à canal unique) ; ailleurs seuil large bande
3. **Raffinement fin séparable** (±½ symbole au ¼, ±2,6 Hz), puis **temps au 1/32 de symbole**
   (5 ms, ±1/8, interpolé : `_refineTimeGoertzel`) et fréquence interpolée. Indispensable : la
   grille au ¼ de symbole est fixe (alignée sur la position absolue pour le cache), une
   fenêtre décalée de 20 ms coûtait ~1 dB ; l'ancien décodeur avait une grille qui changeait à
   chaque passe (tampon décalé de 12,5 symboles), donc plusieurs chances
4. **BP** (offset min-sum) puis, si elle échoue, **OSD** (`osdDecode`, comme WSJT-X : 91
   positions les plus fiables réencodées, ordre 1 complet + paires parmi les 50 moins fiables de
   la base, `RX_OSD_PAIRS`) sur des **vraisemblances d'amplitude** (`_extractLLRAmplitude`,
   meilleur ordre de fiabilité que les log-puissances) → CRC-14 → texte libre ou télémétrie.
   Échec au meilleur point (synchro ≥ 20) : essais voisins ±1/16 de symbole, ±0,5 Hz.
   Tentative d'étendu (blocs avant **et** arrière). `frame.freq` = fréquence du ton 0
   OSD sur bruit pur : 1 CRC accepté sur 20 000, aucun de type valide ; 0 faux décodage en
   10 min de bruit (12 canaux), passe moyenne 245 ms sur PC

Mesures : `tests/multisignal.js` — 10 stations simultanées 30/30, forte 0 dB + faible -16 dB à
120 Hz OK, 2 étendus simultanés non mélangés. **Sensibilité** (`tests/sensitivity.js`, flux
réel, mêmes tirages, ancien décodeur 48 kHz à canal unique entre parenthèses) : -18 dB 20/20
(19), **-19 dB 20/20 (17), -20 dB 15/20 (3), -21 dB 4/20 (0)** : ~1,5 dB de mieux. Avant
l'affinage au 1/32 et l'OSD, le large bande perdait ~0,5 dB (-19 dB 13/20) : trames trouvées
mais LDPC en échec. Passe ~250 ms au repos sur PC (cache), ~1,4 s avec 10 signaux, 2,5 s à froid.

Dédoublonnage **par position absolue et fréquence** (`_decodedSpans` avec `freq`) : un candidat
dont le centre tombe dans une trame déjà décodée **à moins de 30 Hz** est exclu avant la
sélection. Une vieille trame n'est jamais réémise, une trame répétée à l'identique (ARQ) est une
nouvelle position, et une autre station au même instant sur une autre fréquence passe.

**Trame en cours de réception** (`_framesInProgress` → `channelBusy()`) : fenêtres de départ trop
récentes pour 79 symboles dont les 1 ou 2 Costas reçus synchronisent (`RX_BUSY_SCORE_1/2` 12/17,
bruit max 11/12) **et** dont les tons de données suivent le dernier Costas (contraste
`RX_BUSY_CONTRAST`, sinon c'est la fin d'une trame finie) ; aussi trame décodée qui continue
(étendu) ou dont la traîne n'est pas captée. Lignes muettes (micro coupé) ignorées. Mesure :
0 fausse alerte sur 600 s de bruit, détecté 100 % à -10 dB, ~95 % à -14 dB, ~60-70 % à -18 dB.

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

# Import d'annuaire, canaux/créneaux, attribution, fichier et lien de QR code, annuaire de test
node tests/directory.js

# Service des annuaires (port et dossier temporaires) : codes, versions, limites
node tests/annuaire-server.js

# Messages formatés 9-line / MIST : codage, MGRS (référence publiée), texte en clair
node tests/medevac.js

# Carte tactique : SIDC valides, message → symbole, projection CONTACT, carroyage, tuiles
node tests/tacmap.js

# Séquencement PTT (avance/maintien, annulation) et adaptateur natif
node tests/ptt-timing.js

# Efficacité selon la fréquence audio : chaîne BLU simulée (filtre 300-2700 Hz, distorsion) — ~8 min
node tests/passband.js 8        # → bande utile 500-2500 Hz (décodage plat)

# Bande son d'essai à jouer devant (ou câblée à) un téléphone : trames « PC99SNR -xx » toutes
# les 15 s, de plus en plus faibles ; BRUIT=enregistrement.wav (ex. réception HF), GAIN_DB=-20
# pour une entrée micro (une sortie ligne de PC sature), NIVEAUX=0,-10,-14,...
node tests/test-audio.js essai.wav 1000

# Sensibilité en conditions d'écoute réelles (flux 48 kHz, passes de 2 s, horloge ±150 ppm,
# fréquence ±10 Hz), comparée à une autre version du modem — ~20 min avec l'ancien
git show eeb6e19:ft8-modem.js > /tmp/ancien.js
node tests/sensitivity.js 20 /tmp/ancien.js     # SNRS=-19,-20,-21 ; F0=1000 ; plusieurs fichiers comparés
# BRUIT=ambiant (rose, voix, sifflements, clics) ou BRUIT=enregistrement.wav (48 kHz mono, ex.
# sortie de réception d'un IC-7300 : `arecord -D plughw:CARD=CODEC,DEV=0 -f S16_LE -r 48000 -c 1`).
# Bruit HF réel (80 m, USB 3 kHz) : plus dur que le blanc ; -19 dB : multi 9/20, ancien 1/20.

# Bout en bout : 2 FT8Modem réels + SonoLink, air simulé (GFSK + bruit), 12 kHz — ~2,5 min
node tests/link-audio.js        # SNR -10 dB (argument : autre SNR) ; dont 3e station sur autre fréquence

# Plusieurs stations simultanées (2, 5, 10, forte + faible, 2 étendus) — ~1 min
node tests/multisignal.js 3

# 3 stations ChatMTX complètes (Chromium headless), air simulé avec pertes, temps ×10 — ~6 min
# 23 scénarios : adressage, en l'air, répétitions, RPT, 9-line/MIST, collationnement, alerte
# Prérequis hors dépôt : npm i -g playwright-core && npx playwright install chromium
node tests/stations.js        # ONLY=12,24 : seulement ces scénarios
```


## Station de test HF (`station/`) : ChatMTX sur l'IC-7300 du PC

Le **vrai ChatMTX** (https://chatmtx.f4mtx.com, même code que l'APK) dans une fenêtre Chromium
du bureau, relié à l'IC-7300 **par le pupitre telec-icom** (`~/projects/telec-icom`, démarré par
son `run.sh`, port 8000), qui garde l'exclusivité du poste (CI-V, codec réservé par sa règle
WirePlumber `51-ic7300-exclusif.lua` — ne jamais la contourner) et ses garde-fous d'émission.
- `chatmtx-station.js` (Node + `playwright-core` 1.63.0 + `ws`) : se connecte au pupitre avec le
  compte station (`compte.py` : compte machine vérifié, approuvé, droit d'émettre, sans second
  facteur ; identifiants dans `~/.config/chatmtx-station/compte.json`, 0600).
  Trames du pupitre : **240 octets = 120 échantillons = 10 ms** à 12 kHz.
  Réception : `/ws/rx` → pont local WebSocket → **faux micro** de la page (`getUserMedia`
  remplacé ; `AudioWorklet` `rx-src` avec 0,5 s d'avance, souffle infime quand rien n'arrive).
  Émission : PTT de l'appli = faux port série (`modem.serialPort.setSignals`) → ordre
  `{action:'ptt'}` sur `/ws/state` ; pendant `transmitSymbols`, `ctx.destination` est remplacé
  par un `MediaStreamDestination` capté à 12 kHz (`AudioWorklet` `tx-cap`, sur le fil audio :
  insensible aux passes de décodage) → le lanceur **recadence** à 1 trame / 10 ms après 0,3 s
  d'avance → `/ws/tx` ; PTT relâché seulement **file vidée** (sinon fin de trame coupée). Rien
  vers les haut-parleurs du PC. `SELFTEST=1` (avec `NO_TX=1`) : la page émet « ESSAI STATION »,
  l'audio qui serait parti est enregistré (`/tmp/chatmtx-station-tx.wav`) et se décode hors
  ligne (vérifié : 13,19 s, décodé à 1 000,2 Hz).
  Fréquence du poste lue dans l'état du pupitre (titre) ; **aucun ordre de fréquence ni de mode**.
- Profil Chromium `~/.local/share/chatmtx-station` (indicatif, annuaire, historique de la
  station) ; `--disable-features=LocalNetworkAccessChecks` (page https → pont `ws://127.0.0.1`).
- Écoute lancée seule ; nouvelle version (`CACHE_NAME` de `sw.js`, toutes les 5 min) → page
  rechargée au repos. PTT relâché sur fermeture/plantage/arrêt et après 130 s. Le pupitre accorde
  au **seul compte station** une durée maximale d'émission de 130 s (`station_max_tx` dans son
  `app.py`, `set_ptt(on, max_tx)` dans `icom/controller.py`, `.env` : `PUPITRE_STATION_EMAIL`,
  `PUPITRE_STATION_MAX_TX`, borné à 180 s) ; les autres comptes gardent `PUPITRE_MAX_TX` (60 s)
  et ses trois autres barrières s'appliquent aussi à la station.
- Journal toutes les 30 s : trames/s et niveau reçus du pupitre, niveau du micro ChatMTX,
  trames d'émission. `NO_TX=1` : réception seule, l'émission est captée et comptée, jamais émise.
- `install.sh` (dépendances, compte, service `chatmtx-station.service` de la session graphique).
- Session du pupitre gardée (`~/.config/chatmtx-station/session`, 7 jours) : se reconnecter à
  chaque démarrage épuise la limite de 5 connexions / 15 min du pupitre (attente de 16 min
  après un refus). Présence du poste suivie : « POSTE NON JOIGNABLE (CI-V) », PTT refusé.
- **IC-7300 : « CI-V USB Baud Rate » = 19200** (pas Auto : en Auto le poste se cale sur le
  dernier débit entendu, et un autre logiciel à 115 200 le rendait muet pour le pupitre).
- Essai d'émission réel (4 oct. 2026) : étendu 2 blocs, alternat 24,9 s, 2 465 trames de 10 ms,
  aucune coupure du chien de garde.

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
