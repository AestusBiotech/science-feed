"""Rewriter: turn each survivor's title + snippet into a hook `title` and a
short `blurb` in the user's voice (config/voice.md). Second AI stage.

Reddit is exempt: threads keep their own title and lead text verbatim, since a
thread is someone talking and the voice belongs to them, not to us. Only
papers/news go to the model.

Batches ~10 items per request through Claude Code in subscription mode (the
`claude` CLI, not the metered API), with the voice guide as the system prompt.
Each reply is a JSON {index, title, blurb} array. A batch that still fails
after claude_json's own retries is dropped and the run continues — one flaky
call must not cost the whole night. But if more than one batch is lost, that
is breakage rather than a blip: exit nonzero without writing cards so the
feed stays at its last good state.
"""
from __future__ import annotations

import json

import common as c

BATCH = 10

SCHEMA = {
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
                    "title": {"type": "string"},
                    "blurb": {"type": "string"},
                },
                "required": ["index", "title", "blurb"],
            },
        }
    },
    "required": ["results"],
}


def _prompt(batch: list[dict]) -> str:
    lines = []
    for i, s in enumerate(batch):
        snippet = s["snippet"][:800]
        lines.append(
            f"[{i}] lane: {s['lane']}\noriginal title: {s['original_title']}"
            + (f"\nsnippet: {snippet}" if snippet else "")
        )
    return (
        "Rewrite each item into a hook title and a short blurb in the "
        "voice from the style guide, its length following the substance rather "
        "than a fixed sentence count. Return one result per item, using the "
        "bracket number as `index`.\n\n" + "\n\n".join(lines)
    )


def _card(s: dict, title: str, blurb: str, harvested: str) -> dict:
    return {
        "id": s["id"],
        "source": s["source"],
        "url": s["url"],
        "original_title": s["original_title"],
        "title": title,
        "blurb": blurb,
        "lane": s["lane"],
        "published": s.get("published", ""),
        "harvested": harvested,
        "score": s.get("score", 0),
        "preprint": bool(s.get("preprint", False)),
        "venue": s.get("venue", ""),
        "image": s.get("image", ""),
    }


def main() -> None:
    survivors = c.read_json(c.SURVIVORS, default=[]) or []
    if not survivors:
        c.log("no survivors to rewrite; writing empty cards")
        c.write_json(c.CARDS, [])
        return

    harvested = c.today()

    # Reddit threads never reach the model; they carry their own words through.
    raw = {s["id"]: _card(s, s["original_title"].strip(), s["snippet"].strip(), harvested)
           for s in survivors if s.get("source") == "reddit"}
    to_rewrite = [s for s in survivors if s.get("source") != "reddit"]
    if raw:
        c.log(f"{len(raw)} reddit threads kept verbatim")

    if to_rewrite and not c.claude_bin():
        c.log("claude CLI not found - skipping rewrite (exit 0)")
        c.write_json(c.CARDS, [])
        return

    system = c.load_text("voice.md")

    rewritten: dict[str, dict] = {}
    lost_batches = 0
    for start in range(0, len(to_rewrite), BATCH):
        batch = to_rewrite[start:start + BATCH]
        try:
            results = c.claude_json(_prompt(batch), system, SCHEMA, model=c.REWRITE_MODEL)["results"]
        except (RuntimeError, json.JSONDecodeError, KeyError, TypeError) as exc:
            lost_batches += 1
            if lost_batches > 1:
                c.die(f"rewriter failing repeatedly ({lost_batches} batches lost): {exc}")
            c.log(f"  dropping batch at {start} ({len(batch)} items) after retries: {exc}")
            continue

        by_index = {r.get("index"): r for r in results if isinstance(r.get("index"), int)}
        for i, s in enumerate(batch):
            r = by_index.get(i)
            if not r or not r.get("title") or not r.get("blurb"):
                c.log(f"  no rewrite for item {start + i} ({s['id'][:8]}); dropping")
                continue
            rewritten[s["id"]] = _card(s, r["title"].strip(), r["blurb"].strip(), harvested)
        c.log(f"  rewrote {min(start + BATCH, len(to_rewrite))}/{len(to_rewrite)}")

    # survivor order, so the reddit passthroughs land where curate put them
    cards = [c_ for s in survivors
             if (c_ := raw.get(s["id"]) or rewritten.get(s["id"]))]

    c.write_json(c.CARDS, cards)
    c.log(f"produced {len(cards)} cards")


if __name__ == "__main__":
    main()
