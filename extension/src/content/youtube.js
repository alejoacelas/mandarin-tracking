// Content script for youtube.com. Counts time while a video plays with sound and no ad shows,
// whether or not the tab is in front, and reports it with the video and channel. The hub works
// out each channel's language, so every YouTube interval has language "unknown".
import { EngagementTimer } from "../lib/timer.js";
import { Page, reportProblem, resolveProblem } from "./messaging.js";

const COMPONENT = "extension.youtube";
const FLUSH_MS = 5000;

const page = new Page("youtube");
const timer = new EngagementTimer({ mode: "video" });

function videoIdFromUrl() {
  const u = new URL(location.href);
  if (u.pathname === "/watch") return u.searchParams.get("v");
  return u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1] ?? null;
}

// Any unmuted, playing video counts. Muted autoplay previews on the home page don't.
function audibleVideo() {
  return [...document.querySelectorAll("video")].find((v) => !v.paused && !v.ended && !v.muted && v.volume > 0 && v.readyState > 2);
}

const reported = new Set();
function problemOnce(key, message) {
  if (reported.has(key)) return;
  reported.add(key);
  reportProblem(COMPONENT, message);
}

// The playing video comes from YouTube's player (published by youtube-main.js). Without it, the
// URL's video is used, marked in meta, and a problem is reported, since the miniplayer and channel
// trailers would then be attributed to the wrong video.
function describePlaying() {
  const d = document.documentElement.dataset;
  let id = d.mtPlaying && d.mtPlaying !== "?" ? d.mtPlaying : null;
  let idFrom = "player";
  if (!id) {
    id = videoIdFromUrl();
    idFrom = id ? "url" : "none";
    problemOnce("player", "YouTube's player didn't say which video is playing; using the page address instead, which can credit the miniplayer's videos to the wrong channel.");
  }
  const fromPlayer = idFrom === "player";
  return {
    source: "youtube",
    app: location.hostname,
    language: "unknown",
    zh_share: null,
    units: null,
    video_id: id,
    channel_id: (fromPlayer && d.mtChannelId) || null,
    channel_name: (fromPlayer && d.mtChannelName) || null,
    title: (fromPlayer && d.mtVideoTitle) || null,
    conversation_id: null,
    doc_id: null,
    url: id ? `https://www.youtube.com/watch?v=${id}` : null,
    meta: { video_id_from: idFrom },
  };
}

let desc = null; // what the timer's pending spans belong to
let playingSince = null;
let watchPageWithoutVideoSince = null;
let resolvedOnce = false;

function tick() {
  if (!page.owns()) {
    page.handOff(desc, timer.take());
    clearInterval(ticker);
    clearInterval(flusher);
    return;
  }
  page.adoptHandoff();
  const playing = !!audibleVideo();
  const ad = !!document.querySelector(".ad-showing, .ad-interrupting");
  if (playing && !ad) {
    const next = describePlaying();
    if (desc && next.video_id !== desc.video_id) page.push(desc, timer.take());
    if (!desc || next.video_id !== desc.video_id) playingSince = Date.now();
    desc = next;
    if (!next.channel_id && Date.now() - playingSince > 10_000) {
      problemOnce("channel", "YouTube's player didn't give the channel of a playing video for 10 seconds; its time is sent with the video id only.");
    } else if (next.channel_id && next.meta.video_id_from === "player" && !resolvedOnce) {
      resolvedOnce = true;
      if (!reported.size) resolveProblem(COMPONENT);
    }
  }
  timer.set({ playing, ad });

  // A watch page with no video element at all means YouTube's page changed under us.
  if (videoIdFromUrl() && !document.querySelector("video")) {
    watchPageWithoutVideoSince ??= Date.now();
    if (Date.now() - watchPageWithoutVideoSince > 15_000) problemOnce("novideo", "A YouTube watch page has had no video element for 15 seconds; YouTube's page may have changed.");
  } else {
    watchPageWithoutVideoSince = null;
  }
}

function flush() {
  if (page.stopped) return;
  page.push(desc, timer.take());
  page.flush();
}

const ticker = setInterval(tick, 1000);
const flusher = setInterval(flush, FLUSH_MS);
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", flush);
