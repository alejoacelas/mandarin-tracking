# Mandarin time: Chrome extension

Measures time on YouTube, LLM chats (chatgpt.com, claude.ai, Gemini, DeepSeek, Doubao, Kimi, Grok, Perplexity) and Readwise Reader, imports chatgpt.com and claude.ai chat history, and sends it all to the hub on this Mac (`http://127.0.0.1:47800`, see `../docs/protocol.md`). It pairs with the hub by itself; the popup shows today's minutes, the hub's status and any problems.

Build: `npm install && npm run build`. Load: in `chrome://extensions` turn on Developer mode, choose "Load unpacked" and pick this folder.

Test: `npm test` runs the unit tests. `npm run test:e2e` loads the extension into Chromium (from `npx playwright install chromium`, or `CHROMIUM=<path>`) against local copies of the sites and a fake hub; it opens browser windows, so run it on a machine you aren't using. `node test/e2e/live-youtube.mjs` and `node test/e2e/live-signed-in.mjs` check the real sites; the second copies this Mac's Chrome cookies into a temporary profile.
