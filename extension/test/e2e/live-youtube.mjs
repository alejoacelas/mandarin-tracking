// Live check on real youtube.com (no sign-in needed): plays a Mandarin video and an English one
// and prints the intervals that reach the hub (a fake hub unless HUB=real).
// Usage: node test/e2e/live-youtube.mjs
import { Browser, sleep } from "./harness.js";

const VIDEOS = [
  ["SHWjQrGb3MQ", "Mandarin (老高與小茉)"],
  ["dQw4w9WgXcQ", "English (Rick Astley)"],
];
const PLAY_S = 40;

const b = await Browser.launch({ live: true, hub: process.env.HUB === "real" ? null : undefined });
const out = [];
try {
  for (const [id, label] of VIDEOS) {
    const p = await b.open(`https://www.youtube.com/watch?v=${id}`);
    await sleep(3000);
    // EU/UK cookie consent (a dialog over the player, or its own page): choose "Reject all".
    const rejected = await p.eval(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /^\\s*reject all\\s*$/i.test(x.textContent)); b?.click(); return !!b; })()`);
    if (rejected) { await sleep(3000); await p.eval("location.reload()").catch(() => {}); await sleep(6000); }
    const started = await p.eval(`(async () => { const v = document.querySelector("video"); if (!v) return "no video"; v.muted = false; v.volume = 1;
      return v.play().then(() => "playing", (e) => String(e)); })()`);
    const page = await p.eval(`JSON.stringify({ title: document.title, text: document.body.innerText.slice(0, 200) })`);
    const seen = [];
    for (let i = 0; i < PLAY_S; i += 5) {
      await sleep(5000);
      seen.push(await p.eval(`JSON.stringify({ ad: !!document.querySelector(".ad-showing"), playing: document.documentElement.dataset.mtPlaying, paused: document.querySelector("video")?.paused })`));
    }
    await p.eval(`document.querySelector("video")?.pause()`);
    await sleep(6500);
    await b.pump();
    const ivs = b.hub ? b.hub.list((i) => i.source === "youtube" && i.video_id === id) : [];
    out.push({ label, id, started, page: JSON.parse(page), states: seen.map((s) => JSON.parse(s)), seconds: ivs.reduce((t, i) => t + (i.end_ms - i.start_ms) / 1000, 0),
      intervals: ivs.map((i) => ({ s: (i.end_ms - i.start_ms) / 1000, channel_id: i.channel_id, channel_name: i.channel_name, title: i.title, language: i.language, from: i.meta?.video_id_from })) });
    await p.close();
  }
  const st = await b.message({ type: "status" });
  out.push({ problems: st.problems, hubProblems: b.hub?.problems, outbox: st.counts, hubStatus: st.hubStatus,
    // With the real hub, its summary shows what it made of the time.
    summary: b.hub ? undefined : st.summary?.days?.at(-1)?.items?.filter((i) => i.source === "youtube" && i.device?.startsWith("Chrome")) });
} finally {
  console.log(JSON.stringify(out, null, 2));
  await b.close();
}
