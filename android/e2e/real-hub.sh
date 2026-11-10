#!/bin/bash
# Sends real intervals from the emulator to the real hub (hub/ in this repo) and prints the
# hub's view of today. Needs Go and the simulator apps (installed by e2e/run.sh).
# Usage: e2e/real-hub.sh [-s emulator-5554]
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == "-s" ]]; then export ANDROID_SERIAL="$2"; shift 2; fi

DATA=$(mktemp -d)
(cd ../hub && go build -o "$DATA/hub" .)
"$DATA/hub" -data "$DATA" -no-bonjour -no-mac-apps -port 47800 &
HUB=$!
trap 'kill $HUB 2>/dev/null' EXIT
until curl -s -o /dev/null http://127.0.0.1:47800/api/v1/dashboard; do sleep 0.5; done
CODE=$(curl -s -H "Host: 127.0.0.1:47800" http://127.0.0.1:47800/api/v1/dashboard | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pair_code"])')

./gradlew -q :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.mandarintracking.android.RealHubTest \
  -Pandroid.testInstrumentationRunnerArguments.realHub=10.0.2.2:47800 \
  -Pandroid.testInstrumentationRunnerArguments.realHubCode="$CODE"

curl -s -H "Host: 127.0.0.1:47800" http://127.0.0.1:47800/api/v1/dashboard | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
print("devices:", d.get("devices"))
print("today:", d["days"][-1] if d.get("days") else None)
print("warnings:", d.get("warnings"))'
