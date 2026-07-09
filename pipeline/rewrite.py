"""Rewriter: turn each survivor's title + snippet into a hook `title` and a
2-3 sentence `blurb` in the user's voice (config/voice.md). Second AI stage.

Batches ~10 items per request through Claude Code in subscription mode (the
`claude` CLI, not the metered API), with the voice guide as the system prompt.
Each reply is a JSON {index, title, blurb} array. On failure we exit nonzero
without writing cards so the feed stays at its last good state.
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
        snippet = s["snippet"][:400]
        lines.append(
            f"[{i}] lane: {s['lane']}\noriginal title: {s['original_title']}"
            + (f"\nsnippet: {snippet}" if snippet else "")
        )
    return (
        "Rewrite each item into a hook title and a 2-3 sentence blurb in the "
        "voice from the style guide. Return one result per item, using the "
        "bracket number as `index`.\n\n" + "\n\n".join(lines)
    )


def main() -> None:
    survivors = c.read_json(c.SURVIVORS, default=[]) or []
    if not survivors:
        c.log("no survivors to rewrite; writing empty cards")
        c.write_json(c.CARDS, [])
        return

    if not c.claude_bin():
        c.log("claude CLI not found - skipping rewrite (exit 0)")
        c.write_json(c.CARDS, [])
        return

    system = c.load_text("voice.md")

    harvested = c.today()
    cards: list[dict] = []
    for start in range(0, len(survivors), BATCH):
        batch = survivors[start:start + BATCH]
        try:
            results = c.claude_json(_prompt(batch), system, SCHEMA)["results"]
        except (RuntimeError, json.JSONDecodeError, KeyError, TypeError) as exc:
            c.die(f"could not get/parse rewriter response: {exc}")

        by_index = {r.get("index"): r for r in results if isinstance(r.get("index"), int)}
        for i, s in enumerate(batch):
            r = by_index.get(i)
            if not r or not r.get("title") or not r.get("blurb"):
                c.log(f"  no rewrite for item {start + i} ({s['id'][:8]}); dropping")
                continue
            cards.append({
                "id": s["id"],
                "source": s["source"],
                "url": s["url"],
                "original_title": s["original_title"],
                "title": r["title"].strip(),
                "blurb": r["blurb"].strip(),
                "lane": s["lane"],
                "published": s.get("published", ""),
                "harvested": harvested,
                "score": s.get("score", 0),
                "preprint": bool(s.get("preprint", False)),
                "venue": s.get("venue", ""),
                "image": s.get("image", ""),
            })
        c.log(f"  rewrote {min(start + BATCH, len(survivors))}/{len(survivors)}")

    c.write_json(c.CARDS, cards)
    c.log(f"produced {len(cards)} cards")


if __name__ == "__main__":
    main()
