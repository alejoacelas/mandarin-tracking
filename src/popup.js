import { summarize, localDay, formatDuration, SOURCES } from "./summary.js";
import { DEFAULT_SETTINGS } from "./content/messaging.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

async function render() {
  const data = await chrome.storage.local.get(["log", "channels", "settings", "problems", "seenProblemsAt"]);
  const settings = { ...DEFAULT_SETTINGS, ...data.settings };
  const summary = summarize(data.log ?? {}, data.channels ?? {}, settings);
  const today = summary[localDay(new Date())];

  $("today").textContent = formatDuration(today?.totals.mandarin ?? 0);
  const extra = [];
  if (today?.totals.mixed) extra.push(`+ ${formatDuration(today.totals.mixed)} partly Mandarin`);
  if (today?.totals.unclassified) extra.push(`${formatDuration(today.totals.unclassified)} not yet classified`);
  $("today-extra").textContent = extra.join(" · ");

  const sources = $("sources");
  sources.replaceChildren();
  for (const [source, label] of Object.entries(SOURCES)) {
    const s = today?.sources[source];
    if (!s) continue;
    const det = el("details", {}, el("summary", {}, el("span", { textContent: label }), el("span", { textContent: `${formatDuration(s.totals.mandarin)} Mandarin` })));
    for (const item of s.items) {
      const tag = item.cls === "unclassified" && item.channel?.status === "pending" ? "classifying…" : item.cls;
      const share = item.share != null ? ` · ${Math.round(item.share * 100)}% 中文` : "";
      const name = item.url ? el("a", { href: item.url, target: "_blank", textContent: item.title ?? item.key }) : el("span", { textContent: item.title ?? item.key });
      det.append(el("div", { className: "row" }, el("span", { className: "name", title: item.title ?? item.key }, name),
        el("span", { className: `chip ${item.channel?.status === "error" ? "error" : item.cls}`, textContent: tag + share }),
        el("span", { textContent: formatDuration(item.seconds) })));
      if (item.channel?.reason || item.channel?.error) {
        const reason = el("div", { className: "reason", textContent: item.channel.reason ?? item.channel.error });
        const redo = el("button", { textContent: "Reclassify" });
        redo.onclick = () => chrome.runtime.sendMessage({ type: "reclassify", channelUrl: item.key, name: item.title }).then(render);
        reason.append(" ", redo);
        det.append(reason);
      }
    }
    sources.append(det);
  }
  if (!sources.children.length) sources.textContent = "Nothing tracked yet today.";

  const days = $("days");
  days.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const d = localDay(new Date(Date.now() - i * 86400_000));
    days.append(el("div", {}, el("span", { textContent: d }), el("span", { textContent: formatDuration(summary[d]?.totals.mandarin ?? 0) })));
  }

  const unseen = (data.problems ?? []).filter((p) => p.at > (data.seenProblemsAt ?? 0));
  const failedChannels = Object.values(data.channels ?? {}).filter((c) => c.status === "error");
  $("problems").hidden = !unseen.length && !failedChannels.length;
  $("problem-list").replaceChildren(
    ...unseen.map((p) => el("div", { className: "problem", textContent: `${new Date(p.at).toLocaleTimeString()} ${SOURCES[p.source] ?? p.source}: ${p.message}` })),
    ...failedChannels.map((c) => el("div", { className: "problem", textContent: `Channel ${c.name} couldn't be classified: ${c.error}` })),
  );

  $("threshold").value = Math.round(settings.threshold * 100);
  $("idle").value = settings.idleSeconds;
}

async function saveSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const threshold = Math.min(100, Math.max(1, Number($("threshold").value))) / 100;
  const idleSeconds = Math.min(3600, Math.max(10, Number($("idle").value)));
  await chrome.storage.local.set({ settings: { ...settings, threshold, idleSeconds } });
  render();
}
$("threshold").onchange = saveSettings;
$("idle").onchange = saveSettings;
$("dismiss").onclick = () => chrome.runtime.sendMessage({ type: "seenProblems" }).then(render);
$("export").onclick = async () => {
  const data = await chrome.storage.local.get(["log", "channels", "videos", "settings"]);
  const blob = new Blob([JSON.stringify({ format: "mandarin-tracking-extension/1", exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: "application/json" });
  el("a", { href: URL.createObjectURL(blob), download: `mandarin-time-${localDay(new Date())}.json` }).click();
};
render();
