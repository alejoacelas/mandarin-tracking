// Loads the built extension into Chromium, drives local copies of the sites on a schedule, and
// checks what reaches a fake hub. Opens real browser windows, so run it on a machine you aren't
// using. Run with `npm run test:e2e`.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, sleep, VIDEO_ID, VIDEO_ID_2, CHANNELS, sites, ZH, EN } from "./harness.js";
import { seconds } from "./fakehub.js";

const IDLE = 6; // seconds without input before a chat stops counting
const TOL = 2.5; // seconds of allowed difference from the schedule

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // English
const C = "cccccccc-0000-4000-8000-000000000003";
const GPT = "6abb6a25-c3bc-83ed-9a17-e71dc2041f25";
const GPT_REDESIGNED = "dddddddd-c3bc-83ed-9a17-e71dc2041f25";

let browser;
let pages = [];
const open = async (url, opts) => { const p = await browser.open(url, opts); pages.push(p); return p; };

before(async () => { browser = await Browser.launch({ idleSeconds: IDLE }); });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  sites.claude = { status: 200, conversations: [] };
  sites.chatgpt = { signedIn: true, status: 200, conversations: [] };
  await browser.ctl.eval("chrome.storage.local.clear().then(() => true)");
  browser.hub.reset();
  await browser.configure({ idleSeconds: IDLE });
});
afterEach(async () => {
  for (const p of pages) await p.close().catch(() => {});
  pages = [];
  await sleep(300);
});

async function beActive(page, s) {
  for (let i = 0; i < s; i++) { await page.move(100 + (i % 2) * 40, 120); await sleep(1000); }
}
// Waits out the idle tail and a flush, then asks the worker to send everything.
async function settle() {
  await sleep((IDLE + 6) * 1000);
  await browser.pump();
}
const forConv = (id) => browser.hub.list((i) => i.conversation_id === id);
function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= TOL, `${label}: recorded ${actual} s, expected ${expected} s`);
}
// No two intervals of the same tab overlap (overlap would count time twice).
function noOverlap(intervals, label) {
  const s = [...intervals].sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].start_ms >= s[i - 1].end_ms - 50, `${label}: intervals overlap`);
}

test("pairs through pair-extension from a chrome-extension:// origin and sends a heartbeat", async () => {
  await browser.pump();
  const pair = browser.hub.pairs.at(-1);
  assert.match(pair.origin, /^chrome-extension:\/\//);
  assert.match(pair.body.device_name, /^Chrome/);
  assert.equal(pair.remote, "127.0.0.1");
  const hb = browser.hub.heartbeats.at(-1);
  assert.equal(hb.version, "1.0.0");
  assert.equal(hb.permissions["www.youtube.com"], true);
  assert.equal(hb.permissions["chatgpt.com"], true);
});

test("each Claude chat gets its own intervals and language; idle time stops counting; in-app navigation is followed", async () => {
  const page = await open(`https://claude.ai/chat/${A}`);
  await beActive(page, 10);
  await sleep(15000); // idle
  await page.eval(`history.pushState({}, "", "/chat/${B}"); document.title = "Chat bbbb - Claude";
    document.getElementById("t").textContent = ${JSON.stringify(EN)}; document.getElementById("u").textContent = "plan"`);
  await beActive(page, 8);
  await settle();

  const a = forConv(A), b = forConv(B);
  near(seconds(a), 10 + IDLE, "chat A");
  near(seconds(b), 8 + IDLE, "chat B");
  assert.ok(a.every((i) => i.language === "zh" && i.source === "llm" && i.app === "claude.ai" && i.title === "Chat aaaa"), JSON.stringify(a));
  assert.ok(a[0].zh_share > 0.9 && a[0].units > 20, "the sidebar's English isn't measured");
  assert.ok(b.every((i) => i.language === "other"), JSON.stringify(b));
  assert.equal(a[0].meta.measured, "content");
  assert.equal(a[0].url, `https://claude.ai/chat/${A}`);
});

test("a chat tab in the background doesn't count; coming back resumes; a second window only counts when focused", async () => {
  const claude = await open(`https://claude.ai/chat/${A}`);
  await beActive(claude, 5);
  const gpt = await open(`https://chatgpt.com/c/${GPT}`); // new active tab; Claude goes to the background
  await beActive(gpt, 6);
  await claude.activate();
  await beActive(claude, 5);
  await settle();

  near(seconds(forConv(A)), 5 + 5 + IDLE, "Claude across two visits");
  near(seconds(forConv(GPT)), 6, "ChatGPT in between");
  assert.ok(forConv(A).length >= 2, "the visits are separate intervals");
  const g = forConv(GPT)[0];
  assert.equal(g.app, "chatgpt.com");
  assert.equal(g.language, "zh");
});

test("time on a new chat goes to the conversation it becomes; pages that aren't chats don't count", async () => {
  const page = await open("https://claude.ai/recents");
  await beActive(page, 5);
  await page.eval(`history.pushState({}, "", "/new"); document.querySelector("main").innerHTML = "<textarea></textarea>"`);
  await beActive(page, 7);
  await page.eval(`history.replaceState({}, "", "/chat/${C}"); document.title = "Chat cccc - Claude";
    document.querySelector("main").innerHTML = '<div data-testid="user-message">' + ${JSON.stringify(ZH)} + '</div>'`);
  await beActive(page, 4);
  await settle();

  near(seconds(forConv(C)), 7 + 4 + IDLE, "new chat");
  assert.equal(browser.hub.list().length, forConv(C).length, "nothing for the recents page");
  assert.equal(forConv(C).at(-1).language, "zh");
});

test("YouTube counts audible playing time, in background tabs too, not pauses, ads or mute; pauses split intervals", async () => {
  const yt = await open(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  const video = (js) => yt.eval(`(() => { const v = document.querySelector("video"); ${js} })()`);
  await video("return v.play().then(() => true)");
  await sleep(8000);
  await video("v.pause()");
  await sleep(5000);
  await video("return v.play().then(() => true)");
  const other = await open(`https://claude.ai/recents`);
  await sleep(6000); // playing in a background tab
  await yt.eval(`document.getElementById("movie_player").classList.add("ad-showing")`);
  await sleep(5000);
  await yt.eval(`document.getElementById("movie_player").classList.remove("ad-showing")`);
  await sleep(4000);
  await video("v.muted = true");
  await sleep(5000);
  await video("v.pause()");
  await sleep(6500);
  await browser.pump();
  void other;

  const ivs = browser.hub.list((i) => i.source === "youtube");
  near(seconds(ivs), 8 + 6 + 4, "YouTube");
  assert.ok(ivs.length >= 3, `pause and ad split the time: ${ivs.length} intervals`);
  noOverlap(ivs, "YouTube");
  for (const i of ivs) {
    assert.equal(i.language, "unknown");
    assert.equal(i.video_id, VIDEO_ID);
    assert.equal(i.channel_id, CHANNELS[VIDEO_ID].channelId);
    assert.equal(i.channel_name, CHANNELS[VIDEO_ID].author);
    assert.equal(i.app, "www.youtube.com");
    assert.equal(i.meta.video_id_from, "player");
  }
});

test("YouTube credits the video actually playing when it changes without a URL change (miniplayer)", async () => {
  const yt = await open(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  await yt.eval(`document.querySelector("video").play().then(() => true)`);
  await sleep(7000);
  await yt.eval(`window.currentVideo = ${JSON.stringify(VIDEO_ID_2)}`);
  await sleep(7000);
  await yt.eval(`document.querySelector("video").pause()`);
  await sleep(6500);
  await browser.pump();

  near(seconds(browser.hub.list((i) => i.video_id === VIDEO_ID)), 7, "first video");
  const second = browser.hub.list((i) => i.video_id === VIDEO_ID_2);
  near(seconds(second), 7, "second video");
  assert.equal(second[0].channel_id, CHANNELS[VIDEO_ID_2].channelId);
});

test("YouTube without channel details from the player sends the video id and reports a problem", async () => {
  const yt = await open(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  await yt.eval(`window.hideChannel = true; document.querySelector("video").play().then(() => true)`);
  await sleep(13000);
  await yt.eval(`document.querySelector("video").pause()`);
  await sleep(6500);
  await browser.pump();
  const ivs = browser.hub.list((i) => i.source === "youtube");
  near(seconds(ivs), 13, "video without channel");
  assert.equal(ivs[0].channel_id, null);
  assert.equal(ivs[0].video_id, VIDEO_ID);
  assert.ok(browser.hub.problems.some((p) => p.component === "extension.youtube" && /channel/.test(p.message)), JSON.stringify(browser.hub.problems));
});

test("Reader counts reading time per document with the document's language", async () => {
  const page = await open("https://read.readwise.io/new/read/01m6gr06yps2ws7rzt6fs3szh2");
  await beActive(page, 9);
  await settle();
  const ivs = browser.hub.list((i) => i.source === "reader");
  near(seconds(ivs), 9 + IDLE, "Reader");
  assert.equal(ivs[0].doc_id, "01m6gr06yps2ws7rzt6fs3szh2");
  assert.equal(ivs[0].language, "zh");
  assert.equal(ivs[0].title, "远程工作");
  assert.equal(ivs[0].conversation_id, null);
});

test("a chat page whose markup changed is measured from the page, marked in meta, and reported", async () => {
  const page = await open(`https://chatgpt.com/c/${GPT_REDESIGNED}`);
  await beActive(page, 14);
  await settle();
  const ivs = forConv(GPT_REDESIGNED);
  assert.ok(ivs.length >= 1);
  assert.ok(ivs.every((i) => i.meta.measured === "page"), JSON.stringify(ivs.map((i) => i.meta)));
  assert.equal(ivs.at(-1).language, "zh", "the sidebar inside <nav> is left out");
  const p = browser.hub.problems.find((x) => x.component === "extension.llm.chatgpt.com");
  assert.ok(p && /layout may have changed/.test(p.message), JSON.stringify(browser.hub.problems));
});

test("while the hub is down, intervals wait in the outbox and the popup says so; they arrive when it's back", async () => {
  await browser.pump(); // paired
  await browser.hub.stop();
  const page = await open(`https://claude.ai/chat/${A}`);
  await beActive(page, 10);
  await sleep((IDLE + 6) * 1000);
  await browser.pump();
  const st = await browser.message({ type: "status" });
  assert.ok(st.counts.intervals >= 1, JSON.stringify(st.counts));
  assert.equal(st.hubStatus.ok, false);
  assert.equal(st.hubStatus.kind, "unreachable");
  const popup = await open(`chrome-extension://${browser.extId}/popup.html`);
  await sleep(1500);
  assert.match(await popup.eval(`document.getElementById("hub").textContent`), /not answering/);
  assert.match(await popup.eval(`document.getElementById("outbox").textContent`), /interval/);

  await browser.hub.start();
  await browser.pump();
  near(seconds(forConv(A)), 10 + IDLE, "chat sent after the hub came back");
  const st2 = await browser.message({ type: "status" });
  assert.equal(st2.counts.intervals, 0);
  assert.equal(st2.hubStatus.ok, true);
});

test("when the hub forgets the token, the extension pairs again without counting any time twice", async () => {
  const page = await open(`https://claude.ai/chat/${A}`);
  await beActive(page, 8);
  await browser.pump(); // part of the running interval reaches the hub
  assert.ok(seconds(forConv(A)) > 0);
  browser.hub.forgetTokens();
  await beActive(page, 8);
  await settle();

  assert.equal(browser.hub.pairs.length, 2);
  const devices = new Set(forConv(A).map((i) => i.device));
  assert.equal(devices.size, 2, "time after re-pairing is under the new device");
  near(seconds(forConv(A)), 16 + IDLE, "chat across re-pairing");
  noOverlap(forConv(A), "chat across re-pairing");
});

test("killing the service worker repeatedly loses no time and counts none twice", async () => {
  const page = await open(`https://claude.ai/chat/${A}`);
  for (let k = 0; k < 3; k++) {
    await beActive(page, 6);
    const killed = await browser.killWorker();
    assert.ok(killed, "worker stopped");
  }
  await beActive(page, 4);
  await settle();
  near(seconds(forConv(A)), 22 + IDLE, "chat across worker restarts");
  noOverlap(forConv(A), "chat across worker restarts");
});

test("reloading the extension mid-session keeps tracking open tabs without counting twice", async () => {
  const page = await open(`https://claude.ai/chat/${A}`);
  await beActive(page, 7); // not yet flushed when the reload happens
  await browser.reloadExtension();
  await browser.configure({ idleSeconds: IDLE });
  await page.activate();
  await sleep(1500);
  await beActive(page, 8);
  await settle();
  near(seconds(forConv(A)), 1.5 + 7 + 8 + IDLE, "chat across an extension reload");
  noOverlap(forConv(A), "chat across an extension reload");
});

test("a frozen page (like a sleeping laptop) leaves a gap instead of counting the frozen time", async () => {
  const yt = await open(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  await yt.eval(`document.querySelector("video").play().then(() => true)`);
  await sleep(6000);
  await yt.lifecycle("frozen");
  await sleep(30000);
  await yt.lifecycle("active");
  await sleep(6000);
  await yt.eval(`document.querySelector("video").pause()`);
  await sleep(6500);
  await browser.pump();
  const ivs = browser.hub.list((i) => i.source === "youtube");
  const total = seconds(ivs);
  // 12 s of play; at most 15 s of the frozen stretch can count (MAX_STRETCH_MS).
  assert.ok(total >= 12 - TOL && total <= 12 + 15 + TOL, `recorded ${total} s`);
  noOverlap(ivs, "frozen page");
});

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test("chat history: imports per-message data without text, then only what changed", async () => {
  sites.claude.conversations = [
    { uuid: "cl-1", updated_at: iso(60_000), messages: [
      { uuid: "cl-1-a", sender: "human", created_at: iso(120_000), text: ZH },
      { uuid: "cl-1-b", sender: "assistant", created_at: iso(60_000), text: EN }] },
    { uuid: "cl-old", updated_at: iso(40 * 86_400_000), messages: [{ uuid: "cl-old-a", sender: "human", created_at: iso(40 * 86_400_000), text: ZH }] },
  ];
  sites.chatgpt.conversations = [
    { id: "gp-1", update_time: iso(30_000), messages: [{ id: "gp-1-a", role: "user", create_time: (Date.now() - 30_000) / 1000, text: ZH }] },
  ];
  await browser.message({ type: "syncHistory" });
  await browser.pump();
  const msgs = [...browser.hub.messages.values()];
  assert.deepEqual(msgs.map((m) => m.message_id).sort(), ["cl-1-a", "cl-1-b", "gp-1-a"]);
  const a = browser.hub.messages.get("claude|cl-1-a");
  assert.deepEqual(Object.keys(a).sort(), ["at_ms", "conversation_id", "message_id", "role", "service", "units", "zh_share"]);
  assert.equal(a.role, "user");
  assert.equal(a.zh_share, 1);
  assert.equal(browser.hub.messages.get("claude|cl-1-b").zh_share, 0);
  assert.equal(browser.hub.messages.get("chatgpt|gp-1-a").conversation_id, "gp-1");
  assert.ok(sites.requests.some((r) => r.host === "claude.ai" && r.path === "/api/organizations"));

  // A new message in one conversation: only that conversation is fetched again.
  sites.requests.length = 0;
  sites.claude.conversations[0].updated_at = iso(0);
  sites.claude.conversations[0].messages.push({ uuid: "cl-1-c", sender: "human", created_at: iso(0), text: ZH });
  await browser.message({ type: "syncHistory" });
  await browser.pump();
  assert.ok(browser.hub.messages.has("claude|cl-1-c"));
  assert.equal(sites.requests.filter((r) => /chat_conversations\/[\w-]+$/.test(r.path)).length, 1);
  assert.equal(sites.requests.filter((r) => r.path.startsWith("/backend-api/conversation/")).length, 0);
});

test("chat history: signing out after a good import is a problem; signing back in resolves it", async () => {
  await browser.message({ type: "syncHistory" }); // both services work (no conversations)
  sites.claude.status = 403;
  sites.chatgpt.signedIn = false;
  await browser.message({ type: "syncHistory" });
  await browser.pump();
  const comps = Object.fromEntries(browser.hub.problems.map((p) => [p.component, p.message]));
  assert.match(comps["extension.history.claude"] ?? "", /Signed out of claude\.ai/);
  assert.match(comps["extension.history.chatgpt"] ?? "", /Signed out of chatgpt\.com/);
  const st = await browser.message({ type: "status" });
  assert.equal(st.historyStatus.claude.signed_in, false);

  // Signed in again.
  sites.claude.status = 200;
  sites.chatgpt.signedIn = true;
  sites.claude.conversations = [{ uuid: "x", updated_at: iso(0), messages: [] }];
  sites.chatgpt.conversations = [];
  await browser.message({ type: "syncHistory" });
  await browser.pump();
  assert.ok(browser.hub.problems.some((p) => p.component === "extension.history.chatgpt" && p.resolved), "chatgpt resolved");
  assert.ok(browser.hub.problems.some((p) => p.component === "extension.history.claude" && p.resolved), "claude resolved");
});

test("popup shows today's minutes from the hub, problems and a dashboard link; the badge shows minutes", async () => {
  browser.hub.summaryMinutes = 42;
  await browser.pump();
  const badge = await browser.ctl.eval("chrome.action.getBadgeText({})");
  assert.equal(badge, "42m");
  await browser.message({ type: "problem", component: "extension.reader", message: "Test problem shown in the popup" });
  const popup = await open(`chrome-extension://${browser.extId}/popup.html`);
  await sleep(1500);
  assert.equal(await popup.eval(`document.getElementById("total").textContent`), "42m");
  assert.match(await popup.eval(`document.getElementById("problems").textContent`), /Test problem/);
  assert.equal(await popup.eval(`document.getElementById("dashboard").href`), `${browser.hub.url}/`);
  assert.equal(await browser.ctl.eval("chrome.action.getBadgeText({})"), "42!");
  assert.ok(browser.hub.problems.some((p) => p.component === "extension.reader"), "problem sent to the hub");
});
