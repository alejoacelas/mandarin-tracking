#!/bin/bash
# Builds the three release assets into dist/: mandarin-hub, chrome-extension.zip and mandarin-tracker.apk.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
scripts/build-hub.sh
(cd extension && npm ci --silent && npm test >/dev/null && npm run build >/dev/null)
rm -f dist/chrome-extension.zip
(cd extension && zip -qr ../dist/chrome-extension.zip manifest.json popup.html dist $(ls -d icons 2>/dev/null))
(cd android && ./gradlew -q :app:testDebugUnitTest :app:assembleRelease)
cp android/app/build/outputs/apk/release/app-release.apk dist/mandarin-tracker.apk
ls -la dist
