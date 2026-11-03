import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { pollReader, secondsFromEvents } from "../../src/readwise.js";

test("time between close saves goes to the later document; isolated saves get the tail", () => {
  const s = (doc, sec) => ({ doc, at: sec * 1000 });
  const out = secondsFromEvents([s("a", 0), s("a", 30), s("b", 60), s("b", 1000)]);
  const by = (d) => out.filter((x) => x.doc === d).reduce((n, x) => n + x.seconds, 0);
  assert.equal(by("a"), 30);
  assert.equal(by("b"), 30 + 45 + 45);
});

// Replays the API snapshots recorded during scripted reading (readwise/runs) through pollReader
// with adaptive polling, and compares the result with the reading that actually happened.
test("replayed scripted reading is credited within 15% overall", async () => {
  const dir = new URL("../../readwise/", import.meta.url);
  const snaps = readFileSync(new URL("runs/poll.jsonl", dir), "utf8").trim().split("\n").map(JSON.parse).filter((s) => s.docs);
  const truth = readFileSync(new URL("runs/truth.jsonl", dir), "utf8").trim().split("\n").map(JSON.parse);
  const html = Object.fromEntries(
    readdirSync(new URL("fixtures/", dir)).map((f) => {
      const h = readFileSync(new URL(`fixtures/${f}`, dir), "utf8");
      return [h.match(/<h1>(.*?)<\/h1>/s)[1].slice(0, 4), h];
    }),
  );

  let snap;
  const fetchFn = async (url) => {
    const q = new URL(url).searchParams;
    const docs = Object.entries(snap.docs).map(([id, d]) => ({
      id, title: d.title, updated_at: d.updated_at, last_opened_at: d.last_opened_at, parent_id: null,
      html_content: html[d.title.slice(0, 4)] ?? "",
    }));
    const results = q.get("id") ? docs.filter((d) => d.id === q.get("id"))
      : docs.filter((d) => d.updated_at > q.get("updatedAfter"));
    return { status: 200, ok: true, json: async () => ({ results, nextPageCursor: null }) };
  };

  // Skip the scripted-scroll run (no input events, so Reader stopped syncing) and the probe.
  const scenarios = truth.filter((t) => !["probe", "js_scroll_8min"].includes(t.scenario));
  const start = Math.min(...scenarios.map((t) => t.start)) - 30;
  let state = {}, events = [], lastEventAt = 0, t = snaps.find((s) => s.t >= start - 120).t;
  while (true) {
    snap = snaps.find((s) => s.t >= t);
    if (!snap) break;
    const r = await pollReader({ token: "x", state, now: snap.t * 1000, fetchFn, lastEventAt });
    state = r.state;
    if (snap.t >= start) events.push(...r.events);
    lastEventAt = Math.max(lastEventAt, ...r.events.map((e) => e.at));
    t = snap.t + r.delayS - 2;
  }
  const credited = secondsFromEvents(events).filter((s) => s.at >= start * 1000).reduce((n, s) => n + s.seconds, 0);
  const actual = scenarios.reduce((n, s) => n + (s.end - s.start), 0);
  assert.ok(Math.abs(credited - actual) / actual < 0.15, `credited ${Math.round(credited)} s, actual ${Math.round(actual)} s`);
});
