// Key-value storage used by the background logic: chrome.storage.local in the extension, a Map in
// unit tests. Every write goes through `serial`, so concurrent events can't overwrite each other.
export class MemoryKV {
  constructor() { this.data = new Map(); }
  async get(keys) {
    const out = {};
    for (const k of [].concat(keys)) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(obj) { for (const [k, v] of Object.entries(obj)) this.data.set(k, structuredClone(v)); }
  async remove(keys) { for (const k of [].concat(keys)) this.data.delete(k); }
  async getKeys() { return [...this.data.keys()]; }
}

export function chromeKV() {
  const s = chrome.storage.local;
  return {
    get: (keys) => s.get(keys),
    set: (obj) => s.set(obj),
    remove: (keys) => s.remove(keys),
    getKeys: () => s.getKeys(),
  };
}

// Runs tasks one after another; a failed task doesn't stop the ones after it.
export function serializer() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}
