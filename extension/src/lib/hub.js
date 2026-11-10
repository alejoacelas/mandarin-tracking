// Talks to the Mac hub (docs/protocol.md). Pairs on first use through the loopback-only
// pair-extension call, and pairs again when the hub answers 401.
export const DEFAULT_HUB_URL = "http://127.0.0.1:47800";

export class HubError extends Error {
  // kind: "unreachable" (no answer), "http" (unexpected status), "pair_refused", "bad_response"
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// Wait before the next attempt after `failures` failures in a row: 5 s, 10 s, 20 s ... 5 min.
export function backoffMs(failures) {
  if (failures <= 0) return 0;
  return Math.min(5 * 60_000, 5000 * 2 ** (failures - 1));
}

export class Hub {
  // onRepaired runs after the hub forgot our token and we paired again, before retrying.
  constructor({ fetch, kv, baseUrl = DEFAULT_HUB_URL, deviceName = "Chrome", onRepaired = async () => {} }) {
    this.fetch = fetch;
    this.kv = kv;
    this.baseUrl = baseUrl;
    this.deviceName = deviceName;
    this.onRepaired = onRepaired;
  }

  async raw(method, path, body, token) {
    let r;
    try {
      r = await this.fetch(this.baseUrl + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (e) {
      throw new HubError("unreachable", `Can't reach the hub at ${this.baseUrl}: ${e.message ?? e}`);
    }
    let json = null;
    const text = await r.text().catch(() => "");
    if (text) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
    return { status: r.status, json, text };
  }

  async pair() {
    const r = await this.raw("POST", "/api/v1/pair-extension", { device_name: this.deviceName });
    if (r.status === 403) throw new HubError("pair_refused", `The hub refused to pair this extension (403): ${r.text.slice(0, 200)}`, 403);
    if (r.status !== 200) throw new HubError("http", `Pairing returned ${r.status}: ${r.text.slice(0, 200)}`, r.status);
    if (typeof r.json?.token !== "string" || !r.json.token) throw new HubError("bad_response", "Pairing answer has no token.");
    const hub = { token: r.json.token, device_id: r.json.device_id ?? null, paired_at: Date.now(), base_url: this.baseUrl };
    await this.kv.set({ hub });
    return hub.token;
  }

  async token() {
    const { hub } = await this.kv.get("hub");
    if (hub?.token && hub.base_url === this.baseUrl) return hub.token;
    return this.pair();
  }

  // body: a value, or a function returning the body, called again if the request is retried.
  async call(method, path, body) {
    const make = typeof body === "function" ? body : async () => body;
    let token = await this.token();
    let r = await this.raw(method, path, await make(), token);
    if (r.status === 401) {
      await this.kv.remove("hub");
      token = await this.pair();
      await this.onRepaired();
      r = await this.raw(method, path, await make(), token);
      if (r.status === 401) throw new HubError("http", `The hub refused a fresh token for ${path} (401).`, 401);
    }
    if (r.status < 200 || r.status >= 300) throw new HubError("http", `${method} ${path} returned ${r.status}: ${r.text.slice(0, 200)}`, r.status);
    return r.json;
  }
}
