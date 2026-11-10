#!/bin/bash
# Runs the emulator end-to-end tests: starts the fake hub on the host, installs the simulator
# apps (fake Pleco, ChatGPT, Reader, YouTube and a hub beacon) and runs the instrumented tests.
# The emulator must not have the real YouTube installed (use an AOSP "default" image).
# Usage: e2e/run.sh [-s emulator-5554] [gradle args, e.g. -Pandroid.testInstrumentationRunnerArguments.class=...]
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "-s" ]]; then export ANDROID_SERIAL="$2"; shift 2; fi

python3 e2e/fake_hub.py --port 47811 &
HUB=$!
trap 'kill $HUB 2>/dev/null' EXIT

./gradlew -q :simulators:assembleDebug :app:assembleDebug :app:assembleDebugAndroidTest
for apk in simulators/build/outputs/apk/*/debug/*.apk; do
  # The fake YouTube can't replace a preinstalled real one; its tests then fail, the others still run.
  adb install -r -t "$apk" >/dev/null || echo "could not install $apk"
done
# Let notifications from the fake YouTube player show (Android 13+).
adb shell pm grant com.google.android.youtube android.permission.POST_NOTIFICATIONS 2>/dev/null || true

./gradlew :app:connectedDebugAndroidTest "$@"
