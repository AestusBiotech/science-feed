"""Curator: score candidates against config/interests.md with one Haiku call
per batch, keep the top N, assign a lane. First AI stage.

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
    ap.add_argument("--keep", type=int, default=40,
                    help="how many top-scoring items to keep")
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

    keep = min(args.keep, c.MAX_ITEMS_PER_RUN)
    scored.sort(key=lambda x: x["score"], reverse=True)
    survivors = scored[:keep]
    c.write_json(c.SURVIVORS, survivors)
    if survivors:
        lo, hi = survivors[-1]["score"], survivors[0]["score"]
        c.log(f"kept {len(survivors)} of {len(scored)} scored (score {lo}-{hi})")
    else:
        c.log("kept 0 survivors")


if __name__ == "__main__":
    main()
