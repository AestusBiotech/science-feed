"""TEMPORARY bake-off: which transport clears RSC's Cloudflare from a CI runner
and yields the article's og:image? Deleted once we pick a winner."""
import re
import urllib.parse

import requests

ARTICLE = "https://doi.org/10.1039/d6cc02260j"   # the paper from the screenshot
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
_GA_RE = re.compile(r'https?://[^\s"\'<>]*(?:silverchair|-ga\.)[^\s"\'<>]*', re.I)


def extract_og(html: str) -> str:
    for m in re.finditer(r"<meta\b[^>]*>", html, re.I):
        tag = m.group(0)
        prop = re.search(r'(?:property|name)\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        content = re.search(r'content\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        if prop and content and prop.group(1).strip().lower() in (
                "og:image", "og:image:secure_url", "og:image:url", "twitter:image"):
            return content.group(1).strip()
    return ""


def probe_feed_rss():
    r = requests.get("https://feeds.rsc.org/rss/cc",
                     headers={"User-Agent": UA}, timeout=30)
    m = _GA_RE.search(r.text) or re.search(r'<img[^>]+src=["\']([^"\']+)', r.text, re.I)
    return f"status={r.status_code} len={len(r.text)}", (m.group(0) if m else "")


def probe_plain():
    r = requests.get(ARTICLE, headers={"User-Agent": UA}, timeout=30,
                     allow_redirects=True)
    return f"status={r.status_code} final={r.url}", extract_og(r.text)


def probe_microlink():
    api = "https://api.microlink.io/?url=" + urllib.parse.quote(ARTICLE, safe="")
    r = requests.get(api, timeout=60)
    j = r.json()
    img = ((j.get("data") or {}).get("image") or {}).get("url", "")
    return f"http={r.status_code} apiStatus={j.get('status')}", img


def probe_jina():
    r = requests.get("https://r.jina.ai/" + ARTICLE,
                     headers={"User-Agent": UA, "Accept": "application/json"},
                     timeout=90)
    m = _GA_RE.search(r.text)
    return f"status={r.status_code} len={len(r.text)}", (m.group(0) if m else "")


def probe_playwright():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(user_agent=UA)
        pg.goto(ARTICLE, wait_until="domcontentloaded", timeout=60000)
        try:
            og = pg.get_attribute('meta[property="og:image"]', "content") or ""
        except Exception:
            og = ""
        title = pg.title()
        b.close()
        return f"title={title[:70]!r}", og


for name, fn in [("feed-rss", probe_feed_rss), ("plain", probe_plain),
                 ("microlink", probe_microlink), ("jina", probe_jina),
                 ("playwright", probe_playwright)]:
    try:
        meta, img = fn()
        print(f"[{name}] {meta}")
        print(f"[{name}] IMAGE = {img!r}")
    except Exception as e:
        print(f"[{name}] ERROR {type(e).__name__}: {e}")
    print("-" * 72, flush=True)
