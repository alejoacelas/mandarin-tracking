// Background worker: stores credited time, resolves YouTube videos to channels, asks the LLM to
// classify new channels, and shows a red badge when something needs attention.
import { makeClient, classifyChannel } from "./classify.js";
import { ANTHROPIC_API_KEY } from "../extension/build/config.js";
import { localDay } from "./summary.js";
import { pollReader, IDLE_POLL_S } from "./readwise.js";
import { applyReaderEvents } from "./reader-sync.js";

// A "pending" classification older than this, with no call in progress in this worker, was
// interrupted by the worker stopping and gets retried.
const CLASSIFY_STALE_MS = 10 * 60_000;
const inFlight = new Set(); // channel URLs being classified by this worker instance
const oembedFailures = new Map(); // videoId -> time of last failure, to avoid refetching every 5 s
const MAX_CREDIT_SECONDS = 3600;

// All storage writes go through one queue so concurrent messages can't overwrite each other.
let queue = Promise.resolve();
function update(keys, fn) {
  const run = queue.then(async () => {
    const data = await chrome.storage.local.get(keys);
    const changed = await fn(data);
    if (changed) await chrome.storage.local.set(changed);
  });
  queue = run.catch((e) => console.error("storage update failed", e));
  return run;
}

async function addProblem(source, message, url) {
  await update(["problems"], ({ problems = [] }) => {
    const last = problems.at(-1);
    if (last && last.message === message && Date.now() - last.at < 3600_000) return null;
    return { problems: [...problems, { at: Date.now(), source, message, url }].slice(-50) };
  });
  await refreshBadge();
}

async function credit({ source, key, title, url, seconds, share, units }) {
  if (!(seconds > 0)) return;
  if (seconds > MAX_CREDIT_SECONDS) {
    await addProblem(source, `Got ${seconds} s in one report for ${title ?? key}; recorded ${MAX_CREDIT_SECONDS} s.`);
    seconds = MAX_CREDIT_SECONDS;
  }
  const day = localDay(new Date());
  await update(["log"], ({ log = {} }) => {
    const items = ((log[day] ??= {})[source] ??= {});
    const item = (items[key] ??= { seconds: 0 });
    item.seconds += seconds;
    if (title) item.title = title;
    if (url) item.url = url;
    if (share != null && units >= (item.units ?? 0) * 0.5) { item.share = share; item.units = units; }
    item.last = Date.now();
    return { log };
  });
}

async function resolveVideo(videoId) {
  const { videos = {} } = await chrome.storage.local.get("videos");
  if (videos[videoId]) return videos[videoId];
  if (videoId === "unknown") throw new Error("A video played with sound but its ID couldn't be found.");
  if (Date.now() - (oembedFailures.get(videoId) ?? 0) < 10 * 60_000) throw new Error(`Still can't look up the channel of video ${videoId}.`);
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
  if (!r.ok) { oembedFailures.set(videoId, Date.now()); throw new Error(`YouTube oEmbed returned ${r.status} for video ${videoId}`); }
  const o = await r.json();
  if (!o.author_url || !o.author_name) throw new Error(`YouTube oEmbed has no channel for video ${videoId}`);
  const info = { channelUrl: o.author_url, channelName: o.author_name, title: o.title };
  await update(["videos"], ({ videos = {} }) => ({ videos: { ...videos, [videoId]: info } }));
  return info;
}

async function creditVideo({ videoId, seconds }) {
  let info;
  try {
    info = await resolveVideo(videoId);
  } catch (e) {
    // Keep the time, visibly unresolved and under the video's ID, instead of dropping it.
    await credit({ source: "youtube", key: `video:${videoId}`, title: `Video ${videoId} (channel unknown)`, url: videoId === "unknown" ? undefined : `https://www.youtube.com/watch?v=${videoId}`, seconds });
    await addProblem("youtube", String(e.message ?? e));
    return;
  }
  await credit({ source: "youtube", key: info.channelUrl, title: info.channelName, url: info.channelUrl, seconds });
  ensureClassified(info); // runs on; the content script doesn't wait for it
}

async function ensureClassified({ channelUrl, channelName, title }) {
  if (inFlight.has(channelUrl)) return;
  let start = false;
  await update(["channels"], ({ channels = {} }) => {
    const c = channels[channelUrl];
    if (c && (c.status === "done" || (c.status === "pending" && Date.now() - c.since < CLASSIFY_STALE_MS))) return null;
    if (c?.status === "error" && !c.retry) return null;
    start = true;
    return { channels: { ...channels, [channelUrl]: { name: channelName, status: "pending", since: Date.now(), videoTitle: title } } };
  });
  if (!start) return;
  inFlight.add(channelUrl);
  try {
    const result = await classifyChannel(makeClient(ANTHROPIC_API_KEY), { name: channelName, url: channelUrl, videoTitle: title });
    await setChannel(channelUrl, { name: channelName, status: "done", at: Date.now(), ...pick(result, ["label", "confidence", "mandarin_share", "reason"]) });
  } catch (e) {
    await setChannel(channelUrl, { name: channelName, status: "error", at: Date.now(), error: String(e.message ?? e).slice(0, 300) });
    await addProblem("youtube", `Couldn't classify channel ${channelName}: ${String(e.message ?? e).slice(0, 200)}`);
  } finally {
    inFlight.delete(channelUrl);
  }
  await refreshBadge();
}

const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
async function setChannel(url, value) {
  await update(["channels"], ({ channels = {} }) => ({ channels: { ...channels, [url]: value } }));
}

export async function refreshBadge() {
  const { problems = [], seenProblemsAt = 0, channels = {} } = await chrome.storage.local.get(["problems", "seenProblemsAt", "channels"]);
  const unseen = problems.filter((p) => p.at > seenProblemsAt).length;
  const failed = Object.values(channels).filter((c) => c.status === "error" || (c.status === "pending" && Date.now() - c.since > CLASSIFY_STALE_MS)).length;
  const n = unseen + failed;
  await chrome.action.setBadgeText({ text: n ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

// Channels left "pending" when the worker was stopped mid-classification get retried.
async function resumeInterrupted() {
  const { channels = {}, videos = {} } = await chrome.storage.local.get(["channels", "videos"]);
  for (const [url, c] of Object.entries(channels)) {
    if (c.status === "pending" && Date.now() - c.since >= CLASSIFY_STALE_MS) {
      const title = c.videoTitle ?? Object.values(videos).find((v) => v.channelUrl === url)?.title;
      ensureClassified({ channelUrl: url, channelName: c.name, title });
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handle = {
    credit: () => (msg.source === "youtube" ? creditVideo(msg) : credit(msg)),
    problem: () => addProblem(msg.source, msg.message, msg.url),
    resume: async () => { await resumeInterrupted(); await ensureReaderAlarm(); },
    pollReader: async () => { await pollReaderOnce(); },
    reclassify: async () => {
      await setChannel(msg.channelUrl, { name: msg.name, status: "error", retry: true });
      const { videos = {} } = await chrome.storage.local.get("videos");
      const title = Object.values(videos).find((v) => v.channelUrl === msg.channelUrl)?.title;
      await ensureClassified({ channelUrl: msg.channelUrl, channelName: msg.name, title });
    },
    seenProblems: async () => { await chrome.storage.local.set({ seenProblemsAt: Date.now() }); await refreshBadge(); },
  }[msg.type];
  if (!handle) return false;
  handle().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) }));
  return true;
});

// Chrome doesn't put content scripts into tabs that were open before an install or update, so
// those tabs would track nothing until reloaded. Inject them now.
async function injectIntoOpenTabs() {
  for (const cs of chrome.runtime.getManifest().content_scripts) {
    const tabs = await chrome.tabs.query({ url: cs.matches });
    for (const tab of tabs) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js, world: cs.world ?? "ISOLATED" }).catch(() => {});
    }
  }
}

// Reader API polling, for reading done in Reader's phone apps. Runs only when a Readwise token
// is set in the popup's settings. Each poll says how long to wait before the next one.
const READER_ALARM = "reader-poll";
async function pollReaderOnce() {
  const { settings = {}, readerApi = {} } = await chrome.storage.local.get(["settings", "readerApi"]);
  if (!settings.readwiseToken) { await chrome.alarms.clear(READER_ALARM); return; }
  let delayS = IDLE_POLL_S;
  try {
    const r = await pollReader({ token: settings.readwiseToken, state: readerApi.state, lastEventAt: readerApi.lastEventAt ?? 0 });
    delayS = r.delayS;
    await update(["log", "readerApi"], ({ log = {}, readerApi: cur = {} }) => {
      const merged = applyReaderEvents({ log, events: cur.events ?? [], newEvents: r.events, docs: r.state.docs, now: Date.now() });
      const lastEventAt = Math.max(cur.lastEventAt ?? 0, ...r.events.map((e) => e.at));
      return { log: merged.log, readerApi: { state: r.state, events: merged.events, lastEventAt, lastPollAt: Date.now() } };
    });
  } catch (e) {
    if (e.retryAfterS) delayS = Math.max(delayS, e.retryAfterS);
    await addProblem("reader", `Reader API poll failed: ${String(e.message ?? e).slice(0, 200)}`);
  }
  await chrome.alarms.create(READER_ALARM, { delayInMinutes: Math.max(0.5, delayS / 60) });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === READER_ALARM) pollReaderOnce(); });
chrome.storage.onChanged.addListener((changes) => {
  const was = changes.settings?.oldValue?.readwiseToken;
  const now = changes.settings?.newValue?.readwiseToken;
  if (changes.settings && was !== now) pollReaderOnce();
});
async function ensureReaderAlarm() {
  if (!(await chrome.alarms.get(READER_ALARM))) pollReaderOnce();
}

chrome.runtime.onStartup.addListener(() => { resumeInterrupted(); refreshBadge(); ensureReaderAlarm(); });
chrome.runtime.onInstalled.addListener(() => { resumeInterrupted(); refreshBadge(); injectIntoOpenTabs(); ensureReaderAlarm(); });
