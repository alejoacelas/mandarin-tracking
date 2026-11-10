# Mandarin Tracker

Counts the time you spend on Mandarin each day: YouTube videos, reading in Readwise Reader and Pleco, and chatting with AI in Mandarin, on a Mac with Chrome and an Android phone. After setup it runs by itself, and the dashboard on the Mac shows the totals.

## Install

On the Mac, paste this into Terminal:

```
curl -fsSL https://raw.githubusercontent.com/alejoacelas/mandarin-tracking/main/install.sh | bash
```

It installs the hub (it starts at every login) and opens the dashboard at http://127.0.0.1:47800. The installer then lists three one-time steps: load the Chrome extension, install the Android app from the dashboard's QR code, and paste a Readwise token.

The phone sends its time when it's on the same Wi-Fi as the Mac and keeps it until then.

To uninstall, run the same command with `| bash -s -- --uninstall` instead of `| bash`.

## Develop

`hub/` (Go), `extension/` (Chrome) and `android/` each have their own tests; `docs/protocol.md` is how they talk. `scripts/build-release.sh` builds the release files.
