// Loads the built extension into Chromium and checks the time it records against a scripted
// schedule of activity. Opens real browser windows, so run it on a machine you aren't using
// (see README). Run with `npm run test:e2e`.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, sleep, VIDEO_ID, CHANNEL_URL, VIDEO_ID_2, CHANNEL_URL_2, VIDEO_ID_NO_EMBED, CHANNEL_ID_NO_EMBED } from "./harness.js";

const IDLE_SECONDS = 6;
const TOLERANCE = 2; // seconds of allowed difference from the scripted schedule
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const GPT = "6abb6a25-c3bc-83ed-9a17-e71dc2041f25";

let browser;
before(async () => { browser = await Browser.launch(); });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  await browser.worker.eval(`(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      settings: { idleSeconds: ${IDLE_SECONDS}, threshold: 0.3 },
      // Pre-classified, so the test doesn't call the LLM.
      channels: {
        ${JSON.stringify(CHANNEL_URL)}: { name: "test", status: "done", label: "mandarin" },
        ${JSON.stringify(CHANNEL_URL_2)}: { name: "test 2", status: "done", label: "other" },
        ${JSON.stringify(`https://www.youtube.com/channel/${CHANNEL_ID_NO_EMBED}`)}: { name: "no embed", status: "done", label: "mandarin" },
      },
    });
  })()`);
});

// Moves the mouse every second for `seconds` seconds, which counts as user activity.
async function beActive(page, seconds) {
  for (let i = 0; i < seconds; i++) { await page.move(100 + (i % 2) * 40, 120); await sleep(1000); }
}
// Waits out the idle tail and the extension's 5-second flush, so all time is stored.
const settle = () => sleep((IDLE_SECONDS + 6.5) * 1000);
async function today() {
  const { log = {} } = await browser.storage(["log"]);
  return Object.values(log)[0] ?? {};
}
function near(actual, expected, label) {
  assert.ok(Math.abs((actual ?? 0) - expected) <= TOLERANCE, `${label}: recorded ${actual}s, expected ${expected}s`);
}

test("separates time per Claude chat, stops at the idle limit, follows in-app navigation", async () => {
  const page = await browser.open(`https://claude.ai/chat/${A}`);
  await beActive(page, 10);   // A: 10 s active, then IDLE_SECONDS more before it counts as idle
  await sleep(15000);         // idle
  // Switch chats inside the app, like clicking a sidebar link; the page text changes with it.
  await page.eval(`history.pushState({}, "", "/chat/${B}"); document.title = "Chat bbbb - Claude";
    document.getElementById("t").textContent = "Planning the project timeline and the order of tasks. ".repeat(5)`);
  await beActive(page, 8);    // B: 8 s active
  await settle();

  const day = await today();
  near(day.claude?.[A]?.seconds, 10 + IDLE_SECONDS, "chat A");
  near(day.claude?.[B]?.seconds, 8 + IDLE_SECONDS, "chat B");
  assert.equal(day.claude[A].title, "Chat aaaa");
  assert.ok(day.claude[A].share > 0.6, `chat A share ${day.claude[A].share}`);
  assert.ok(day.claude[B].share < 0.1, `chat B share ${day.claude[B].share}`);
});

test("switching chats mid-activity keeps each chat's own share and title", async () => {
  const page = await browser.open(`https://claude.ai/chat/${A}`);
  await beActive(page, 8);    // A: Chinese, 8 s, not yet flushed when we switch
  // The app swaps URL, title and text at once, like a sidebar click.
  await page.eval(`history.pushState({}, "", "/chat/${B}"); document.title = "Chat bbbb - Claude";
    document.getElementById("t").textContent = "Planning the project timeline and the order of tasks, which is a long English conversation. ".repeat(20)`);
  await beActive(page, 6);
  await settle();

  const day = await today();
  near(day.claude?.[A]?.seconds, 8, "chat A");
  near(day.claude?.[B]?.seconds, 6 + IDLE_SECONDS, "chat B");
  assert.ok(day.claude[A].share > 0.6, `chat A share ${day.claude[A].share}`);
  assert.equal(day.claude[A].title, "Chat aaaa");
  assert.ok(day.claude[B].share < 0.1, `chat B share ${day.claude[B].share}`);
});

test("time on pages that aren't a conversation doesn't go to the next chat", async () => {
  const page = await browser.open("https://claude.ai/recents");
  await beActive(page, 6);
  await page.eval(`history.pushState({}, "", "/chat/${A}")`);
  await beActive(page, 4);
  await settle();

  const day = await today();
  near(day.claude?._other?.seconds, 6, "recents page");
  near(day.claude?.[A]?.seconds, 4 + IDLE_SECONDS, "chat opened from recents");
});

test("doesn't count a chat tab in the background", async () => {
  const claude = await browser.open(`https://claude.ai/chat/${A}`);
  await beActive(claude, 5);
  const gpt = await browser.open(`https://chatgpt.com/c/${GPT}`); // new active tab; Claude goes to background
  await beActive(gpt, 12);
  await settle();

  const day = await today();
  // Claude's tab was hidden 5 s in, before its idle tail ran.
  near(day.claude?.[A]?.seconds, 5, "background Claude chat");
  near(day.chatgpt?.[GPT]?.seconds, 12 + IDLE_SECONDS, "ChatGPT chat");
  await gpt.activate(); // keep focus where the next test expects it
});

test("returning to a background tab resumes counting for that chat", async () => {
  const claude = await browser.open(`https://claude.ai/chat/${A}`);
  await beActive(claude, 4);
  const gpt = await browser.open(`https://chatgpt.com/c/${GPT}`);
  await beActive(gpt, 4);
  await claude.activate();
  await beActive(claude, 6);
  await settle();

  const day = await today();
  near(day.claude?.[A]?.seconds, 4 + 6 + IDLE_SECONDS, "Claude chat across two visits");
  near(day.chatgpt?.[GPT]?.seconds, 4, "ChatGPT chat in between");
});

test("time on a new chat goes to the conversation it becomes", async () => {
  const page = await browser.open("https://claude.ai/new");
  await beActive(page, 7);    // typing the first message; no chat ID yet
  await page.eval(`history.replaceState({}, "", "/chat/${C}")`);
  await beActive(page, 4);
  await settle();

  const day = await today();
  near(day.claude?.[C]?.seconds, 11 + IDLE_SECONDS, "new chat");
  assert.deepEqual(Object.keys(day.claude ?? {}), [C]);
});

test("YouTube counts playing time, including background tabs, excluding pauses, ads and mute", async () => {
  const yt = await browser.open(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  const video = (js) => yt.eval(`(() => { const v = document.querySelector("video"); ${js} })()`);
  await video("return v.play().then(() => true)");
  await sleep(8000);          // 8 s playing
  await video("v.pause()");
  await sleep(5000);          // paused
  await video("return v.play().then(() => true)");
  const other = await browser.open(`https://chatgpt.com/c/${GPT}`);
  await sleep(6000);          // 6 s playing in a background tab
  await yt.eval(`document.getElementById("movie_player").classList.add("ad-showing")`);
  await sleep(5000);          // ad
  await yt.eval(`document.getElementById("movie_player").classList.remove("ad-showing")`);
  await sleep(4000);          // 4 s playing
  await video("v.muted = true");
  await sleep(5000);          // muted
  await video("v.pause()");
  await sleep(6500);
  await other.activate();

  const day = await today();
  near(day.youtube?.[CHANNEL_URL]?.seconds, 8 + 6 + 4, "YouTube channel");
});

test("YouTube credits the video actually playing when it changes without a URL change (miniplayer)", async () => {
  const yt = await browser.open(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  await yt.eval(`document.querySelector("video").play().then(() => true)`);
  await sleep(7000);
  await yt.eval(`window.currentVideo = ${JSON.stringify(VIDEO_ID_2)}`); // next video, same URL
  await sleep(7000);
  await yt.eval(`document.querySelector("video").pause()`);
  await sleep(6500);

  const day = await today();
  near(day.youtube?.[CHANNEL_URL]?.seconds, 7, "first channel");
  near(day.youtube?.[CHANNEL_URL_2]?.seconds, 7, "second channel");
});

test("a tab open before the extension reloads keeps tracking, and isn't counted twice", async () => {
  const page = await browser.open(`https://claude.ai/chat/${A}`);
  await beActive(page, 6);
  await settle();                    // 6 s + idle tail, all stored before the reload
  await browser.reloadExtension();   // the reopened storage tab is now active; bring the chat back
  await page.activate();
  await sleep(1500);                 // the updated extension injects its scripts into open tabs
  await beActive(page, 8);
  await settle();

  const day = await today();
  // Counting twice (old and new script both running) would add another 8 + IDLE_SECONDS.
  near(day.claude?.[A]?.seconds, 6 + IDLE_SECONDS + 8 + IDLE_SECONDS, "chat across an extension reload");
});

test("YouTube gets the channel from the player when oEmbed refuses the video", async () => {
  const yt = await browser.open(`https://www.youtube.com/watch?v=${VIDEO_ID_NO_EMBED}`);
  await yt.eval(`window.playerDetails = { videoId: ${JSON.stringify(VIDEO_ID_NO_EMBED)}, channelId: ${JSON.stringify(CHANNEL_ID_NO_EMBED)}, author: "频道" }`);
  await yt.eval(`document.querySelector("video").play().then(() => true)`);
  await sleep(8000);
  await yt.eval(`document.querySelector("video").pause()`);
  await sleep(6500);

  const day = await today();
  near(day.youtube?.[`https://www.youtube.com/channel/${CHANNEL_ID_NO_EMBED}`]?.seconds, 8, "channel from player");
  assert.equal(day.youtube[`https://www.youtube.com/channel/${CHANNEL_ID_NO_EMBED}`].title, "频道");
  const { problems = [] } = await browser.storage(["problems"]);
  assert.deepEqual(problems, []);
});
