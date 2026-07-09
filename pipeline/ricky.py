"""Ricky: the easter-egg endorsement. Runs between rewrite and assemble.

Two stages, exactly as specified:
  1. Nomination (free) — reuse the curation scores. The single highest-scoring
     card added this run, that has never been Ricky'd before, is the nominee.
     Novelty is inherent: the harvester only surfaces items not already in
     seen_ids, so this run's cards are new to the reader by construction.
  2. Veto (one Haiku call) — ask claude-haiku-4-5 one brutal yes/no question,
     with interests.md as the system prompt and "default to no". Only a `true`
     endorses. Most nights this is `false`, and that is correct.

If a pick is endorsed, one extra Haiku call writes the longer `blurb_long` used
in the "Ricky's choice" section, and:
  - the card in cards.json gains `ricky: {endorsed_at}` (so assemble writes the
    amber tag into the chunk, and it shows in the regular feed too), and
  - the enriched card (with blurb_long) is prepended to data/feed/ricky.json,
    the permanent index the client's section and pop-up read.

Guardrails (per ricky-addition.md §5): this stage must never break the
pipeline. A missing claude CLI, a nominee that can't be found, or any
veto/expand call failure => skip Ricky for the night and exit 0. The core
stages own the nonzero-exit rules, not this one.
"""
from __future__ import annotations

import json

import common as c

RICKY_INDEX = c.FEED_DIR / "ricky.json"

VETO_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "ricky": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["ricky", "reason"],
}

EXPAND_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"blurb_long": {"type": "string"}},
    "required": ["blurb_long"],
}

VETO_INSTRUCTION = (
    "Below is one article (title + snippet). Would this specific person stop "
    "mid-scroll and read it immediately? This endorsement is rare and must stay "
    "meaningful — default to no. Only answer yes if this is genuinely "
    "exceptional for them, not merely relevant."
)

EXPAND_INSTRUCTION = (
    "Below is one article and the short blurb already written for it in the "
    "reader's voice. Write blurb_long: keep that take, then add 2-4 more "
    "sentences of real substance in the exact same dry, skeptical voice — the "
    "genuinely interesting part, the caveat worth their skepticism, and why it "
    "matters. No hype, no filler, no restating the title. 5-7 sentences total."
)


def _load_index() -> list[dict]:
    return c.read_json(RICKY_INDEX, default=[]) or []


def _snippets_by_id() -> dict[str, str]:
    survivors = c.read_json(c.SURVIVORS, default=[]) or []
    return {s["id"]: (s.get("snippet") or "") for s in survivors}


def _nominate(cards: list[dict], endorsed_ids: set[str]) -> dict | None:
    pool = [card for card in cards if card["id"] not in endorsed_ids]
    if not pool:
        return None
    # top scorer of the run; tiebreak on newest publication date.
    pool.sort(key=lambda x: (x.get("score", 0), x.get("published", "")), reverse=True)
    return pool[0]


def _veto(nominee: dict, snippet: str) -> tuple[bool, str]:
    body = f"title: {nominee['original_title']}"
    if snippet:
        body += f"\nsnippet: {snippet[:600]}"
    data = c.claude_json(
        f"{VETO_INSTRUCTION}\n\n{body}", c.load_text("interests.md"), VETO_SCHEMA,
    )
    return bool(data.get("ricky")), (data.get("reason") or "").strip()


def _expand(nominee: dict, snippet: str) -> str:
    body = (
        f"lane: {nominee['lane']}\n"
        f"title: {nominee['original_title']}\n"
        f"short blurb: {nominee['blurb']}"
    )
    if snippet:
        body += f"\nsnippet: {snippet[:600]}"
    data = c.claude_json(
        f"{EXPAND_INSTRUCTION}\n\n{body}", c.load_text("voice.md"), EXPAND_SCHEMA,
    )
    return (data.get("blurb_long") or "").strip()


def main() -> None:
    index = _load_index()
    # ensure the file exists so the client never 404s on first deploy.
    if not RICKY_INDEX.exists():
        c.write_json(RICKY_INDEX, index)

    cards = c.read_json(c.CARDS, default=[]) or []
    if not cards:
        c.log("ricky: no new cards this run; nothing to endorse")
        return

    if not c.claude_bin():
        c.log("ricky: claude CLI not found - skipping (exit 0)")
        return

    endorsed_ids = {card["id"] for card in index}
    nominee = _nominate(cards, endorsed_ids)
    if not nominee:
        c.log("ricky: no eligible nominee (all top cards already endorsed)")
        return

    snippet = _snippets_by_id().get(nominee["id"], "")

    try:
        keep, reason = _veto(nominee, snippet)
    except Exception as exc:                       # never break the pipeline
        c.log(f"ricky: veto call failed, skipping tonight ({exc})")
        return

    c.log(f"ricky: nominee {nominee['id'][:8]} score {nominee.get('score')} "
          f"-> ricky={keep} :: {reason}")
    if not keep:
        return

    try:
        blurb_long = _expand(nominee, snippet)
    except Exception as exc:
        c.log(f"ricky: expand call failed, skipping endorsement ({exc})")
        return
    if not blurb_long:
        c.log("ricky: empty expanded blurb; skipping endorsement")
        return

    endorsed_at = c.now_iso()

    # 1) tag the card in cards.json so assemble writes it into the chunk and it
    #    carries the amber tag in the regular feed.
    for card in cards:
        if card["id"] == nominee["id"]:
            card["ricky"] = {"endorsed_at": endorsed_at}
            break
    c.write_json(c.CARDS, cards)

    # 2) prepend the enriched pick (with the long blurb) to the section index.
    entry = dict(nominee)
    entry["ricky"] = {"endorsed_at": endorsed_at}
    entry["blurb_long"] = blurb_long
    index.insert(0, entry)
    c.write_json(RICKY_INDEX, index)

    c.log(f"ricky: ENDORSED {nominee['id'][:8]} \"{nominee['title'][:60]}\"")


if __name__ == "__main__":
    main()
