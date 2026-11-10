import { test } from "node:test";
import assert from "node:assert/strict";
import { EngagementTimer, MAX_STRETCH_MS, totalMs } from "../../src/lib/timer.js";

// A fake pair of clocks. tick(s) passes time in one-second steps, ticking every timer like the
// content scripts do. sleep(s) passes wall time only (macOS: the monotonic clock stops while
// asleep); freeze(s) passes both with no ticks; jumpClock(s) moves the wall clock alone.
function clocks() {
  let wall = 1_700_000_000_000;
  let mono = 1000;
  const timers = [];
  return {
    now: () => wall,
    mono: () => mono,
    register: (t) => (timers.push(t), t),
    tick(s) {
      for (let i = 0; i < Math.floor(s); i++) { wall += 1000; mono += 1000; timers.forEach((t) => t.advance()); }
      const rest = (s % 1) * 1000; wall += rest; mono += rest;
    },
    sleep(s) { wall += s * 1000; },
    freeze(s) { wall += s * 1000; mono += s * 1000; },
    jumpClock(s) { wall += s * 1000; },
    get wall() { return wall; },
  };
}
const make = (c, opts) => c.register(new EngagementTimer({ ...opts, now: c.now, mono: c.mono }));
const seconds = (spans) => totalMs(spans) / 1000;

test("reading: counts while active and stops at the idle limit", () => {
  const c = clocks();
  const t = make(c, { mode: "reading", idleMs: 120_000 });
  c.tick(30); t.activity();
  c.tick(30); t.activity();
  assert.equal(seconds(t.take()), 60);
  c.tick(600); // walked away: only the 120 s until the idle limit count
  assert.equal(seconds(t.take()), 120);
  c.tick(100);
  assert.deepEqual(t.take(), []);
  t.activity(); c.tick(10);
  assert.equal(seconds(t.take()), 10);
});

test("reading: continuous activity is one span with wall-clock ends", () => {
  const c = clocks();
  const start = c.wall;
  const t = make(c, { mode: "reading" });
  for (let i = 0; i < 20; i++) { c.tick(1); t.activity(); }
  assert.deepEqual(t.take(), [[start, start + 20_000]]);
});

test("reading: a hidden or unfocused tab doesn't count", () => {
  const c = clocks();
  const t = make(c, { mode: "reading" });
  c.tick(5); t.set({ visible: false });
  c.tick(50); t.activity();
  c.tick(10); t.set({ visible: true }); t.activity();
  c.tick(5); t.set({ focused: false });
  c.tick(40);
  const spans = t.take();
  assert.equal(seconds(spans), 10);
  assert.equal(spans.length, 2);
});

test("reading: the idle limit runs from the last input, not from when the tab came back", () => {
  const c = clocks();
  const t = make(c, { mode: "reading", idleMs: 60_000 });
  c.tick(10); t.set({ visible: false });
  c.tick(100); t.set({ visible: true });
  c.tick(20);
  assert.equal(seconds(t.take()), 10);
});

test("video: counts while playing, in background tabs too, but not ads", () => {
  const c = clocks();
  const t = make(c, { mode: "video" });
  c.tick(5); t.set({ playing: true });
  c.tick(20); t.set({ visible: false });
  c.tick(20); t.set({ ad: true });
  c.tick(15); t.set({ ad: false });
  c.tick(5); t.set({ playing: false });
  c.tick(100);
  const spans = t.take();
  assert.equal(seconds(spans), 45);
  assert.equal(spans.length, 2, "the ad splits the time into two spans");
});

test("sleep: wall time passing while the monotonic clock stood still adds nothing", () => {
  const c = clocks();
  const t = make(c, { mode: "video" });
  t.set({ playing: true });
  c.tick(3);
  c.sleep(1800);
  c.tick(2);
  const spans = t.take();
  assert.equal(seconds(spans), 5);
  assert.equal(spans.length, 2, "the sleep leaves a gap between spans");
  assert.ok(spans[1][0] - spans[0][1] >= 1_799_000);
});

test("frozen page: a long stretch between ticks counts at most MAX_STRETCH_MS", () => {
  const c = clocks();
  const t = make(c, { mode: "video" });
  t.set({ playing: true });
  c.tick(3);
  c.freeze(600);
  c.tick(2);
  // The first tick after the freeze closes the long stretch (capped); the second adds 1 s.
  assert.equal(seconds(t.take()), 3 + MAX_STRETCH_MS / 1000 + 1);
});

test("system clock jumps move the spans but don't add or remove time", () => {
  const c = clocks();
  const t = make(c, { mode: "video" });
  t.set({ playing: true });
  c.tick(10);
  c.jumpClock(3600); // clock set forward an hour
  c.tick(10);
  c.jumpClock(-7200); // and back two
  c.tick(10);
  const spans = t.take();
  assert.equal(seconds(spans), 30);
  assert.equal(spans.length, 3);
});

test("take returns each span once and keeps sub-second precision", () => {
  const c = clocks();
  const t = make(c, { mode: "video" });
  t.set({ playing: true });
  let total = 0;
  for (let i = 0; i < 10; i++) { c.tick(0.7); total += totalMs(t.take()); }
  assert.equal(total, 7000);
});
