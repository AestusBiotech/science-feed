# feed

A single-user, no-social curated feed. An endless scroll of cards that each link
out to a paper, thread, or article, with the title and blurb **rewritten in your
own voice** so they catch *your* interest. Content doesn't have to be new —
resurfacing old items is a feature.

Live: https://aestusbiotech.github.io/science-feed/

## How it works

Three cost centers, decoupled so each is free or nearly free:

```
GitHub Actions (nightly cron ~03:00 UTC)
 ├─ harvest.py   pull candidates from Reddit / HN / arXiv / PubMed / RSS   (no AI, $0)
 ├─ curate.py    Haiku scores them against config/interests.md, keeps everything above a score bar
 ├─ rewrite.py   Haiku rewrites survivors into config/voice.md style
 ├─ assemble.py  append to chunked feed JSON, update manifest + seen-IDs
 └─ git push     GitHub Pages redeploys

GitHub Pages (static)
 └─ index.html + app.js + styles.css + sw.js + data/feed/*.json

Phone / desktop
 └─ installable PWA, endless scroll, IndexedDB tracks what you've seen
```

Your PC stays off. Everything runs on Actions + Pages.

## The only things you edit

All personalization lives in three files — the pipeline reads them at runtime and
never hardcodes topics or style:

| File | What it controls |
|---|---|
| `config/interests.md` | who you are + the scoring rubric (what's interesting, what's boring) |
| `config/voice.md` | the hook-voice style guide + example rewrites |
| `config/sources.yml` | subreddits, RSS URLs, arXiv/PubMed queries, HN queries, and the lane list |

Change a lane, add a source, tighten the voice — edit these and push.

## The card

```json
{
  "id": "sha1 of the url",
  "source": "reddit | hn | arxiv | pubmed | rss | web",
  "url": "https://... (the outbound link)",
  "original_title": "as published",
  "title": "rewritten hook",
  "blurb": "2-3 sentence rewrite in your voice",
  "lane": "one of your lanes",
  "published": "2024-11-02",
  "harvested": "2026-07-08",
  "score": 87
}
```

Cards are ~400-600 bytes. A few thousand is 2-3 MB, chunked (100 per chunk).

## Run it locally

```
node serve.js          # http://localhost:5173  (or double-click "Open Feed.bat")
```

The AI stages run through **Claude Code in subscription mode** — they shell out
to the `claude` CLI, which authenticates with your logged-in Claude subscription
(Pro/Max), not a metered API key. Install Claude Code and log in once:

```
npm install -g @anthropic-ai/claude-code
claude                                   # /login once, interactively
```

Then run the pipeline against the real feed with a tiny cap to see it end-to-end:

```
pip install -r pipeline/requirements.txt
MAX_ITEMS_PER_RUN=5 python pipeline/harvest.py --mode nightly
MAX_ITEMS_PER_RUN=5 python pipeline/curate.py --keep-score 58
python pipeline/rewrite.py
python pipeline/assemble.py
```

If the `claude` CLI isn't installed, the AI stages skip cleanly (exit 0) so
nothing breaks — you just get no new cards.

## Cost

- **Model:** `claude-haiku-4-5` only. No fallbacks, no bigger model.
- **Billing:** subscription mode — calls draw on your Claude Pro/Max plan usage
  rather than pay-as-you-go API dollars. There's no per-run dollar meter; the
  ceiling is your plan's rate limits.
- **Keep-cut:** score-based, not a count — `curate.py --keep-score` keeps every
  paper/news item at or above the bar (default 58), so a good source is never
  dropped just because others outranked it.
- **Backstop:** `MAX_ITEMS_PER_RUN` (default 250) in `curate.py` only trims the
  lowest-scoring overflow if a night is pathologically large — it's a runaway
  guard, not the cap, so normal runs are never touched by it.

## Backfill (build the vault, week one)

Run the **backfill archive** workflow manually a few times (Actions tab →
"backfill archive" → Run workflow). Inputs: `time_window` (year / all) and
`max_items` (cost cap per run). Do this a handful of times to build a
~2,000-4,000 card archive, then never again.

## Guardrails

- Any stage failing exits nonzero → no commit → the feed stays at its last good state.
- Fetch failures degrade gracefully: harvest whatever responds; only fail if *zero* candidates come back.
- `assemble.py` validates every chunk parses, ids are unique, and the manifest matches disk.
- The Claude Code OAuth token lives only as an Actions secret — never in client code or committed files.

## Activation (two one-time steps)

The pipeline is built but won't run until:

1. **Push the workflow files.** They live in `.github/workflows/` locally but the
   local `gh` token lacks the `workflow` OAuth scope, so `git push` of them is
   rejected. Run `gh auth refresh -s workflow` then push, or add them via the
   GitHub web UI.
2. **Add the `CLAUDE_CODE_OAUTH_TOKEN` repo secret** (Settings → Secrets and
   variables → Actions → New repository secret). Generate the token by running
   `claude setup-token` locally while logged into your Claude subscription.

Until both are done, the site serves the seed feed; the pipeline doesn't run.
