// Runs in the page's own JavaScript world on youtube.com, where YouTube's player object is
// reachable. Publishes the audibly playing video's id, channel id, channel name and title as data
// attributes on <html>, which the extension's content script reads. This tells the miniplayer's
// next video or a channel trailer apart from the URL's video.
if (!window.__mtYoutubeMain) {
  window.__mtYoutubeMain = true;
  setInterval(() => {
    const root = document.documentElement;
    const v = [...document.querySelectorAll("video")].find((x) => !x.paused && !x.ended && !x.muted && x.volume > 0 && x.readyState > 2);
    if (!v) { root.dataset.mtPlaying = ""; return; }
    const player = v.closest(".html5-video-player");
    let data = null;
    let details = null;
    try { data = typeof player?.getVideoData === "function" ? player.getVideoData() : null; } catch { data = null; }
    try { details = typeof player?.getPlayerResponse === "function" ? player.getPlayerResponse()?.videoDetails : null; } catch { details = null; }
    root.dataset.mtPlaying = data?.video_id || "?";
    // Only trust channel details that belong to the same video.
    const same = !!details && details.videoId === data?.video_id;
    root.dataset.mtChannelId = (same && details.channelId) || "";
    root.dataset.mtChannelName = (same && details.author) || data?.author || "";
    root.dataset.mtVideoTitle = (same && details.title) || data?.title || "";
  }, 1000);
}
