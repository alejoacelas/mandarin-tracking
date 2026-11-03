"""Save the fixture articles to the Reader account in READWISE_TOKEN.

Reader dedupes by URL, so rerunning updates the same documents.
"""

import json
import os
import pathlib
import re
import urllib.request

FIXTURES = pathlib.Path(__file__).parent / "fixtures"

for path in sorted(FIXTURES.glob("*.html")):
    html = path.read_text()
    title = re.sub("<[^>]+>", "", re.search(r"<h1>(.*?)</h1>", html, re.S).group(1)).strip()
    body = {
        "url": f"https://example.com/mandarin/{path.stem}",
        "html": html,
        "title": title,
        "author": "Fixture",
        "should_clean_html": False,
        "location": "new",
    }
    req = urllib.request.Request(
        "https://readwise.io/api/v3/save/",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Token {os.environ['READWISE_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as r:
        print(path.stem, r.status, json.load(r)["url"])
