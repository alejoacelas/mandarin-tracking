// Turns engaged spans reported by a tab into protocol intervals (docs/protocol.md, "Intervals").
// Pure logic: the background worker keeps one open interval per tab and source, and passes it in.
//
// Rules:
// - A span extends the open interval when it continues it (starts within JOIN_GAP_MS of its end)
//   and shows the same content: same source, site, video / conversation / document and language.
// - Anything else starts a new interval: other content, a different language, any pause longer
//   than JOIN_GAP_MS (pauses aren't counted as time), or the open one reaching 30 minutes.
// - A span that repeats time already in the open interval (a retry after the worker stopped
//   before it answered) adds only the part that is new.
// - Time on a new chat that has no conversation id yet goes to the conversation it becomes.
export const MAX_INTERVAL_MS = 30 * 60_000;
export const JOIN_GAP_MS = 3000;

export const DESC_FIELDS = ["source", "app", "language", "zh_share", "units", "title", "channel_name", "channel_id",
  "video_id", "conversation_id", "doc_id", "url", "meta"];
const IDENTITY = ["source", "app", "language", "video_id", "conversation_id", "doc_id"];
const FILL_IN = ["channel_id", "channel_name"]; // YouTube's player can report these a moment late

function sameContent(open, desc) {
  if (!IDENTITY.every((k) => (open[k] ?? null) === (desc[k] ?? null))) return false;
  return FILL_IN.every((k) => open[k] == null || desc[k] == null || open[k] === desc[k]);
}

// A new chat (no conversation id yet) turning into a conversation in the same tab.
function adopts(open, desc) {
  return open.source === "llm" && open.conversation_id == null && open.meta?.new_chat === true
    && desc.conversation_id != null && open.app === desc.app;
}

function describe(desc) {
  const out = {};
  for (const k of DESC_FIELDS) out[k] = desc[k] ?? null;
  return out;
}

// Latest measurement wins for the descriptive fields; identity fields never change here.
function refresh(open, desc) {
  for (const k of ["title", "zh_share", "units", "url", "meta"]) if (desc[k] !== undefined) open[k] = desc[k] ?? null;
  for (const k of FILL_IN) if (desc[k] != null) open[k] = desc[k];
}

// open: the tab's open interval or null. Returns { open, changed: [intervals to (re)send] }.
export function applySpans({ open, desc, spans, newId }) {
  const changed = new Map();
  let cur = open ? { ...open, meta: open.meta ? { ...open.meta } : null } : null;
  for (let [s, e] of spans) {
    if (!(e > s)) continue;
    const continues = cur && s <= cur.end_ms + JOIN_GAP_MS && s >= cur.start_ms - JOIN_GAP_MS;
    if (continues && e <= cur.end_ms && sameContent(cur, desc)) continue; // already counted
    if (continues && cur.end_ms - cur.start_ms < MAX_INTERVAL_MS && (sameContent(cur, desc) || adopts(cur, desc))) {
      if (adopts(cur, desc)) Object.assign(cur, describe(desc));
      else refresh(cur, desc);
      const limit = cur.start_ms + MAX_INTERVAL_MS;
      const from = Math.max(s, cur.end_ms);
      cur.end_ms = Math.min(e, limit);
      changed.set(cur.id, { ...cur });
      if (e <= limit) continue;
      s = Math.max(from, limit); // the rest starts a new interval
    } else if (continues && sameContent(cur, desc) && s < cur.end_ms) {
      s = cur.end_ms; // the open interval is full; only the new part starts the next one
    }
    cur = { id: newId(), ...describe(desc), start_ms: s, end_ms: e };
    changed.set(cur.id, { ...cur });
  }
  return { open: cur, changed: [...changed.values()] };
}
