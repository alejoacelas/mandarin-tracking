// A fake hub that records what the extension sends, following docs/protocol.md. Tests can take
// it down, bring it back, and make it forget tokens (so the extension has to pair again).
import http from "node:http";

export class FakeHub {
  constructor() {
    this.reset();
    this.server = null;
    this.port = null;
  }

  reset() {
    this.tokens = new Map(); // token -> device id
    this.devices = 0;
    this.intervals = new Map(); // `${device}|${id}` -> interval
    this.messages = new Map(); // `${service}|${message_id}` -> message
    this.problems = []; // every problems call, in order
    this.heartbeats = [];
    this.pairs = []; // { origin, body, remote }
    this.log = []; // every request: { method, path, status }
    this.summaryMinutes = 0;
    this.rejectIds = new Set();
  }

  handler = async (req, res) => {
    const url = new URL(req.url, "http://hub");
    let body = "";
    for await (const chunk of req) body += chunk;
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { json = null; }
    const send = (status, obj) => {
      this.log.push({ method: req.method, path: url.pathname, status });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/api/v1/pair-extension" && req.method === "POST") {
      const origin = req.headers.origin ?? "";
      this.pairs.push({ origin, body: json, remote: req.socket.remoteAddress });
      if (!origin.startsWith("chrome-extension://")) return send(403, { error: "origin" });
      const token = `tok-${Math.random().toString(36).slice(2)}`;
      const device = `dev${++this.devices}`;
      this.tokens.set(token, device);
      return send(200, { token, device_id: device });
    }
    const device = this.tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!device) return send(401, { error: "unknown token" });
    if (url.pathname === "/api/v1/intervals" && req.method === "POST") {
      const rejected = [];
      let accepted = 0;
      for (const i of json?.intervals ?? []) {
        const bad = this.rejectIds.has(i.id) ? "test rejects it" : !(i.end_ms > i.start_ms) ? "end_ms must be after start_ms" : i.end_ms - i.start_ms > 12 * 3600_000 ? "longer than 12 h" : null;
        if (bad) { rejected.push({ id: i.id, reason: bad }); continue; }
        this.intervals.set(`${device}|${i.id}`, { ...i, device });
        accepted++;
      }
      return send(200, { accepted, rejected });
    }
    if (url.pathname === "/api/v1/chat-messages" && req.method === "POST") {
      for (const m of json?.messages ?? []) this.messages.set(`${m.service}|${m.message_id}`, m);
      return send(200, { accepted: json?.messages?.length ?? 0 });
    }
    if (url.pathname === "/api/v1/problems" && req.method === "POST") { this.problems.push(json); return send(200, {}); }
    if (url.pathname === "/api/v1/heartbeat" && req.method === "POST") { this.heartbeats.push({ device, ...json }); return send(200, {}); }
    if (url.pathname === "/api/v1/summary" && req.method === "GET") {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      return send(200, { days: [{ date, total_min: this.summaryMinutes, by_source: { youtube: this.summaryMinutes }, partly_min: 0, unclassified_min: 0 }], warnings: [] });
    }
    return send(404, { error: "not found" });
  };

  async start(port = 0) {
    this.server = http.createServer(this.handler);
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(port || this.port || 0, "127.0.0.1", resolve); });
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  get url() { return `http://127.0.0.1:${this.port}`; }

  forgetTokens() { this.tokens.clear(); }

  // Latest copy of each interval, optionally filtered.
  list(pred = () => true) {
    return [...this.intervals.values()].filter(pred).sort((a, b) => a.start_ms - b.start_ms);
  }
}

// Seconds covered by intervals; overlapping ones would be counted twice, which tests check for.
export const seconds = (intervals) => intervals.reduce((t, i) => t + (i.end_ms - i.start_ms), 0) / 1000;
