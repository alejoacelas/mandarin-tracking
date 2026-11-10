#!/bin/bash
# Installs (or updates) Mandarin Tracker on this Mac:
#   curl -fsSL https://raw.githubusercontent.com/alejoacelas/mandarin-tracking/main/install.sh | bash
# Remove it with:
#   curl -fsSL https://raw.githubusercontent.com/alejoacelas/mandarin-tracking/main/install.sh | bash -s -- --uninstall
set -euo pipefail

REPO="alejoacelas/mandarin-tracking"
RELEASE="${MT_RELEASE_URL:-https://github.com/$REPO/releases/latest/download}"
APP="$HOME/Applications/Mandarin Tracker"
DATA="$HOME/Library/Application Support/Mandarin Tracker"
LOGS="$HOME/Library/Logs/Mandarin Tracker"
LABEL="com.mandarintracker.hub"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=47800
DOMAIN="gui/$(id -u)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mCould not install: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS."

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APP"
  say "Mandarin Tracker is removed. Your recorded time is still in:"
  echo "  $DATA"
  echo "Move that folder to the Trash if you don't want it. Also remove the extension in chrome://extensions and the app on the phone."
  exit 0
fi

major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 12 ] || die "macOS 12 or later is needed (this Mac has $(sw_vers -productVersion))."

say "Downloading Mandarin Tracker…"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -n "${MT_LOCAL_DIST:-}" ]; then
  cp "$MT_LOCAL_DIST/mandarin-hub" "$MT_LOCAL_DIST/chrome-extension.zip" "$tmp/"
else
  curl -fsSL --retry 3 -o "$tmp/mandarin-hub" "$RELEASE/mandarin-hub" || die "couldn't download the hub. Check the internet connection and try again."
  curl -fsSL --retry 3 -o "$tmp/chrome-extension.zip" "$RELEASE/chrome-extension.zip" || die "couldn't download the Chrome extension."
fi
chmod +x "$tmp/mandarin-hub"
"$tmp/mandarin-hub" -version >/dev/null 2>&1 || die "the downloaded hub doesn't run on this Mac."

say "Installing…"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
mkdir -p "$APP" "$DATA" "$LOGS" "$HOME/Library/LaunchAgents"
mv -f "$tmp/mandarin-hub" "$APP/mandarin-hub"
xattr -cr "$APP/mandarin-hub" 2>/dev/null || true
# Replace the extension's files in place: Chrome keeps loading it from this same folder.
rm -rf "$APP/Chrome extension.new"
mkdir -p "$APP/Chrome extension.new"
unzip -q "$tmp/chrome-extension.zip" -d "$APP/Chrome extension.new"
rm -rf "$APP/Chrome extension"
mv "$APP/Chrome extension.new" "$APP/Chrome extension"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/mandarin-hub</string><string>-port</string><string>$PORT</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/hub.log</string>
  <key>StandardErrorPath</key><string>$LOGS/hub.log</string>
</dict>
</plist>
EOF

# The phone sends its time to this Mac, so the macOS firewall, if it's on, must let the hub in.
fw=/usr/libexec/ApplicationFirewall/socketfilterfw
if "$fw" --getglobalstate 2>/dev/null | grep -q "enabled"; then
  say "The Mac's firewall is on. Allowing the hub to receive time from the phone (your Mac password is needed)…"
  sudo "$fw" --add "$APP/mandarin-hub" >/dev/null && sudo "$fw" --unblockapp "$APP/mandarin-hub" >/dev/null \
    || echo "Couldn't change the firewall. The phone won't be able to send its time until the hub is allowed in System Settings > Network > Firewall."
fi

launchctl bootstrap "$DOMAIN" "$PLIST" || die "macOS refused to start the hub (see $LOGS/hub.log)."
for _ in $(seq 1 20); do
  curl -fs "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 || die "the hub didn't start. See $LOGS/hub.log."

say "Mandarin Tracker is running. It starts by itself whenever you log in."
cat <<EOF

Three things left to do, once:

1. Chrome extension: in Chrome, open chrome://extensions, turn on "Developer mode"
   (top right), click "Load unpacked" and choose this folder:
     $APP/Chrome extension
   (In the file picker, press Command+Shift+G and paste that path.)

2. Phone: open the dashboard (it's opening now) and scan the QR code under
   "Connect" with the phone to download the Android app. The app walks you
   through its permissions and finds this Mac by itself.

3. Readwise Reader: paste your access token from readwise.io/access_token
   into Settings on the dashboard.

Dashboard: http://127.0.0.1:$PORT
EOF
open "http://127.0.0.1:$PORT" 2>/dev/null || true
