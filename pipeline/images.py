"""Best-effort article images for cards that arrive without one.

Crossref / PubMed / arXiv give abstracts, not pictures, so those cards render
text-only. Two strategies, tried in order:

1. Deterministic publisher URLs (no network). A few publishers - RSC most
   importantly - serve their graphical-abstract image at a path fully
   determined by the DOI. We build that link straight from the DOI string,
   without ever fetching the page. This is the ONLY thing that works for RSC:
   it bot-blocks its article pages from every datacenter IP (both CI and any
   server-side scraper get 403), yet the reader's own browser - a residential
   client that isn't blocked - loads the image just fine. See rsc_ga_image.

2. og:image scraping (network). Fetch the landing page and lift its
   social-share image (og:image / twitter:image / link rel=image_src) - for
   most other publishers that is the paper's first figure or a journal cover.

Everything is best-effort: any block, timeout, or missing tag just leaves the
image empty and the card renders text-only, exactly as before. If a built or
scraped URL turns out to 404, the reader's browser drops the <img> on error.
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


# --------------------------------------------------------------------------
# Deterministic publisher image URLs (no network)
# --------------------------------------------------------------------------
# RSC DOIs since 2020 encode the year and journal in the suffix:
#   10.1039/d6cc02260j  ->  d = post-2020 scheme, 6 = 2026, cc = Chem. Commun.
# The graphical abstract is served at a fixed path built from those pieces, so
# we never have to touch the bot-blocked article page to know the image URL.
_RSC_DOI_RE = re.compile(r"10\.1039/(d(\d)([a-z]{2})[0-9a-z]+)", re.I)


def rsc_ga_image(url: str) -> str:
    """Graphical-abstract GIF URL for an RSC DOI, or "" if `url` isn't one.

    Pure string work - no request is made. The URL may 404 for the rare
    article without a graphical abstract; the reader's browser drops the image
    on error, so a wrong guess costs nothing beyond a text-only card.
    """
    m = _RSC_DOI_RE.search(url or "")
    if not m:
        return ""
    doi_body = m.group(1).lower()          # d6cc02260j
    year = 2020 + int(m.group(2))          # 6 -> 2026
    journal = m.group(3).upper()           # cc -> CC
    return (f"https://pubs.rsc.org/image/article/{year}/{journal}/"
            f"{doi_body}/{doi_body}-ga.gif")


def publisher_image(url: str) -> str:
    """Deterministic image URL for a known publisher, or "" if none applies.

    Dispatch point for the no-network builders. RSC is the one that matters
    today (its pages 403 every scraper); other publishers can slot in here.
    """
    return rsc_ga_image(url)


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
        url = card.get("url", "")
        # Prefer the deterministic publisher URL (free, and works for hosts that
        # 403 every scraper); fall back to scraping the share image otherwise.
        built = publisher_image(url)
        img = built or og_image(url, session)
        if img:
            card["image"] = img[:500]
            added += 1
        if log:
            how = "built" if built else ("ok   " if img else "--   ")
            log(f"  image {i}/{len(todo)} {how} {url[:60]}")
        if not built:
            time.sleep(pause)   # only rate-limit the calls that actually fetch
    return added
