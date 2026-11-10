// Chat history import from the endpoints chatgpt.com's and claude.ai's own web apps use. This
// history includes chats from the phone and desktop apps. Each message becomes
// { service, conversation_id, message_id, at_ms, role, zh_share, units }; message text never
// leaves this file.
//
// Endpoint shapes (checked live on 2026-11-10):
// claude.ai   GET /api/organizations -> [{ uuid, capabilities: ["chat", ...] }]
//             GET /api/organizations/{org}/chat_conversations?limit=&offset=
//                 -> [{ uuid, updated_at (ISO) }], newest update first
//             GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages
//                 -> { chat_messages: [{ uuid, sender: human|assistant, created_at, content: [{ type, text }] }] }
// chatgpt.com GET /api/auth/session -> { accessToken } (no accessToken when signed out)
//             GET /backend-api/conversations?offset=&limit=&order=updated (Bearer token)
//                 -> { items: [{ id, update_time (ISO, or seconds in older answers) }] }, newest first.
//                 Without the token it answers 200 with no items, so the token is required.
//             GET /backend-api/conversation/{id} -> { mapping: { [node]: { message: { id, author: { role },
//                 create_time (seconds), recipient, content: { content_type, parts }, metadata } } } }
import { chineseShare } from "./chinese.js";

export const LOOKBACK_MS = 30 * 24 * 3600_000; // how far back the first import goes
export const CONVERSATIONS_PER_RUN = 150;

export class HistoryError extends Error {
  // kind: "signed_out", "rate_limited", "blocked" (an HTML challenge page instead of JSON),
  // "schema" (the answer's shape changed), "http", "network"
  constructor(kind, message, { retryAfterMs = null, status = null } = {}) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

function schema(service, what) {
  return new HistoryError("schema", `${service} history answer changed shape: ${what}`);
}

const toMs = (t) => {
  if (typeof t === "number" && Number.isFinite(t)) return t < 1e11 ? Math.round(t * 1000) : Math.round(t);
  if (typeof t === "string") { const ms = Date.parse(t); return Number.isFinite(ms) ? ms : null; }
  return null;
};

function measured(service, conversationId, messageId, atMs, role, text) {
  const { share, units } = chineseShare(text);
  return { service, conversation_id: conversationId, message_id: String(messageId), at_ms: atMs, role, zh_share: units ? share : null, units };
}

// ---------- claude.ai ----------

export function parseClaudeConversation(conversationId, detail) {
  if (!detail || !Array.isArray(detail.chat_messages)) throw schema("claude.ai", "no chat_messages list");
  const out = [];
  for (const m of detail.chat_messages) {
    const role = m?.sender === "human" ? "user" : m?.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    const at = toMs(m.created_at);
    if (!m.uuid || at == null) throw schema("claude.ai", "a message has no uuid or created_at");
    let text;
    if (Array.isArray(m.content)) text = m.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    else if (typeof m.text === "string") text = m.text;
    else throw schema("claude.ai", "a message has neither content blocks nor text");
    out.push(measured("claude", conversationId, m.uuid, at, role, text));
  }
  return out;
}

// ---------- chatgpt.com ----------

export function parseChatgptConversation(conversationId, detail) {
  if (!detail || typeof detail.mapping !== "object" || detail.mapping === null) throw schema("chatgpt.com", "no mapping");
  const out = [];
  for (const node of Object.values(detail.mapping)) {
    const m = node?.message;
    if (!m) continue;
    const role = m.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (m.recipient && m.recipient !== "all") continue; // tool calls
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    const type = m.content?.content_type;
    if (type !== "text" && type !== "multimodal_text") continue; // thoughts, code, ...
    const at = toMs(m.create_time);
    if (!m.id || at == null) throw schema("chatgpt.com", "a message has no id or create_time");
    const text = (m.content.parts ?? []).filter((p) => typeof p === "string").join("\n");
    out.push(measured("chatgpt", conversationId, m.id, at, role, text));
  }
  return out;
}

// ---------- HTTP ----------

async function getJson(fetch, service, url, init = {}) {
  let r;
  try {
    r = await fetch(url, { credentials: "include", cache: "no-store", ...init });
  } catch (e) {
    throw new HistoryError("network", `Can't reach ${service}: ${e.message ?? e}`);
  }
  const type = r.headers.get("content-type") ?? "";
  if (r.status === 429) {
    const ra = Number(r.headers.get("retry-after"));
    throw new HistoryError("rate_limited", `${service} is rate limiting history requests (429).`, { retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null, status: 429 });
  }
  if (!type.includes("json") && (r.status === 403 || r.status === 503 || type.includes("html"))) {
    throw new HistoryError("blocked", `${service} answered with a web page instead of data (${r.status}); it may want a browser check. Open ${service} in a tab once.`, { status: r.status });
  }
  if (r.status === 401 || r.status === 403) throw new HistoryError("signed_out", `Not signed in to ${service} in this Chrome profile (${r.status}).`, { status: r.status });
  if (!r.ok) throw new HistoryError("http", `${service} returned ${r.status} for ${new URL(url).pathname}.`, { status: r.status });
  try {
    return await r.json();
  } catch {
    throw schema(service, `${new URL(url).pathname} didn't return JSON`);
  }
}

// Clients list conversations updated after `sinceMs` (newest first, stopping at the first older
// one) and fetch one conversation's messages.
export class ClaudeClient {
  constructor({ fetch, base = "https://claude.ai", pageSize = 50 }) {
    this.fetch = fetch; this.base = base; this.pageSize = pageSize;
    this.service = "claude.ai";
  }

  async listUpdatedSince(sinceMs) {
    const orgs = await getJson(this.fetch, this.service, `${this.base}/api/organizations`);
    if (!Array.isArray(orgs)) throw schema(this.service, "organizations isn't a list");
    const chatOrgs = orgs.filter((o) => Array.isArray(o?.capabilities) && o.capabilities.includes("chat") && o.uuid);
    if (!chatOrgs.length) throw schema(this.service, "no organization has the chat capability");
    const out = [];
    for (const org of chatOrgs) {
      for (let offset = 0; ; offset += this.pageSize) {
        const page = await getJson(this.fetch, this.service, `${this.base}/api/organizations/${org.uuid}/chat_conversations?limit=${this.pageSize}&offset=${offset}`);
        if (!Array.isArray(page)) throw schema(this.service, "chat_conversations isn't a list");
        let older = false;
        for (const c of page) {
          const updated = toMs(c?.updated_at);
          if (!c?.uuid || updated == null) throw schema(this.service, "a conversation has no uuid or updated_at");
          if (updated <= sinceMs) { older = true; break; }
          out.push({ id: c.uuid, updated_ms: updated, org: org.uuid });
        }
        if (older || page.length < this.pageSize) break;
      }
    }
    return out;
  }

  async messages(conv) {
    const detail = await getJson(this.fetch, this.service,
      `${this.base}/api/organizations/${conv.org}/chat_conversations/${conv.id}?tree=True&rendering_mode=messages&render_all_tools=true`);
    return parseClaudeConversation(conv.id, detail);
  }
}

export class ChatgptClient {
  constructor({ fetch, base = "https://chatgpt.com", pageSize = 100 }) {
    this.fetch = fetch; this.base = base; this.pageSize = pageSize;
    this.service = "chatgpt.com";
    this.accessToken = null;
  }

  async session(force = false) {
    if (this.accessToken && !force) return this.accessToken;
    const s = await getJson(this.fetch, this.service, `${this.base}/api/auth/session`);
    if (!s || typeof s !== "object") throw schema(this.service, "session isn't an object");
    if (!s.accessToken) throw new HistoryError("signed_out", "Not signed in to chatgpt.com in this Chrome profile.");
    this.accessToken = s.accessToken;
    return s.accessToken;
  }

  async api(path) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.session(attempt > 0);
      try {
        return await getJson(this.fetch, this.service, this.base + path, { headers: { Authorization: `Bearer ${token}` } });
      } catch (e) {
        // An expired access token: get a fresh one from the session once.
        if (e.kind === "signed_out" && attempt === 0) continue;
        throw e;
      }
    }
  }

  async listUpdatedSince(sinceMs) {
    const out = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const page = await this.api(`/backend-api/conversations?offset=${offset}&limit=${this.pageSize}&order=updated`);
      if (!page || !Array.isArray(page.items)) throw schema(this.service, "conversations has no items list");
      let older = false;
      for (const c of page.items) {
        const updated = toMs(c?.update_time);
        if (!c?.id || updated == null) throw schema(this.service, "a conversation has no id or update_time");
        if (updated <= sinceMs) { older = true; break; }
        out.push({ id: c.id, updated_ms: updated });
      }
      if (older || page.items.length < this.pageSize) break;
    }
    return out;
  }

  async messages(conv) {
    return parseChatgptConversation(conv.id, await this.api(`/backend-api/conversation/${conv.id}`));
  }
}

// Messages not yet sent for a conversation: those at or after the newest one sent before.
// (Resending the boundary message is harmless; the hub saves by message id.)
export function newMessages(messages, seenUntilMs) {
  if (seenUntilMs == null) return messages;
  return messages.filter((m) => m.at_ms >= seenUntilMs);
}

// One sync run for one service. `state` is the service's saved progress:
//   { cursor_ms, next_cursor_ms, pending: [{ id, updated_ms, org }], seen: { [id]: ms } }
// It's saved through `save` after every conversation, so a stopped worker resumes where it was.
// `emit(messages)` must store messages durably before it resolves.
export async function syncService({ client, state, save, emit, now, sleep = async () => {}, delayMs = 1000, maxConversations = CONVERSATIONS_PER_RUN }) {
  const st = { cursor_ms: null, next_cursor_ms: null, pending: [], seen: {}, ...structuredClone(state ?? {}) };
  if (!st.pending.length) {
    const since = st.cursor_ms ?? now() - LOOKBACK_MS;
    const list = await client.listUpdatedSince(since);
    st.pending = list.sort((a, b) => a.updated_ms - b.updated_ms);
    st.next_cursor_ms = Math.max(since, ...list.map((c) => c.updated_ms));
    await save(st);
  }
  let done = 0;
  let sent = 0;
  const skipped = [];
  while (st.pending.length && done < maxConversations) {
    const conv = st.pending[0];
    if (done > 0) await sleep(delayMs);
    let msgs;
    try {
      msgs = newMessages(await client.messages(conv), st.seen[conv.id]);
    } catch (e) {
      // One conversation that can't be read (deleted meanwhile, or an unknown shape) mustn't block
      // the rest; the caller reports what was skipped. Anything else stops the run and the
      // conversation stays pending.
      if (!(e.kind === "schema" || (e.kind === "http" && e.status === 404))) throw e;
      skipped.push({ id: conv.id, reason: e.message });
      msgs = [];
    }
    if (msgs.length) await emit(msgs);
    sent += msgs.length;
    const newest = Math.max(st.seen[conv.id] ?? 0, ...msgs.map((m) => m.at_ms));
    if (newest > 0) st.seen[conv.id] = newest;
    st.pending.shift();
    done++;
    if (!st.pending.length) st.cursor_ms = st.next_cursor_ms;
    await save(st);
  }
  // Forget conversations not touched within the lookback window.
  const cutoff = now() - LOOKBACK_MS;
  for (const [id, ms] of Object.entries(st.seen)) if (ms < cutoff) delete st.seen[id];
  await save(st);
  return { conversations: done, messages: sent, remaining: st.pending.length, skipped, state: st };
}
