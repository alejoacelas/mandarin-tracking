# mandarin-tracking

Track how much time I spend taking in and using Mandarin, across:

- watching Mandarin videos on YouTube
- reading Mandarin in Readwise Reader
- reading and looking things up in Pleco
- talking with LLMs in Mandarin

The goal is a single daily total, with a breakdown by activity.

## How each source is measured

### YouTube

The extension counts time while a video plays with sound and no ad is showing, in any tab.
YouTube's player says which video is playing, so the miniplayer's next video counts toward
its own channel. Each video's channel comes from YouTube's oEmbed endpoint. The first time a
channel appears, Claude Opus with web search labels it `mandarin`, `mixed` (roughly 25–75%
Mandarin, like lessons taught in English), `other` or `unknown` (`src/classify.js`). Time
from channels not yet labelled shows as "not yet classified", and labels apply to past days
too. Phone and TV viewing isn't counted.

`eval/` measures the labels against the spoken language of each channel's audio:
`ground-truth.mjs` cuts nine 30 s clips per channel and runs SenseVoice (which separates
Mandarin from Cantonese), plus an LLM check that flags Hokkien, Hakka and Wu transcribed as
garbled Mandarin. `run-classifier.mjs` scores the classifier on 58 deliberately tricky
channels from `channels.json`.

### Readwise Reader

Two measurements, combined per document per day by taking the larger:

- On the desktop, the extension's content script on read.readwise.io counts engaged time.
- Everywhere, including the phone apps, `src/readwise.js` reads the Reader API, with the token
  from the extension's settings or else `READWISE_TOKEN` from `.env`, built in by `npm run build`. The API has no
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

Not tracked. Pleco has no API, and the Mac's copy of iPhone Screen Time lists only a few
apps per day, so Pleco's minutes can't be read from it.

### Mac apps

`apptime/` is a small helper that runs in the background at login (install with
`apptime/install.sh`; it needs no permissions). Every 5 s it gives 5 s to the app in front,
unless the screen is locked or there has been no input for 2 minutes, and serves the daily
totals at `http://127.0.0.1:47321/`. The extension copies them once a minute and shows the apps
named in its settings (Orca by default) in their own card, outside the Mandarin total, since the
helper can't tell what language you use in an app. It counts from install onwards.

### LLM conversations

The extension times each conversation on claude.ai and chatgpt.com live, while its tab
is visible, focused and in use, and records the share of Chinese in the chat. Chats in
the desktop and phone apps are not counted. To add them, fetch history from the
endpoints the web apps use (claude.ai `/api/organizations/{org}/chat_conversations`,
chatgpt.com `/backend-api/conversations`), which carry per-message timestamps from
every device, and merge per chat per day by taking the larger, as for Reader.

## The Chrome extension

Build it with `npm install && npm run build`, which reads `ANTHROPIC_API_KEY` from `.env`
(see `AGENTS.md`). Then in `chrome://extensions`, turn on Developer mode, choose "Load
unpacked" and pick the `extension/` folder. The extension reloads itself within a minute of
each rebuild, and open tabs pick up the new version without reloading.

Click the toolbar icon to see the breakdown; "Open in a tab" shows the same view full size. The icon's badge shows today's Mandarin minutes. The view has the last seven days as bars (click one to see that day), the day's Mandarin total, and each channel, chat and document with its time and label. An amber "!" on the badge means something needs attention: a channel that couldn't be labelled, a page whose layout the extension no longer recognises, or a failed Reader API poll. A chat or document counts as Mandarin when at least 30% of its text is Chinese
(adjustable). Reading stops counting after 2 minutes without input. Set a Readwise token in
Settings to add phone reading. "Export JSON" saves the raw log, channel labels and
settings, without the token.

Tests: `npm test` runs unit tests. `npm run test:e2e` loads the extension into Chromium and
checks recorded time against a scripted schedule on local copies of claude.ai, chatgpt.com
and YouTube. It opens browser windows, so run it on a machine you aren't using.
`test/e2e/live-checks.mjs`, `live-reader.mjs` and `live-apptime.mjs` check the parts that need
the real sites or the Mac helper.
