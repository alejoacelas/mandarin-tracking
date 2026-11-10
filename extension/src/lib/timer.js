// Decides which stretches of time count as engaged, and returns them as wall-clock spans
// [start_ms, end_ms]. Pure logic with injected clocks, so it can be tested without a browser.
//
// "video" mode counts while a video plays with sound and no ad shows, whether or not the tab is
// visible (listening counts). "reading" mode counts while the tab is visible and focused and the
// user did something within the idle limit.
//
// Durations come from the monotonic clock (`mono`, performance.now in pages) and timestamps from
// the wall clock (`now`, Date.now). So a change of the system clock moves where a span sits but
// never adds or removes engaged time. Callers tick about once a second; a longer stretch between
// ticks means the computer slept or the page was frozen, so at most MAX_STRETCH_MS of it counts.
export const MAX_STRETCH_MS = 15_000;
const JOIN_MS = 50; // spans this close together are one span

export class EngagementTimer {
  constructor({ mode, now = () => Date.now(), mono = () => performance.now(), idleMs = 120_000 }) {
    this.mode = mode;
    this.now = now;
    this.mono = mono;
    this.idleMs = idleMs;
    this.visible = true;
    this.focused = true;
    this.playing = false;
    this.ad = false;
    this.lastActivity = mono();
    this.sinceMono = mono();
    this.spans = [];
    this.droppedMs = 0; // time not counted because ticks were too far apart, for diagnostics
  }

  advance() {
    const m = this.mono();
    const w = this.now();
    const elapsed = m - this.sinceMono;
    if (elapsed > 0) {
      const counted = Math.min(elapsed, MAX_STRETCH_MS);
      this.droppedMs += elapsed - counted;
      let engaged = 0;
      if (this.mode === "video") {
        if (this.playing && !this.ad) engaged = counted;
      } else if (this.visible && this.focused) {
        engaged = Math.max(0, Math.min(counted, this.lastActivity + this.idleMs - this.sinceMono));
      }
      if (engaged > 0) {
        // Wall time of the stretch's start, as seen from now.
        const start = Math.round(w - elapsed);
        this.addSpan(start, Math.round(start + engaged));
      }
    }
    this.sinceMono = m;
  }

  addSpan(start, end) {
    if (end <= start) return;
    const last = this.spans.at(-1);
    if (last && Math.abs(start - last[1]) <= JOIN_MS && end > last[1]) last[1] = end;
    else this.spans.push([start, end]);
  }

  set(changes) {
    this.advance();
    Object.assign(this, changes);
  }

  activity() {
    this.advance();
    this.lastActivity = this.mono();
  }

  // Returns the engaged spans since the last call.
  take() {
    this.advance();
    const spans = this.spans;
    this.spans = [];
    return spans;
  }
}

export const totalMs = (spans) => spans.reduce((t, [s, e]) => t + (e - s), 0);
