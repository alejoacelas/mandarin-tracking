// Checks against the live sites that the fixture tests can't cover: YouTube's real player reports
// the video ID the extension relies on, and the extension can classify a channel by calling the
// Anthropic API from inside the browser. Needs a build with a real key. Opens browser windows, so
// run it on a spare machine: node test/e2e/live-checks.mjs
import { Browser, sleep } from "./harness.js";
// 1) Real YouTube: does the player report the video ID the extension relies on?
const live = await Browser.launch({ live: true });
const yt = await live.open("https://www.youtube.com/watch?v=SHWjQrGb3MQ");
await sleep(5000);
console.log("real player:", await yt.eval(`JSON.stringify({ api: typeof document.getElementById("movie_player")?.getVideoData, id: document.getElementById("movie_player")?.getVideoData?.().video_id, details: (({ videoId, channelId, author }) => ({ videoId, channelId, author }))(document.getElementById("movie_player")?.getPlayerResponse?.()?.videoDetails ?? {}), playerClass: !!document.querySelector("video")?.closest(".html5-video-player"), adFlag: !!document.querySelector(".ad-showing") })`));
await live.close();
// 2) Fixture page, real Anthropic API: the extension classifies a channel it hasn't seen.
const b = await Browser.launch();
await b.worker.eval(`chrome.storage.local.clear().then(() => true)`);
const page = await b.open("https://www.youtube.com/watch?v=SHWjQrGb3MQ");
await page.eval(`document.querySelector("video").play().then(() => true)`);
await sleep(7000);
await page.eval(`document.querySelector("video").pause()`);
let ch;
for (let i = 0; i < 60; i++) { ch = (await b.storage(["channels"])).channels; if (ch && Object.values(ch).every((c) => c.status !== "pending")) break; await sleep(3000); }
console.log("classification in browser:", JSON.stringify(ch));
console.log("log:", JSON.stringify((await b.storage(["log"])).log));
await b.close();
