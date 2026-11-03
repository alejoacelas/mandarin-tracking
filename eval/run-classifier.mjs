// Runs the channel classifier on every channel in eval/ground-truth.json and compares its label
// with the label from the audio. The classifier gets exactly what the extension sees: YouTube's
// oEmbed data (channel name, channel URL, video title) for one of the channel's videos.
// Usage: node --env-file=.env eval/run-classifier.mjs [runs-per-channel] [--skip-done <earlier results file>]
// --skip-done runs only the channels with no successful run in that file, to finish an interrupted run.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { makeClient, classifyChannel } from "../src/classify.js";

const RUNS = Number(/^\d+$/.test(process.argv[2] ?? "") ? process.argv[2] : 1);
const CONCURRENCY = 8;
// Truth is the audio label, replaced by the adjudicated verdict where the two methods disagreed
// and a reviewer settled it (eval/adjudicated.json). Channels whose truth is "unknown" are skipped.
const adjudicated = Object.fromEntries(JSON.parse(await readFile("eval/adjudicated.json", "utf8")).map((a) => [a.url, a.verdict]));
const truth = JSON.parse(await readFile("eval/ground-truth.json", "utf8"))
  .filter((c) => !c.error)
  .map((c) => ({ ...c, audio_label: { ...c.audio_label, label: adjudicated[c.url] ?? c.audio_label.label } }))
  .filter((c) => c.audio_label.label !== "unknown");
const skipFile = process.argv.includes("--skip-done") ? process.argv[process.argv.indexOf("--skip-done") + 1] : null;
if (skipFile) {
  const done = new Set(JSON.parse(await readFile(skipFile, "utf8")).filter((r) => !r.error).map((r) => r.url));
  truth.splice(0, truth.length, ...truth.filter((c) => !done.has(c.url)));
}
const client = makeClient(process.env.ANTHROPIC_API_KEY);

async function oembed(videoId) {
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
  if (!r.ok) throw new Error(`oEmbed ${r.status}`);
  return r.json();
}

const jobs = [];
for (const c of truth) for (let k = 0; k < RUNS; k++) jobs.push({ c, k });
const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { c, k } = jobs[next++];
    // Use a different video per run so runs also vary the title the classifier sees.
    const videoId = [...new Set(c.clips.map((x) => x.videoId))][k % 3] ?? c.clips[0].videoId;
    const row = { name: c.name, url: c.url, category: c.category, truth: c.audio_label.label, share: c.audio_label.share, run: k };
    try {
      // Embed-disabled videos refuse oEmbed; the extension then has the channel from YouTube's
      // player, so fall back to the channel's name and URL without a title.
      const o = await oembed(videoId).catch(() => null);
      row.input = o ? { name: o.author_name, url: o.author_url, videoTitle: o.title } : { name: c.name.trim(), url: c.url };
      const t = Date.now();
      const r = await classifyChannel(client, row.input);
      Object.assign(row, { label: r.label, confidence: r.confidence, mandarin_share: r.mandarin_share, reason: r.reason, searches: r.searches, usage: r.usage, seconds: (Date.now() - t) / 1000 });
    } catch (e) {
      row.error = String(e).slice(0, 300);
    }
    results.push(row);
    const mark = row.error ? "ERR " : row.label === row.truth ? "ok  " : "MISS";
    console.log(`${mark} truth=${row.truth} got=${row.label ?? "-"} ${row.confidence ?? ""}\t${c.name}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Severity: confusing mandarin with other is a severe error (time counted or dropped wrongly);
// mixed vs a neighbour is minor; unknown is an abstention that shows up as unclassified time.
const severe = results.filter((r) => r.label && ((r.label === "mandarin" && r.truth === "other") || (r.label === "other" && r.truth === "mandarin")));
const minor = results.filter((r) => r.label && r.label !== r.truth && r.label !== "unknown" && !severe.includes(r));
const abstain = results.filter((r) => r.label === "unknown");
const errors = results.filter((r) => r.error);
const tokens = results.reduce((s, r) => s + (r.usage?.input_tokens ?? 0) * 4e-6 + (r.usage?.output_tokens ?? 0) * 20e-6, 0);
const searches = results.reduce((s, r) => s + (r.searches ?? 0), 0);
console.log(`\n${results.length} runs: ${results.length - severe.length - minor.length - abstain.length - errors.length} correct, ${severe.length} severe, ${minor.length} minor, ${abstain.length} unknown, ${errors.length} errors`);
console.log(`cost ≈ $${(tokens + searches * 0.01).toFixed(2)} (${searches} searches)`);
await mkdir("eval/results", { recursive: true });
const file = `eval/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(file, JSON.stringify(results, null, 2));
console.log(file);
