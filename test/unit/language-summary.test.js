import { test } from "node:test";
import assert from "node:assert/strict";
import { chineseShare } from "../../src/language.js";
import { summarize, classify } from "../../src/summary.js";

test("chineseShare", () => {
  assert.equal(chineseShare("我今天很忙").share, 1);
  assert.equal(chineseShare("I am busy today").share, 0);
  assert.equal(chineseShare("").share, 0);
  // Five characters and five English words: half and half.
  assert.equal(chineseShare("我今天很忙 because of work this week").share, 0.5);
  // Japanese: kanji mixed with kana scores well below pure Chinese.
  assert.ok(chineseShare("今日はとても忙しいです").share < 0.4);
  assert.ok(chineseShare("오늘 정말 바빠요 我").share < 0.3);
});

test("classify chats by threshold and YouTube by channel label", () => {
  assert.equal(classify("claude", "x", { share: 0.31 }, {}, 0.3), "mandarin");
  assert.equal(classify("claude", "x", { share: 0.29 }, {}, 0.3), "other");
  assert.equal(classify("claude", "x", { share: null }, {}, 0.3), "unclassified");
  assert.equal(classify("claude", "_other", { share: null }, {}, 0.3), "other");
  const ch = { a: { status: "done", label: "mandarin" }, b: { status: "pending" }, c: { status: "done", label: "unknown" }, d: { status: "error" } };
  assert.equal(classify("youtube", "a", {}, ch, 0.3), "mandarin");
  for (const k of ["b", "c", "d", "missing"]) assert.equal(classify("youtube", k, {}, ch, 0.3), "unclassified");
});

test("summarize totals per day and source", () => {
  const log = {
    "2026-11-03": {
      youtube: { a: { seconds: 600 }, b: { seconds: 60 } },
      claude: { c1: { seconds: 120, share: 0.8 }, c2: { seconds: 300, share: 0.05 } },
    },
  };
  const s = summarize(log, { a: { status: "done", label: "mandarin" } }, { threshold: 0.3 })["2026-11-03"];
  assert.deepEqual(s.totals, { mandarin: 720, mixed: 0, unclassified: 60, other: 300 });
  assert.equal(s.sources.claude.items[0].key, "c2");
});
