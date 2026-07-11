"""Best-effort article images for cards that arrive without one.

Crossref / PubMed / arXiv give abstracts, not pictures, so those cards render
text-only. Here we fetch the article's landing page and lift its social-share
image (og:image / twitter:image / link rel=image_src), and if the page has no
usable share card we fall back to the article's first figure.

The publishers that matter here (SNMMI's JNM, ACS, RSC) sit behind Cloudflare /
Radware bot protection that blocks on the TLS fingerprint, not the headers - so
a plain `requests` GET is a guaranteed 403 no matter how browser-like the
headers look. We fetch with curl_cffi impersonating a real browser (see
IMPERSONATE_TARGETS), which reproduces a real browser's TLS handshake and sails
through. Elsevier is the exception - its article pages captcha-wall every
non-browser client - so for those we skip the page and pull the graphical
abstract straight off the open CDN (see _elsevier_cdn_image). The images those pages point at
(og:image share cards, HighWire F1 figures) are then loadable by any real
browser, so they render fine in the app even though `requests` can't fetch them.

Everything is best-effort: any block, timeout, or missing tag just leaves the
image empty and the card renders text-only, exactly as before.
"""
from __future__ import annotations

import re
import time
from html import unescape
from urllib.parse import urljoin

import requests

try:
    from curl_cffi import requests as curl_requests
except ImportError:  # pragma: no cover - falls back to plain requests
    curl_requests = None

# curl_cffi reproduces this browser's full header + TLS fingerprint; the string
# here is only used for the plain-requests fallback path.
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
               "image/avif,image/webp,*/*;q=0.8"),
    "Accept-Language": "en-US,en;q=0.9",
}
# curl_cffi's own default "chrome" alias tracks the newest Chrome build, and
# publisher bot-walls (Cloudflare / Radware / Incapsula at Wiley, SAGE, ...) now
# flag exactly that newest fingerprint — so an unpinned curl_cffi silently
# started 403-ing pages that used to scrape fine. Pin explicit, known-good
# targets and try them in order: a 403 from one is retried with the next.
# safari18_0 clears the most walls (it's the only one SAGE and Wiley let
# through); chrome131 is a fallback for the rare host that prefers Chrome.
IMPERSONATE_TARGETS = ("safari18_0", "chrome131")
TIMEOUT = 20
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

# Boilerplate that publishers and aggregators hand back in place of a real
# picture: site logos and favicons, generic journal covers, PubMed's NLM
# banner, bioRxiv's server logo, Google News' shared feed icon, and the row of
# social-share widget icons (twitter/facebook/linkedin/mendeley) that HighWire
# pages embed. None of these say anything about the article - never use them.
_JUNK_RE = re.compile(
    r"(logo|favicon|/icon|spacer|loading|sprite|placeholder|[-_/]cover"
    r"|/badge|_\d+x\d+\.|pubmed-meta-image|googleusercontent\.com"
    r"|news\.google|/highwire/images/|twitter\.png|fb-blue|fb-\w|linkedin"
    r"|mendeley|/social[-/]|sitebuilderassets|/umbrella/|eurekaselect\.com/images"
    r"|/bentham/)", re.I)
# HighWire / Silverchair article figures: .../F1.medium.gif, .../F2.large.jpg.
# These journals (JNM and friends) ship an empty og:image but embed the real
# first figure at this predictable, article-owned path, so reach for it
# directly. We deliberately do NOT fall back to a generic first-<img> scan:
# publisher pages salt in related-article thumbnails and share icons, so an
# untargeted grab risks captioning a card with some other paper's figure.
_FIGURE_RE = re.compile(r'\bsrc\s*=\s*["\']([^"\']*/F\d+\.[^"\']+)["\']', re.I)


def is_junk_image(url: str) -> bool:
    """True for boilerplate images (logos, covers, banners) worth rejecting."""
    return bool(url) and bool(_JUNK_RE.search(url))


# Elsevier hard-blocks its article pages (sciencedirect.com serves a captcha to
# any non-browser TLS client, and doi.org resolves to a scriptless linkinghub
# stub), so og:image scraping there always comes up empty. But the graphical
# abstract (…-ga1.jpg) and first figure (…-gr1.jpg) sit on the open
# ars.els-cdn.com CDN at a path derived only from the article PII — which the
# DOI redirect hands us in the resolved URL. Reach for those directly, the same
# "predictable, article-owned path" trick used for HighWire F-figures.
_ELSEVIER_PII_RE = re.compile(r"/pii/([A-Z0-9]+)", re.I)


def _elsevier_cdn_image(session, final_url: str) -> str:
    """Graphical abstract / first figure for an Elsevier article, off the CDN."""
    m = _ELSEVIER_PII_RE.search(final_url or "")
    if not m:
        return ""
    pii = m.group(1).upper()
    for suffix in ("ga1.jpg", "gr1.jpg"):
        cdn = f"https://ars.els-cdn.com/content/image/1-s2.0-{pii}-{suffix}"
        r = _fetch(session, cdn)
        if (r is not None and r.status_code == 200
                and r.headers.get("content-type", "").lower().startswith("image")):
            return cdn
    return ""


# <meta name="citation_doi" content="10.xxxx/..."> in either attribute order.
_CITATION_DOI_RE = re.compile(
    r'<meta\b(?=[^>]*\bname\s*=\s*["\']citation_doi["\'])'
    r'[^>]*\bcontent\s*=\s*["\']([^"\']+)["\']', re.I)
_DOI_HREF_RE = re.compile(r'href\s*=\s*["\']https?://(?:dx\.)?doi\.org/([^"\']+)["\']', re.I)
_PUBMED_RE = re.compile(r"https?://pubmed\.ncbi\.nlm\.nih\.gov/(\d+)", re.I)
_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"


def _citation_doi(html: str) -> str:
    """The DOI an abstract page points at, from citation_doi or a doi.org link."""
    m = _CITATION_DOI_RE.search(html) or _DOI_HREF_RE.search(html)
    return unescape(m.group(1).strip()) if m else ""


def _pubmed_doi(pmid: str) -> str:
    """The article DOI for a PMID, via NCBI E-utilities (JSON, not scraped).

    The PubMed *page* is a bot-challenged stub for us and carries no picture
    anyway; the esummary API reliably hands back the DOI so we can image the
    publisher instead.
    """
    try:
        r = requests.get(_ESUMMARY,
                         params={"db": "pubmed", "id": pmid, "retmode": "json"},
                         headers={"User-Agent": BROWSER_UA}, timeout=TIMEOUT)
        if r.status_code >= 400:
            return ""
        rec = r.json().get("result", {}).get(pmid, {})
        for aid in rec.get("articleids", []):
            if aid.get("idtype") == "doi" and aid.get("value"):
                return str(aid["value"]).strip()
    except Exception:
        return ""
    return ""


def _new_session():
    """A curl_cffi session (impersonation is chosen per request), or a plain one."""
    if curl_requests is not None:
        return curl_requests.Session()
    return requests.Session()


def _fetch(session, url: str):
    """GET `url`, returning the response or None on any failure.

    With curl_cffi we retry across IMPERSONATE_TARGETS: publishers block
    different TLS fingerprints, so a 403 from one target is retried with the
    next, and we keep the first response that isn't a bot-block.
    """
    if curl_requests is not None and isinstance(session, curl_requests.Session):
        last = None
        for target in IMPERSONATE_TARGETS:
            try:
                r = session.get(url, timeout=TIMEOUT, allow_redirects=True,
                                impersonate=target)
            except Exception:
                continue
            last = r
            if r.status_code != 403:
                return r
        return last
    try:
        return session.get(url, headers=HEADERS, timeout=TIMEOUT,
                           allow_redirects=True)
    except Exception:
        return None


def og_image(url: str, session=None, _depth: int = 0) -> str:
    """Return a share-card or first-figure image URL for `url`, or ""."""
    if not url or not url.startswith("http"):
        return ""
    session = session or _new_session()

    # PubMed abstract pages have no image of their own (and stub us as a bot);
    # resolve the DOI via the API and image the publisher instead.
    if _depth == 0:
        pm = _PUBMED_RE.match(url)
        if pm:
            doi = _pubmed_doi(pm.group(1))
            return og_image("https://doi.org/" + doi, session, _depth=1) if doi else ""

    r = _fetch(session, url)
    if r is None:
        return ""
    base = str(r.url)

    # Elsevier article pages are captcha-walled (a 403, or a scriptless
    # linkinghub redirect stub), so scraping them never yields an image; pull
    # the graphical abstract off the open CDN using the PII in the resolved URL.
    if "sciencedirect.com" in base or "elsevier.com" in base:
        img = _elsevier_cdn_image(session, base)
        if img:
            return img

    if r.status_code >= 400:
        return ""
    html = r.text[:MAX_HTML_BYTES]

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
        val = found.get(key)
        if val and not _JUNK_RE.search(val):
            return _absolutize(val, base)

    m = _LINK_IMGSRC_RE.search(html)
    if m:
        href = _HREF_RE.search(m.group(0))
        if href:
            cand = unescape(href.group(1).strip())
            if not _JUNK_RE.search(cand):
                return _absolutize(cand, base)

    fig = _first_figure(html, base)
    if fig:
        return fig

    # Abstract-only landing pages (PubMed, Europe PMC) carry no picture of
    # their own but name the real article via citation_doi. Follow it once to
    # the publisher, who usually has a share card or figure.
    if _depth == 0:
        doi = _citation_doi(html)
        if doi:
            follow = "https://doi.org/" + doi
            if follow.rstrip("/") != url.rstrip("/"):
                return og_image(follow, session, _depth=1)
    return ""


def _first_figure(html: str, base: str) -> str:
    """The article's own first figure, when the page has no share card.

    Restricted to the HighWire/Silverchair F-number path, which is always the
    current article's figure. Anything looser risks a related-article thumbnail.
    """
    m = _FIGURE_RE.search(html)
    if m:
        cand = unescape(m.group(1).strip())
        if not _JUNK_RE.search(cand):
            return _absolutize(cand, base)
    return ""


def _absolutize(src: str, base: str) -> str:
    if src.startswith("//"):
        return "https:" + src
    if src.startswith("http"):
        return src
    return urljoin(base, src)


def enrich(cards: list[dict], pause: float = 0.3, log=print) -> int:
    """Give every card a real image where we can. Returns the count added.

    Processes cards that have no image *or* whose image is boilerplate (a logo,
    cover, or banner that slipped through an earlier harvest). When a card's
    only image is junk and we can't find a real one, we clear it so it renders
    clean text rather than a misleading picture.
    """
    session = _new_session()
    added = 0
    todo = [c for c in cards
            if not (c.get("image") or "").strip() or is_junk_image(c.get("image", ""))]
    for i, card in enumerate(todo, 1):
        had_junk = is_junk_image(card.get("image", ""))
        img = og_image(card.get("url", ""), session)
        if img:
            card["image"] = img[:500]
            added += 1
            status = "ok "
        elif had_junk:
            card["image"] = ""
            status = "junk-cleared "
        else:
            status = "-- "
        if log:
            log(f"  image {i}/{len(todo)} {status}{card.get('url', '')[:60]}")
        time.sleep(pause)
    return added
