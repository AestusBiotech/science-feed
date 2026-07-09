"""Assembler: append new cards to the chunked feed, update the manifest and the
seen-IDs set, and validate the result. No AI, no network.

- New cards are de-duped against every id already in the feed.
- The newest chunk is filled to CARDS_PER_CHUNK, then a new chunk rolls over.
- seen_ids gains *every* candidate id processed this run (not just survivors),
  so discarded items are never re-fetched.
- Validation fails loudly: every chunk must parse, ids must be unique, and the
  manifest must match the files on disk.
"""
from __future__ import annotations

import common as c


def _chunk_name(n: int) -> str:
    return f"chunk-{n:04d}.json"


def _load_manifest() -> dict:
    m = c.read_json(c.MANIFEST, default=None)
    if not m:
        return {"chunks": [], "total": 0, "updated": None, "lanes": c.lanes()}
    return m


def _existing_ids(manifest: dict) -> set[str]:
    ids: set[str] = set()
    for name in manifest.get("chunks", []):
        for card in c.read_json(c.FEED_DIR / name, default=[]) or []:
            ids.add(card["id"])
    return ids


def _validate(manifest: dict) -> None:
    total = 0
    seen: set[str] = set()
    for name in manifest["chunks"]:
        path = c.FEED_DIR / name
        cards = c.read_json(path, default=None)
        if cards is None:
            c.die(f"manifest lists {name} but it does not parse / exist")
        for card in cards:
            if card["id"] in seen:
                c.die(f"duplicate card id {card['id']} in {name}")
            seen.add(card["id"])
        total += len(cards)
    if total != manifest["total"]:
        c.die(f"manifest total {manifest['total']} != {total} cards on disk")


def main() -> None:
    new_cards = c.read_json(c.CARDS, default=[]) or []
    candidates = c.read_json(c.CANDIDATES, default=[]) or []

    manifest = _load_manifest()
    have = _existing_ids(manifest)

    fresh = [card for card in new_cards if card["id"] not in have]
    added = 0

    if fresh:
        c.FEED_DIR.mkdir(parents=True, exist_ok=True)
        # Start from the newest chunk (or a fresh one), then roll at capacity.
        if manifest["chunks"]:
            cur_name = manifest["chunks"][-1]
            cur = c.read_json(c.FEED_DIR / cur_name, default=[]) or []
        else:
            cur_name = _chunk_name(1)
            manifest["chunks"].append(cur_name)
            cur = []

        for card in fresh:
            if len(cur) >= c.CARDS_PER_CHUNK:
                c.write_json(c.FEED_DIR / cur_name, cur)
                cur_name = _chunk_name(len(manifest["chunks"]) + 1)
                manifest["chunks"].append(cur_name)
                cur = []
            cur.append(card)
            added += 1
        c.write_json(c.FEED_DIR / cur_name, cur)

        manifest["total"] = manifest.get("total", 0) + added

    manifest["updated"] = c.now_iso()
    manifest["lanes"] = c.lanes()
    c.write_json(c.MANIFEST, manifest)

    # Record every processed candidate id (plus card ids) so we never re-fetch.
    seen = c.load_seen()
    seen.update(cand["id"] for cand in candidates)
    seen.update(card["id"] for card in new_cards)
    c.save_seen(seen)

    _validate(manifest)
    c.log(f"assembled: +{added} new cards, total {manifest['total']}, "
          f"{len(manifest['chunks'])} chunks, seen_ids {len(seen)}")


if __name__ == "__main__":
    main()
