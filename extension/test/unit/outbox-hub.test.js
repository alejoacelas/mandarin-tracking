import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "../../src/lib/kv.js";
import { Outbox, KEEP_SENT_MS } from "../../src/lib/outbox.js";
import { Hub, HubError, backoffMs } from "../../src/lib/hub.js";
import { Problems, problemBody } from "../../src/lib/problems.js";

const iv = (id, start, end, over = {}) => ({ id, source: "llm", app: "claude.ai", language: "zh", start_ms: start, end_ms: end, ...over });

test("outbox: dirty intervals stay until accepted; a change during sending keeps them dirty", async () => {
  const ob = new Outbox(new MemoryKV());
  await ob.putIntervals([iv("a", 0, 1000), iv("b", 0, 2000)]);
  const batch = await ob.dirtyIntervals();
  assert.equal(batch.length, 2);
  await ob.putIntervals([iv("a", 0, 5000)]); // extended while the request was in flight
  await ob.markIntervalsSent(batch);
  const dirty = await ob.dirtyIntervals();
  assert.deepEqual(dirty.map((r) => [r.i.id, r.i.end_ms, r.acked_end]), [["a", 5000, 1000]]);
  assert.deepEqual(await ob.counts(), { intervals: 1, messages: 0 });
});

test("outbox: rejected intervals are dropped", async () => {
  const ob = new Outbox(new MemoryKV());
  await ob.putIntervals([iv("a", 0, 1000), iv("b", 0, 1000)]);
  await ob.markIntervalsSent(await ob.dirtyIntervals(), ["b"]);
  assert.equal((await ob.intervalRecords()).length, 1);
});

test("outbox: sent intervals are pruned once they can no longer be extended", async () => {
  const ob = new Outbox(new MemoryKV());
  await ob.putIntervals([iv("old", 0, 1000), iv("new", 0, 100_000_000)]);
  await ob.markIntervalsSent(await ob.dirtyIntervals());
  await ob.prune(1000 + KEEP_SENT_MS + 1);
  assert.deepEqual((await ob.intervalRecords()).map((r) => r.i.id), ["new"]);
});

test("outbox: dirty intervals come out oldest first, at most `limit`", async () => {
  const ob = new Outbox(new MemoryKV());
  await ob.putIntervals([iv("c", 3000, 4000), iv("a", 1000, 2000), iv("b", 2000, 3000)]);
  assert.deepEqual((await ob.dirtyIntervals(2)).map((r) => r.i.id), ["a", "b"]);
});

test("outbox: after pairing again, accepted time stays and only the rest is resent under new ids", async () => {
  const ob = new Outbox(new MemoryKV());
  await ob.putIntervals([iv("acked", 0, 10_000), iv("partly", 0, 10_000), iv("never", 0, 10_000)]);
  await ob.markIntervalsSent((await ob.dirtyIntervals()).filter((r) => r.i.id !== "never"));
  await ob.putIntervals([iv("partly", 0, 15_000)]);
  let n = 0;
  await ob.rebaseAfterRepair(() => `new${++n}`);
  const recs = (await ob.intervalRecords()).sort((a, b) => a.i.id.localeCompare(b.i.id));
  assert.deepEqual(recs.map((r) => [r.i.id, r.i.start_ms, r.i.end_ms, r.dirty]), [["never", 0, 10_000, true], ["new1", 10_000, 15_000, true]]);
});

test("outbox: chat messages are kept by service and id until removed", async () => {
  const ob = new Outbox(new MemoryKV());
  const m = (id) => ({ service: "claude", conversation_id: "c", message_id: id, at_ms: 1, role: "user", zh_share: 1, units: 30 });
  await ob.putMessages([m("1"), m("2"), m("1")]);
  const pending = await ob.pendingMessages();
  assert.equal(pending.length, 2);
  await ob.removeMessages(pending.slice(0, 1));
  assert.equal((await ob.counts()).messages, 1);
});

// A fake hub's fetch: routes by path; `state.tokens` holds the tokens it accepts.
function fakeFetch(state) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    state.calls.push({ path, auth: init.headers?.Authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
    if (state.down) throw new TypeError("Failed to fetch");
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/v1/pair-extension") {
      if (state.refusePair) return json(403, { error: "loopback only" });
      const token = `tok${state.tokens.size + 1}`;
      state.tokens.add(token);
      return json(200, { token, device_id: `dev${state.tokens.size}` });
    }
    if (!state.tokens.has(init.headers?.Authorization?.replace("Bearer ", ""))) return json(401, { error: "unknown token" });
    return json(200, { accepted: 1, rejected: [] });
  };
}

test("hub: pairs on first use, then reuses the token", async () => {
  const state = { calls: [], tokens: new Set() };
  const kv = new MemoryKV();
  const hub = new Hub({ fetch: fakeFetch(state), kv });
  await hub.call("POST", "/api/v1/heartbeat", { version: "1" });
  await hub.call("POST", "/api/v1/heartbeat", { version: "1" });
  assert.deepEqual(state.calls.map((c) => c.path), ["/api/v1/pair-extension", "/api/v1/heartbeat", "/api/v1/heartbeat"]);
  assert.equal(state.calls[0].body.device_name, "Chrome");
  assert.equal(state.calls[2].auth, "Bearer tok1");
  assert.equal((await kv.get("hub")).hub.device_id, "dev1");
});

test("hub: a 401 pairs again, runs onRepaired, and rebuilds the body for the retry", async () => {
  const state = { calls: [], tokens: new Set() };
  let repaired = 0;
  let built = 0;
  const hub = new Hub({ fetch: fakeFetch(state), kv: new MemoryKV(), onRepaired: async () => { repaired++; } });
  await hub.call("GET", "/api/v1/summary");
  state.tokens.clear(); // the hub forgot us
  await hub.call("POST", "/api/v1/intervals", async () => ({ n: ++built }));
  assert.equal(repaired, 1);
  assert.equal(built, 2);
  assert.equal(state.calls.at(-1).auth, "Bearer tok1"); // new set: tok1 again
});

test("hub: unreachable and refused pairing are distinct errors", async () => {
  const down = new Hub({ fetch: fakeFetch({ calls: [], tokens: new Set(), down: true }), kv: new MemoryKV() });
  await assert.rejects(down.call("GET", "/api/v1/summary"), (e) => e instanceof HubError && e.kind === "unreachable");
  const refused = new Hub({ fetch: fakeFetch({ calls: [], tokens: new Set(), refusePair: true }), kv: new MemoryKV() });
  await assert.rejects(refused.call("GET", "/api/v1/summary"), (e) => e.kind === "pair_refused");
});

test("hub: backoff doubles from 5 s and stops at 5 min", () => {
  assert.deepEqual([0, 1, 2, 3, 7, 20].map(backoffMs), [0, 5000, 10_000, 20_000, 300_000, 300_000]);
});

test("problems: one per component, reported once, resolved once, local ones never sent", async () => {
  const p = new Problems(new MemoryKV(), () => 5);
  assert.equal(await p.report("extension.youtube", "broken"), true);
  assert.equal(await p.report("extension.youtube", "broken"), false);
  await p.report("local.hub", "down");
  const unsynced = await p.unsynced();
  assert.deepEqual(unsynced.map(problemBody), [{ component: "extension.youtube", message: "broken" }]);
  await p.markSynced("extension.youtube", unsynced[0].rev);
  assert.deepEqual(await p.unsynced(), []);
  await p.resolve("extension.youtube");
  assert.deepEqual((await p.unsynced()).map(problemBody), [{ component: "extension.youtube", resolved: true }]);
  await p.resolve("local.hub");
  assert.deepEqual(await p.active(), []);
});

test("problems: a resolve that happens while the report is being sent is still sent", async () => {
  const p = new Problems(new MemoryKV());
  await p.report("extension.reader", "no text");
  const [sent] = await p.unsynced();
  await p.resolve("extension.reader");
  await p.markSynced("extension.reader", sent.rev); // the report's answer arrives late
  assert.deepEqual((await p.unsynced()).map(problemBody), [{ component: "extension.reader", resolved: true }]);
});
