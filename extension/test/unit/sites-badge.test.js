import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SITES, READING_MATCHES } from "../../src/lib/sites.js";
import { badgeFor, formatMinutes, todayFrom, localDate } from "../../src/lib/badge.js";

const id = (url) => { const u = new URL(url); return SITES[u.hostname].conversation(u); };
const isNew = (url) => { const u = new URL(url); return SITES[u.hostname].isNewChat(u); };

test("conversation and document ids from URLs", () => {
  const cases = {
    "https://chatgpt.com/c/6ae1b705-6698-83eb-8fc5-b9faf3f19ab3": "6ae1b705-6698-83eb-8fc5-b9faf3f19ab3",
    "https://chatgpt.com/g/g-p-6aa8edb5cc088191b75be1006a1f158d-mandarin/c/6abb6a25-c3bc-83ed-9a17-e71dc2041f25": "6abb6a25-c3bc-83ed-9a17-e71dc2041f25",
    "https://chatgpt.com/": null,
    "https://chatgpt.com/gpts": null,
    "https://claude.ai/chat/6cf538e8-dedf-4fa9-b054-faf38804fb49": "6cf538e8-dedf-4fa9-b054-faf38804fb49",
    "https://claude.ai/recents": null,
    "https://gemini.google.com/app/152b87afe7b9cb1e": "152b87afe7b9cb1e",
    "https://gemini.google.com/u/1/app/152b87afe7b9cb1e": "152b87afe7b9cb1e",
    "https://gemini.google.com/gem/coding-partner/152b87afe7b9cb1e": "152b87afe7b9cb1e",
    "https://chat.deepseek.com/a/chat/s/0f2b6c1e-6c55-4a43-9f0a-3e1d1c2b3a4f": "0f2b6c1e-6c55-4a43-9f0a-3e1d1c2b3a4f",
    "https://www.doubao.com/chat/1234567890123": "1234567890123",
    "https://www.kimi.com/chat/d3v1abcdefgh": "d3v1abcdefgh",
    "https://grok.com/c/0f2b6c1e-6c55-4a43-9f0a-3e1d1c2b3a4f": "0f2b6c1e-6c55-4a43-9f0a-3e1d1c2b3a4f",
    "https://www.perplexity.ai/search/how-do-tones-work-AbCdEf12345": "how-do-tones-work-AbCdEf12345",
    "https://read.readwise.io/new/read/01m6gr06yps2ws7rzt6fs3szh2": "01m6gr06yps2ws7rzt6fs3szh2",
    "https://read.readwise.io/read/01m6gr06yps2ws7rzt6fs3szh2": "01m6gr06yps2ws7rzt6fs3szh2",
    "https://read.readwise.io/new": null,
  };
  for (const [url, want] of Object.entries(cases)) assert.equal(id(url), want, url);
});

test("new-chat pages", () => {
  assert.ok(isNew("https://claude.ai/new"));
  assert.ok(isNew("https://chatgpt.com/"));
  assert.ok(isNew("https://gemini.google.com/app"));
  assert.ok(!isNew("https://claude.ai/recents"));
  assert.ok(!isNew("https://read.readwise.io/new"));
});

test("the manifest injects the reading script exactly where sites.js has a site", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url)));
  const reading = manifest.content_scripts.find((c) => c.js.includes("dist/reading.js"));
  assert.deepEqual([...reading.matches].sort(), [...READING_MATCHES].sort());
  for (const m of READING_MATCHES) assert.ok(manifest.host_permissions.includes(m), m);
});

test("badge: minutes on red, amber with ! when something is wrong", () => {
  assert.deepEqual(badgeFor({ minutes: 42.4, problem: false }).text, "42m");
  assert.deepEqual(badgeFor({ minutes: 65, problem: false }).text, "1h05");
  assert.deepEqual(badgeFor({ minutes: 0, problem: false }).text, "");
  assert.deepEqual(badgeFor({ minutes: 42, problem: true }).text, "42!");
  assert.deepEqual(badgeFor({ minutes: 150, problem: true }).text, "3h!");
  assert.deepEqual(badgeFor({ minutes: null, problem: true }).text, "!");
  assert.notEqual(badgeFor({ minutes: 1, problem: true }).color, badgeFor({ minutes: 1, problem: false }).color);
  assert.equal(formatMinutes(59.6), "1h00");
});

test("today's minutes come from the summary entry for today's local date", () => {
  const s = { days: [{ date: "2026-11-09", total_min: 10 }, { date: "2026-11-10", total_min: 42.5 }] };
  assert.equal(todayFrom(s, "2026-11-10"), 42.5);
  assert.equal(todayFrom(s, "2026-11-11"), 0);
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
