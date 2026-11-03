// Decides whether a YouTube channel's videos are spoken in Mandarin.
// Shared by the extension (background worker) and the eval harness (Node).
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";
export const LABELS = ["mandarin", "mixed", "other", "unknown"];

const SYSTEM = `You decide which language is spoken in a YouTube channel's videos, for someone tracking how much Mandarin they listen to.

Use web search (and web fetch on pages you find) to learn about the channel: who runs it, where they are from, what the videos are like, and above all what language the speech is in. Titles and descriptions are weak evidence: Cantonese, Taiwanese Hokkien, Japanese and English channels often have Chinese-character titles, and Mandarin channels sometimes have English titles. Look for evidence about the spoken audio: descriptions of the host, interviews, Wikipedia or Baidu entries, fan wikis, subtitles, comments that mention the language.

Labels:
- "mandarin": most of the speech (or sung vocals, for music) across the channel's videos is Mandarin Chinese, any accent (mainland, Taiwan, Singapore, Malaysia).
- "mixed": Mandarin is a large share of the speech but another language is too, e.g. a Mandarin-teaching channel that explains in English, or a bilingual vlog. Use this when roughly 25-75% of the speech is Mandarin.
- "other": little or no spoken Mandarin. This includes Cantonese, Hokkien, Shanghainese and other Chinese languages, English or other languages about China, and channels with no speech.
- "unknown": you could not find enough evidence to choose. Prefer this over a guess.

Decide from evidence, not from the script of the title. Keep searching until you are confident or out of leads.`;

const SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", enum: LABELS },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    mandarin_share: {
      type: "string",
      description: "Rough share of the speech that is Mandarin, e.g. '90%', '40%', '0%'.",
    },
    reason: { type: "string", description: "One or two sentences citing the evidence." },
  },
  required: ["label", "confidence", "mandarin_share", "reason"],
  additionalProperties: false,
};

export function makeClient(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 4 * 60_000 });
}

// channel: { name, url, videoTitle? }
// Returns { label, confidence, mandarin_share, reason, searches, usage }.
export async function classifyChannel(client, channel) {
  const lines = [
    `Channel name: ${channel.name}`,
    `Channel URL: ${channel.url}`,
  ];
  if (channel.videoTitle) lines.push(`Title of one of its videos: ${channel.videoTitle}`);

  const messages = [{ role: "user", content: lines.join("\n") }];
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: 8 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
  ];

  let response;
  let searches = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (let turn = 0; turn < 6; turn++) {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages,
      tools,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    });
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    searches += response.usage.server_tool_use?.web_search_requests ?? 0;
    if (response.stop_reason !== "pause_turn") break;
    // Server-side tool loop paused: resend so it resumes where it left off.
    messages.splice(1, messages.length - 1, { role: "assistant", content: response.content });
  }

  if (response.stop_reason === "refusal") {
    throw new Error(`Model declined to classify (${response.stop_details?.category ?? "no category"})`);
  }
  if (response.stop_reason !== "end_turn") {
    throw new Error(`Classification stopped early: ${response.stop_reason}`);
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).at(-1);
  const result = JSON.parse(text);
  if (!LABELS.includes(result.label)) throw new Error(`Bad label: ${result.label}`);
  return { ...result, searches, usage };
}
