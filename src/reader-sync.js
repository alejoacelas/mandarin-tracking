// Merges Reader API reading time (src/readwise.js) into the extension's log. API seconds are
// stored as `apiSeconds` next to the content script's `seconds` on the same document and day;
// the summary counts the larger of the two, so desktop reading isn't counted twice and phone
// reading still adds.
import { secondsFromEvents } from "./readwise.js";
import { localDay } from "./summary.js";

export const KEEP_EVENTS_DAYS = 7;

// Keeps events from the last KEEP_EVENTS_DAYS days, recomputes apiSeconds for every day those
// events fully cover, and returns { log, events }. Days older than the kept events keep the
// apiSeconds already stored.
export function applyReaderEvents({ log, events, newEvents, docs, now }) {
  const cutoff = now - KEEP_EVENTS_DAYS * 86400_000;
  const kept = [...events, ...newEvents].filter((e) => e.at >= cutoff);
  // Drop duplicates: the same save can be seen by two polls.
  const seen = new Set();
  const unique = kept.filter((e) => { const k = `${e.doc}|${e.at}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const firstFullDay = localDay(new Date(cutoff + 86400_000));
  const perDayDoc = {};
  for (const s of secondsFromEvents(unique)) {
    const day = localDay(new Date(s.at));
    if (day < firstFullDay) continue;
    const k = `${day}|${s.doc}`;
    perDayDoc[k] = (perDayDoc[k] ?? 0) + s.seconds;
  }

  const next = structuredClone(log);
  // Clear recomputed days first, so a document whose events were dropped doesn't keep stale time.
  for (const [day, bySource] of Object.entries(next)) {
    if (day < firstFullDay) continue;
    for (const item of Object.values(bySource.reader ?? {})) delete item.apiSeconds;
  }
  for (const [k, seconds] of Object.entries(perDayDoc)) {
    const [day, doc] = k.split("|");
    const item = (((next[day] ??= {}).reader ??= {})[doc] ??= { seconds: 0 });
    item.apiSeconds = Math.round(seconds);
    const d = docs[doc];
    if (d) {
      item.title ??= d.title;
      if (item.share == null) item.share = d.share;
    }
  }
  return { log: next, events: unique };
}
