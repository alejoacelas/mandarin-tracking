// Live check with real sign-ins: runs Google Chrome on a copy of this Mac's Chrome profile
// (cookies only), loads the extension, and checks against the real sites:
//   - chat history import from chatgpt.com and claude.ai (from the extension's worker)
//   - optionally a throwaway Mandarin chat on each, created, imported and deleted again
//   - chat and Reader pages: intervals with the language measured from the page
// Prints counts and fields only, never message text. Uses a fake hub unless HUB=real.
// Usage: node test/e2e/live-signed-in.mjs [--throwaway] [--pages url1,url2,...]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { Browser, sleep } from "./harness.js";

const args = process.argv.slice(2);
const throwaway = args.includes("--throwaway");
const pagesArg = args[args.indexOf("--pages") + 1];
const pageUrls = args.includes("--pages") ? pagesArg.split(",") : [];
const PORT = 9333;

const src = path.join(homedir(), "Library/Application Support/Google/Chrome");
const dir = mkdtempSync(path.join(tmpdir(), "mt-live-"));
mkdirSync(path.join(dir, "Default"));
copyFileSync(path.join(src, "Local State"), path.join(dir, "Local State"));
copyFileSync(path.join(src, "Default/Preferences"), path.join(dir, "Default/Preferences"));
// A consistent copy of the cookie database while Chrome has it open.
execFileSync("sqlite3", [`file:${path.join(src, "Default/Cookies")}?immutable=1`, `.backup '${path.join(dir, "Default/Cookies")}'`]);

// `open` starts Chrome in the logged-in session, where it can read its cookie key from the keychain.
execFileSync("open", ["-na", "Google Chrome", "--args", `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`,
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--window-size=1200,900", "about:blank"]);
let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(500); }
}
if (!wsUrl) throw new Error("Chrome didn't open its debugging port");

const hub = process.env.HUB === "real" ? null : undefined;
const b = await Browser.connect({ wsUrl, hub, idleSeconds: 6 });
const out = { extension: b.extId };
try {
  // ---------- chat history ----------
  // A first import of a busy account takes minutes, so start it and watch its status.
  const t0 = Date.now();
  await b.ctl.eval(`chrome.runtime.sendMessage({ type: "syncHistory" }); true`);
  await b.waitFor(async () => {
    const { historyStatus: h = {} } = await b.storage(["historyStatus"]);
    return ["chatgpt", "claude"].every((s) => (h[s]?.last_ok_at ?? 0) > t0 || (h[s]?.last_fail_at ?? 0) > t0);
  }, { timeout: 15 * 60_000, every: 5000, what: "the history import" });
  await b.pump();
  const st = await b.message({ type: "status" });
  out.history = { seconds: Math.round((Date.now() - t0) / 1000), status: st.historyStatus, problems: st.problems };
  if (b.hub) {
    const msgs = [...b.hub.messages.values()];
    const by = (svc) => msgs.filter((m) => m.service === svc);
    for (const svc of ["chatgpt", "claude"]) {
      const m = by(svc);
      out.history[svc] = {
        messages: m.length,
        conversations: new Set(m.map((x) => x.conversation_id)).size,
        roles: [...new Set(m.map((x) => x.role))],
        zh_messages: m.filter((x) => x.units >= 20 && x.zh_share >= 0.3).length,
        newest: m.length ? new Date(Math.max(...m.map((x) => x.at_ms))).toISOString() : null,
        fields: m[0] ? Object.keys(m[0]).sort() : [],
      };
    }
  }

  // ---------- throwaway Mandarin chats ----------
  if (throwaway) {
    const PROMPT = "请用中文简单介绍一下北京的天气，两三句话就可以。";
    out.throwaway = {};
    for (const [svc, url] of [["claude", "https://claude.ai/new"], ["chatgpt", "https://chatgpt.com/"]]) {
      const p = await b.open(url);
      await sleep(4000);
      await p.eval(`(() => { const e = document.querySelector('div[contenteditable="true"], textarea'); e.focus(); return !!e; })()`);
      await b.cdp.send("Input.insertText", { text: PROMPT }, p.sessionId);
      await sleep(500);
      await b.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, p.sessionId);
      await b.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, p.sessionId);
      // Keep the tab active (mouse moves) while the reply streams in.
      for (let i = 0; i < 25; i++) { await p.move(300 + (i % 2) * 30, 300); await sleep(1000); }
      const pathName = await p.eval("location.pathname");
      out.throwaway[svc] = { path: pathName };
      await sleep(8000);
      await b.pump();
      const id = pathName.split("/").pop();
      const ivs = b.hub ? b.hub.list((i) => i.conversation_id === id) : [];
      out.throwaway[svc].intervals = ivs.map((i) => ({ s: (i.end_ms - i.start_ms) / 1000, language: i.language, zh_share: i.zh_share, units: i.units, measured: i.meta?.measured, title: !!i.title }));
      // Import it from history, then delete the chat the way the web app does.
      const t1 = Date.now();
      await b.ctl.eval(`chrome.runtime.sendMessage({ type: "syncHistory" }); true`);
      await b.waitFor(async () => {
        const { historyStatus: h = {} } = await b.storage(["historyStatus"]);
        return (h[svc]?.last_ok_at ?? 0) > t1 || (h[svc]?.last_fail_at ?? 0) > t1;
      }, { timeout: 10 * 60_000, every: 3000, what: "the history import" });
      await b.pump();
      const imported = b.hub ? [...b.hub.messages.values()].filter((m) => m.conversation_id === id) : [];
      out.throwaway[svc].imported = imported.map((m) => ({ role: m.role, zh_share: m.zh_share, units: m.units }));
      out.throwaway[svc].deleted = await p.eval(svc === "claude"
        ? `(async () => { const orgs = await (await fetch("/api/organizations")).json(); const org = orgs.find((o) => o.capabilities.includes("chat")).uuid;
            return (await fetch("/api/organizations/" + org + "/chat_conversations/" + ${JSON.stringify(id)}, { method: "DELETE" })).status; })()`
        : `(async () => { const s = await (await fetch("/api/auth/session")).json();
            return (await fetch("/backend-api/conversation/" + ${JSON.stringify(id)}, { method: "PATCH", headers: { Authorization: "Bearer " + s.accessToken, "Content-Type": "application/json" }, body: JSON.stringify({ is_visible: false }) })).status; })()`);
      await p.close();
    }
  }

  // ---------- pages ----------
  out.pages = [];
  for (const url of pageUrls) {
    const p = await b.open(url);
    await sleep(3000);
    for (let i = 0; i < 12; i++) { await p.move(300 + (i % 2) * 30, 300); await sleep(1000); }
    await sleep(13000);
    await b.pump();
    const host = new URL(url).hostname;
    const ivs = b.hub ? b.hub.list((i) => i.app === host) : [];
    out.pages.push({ url: url.replace(/[?#].*/, ""), intervals: ivs.map((i) => ({ s: (i.end_ms - i.start_ms) / 1000, source: i.source, language: i.language, zh_share: i.zh_share && Math.round(i.zh_share * 100) / 100, units: i.units, measured: i.meta?.measured, id: i.conversation_id ?? i.doc_id, title: i.title })) });
    await p.close();
  }
  out.problems = (await b.message({ type: "status" })).problems;
  out.hubProblems = b.hub?.problems;
} finally {
  console.log(JSON.stringify(out, null, 2));
  await b.close();
  spawnSync("pkill", ["-f", `user-data-dir=${dir}`]);
  await sleep(1500);
  // The copied cookie database holds sessions: delete it, and move the rest of the copy to the Trash.
  for (const f of ["Cookies", "Cookies-journal"]) { const p = path.join(dir, "Default", f); if (existsSync(p)) unlinkSync(p); }
  if (existsSync(dir)) renameSync(dir, path.join(homedir(), ".Trash", path.basename(dir)));
}
