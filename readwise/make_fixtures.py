"""Generate original Mandarin articles for testing Reader time tracking.

Writes readwise/fixtures/<slug>.html. Needs ANTHROPIC_API_KEY in the environment.
"""

import json
import os
import pathlib
import urllib.request
from concurrent.futures import ThreadPoolExecutor

OUT = pathlib.Path(__file__).parent / "fixtures"

ARTICLES = [
    ("morning-market", "在早市买菜的一个早晨", 400, "HSK3"),
    ("rainy-subway", "下雨天坐地铁的小故事", 800, "HSK3"),
    ("tea-history", "中国茶的简短历史", 1500, "HSK4"),
    ("city-cycling", "城市里骑自行车的好处和问题", 2500, "HSK4"),
    ("remote-work", "远程工作改变了年轻人的生活方式", 4000, "HSK5"),
    ("learning-tones", "Learning Mandarin tones: 一个学习者的笔记", 1200, "mixed English and Chinese, about half each"),
]


def generate(slug, title, chars, level):
    prompt = (
        f"Write an original Mandarin article titled「{title}」for a learner at {level} level, "
        f"about {chars} Chinese characters long, in simplified Chinese. "
        "Use several paragraphs. Return only HTML: <h1> title then <p> paragraphs, no other text."
    )
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": "claude-opus-5-5",
            "max_tokens": 8000,
            "messages": [{"role": "user", "content": prompt}],
        }).encode(),
        headers={
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        html = next(b["text"] for b in json.load(r)["content"] if b["type"] == "text").strip()
    html = html.removeprefix("```html").removesuffix("```").strip()
    (OUT / f"{slug}.html").write_text(html)
    cjk = sum("一" <= c <= "鿿" for c in html)
    print(f"{slug}: {cjk} CJK chars")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(lambda a: generate(*a), ARTICLES))
