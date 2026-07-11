"""Harvest raw candidates from free structured APIs. No AI.

Reads config/sources.yml, skips anything already in data/seen_ids.json, applies
link hygiene (Wikipedia/junk blocklist + dead-link drop) and recency caps, and
writes a bounded, normalized candidate pool to scratch/candidates.json.

Sourcing shape (see sources.yml for the why):
  - Primary literature via Crossref (ACS/RSC/JNM, whose own feeds block CI) and
    publisher RSS (Nature/Science/Cell/Springer/ScienceDirect).
  - Preprints: ChemRxiv (Crossref prefix), bioRxiv (RSS), arXiv (Atom). Tagged.
  - PubMed E-utilities for the reader's field.
  - ClinicalTrials.gov (API v2) for trial readouts / status changes, and FDA
    press-release RSS for approvals — the biotech-news signal layer.
  - Reddit, thread-linked only, last 48h. No Hacker News.

Modes:
  nightly  (default)  -- recent items
  backfill            -- widens the journal date window for archive building

Each source degrades gracefully: a failing source logs a warning and is
skipped. The run only fails if *zero* candidates were gathered from anywhere.
"""
from __future__ import annotations

import argparse
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Iterable
from urllib.parse import urlsplit
from xml.sax.saxutils import unescape

import feedparser
import requests

import common as c
import images

UA = "personal-science-feed/1.0 (single-user reading list; mailto:info@aestusbiotech.com)"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
MAILTO = "info@aestusbiotech.com"
HTTP_TIMEOUT = 20
REDDIT_MIN_SCORE = 25
CROSSREF_ROWS = 12
CTGOV_ROWS = 20

# ClinicalTrials.gov API v2. We pull trials whose status recently *changed* to a
# readout-signalling state (default below) and link to the canonical study page.
CTGOV_API = "https://clinicaltrials.gov/api/v2/studies"
CTGOV_FIELDS = ("NCTId,BriefTitle,OverallStatus,LastUpdatePostDate,Phase,"
                "Condition,InterventionName,LeadSponsorName")
# Statuses worth surfacing as a "readout / change" rather than recruiting churn.
# Pipe-separated per the v2 filter syntax; overridable per source via `status:`.
CTGOV_DEFAULT_STATUS = "COMPLETED|TERMINATED|ACTIVE_NOT_RECRUITING"
_CTGOV_PHASE = {
    "EARLY_PHASE1": "Early Phase 1", "PHASE1": "Phase 1", "PHASE2": "Phase 2",
    "PHASE3": "Phase 3", "PHASE4": "Phase 4", "NA": "",
}

# Reddit killed its free API, but the per-account RSS feed still serves from
# datacenter IPs when you pass a personal feed token (Reddit prefs -> RSS feeds:
# the ?feed=<token>&user=<name> pair). Set both env vars to harvest Reddit
# reliably in CI; without them the source falls back to the unauthenticated
# endpoint and simply degrades to zero when the runner's IP is throttled.
REDDIT_FEED_TOKEN = os.environ.get("REDDIT_FEED_TOKEN", "").strip()
REDDIT_USER = os.environ.get("REDDIT_USER", "").strip()

# Recency caps (overridden from sources.yml `recency:` block in main()).
REDDIT_MAX_AGE_HOURS = 48
NEWS_MAX_AGE_DAYS = 31

# Domains that must never appear in the feed. Checked against the URL host and
# all parent domains, so "en.wikipedia.org" and "de.m.wikipedia.org" both match.
BLOCKED_DOMAINS = {
    "wikipedia.org", "m.wikipedia.org", "wikimedia.org", "wiktionary.org",
    "fandom.com", "quora.com", "pinterest.com", "researchgate.net",
    "sci-hub.se",
}

_TAG_RE = re.compile(r"<[^>]+>")


def _clean(text: str | None) -> str:
    if not text:
        return ""
    return unescape(" ".join(text.split())).strip()


def _strip_html(text: str | None) -> str:
    """Crossref abstracts/titles arrive as JATS/HTML; flatten to plain text."""
    if not text:
        return ""
    return _clean(unescape(_TAG_RE.sub(" ", text)))


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _blocked(url: str) -> bool:
    host = _host(url)
    if not host:
        return True
    # match the host and every parent domain against the blocklist
    parts = host.split(".")
    for i in range(len(parts) - 1):
        if ".".join(parts[i:]) in BLOCKED_DOMAINS:
            return True
    return False


def _link_alive(url: str) -> bool:
    """Conservative liveness check for outbound article/news links.

    Drops ONLY links that are provably gone: HTTP 404/410, or a DNS/connection
    failure. A 403/401/429 means the publisher is blocking a bot, not that the
    article is missing (doi.org HEAD returns 403 for ACS, for instance), so
    those count as alive. Timeouts and TLS quirks also count as alive — better a
    rare stale link than dropping good papers on a slow night.
    """
    try:
        r = requests.get(url, headers={"User-Agent": BROWSER_UA},
                         timeout=12, allow_redirects=True, stream=True)
        status = r.status_code
        r.close()
        return status not in (404, 410)
    except requests.exceptions.ConnectionError:
        return False
    except requests.exceptions.RequestException:
        return True  # timeout / TLS / redirects: assume alive, don't false-drop


def _candidate(source: str, url: str, title: str, snippet: str, published: str,
               lane: str, preprint: bool = False, venue: str = "",
               image: str = "") -> dict | None:
    url = (url or "").strip()
    title = _clean(title)
    if not url or not title:
        return None
    return {
        "id": c.sha1_id(url),
        "source": source,
        "url": url,
        "original_title": title[:300],
        "snippet": _clean(snippet)[:600],
        "published": published or "",
        "suggested_lane": lane,
        "preprint": bool(preprint),
        "venue": _clean(venue)[:120],
        "image": (image or "").strip()[:500],
    }


_IMG_SRC_RE = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']', re.I)
_IMG_EXT_RE = re.compile(r"\.(jpe?g|png|gif|webp|avif)(\?|#|$)", re.I)


def _entry_image(entry, summary_html: str = "") -> str:
    """Best-effort thumbnail / figure image URL for a feed entry.

    Sources that carry pictures: Reddit (media:thumbnail on link & image posts)
    and publisher RSS (media:content / enclosure figures, or an <img> in the
    summary HTML). Text-only posts and the abstract-only APIs (Crossref, PubMed,
    arXiv) have none — those just come back as "" and render text-only.

    Feeds also love to hand back boilerplate — Google News' shared icon,
    bioRxiv's server logo — so junk is dropped here; a later scrape may still
    find a real figure for the same card.
    """
    def _ok(u: str) -> bool:
        return u.startswith("http") and not images.is_junk_image(u)

    for m in (getattr(entry, "media_thumbnail", None) or []):
        u = (m.get("url") or "").strip()
        if _ok(u):
            return u
    for m in (getattr(entry, "media_content", None) or []):
        u = (m.get("url") or "").strip()
        if _ok(u) and (m.get("medium") == "image" or _IMG_EXT_RE.search(u)):
            return u
    for link in (getattr(entry, "links", None) or []):
        if link.get("rel") == "enclosure" and (link.get("type") or "").startswith("image/"):
            u = (link.get("href") or "").strip()
            if _ok(u):
                return u
    m = _IMG_SRC_RE.search(summary_html or "")
    if m and _ok(m.group(1).strip()):
        return m.group(1).strip()
    return ""


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")


def _age_days(published: str) -> float | None:
    """Age in days from a 'YYYY-MM-DD' string, or None if unparseable."""
    if not published:
        return None
    try:
        d = datetime.strptime(published[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - d).total_seconds() / 86400.0


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
def harvest_crossref(entry: dict, mode: str) -> Iterable[dict]:
    """Primary literature (by ISSN) or preprints (by DOI prefix) via Crossref.

    Links out to the version-of-record DOI. Reliable where publisher RSS is
    IP-blocked (ACS, RSC, J. Nucl. Med.).
    """
    lane = entry.get("lane", "wildcard")
    preprint = bool(entry.get("preprint"))
    name = entry.get("name", "")
    window_months = 24 if mode == "nightly" else 72
    from_date = _iso_days_ago(window_months * 30)
    base = "https://api.crossref.org"

    if entry.get("prefix"):
        # ChemRxiv and other preprint prefixes: sort by deposit/created date.
        url = (f"{base}/prefixes/{entry['prefix']}/works"
               f"?filter=type:posted-content,from-created-date:{from_date}"
               f"&sort=created&order=desc&rows={CROSSREF_ROWS}"
               "&select=DOI,title,abstract,created,posted,container-title"
               f"&mailto={MAILTO}")
    else:
        url = (f"{base}/journals/{entry['issn']}/works"
               f"?filter=from-pub-date:{from_date}"
               f"&sort=published&order=desc&rows={CROSSREF_ROWS}"
               "&select=DOI,title,abstract,published,container-title"
               f"&mailto={MAILTO}")

    r = requests.get(url, headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    for it in r.json().get("message", {}).get("items", []):
        doi = it.get("DOI")
        if not doi:
            continue
        title = _strip_html((it.get("title") or [""])[0])
        abstract = _strip_html(it.get("abstract") or "")
        container = it.get("container-title") or []
        venue = (container[0] if container else name) or ""
        pub = _crossref_date(it)
        snippet = abstract or venue
        src = "chemrxiv" if entry.get("prefix") else "crossref"
        cand = _candidate(src, f"https://doi.org/{doi}", title, snippet, pub,
                          lane, preprint=preprint, venue=venue)
        if cand:
            yield cand


def _crossref_date(item: dict) -> str:
    """Best available date from a Crossref record, as 'YYYY-MM-DD'."""
    for key in ("published", "posted", "published-online", "issued", "created"):
        parts = (item.get(key) or {}).get("date-parts") or [[]]
        dp = parts[0]
        if dp and dp[0]:
            y = dp[0]
            m = dp[1] if len(dp) > 1 else 1
            d = dp[2] if len(dp) > 2 else 1
            return f"{y:04d}-{m:02d}-{d:02d}"
    return ""


def harvest_reddit(entry: dict, mode: str) -> Iterable[dict]:
    """Reddit top posts, THREAD-linked, within the last 48h.

    The RSS <link> is the comment thread, which is exactly what we want — never
    the outbound URL, since that link is where Wikipedia and dead-blog junk used
    to leak in. With REDDIT_FEED_TOKEN + REDDIT_USER set, the request uses the
    authenticated per-account feed, which serves reliably from CI. Without them
    it falls back to the public endpoint and may degrade to zero on a throttled
    runner IP; the feed is papers-first regardless.
    """
    sub = entry["sub"]
    lane = entry.get("lane", "wildcard")
    url = f"https://www.reddit.com/r/{sub}/top/.rss?t=week"
    if REDDIT_FEED_TOKEN and REDDIT_USER:
        url += f"&feed={REDDIT_FEED_TOKEN}&user={REDDIT_USER}"   # clears the IP throttle
    r = requests.get(url, headers={"User-Agent": BROWSER_UA}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    feed = feedparser.parse(r.content)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=REDDIT_MAX_AGE_HOURS)
    for e in feed.entries:
        pp = getattr(e, "published_parsed", None) or getattr(e, "updated_parsed", None)
        pub = ""
        if pp:
            when = datetime(*pp[:6], tzinfo=timezone.utc)
            if when < cutoff:  # 48h window
                continue
            pub = when.strftime("%Y-%m-%d")
        thread = getattr(e, "link", "")  # the reddit comment thread
        # Reddit's RSS summary is HTML boilerplate ("submitted by ... [link]
        # [comments]"); keep only the lead text as a snippet, but mine the raw
        # HTML (and media tags) for a preview image first.
        summary_html = getattr(e, "summary", "") or getattr(e, "description", "")
        image = _entry_image(e, summary_html)
        summary = _strip_html(summary_html)
        summary = re.split(r"submitted by", summary)[0].strip()
        cand = _candidate("reddit", thread, getattr(e, "title", ""),
                          summary, pub, lane, image=image)
        if cand:
            yield cand


def harvest_arxiv(entry: dict, mode: str) -> Iterable[dict]:
    cat = entry["cat"]
    lane = entry.get("lane", "wildcard")
    preprint = bool(entry.get("preprint"))
    url = ("http://export.arxiv.org/api/query?"
           f"search_query=cat:{cat}&sortBy=submittedDate&sortOrder=descending"
           "&start=0&max_results=30")
    feed = feedparser.parse(url)
    for e in feed.entries:
        pub = getattr(e, "published", "")[:10]
        cand = _candidate("arxiv", getattr(e, "link", ""), getattr(e, "title", ""),
                          getattr(e, "summary", ""), pub, lane,
                          preprint=preprint, venue="arXiv")
        if cand:
            yield cand


def harvest_pubmed(entry: dict, mode: str) -> Iterable[dict]:
    query = entry["query"]
    lane = entry.get("lane", "wildcard")
    eutils = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    esearch = requests.get(
        f"{eutils}/esearch.fcgi",
        params={"db": "pubmed", "term": query, "retmax": 25,
                "retmode": "json", "sort": "date"},
        headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    esearch.raise_for_status()
    ids = esearch.json().get("esearchresult", {}).get("idlist", [])
    if not ids:
        return
    time.sleep(0.34)  # respect the 3 req/sec unauthenticated limit
    esum = requests.get(
        f"{eutils}/esummary.fcgi",
        params={"db": "pubmed", "id": ",".join(ids), "retmode": "json"},
        headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    esum.raise_for_status()
    result = esum.json().get("result", {})
    for pmid in result.get("uids", []):
        rec = result.get(pmid, {})
        url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
        pub = (rec.get("sortpubdate") or rec.get("pubdate") or "")[:10].replace("/", "-")
        venue = rec.get("source", "")
        cand = _candidate("pubmed", url, rec.get("title", ""), venue, pub, lane,
                          venue=venue)
        if cand:
            yield cand


def harvest_rss(entry: dict, mode: str) -> Iterable[dict]:
    url = entry["url"]
    lane = entry.get("lane", "wildcard")
    preprint = bool(entry.get("preprint"))
    feed = feedparser.parse(url, agent=UA)
    for e in feed.entries[:30]:
        pub = ""
        if getattr(e, "published_parsed", None):
            pub = time.strftime("%Y-%m-%d", e.published_parsed)
        elif getattr(e, "updated_parsed", None):
            pub = time.strftime("%Y-%m-%d", e.updated_parsed)
        summary = getattr(e, "summary", "") or getattr(e, "description", "")
        image = _entry_image(e, summary)
        cand = _candidate("rss", getattr(e, "link", ""), getattr(e, "title", ""),
                          _strip_html(summary), pub, lane, preprint=preprint,
                          image=image)
        if cand:
            yield cand


def _ctgov_date(struct: dict) -> str:
    """'YYYY-MM-DD' from a ClinicalTrials date struct, padding partial dates."""
    d = ((struct or {}).get("date") or "").strip()
    if len(d) == 7:            # 'YYYY-MM' -> first of month, so it stays parseable
        d += "-01"
    return d[:10]


def _ctgov_snippet(phases, status, conds, intervs, sponsor) -> str:
    """One dense line of substance for the curator: phase, status, what & who."""
    phase = "/".join(p for p in (_CTGOV_PHASE.get(x, x) for x in phases) if p)
    bits = [
        phase,
        (status or "").replace("_", " ").title(),
        ", ".join(conds[:2]),
        ", ".join(x for x in intervs[:2] if x),
        f"Sponsor: {sponsor}" if sponsor else "",
    ]
    return " · ".join(b for b in bits if b)


def harvest_clinicaltrials(entry: dict, mode: str) -> Iterable[dict]:
    """Trial readouts / status changes from ClinicalTrials.gov (API v2).

    Surfaces trials whose status recently moved to a readout-signalling state
    (completed, terminated, active-not-recruiting) — the "trial readouts,
    approvals" the biotech-news lane asks for — newest-change-first, rather than
    routine recruiting churn. Mark the source `news: true` so the recency cap in
    main() drops anything past the window. Links to the canonical study page.
    """
    lane = entry.get("lane", "biotech news")
    params = {
        "query.term": entry["query"],
        "filter.overallStatus": entry.get("status", CTGOV_DEFAULT_STATUS),
        "sort": "LastUpdatePostDate:desc",
        "pageSize": CTGOV_ROWS,
        "fields": CTGOV_FIELDS,
    }
    r = requests.get(CTGOV_API, params=params,
                     headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    for study in r.json().get("studies", []):
        ps = study.get("protocolSection", {})
        ident = ps.get("identificationModule", {})
        st = ps.get("statusModule", {})
        nct = ident.get("nctId", "")
        if not nct:
            continue
        phases = ps.get("designModule", {}).get("phases", []) or []
        conds = ps.get("conditionsModule", {}).get("conditions", []) or []
        intervs = [i.get("name", "") for i in
                   (ps.get("armsInterventionsModule", {}).get("interventions") or [])]
        sponsor = (ps.get("sponsorCollaboratorsModule", {})
                   .get("leadSponsor", {}).get("name", ""))
        snippet = _ctgov_snippet(phases, st.get("overallStatus", ""),
                                 conds, intervs, sponsor)
        cand = _candidate("clinicaltrials",
                          f"https://clinicaltrials.gov/study/{nct}",
                          ident.get("briefTitle", ""), snippet,
                          _ctgov_date(st.get("lastUpdatePostDateStruct", {})),
                          lane, venue="ClinicalTrials.gov")
        if cand:
            yield cand


HANDLERS = {
    "crossref": harvest_crossref,
    "pubmed": harvest_pubmed,
    "arxiv": harvest_arxiv,
    "reddit": harvest_reddit,
    "rss": harvest_rss,
    "clinicaltrials": harvest_clinicaltrials,
}


def _entry_label(kind: str, entry: dict) -> str:
    for key in ("name", "issn", "prefix", "sub", "cat", "url", "query"):
        if entry.get(key):
            return f"{kind}:{entry[key]}"
    return kind


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["nightly", "backfill"], default="nightly")
    args = ap.parse_args()

    sources = c.load_sources()
    recency = sources.get("recency", {}) or {}
    global REDDIT_MAX_AGE_HOURS, NEWS_MAX_AGE_DAYS
    REDDIT_MAX_AGE_HOURS = int(recency.get("reddit_max_age_hours", REDDIT_MAX_AGE_HOURS))
    NEWS_MAX_AGE_DAYS = int(recency.get("news_max_age_days", NEWS_MAX_AGE_DAYS))

    seen = c.load_seen()
    pool: dict[str, dict] = {}   # id -> candidate, de-duped within the run
    sources_ok = 0
    sources_failed = 0
    dropped_blocked = 0
    dropped_dead = 0
    dropped_old = 0

    for kind, handler in HANDLERS.items():
        for entry in sources.get(kind, []) or []:
            label = _entry_label(kind, entry)
            is_news = bool(entry.get("news"))
            try:
                got = 0
                for cand in handler(entry, args.mode):
                    cid = cand["id"]
                    if cid in seen or cid in pool:
                        continue
                    if _blocked(cand["url"]):
                        dropped_blocked += 1
                        continue
                    if is_news:
                        age = _age_days(cand["published"])
                        if age is not None and age > NEWS_MAX_AGE_DAYS:
                            dropped_old += 1
                            continue
                    # Liveness check only for outbound article/news links; DOI,
                    # PubMed, arXiv and reddit-thread URLs are canonical.
                    if kind == "rss" and not _link_alive(cand["url"]):
                        dropped_dead += 1
                        continue
                    pool[cid] = cand
                    got += 1
                sources_ok += 1
                c.log(f"  {label}: +{got}")
            except Exception as exc:  # one bad source must not sink the run
                sources_failed += 1
                c.log(f"  {label}: FAILED ({exc.__class__.__name__}: {exc})")
            time.sleep(0.4)  # be polite between requests

    candidates = list(pool.values())
    # Shuffle before capping so a full pool is truncated fairly across sources
    # rather than dropping whichever sources happened to be harvested last.
    random.shuffle(candidates)
    # Reddit is exempt from the pool cap: every thread found that night reaches
    # the curator uncapped, so any relevant one can make the feed. Only the much
    # larger papers/news pool is truncated to hold scoring cost down.
    reddit = [x for x in candidates if x.get("source") == "reddit"]
    rest = [x for x in candidates if x.get("source") != "reddit"]
    if len(rest) > c.CANDIDATE_POOL_CAP:
        rest = rest[: c.CANDIDATE_POOL_CAP]
    candidates = reddit + rest

    c.write_json(c.CANDIDATES, candidates)
    c.log(f"harvested {len(candidates)} new candidates "
          f"({sources_ok} sources ok, {sources_failed} failed, mode={args.mode}); "
          f"dropped {dropped_blocked} blocked, {dropped_dead} dead, {dropped_old} stale")

    if not candidates and sources_ok == 0:
        c.die("every source failed and no candidates were gathered")


if __name__ == "__main__":
    main()
