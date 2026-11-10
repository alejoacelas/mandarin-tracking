// Content script for pages where time counts while you read or type: LLM chats and Readwise
// Reader documents (sites in ../lib/sites.js). Counts time while the tab is visible, focused and in
// use, and reports it with the conversation or document and the language of its text.
import { EngagementTimer } from "../lib/timer.js";
import { chineseShare, languageOf } from "../lib/chinese.js";
import { SITES, contentElements } from "../lib/sites.js";
import { Page, reportProblem, resolveProblem, send } from "./messaging.js";

const FLUSH_MS = 5000;
const MEASURE_EVERY_MS = 3000;
const SETTLE_MS = 1500; // the page's text belongs to a new URL only after this long
const MISSING_CONTENT_MS = 10_000;
// Page changes (a reply streaming in) count as activity only this soon after real input, so an
// abandoned tab with a ticking clock or spinner stops counting.
const MUTATION_GRACE_MS = 5 * 60_000;

const site = SITES[location.hostname];
const component = site?.source === "reader" ? "extension.reader" : `extension.llm.${location.hostname}`;

function pageState() {
  const id = site.conversation(location);
  return { id, newChat: !id && site.isNewChat(location) };
}

// Text of the conversation's messages, or of the page's main area when the messages can't be
// found (marked as such and reported).
function measureText() {
  const els = contentElements(document, site.content);
  if (els.length) return { text: els.map((e) => e.innerText).join("\n"), how: "content" };
  const main = document.querySelector("main") ?? document.body;
  let text = main?.innerText ?? "";
  for (const nav of main?.querySelectorAll("nav, aside, [role=navigation]") ?? []) text = text.replace(nav.innerText, "");
  return { text, how: "page" };
}

async function start(idleSeconds) {
  const page = new Page("reading");
  const timer = new EngagementTimer({ mode: "reading", idleMs: idleSeconds * 1000 });
  timer.set({ visible: document.visibilityState === "visible", focused: document.hasFocus() });

  let url = location.href;
  let state = pageState();
  let stateSince = Date.now(); // when the conversation or document last changed
  let urlChangedAt = Date.now();
  let measured = null; // { id, share, units, language, title, how } for the current page
  let lastMeasure = 0;
  let lastInput = Date.now();
  let missingReported = false;
  let resolvedOnce = false;

  function describe() {
    const m = measured && measured.id === state.id ? measured : null;
    const meta = { measured: m ? m.how : "not_yet" };
    if (state.newChat) meta.new_chat = true;
    return {
      source: site.source,
      app: location.hostname,
      language: m?.language ?? "unknown",
      zh_share: m && m.units ? m.share : null,
      units: m ? m.units : null,
      title: m?.title ?? null,
      conversation_id: site.source === "llm" ? state.id : null,
      doc_id: site.source === "reader" ? state.id : null,
      video_id: null, channel_id: null, channel_name: null,
      url: state.id ? location.origin + location.pathname : null,
      meta,
    };
  }

  // Spans so far belong to the page as it was. Pages that are neither a conversation nor a new
  // chat (settings, the list of past chats) don't count.
  function collect() {
    const spans = timer.take();
    if (state.id || state.newChat) page.push(describe(), spans);
  }

  function measure() {
    const { text, how } = measureText();
    const { share, units } = chineseShare(text);
    measured = { id: state.id, share, units, language: languageOf({ share, units }), title: site.title(document), how };
    if (how === "content" && !resolvedOnce) {
      resolvedOnce = true;
      if (!missingReported) resolveProblem(component);
    }
    if (how === "page" && state.id && Date.now() - stateSince > MISSING_CONTENT_MS && !missingReported) {
      missingReported = true;
      reportProblem(component, `Can't find the ${site.source === "reader" ? "document" : "conversation"} text on ${location.hostname}; measuring the whole page instead, which includes menus. The page layout may have changed.`);
    }
  }

  const ticker = setInterval(() => {
    if (!page.owns()) {
      collect();
      page.handOff(null, []);
      clearInterval(ticker);
      clearInterval(flusher);
      return;
    }
    page.adoptHandoff();
    timer.advance();
    if (location.href !== url) {
      const next = pageState();
      if (next.id !== state.id || next.newChat !== state.newChat) {
        collect();
        state = next;
        stateSince = Date.now();
        // A new chat's text measured before it got its id stays valid for the new id.
        if (measured && measured.id === null && next.id) measured = { ...measured, id: next.id };
        else measured = null;
      }
      url = location.href;
      urlChangedAt = Date.now();
    } else if ((state.id || state.newChat) && Date.now() - urlChangedAt > SETTLE_MS && document.visibilityState === "visible"
      && Date.now() - lastMeasure > MEASURE_EVERY_MS) {
      lastMeasure = Date.now();
      measure();
    }
  }, 1000);

  function flush() {
    if (page.stopped) return;
    // Measure before the first send for this page, so its first interval has a language.
    if ((state.id || state.newChat) && measured?.id !== state.id && Date.now() - urlChangedAt > SETTLE_MS) measure();
    collect();
    page.flush();
  }
  const flusher = setInterval(flush, FLUSH_MS);

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
  addEventListener("pagehide", flush);
}

if (site) {
  send({ type: "settings" }).then((reply) => start(reply?.idleSeconds ?? 120));
}
