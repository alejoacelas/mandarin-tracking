import { test } from "node:test";
import assert from "node:assert/strict";
import { chineseShare, languageOf } from "../../src/lib/chinese.js";

test("Han characters and Latin words count one unit each", () => {
  assert.deepEqual(chineseShare("我学中文 every day"), { share: 4 / 6, units: 6 });
});

test("empty or symbol-only text has no units and no share", () => {
  assert.deepEqual(chineseShare(""), { share: null, units: 0 });
  assert.deepEqual(chineseShare("123 !!! 😀"), { share: null, units: 0 });
});

test("traditional characters count like simplified ones", () => {
  assert.equal(chineseShare("學習漢語很有意思").share, 1);
});

test("Japanese with many kanji scores 0 (kana at least 10% of Han plus kana)", () => {
  const ja = "今日はとても良い天気ですね。散歩に行きましょうか。明日も晴れるといいですね。";
  const r = chineseShare(ja);
  assert.equal(r.share, 0);
  assert.ok(r.units >= 20);
  assert.equal(languageOf(r), "other");
});

test("a stray kana in a long Chinese text doesn't make it Japanese", () => {
  const zh = "我最近在学习中文每天都会和老师练习口语你觉得我应该先学汉字还是先练习听力".repeat(2) + "の";
  const r = chineseShare(zh);
  assert.ok(r.share > 0.9, String(r.share));
});

test("Korean scores low: each Hangul run is one non-Chinese unit", () => {
  const r = chineseShare("안녕하세요 저는 학생입니다 한국어를 공부해요 학교 韓國");
  assert.ok(r.share < 0.3);
});

test("Cyrillic words count as units", () => {
  assert.deepEqual(chineseShare("привет мир 你好"), { share: 0.5, units: 4 });
});

test("language needs 20 units and a 0.3 share", () => {
  assert.equal(languageOf(chineseShare("你好")), "unknown");
  assert.equal(languageOf({ share: 0.3, units: 20 }), "zh");
  assert.equal(languageOf({ share: 0.29, units: 20 }), "other");
  assert.equal(languageOf({ share: 0.9, units: 19 }), "unknown");
  assert.equal(languageOf({ share: null, units: 0 }), "unknown");
});
