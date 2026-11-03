// Background worker: stores credited time, resolves YouTube videos to channels, asks the LLM to
// classify new channels, and shows a red badge when something needs attention.
import { makeClient, classifyChannel } from "./classify.js";
import { ANTHROPIC_API_KEY } from "../extension/build/config.js";
import { localDay } from "./summary.js";

const CLASSIFY_STALE_MS = 3 * 60_000; // a "pending" classification older than this was interrupted

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
  if (!(seconds > 0 && seconds < 3600)) return;
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
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
  if (!r.ok) throw new Error(`YouTube oEmbed returned ${r.status} for video ${videoId}`);
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
    // Keep the time, visibly unresolved, instead of dropping it.
    await credit({ source: "youtube", key: "unresolved", title: "Videos whose channel couldn't be looked up", seconds });
    await addProblem("youtube", String(e.message ?? e));
    return;
  }
  await credit({ source: "youtube", key: info.channelUrl, title: info.channelName, url: info.channelUrl, seconds });
  await ensureClassified(info);
}

async function ensureClassified({ channelUrl, channelName, title }) {
  let start = false;
  await update(["channels"], ({ channels = {} }) => {
    const c = channels[channelUrl];
    if (c && (c.status === "done" || (c.status === "pending" && Date.now() - c.since < CLASSIFY_STALE_MS))) return null;
    if (c?.status === "error" && !c.retry) return null;
    start = true;
    return { channels: { ...channels, [channelUrl]: { name: channelName, status: "pending", since: Date.now(), videoTitle: title } } };
  });
  if (!start) return;
  try {
    const result = await classifyChannel(makeClient(ANTHROPIC_API_KEY), { name: channelName, url: channelUrl, videoTitle: title });
    await setChannel(channelUrl, { name: channelName, status: "done", at: Date.now(), ...pick(result, ["label", "confidence", "mandarin_share", "reason"]) });
  } catch (e) {
    await setChannel(channelUrl, { name: channelName, status: "error", at: Date.now(), error: String(e.message ?? e).slice(0, 300) });
    await addProblem("youtube", `Couldn't classify channel ${channelName}: ${String(e.message ?? e).slice(0, 200)}`);
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
  const failed = Object.values(channels).filter((c) => c.status === "error").length;
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

chrome.runtime.onStartup.addListener(() => { resumeInterrupted(); refreshBadge(); });
chrome.runtime.onInstalled.addListener(() => { resumeInterrupted(); refreshBadge(); });
