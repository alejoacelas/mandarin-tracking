// Content script for pages where time counts while you read or type: claude.ai and chatgpt.com
// conversations, and Readwise Reader documents. Credits engaged seconds to the conversation or
// document open at the time, together with the share of Chinese in its text.
import { EngagementTimer } from "../timer.js";
import { chineseShare } from "../language.js";
import { send, reportProblem, loadSettings } from "./messaging.js";

const SITES = {
  "claude.ai": {
    source: "claude",
    key: (u) => u.pathname.match(/^\/chat\/([0-9a-f-]{36})/)?.[1],
    title: () => document.title.replace(/ - Claude$/, ""),
    textRoot: () => document.querySelector("main"),
  },
  "chatgpt.com": {
    source: "chatgpt",
    key: (u) => u.pathname.match(/\/c\/([\w-]{8,})/)?.[1],
    title: () => document.title,
    textRoot: () => document.querySelector("main"),
  },
  "read.readwise.io": {
    source: "reader",
    key: (u) => u.pathname.match(/\/read\/(\w{8,})/)?.[1],
    title: () => document.title.replace(/ [|–-] Readwise.*$/i, ""),
    textRoot: () => document.querySelector("article") ?? document.querySelector("main"),
  },
};

const FLUSH_MS = 5000;
const site = SITES[location.hostname];

async function start() {
  const settings = await loadSettings();
  const timer = new EngagementTimer({ mode: "reading", idleMs: settings.idleSeconds * 1000 });
  timer.set({ visible: document.visibilityState === "visible", focused: document.hasFocus() });

  let key = site.key(location);
  let url = location.href;
  let heldSeconds = 0; // time spent on a new chat before it got its own URL
  let missingRootReported = false;

  function measure() {
    const root = site.textRoot();
    if (!root) {
      if (!missingRootReported) reportProblem(site.source, `Can't find the conversation text on ${location.pathname}; the page layout may have changed.`);
      missingRootReported = true;
      return null;
    }
    return chineseShare(root.innerText);
  }

  function flush(forKey = key, forUrl = url) {
    let seconds = timer.take();
    if (!forKey) { heldSeconds += seconds; return; }
    seconds += heldSeconds;
    heldSeconds = 0;
    if (seconds <= 0) return;
    const m = measure();
    send({ type: "credit", source: site.source, key: forKey, url: forUrl, title: site.title(), seconds, share: m?.share ?? null, units: m?.units ?? 0 });
  }

  // Single-page apps change URL without reloading: credit time so far to the previous page first.
  setInterval(() => {
    if (location.href === url) return;
    const newKey = site.key(location);
    if (newKey !== key) {
      // Time so far belongs to the old conversation. Time on a new chat that had no URL yet
      // stays held and goes to the URL it gets.
      if (key) flush(key, url);
      key = newKey;
    }
    url = location.href;
  }, 500);
  setInterval(() => flush(), FLUSH_MS);

  const active = () => timer.activity();
  for (const ev of ["keydown", "pointerdown", "wheel", "scroll", "touchstart"]) addEventListener(ev, active, { capture: true, passive: true });
  let lastMove = 0;
  addEventListener("pointermove", () => { const t = Date.now(); if (t - lastMove > 1000) { lastMove = t; active(); } }, { capture: true, passive: true });
  // A response streaming in counts as activity: you're reading it.
  new MutationObserver(() => { if (document.visibilityState === "visible") active(); })
    .observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  document.addEventListener("visibilitychange", () => {
    timer.set({ visible: document.visibilityState === "visible" });
    if (document.visibilityState === "hidden") flush();
  });
  addEventListener("focus", () => timer.set({ focused: true }));
  addEventListener("blur", () => timer.set({ focused: false }));
  addEventListener("pagehide", () => flush());
}

if (site) start();
