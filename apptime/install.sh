#!/bin/zsh
# Builds the app-time helper and runs it at login with launchd. Rerun after changing main.swift.
# Remove with: launchctl bootout gui/$(id -u)/$LABEL && trash ~/Library/LaunchAgents/$LABEL.plist
set -euo pipefail
LABEL=io.github.alejoacelas.mandarin-apptime
DIR="$HOME/Library/Application Support/mandarin-tracking"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
swiftc -O "${0:A:h}/main.swift" -o "$DIR/apptime"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DIR/apptime</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardErrorPath</key><string>$DIR/apptime.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
curl -sf http://127.0.0.1:47321/ >/dev/null && echo "apptime running on http://127.0.0.1:47321/"
