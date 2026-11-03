"""Compare Reader time estimators against scripted reading sessions.

Usage: python3 readwise/benchmark.py
Reads readwise/runs/poll.jsonl (10 s snapshots of every document) and
readwise/runs/truth.jsonl (what was actually read, and when). Replays the snapshots as
if polled at coarser intervals, averaged over several start offsets, and prints each
estimator's minutes per scenario next to the true minutes.
"""

import json
import pathlib
import re
from datetime import datetime

HERE = pathlib.Path(__file__).parent
POLL_INTERVALS = [10, 60, 120, 300, 600, 900]
PHASES = 5  # poll start offsets averaged per interval
GAP = 300  # seconds without a progress save that end a session
TAIL = 30  # seconds credited after a session's last save
LEARNER_CPM = 200  # assumed Chinese characters read per minute


def ts(s):
    return datetime.fromisoformat(s).timestamp() if s else None


def load():
    snaps = [json.loads(l) for l in (HERE / "runs/poll.jsonl").read_text().splitlines()]
    snaps = [s for s in snaps if "docs" in s]
    truth = [json.loads(l) for l in (HERE / "runs/truth.jsonl").read_text().splitlines()]
    return snaps, truth


def char_counts(snaps):
    by_title = {}
    for p in (HERE / "fixtures").glob("*.html"):
        html = p.read_text()
        title = re.sub("<[^>]+>", "", re.search(r"<h1>(.*?)</h1>", html, re.S).group(1)).strip()
        by_title[title] = sum("一" <= c <= "鿿" for c in html)
    return {i: by_title.get(d["title"], 0) for i, d in snaps[-1]["docs"].items()}


def subsample(snaps, every, offset=0):
    out, last = [], None
    for s in snaps:
        if s["t"] < snaps[0]["t"] + offset:
            continue
        if last is None or s["t"] - last >= every - 2:
            out.append(s)
            last = s["t"]
    return out


def changes(snaps):
    """(prev, cur, doc, gain) for each doc whose save time changed between polls."""
    out = []
    for a, b in zip(snaps, snaps[1:]):
        for d, pb in b["docs"].items():
            pa = a["docs"].get(d)
            if pa and pa["updated_at"] != pb["updated_at"]:
                out.append((a, b, d, (pb["progress"] or 0) - (pa["progress"] or 0)))
    return out


def poll_delta(ch, every, chars):
    """Credit each poll interval in which some document's progress went up."""
    return sum(min(b - a, every) for a, b in {(a["t"], b["t"]) for a, b, d, g in ch if g > 0})


def save_windows(ch, every, chars):
    """Sessions from last_opened_at through observed save times, split by GAP."""
    events = []
    for a, b, d, gain in ch:
        doc = b["docs"][d]
        events.append(ts(doc["updated_at"]))
        opened = ts(doc["last_opened_at"])
        if opened and opened > a["t"]:
            events.append(opened)
    events.sort()
    total, start, prev = 0, None, None
    for e in events:
        if start is None or e - prev > GAP:
            if start is not None:
                total += prev - start + TAIL
            start = e
        prev = e
    if start is not None:
        total += prev - start + TAIL
    return total


def chars_read(ch, every, chars):
    """Characters scrolled past, at an assumed learner reading speed."""
    return sum(max(0, g) * chars.get(d, 0) for a, b, d, g in ch) / LEARNER_CPM * 60


ESTIMATORS = {"poll_delta": poll_delta, "save_windows": save_windows, "chars_read": chars_read}


def scenarios_from(truth):
    scenarios = {}
    for t in truth:
        if t["scenario"] == "probe":
            continue
        sc = scenarios.setdefault(t["scenario"], {"docs": set(), "start": t["start"], "end": t["end"], "true": 0})
        sc["docs"].add(t["doc"])
        sc["start"], sc["end"] = min(sc["start"], t["start"]), max(sc["end"], t["end"])
        if t.get("counts", True):
            sc["true"] += t["end"] - t["start"]
    order = sorted((sc["start"], n) for n, sc in scenarios.items())
    for (_, n), nxt in zip(order, order[1:] + [(float("inf"), None)]):
        scenarios[n]["until"] = nxt[0]
    return scenarios


def main():
    snaps, truth = load()
    chars = char_counts(snaps)
    scenarios = scenarios_from(truth)
    header = f"{'scenario':<16}{'every':>6}{'true':>7}" + "".join(f"{n:>14}" for n in ESTIMATORS)
    rows = {}
    for every in POLL_INTERVALS:
        runs = [changes(subsample(snaps, every, every * k / PHASES)) for k in range(PHASES)]
        for name, sc in scenarios.items():
            vals = [0.0] * len(ESTIMATORS)
            for ch in runs:
                mine = [c for c in ch if c[2] in sc["docs"] and sc["start"] - 60 <= c[1]["t"] < sc["until"]]
                for i, f in enumerate(ESTIMATORS.values()):
                    vals[i] += f(mine, every, chars) / 60 / PHASES
            rows.setdefault(name, []).append(
                f"{name:<16}{every:>6}{sc['true'] / 60:>7.1f}" + "".join(f"{v:>14.1f}" for v in vals)
            )
    print(header)
    for name in rows:
        print("\n".join(rows[name]))


if __name__ == "__main__":
    main()
