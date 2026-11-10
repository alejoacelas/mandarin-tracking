import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeConversation, parseChatgptConversation, newMessages, syncService,
  ClaudeClient, ChatgptClient, HistoryError, LOOKBACK_MS,
} from "../../src/lib/history.js";

const ZH = "我最近在学习中文，每天都会和老师练习口语。你觉得我应该先学汉字还是先练习听力？";
const EN = "I have been thinking about how to plan the project timeline and which tasks come first.";

test("claude: text blocks only, roles mapped, no text in the output", () => {
  const msgs = parseClaudeConversation("c1", {
    chat_messages: [
      { uuid: "m1", sender: "human", created_at: "2026-11-10T10:00:00Z", text: "", content: [{ type: "text", text: ZH }] },
      { uuid: "m2", sender: "assistant", created_at: "2026-11-10T10:00:05.123Z", text: "", content: [
        { type: "thinking", thinking: EN.repeat(10) }, { type: "tool_use", input: {} }, { type: "text", text: ZH }] },
      { uuid: "m3", sender: "human", created_at: "2026-11-10T10:01:00Z", content: [] }, // a file only
    ],
  });
  assert.deepEqual(msgs.map((m) => [m.message_id, m.role, m.at_ms, m.units > 20, m.zh_share]), [
    ["m1", "user", Date.parse("2026-11-10T10:00:00Z"), true, 1],
    ["m2", "assistant", Date.parse("2026-11-10T10:00:05.123Z"), true, 1],
    ["m3", "user", Date.parse("2026-11-10T10:01:00Z"), false, null],
  ]);
  for (const m of msgs) assert.deepEqual(Object.keys(m).sort(), ["at_ms", "conversation_id", "message_id", "role", "service", "units", "zh_share"]);
});

test("claude: a changed shape is a schema error", () => {
  assert.throws(() => parseClaudeConversation("c1", { messages: [] }), (e) => e.kind === "schema");
  assert.throws(() => parseClaudeConversation("c1", { chat_messages: [{ sender: "human", content: [] }] }), (e) => e.kind === "schema");
});

test("chatgpt: user and assistant text only; tool calls, thoughts and hidden messages skipped", () => {
  const node = (id, role, type, parts, extra = {}) => ({ id, message: { id, author: { role }, create_time: 1793177364.27, recipient: "all", content: { content_type: type, parts }, metadata: {}, ...extra } });
  const msgs = parseChatgptConversation("g1", {
    mapping: {
      root: { id: "root", message: null },
      s: node("s", "system", "text", [""], { metadata: { is_visually_hidden_from_conversation: true } }),
      u: node("u", "user", "text", [ZH]),
      img: node("img", "user", "multimodal_text", [{ content_type: "image_asset_pointer" }, EN]),
      th: node("th", "assistant", "thoughts", undefined),
      tool: node("tool", "assistant", "text", ["search"], { recipient: "web.run" }),
      a: node("a", "assistant", "text", [EN]),
      t: node("t", "tool", "text", ["result"]),
    },
  });
  assert.deepEqual(msgs.map((m) => [m.message_id, m.role, m.at_ms]).sort(), [["a", "assistant", 1793177364270], ["img", "user", 1793177364270], ["u", "user", 1793177364270]]);
  assert.equal(msgs.find((m) => m.message_id === "u").zh_share, 1);
  assert.equal(msgs.find((m) => m.message_id === "a").zh_share, 0);
});

test("chatgpt: a message without create_time is a schema error", () => {
  assert.throws(() => parseChatgptConversation("g", { mapping: { u: { message: { id: "u", author: { role: "user" }, create_time: null, content: { content_type: "text", parts: ["x"] } } } } }), (e) => e.kind === "schema");
});

test("newMessages keeps those at or after the newest already sent", () => {
  const ms = [10, 20, 30].map((at) => ({ message_id: String(at), at_ms: at }));
  assert.deepEqual(newMessages(ms, null).length, 3);
  assert.deepEqual(newMessages(ms, 20).map((m) => m.at_ms), [20, 30]);
});

// ---------- clients against fake endpoints ----------

function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function claudeFetch(conversations, { status = 200, page } = {}) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (status !== 200) return jsonResponse(status, { error: { type: "permission_error" } });
    if (u.pathname === "/api/organizations") return jsonResponse(200, [{ uuid: "api-org", capabilities: ["api"] }, { uuid: "org1", capabilities: ["chat", "claude_max"] }]);
    const m = u.pathname.match(/chat_conversations\/(.+)$/);
    if (m) return jsonResponse(200, { chat_messages: conversations.find((c) => c.uuid === m[1]).messages });
    const limit = Number(u.searchParams.get("limit")), offset = Number(u.searchParams.get("offset"));
    const sorted = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return jsonResponse(200, (page ?? sorted).slice(offset, offset + limit).map(({ uuid, updated_at }) => ({ uuid, updated_at })));
  };
  f.calls = calls;
  return f;
}
const conv = (uuid, minute, texts) => ({
  uuid, updated_at: `2026-11-10T10:${String(minute).padStart(2, "0")}:00Z`,
  messages: texts.map((t, i) => ({ uuid: `${uuid}-m${i}`, sender: i % 2 ? "assistant" : "human", created_at: `2026-11-10T10:${String(minute).padStart(2, "0")}:0${i}Z`, content: [{ type: "text", text: t }] })),
});

test("claude client: uses only chat organizations, pages until older conversations", async () => {
  const convs = Array.from({ length: 7 }, (_, i) => conv(`c${i}`, i + 1, [ZH]));
  const f = claudeFetch(convs);
  const client = new ClaudeClient({ fetch: f, pageSize: 3 });
  const list = await client.listUpdatedSince(Date.parse("2026-11-10T10:03:30Z"));
  assert.deepEqual(list.map((c) => c.id), ["c6", "c5", "c4", "c3"]);
  assert.ok(f.calls.every((c) => !c.includes("api-org")));
  assert.equal(f.calls.filter((c) => c.includes("offset=")).length, 2, "stops at the first older conversation");
});

test("claude client: 401/403 JSON means signed out; 429 is rate limited with Retry-After; HTML is blocked", async () => {
  await assert.rejects(new ClaudeClient({ fetch: claudeFetch([], { status: 403 }) }).listUpdatedSince(0), (e) => e.kind === "signed_out");
  const limited = async () => jsonResponse(429, { error: "rate" }, { "retry-after": "30" });
  await assert.rejects(new ClaudeClient({ fetch: limited }).listUpdatedSince(0), (e) => e.kind === "rate_limited" && e.retryAfterMs === 30_000);
  const html = async () => new Response("<html>Just a moment...</html>", { status: 403, headers: { "content-type": "text/html" } });
  await assert.rejects(new ClaudeClient({ fetch: html }).listUpdatedSince(0), (e) => e.kind === "blocked");
  const net = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(new ClaudeClient({ fetch: net }).listUpdatedSince(0), (e) => e.kind === "network");
});

function chatgptFetch(items, { signedIn = true, expireOnce = false } = {}) {
  let expired = expireOnce;
  let session = 0;
  const f = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/api/auth/session") { session++; return jsonResponse(200, signedIn ? { accessToken: `t${session}` } : {}); }
    // Like the real endpoint: without a token the list is empty, not an error.
    if (!init.headers?.Authorization) return jsonResponse(200, { items: [], total: 0 });
    if (expired) { expired = false; return jsonResponse(401, { detail: "expired" }); }
    if (u.pathname === "/backend-api/conversations") {
      const offset = Number(u.searchParams.get("offset")), limit = Number(u.searchParams.get("limit"));
      return jsonResponse(200, { items: items.slice(offset, offset + limit), total: 6 });
    }
    const id = u.pathname.split("/").pop();
    return jsonResponse(200, { mapping: { [id + "u"]: { message: { id: id + "u", author: { role: "user" }, create_time: 1793177364, recipient: "all", content: { content_type: "text", parts: [ZH] } } } } });
  };
  f.sessions = () => session;
  return f;
}

test("chatgpt client: sends the session's access token; handles ISO and numeric update times", async () => {
  const items = [{ id: "a", update_time: "2026-11-10T10:05:00Z" }, { id: "b", update_time: 1793174400 }, { id: "c", update_time: "2026-01-01T00:00:00Z" }];
  const list = await new ChatgptClient({ fetch: chatgptFetch(items) }).listUpdatedSince(Date.parse("2026-06-01T00:00:00Z"));
  assert.deepEqual(list.map((c) => c.id), ["a", "b"]);
  assert.equal(list[1].updated_ms, 1793174400000);
});

test("chatgpt client: signed out is an error, not an empty list; an expired token is refreshed once", async () => {
  await assert.rejects(new ChatgptClient({ fetch: chatgptFetch([], { signedIn: false }) }).listUpdatedSince(0), (e) => e.kind === "signed_out");
  const f = chatgptFetch([{ id: "a", update_time: "2026-11-10T10:05:00Z" }], { expireOnce: true });
  const list = await new ChatgptClient({ fetch: f }).listUpdatedSince(0);
  assert.equal(list.length, 1);
  assert.equal(f.sessions(), 2);
});

test("chatgpt client: an items list missing is a schema error", async () => {
  const f = async (url) => (new URL(url).pathname === "/api/auth/session" ? jsonResponse(200, { accessToken: "t" }) : jsonResponse(200, { conversations: [] }));
  await assert.rejects(new ChatgptClient({ fetch: f }).listUpdatedSince(0), (e) => e.kind === "schema");
});

// ---------- the sync run ----------

function fakeClient(convs, { failOn = null } = {}) {
  return {
    listed: 0,
    async listUpdatedSince(since) { this.listed++; return convs.filter((c) => c.updated_ms > since).map(({ id, updated_ms }) => ({ id, updated_ms })); },
    async messages({ id }) {
      if (failOn?.[id]) throw failOn[id];
      return convs.find((c) => c.id === id).messages.map((at) => ({ service: "claude", conversation_id: id, message_id: `${id}@${at}`, at_ms: at, role: "user", zh_share: 1, units: 30 }));
    },
  };
}
const NOW = 1_800_000_000_000;

async function syncLoop(client, state, opts = {}) {
  const sent = [];
  let saved = state;
  const r = await syncService({ client, state, save: async (s) => { saved = s; }, emit: async (m) => { sent.push(...m); }, now: () => NOW, ...opts });
  return { r, sent, saved };
}

test("sync: first run imports the lookback window; the next only what changed since", async () => {
  const convs = [
    { id: "old", updated_ms: NOW - LOOKBACK_MS - 1000, messages: [1] },
    { id: "a", updated_ms: NOW - 5000, messages: [NOW - 9000, NOW - 5000] },
    { id: "b", updated_ms: NOW - 4000, messages: [NOW - 4000] },
  ];
  const client = fakeClient(convs);
  const first = await syncLoop(client, undefined);
  assert.deepEqual(first.sent.map((m) => m.message_id).sort(), ["a@" + (NOW - 5000), "a@" + (NOW - 9000), "b@" + (NOW - 4000)].sort());
  assert.equal(first.saved.cursor_ms, NOW - 4000);

  convs[1].updated_ms = NOW - 1000;
  convs[1].messages.push(NOW - 1000);
  const second = await syncLoop(client, first.saved);
  // The boundary message is sent again (harmless), plus the new one; "b" isn't fetched.
  assert.deepEqual(second.sent.map((m) => m.message_id), ["a@" + (NOW - 5000), "a@" + (NOW - 1000)]);
  assert.equal(second.r.conversations, 1);
});

test("sync: a run stopped by an error resumes with the conversations still pending", async () => {
  const convs = [1, 2, 3].map((n) => ({ id: `c${n}`, updated_ms: NOW - 10_000 + n, messages: [NOW - 10_000 + n] }));
  const limited = new HistoryError("rate_limited", "429");
  const client = fakeClient(convs, { failOn: { c2: limited } });
  const run1 = await syncService({ client, state: undefined, save: async (s) => { run1State = s; }, emit: async () => {}, now: () => NOW }).catch((e) => e);
  var run1State;
  assert.equal(run1.kind, "rate_limited");
  assert.deepEqual(run1State.pending.map((p) => p.id), ["c2", "c1"]); // newest first; c3 was done
  assert.equal(run1State.cursor_ms, null, "the cursor moves only when every listed conversation is done");

  const client2 = fakeClient(convs);
  const run2 = await syncLoop(client2, run1State);
  assert.equal(client2.listed, 0, "no new listing while conversations are pending");
  assert.deepEqual(run2.sent.map((m) => m.conversation_id), ["c2", "c1"]);
  assert.equal(run2.saved.cursor_ms, NOW - 10_000 + 3);
});

test("sync: a conversation that can't be read is skipped and reported, not retried forever", async () => {
  const convs = [1, 2].map((n) => ({ id: `c${n}`, updated_ms: NOW - 100 + n, messages: [NOW - 100 + n] }));
  const client = fakeClient(convs, { failOn: { c1: new HistoryError("schema", "shape") } });
  const { r, sent } = await syncLoop(client, undefined);
  assert.deepEqual(r.skipped.map((s) => s.id), ["c1"]);
  assert.deepEqual(sent.map((m) => m.conversation_id), ["c2"]);
  assert.equal(r.remaining, 0);
});

test("sync: at most maxConversations per run, with a pause between requests", async () => {
  const convs = Array.from({ length: 5 }, (_, n) => ({ id: `c${n}`, updated_ms: NOW - 100 + n, messages: [NOW - 100 + n] }));
  const pauses = [];
  const { r, saved } = await syncLoop(fakeClient(convs), undefined, { maxConversations: 3, sleep: async (ms) => pauses.push(ms), delayMs: 1200 });
  assert.equal(r.conversations, 3);
  assert.equal(r.remaining, 2);
  assert.deepEqual(pauses, [1200, 1200]);
  assert.equal(saved.pending.length, 2);
});
