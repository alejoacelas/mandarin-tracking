// Content script for youtube.com. Credits seconds while a video plays with sound and no ad is
// showing, whether or not the tab is in front. The background worker turns the video ID into a
// channel and the channel into a language label.
import { EngagementTimer } from "../timer.js";
import { send, reportProblem, claimPage } from "./messaging.js";

const FLUSH_MS = 5000;
const alive = claimPage("mtYoutube");
const timer = new EngagementTimer({ mode: "video" });

function videoIdFromUrl() {
  const u = new URL(location.href);
  if (u.pathname === "/watch") return u.searchParams.get("v");
  return u.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/)?.[1] ?? null;
}

// Any unmuted, playing video counts. Muted autoplay previews on the home page don't.
function audibleVideo() {
  return [...document.querySelectorAll("video")].find((v) => !v.paused && !v.ended && !v.muted && v.volume > 0 && v.readyState > 2);
}

// The playing video's ID comes from YouTube's player (published by youtube-main.js). If that's
// unavailable, the URL's video ID is used and a problem is reported once, since the miniplayer
// and channel trailers would then be attributed to the wrong video.
let playerApiProblem = false;
function playingVideoId() {
  const fromPlayer = document.documentElement.dataset.mtPlaying;
  if (fromPlayer && fromPlayer !== "?") return fromPlayer;
  if (fromPlayer === "?" && !playerApiProblem) {
    playerApiProblem = true;
    reportProblem("youtube", "YouTube's player didn't report which video is playing; using the URL instead, which can credit the miniplayer's videos to the wrong channel.");
  }
  return videoIdFromUrl();
}

let videoId = null; // video the pending seconds belong to
let pageWithoutVideoSince = null;
let problemReported = false;

async function flush() {
  if (!alive()) return;
  const seconds = timer.take();
  if (seconds <= 0) return;
  // No ID at all: keep the time, visibly, rather than drop it.
  const ok = await send({ type: "credit", source: "youtube", videoId: videoId ?? "unknown", seconds });
  if (!ok) timer.giveBack(seconds);
}

setInterval(() => {
  if (!alive()) return;
  const playing = !!audibleVideo();
  const ad = !!document.querySelector(".ad-showing");
  if (playing && !ad) {
    const id = playingVideoId();
    if (id !== videoId) { flush(); videoId = id; }
  }
  timer.set({ playing, ad });

  // A watch page with no video element at all means YouTube's page changed under us.
  if (videoIdFromUrl() && !document.querySelector("video")) {
    pageWithoutVideoSince ??= Date.now();
    if (!problemReported && Date.now() - pageWithoutVideoSince > 15000) {
      reportProblem("youtube", "A watch page has no video element after 15 seconds; YouTube's page may have changed.");
      problemReported = true;
    }
  } else {
    pageWithoutVideoSince = null;
  }
}, 1000);

setInterval(flush, FLUSH_MS);
addEventListener("pagehide", flush);
