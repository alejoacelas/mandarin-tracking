# Hub protocol

The hub runs on the Mac as a LaunchAgent. It stores everything, works out daily totals and serves the dashboard. The Chrome extension and the Android app measure time and send it to the hub.

- Address: `http://<mac>:47800`. The extension uses `http://127.0.0.1:47800`.
- The Android app finds the hub on the local network through Bonjour/NSD, service type `_mandarintrack._tcp`. It remembers the last address that worked and tries it first.
- Bodies are JSON. Times are integer milliseconds since the Unix epoch, in UTC.
- Every call except pairing carries `Authorization: Bearer <token>`. A missing or unknown token gets `401`, and the client must pair again.

## Pairing

`POST /api/v1/pair` with `{"code": "123456", "device_name": "Pixel 8", "kind": "android"}` returns `{"token": "...", "device_id": "..."}`. The 6-digit code is shown on the dashboard. It changes after each successful pairing. A wrong code gets `403`.

`POST /api/v1/pair-extension` with `{"device_name": "Chrome"}` returns the same shape. The hub accepts it only from loopback, and only when `Origin` starts with `chrome-extension://`.

## Intervals

`POST /api/v1/intervals` with `{"intervals": [Interval, ...]}` (at most 500 per call) returns `{"accepted": n, "rejected": [{"id": "...", "reason": "..."}]}`.

An interval is a stretch of time spent in one source. The hub saves it under `(device, id)`. Sending the same `id` again replaces the earlier copy, so a client can send a session that is still running and extend it later. Sending the same batch twice is harmless.

| Field | Type | Meaning |
|---|---|---|
| `id` | string, ≤128 chars, required | Unique per device. |
| `source` | `youtube`, `reader`, `pleco`, `llm` or `app`, required | `app` is a tracked app whose content isn't known. |
| `start_ms`, `end_ms` | int, required | `end_ms > start_ms`. Each interval is at most 12 h long and ends no more than 5 min in the future. |
| `language` | `zh`, `other` or `unknown`, required | `zh` means Mandarin, as measured by the client. Use `unknown` when the client didn't see the content, and for every YouTube interval (the hub classifies channels). |
| `zh_share` | number 0–1 or null | Share of the measured text that is Chinese (see "Chinese share"). |
| `units` | int or null | How much text `zh_share` is based on. |
| `app` | string, required | Android package, Mac bundle ID or website host, e.g. `com.pleco.chinesesystem`, `chatgpt.com`. |
| `title` | string or null | Video, document or chat title. |
| `channel_name`, `channel_id`, `video_id` | string or null | YouTube only. Android's media session gives only the channel name. |
| `conversation_id`, `doc_id`, `url` | string or null | When known. |
| `meta` | object or null | Anything else useful for debugging, at most 4 KB. |

Clients start a new interval when the video, conversation, document, app or language changes. They also start one after 30 minutes of a single interval, and after any gap of more than 2 minutes, such as the screen locking, the user going idle or a video pausing. They send intervals at least once a minute while one is running, and keep unsent intervals until the hub accepts them, however long that takes.

## Chat history

`POST /api/v1/chat-messages` with `{"messages": [{"service": "chatgpt" | "claude", "conversation_id", "message_id", "at_ms", "role": "user" | "assistant", "zh_share", "units"}]}` returns `{"accepted": n}`. The hub saves each message under `(service, message_id)`.

The extension reads these from the history endpoints that chatgpt.com and claude.ai use. That history includes chats from the phone and desktop apps. The hub uses it to decide whether an `llm` or `app` interval in those apps with `language: unknown` was in Mandarin.

## Problems

`POST /api/v1/problems` with `{"component": "android.mediasession", "message": "..."}`. The hub shows the latest problem from each component on the dashboard until that component sends `{"component": "...", "resolved": true}`.

## Heartbeat

Clients call `POST /api/v1/heartbeat` with `{"version": "1.0.0", "permissions": {"usage_access": true, ...}}` at least every 15 minutes while they can reach the hub. The dashboard warns when a device has been silent for more than 24 hours, or when it lacks a permission it needs.

## Summary

`GET /api/v1/summary?days=7` returns the dashboard data (the extension popup uses it):

```json
{"days": [{"date": "2026-11-10", "total_min": 42.5,
  "by_source": {"youtube": 20, "reader": 10, "pleco": 5, "llm": 7.5},
  "partly_min": 3, "unclassified_min": 1}],
 "warnings": ["..."]}
```

## Chinese share

Every client computes the share the same way. Count each Han character as one unit, and each run of Latin or Cyrillic letters as one unit. Each kana character and each run of Hangul also count as units, but non-Chinese ones, so Japanese and Korean score low. The share is Han units ÷ all units, except that text whose kana characters are at least 10% of its Han plus kana characters is Japanese and has share 0 (Japanese text full of kanji otherwise passes the threshold). Text counts as Mandarin when the share is at least 0.3 and there are at least 20 units. Interface text such as buttons, menus and the list of past chats is excluded wherever the client can tell it apart from content. Traditional and simplified characters both count. Cantonese written in Chinese characters also counts, because text alone can't separate the two.
