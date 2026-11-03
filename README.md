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

The Reader API (`GET https://readwise.io/api/v3/list/?updatedAfter=…`, token from
readwise.io/access_token) gives each document's `reading_progress`,
`last_opened_at` and content, but no time spent. Time is estimated from how
progress changes between polls. The method is being chosen by benchmarking
several estimates against each other.

Limits: progress is a scroll position, so skimming inflates it and rereading adds
nothing. Phone reading appears only after the app syncs. The list endpoint allows
20 requests per minute.

### Pleco

Pleco runs on the iPhone and has no API; its history export keeps only the last
lookup time per word. Time comes from iPhone Screen Time instead: with "Share
Across Devices" on, iPhone app sessions sync to the Mac's Biome `App.InFocus`
stream (`~/Library/Biome`, readable only with Full Disk Access). The tracker sums
Pleco's sessions per day. Biome keeps about four weeks, so the reader runs
continuously. It cannot separate document reading from lookups.

### LLM conversations

Claude and ChatGPT keep every message server-side with a timestamp, whichever
device sent it. The Chrome extension fetches history from the endpoints the web
apps use, with the browser's login:

- claude.ai: `/api/organizations/{org}/chat_conversations` and
  `/chat_conversations/{id}?tree=True&rendering_mode=messages`
- chatgpt.com: `/backend-api/conversations` and `/backend-api/conversation/{id}`,
  with the bearer token from `/api/auth/session`

These endpoints are undocumented and may change; the official data exports carry
the same timestamps as a manual fallback. A turn counts as Mandarin when my
message is at least 30% CJK characters. Turns are grouped into sessions split by
gaps over 10 minutes, and each gap is capped at an estimate of reading and typing
time.
