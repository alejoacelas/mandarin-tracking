// Runs in the page's own JavaScript world on youtube.com, where YouTube's player object is
// reachable. Publishes the ID of the video that is audibly playing as a data attribute on <html>,
// which the extension's content script reads. This is what tells the miniplayer's next video,
// or a channel page's trailer, apart from the URL's video.
setInterval(() => {
  const root = document.documentElement;
  const v = [...document.querySelectorAll("video")].find((x) => !x.paused && !x.ended && !x.muted && x.volume > 0 && x.readyState > 2);
  if (!v) { root.dataset.mtPlaying = ""; return; }
  const player = v.closest(".html5-video-player");
  const id = typeof player?.getVideoData === "function" ? player.getVideoData()?.video_id : null;
  root.dataset.mtPlaying = id || "?";
}, 1000);
