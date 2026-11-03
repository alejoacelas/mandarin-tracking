// Decides which wall-clock time counts as engaged time. Pure logic with an injected clock, so it
// can be tested without a browser.
//
// "video" mode counts while the video plays and no ad is showing, whether or not the tab is
// visible (listening counts). "reading" mode counts while the tab is visible and focused and
// the user did something (key, pointer, scroll) within the idle limit.
//
// Callers tick the timer about once a second. A longer stretch between calls means the computer
// slept or the page was frozen, so at most MAX_STRETCH_MS of it counts.
export const MAX_STRETCH_MS = 15_000;

export class EngagementTimer {
  constructor({ mode, now = () => Date.now(), idleMs = 120_000 }) {
    this.mode = mode;
    this.now = now;
    this.idleMs = idleMs;
    this.visible = true;
    this.focused = true;
    this.playing = false;
    this.ad = false;
    this.lastActivity = now();
    this.since = now(); // start of the stretch not yet collected
    this.pendingMs = 0;
    this.gapMs = 0; // time dropped because of long gaps, for diagnostics
  }

  // Moves engaged time up to `at` into pendingMs. In reading mode an idle stretch is credited
  // only up to the moment the idle limit ran out.
  advance(at = this.now()) {
    if (at <= this.since) return;
    const end = Math.min(at, this.since + MAX_STRETCH_MS);
    if (at > end) this.gapMs += at - end;
    if (this.mode === "video") {
      if (this.playing && !this.ad) this.pendingMs += end - this.since;
    } else if (this.visible && this.focused) {
      const until = Math.min(end, this.lastActivity + this.idleMs);
      if (until > this.since) this.pendingMs += until - this.since;
    }
    this.since = at;
  }

  set(changes) {
    this.advance();
    Object.assign(this, changes);
  }

  activity() {
    this.advance();
    this.lastActivity = this.now();
  }

  // Returns whole seconds of engaged time since the last call, keeping the remainder.
  take() {
    this.advance();
    const seconds = Math.floor(this.pendingMs / 1000);
    this.pendingMs -= seconds * 1000;
    return seconds;
  }

  // Puts seconds back, e.g. when sending them to the background worker failed.
  giveBack(seconds) {
    this.pendingMs += seconds * 1000;
  }
}
