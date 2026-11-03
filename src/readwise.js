// Readwise Reader reading time from the Reader API, for reading the content script can't see
// (the iOS and Android apps). The API has no time-spent data; it gives each document's
// `updated_at`, which moves each time the app saves reading progress (about every 30 s while
// you scroll), and `last_opened_at`. A session runs from an open or save through every save
// less than SESSION_GAP_S apart, plus SESSION_TAIL_S after the last one. readwise/benchmark.py
// tuned these against scripted reading sessions (about 15% error per session).
import { chineseShare } from "./language.js";

export const SESSION_GAP_S = 300;
export const SESSION_TAIL_S = 45;
// Poll slowly while nothing changes, quickly while reading is happening, because each poll only
// sees a document's latest save and the saves in between are what bound the session.
export const IDLE_POLL_S = 300;
export const ACTIVE_POLL_S = 30;
export const MANDARIN_SHARE = 0.3;

const API = "https://readwise.io/api/v3/list/";

async function getJSON(url, token, fetchFn) {
  const r = await fetchFn(url, { headers: { Authorization: `Token ${token}` } });
  if (r.status === 404) return { results: [], nextPageCursor: null }; // empty libraries return 404
  if (r.status === 429) {
    const err = new Error("Reader API rate limit");
    err.retryAfterS = Number(r.headers.get("Retry-After")) || 60;
    throw err;
  }
  if (!r.ok) throw new Error(`Reader API returned ${r.status}`);
  return r.json();
}

async function listUpdated(token, since, fetchFn) {
  const docs = [];
  let cursor = "";
  do {
    const q = new URLSearchParams({ updatedAfter: since ?? "1970-01-01T00:00:00Z" });
    if (cursor) q.set("pageCursor", cursor);
    const d = await getJSON(`${API}?${q}`, token, fetchFn);
    docs.push(...d.results);
    cursor = d.nextPageCursor;
  } while (cursor);
  return docs;
}

async function mandarinShare(token, doc, fetchFn) {
  const d = await getJSON(`${API}?${new URLSearchParams({ id: doc.id, withHtmlContent: "true" })}`, token, fetchFn);
  const html = d.results[0]?.html_content ?? "";
  const text = `${doc.title ?? ""} ${html.replace(/<[^>]+>/g, " ")}`;
  return chineseShare(text).share;
}

// One poll. `state` is { since, docs: { id: { updatedAt, openedAt, share, title } } } from the
// previous poll (or {} the first time). Returns the new state, the save/open events seen on
// Mandarin documents, and how long to wait before the next poll.
//
// The first poll only records documents, so a library's history isn't counted as reading today.
export async function pollReader({ token, state = {}, now = Date.now(), fetchFn = fetch, lastEventAt = 0 }) {
  const first = !state.docs;
  const docs = { ...state.docs };
  const events = [];
  for (const doc of await listUpdated(token, state.since, fetchFn)) {
    if (doc.parent_id) continue; // highlights and notes
    const prev = docs[doc.id];
    if (prev?.updatedAt === doc.updated_at) continue;
    const share = prev?.share ?? (await mandarinShare(token, doc, fetchFn));
    docs[doc.id] = { updatedAt: doc.updated_at, openedAt: doc.last_opened_at, share, title: doc.title };
    if (first || share < MANDARIN_SHARE) continue;
    const opened = Date.parse(doc.last_opened_at);
    if (opened && doc.last_opened_at !== prev?.openedAt) events.push({ doc: doc.id, at: opened, title: doc.title });
    events.push({ doc: doc.id, at: Date.parse(doc.updated_at), title: doc.title });
  }
  const latest = Object.values(docs).reduce((m, d) => (d.updatedAt > m ? d.updatedAt : m), state.since ?? "");
  const recent = Math.max(lastEventAt, ...events.map((e) => e.at));
  const delayS = now - recent < SESSION_GAP_S * 1000 ? ACTIVE_POLL_S : IDLE_POLL_S;
  return { state: { since: latest || state.since, docs }, events, delayS };
}

// Seconds per document from save/open events (any order, any number of polls). Time between
// two events less than SESSION_GAP_S apart goes to the later event's document; the last event
// of each session gets SESSION_TAIL_S.
export function secondsFromEvents(events, { gapS = SESSION_GAP_S, tailS = SESSION_TAIL_S } = {}) {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const out = [];
  sorted.forEach((e, i) => {
    const next = sorted[i + 1];
    if (next && (next.at - e.at) / 1000 <= gapS) out.push({ doc: next.doc, at: e.at, seconds: (next.at - e.at) / 1000 });
    else out.push({ doc: e.doc, at: e.at, seconds: tailS });
  });
  return out.filter((s) => s.seconds > 0);
}
