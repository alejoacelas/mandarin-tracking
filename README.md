# mandarin-tracking

Track how much time I spend taking in and using Mandarin, across:

- watching Mandarin videos on YouTube
- reading Mandarin in Readwise Reader
- reading and looking things up in Pleco
- talking with LLMs in Mandarin

The goal is a single daily total, with a breakdown by activity.

## How each source is measured

### YouTube

A Chrome extension, built separately.

### Readwise Reader

Two measurements, combined per document per day by taking the larger:

- On the desktop, the extension's content script on read.readwise.io counts engaged time.
- Everywhere, including the phone apps, `src/readwise.js` reads the Reader API. The API has no
  time spent, but a document's `updated_at` moves each time Reader saves reading progress
  (about every 30 s while you scroll) and `last_opened_at` marks opens. Saves less than 5 min
  apart form one session, plus 45 s after the last save. The tracker polls every 5 min, and
  every 30 s while saves are arriving, because each poll only sees a document's latest save.
  A document counts as Mandarin when its text is at least 30% Chinese.

`readwise/benchmark.py` compares estimators on recorded scripted reading
(`readwise/runs/`); this method was within about 15% per session and 11% overall, while
crediting whole poll intervals or characters read was off by 2–4×. Untested: how promptly
the phone apps sync progress, and reading without scrolling for over 5 min, which ends the
session. Reader stops syncing progress when the page scrolls without user input, so
benchmarks drive it with real key presses.

### Pleco

Pleco runs on the iPhone and has no API; its history export keeps only the last
lookup time per word. Time comes from iPhone Screen Time instead: with "Share
Across Devices" on, iPhone app sessions sync to the Mac's Biome `App.InFocus`
stream (`~/Library/Biome`, readable only with Full Disk Access). The tracker sums
Pleco's sessions per day. Biome keeps about four weeks, so the reader runs
continuously. It cannot separate document reading from lookups.

### LLM conversations

The extension times each conversation on claude.ai and chatgpt.com live, while its tab
is visible, focused and in use, and records the share of Chinese in the chat. Chats in
the desktop and phone apps are not counted. To add them, fetch history from the
endpoints the web apps use (claude.ai `/api/organizations/{org}/chat_conversations`,
chatgpt.com `/backend-api/conversations`), which carry per-message timestamps from
every device, and merge per chat per day by taking the larger, as for Reader.
