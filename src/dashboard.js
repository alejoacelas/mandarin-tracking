// The extension's view of tracked time: the last 7 days as bars, then the selected day's
// Mandarin total and its breakdown per source, channel, chat and document. Opens as the toolbar
// popup (dashboard.html?popup) and as a full tab (dashboard.html). Re-renders when storage changes.
import { summarize, localDay, formatDuration, SOURCES } from "./summary.js";
import { DEFAULT_SETTINGS } from "./content/messaging.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const inPopup = new URLSearchParams(location.search).has("popup");
if (inPopup) document.body.classList.add("popup");

const TAG = { mandarin: "Mandarin", mixed: "Partly Mandarin", other: "Not Mandarin", unclassified: "Waiting for a label" };
const COLOR = { mandarin: "var(--zh)", mixed: "var(--mixed)", other: "var(--other)", unclassified: "var(--line)" };
let selected = localDay(new Date());

function lastDays(n) {
  return Array.from({ length: n }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (n - 1 - i)); return d; });
}

async function render() {
  const data = await chrome.storage.local.get(["log", "channels", "settings", "problems", "seenProblemsAt", "readerApi"]);
  const settings = { ...DEFAULT_SETTINGS, ...data.settings };
  const summary = summarize(data.log ?? {}, data.channels ?? {}, settings);
  const today = localDay(new Date());

  // Week bars, scaled to the busiest day.
  const days = lastDays(7);
  const max = Math.max(60, ...days.map((d) => summary[localDay(d)]?.totals.mandarin ?? 0));
  let weekTotal = 0;
  $("week").replaceChildren(...days.map((d) => {
    const key = localDay(d);
    const s = summary[key]?.totals.mandarin ?? 0;
    weekTotal += s;
    const b = el("button", { className: `day${key === selected ? " sel" : ""}`, title: key },
      el("span", { className: "t", textContent: s ? shortDuration(s) : "–" }),
      el("div", { className: "bar" }, el("div", { style: `height:${(s / max) * 100}%` })),
      el("span", { className: "d", textContent: key === today ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" }) }));
    b.onclick = () => { selected = key; render(); };
    return b;
  }));
  $("week-total").textContent = `${formatDuration(weekTotal)} of Mandarin in the last 7 days`;

  // Selected day.
  const day = summary[selected];
  const t = day?.totals ?? { mandarin: 0, mixed: 0, other: 0, unclassified: 0 };
  const date = new Date(`${selected}T12:00`);
  $("day-title").textContent = selected === today ? "Today" : date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("total").replaceChildren(formatDuration(t.mandarin), el("small", { textContent: " of Mandarin" }));
  const extra = [];
  if (t.mixed) extra.push(`plus ${formatDuration(t.mixed)} partly Mandarin`);
  if (t.unclassified) extra.push(`${formatDuration(t.unclassified)} waiting for a label`);
  if (t.other) extra.push(`${formatDuration(t.other)} not Mandarin`);
  $("total-extra").textContent = extra.join(" · ");
  const all = t.mandarin + t.mixed + t.other + t.unclassified;
  $("split").replaceChildren(...(all ? ["mandarin", "mixed", "other", "unclassified"] : []).map((c) =>
    el("div", { style: `width:${(t[c] / all) * 100}%;background:${COLOR[c]}`, title: `${TAG[c]}: ${formatDuration(t[c])}` })));

  // Per source: Mandarin and partly Mandarin first, the rest folded away.
  const sources = $("sources");
  sources.replaceChildren();
  for (const [source, label] of Object.entries(SOURCES)) {
    const s = day?.sources[source];
    if (!s || !s.items.some((i) => i.seconds >= 30)) continue;
    const top = Math.max(...s.items.map((i) => i.seconds));
    const card = el("div", { className: "card" }, el("div", { className: "src-head" }, el("b", { textContent: label }),
      el("span", { textContent: `${formatDuration(s.totals.mandarin)} Mandarin` })));
    const shown = s.items.filter((i) => i.cls !== "other");
    const rest = s.items.filter((i) => i.cls === "other" && i.seconds >= 30);
    for (const item of shown) card.append(row(source, item, top));
    if (rest.length) {
      const sum = rest.reduce((a, i) => a + i.seconds, 0);
      card.append(el("details", { className: "rest" }, el("summary", { textContent: `Not Mandarin: ${rest.length} ${rest.length === 1 ? "item" : "items"}, ${formatDuration(sum)}` }),
        ...rest.map((i) => row(source, i, top))));
    }
    sources.append(card);
  }
  if (!sources.children.length) {
    sources.append(el("div", { className: "card empty", textContent: selected === today
      ? "Nothing tracked yet today. Play a YouTube video, or read in Reader, Claude or ChatGPT, and it shows up here within a few seconds."
      : "Nothing tracked on this day." }));
  }

  // Problems.
  const unseen = (data.problems ?? []).filter((p) => p.at > (data.seenProblemsAt ?? 0));
  const failed = Object.values(data.channels ?? {}).filter((c) => c.status === "error");
  $("problems").hidden = !unseen.length && !failed.length;
  $("problem-list").replaceChildren(
    ...failed.map((c) => el("p", { textContent: `Couldn't label the channel ${c.name}. Its time waits until a retry works (see the channel below).` })),
    ...unseen.map((p) => el("p", { textContent: `${new Date(p.at).toLocaleString()} · ${SOURCES[p.source] ?? p.source}: ${p.message}` })),
  );
  $("dismiss").hidden = !unseen.length;

  if (document.activeElement?.tagName !== "INPUT") {
    $("threshold").value = Math.round(settings.threshold * 100);
    $("idle").value = settings.idleSeconds;
    $("readwise").value = settings.readwiseToken ?? "";
  }
  const lastPoll = data.readerApi?.lastPollAt;
  $("reader-status").textContent = settings.readwiseToken ? (lastPoll ? `Reader API last checked ${new Date(lastPoll).toLocaleTimeString()}` : "Reader API not checked yet") : "";
}

function row(source, item, top) {
  const name = item.title ?? item.key;
  const c = item.channel;
  let tag = TAG[item.cls], tagClass = item.cls;
  if (c?.status === "pending") tag = "Labelling…";
  if (c?.status === "error") { tag = "Couldn't label"; tagClass = "bad"; }
  if (item.share != null && source !== "youtube") tag += ` · ${Math.round(item.share * 100)}% 中文`;
  const r = el("div", { className: `item${item.cls === "other" ? " dim" : ""}` },
    el("span", { className: "name", title: name }, item.url ? el("a", { href: item.url, target: "_blank", textContent: name }) : name),
    el("span", { className: `tag ${tagClass}`, textContent: tag, title: c?.reason ?? c?.error ?? "" }),
    el("span", { className: "time", textContent: formatDuration(item.seconds) }),
    el("div", { className: "meter" }, el("div", { style: `width:${(item.seconds / top) * 100}%;background:${COLOR[item.cls]}` })));
  // YouTube channels say why they got their label, and can be relabelled.
  if (source === "youtube" && c && c.status !== "pending") {
    const redo = el("button", { className: "link", textContent: c.status === "error" ? "retry" : "relabel" });
    redo.onclick = () => { redo.textContent = "labelling…"; chrome.runtime.sendMessage({ type: "reclassify", channelUrl: item.key, name: c.name ?? name }).then(render); };
    r.append(el("div", { className: "why" }, `${c.reason ?? c.error ?? ""} `, redo));
  }
  return r;
}

// "1h05", "45m": fits above a bar.
function shortDuration(seconds) {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

async function saveSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const threshold = Math.min(100, Math.max(1, Number($("threshold").value))) / 100;
  const idleSeconds = Math.min(3600, Math.max(10, Number($("idle").value)));
  const readwiseToken = $("readwise").value.trim() || undefined;
  await chrome.storage.local.set({ settings: { ...settings, threshold, idleSeconds, readwiseToken } });
  chrome.runtime.sendMessage({ type: "resume" }).catch(() => {});
}
$("threshold").onchange = saveSettings;
$("idle").onchange = saveSettings;
$("readwise").onchange = saveSettings;
$("toggle-settings").onclick = () => { $("settings").hidden = !$("settings").hidden; };
$("open-tab").hidden = !inPopup;
$("open-tab").onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }); window.close(); };
$("dismiss").onclick = () => chrome.runtime.sendMessage({ type: "seenProblems" }).then(render);
$("export").onclick = async () => {
  const data = await chrome.storage.local.get(["log", "channels", "videos", "settings"]);
  if (data.settings) data.settings = { ...data.settings, readwiseToken: undefined }; // don't export the token
  const blob = new Blob([JSON.stringify({ format: "mandarin-tracking-extension/1", exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: "application/json" });
  el("a", { href: URL.createObjectURL(blob), download: `mandarin-time-${localDay(new Date())}.json` }).click();
};
chrome.storage.onChanged.addListener(() => render());
chrome.runtime.sendMessage({ type: "resume" }).catch(() => {});
render();
