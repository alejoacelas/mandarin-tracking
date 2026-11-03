// Turns the stored log into per-day totals. Labels are applied when summarising, not when time is
// recorded, so a channel classified later or a changed threshold applies to past days too.
export const SOURCES = { youtube: "YouTube", reader: "Readwise Reader", claude: "Claude", chatgpt: "ChatGPT" };
export const CLASSES = ["mandarin", "mixed", "unclassified", "other"];

export function localDay(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function classify(source, key, item, channels, threshold) {
  if (key.startsWith("_")) return "other"; // pages that aren't a conversation, unsent new chats
  if (source === "youtube") {
    const c = channels[key];
    if (c?.status !== "done") return "unclassified";
    return c.label === "unknown" ? "unclassified" : c.label;
  }
  if (item.share == null) return "unclassified";
  return item.share >= threshold ? "mandarin" : "other";
}

// Returns { [day]: { totals: {class: seconds}, sources: { [source]: { totals, items: [...] } } } }
export function summarize(log, channels, { threshold }) {
  const out = {};
  for (const [day, bySource] of Object.entries(log)) {
    const dayOut = { totals: zero(), sources: {} };
    for (const [source, items] of Object.entries(bySource)) {
      const s = { totals: zero(), items: [] };
      for (const [key, raw] of Object.entries(items)) {
        // Reader documents can have time from both the content script and the Reader API
        // (src/reader-sync.js); the larger one counts.
        const item = { ...raw, seconds: Math.max(raw.seconds ?? 0, raw.apiSeconds ?? 0) };
        const cls = classify(source, key, item, channels, threshold);
        s.totals[cls] += item.seconds;
        dayOut.totals[cls] += item.seconds;
        s.items.push({ key, cls, ...item, channel: source === "youtube" ? channels[key] : undefined });
      }
      s.items.sort((a, b) => b.seconds - a.seconds);
      dayOut.sources[source] = s;
    }
    out[day] = dayOut;
  }
  return out;
}

const zero = () => Object.fromEntries(CLASSES.map((c) => [c, 0]));

export function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
