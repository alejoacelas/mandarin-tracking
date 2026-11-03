// Runs in the page's own JavaScript world on youtube.com, where YouTube's player object is
// reachable. Publishes the audibly playing video's ID, channel ID, channel name and title as
// data attributes on <html>, which the extension's content script reads. This tells the
// miniplayer's next video or a channel trailer apart from the URL's video, and gives the channel
// even for videos whose embedding is disabled (where YouTube's oEmbed lookup refuses).
setInterval(() => {
  const root = document.documentElement;
  const v = [...document.querySelectorAll("video")].find((x) => !x.paused && !x.ended && !x.muted && x.volume > 0 && x.readyState > 2);
  if (!v) { root.dataset.mtPlaying = ""; return; }
  const player = v.closest(".html5-video-player");
  const data = typeof player?.getVideoData === "function" ? player.getVideoData() : null;
  const details = typeof player?.getPlayerResponse === "function" ? player.getPlayerResponse()?.videoDetails : null;
  root.dataset.mtPlaying = data?.video_id || "?";
  // Only trust channel details that belong to the same video.
  const same = details?.videoId === data?.video_id;
  root.dataset.mtChannelId = (same && details?.channelId) || "";
  root.dataset.mtChannelName = (same && details?.author) || "";
  root.dataset.mtVideoTitle = data?.title || "";
}, 1000);
