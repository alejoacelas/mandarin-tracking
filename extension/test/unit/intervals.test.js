import { test } from "node:test";
import assert from "node:assert/strict";
import { applySpans, MAX_INTERVAL_MS } from "../../src/lib/intervals.js";

const T = 1_700_000_000_000;
const S = 1000;
const ids = () => { let n = 0; return () => `iv${++n}`; };
const chat = (over = {}) => ({ source: "llm", app: "claude.ai", language: "zh", zh_share: 0.8, units: 200, title: "聊天", conversation_id: "c1", url: "https://claude.ai/chat/c1", meta: { measured: "content" }, ...over });
const video = (over = {}) => ({ source: "youtube", app: "www.youtube.com", language: "unknown", video_id: "v1", channel_id: "UC1", channel_name: "老高", title: "t", ...over });

// Feeds batches of spans in order, like a tab's flushes, and returns every interval's latest copy.
function run(batches, newId = ids()) {
  let open = null;
  const all = new Map();
  for (const [desc, spans] of batches) {
    const r = applySpans({ open, desc, spans, newId });
    open = r.open;
    for (const i of r.changed) all.set(i.id, i);
  }
  return { open, intervals: [...all.values()] };
}
const dur = (i) => (i.end_ms - i.start_ms) / S;

test("contiguous spans of the same chat extend one interval", () => {
  const { intervals } = run([
    [chat(), [[T, T + 5 * S]]],
    [chat(), [[T + 5 * S, T + 10 * S]]],
    [chat({ title: "新标题", zh_share: 0.9 }), [[T + 10 * S, T + 15 * S]]],
  ]);
  assert.equal(intervals.length, 1);
  assert.equal(dur(intervals[0]), 15);
  assert.equal(intervals[0].title, "新标题", "latest title wins");
  assert.equal(intervals[0].zh_share, 0.9);
});

test("a pause longer than 3 s starts a new interval and isn't counted", () => {
  const { intervals } = run([[chat(), [[T, T + 10 * S], [T + 70 * S, T + 80 * S]]]]);
  assert.deepEqual(intervals.map(dur), [10, 10]);
  assert.equal(intervals[1].start_ms, T + 70 * S);
});

test("a gap of more than 2 minutes always starts a new interval", () => {
  const { intervals } = run([[chat(), [[T, T + 10 * S]]], [chat(), [[T + 200 * S, T + 210 * S]]]]);
  assert.equal(intervals.length, 2);
});

test("a change of conversation, video, document, site or language starts a new interval", () => {
  const cases = [
    [chat(), chat({ conversation_id: "c2" })],
    [chat(), chat({ language: "other" })],
    [chat(), chat({ app: "chatgpt.com" })],
    [video(), video({ video_id: "v2" })],
    [{ source: "reader", app: "read.readwise.io", language: "zh", doc_id: "d1" }, { source: "reader", app: "read.readwise.io", language: "zh", doc_id: "d2" }],
  ];
  for (const [a, b] of cases) {
    const { intervals } = run([[a, [[T, T + 5 * S]]], [b, [[T + 5 * S, T + 10 * S]]]]);
    assert.equal(intervals.length, 2, JSON.stringify(b));
  }
});

test("intervals are split at 30 minutes exactly", () => {
  const spans = [];
  for (let t = 0; t < 65 * 60; t += 5) spans.push([T + t * S, T + (t + 5) * S]);
  const { intervals } = run(spans.map((s) => [video(), [s]]));
  assert.deepEqual(intervals.map(dur), [30 * 60, 30 * 60, 5 * 60]);
  assert.equal(intervals[1].start_ms, intervals[0].end_ms);
  for (const i of intervals) assert.ok(i.end_ms - i.start_ms <= MAX_INTERVAL_MS);
});

test("a single span crossing the 30-minute mark is split", () => {
  const { intervals } = run([[video(), [[T, T + 29 * 60 * S]]], [video(), [[T + 29 * 60 * S, T + 31 * 60 * S]]]]);
  assert.deepEqual(intervals.map(dur), [30 * 60, 60]);
});

test("a repeated batch (retry after the worker died before answering) adds nothing", () => {
  const b1 = [chat(), [[T, T + 5 * S]]];
  const b2 = [chat(), [[T + 5 * S, T + 10 * S]]];
  const { intervals } = run([b1, b2, b2, b2]);
  assert.equal(intervals.length, 1);
  assert.equal(dur(intervals[0]), 10);
});

test("a partly repeated span adds only the new part", () => {
  const { intervals } = run([[chat(), [[T, T + 10 * S]]], [chat(), [[T + 8 * S, T + 12 * S]]]]);
  assert.equal(intervals.length, 1);
  assert.equal(dur(intervals[0]), 12);
});

test("YouTube channel details reported late fill in the same interval", () => {
  const { intervals } = run([
    [video({ channel_id: null, channel_name: null }), [[T, T + 5 * S]]],
    [video(), [[T + 5 * S, T + 10 * S]]],
  ]);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].channel_id, "UC1");
});

test("time on a new chat goes to the conversation it becomes", () => {
  const fresh = chat({ conversation_id: null, language: "unknown", zh_share: null, units: 0, title: null, url: null, meta: { new_chat: true } });
  const { intervals } = run([[fresh, [[T, T + 20 * S]]], [chat(), [[T + 20 * S, T + 30 * S]]]]);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].conversation_id, "c1");
  assert.equal(intervals[0].language, "zh");
  assert.equal(dur(intervals[0]), 30);
});

test("a new chat abandoned for another chat after a pause stays separate", () => {
  const fresh = chat({ conversation_id: null, language: "unknown", meta: { new_chat: true } });
  const { intervals } = run([[fresh, [[T, T + 20 * S]]], [chat(), [[T + 200 * S, T + 210 * S]]]]);
  assert.equal(intervals.length, 2);
  assert.equal(intervals[0].conversation_id, null);
});

test("a span from before the open interval (clock set back) starts a new interval", () => {
  const { intervals } = run([[chat(), [[T, T + 10 * S]]], [chat(), [[T - 3600 * S, T - 3590 * S]]]]);
  assert.equal(intervals.length, 2);
  assert.ok(intervals.every((i) => i.end_ms > i.start_ms));
});

test("only protocol fields are set, with null for missing ones", () => {
  const { intervals } = run([[video(), [[T, T + 5 * S]]]]);
  assert.deepEqual(Object.keys(intervals[0]).sort(), ["app", "channel_id", "channel_name", "conversation_id", "doc_id", "end_ms", "id",
    "language", "meta", "source", "start_ms", "title", "units", "url", "video_id", "zh_share"].sort());
  assert.equal(intervals[0].doc_id, null);
});

test("a page's first seconds, before its text was measured, join the measured interval", () => {
  const early = chat({ language: "unknown", zh_share: null, units: null, title: null, meta: { measured: "not_yet" } });
  const { intervals } = run([[early, [[T, T + 1 * S]]], [chat(), [[T + 1 * S, T + 20 * S]]]]);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].language, "zh");
  assert.equal(dur(intervals[0]), 20);
});

test("a measured chat doesn't turn into another conversation", () => {
  const { intervals } = run([[chat({ meta: { measured: "content" } }), [[T, T + 5 * S]]], [chat({ conversation_id: "c2" }), [[T + 5 * S, T + 9 * S]]]]);
  assert.equal(intervals.length, 2);
});
