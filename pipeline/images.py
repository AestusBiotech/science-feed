"""Best-effort article images for cards that arrive without one.

Crossref / PubMed / arXiv give abstracts, not pictures, so those cards render
text-only. Here we fetch the article's landing page and lift its social-share
image (og:image / twitter:image / link rel=image_src) - for most publishers
that is the paper's first figure or a journal cover.

Everything is best-effort: any block, timeout, or missing tag just leaves the
image empty and the card renders text-only, exactly as before. Some publishers
(ACS, RSC, SNM) sit behind bot protection and will simply return nothing.
"""
from __future__ import annotations

import re
import time
from html import unescape
from urllib.parse import urljoin

import requests

BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = 15
MAX_HTML_BYTES = 600_000   # the <head> is always near the top; don't read novels

# <meta property="og:image" content="..."> in any attribute order.
_META_RE = re.compile(r"<meta\b[^>]*>", re.I)
_PROP_RE = re.compile(r'(?:property|name)\s*=\s*["\']([^"\']+)["\']', re.I)
_CONTENT_RE = re.compile(r'content\s*=\s*["\']([^"\']+)["\']', re.I)
_LINK_IMGSRC_RE = re.compile(
    r'<link\b[^>]*rel\s*=\s*["\']image_src["\'][^>]*>', re.I)
_HREF_RE = re.compile(r'href\s*=\s*["\']([^"\']+)["\']', re.I)
# Social/share cards, in the order we trust them.
_WANTED = ("og:image:secure_url", "og:image:url", "og:image",
           "twitter:image:src", "twitter:image")


def og_image(url: str, session: requests.Session | None = None) -> str:
    """Return a share-card image URL for `url`, or "" if none can be had."""
    if not url or not url.startswith("http"):
        return ""
    get = (session or requests).get
    try:
        r = get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
    except requests.exceptions.RequestException:
        return ""
    if r.status_code >= 400:
        return ""
    html = r.text[:MAX_HTML_BYTES]
    base = str(r.url)

    found: dict[str, str] = {}
    for tag in _META_RE.findall(html):
        prop = _PROP_RE.search(tag)
        content = _CONTENT_RE.search(tag)
        if not prop or not content:
            continue
        key = prop.group(1).strip().lower()
        if key in _WANTED and key not in found:
            found[key] = unescape(content.group(1).strip())

    for key in _WANTED:
        if found.get(key):
            return _absolutize(found[key], base)

    m = _LINK_IMGSRC_RE.search(html)
    if m:
        href = _HREF_RE.search(m.group(0))
        if href:
            return _absolutize(unescape(href.group(1).strip()), base)
    return ""


def _absolutize(src: str, base: str) -> str:
    if src.startswith("//"):
        return "https:" + src
    if src.startswith("http"):
        return src
    return urljoin(base, src)


def enrich(cards: list[dict], pause: float = 0.3, log=print) -> int:
    """Fill `image` on every card that lacks one. Returns the count added."""
    session = requests.Session()
    added = 0
    todo = [c for c in cards if not (c.get("image") or "").strip()]
    for i, card in enumerate(todo, 1):
        img = og_image(card.get("url", ""), session)
        if img:
            card["image"] = img[:500]
            added += 1
        if log:
            log(f"  image {i}/{len(todo)} "
                f"{'ok ' if img else '-- '}{card.get('url', '')[:60]}")
        time.sleep(pause)
    return added
