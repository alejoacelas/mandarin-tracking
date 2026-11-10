// Background worker. Turns spans from the content scripts into intervals, keeps them in a durable
// outbox until the hub accepts them, imports chat history from chatgpt.com and claude.ai, and
// keeps the toolbar badge up to date. All state lives in chrome.storage.local, because Chrome
// stops this worker whenever it's idle.
import { chromeKV, serializer } from "../lib/kv.js";
import { applySpans } from "../lib/intervals.js";
import { Outbox } from "../lib/outbox.js";
import { Hub, HubError, DEFAULT_HUB_URL, backoffMs } from "../lib/hub.js";
import { Problems, problemBody } from "../lib/problems.js";
import { ClaudeClient, ChatgptClient, syncService } from "../lib/history.js";
import { READING_MATCHES } from "../lib/sites.js";
import { badgeFor, todayFrom, localDate } from "../lib/badge.js";

const kv = chromeKV();
const serial = serializer();
const outbox = new Outbox(kv);
const problems = new Problems(kv);
const VERSION = chrome.runtime.getManifest().version;
const report = (component, message) => serial(() => problems.report(component, message));
const resolve = (component) => serial(() => problems.resolve(component));

const HEARTBEAT_MS = 10 * 60_000;
const HISTORY_EVERY_MIN = 15;
const OPEN_STALE_MS = 10 * 60_000;
const HUB_DOWN_PROBLEM_MS = 5 * 60_000;

async function settings() {
  const { settings: s = {} } = await kv.get("settings");
  return { idleSeconds: 120, hubUrl: DEFAULT_HUB_URL, ...s };
}

async function deviceName() {
  try {
    const { os } = await chrome.runtime.getPlatformInfo();
    return `Chrome on ${{ mac: "Mac", win: "Windows", linux: "Linux", cros: "ChromeOS" }[os] ?? os}`;
  } catch { return "Chrome"; }
}

async function hub() {
  const s = await settings();
  return new Hub({
    fetch: (...a) => fetch(...a),
    kv,
    baseUrl: s.hubUrl,
    deviceName: await deviceName(),
    onRepaired: () => serial(async () => {
      await outbox.rebaseAfterRepair(() => crypto.randomUUID());
      await kv.set({ open: {} });
    }),
  });
}

// ---------- spans from content scripts ----------

async function addSpans(tabId, desc, spans) {
  const clean = (spans ?? []).filter((s) => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0]);
  if (!clean.length) return;
  await serial(async () => {
    const { open = {} } = await kv.get("open");
    const key = `${tabId}:${desc.source}`;
    const res = applySpans({ open: open[key] ?? null, desc, spans: clean, newId: () => crypto.randomUUID() });
    await outbox.putIntervals(res.changed);
    open[key] = res.open;
    const now = Date.now();
    for (const [k, v] of Object.entries(open)) if (!v || Math.abs(now - v.end_ms) > OPEN_STALE_MS) delete open[k];
    await kv.set({ open });
  });
  soon();
}

// ---------- sending to the hub ----------

let soonTimer = null;
let lastPumpAt = 0;
function soon() {
  if (soonTimer) return;
  const wait = Math.max(1000, 15_000 - (Date.now() - lastPumpAt));
  soonTimer = setTimeout(() => { soonTimer = null; pump(); }, wait);
}

// One run at a time. A call during a run gets a fresh run right after it, so whatever made the
// caller ask (a new problem, a test) is included.
function once(fn) {
  let running = null;
  let queued = null;
  const run = (...a) => {
    if (!running) {
      running = fn(...a).finally(() => { running = null; });
      return running;
    }
    queued ??= running.catch(() => {}).then(() => { queued = null; return run(...a); });
    return queued;
  };
  return run;
}
const pumpRun = once((force) => pumpOnce(force));
function pump({ force = false } = {}) {
  return pumpRun(force);
}

const PROTOCOL_FIELDS = ["id", "source", "start_ms", "end_ms", "language", "zh_share", "units", "app", "title",
  "channel_name", "channel_id", "video_id", "conversation_id", "doc_id", "url", "meta"];
function wire(i) {
  const out = {};
  for (const k of PROTOCOL_FIELDS) out[k] = i[k] ?? null;
  if (typeof out.title === "string") out.title = out.title.slice(0, 500);
  return out;
}

async function sendIntervals(h) {
  for (let round = 0; round < 50; round++) {
    if (!(await outbox.dirtyIntervals(1)).length) return;
    let batch = [];
    const resp = await h.call("POST", "/api/v1/intervals", async () => {
      batch = await outbox.dirtyIntervals(500);
      return { intervals: batch.map((r) => wire(r.i)) };
    });
    if (typeof resp?.accepted !== "number" || (resp.rejected != null && !Array.isArray(resp.rejected))) {
      throw new HubError("bad_response", `The hub's answer to intervals isn't {accepted, rejected}: ${JSON.stringify(resp).slice(0, 200)}`);
    }
    const rejected = resp.rejected ?? [];
    await serial(() => outbox.markIntervalsSent(batch, rejected.map((r) => r.id)));
    if (rejected.length) {
      const sample = rejected.slice(0, 3).map((r) => `${r.id}: ${r.reason}`).join("; ");
      await report("extension.intervals", `The hub rejected ${rejected.length} interval(s), which were dropped: ${sample}`);
    }
  }
}

async function sendMessages(h) {
  for (let round = 0; round < 100; round++) {
    const batch = await outbox.pendingMessages(500);
    if (!batch.length) return;
    const resp = await h.call("POST", "/api/v1/chat-messages", { messages: batch });
    if (typeof resp?.accepted !== "number") {
      throw new HubError("bad_response", `The hub's answer to chat-messages has no accepted count: ${JSON.stringify(resp).slice(0, 200)}`);
    }
    await serial(() => outbox.removeMessages(batch));
    if (resp.accepted < batch.length) {
      await report("extension.chat-messages", `The hub accepted ${resp.accepted} of ${batch.length} chat messages; the rest were dropped as invalid.`);
    }
  }
}

async function sendProblems(h) {
  for (const p of await problems.unsynced()) {
    await h.call("POST", "/api/v1/problems", problemBody(p));
    await serial(() => problems.markSynced(p.component, p.rev));
  }
}

async function sitePermissions() {
  const out = {};
  for (const m of ["https://www.youtube.com/*", ...READING_MATCHES]) {
    const host = new URL(m.replace("/*", "/")).hostname;
    try { out[host] = await chrome.permissions.contains({ origins: [m] }); } catch { out[host] = false; }
  }
  return out;
}

async function heartbeat(h, force) {
  const { lastHeartbeatAt = 0 } = await kv.get("lastHeartbeatAt");
  const now = Date.now();
  if (!force && now - lastHeartbeatAt < HEARTBEAT_MS && lastHeartbeatAt <= now) return;
  await h.call("POST", "/api/v1/heartbeat", { version: VERSION, permissions: await sitePermissions() });
  await kv.set({ lastHeartbeatAt: now });
}

async function refreshSummary(h) {
  const summary = await h.call("GET", "/api/v1/summary?days=7");
  if (!Array.isArray(summary?.days)) throw new HubError("bad_response", "The hub's summary has no days list.");
  await kv.set({ summary: { ...summary, fetched_at: Date.now(), date: localDate(new Date()) } });
}

async function pumpOnce(force) {
  lastPumpAt = Date.now();
  const { hubStatus: st = {} } = await kv.get("hubStatus");
  const now = Date.now();
  // A wait that ends more than the longest backoff away means the clock moved; ignore it.
  if (!force && st.next_try_at && st.next_try_at > now && st.next_try_at - now <= backoffMs(99)) {
    await refreshBadge();
    return;
  }
  try {
    const h = await hub();
    await sendProblems(h);
    await sendIntervals(h);
    await sendMessages(h);
    await heartbeat(h, force);
    await refreshSummary(h);
    await serial(() => outbox.prune(Date.now()));
    await kv.set({ hubStatus: { ok: true, last_ok_at: Date.now(), failures: 0, last_error: null, failing_since: null, next_try_at: null } });
    await resolve("local.hub");
  } catch (e) {
    const failures = (st.failures ?? 0) + 1;
    const failingSince = st.failing_since ?? now;
    const message = String(e.message ?? e).slice(0, 300);
    await kv.set({ hubStatus: { ...st, ok: false, failures, last_error: message, kind: e.kind ?? "error", failing_since: failingSince, next_try_at: Date.now() + backoffMs(failures) } });
    if (e.kind === "pair_refused" || e.kind === "bad_response" || Date.now() - failingSince > HUB_DOWN_PROBLEM_MS) {
      await report("local.hub", e.kind === "unreachable" ? `The hub isn't answering at ${(await settings()).hubUrl}; time is kept here until it's back.` : message);
    }
    const wait = backoffMs(failures);
    if (wait < 60_000) setTimeout(() => pump(), wait);
  }
  await refreshBadge();
}

// ---------- badge ----------

async function refreshBadge() {
  const { summary, hubStatus = {} } = await kv.get(["summary", "hubStatus"]);
  const active = await problems.active();
  const today = localDate(new Date());
  const minutes = summary && summary.date === today && Date.now() - summary.fetched_at < 30 * 60_000 ? todayFrom(summary, today) : null;
  const b = badgeFor({ minutes, problem: active.length > 0 || (!hubStatus.ok && hubStatus.failures > 0 && hubStatus.failing_since && Date.now() - hubStatus.failing_since > HUB_DOWN_PROBLEM_MS) });
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  await chrome.action.setTitle({ title: b.title });
}

// ---------- chat history ----------

const HISTORY = {
  chatgpt: { name: "chatgpt.com", client: () => new ChatgptClient({ fetch: (...a) => fetch(...a) }) },
  claude: { name: "claude.ai", client: () => new ClaudeClient({ fetch: (...a) => fetch(...a) }) },
};
const syncHistory = once(() => syncHistoryOnce());

async function syncHistoryOnce() {
  let more = false;
  for (const [service, { name, client }] of Object.entries(HISTORY)) {
    const stateKey = `history:${service}`;
    const { [stateKey]: state, historyStatus = {} } = await kv.get([stateKey, "historyStatus"]);
    const status = historyStatus[service] ?? {};
    const component = `extension.history.${service}`;
    try {
      const r = await syncService({
        client: client(),
        state,
        save: (st) => kv.set({ [stateKey]: st }),
        emit: (msgs) => serial(() => outbox.putMessages(msgs)),
        now: () => Date.now(),
        sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      });
      more ||= r.remaining > 0;
      await setHistoryStatus(service, { ...status, signed_in: true, ever_ok: true, last_ok_at: Date.now(), last_error: null, failures: 0, last_run: r.conversations, last_messages: r.messages });
      if (r.skipped.length) await report(component, `Skipped ${r.skipped.length} ${name} conversation(s) that couldn't be read: ${r.skipped[0].reason}`);
      else await resolve(component);
    } catch (e) {
      const failures = (status.failures ?? 0) + 1;
      const signedOut = e.kind === "signed_out";
      await setHistoryStatus(service, { ...status, signed_in: !signedOut, last_error: String(e.message ?? e).slice(0, 300), kind: e.kind ?? "error", failures, last_fail_at: Date.now() });
      if (signedOut) {
        // Someone who never used this service in Chrome isn't missing anything.
        if (status.ever_ok) await report(component, `Signed out of ${name} in Chrome, so chats from the ${name} apps aren't being imported. Sign in to ${name} in Chrome to fix it.`);
      } else if (e.kind === "schema" || e.kind === "blocked" || failures >= 3) {
        await report(component, `Couldn't import ${name} chat history: ${e.message}`);
      } else if (!e.kind) {
        await report(component, `Chat history import from ${name} failed: ${e.message ?? e}`);
      }
      if (e.kind === "rate_limited" && e.retryAfterMs) more = false;
    }
  }
  await kv.set({ lastHistoryRunAt: Date.now() });
  // Conversations left over (a long first import) continue in a minute.
  if (more) chrome.alarms.create("history-more", { delayInMinutes: 1 });
  pump();
}

async function setHistoryStatus(service, value) {
  await serial(async () => {
    const { historyStatus = {} } = await kv.get("historyStatus");
    await kv.set({ historyStatus: { ...historyStatus, [service]: value } });
  });
}

async function historyIfDue() {
  const { lastHistoryRunAt = 0 } = await kv.get("lastHistoryRunAt");
  const age = Date.now() - lastHistoryRunAt;
  if (age < 0 || age >= HISTORY_EVERY_MIN * 60_000) syncHistory();
}

// ---------- content scripts in tabs open before install or update ----------

async function injectIntoOpenTabs() {
  for (const cs of chrome.runtime.getManifest().content_scripts ?? []) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: cs.matches }); } catch { continue; }
    for (const tab of tabs) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js, world: cs.world ?? "ISOLATED" }).catch(() => {});
    }
  }
}

// ---------- events ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handlers = {
    spans: () => addSpans(sender.tab?.id ?? "none", msg.desc ?? {}, msg.spans),
    problem: async () => { if (await report(msg.component, msg.message)) { refreshBadge(); soon(); } },
    resolve: async () => { if (await resolve(msg.component)) { refreshBadge(); soon(); } },
    settings: async () => ({ idleSeconds: (await settings()).idleSeconds }),
    status: () => status(),
    pump: () => pump({ force: true }),
    syncHistory: () => syncHistory(),
  };
  const handle = handlers[msg?.type];
  if (!handle) return false;
  handle().then((value) => reply({ ok: true, ...(value ?? {}) }), (e) => reply({ ok: false, error: String(e?.message ?? e) }));
  return true;
});

async function status() {
  const { hubStatus = {}, summary = null, historyStatus = {}, hub: paired = null } = await kv.get(["hubStatus", "summary", "historyStatus", "hub"]);
  return {
    hubStatus, summary, historyStatus,
    paired: !!paired?.token,
    hubUrl: (await settings()).hubUrl,
    counts: await outbox.counts(),
    problems: await problems.active(),
    today: localDate(new Date()),
  };
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pump") { pump(); historyIfDue(); }
  if (a.name === "history" || a.name === "history-more") syncHistory();
});

async function ensureAlarms() {
  if (!(await chrome.alarms.get("pump"))) chrome.alarms.create("pump", { periodInMinutes: 1 });
  if (!(await chrome.alarms.get("history"))) chrome.alarms.create("history", { periodInMinutes: HISTORY_EVERY_MIN });
}

chrome.runtime.onInstalled.addListener(() => { injectIntoOpenTabs(); syncHistory(); });
chrome.runtime.onStartup.addListener(() => { syncHistory(); });
// Every time the worker starts (Chrome starts it for events and stops it when idle).
ensureAlarms();
pump();
historyIfDue();
