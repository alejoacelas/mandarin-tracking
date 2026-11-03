// Content script for pages where time counts while you read or type: claude.ai and chatgpt.com
// conversations, and Readwise Reader documents. Credits engaged seconds to the conversation or
// document open at the time, together with the share of Chinese in its text.
import { EngagementTimer } from "../timer.js";
import { chineseShare } from "../language.js";
import { send, reportProblem, loadSettings, claimPage } from "./messaging.js";

const SITES = {
  "claude.ai": {
    source: "claude",
    key: (u) => u.pathname.match(/^\/chat\/([0-9a-f-]{36})/)?.[1],
    isNewChat: (u) => u.pathname === "/new" || u.pathname.startsWith("/project/"),
    title: () => document.title.replace(/ - Claude$/, ""),
    textRoot: () => document.querySelector("main"),
  },
  "chatgpt.com": {
    source: "chatgpt",
    key: (u) => u.pathname.match(/\/c\/([\w-]{8,})/)?.[1],
    isNewChat: (u) => u.pathname === "/" || (u.pathname.startsWith("/g/") && !u.pathname.includes("/c/")),
    title: () => document.title,
    textRoot: () => document.querySelector("main"),
  },
  "read.readwise.io": {
    source: "reader",
    key: (u) => u.pathname.match(/\/read\/(\w{8,})/)?.[1],
    isNewChat: () => false,
    title: () => document.title.replace(/ [|–-] Readwise.*$/i, ""),
    // The open document's text; <main> also holds the document list and menus.
    textRoot: () => document.getElementById("document-text-content"),
  },
};

// Keys for time that isn't on a conversation. The summary counts both as not Mandarin.
const OTHER_PAGES = { key: "_other", title: "Pages that aren't a conversation" };
const UNSENT = { key: "_unsent", title: "New chats never sent" };
const FLUSH_MS = 5000;
// Page changes (a reply streaming in) count as activity only this soon after real input, so an
// abandoned tab with a ticking clock or spinner stops counting.
const MUTATION_GRACE_MS = 5 * 60_000;

const site = SITES[location.hostname];

async function start() {
  const alive = claimPage("mtReading");
  const settings = await loadSettings((s) => { timer.idleMs = s.idleSeconds * 1000; });
  const timer = new EngagementTimer({ mode: "reading", idleMs: settings.idleSeconds * 1000 });
  timer.set({ visible: document.visibilityState === "visible", focused: document.hasFocus() });

  let url = location.href;
  let key = site.key(location);
  let onNewChat = !key && site.isNewChat(location);
  let urlChangedAt = Date.now();
  let heldSeconds = 0; // time on a new chat before it has its own URL
  let lastInput = Date.now();
  let measured = null; // { key, share, units, title } taken while this URL was stable
  let missingRootReported = false;

  // Measures the current conversation. Only called when the URL has been stable for a second,
  // so the text and title belong to the conversation in the URL.
  function measure() {
    const root = site.textRoot();
    if (!root) {
      if (!missingRootReported && key) reportProblem(site.source, `Can't find the conversation text on ${location.pathname}; the page layout may have changed.`);
      missingRootReported = true;
      return;
    }
    const m = chineseShare(root.innerText);
    measured = { key, share: m.share, units: m.units, title: site.title() };
  }

  async function sendCredit(target, seconds) {
    const ok = await send({ type: "credit", source: site.source, ...target, seconds });
    if (!ok) timer.giveBack(seconds); // retried on the next flush
  }

  // Credits time so far to the page that was open. `prev` describes that page.
  function flush(prev = { key, onNewChat, url }) {
    if (!alive()) return;
    const seconds = timer.take();
    if (prev.key) {
      const total = seconds + heldSeconds;
      heldSeconds = 0;
      if (total <= 0) return;
      const m = measured?.key === prev.key ? measured : null;
      sendCredit({ key: prev.key, url: prev.url, title: m?.title, share: m?.share ?? null, units: m?.units ?? 0 }, total);
    } else if (prev.onNewChat) {
      heldSeconds += seconds;
    } else if (seconds > 0) {
      sendCredit({ ...OTHER_PAGES, share: null, units: 0 }, seconds);
    }
  }

  function releaseHeld() {
    if (heldSeconds > 0) sendCredit({ ...UNSENT, share: null, units: 0 }, heldSeconds);
    heldSeconds = 0;
  }

  setInterval(() => {
    if (!alive()) return;
    timer.advance();
    if (location.href !== url) {
      const prev = { key, onNewChat, url };
      const newKey = site.key(location);
      const newIsNewChat = !newKey && site.isNewChat(location);
      if (newKey !== key || newIsNewChat !== onNewChat) {
        flush(prev);
        // Time held on a new chat goes to the conversation it becomes; anywhere else, it's unsent.
        if (prev.onNewChat && !newKey) releaseHeld();
        key = newKey;
        onNewChat = newIsNewChat;
        measured = null;
      }
      url = location.href;
      urlChangedAt = Date.now();
    } else if (key && Date.now() - urlChangedAt > 1000 && document.visibilityState === "visible") {
      measure();
    }
  }, 1000);
  setInterval(() => flush(), FLUSH_MS);

  const input = () => { lastInput = Date.now(); timer.activity(); };
  for (const ev of ["keydown", "pointerdown", "wheel", "scroll", "touchstart"]) addEventListener(ev, input, { capture: true, passive: true });
  let lastMove = 0;
  addEventListener("pointermove", () => { const t = Date.now(); if (t - lastMove > 1000) { lastMove = t; input(); } }, { capture: true, passive: true });
  new MutationObserver(() => {
    if (document.visibilityState === "visible" && Date.now() - lastInput < MUTATION_GRACE_MS) timer.activity();
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  document.addEventListener("visibilitychange", () => {
    timer.set({ visible: document.visibilityState === "visible" });
    if (document.visibilityState === "hidden") flush();
  });
  addEventListener("focus", () => timer.set({ focused: true }));
  // Clicking into an embedded frame (an artifact, a PDF view) blurs the window but you're still here.
  addEventListener("blur", () => setTimeout(() => timer.set({ focused: document.activeElement?.tagName === "IFRAME" }), 0));
  addEventListener("pagehide", () => { flush(); releaseHeld(); });
}

if (site) start();
