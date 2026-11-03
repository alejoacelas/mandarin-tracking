// Test harness: a local HTTPS server that impersonates claude.ai, chatgpt.com and youtube.com,
// and a Chromium with the extension loaded, driven over the DevTools protocol directly.
// (Playwright isn't used for driving: it makes every page report itself visible, which hides
// exactly the background-tab behaviour these tests check.)
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const here = import.meta.dirname;
const root = path.resolve(here, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ZH = "我最近在学习中文，每天都会和老师练习口语。你觉得我应该先学汉字还是先练习听力？其实我更喜欢看视频学习。".repeat(3);
export const EN = "I have been thinking about how to plan the project timeline and which tasks come first. ".repeat(4);
export const VIDEO_ID = "SHWjQrGb3MQ";
export const CHANNEL_URL = "https://www.youtube.com/@laogao";

const chatHtml = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body><nav>Recents: another chat title in English</nav><main><div id="t">${text}</div><textarea></textarea></main></body>`;

function handler(req, res) {
  const host = req.headers.host.split(":")[0];
  const url = new URL(req.url, `https://${host}`);
  const html = (body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (host === "claude.ai") {
    const id = url.pathname.split("/").pop();
    return html(chatHtml(`Chat ${id.slice(0, 4)} - Claude`, id.startsWith("bbbb") ? EN : id === "new" ? "" : ZH));
  }
  if (host === "chatgpt.com") return html(chatHtml("GPT chat", ZH + EN));
  if (host === "www.youtube.com") {
    if (url.pathname === "/oembed") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ author_name: "老高與小茉 Mr & Mrs Gao", author_url: CHANNEL_URL, title: "test video" }));
    }
    if (url.pathname === "/fixture/video.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      return res.end(readFileSync(path.join(here, "fixtures/video.mp4")));
    }
    return html(`<!doctype html><meta charset="utf-8"><title>video</title><body><div id="movie_player"><video src="/fixture/video.mp4"></video></div></body>`);
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: no reply in 20 s`)); }, 20000);
    });
  }
}

export class Browser {
  static async launch() {
    const b = new Browser();
    b.dir = mkdtempSync(path.join(tmpdir(), "mt-e2e-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=test", "-days", "1",
      "-keyout", `${b.dir}/key.pem`, "-out", `${b.dir}/cert.pem`], { stdio: "ignore" });
    b.server = https.createServer({ key: readFileSync(`${b.dir}/key.pem`), cert: readFileSync(`${b.dir}/cert.pem`) }, handler);
    await new Promise((r) => b.server.listen(0, "127.0.0.1", r));
    const port = b.server.address().port;
    const ext = path.join(root, "extension");
    b.proc = spawn(chromium.executablePath(), [
      `--user-data-dir=${b.dir}/profile`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
      `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      `--host-resolver-rules=MAP claude.ai 127.0.0.1:${port},MAP chatgpt.com 127.0.0.1:${port},MAP www.youtube.com 127.0.0.1:${port}`,
      "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = "";
      b.proc.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) resolve(m[1]); });
      b.proc.on("exit", () => reject(new Error("Chromium exited")));
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => (ws.onopen = r));
    b.cdp = new Cdp(ws);
    // Storage is read through the extension's popup page in a background tab: evaluating in the
    // service worker over CDP is unreliable while it starts and stops.
    const swId = await b.waitForTarget((t) => t.type === "service_worker" && t.url.endsWith("/build/background.js"));
    const { targetInfos } = await b.cdp.send("Target.getTargets");
    const extId = new URL(targetInfos.find((t) => t.targetId === swId).url).host;
    b.worker = await b.open(`chrome-extension://${extId}/popup.html`);
    return b;
  }

  async waitForTarget(pred) {
    for (let i = 0; i < 100; i++) {
      const { targetInfos } = await this.cdp.send("Target.getTargets");
      const t = targetInfos.find(pred);
      if (t) return t.targetId;
      await sleep(100);
    }
    throw new Error("target not found");
  }

  async attach(targetId) {
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const eval_ = async (expression) => {
      const r = await this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    return { targetId, sessionId, eval: eval_ };
  }

  // Opens a URL in a new tab of the same window, which becomes the active tab.
  async open(url) {
    const { targetId } = await this.cdp.send("Target.createTarget", { url, newWindow: false });
    const page = await this.attach(targetId);
    for (let i = 0; i < 50 && (await page.eval("document.readyState")) !== "complete"; i++) await sleep(100);
    await sleep(500);
    page.activate = () => this.cdp.send("Target.activateTarget", { targetId });
    page.move = (x, y) => this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page.sessionId);
    return page;
  }

  async storage(keys) {
    return this.worker.eval(`chrome.storage.local.get(${JSON.stringify(keys)})`);
  }

  async close() {
    this.proc.kill();
    this.server.close();
    await sleep(300);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export { sleep };
