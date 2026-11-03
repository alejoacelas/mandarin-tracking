import { test } from "node:test";
import assert from "node:assert/strict";
import { EngagementTimer } from "../../src/timer.js";

function clock() {
  let t = 1_000_000;
  return { now: () => t, tick: (s) => { t += s * 1000; } };
}

test("reading: counts while active, stops at the idle limit", () => {
  const c = clock();
  const timer = new EngagementTimer({ mode: "reading", now: c.now, idleMs: 120_000 });
  c.tick(30); timer.activity();
  c.tick(30); timer.activity();
  assert.equal(timer.take(), 60);
  c.tick(600); // walked away: only the 120 s until the idle limit count
  assert.equal(timer.take(), 120);
  c.tick(100);
  assert.equal(timer.take(), 0);
  timer.activity(); c.tick(10);
  assert.equal(timer.take(), 10);
});

test("reading: hidden or unfocused tab doesn't count", () => {
  const c = clock();
  const timer = new EngagementTimer({ mode: "reading", now: c.now });
  c.tick(5); timer.set({ visible: false });
  c.tick(50); timer.activity();
  c.tick(10); timer.set({ visible: true }); timer.activity();
  c.tick(5); timer.set({ focused: false });
  c.tick(40);
  assert.equal(timer.take(), 10);
});

test("reading: idle limit is measured from the last activity, not from when the tab came back", () => {
  const c = clock();
  const timer = new EngagementTimer({ mode: "reading", now: c.now, idleMs: 60_000 });
  c.tick(10); timer.set({ visible: false });
  c.tick(100); timer.set({ visible: true }); // back after 100 s with no input: already idle
  c.tick(20);
  assert.equal(timer.take(), 10);
});

test("video: counts while playing, including background tabs, but not ads", () => {
  const c = clock();
  const timer = new EngagementTimer({ mode: "video", now: c.now });
  c.tick(5); timer.set({ playing: true });
  c.tick(20); timer.set({ visible: false });
  c.tick(20); timer.set({ ad: true });
  c.tick(15); timer.set({ ad: false });
  c.tick(5); timer.set({ playing: false });
  c.tick(100);
  assert.equal(timer.take(), 45);
});

test("take keeps sub-second remainders", () => {
  const c = clock();
  const timer = new EngagementTimer({ mode: "video", now: c.now });
  timer.set({ playing: true });
  let total = 0;
  for (let i = 0; i < 10; i++) { c.tick(0.7); total += timer.take(); }
  assert.equal(total, 7);
});
