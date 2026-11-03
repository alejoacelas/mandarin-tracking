"""Record raw Reader document state every INTERVAL seconds to a JSONL file.

Usage: python3 readwise/poll_log.py OUT.jsonl [INTERVAL]
Each line: {"t": poll time (unix), "docs": {id: {progress, last_opened_at, updated_at}}}.
Benchmarks replay these snapshots at coarser intervals.
"""

import json
import os
import sys
import time
import urllib.request

out, interval = sys.argv[1], float(sys.argv[2] if len(sys.argv) > 2 else 30)


def fetch():
    docs, cursor = {}, ""
    while True:
        req = urllib.request.Request(
            f"https://readwise.io/api/v3/list/?pageCursor={cursor}",
            headers={"Authorization": f"Token {os.environ['READWISE_TOKEN']}"},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.load(r)
        for x in d["results"]:
            docs[x["id"]] = {
                "progress": x.get("reading_progress"),
                "last_opened_at": x.get("last_opened_at"),
                "updated_at": x.get("updated_at"),
                "title": x.get("title"),
            }
        cursor = d.get("nextPageCursor")
        if not cursor:
            return docs


while True:
    t = time.time()
    try:
        line = {"t": t, "docs": fetch()}
    except Exception as e:  # keep logging through transient API errors, but record them
        line = {"t": t, "error": repr(e)}
    with open(out, "a") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")
    time.sleep(max(0, interval - (time.time() - t)))
