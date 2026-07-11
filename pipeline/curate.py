"""Curator: score candidates against config/interests.md with one Haiku call
per batch, keep everything at or above a score bar, assign a lane. First AI stage.

The keep-cut is score-based, not a fixed count: every paper/news item scoring at
or above --keep-score makes the feed, however many that is, so a good source is
never dropped just because others outranked it that night. MAX_ITEMS_PER_RUN is
only a runaway-cost backstop, not the cap.

Runs through Claude Code in subscription mode (the `claude` CLI), not the
metered API. Each response is a JSON array of {index, score, lane}; interests.md
is the system prompt.

If the claude CLI isn't installed, exits 0 with a "skipped" notice so forks and
dry runs don't fail.
"""
from __future__ import annotations

import argparse
import json

import common as c
import images

BATCH = 30

# Reddit is papers-first "garnish" by design, but the reader wants relevant
# threads from their subreddits to actually surface. Nudge on-topic Reddit
# scores up a notch so more clear the keep-cut, without letting junk through
# (a genuinely off-topic thread the curator scored near-zero still won't make it).
REDDIT_SCORE_BOOST = 12


def _schema(lane_list: list[str]) -> dict:
    # Structured-output schemas can't use minimum/maximum; the 0-100 range is
    # described in the prompt instead. Every object needs additionalProperties:false.
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "index": {"type": "integer"},
                        "score": {"type": "integer"},
                        "lane": {"type": "string", "enum": lane_list},
                    },
                    "required": ["index", "score", "lane"],
                },
            }
        },
        "required": ["results"],
    }


def _prompt(batch: list[dict]) -> str:
    lines = []
    for i, cand in enumerate(batch):
        snippet = cand["snippet"][:280]
        meta = [cand["suggested_lane"]]
        if cand.get("published"):
            meta.append(f"published {cand['published']}")
        if cand.get("preprint"):
            meta.append("preprint")
        if cand.get("venue"):
            meta.append(cand["venue"])
        lines.append(
            f"[{i}] ({'; '.join(meta)}) {cand['original_title']}"
            + (f"\n    {snippet}" if snippet else "")
        )
    return (
        "Score each item 0-100 for how much this reader would want to open it, "
        "and assign one lane. Apply the recency rules in the rubric using the "
        "publication date shown. Return one result object per item, using the "
        "item's bracket number as `index`.\n\n" + "\n".join(lines)
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-score", type=int, default=58,
                    help="minimum curator score (0-100) for a paper/news item to "
                         "make the feed. This is the gate, not a fixed count: "
                         "every item at or above the bar is kept, so a good "
                         "source is never cut just because others outranked it. "
                         "(reddit is gated separately by --reddit-min.)")
    ap.add_argument("--reddit-min", type=int, default=55,
                    help="minimum curator score for a reddit thread to count as "
                         "relevant; relevant reddit threads are kept uncapped and "
                         "in addition to the score-gated papers/news")
    args = ap.parse_args()

    candidates = c.read_json(c.CANDIDATES, default=[]) or []
    if not candidates:
        c.log("no candidates to score; writing empty survivors")
        c.write_json(c.SURVIVORS, [])
        return

    if not c.claude_bin():
        c.log("claude CLI not found - skipping curation (exit 0)")
        c.write_json(c.SURVIVORS, [])
        return

    system = c.load_text("interests.md")
    schema = _schema(c.lanes())

    scored: list[dict] = []
    for start in range(0, len(candidates), BATCH):
        batch = candidates[start:start + BATCH]
        try:
            results = c.claude_json(_prompt(batch), system, schema)["results"]
        except (RuntimeError, json.JSONDecodeError, KeyError, TypeError) as exc:
            c.die(f"could not get/parse curator response: {exc}")
        for r in results:
            idx = r.get("index")
            if not isinstance(idx, int) or not (0 <= idx < len(batch)):
                continue
            cand = dict(batch[idx])
            cand["score"] = max(0, min(100, int(r.get("score", 0))))
            if cand.get("source") == "reddit":
                cand["score"] = min(100, cand["score"] + REDDIT_SCORE_BOOST)
            cand["lane"] = r.get("lane") or cand["suggested_lane"]
            scored.append(cand)
        c.log(f"  scored {start + len(batch)}/{len(candidates)}")

    # Reddit is kept separately from the papers/news pool: every thread the
    # curator finds relevant that night is added on top, uncapped, gated only by
    # --reddit-min. The papers/news pool is gated by --keep-score below.
    reddit = [x for x in scored
              if x.get("source") == "reddit" and x["score"] >= args.reddit_min]
    rest = [x for x in scored if x.get("source") != "reddit"]

    rest.sort(key=lambda x: x["score"], reverse=True)
    reddit.sort(key=lambda x: x["score"], reverse=True)
    # Score-based keep: everything at or above the bar, however many that is.
    kept = [x for x in rest if x["score"] >= args.keep_score]
    # MAX_ITEMS_PER_RUN is only a runaway-cost backstop — if a night is
    # pathologically large it trims the lowest-scoring overflow (the least good),
    # never the bar itself. Raise it (env) if it ever bites a normal run.
    if len(kept) > c.MAX_ITEMS_PER_RUN:
        c.log(f"note: {len(kept)} cleared the score bar (>= {args.keep_score}); "
              f"backstop-capping to {c.MAX_ITEMS_PER_RUN}")
        kept = kept[:c.MAX_ITEMS_PER_RUN]
    survivors = kept + reddit

    # Abstract-only sources (Crossref/PubMed/arXiv) arrive without a picture;
    # scrape the article's share image so those cards aren't all text. Only the
    # keepers are fetched, and it's best-effort - a block just leaves it empty.
    added = images.enrich(survivors, log=c.log)
    c.log(f"images: +{added} for {len(survivors)} survivors")

    c.write_json(c.SURVIVORS, survivors)
    if survivors:
        n_reddit = len(reddit)
        n_rest = len(survivors) - n_reddit
        hi = max(x["score"] for x in survivors)
        lo = min(x["score"] for x in survivors)
        c.log(f"kept {len(survivors)} of {len(scored)} scored "
              f"({n_rest} papers/news + {n_reddit} reddit; score {lo}-{hi})")
    else:
        c.log("kept 0 survivors")


if __name__ == "__main__":
    main()
