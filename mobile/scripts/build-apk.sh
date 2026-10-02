#!/usr/bin/env bash
# Construit l'APK signé de SonoChat : fichiers du site -> www/ -> projet Android
# -> assembleRelease -> ../dist/sonochat.apk (publié ensuite par ../deploy.sh).
# Avant une publication : incrémenter "version" dans mobile/package.json.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(cd .. && pwd)
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
export ANDROID_HOME=$SDK

if [ ! -f android/keystore.properties ]; then
  echo "android/keystore.properties absent : copie de secours dans ~/.android-keys (voir CLAUDE.md)" >&2
  exit 1
fi

node scripts/bundle-web.mjs
npx cap sync android
(cd android && ./gradlew --quiet assembleRelease)

APK=android/app/build/outputs/apk/release/app-release.apk
BT=$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)
"$BT/apksigner" verify "$APK"
mkdir -p "$ROOT/dist"
cp "$APK" "$ROOT/dist/sonochat.apk"
# Version publiee avec l'APK (deploy.sh) : les applications plus anciennes
# affichent l'ecran de mise a jour obligatoire
node -p "JSON.stringify({ version: require('./package.json').version })" > "$ROOT/dist/apk-version.json"
echo "APK : dist/sonochat.apk ($(du -h "$ROOT/dist/sonochat.apk" | cut -f1)), version $(node -p "require('./package.json').version")"
