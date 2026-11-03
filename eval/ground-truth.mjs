// Establishes each test channel's spoken language from its audio, independent of web evidence.
// For each channel: take its 3 most recent videos of 90s or longer, cut 30-second clips at 20%,
// 50% and 80% of each, and run SenseVoice (Mandarin/Cantonese/English/Japanese/Korean speech
// recognition with language ID) on every clip. SenseVoice has no label for Hokkien, Hakka or Wu
// and transcribes them as garbled Chinese, so an LLM then judges whether each "zh" transcript
// reads as fluent Mandarin.
// Usage: node --env-file=.env eval/ground-truth.mjs [channels.json] [out.json]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const run = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);
const channelsFile = process.argv[2] ?? "eval/channels.json";
const outFile = process.argv[3] ?? "eval/ground-truth.json";
// YouTube starts demanding sign-in after a burst of downloads, so go slowly.
const CONCURRENCY = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anthropic = new Anthropic();

async function listVideos(url) {
  const { stdout } = await run("yt-dlp", [
    "--flat-playlist", "--playlist-end", "8",
    "--print", "%(id)s\t%(duration)s",
    `${url.replace(/\/$/, "")}/videos`,
  ], { maxBuffer: 1 << 24 });
  return stdout.trim().split("\n").filter(Boolean)
    .map((l) => { const [id, d] = l.split("\t"); return { id, duration: Number(d) }; })
    .filter((v) => v.duration >= 90)
    .slice(0, 3);
}

async function download(dir, videoId, start, idx) {
  const base = path.join(dir, `c${idx}`);
  await run("yt-dlp", [
    "-q", "-f", "bestaudio", "--download-sections", `*${start}-${start + 30}`,
    "-o", `${base}.%(ext)s`, `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  const src = (await readdir(dir)).find((f) => f.startsWith(`c${idx}.`));
  await run("ffmpeg", ["-loglevel", "error", "-y", "-i", path.join(dir, src), "-ar", "16000", "-ac", "1", `${base}.wav`]);
  return { videoId, start, wav: `${base}.wav` };
}

async function senseVoice(wavs) {
  const { stdout } = await run("uv", [
    "run", "-q", "--python", "3.12", "--with", "sherpa-onnx", "--with", "numpy",
    "python", "-I", path.join(here, "lib/sensevoice.py"), ...wavs,
  ], { maxBuffer: 1 << 24 });
  const byFile = new Map(stdout.trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.file, r]));
  return wavs.map((w) => byFile.get(w));
}

// Asks whether each Chinese transcript is fluent Mandarin or a garbled rendering of another
// Chinese language. Returns one boolean per transcript.
async function fluentMandarin(texts) {
  if (!texts.length) return [];
  const list = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const res = await anthropic.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { fluent: { type: "array", items: { type: "boolean" } } },
          required: ["fluent"], additionalProperties: false,
        },
      },
    },
    messages: [{
      role: "user",
      content: `Each line is an automatic Mandarin speech-recognition transcript of a 30-second audio clip. When the audio is actually Taiwanese Hokkien, Hakka, Shanghainese or another non-Mandarin language, the transcript comes out as mostly meaningless strings of characters. When the audio is Mandarin, it reads as natural Mandarin, allowing for small recognition errors. For each line, answer true if it reads as Mandarin, false if it looks like a garbled rendering of another language. Return exactly ${texts.length} booleans in order.\n\n${list}`,
    }],
  });
  const text = res.content.find((b) => b.type === "text").text;
  const { fluent } = JSON.parse(text);
  if (fluent.length !== texts.length) throw new Error("fluency check returned wrong count");
  return fluent;
}

async function groundTruth(channel) {
  const dir = await mkdtemp(path.join(tmpdir(), "gt-"));
  try {
    const videos = await listVideos(channel.url);
    if (!videos.length) return { ...channel, error: "no videos of 90s or longer" };
    const settled = [];
    let i = 0;
    for (const v of videos) for (const f of [0.2, 0.5, 0.8]) {
      settled.push(await download(dir, v.id, Math.floor(v.duration * f), i++)
        .then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })));
      await sleep(3000);
    }
    if (settled.every((r) => r.status === "rejected")) throw settled[0].reason;
    const got = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const failed = settled.filter((r) => r.status === "rejected").length;
    const sv = got.length ? await senseVoice(got.map((g) => g.wav)) : [];
    const clips = got.map((g, k) => ({
      videoId: g.videoId, start: g.start,
      lang: sv[k].lang.replace(/[<|>]/g, ""), event: sv[k].event.replace(/[<|>]/g, ""),
      chars: sv[k].text.replace(/\s/g, "").length,
      text: sv[k].text.slice(0, 200),
    }));
    const zh = clips.filter((c) => c.lang === "zh" && c.chars >= 8);
    const fluent = await fluentMandarin(zh.map((c) => c.text));
    zh.forEach((c, k) => { c.fluent = fluent[k]; });
    return { ...channel, clips, failed_clips: failed, audio_label: decide(clips) };
  } catch (e) {
    return { ...channel, error: String(e).slice(0, 300) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A clip is speech when it has at least 8 transcribed characters. A speech clip counts as
// Mandarin when SenseVoice says zh and the transcript reads as fluent Mandarin.
function decide(clips) {
  if (clips.length < 4) return { label: "unknown", note: "too few clips" };
  const speech = clips.filter((c) => c.chars >= 8);
  const langs = speech.map((c) => (c.lang === "zh" && !c.fluent ? "zh?" : c.lang)).join(",");
  if (speech.length < clips.length / 3) return { label: "other", share: 0, langs, note: "mostly no speech" };
  const share = speech.filter((c) => c.lang === "zh" && c.fluent).length / speech.length;
  const label = share >= 0.75 ? "mandarin" : share > 0.25 ? "mixed" : "other";
  return { label, share: Math.round(share * 100) / 100, langs };
}

const channels = JSON.parse(await readFile(channelsFile, "utf8"));
const done = existsSync(outFile) ? JSON.parse(await readFile(outFile, "utf8")) : [];
const results = done.filter((d) => !d.error && d.clips.length >= 8);
const doneUrls = new Set(results.map((d) => d.url));
const todo = channels.filter((c) => !doneUrls.has(c.url));
let next = 0;
async function worker() {
  while (next < todo.length) {
    const c = todo[next++];
    const r = await groundTruth(c);
    results.push(r);
    console.log(`${r.audio_label?.label ?? "ERROR"}\t${r.audio_label?.share ?? ""}\t${r.audio_label?.langs ?? r.error ?? ""}\t${c.name}`);
    await writeFile(outFile, JSON.stringify(results, null, 2));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
