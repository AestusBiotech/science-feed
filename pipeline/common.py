"""Shared helpers for the feed pipeline: paths, IO, hashing, dedupe, config.

Everything else in pipeline/ imports from here. No AI, no network.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

# ---------------------------------------------------------------------------
# Paths. ROOT is the repo root (the parent of this pipeline/ directory).
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
FEED_DIR = DATA_DIR / "feed"
MANIFEST = FEED_DIR / "manifest.json"
SEEN_IDS = DATA_DIR / "seen_ids.json"

# Scratch is where the pipeline stages hand off to each other. Not committed.
SCRATCH = ROOT / "scratch"
CANDIDATES = SCRATCH / "candidates.json"   # harvest.py -> curate.py
SURVIVORS = SCRATCH / "survivors.json"     # curate.py  -> rewrite.py
CARDS = SCRATCH / "cards.json"             # rewrite.py -> assemble.py

# ---------------------------------------------------------------------------
# Tunables (env-overridable). MAX_ITEMS_PER_RUN is the hard cost cap: no run
# scores/rewrites more than this many items, so no run can overspend.
# ---------------------------------------------------------------------------
MAX_ITEMS_PER_RUN = int(os.environ.get("MAX_ITEMS_PER_RUN", "60"))
CANDIDATE_POOL_CAP = int(os.environ.get("CANDIDATE_POOL_CAP", "400"))
CARDS_PER_CHUNK = 100
MODEL = "claude-haiku-4-5"  # locked by the plan. do not change.


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    """Fail the stage loudly. A skipped night is fine; a corrupt feed is not."""
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha1_id(url: str) -> str:
    return hashlib.sha1(url.strip().encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# JSON IO — atomic writes so an interrupted run can't leave half a file.
# ---------------------------------------------------------------------------
def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_sources() -> dict:
    with (CONFIG_DIR / "sources.yml").open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load_text(name: str) -> str:
    return (CONFIG_DIR / name).read_text(encoding="utf-8")


def lanes() -> list[str]:
    return load_sources().get("lanes", []) or []


# ---------------------------------------------------------------------------
# Seen-IDs dedupe set (source-item IDs already processed on prior runs)
# ---------------------------------------------------------------------------
def load_seen() -> set[str]:
    return set(read_json(SEEN_IDS, default=[]) or [])


def save_seen(ids: set[str]) -> None:
    write_json(SEEN_IDS, sorted(ids))


# ---------------------------------------------------------------------------
# Claude Code (subscription mode) — the AI stages call the `claude` CLI in
# print mode instead of the metered Anthropic API. Auth comes from the machine's
# logged-in Claude Code session (or a CLAUDE_CODE_OAUTH_TOKEN env var from
# `claude setup-token`); no ANTHROPIC_API_KEY is used. If that key is present it
# would flip the CLI back to API billing, so we scrub it from the child env.
#
# A missing CLI => the stage should exit 0 with a "skipped" notice so forks
# (and dry runs) don't fail the whole workflow.
# ---------------------------------------------------------------------------
def claude_bin() -> str | None:
    """Absolute path to the `claude` executable, or None if not installed.

    Uses shutil.which so it resolves the .cmd/.exe shim on Windows and the
    plain script on Linux/macOS runners alike.
    """
    return shutil.which("claude")


def _extract_json(text: str) -> Any:
    """Parse a JSON object out of the model's reply.

    The CLI has no server-side schema enforcement, so the model sometimes wraps
    its JSON in a ```json fence or adds a stray line. Strip fences first, then
    fall back to slicing between the outermost braces.
    """
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        i, j = t.find("{"), t.rfind("}")
        if i != -1 and j > i:
            return json.loads(t[i:j + 1])
        raise


def claude_json(prompt: str, system: str, schema: dict) -> Any:
    """One Haiku call via Claude Code (subscription auth); returns parsed JSON.

    `system` fully replaces Claude Code's default agent system prompt. Since the
    CLI can't enforce a response schema, we append the schema to the prompt and
    parse the reply ourselves. Raises on CLI failure or unparseable output —
    callers decide whether that's fatal (curate/rewrite) or skippable (ricky).

    Mechanics that matter: the system prompt goes in via --system-prompt-file and
    the user prompt via stdin, never as argv strings. A multi-kilobyte guide or
    batch passed as an argv element quietly breaks the CLI's flag parsing so
    --output-format json is dropped and you get raw prose back. We also run in a
    scratch cwd with tools off so the agent can't wander the repo.
    """
    exe = claude_bin()
    if not exe:
        die("claude CLI not found on PATH (subscription mode requires Claude Code)")

    full_prompt = (
        f"{prompt}\n\nReturn ONLY a JSON object conforming to this JSON Schema. "
        f"No prose, no explanation, no markdown code fences:\n{json.dumps(schema)}"
    )
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    SCRATCH.mkdir(parents=True, exist_ok=True)
    fd, sys_path = tempfile.mkstemp(dir=str(SCRATCH), suffix=".sys.md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(system)
        cmd = [
            exe, "-p",
            "--model", MODEL,
            "--system-prompt-file", sys_path,
            "--output-format", "json",
            "--allowed-tools", "",       # pure text task; forbid tool use
        ]
        proc = subprocess.run(
            cmd, input=full_prompt, capture_output=True, text=True,
            encoding="utf-8", env=env, cwd=str(SCRATCH),
        )
    finally:
        if os.path.exists(sys_path):
            os.remove(sys_path)

    if proc.returncode != 0:
        raise RuntimeError(
            f"claude CLI exited {proc.returncode}: {(proc.stderr or '')[:400]}"
        )
    try:
        outer = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"claude CLI gave non-JSON output: {exc}\n{proc.stdout[:400]}")
    if outer.get("is_error") or outer.get("subtype") != "success":
        raise RuntimeError(f"claude CLI reported error: {str(outer.get('result'))[:400]}")
    return _extract_json(outer.get("result", ""))
