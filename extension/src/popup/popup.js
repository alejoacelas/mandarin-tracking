// Popup: today's Mandarin minutes from the hub, the hub's status, what's waiting to be sent, and
// any problems.
import { formatMinutes, todayFrom } from "../lib/badge.js";

const $ = (id) => document.getElementById(id);
const SOURCE_NAMES = { youtube: "YouTube", reader: "Reader", llm: "Chats", pleco: "Pleco", app: "Apps" };

const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${Math.max(s, 0)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

function render(st) {
  const day = st.summary?.days?.find((d) => d.date === st.today);
  if (st.summary && st.summary.date === st.today) {
    $("total").textContent = formatMinutes(todayFrom(st.summary, st.today));
    const parts = Object.entries(day?.by_source ?? {}).filter(([, m]) => m > 0).map(([k, m]) => `${SOURCE_NAMES[k] ?? k} ${formatMinutes(m)}`);
    if (day?.unclassified_min > 0) parts.push(`not yet classified ${formatMinutes(day.unclassified_min)}`);
    $("sources").textContent = parts.join(" · ");
  } else {
    $("total").textContent = "–";
    $("sources").textContent = "No numbers from the hub yet today.";
  }

  const h = st.hubStatus ?? {};
  if (h.ok) { $("hub").textContent = `reachable (${ago(h.last_ok_at)})`; $("hub").className = "ok"; }
  else if (h.failures) { $("hub").textContent = h.kind === "unreachable" ? `not answering since ${ago(h.failing_since)}` : "error"; $("hub").className = "bad"; }
  else { $("hub").textContent = "connecting…"; $("hub").className = ""; }

  const c = st.counts ?? {};
  const waiting = [];
  if (c.intervals) waiting.push(`${c.intervals} interval${c.intervals === 1 ? "" : "s"}`);
  if (c.messages) waiting.push(`${c.messages} chat message${c.messages === 1 ? "" : "s"}`);
  $("outbox").textContent = waiting.join(", ") || "nothing";
  $("outbox").className = waiting.length && !h.ok ? "bad" : "";

  const hist = Object.entries(st.historyStatus ?? {}).map(([svc, s]) => {
    const name = svc === "chatgpt" ? "ChatGPT" : svc === "claude" ? "Claude" : svc;
    if (s.signed_in === false) return `${name}: signed out`;
    if (s.last_ok_at) return `${name}: ${ago(s.last_ok_at)}`;
    return `${name}: not yet`;
  });
  $("history").textContent = hist.join(", ") || "not yet";

  const list = $("problems");
  list.replaceChildren(...(st.problems ?? []).map((p) => {
    const li = document.createElement("li");
    li.textContent = p.message;
    const small = document.createElement("small");
    small.textContent = `${p.component}, ${ago(p.at)}`;
    li.append(small);
    return li;
  }));
  if (st.hubUrl) $("dashboard").href = `${st.hubUrl}/`;
}

async function load() {
  const st = await chrome.runtime.sendMessage({ type: "status" });
  if (st?.ok) render(st);
}

load();
// Ask the worker to send what's waiting and fetch fresh numbers, then show them.
chrome.runtime.sendMessage({ type: "pump" }).then(load, load);
