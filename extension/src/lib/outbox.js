// Durable outbox for intervals and chat messages, one storage key per item so that extending a
// running interval rewrites one small record. Items stay until the hub accepts them, however long
// that takes.
//
// Interval records: "iv:<id>" -> { i: interval, v: version, dirty, acked_end }
//   `acked_end` is the end_ms of the last copy the hub accepted, or null.
// Chat message records: "cm:<service>:<message_id>" -> message
const IV = "iv:";
const CM = "cm:";
// Sent intervals are kept this long after they end, in case a late span extends them.
export const KEEP_SENT_MS = 10 * 60_000;

export class Outbox {
  constructor(kv) { this.kv = kv; }

  async putIntervals(intervals) {
    if (!intervals.length) return;
    const keys = intervals.map((i) => IV + i.id);
    const cur = await this.kv.get(keys);
    const out = {};
    for (const i of intervals) {
      const prev = cur[IV + i.id];
      out[IV + i.id] = { i, v: (prev?.v ?? 0) + 1, dirty: true, acked_end: prev?.acked_end ?? null };
    }
    await this.kv.set(out);
  }

  async intervalRecords() {
    const keys = (await this.kv.getKeys()).filter((k) => k.startsWith(IV));
    if (!keys.length) return [];
    return Object.values(await this.kv.get(keys));
  }

  async dirtyIntervals(limit = 500) {
    return (await this.intervalRecords()).filter((r) => r.dirty)
      .sort((a, b) => a.i.start_ms - b.i.start_ms).slice(0, limit);
  }

  // After the hub answered: accepted ones become clean (unless they changed meanwhile), rejected
  // ones are removed (resending can't fix them; the caller reports them).
  async markIntervalsSent(sent, rejectedIds = []) {
    const rejected = new Set(rejectedIds);
    const cur = await this.kv.get(sent.map((r) => IV + r.i.id));
    const out = {};
    const drop = [];
    for (const r of sent) {
      const key = IV + r.i.id;
      const now = cur[key];
      if (!now) continue;
      if (rejected.has(r.i.id)) { drop.push(key); continue; }
      out[key] = now.v === r.v ? { ...now, dirty: false, acked_end: r.i.end_ms } : { ...now, acked_end: r.i.end_ms };
    }
    if (drop.length) await this.kv.remove(drop);
    if (Object.keys(out).length) await this.kv.set(out);
  }

  async prune(now) {
    const old = (await this.intervalRecords()).filter((r) => !r.dirty && now - r.i.end_ms > KEEP_SENT_MS);
    if (old.length) await this.kv.remove(old.map((r) => IV + r.i.id));
  }

  // After pairing again the hub may know us as a new device. Time it already accepted stays under
  // the old device; anything after that goes under new ids, so no time is stored twice.
  async rebaseAfterRepair(newId) {
    const recs = await this.intervalRecords();
    const out = {};
    const drop = [];
    for (const r of recs) {
      if (r.acked_end == null) continue; // never accepted: send as is
      drop.push(IV + r.i.id);
      if (r.i.end_ms > r.acked_end) {
        const i = { ...r.i, id: newId(), start_ms: r.acked_end };
        out[IV + i.id] = { i, v: 1, dirty: true, acked_end: null };
      }
    }
    if (drop.length) await this.kv.remove(drop);
    if (Object.keys(out).length) await this.kv.set(out);
  }

  async putMessages(messages) {
    if (!messages.length) return;
    await this.kv.set(Object.fromEntries(messages.map((m) => [`${CM}${m.service}:${m.message_id}`, m])));
  }

  async messageKeys() { return (await this.kv.getKeys()).filter((k) => k.startsWith(CM)); }

  async pendingMessages(limit = 500) {
    const keys = (await this.messageKeys()).slice(0, limit);
    if (!keys.length) return [];
    return Object.values(await this.kv.get(keys));
  }

  async removeMessages(messages) {
    await this.kv.remove(messages.map((m) => `${CM}${m.service}:${m.message_id}`));
  }

  async counts() {
    const keys = await this.kv.getKeys();
    const ivKeys = keys.filter((k) => k.startsWith(IV));
    const recs = ivKeys.length ? Object.values(await this.kv.get(ivKeys)) : [];
    return { intervals: recs.filter((r) => r.dirty).length, messages: keys.filter((k) => k.startsWith(CM)).length };
  }
}
