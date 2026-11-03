import { test } from "node:test";
import assert from "node:assert/strict";
import { EngagementTimer } from "../../src/timer.js";

// tick(s) passes time in one-second steps, ticking every timer created with c.now like the
// content scripts do; jump(s) passes time with no ticks (computer asleep).
function clock() {
  let t = 1_000_000;
  const timers = [];
  const now = () => t;
  now.register = (timer) => timers.push(timer);
  return {
    now,
    tick: (s) => { for (let i = 0; i < Math.floor(s); i++) { t += 1000; timers.forEach((x) => x.advance()); } t += (s % 1) * 1000; },
    jump: (s) => { t += s * 1000; },
  };
}
const make = (c, opts) => { const timer = new EngagementTimer({ ...opts, now: c.now }); c.now.register(timer); return timer; };

test("reading: counts while active, stops at the idle limit", () => {
  const c = clock();
  const timer = make(c, { mode: "reading", idleMs: 120_000 });
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
  const timer = make(c, { mode: "reading" });
  c.tick(5); timer.set({ visible: false });
  c.tick(50); timer.activity();
  c.tick(10); timer.set({ visible: true }); timer.activity();
  c.tick(5); timer.set({ focused: false });
  c.tick(40);
  assert.equal(timer.take(), 10);
});

test("reading: idle limit is measured from the last activity, not from when the tab came back", () => {
  const c = clock();
  const timer = make(c, { mode: "reading", idleMs: 60_000 });
  c.tick(10); timer.set({ visible: false });
  c.tick(100); timer.set({ visible: true }); // back after 100 s with no input: already idle
  c.tick(20);
  assert.equal(timer.take(), 10);
});

test("video: counts while playing, including background tabs, but not ads", () => {
  const c = clock();
  const timer = make(c, { mode: "video" });
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
  const timer = make(c, { mode: "video" });
  timer.set({ playing: true });
  let total = 0;
  for (let i = 0; i < 10; i++) { c.tick(0.7); total += timer.take(); }
  assert.equal(total, 7);
});

test("a long gap between ticks (computer asleep) counts at most MAX_STRETCH_MS", async () => {
  const { MAX_STRETCH_MS } = await import("../../src/timer.js");
  const c = clock();
  const video = make(c, { mode: "video" });
  video.set({ playing: true });
  c.tick(3); video.advance();
  c.jump(1800); // laptop lid closed for 30 minutes mid-video
  c.tick(2); // the first tick after waking closes the gap stretch, which is capped
  assert.equal(video.take(), 3 + MAX_STRETCH_MS / 1000 + 1);

  const reading = make(c, { mode: "reading", idleMs: 120_000 });
  reading.activity();
  c.jump(600);
  assert.equal(reading.take(), MAX_STRETCH_MS / 1000);
});

test("giveBack returns seconds for the next take", () => {
  const c = clock();
  const timer = make(c, { mode: "video" });
  timer.set({ playing: true });
  c.tick(5);
  const s = timer.take();
  timer.giveBack(s);
  c.tick(2);
  assert.equal(timer.take(), 7);
});
