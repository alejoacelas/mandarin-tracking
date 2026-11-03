// Decides which wall-clock time counts as engaged time. Pure logic with an injected clock, so it
// can be tested without a browser.
//
// "video" mode counts while the video plays and no ad is showing, whether or not the tab is
// visible (listening counts). "reading" mode counts while the tab is visible and focused and
// the user did something (key, pointer, scroll, page text changing) within the idle limit.
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
  }

  counting(at) {
    if (this.mode === "video") return this.playing && !this.ad;
    return this.visible && this.focused && at - this.lastActivity < this.idleMs;
  }

  // Moves engaged time up to `at` into pendingMs. In reading mode an idle stretch is credited
  // only up to the moment the idle limit ran out.
  advance(at = this.now()) {
    if (at <= this.since) return;
    if (this.mode === "video") {
      if (this.counting(at)) this.pendingMs += at - this.since;
    } else if (this.visible && this.focused) {
      const end = Math.min(at, this.lastActivity + this.idleMs);
      if (end > this.since) this.pendingMs += end - this.since;
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
}
