// Checks the extension on the real youtube.com, including a real LLM classification of the
// channel. Needs a build with a real API key. Opens a browser window; run it on a spare machine.
// Usage: node test/e2e/live-youtube.mjs [videoId]
import { Browser, sleep } from "./harness.js";

const videoId = process.argv[2] ?? "dQw4w9WgXcQ";
const b = await Browser.launch({ live: true });
try {
  const yt = await b.open(`https://www.youtube.com/watch?v=${videoId}`);
  // YouTube's cookie-consent page in the UK/EU: decline non-essential cookies.
  for (let i = 0; i < 20; i++) {
    const href = await yt.eval("location.href");
    if (href.includes("consent.youtube.com")) {
      await yt.eval(`[...document.querySelectorAll("button")].find((x) => /reject all/i.test(x.textContent))?.click()`);
      await sleep(3000);
    } else if (await yt.eval(`!!document.querySelector("video")`)) break;
    await sleep(1000);
  }
  const state = () => yt.eval(`(() => { const v = document.querySelector("#movie_player video") ?? document.querySelector("video");
    return v && { t: v.currentTime, paused: v.paused, muted: v.muted, rate: v.playbackRate, ad: !!document.querySelector(".ad-showing") }; })()`);
  await yt.eval(`(() => { const v = document.querySelector("#movie_player video"); v.muted = false; v.volume = 0.05; return v.play().then(() => true, (e) => String(e)); })()`);
  // Sample playback once a second to know how much non-ad, unmuted playing time really happened.
  let expected = 0;
  let prev = await state();
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const s = await state();
    if (s && prev && !s.paused && !s.muted && !s.ad && !prev.ad) expected += 1;
    prev = s;
  }
  await yt.eval(`document.querySelector("#movie_player video").pause()`);
  await sleep(7000);
  // Classification can take up to a minute or two.
  let data;
  for (let i = 0; i < 40; i++) {
    data = await b.storage(["log", "channels", "problems", "videos"]);
    const ch = Object.values(data.channels ?? {})[0];
    if (ch && ch.status !== "pending") break;
    await sleep(3000);
  }
  const day = Object.values(data.log ?? {})[0] ?? {};
  console.log(JSON.stringify({ expectedSeconds: expected, youtube: day.youtube, channels: data.channels, videos: data.videos, problems: data.problems }, null, 2));
} finally {
  await b.close();
}
