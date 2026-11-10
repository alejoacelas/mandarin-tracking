// Content-script side of talking to the background worker.
//
// Spans wait in a queue until the worker confirms it stored them. When the extension is reloaded
// or updated, the old copy of a content script can't reach the worker any more; the new copy
// claims the page, and the old one hands its unsent spans over through a DOM attribute.

let contextGone = false;
const extensionAlive = () => !contextGone && !!globalThis.chrome?.runtime?.id;

// Resolves the worker's reply, or null when it couldn't be reached.
export async function send(message) {
  if (!extensionAlive()) return null;
  try {
    return (await chrome.runtime.sendMessage(message)) ?? null;
  } catch {
    if (!chrome.runtime?.id) contextGone = true;
    return null;
  }
}

export function reportProblem(component, message) {
  send({ type: "problem", component, message, url: location.href });
}
export function resolveProblem(component) {
  send({ type: "resolve", component });
}

export class Page {
  // name: which content script ("youtube" or "reading").
  constructor(name) {
    this.attr = `mt${name[0].toUpperCase()}${name.slice(1)}`;
    this.handoffAttr = `${this.attr}Handoff`;
    this.token = Math.random().toString(36).slice(2);
    document.documentElement.dataset[this.attr] = this.token;
    this.queue = []; // [{ desc, spans }]
    this.sending = false;
    this.stopped = false;
  }

  // False once a newer copy of this script took over the page.
  owns() {
    return document.documentElement.dataset[this.attr] === this.token;
  }

  push(desc, spans) {
    if (!spans.length) return;
    const last = this.queue.at(-1);
    if (last && JSON.stringify(last.desc) === JSON.stringify(desc)) last.spans.push(...spans);
    else this.queue.push({ desc, spans: [...spans] });
  }

  // Hands queued spans to the copy that took over, and stops.
  handOff(extraDesc, extraSpans) {
    if (this.stopped) return;
    this.stopped = true;
    if (extraSpans?.length) this.push(extraDesc, extraSpans);
    if (!this.queue.length) return;
    const d = document.documentElement.dataset;
    let prev = [];
    try { prev = JSON.parse(d[this.handoffAttr] || "[]"); } catch { prev = []; }
    d[this.handoffAttr] = JSON.stringify([...prev, ...this.queue]);
    this.queue = [];
  }

  // Picks up spans an older copy left behind.
  adoptHandoff() {
    const d = document.documentElement.dataset;
    const raw = d[this.handoffAttr];
    if (!raw) return;
    delete d[this.handoffAttr];
    try {
      const items = JSON.parse(raw);
      this.queue.unshift(...items.filter((x) => x?.desc && Array.isArray(x.spans)));
    } catch { /* malformed: nothing to adopt */ }
  }

  async flush() {
    if (this.sending || this.stopped) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        const n = item.spans.length; // push() may add more while this is in flight
        const reply = await send({ type: "spans", desc: item.desc, spans: item.spans.slice(0, n) });
        if (!reply?.ok) break; // kept; retried on the next flush
        item.spans.splice(0, n);
        const at = this.queue.indexOf(item);
        if (!item.spans.length && at >= 0) this.queue.splice(at, 1);
      }
    } finally {
      this.sending = false;
    }
  }
}
