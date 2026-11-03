import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReaderEvents } from "../../src/reader-sync.js";
import { summarize, localDay } from "../../src/summary.js";

const now = new Date(2026, 10, 3, 18, 0).getTime();
const at = (h, m, s = 0) => new Date(2026, 10, 3, h, m, s).getTime();
const day = localDay(new Date(now));
const docs = { d1: { title: "中文文章", share: 0.9 } };

test("phone reading adds a Reader item with API seconds and the document's share", () => {
  const events = [0, 30, 60, 90].map((s) => ({ doc: "d1", at: at(9, 0, s) }));
  const r = applyReaderEvents({ log: {}, events: [], newEvents: events, docs, now });
  const item = r.log[day].reader.d1;
  assert.equal(item.apiSeconds, 90 + 45); // three 30 s gaps plus the tail after the last save
  assert.equal(item.title, "中文文章");
  assert.equal(item.share, 0.9);
});

test("desktop reading seen by both measurements counts once, as the larger", () => {
  const log = { [day]: { reader: { d1: { seconds: 200, share: 0.9 } } } };
  const events = [0, 30, 60].map((s) => ({ doc: "d1", at: at(9, 0, s) }));
  const r = applyReaderEvents({ log, events: [], newEvents: events, docs, now });
  const s = summarize(r.log, {}, { threshold: 0.3 })[day];
  assert.equal(s.totals.mandarin, 200);
});

test("repeated polls don't double-count the same saves", () => {
  const events = [0, 30].map((s) => ({ doc: "d1", at: at(9, 0, s) }));
  let r = applyReaderEvents({ log: {}, events: [], newEvents: events, docs, now });
  r = applyReaderEvents({ log: r.log, events: r.events, newEvents: events, docs, now });
  assert.equal(r.log[day].reader.d1.apiSeconds, 30 + 45);
  assert.equal(r.events.length, 2);
});

test("events older than the kept window are dropped but their day's total stays", () => {
  const old = new Date(2026, 9, 20, 9, 0).getTime();
  const oldDay = localDay(new Date(old));
  const log = { [oldDay]: { reader: { d1: { seconds: 0, apiSeconds: 300 } } } };
  const r = applyReaderEvents({ log, events: [{ doc: "d1", at: old }], newEvents: [], docs, now });
  assert.equal(r.events.length, 0);
  assert.equal(r.log[oldDay].reader.d1.apiSeconds, 300);
});
