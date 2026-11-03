// Content script for youtube.com. Credits seconds while a video plays with sound and no ad is
// showing, whether or not the tab is in front. The background worker turns the video ID into a
// channel and the channel into a language label.
import { EngagementTimer } from "../timer.js";
import { send, reportProblem } from "./messaging.js";

const FLUSH_MS = 5000;
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

let videoId = videoIdFromUrl(); // kept when the miniplayer carries a video onto another page
let pageWithoutVideoSince = null;
let problemReported = false;

function flush() {
  const seconds = timer.take();
  if (seconds > 0 && videoId) send({ type: "credit", source: "youtube", videoId, seconds });
}

setInterval(() => {
  const fromUrl = videoIdFromUrl();
  if (fromUrl && fromUrl !== videoId) { flush(); videoId = fromUrl; }

  const playing = !!audibleVideo();
  const ad = !!document.querySelector(".ad-showing");
  timer.set({ playing, ad });

  // A watch page with no video element at all means YouTube's page changed under us.
  if (fromUrl && !document.querySelector("video")) {
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
