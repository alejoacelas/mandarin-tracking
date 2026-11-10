#!/usr/bin/env python3
"""A stand-in for the Mac hub, for emulator tests. Implements docs/protocol.md's phone endpoints
and validates intervals the way the protocol describes, plus /_test endpoints to inspect what
arrived and to make the hub misbehave.

    python3 fake_hub.py --port 47811

GET  /_test/state                   everything received, and the current pairing code
POST /_test/config {"mode": "ok"|"401"|"500"|"down", "reject_prefix": "u:", "reset": true}
"""
import argparse
import json
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE = {}


def reset():
    STATE.clear()
    STATE.update(code="%06d" % random.randint(0, 999999), tokens={}, intervals={}, problems={},
                 heartbeats=[], posts=[], mode="ok", reject_prefix=None)


reset()

SOURCES = {"youtube", "reader", "pleco", "llm", "app"}
LANGS = {"zh", "other", "unknown"}


def validate(iv, now_ms):
    if not isinstance(iv.get("id"), str) or not iv["id"] or len(iv["id"]) > 128:
        return "bad id"
    if iv.get("source") not in SOURCES:
        return "bad source"
    if iv.get("language") not in LANGS:
        return "bad language"
    s, e = iv.get("start_ms"), iv.get("end_ms")
    if not isinstance(s, int) or not isinstance(e, int) or e <= s:
        return "end_ms must be after start_ms"
    if e - s > 12 * 3600_000:
        return "longer than 12 h"
    if e > now_ms + 5 * 60_000:
        return "end_ms is more than 5 minutes in the future"
    zs = iv.get("zh_share")
    if zs is not None and not (0 <= zs <= 1):
        return "bad zh_share"
    if not isinstance(iv.get("app"), str):
        return "app required"
    if iv.get("meta") is not None and len(json.dumps(iv["meta"])) > 4096:
        return "meta over 4 KB"
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path.startswith("/_test/state"):
            with LOCK:
                return self.reply(200, {k: v for k, v in STATE.items() if k != "tokens"} | {"devices": list(STATE["tokens"].values())})
        dev = self.auth()
        if dev is None:
            return
        self.reply(200, {"days": [], "warnings": []})

    def auth(self):
        tok = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
        with LOCK:
            if STATE["mode"] == "401" or tok not in STATE["tokens"]:
                self.reply(401, {"error": "unknown token; pair again"})
                return None
            return STATE["tokens"][tok]

    def do_POST(self):
        with LOCK:
            mode = STATE["mode"]
        if self.path == "/_test/config":
            cfg = self.body()
            with LOCK:
                if cfg.get("reset"):
                    reset()
                for k in ("mode", "reject_prefix"):
                    if k in cfg:
                        STATE[k] = cfg[k]
                return self.reply(200, {"code": STATE["code"]})
        if mode == "down":
            self.close_connection = True
            self.connection.close()
            return
        if mode == "500":
            return self.reply(500, {"error": "boom"})
        req = self.body()
        if self.path == "/api/v1/pair":
            with LOCK:
                if req.get("code") != STATE["code"]:
                    return self.reply(403, {"error": "wrong code"})
                tok = "tok-%d" % random.randint(0, 1 << 60)
                dev = "android-%d" % (len(STATE["tokens"]) + 1)
                STATE["tokens"][tok] = {"device_id": dev, "name": req.get("device_name"), "kind": req.get("kind")}
                STATE["code"] = "%06d" % random.randint(0, 999999)
                return self.reply(200, {"token": tok, "device_id": dev})
        dev = self.auth()
        if dev is None:
            return
        now = int(time.time() * 1000)
        with LOCK:
            STATE["posts"].append({"path": self.path, "at": now})
            if self.path == "/api/v1/intervals":
                ivs = req.get("intervals", [])
                if len(ivs) > 500:
                    return self.reply(400, {"error": "too many intervals"})
                rejected, ok = [], 0
                for iv in ivs:
                    why = validate(iv, now)
                    if why is None and STATE["reject_prefix"] and iv["id"].startswith(STATE["reject_prefix"]):
                        why = "rejected by test"
                    if why:
                        rejected.append({"id": iv.get("id", ""), "reason": why})
                    else:
                        STATE["intervals"][iv["id"]] = iv
                        ok += 1
                return self.reply(200, {"accepted": ok, "rejected": rejected})
            if self.path == "/api/v1/problems":
                STATE["problems"][req["component"]] = req
                return self.reply(200, {"ok": True})
            if self.path == "/api/v1/heartbeat":
                STATE["heartbeats"].append(req | {"at": now})
                return self.reply(200, {"ok": True})
        self.reply(404, {"error": "not found"})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=47811)
    a = ap.parse_args()
    print("fake hub on :%d" % a.port, flush=True)
    ThreadingHTTPServer(("0.0.0.0", a.port), Handler).serve_forever()
