// Test harness: a local HTTPS server that impersonates the tracked sites (pages and the chat
// history endpoints), a fake hub, and a Chromium with the extension loaded, driven over the
// DevTools protocol directly. (Playwright isn't used for driving: it makes every page report
// itself visible, which hides exactly the background-tab behaviour these tests check.)
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { FakeHub } from "./fakehub.js";
import { buildExtension } from "../../scripts/build.mjs";

const here = import.meta.dirname;
export const extPath = path.resolve(here, "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ZH = "我最近在学习中文，每天都会和老师练习口语。你觉得我应该先学汉字还是先练习听力？其实我更喜欢看视频学习。".repeat(3);
export const EN = "I have been thinking about how to plan the project timeline and which tasks come first. ".repeat(4);
export const SIDEBAR = "Recents: planning the quarterly budget, weekend hiking trip ideas, debugging the build script, recipe for lasagna. ".repeat(3);
export const VIDEO_ID = "SHWjQrGb3MQ";
export const VIDEO_ID_2 = "aaaaaaaaaaa";
export const CHANNELS = { [VIDEO_ID]: { channelId: "UCzhzhzhzhzhzhzhzhzhzh00", author: "老高與小茉 Mr & Mrs Gao" }, [VIDEO_ID_2]: { channelId: "UCenenenenenenenenenen00", author: "Other channel" } };

// What the fake sites' history endpoints return; tests change it.
export const sites = {
  claude: { status: 200, conversations: [] }, // [{ uuid, updated_at, messages: [{ uuid, sender, created_at, text }] }]
  chatgpt: { signedIn: true, status: 200, conversations: [] }, // [{ id, update_time, messages: [{ id, role, create_time, text }] }]
  requests: [],
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body>${body}</body>`;

function claudeChat(id) {
  const text = id.startsWith("bbbb") ? EN : ZH;
  return page(`Chat ${id.slice(0, 4)} - Claude`, `<nav>${SIDEBAR}</nav><main>
    <div data-testid="user-message" id="u">${text.slice(0, 60)}</div><div data-is-streaming="false" id="t">${text}</div>
    <textarea></textarea></main>`);
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function claudeApi(url, res) {
  const st = sites.claude;
  if (st.status !== 200) return json(res, st.status, { error: { type: "permission_error", message: "Invalid authorization" } });
  if (url.pathname === "/api/organizations") return json(res, 200, [{ uuid: "org-api", capabilities: ["api"] }, { uuid: "org-chat", capabilities: ["chat", "claude_pro"] }]);
  const one = url.pathname.match(/^\/api\/organizations\/org-chat\/chat_conversations\/([\w-]+)$/);
  if (one) {
    const c = st.conversations.find((x) => x.uuid === one[1]);
    if (!c) return json(res, 404, { error: "not found" });
    return json(res, 200, { uuid: c.uuid, name: "x", chat_messages: c.messages.map((m) => ({ uuid: m.uuid, sender: m.sender, created_at: m.created_at, text: "", content: [{ type: "text", text: m.text }] })) });
  }
  if (url.pathname === "/api/organizations/org-chat/chat_conversations") {
    const limit = Number(url.searchParams.get("limit") ?? 50), offset = Number(url.searchParams.get("offset") ?? 0);
    const sorted = [...st.conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return json(res, 200, sorted.slice(offset, offset + limit).map(({ uuid, updated_at }) => ({ uuid, updated_at, name: "x" })));
  }
  if (url.pathname.startsWith("/api/organizations/org-api")) return json(res, 403, { error: "api org" });
  return json(res, 404, { error: "not found" });
}

function chatgptApi(req, url, res) {
  const st = sites.chatgpt;
  if (url.pathname === "/api/auth/session") return json(res, 200, st.signedIn ? { accessToken: "fixture-token", expires: "2099-01-01" } : {});
  if (req.headers.authorization !== "Bearer fixture-token") return json(res, 200, { items: [], total: 0 }); // like the real one
  if (st.status !== 200) return json(res, st.status, { detail: "error" }, st.status === 429 ? { "retry-after": "60" } : {});
  if (url.pathname === "/backend-api/conversations") {
    const limit = Number(url.searchParams.get("limit")), offset = Number(url.searchParams.get("offset"));
    const sorted = [...st.conversations].sort((a, b) => b.update_time.localeCompare(a.update_time));
    return json(res, 200, { items: sorted.slice(offset, offset + limit).map(({ id, update_time }) => ({ id, update_time, title: "x" })), total: 1, limit, offset });
  }
  const one = url.pathname.match(/^\/backend-api\/conversation\/([\w-]+)$/);
  if (one) {
    const c = st.conversations.find((x) => x.id === one[1]);
    if (!c) return json(res, 404, { detail: "not found" });
    const mapping = { root: { id: "root", message: null } };
    for (const m of c.messages) mapping[m.id] = { id: m.id, message: { id: m.id, author: { role: m.role }, create_time: m.create_time, recipient: "all", content: { content_type: "text", parts: [m.text] }, metadata: {} } };
    return json(res, 200, { conversation_id: c.id, mapping });
  }
  return json(res, 404, { detail: "not found" });
}

function handler(req, res) {
  const host = req.headers.host.split(":")[0];
  const url = new URL(req.url, `https://${host}`);
  sites.requests.push({ host, path: url.pathname, cookie: !!req.headers.cookie });
  const html = (body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (host === "claude.ai") {
    if (url.pathname.startsWith("/api/")) return claudeApi(url, res);
    if (url.pathname.startsWith("/chat/")) return html(claudeChat(url.pathname.split("/")[2]));
    if (url.pathname === "/new") return html(page("New chat - Claude", `<nav>${SIDEBAR}</nav><main><textarea></textarea></main>`));
    return html(page("Recents - Claude", `<nav>${SIDEBAR}</nav><main><h1>Your chat history</h1>${SIDEBAR}</main>`));
  }
  if (host === "chatgpt.com") {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/backend-api/")) return chatgptApi(req, url, res);
    const id = url.pathname.match(/\/c\/([\w-]+)/)?.[1] ?? "";
    // Conversations whose id starts with "dddd" have markup the extension doesn't know (a redesign).
    const body = id.startsWith("dddd")
      ? `<nav>${SIDEBAR}</nav><main><div class="turn">${ZH}</div><div class="turn">${ZH}</div></main>`
      : `<nav>${SIDEBAR}</nav><main><div data-message-author-role="user">${ZH}</div><div data-message-author-role="assistant">${ZH + EN}</div></main>`;
    return html(page("GPT chat", body));
  }
  if (host === "read.readwise.io") {
    return html(page("远程工作 | Readwise", `<div id="document-inbox">${SIDEBAR}</div><div id="document-reader-root"><div id="document-text-content">${ZH.repeat(3)}</div></div>`));
  }
  if (host === "www.youtube.com") {
    if (url.pathname === "/fixture/video.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      return res.end(readFileSync(path.join(here, "fixtures/video.mp4")));
    }
    // Imitates YouTube's player: getVideoData() and getPlayerResponse() report the loaded video.
    return html(`<!doctype html><meta charset="utf-8"><title>video</title><body><div id="movie_player" class="html5-video-player"><video src="/fixture/video.mp4" loop></video></div>
      <script>window.currentVideo = new URLSearchParams(location.search).get("v");
      window.channels = ${JSON.stringify(CHANNELS)};
      window.hideChannel = false;
      const p = document.getElementById("movie_player");
      p.getVideoData = () => ({ video_id: window.currentVideo, title: "video " + window.currentVideo, author: window.channels[window.currentVideo]?.author });
      p.getPlayerResponse = () => (window.hideChannel ? {} : { videoDetails: { videoId: window.currentVideo, ...window.channels[window.currentVideo], title: "video " + window.currentVideo } });</script></body>`);
  }
  res.writeHead(404); res.end();
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: no reply in 30 s`)); }, 30_000);
    });
  }
}

export function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    for (const sub of ["chrome-mac-arm64", "chrome-mac", "chrome-mac-x64"]) {
      for (const app of ["Chromium.app/Contents/MacOS/Chromium", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) {
        const p = path.join(cache, d, sub, app);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error("No Chromium found. Run `npx playwright install chromium` or set CHROMIUM to a Chromium binary.");
}

export class Browser {
  // live: talk to the real sites instead of the local fixtures. hub: a FakeHub to use, or null
  // to leave the extension's hub address alone (the real hub on 127.0.0.1:47800).
  static async launch({ live = false, hub = undefined, idleSeconds = 6 } = {}) {
    const b = new Browser();
    b.dir = mkdtempSync(path.join(tmpdir(), "mt-e2e-"));
    if (!live) {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=test", "-days", "1",
        "-keyout", `${b.dir}/key.pem`, "-out", `${b.dir}/cert.pem`], { stdio: "ignore" });
      b.server = https.createServer({ key: readFileSync(`${b.dir}/key.pem`), cert: readFileSync(`${b.dir}/cert.pem`) }, handler);
      await new Promise((r) => b.server.listen(0, "127.0.0.1", r));
    }
    b.hub = hub === undefined ? await new FakeHub().start() : hub;
    const port = b.server?.address().port;
    const hosts = ["claude.ai", "chatgpt.com", "www.youtube.com", "read.readwise.io"];
    b.proc = spawn(chromiumPath(), [
      `--user-data-dir=${b.dir}/profile`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
      "--enable-unsafe-extension-debugging", // lets CDP install the extension (Extensions.loadUnpacked)
      "--disable-features=ExtensionManifestV2Unsupported",
      ...(live ? [] : [`--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(",")}`, "--ignore-certificate-errors"]),
      "--autoplay-policy=no-user-gesture-required", "--window-size=1200,900", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = "";
      b.proc.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) resolve(m[1]); });
      b.proc.on("exit", () => reject(new Error(`Chromium exited: ${buf.slice(-500)}`)));
    });
    return b.connectTo(wsUrl, idleSeconds);
  }

  // With a fake hub, load a copy of the extension built with an address where nothing listens,
  // so it never pairs with a real hub on this Mac before the test points it at the fake one.
  async prepareExtension() {
    if (!this.hub) { this.extPath = extPath; return; }
    this.extDir = mkdtempSync(path.join(tmpdir(), "mt-ext-"));
    this.extPath = await buildExtension(this.extDir, { hubUrl: "http://127.0.0.1:9" });
  }

  // Uses a browser that's already running with --remote-debugging-port and
  // --enable-unsafe-extension-debugging (for example Google Chrome with a copy of a signed-in
  // profile, for live checks).
  static async connect({ wsUrl, hub = undefined, idleSeconds = 120 }) {
    const b = new Browser();
    b.hub = hub === undefined ? await new FakeHub().start() : hub;
    return b.connectTo(wsUrl, idleSeconds);
  }

  async connectTo(wsUrl, idleSeconds) {
    await this.prepareExtension();
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => (ws.onopen = r));
    this.cdp = new Cdp(ws);
    await this.installExtension();
    await this.configure({ idleSeconds });
    return this;
  }

  async configure({ idleSeconds }) {
    const settings = { idleSeconds, ...(this.hub ? { hubUrl: this.hub.url } : {}) };
    await this.ctl.eval(`chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }).then(() => true)`);
  }

  // Installs the extension, or reinstalls it as an update if it's already there (what pressing
  // reload on chrome://extensions does). Then opens an extension page used to read storage and
  // send messages to the worker.
  async installExtension() {
    const { id } = await this.cdp.send("Extensions.loadUnpacked", { path: this.extPath });
    this.extId = id;
    for (let i = 0; i < 40; i++) {
      this.ctl = await this.open(`chrome-extension://${id}/popup.html`, { background: true });
      if ((await this.ctl.eval("typeof chrome.storage?.local").catch(() => "")) === "object") return;
      await this.cdp.send("Target.closeTarget", { targetId: this.ctl.targetId }).catch(() => {});
      await sleep(500);
    }
    throw new Error("extension pages didn't load");
  }

  async attach(targetId) {
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression) => {
      const r = await this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    return { targetId, sessionId, eval: evaluate };
  }

  // Opens a URL in a new tab of the same window, which becomes the active tab unless background.
  async open(url, { background = false, newWindow = false } = {}) {
    const { targetId } = await this.cdp.send("Target.createTarget", { url, newWindow, background });
    const p = await this.attach(targetId);
    for (let i = 0; i < 100 && (await p.eval("document.readyState").catch(() => "")) !== "complete"; i++) await sleep(100);
    await sleep(500);
    p.activate = () => this.cdp.send("Target.activateTarget", { targetId });
    p.move = (x, y) => this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, p.sessionId);
    p.close = () => this.cdp.send("Target.closeTarget", { targetId });
    p.lifecycle = (state) => this.cdp.send("Page.setWebLifecycleState", { state }, p.sessionId);
    return p;
  }

  async reloadExtension() {
    await this.cdp.send("Target.closeTarget", { targetId: this.ctl.targetId }).catch(() => {});
    await this.installExtension();
  }

  // Stops the extension's service worker the way Chrome does when it's idle. Returns whether a
  // worker was running and is gone now.
  async killWorker() {
    const find = async () => (await this.cdp.send("Target.getTargets")).targetInfos
      .find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${this.extId}/`));
    const sw = await find();
    if (!sw) return false;
    await this.cdp.send("Target.closeTarget", { targetId: sw.targetId }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      const now = await find();
      if (!now || now.targetId !== sw.targetId) return true;
      await sleep(100);
    }
    return false;
  }

  storage(keys) { return this.ctl.eval(`chrome.storage.local.get(${JSON.stringify(keys)})`); }
  message(msg) { return this.ctl.eval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`); }
  pump() { return this.message({ type: "pump" }); }

  async waitFor(fn, { timeout = 30_000, every = 500, what = "condition" } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await fn();
      if (last) return last;
      await sleep(every);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async close() {
    this.proc?.kill();
    this.server?.close();
    if (this.hub) await this.hub.stop();
    await sleep(300);
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    if (this.extDir) rmSync(this.extDir, { recursive: true, force: true });
  }
}
