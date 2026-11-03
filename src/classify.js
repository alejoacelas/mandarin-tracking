// Decides whether a YouTube channel's videos are spoken in Mandarin.
// Shared by the extension (background worker) and the eval harness (Node).
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";
export const LABELS = ["mandarin", "mixed", "other", "unknown"];

const SYSTEM = `You decide which language is spoken in a YouTube channel's current videos, for someone tracking how much Mandarin they listen to.

Always search before answering, even for a channel you think you know: different channels share names, and channels change language over time. Confirm that what you find is about this exact channel (its URL or handle), and describe its recent videos, not its past or its reputation.

Look for direct evidence about the spoken audio: descriptions of what the host says and in which language, video descriptions mentioning dubbing (配音) or subtitles (字幕), the languages of its recent video titles and descriptions, fan wikis, Wikipedia or Baidu entries, comments that mention the language. Titles are weak evidence on their own: Cantonese, Taiwanese Hokkien, Japanese and English channels often have Chinese-character titles, and Mandarin channels sometimes have English ones. Don't infer the language from who the creators are, where they live, or what they talk about: a Chinese-Korean couple may speak Korean, and a video about Shanghainese may be in Mandarin.

Labels:
- "mandarin": most of the speech (or sung vocals, for music) in the channel's recent videos is Mandarin Chinese, any accent (mainland, Taiwan, Singapore, Malaysia).
- "mixed": Mandarin is roughly 25-75% of the speech, e.g. a Mandarin-teaching channel that explains in another language, a bilingual vlog, or a news channel that mixes its own Mandarin reports with English reports subtitled in Chinese.
- "other": little or no spoken Mandarin. This includes Cantonese, Hokkien, Hakka, Shanghainese and other Chinese languages, English or other languages about China or teaching Chinese, and channels whose videos are mostly music without vocals, ambient sound or silence, even if the few words spoken are Mandarin.
- "unknown": you could not find enough evidence to choose. Prefer this over a guess.

Keep searching until you are confident or out of leads.`;

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
