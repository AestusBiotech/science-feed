# Personal Curated Feed — Build Plan

**For the implementing agent:** This is a complete, self-contained build spec. The user has already made the key decisions — do not re-litigate them. Build fresh; do **not** reuse or read code from any existing feed app the user may have (they explicitly want a clean take).

---

## 1. What we're building

A single-user, no-social "Reddit-like" feed app: an endless scroll of curated cards, each linking out to an article, Reddit thread, paper, or blog post. Every card's title and blurb is **rewritten by an LLM in the user's personal hook voice** so it catches *their* interest specifically. Content doesn't have to be new — items from past years are fine, and resurfacing old items is a feature, not a bug.

**Core principle:** decouple the three cost centers so each is free or near-free:

| Stage | What | Cost |
|---|---|---|
| Harvest | Pull candidates from free APIs (no AI) | $0 |
| Curate + rewrite | Score & rewrite with Claude Haiku | ~$1–3/month |
| Serve | Static PWA on GitHub Pages | $0 |

The user's PC stays off. Everything runs on GitHub Actions cron + GitHub Pages.

## 2. Locked decisions (do not revisit)

- **LLM:** Anthropic API, model **`claude-haiku-4-5`** exactly ($1/M input, $5/M output). No other model, no fallbacks to bigger models.
- **Repo:** public GitHub repo. The user accepts that the feed and interest profile are technically visible. GitHub Pages for hosting, GitHub Actions for the nightly pipeline, the repo itself as the database.
- **No feedback loop in v1.** No thumbs up/down, no backend, no telemetry. (Listed as a v2 idea at the end — do not build it now.)
- **Repeats are OK.** The client resurfaces archive items; the pipeline may occasionally re-cover a topic.

## 3. Architecture

```
GitHub Actions (nightly cron, ~03:00 UTC)
 ├─ harvest.py      → pull candidates from Reddit/HN/arXiv/PubMed/RSS (no AI)
 ├─ curate.py       → Haiku scores candidates against interests.md, keeps top N
 ├─ rewrite.py      → Haiku rewrites survivors into voice.md style (structured output)
 ├─ assemble.py     → append to chunked feed JSON, update manifest + seen-IDs
 └─ git commit+push → GitHub Pages auto-redeploys

GitHub Pages (static)
 └─ PWA: index.html + app.js + sw.js + manifest.json + data/feed/*.json

Phone
 └─ installed PWA, endless scroll, IndexedDB tracks what's been shown
```

## 4. Repository layout

```
/config/
  interests.md        # topics/lanes, what's interesting, what's boring (user-authored)
  voice.md            # hook-voice style guide + 6-10 example cards (user-authored)
  sources.yml         # subreddits, RSS URLs, arXiv categories, PubMed queries, HN queries
/pipeline/
  harvest.py
  curate.py
  rewrite.py
  assemble.py
  common.py           # shared helpers: dedupe, IO, hashing
  requirements.txt    # requests, anthropic, pyyaml, feedparser
/data/
  feed/
    manifest.json     # { "chunks": ["chunk-0007.json", ...], "total": N, "updated": ISO }
    chunk-0001.json   # 100 cards per chunk, append-only, newest chunk last
  seen_ids.json       # source-item IDs already processed (dedupe across runs)
/site/                # everything GitHub Pages serves (or serve repo root — agent's choice)
  index.html
  app.js
  style.css
  sw.js
  manifest.json
  icons/
/.github/workflows/
  nightly.yml         # cron pipeline
  backfill.yml        # manual workflow_dispatch, capped per run
new_plan.md           # this file
README.md
```

## 5. Data model — the card

Every feed item is one JSON object:

```json
{
  "id": "sha1 of source URL",
  "source": "reddit | hn | arxiv | pubmed | rss | web",
  "url": "https://... (the outbound link)",
  "original_title": "as published",
  "title": "rewritten hook title",
  "blurb": "2-3 sentence rewritten summary in the user's voice",
  "lane": "one of the user's topic lanes from interests.md",
  "published": "2024-11-02",
  "harvested": "2026-07-08",
  "score": 87
}
```

Keep cards ~400–600 bytes. 5,000 cards ≈ 2–3 MB total, chunked — static hosting handles this trivially.

## 6. Build phases

### Phase 0 — Interview the user (blocking, do this first)

Before writing pipeline code, get from the user:

1. **Topic lanes** — 4–8 named lanes (e.g. "radiopharma & isotopes", "weird biology", ...). Also anti-topics: what should *never* appear.
2. **Voice** — ask for 5–10 example headlines/blurbs they love (or write 10 candidates in different registers and have them pick/edit). The user has a dry, skeptical taste — but confirm with examples rather than assuming.
3. **Sources per lane** — specific subreddits, journals, blogs, arXiv/PubMed categories. Propose defaults per lane; let them edit.

Write the answers into `config/interests.md`, `config/voice.md`, `config/sources.yml`. These three files are the entire personalization surface — the pipeline must read them at runtime, never hardcode topics or style.

### Phase 1 — Harvester (`harvest.py`, no AI)

Pull raw candidates from free structured APIs. Output: `scratch/candidates.json` (not committed).

- **Reddit:** public JSON endpoints — `https://www.reddit.com/r/{sub}/top.json?t=week&limit=50` for nightly, `t=year`/`t=all` for backfill. Set a descriptive `User-Agent` header (Reddit blocks default agents). If Actions runner IPs get 403/429, fall back to a free Reddit "script" OAuth app (client id/secret as repo secrets) — build the plain path first, add OAuth only if needed.
- **Hacker News:** Algolia API — `https://hn.algolia.com/api/v1/search?query={q}&tags=story&numericFilters=points>100`. Excellent for historical backfill via date filters.
- **arXiv:** `http://export.arxiv.org/api/query?search_query=cat:{cat}&sortBy=submittedDate` (Atom XML; use `feedparser`).
- **PubMed:** E-utilities `esearch` + `esummary`, JSON mode, with the queries from `sources.yml`. Respect the 3 req/sec unauthenticated limit.
- **RSS:** `feedparser` over the list in `sources.yml`.

Rules: skip anything whose `id` is already in `data/seen_ids.json`; normalize each candidate to `{source, url, title, snippet, published, suggested_lane}`; cap the candidate pool per run (e.g. 300) so the curation step has a bounded input.

### Phase 2 — Curator (`curate.py`, first Haiku call)

One API call scores candidates in bulk (don't call per-item):

- Build batches of ~30 candidates (title + snippet only) per request.
- System prompt: contents of `interests.md` + instruction to score 0–100 for "how much would this specific person want to read this" and assign a lane.
- Use **structured outputs** (`output_config: {format: {type: "json_schema", ...}}` — supported on `claude-haiku-4-5`) so the response is a guaranteed-parseable array of `{index, score, lane}`.
- Keep the top N (nightly: ~40; backfill: per-run cap from workflow input). Discard the rest but still record their IDs in `seen_ids.json` so they're never re-fetched.

### Phase 3 — Rewriter (`rewrite.py`, second Haiku call)

- Batch ~10 items per request. System prompt: contents of `voice.md` (style guide + examples), with `cache_control: {type: "ephemeral"}` on the system block so repeated requests within the run hit the prompt cache.
- For each item, produce `title` (rewritten hook) and `blurb` (2–3 sentences) via structured output.
- `max_tokens`: ~2000 per 10-item batch is plenty. No `thinking` parameter — plain fast completion.
- Use the Python SDK (`anthropic` package), reading `ANTHROPIC_API_KEY` from the environment. SDK retries 429/5xx automatically; on persistent failure, **exit nonzero without committing** — a skipped night is fine, a corrupted feed is not.

**Cost check (build this into the README):** nightly ≈ 40 rewrites + scoring ≈ 60K input + 12K output tokens ≈ **$0.12/night, ~$3.50/month worst case**; realistically less. One-time backfill of 3,000 cards ≈ $3–5. If the user ever wants it cheaper, the Message Batches API (50% off, async, fine for a cron job) is the lever — note it, don't build it in v1.

### Phase 4 — Assembler (`assemble.py`)

- Append new cards to the newest chunk; roll a new `chunk-NNNN.json` at 100 cards.
- Update `manifest.json` (chunk list, total count, updated timestamp).
- Update `seen_ids.json`.
- Validate: every chunk parses, no duplicate `id`s, manifest matches files on disk. Fail loudly if not.

### Phase 5 — Frontend PWA

Vanilla HTML/CSS/JS — no framework, no build step (nothing to break in CI).

- **Feed rendering:** fetch `manifest.json`, lazy-load chunks as the user scrolls (IntersectionObserver sentinel). Card = lane tag, rewritten title, blurb, source + age ("reddit · 2y"), whole card is the outbound link (open in new tab).
- **Endless scroll logic:** interleave **fresh** (never-shown, newest-first) with **vault** (previously shown or old archive items, random-weighted) at roughly 3:1. Vault cards get a small "from the vault" tag. Track shown-card IDs + timestamps in **IndexedDB**; a vault card is eligible for resurfacing after ~14 days. With a few thousand cards this makes the scroll effectively infinite.
- **PWA:** `manifest.json` (name, icons, `display: standalone`), service worker caching the app shell + last-fetched chunks (network-first for `manifest.json`, cache-first for chunks). Must be installable on Android/iOS and readable offline with the last-synced feed.
- **Design:** dark, dense, thumb-friendly. Fast. No hero images required (cards are text-first); if a source provides a thumbnail URL, show it small — never hotlink-break the layout when it 404s.

### Phase 6 — GitHub Actions

**`nightly.yml`** — `schedule: cron "0 3 * * *"` plus `workflow_dispatch`:
1. checkout → setup Python 3.12 → `pip install -r pipeline/requirements.txt`
2. run harvest → curate → rewrite → assemble (env: `ANTHROPIC_API_KEY` from repo secret)
3. `git commit -am "feed: nightly update" && git push` (skip commit if no new cards)
4. concurrency group so overlapping runs can't double-commit.

**`backfill.yml`** — `workflow_dispatch` with inputs `items_per_lane` (default 100) and `time_window` (`year`/`all`). Same pipeline with backfill-mode harvest (top-of-year/all-time endpoints). The user runs this a few times in week one to build the ~2,000–4,000 card archive, then never again.

**Secrets:** `ANTHROPIC_API_KEY` only, as an Actions repo secret. **The key must never appear in client-side code, committed files, or logs** — the repo is public. Add a guard: if the key is missing, pipeline exits 0 with a "skipped" notice (so forks don't fail).

**Pages:** deploy from branch (`main`, `/site` folder or root — match the layout chosen). No custom build.

### Phase 7 — Verify

- Run the pipeline locally once with a small cap (5 items) against the real API; confirm cards land in a chunk and render.
- Trigger `nightly.yml` manually on GitHub; confirm green run, commit appears, Pages redeploys.
- Lighthouse PWA check: installable, offline-capable.
- Phone test: install, scroll 100+ cards, links open, vault items appear tagged.
- Show the user 10 sample rewritten cards **before** running full backfill — voice sign-off is the gate for spending backfill money.

## 7. Failure & cost guardrails

- Hard cap `MAX_ITEMS_PER_RUN` (env, default 60) enforced in `curate.py` — no run can spend more than ~$0.25 even if a source misbehaves.
- Any pipeline stage failing → nonzero exit → no commit → feed stays at last good state.
- Reddit/HN/PubMed fetch failures degrade gracefully: harvest whatever sources respond; only fail the run if *zero* candidates were gathered.
- Never retry the whole pipeline in a loop; next night catches up.

## 8. Explicitly out of scope for v1 (v2 ideas, do not build)

- Thumbs up/down feedback loop (would need a write path off the phone)
- Full-article summarization or fetching article bodies (rewrite from title + snippet only)
- Multiple users, auth, comments — never
- Message Batches API cost optimization

## 9. Definition of done

1. User opens the PWA on their phone with their PC off.
2. Feed scrolls indefinitely: fresh nightly cards + tagged vault resurfacing.
3. Every card is in the user's voice, in one of their lanes, and links out correctly.
4. Nightly Action has run green ≥2 consecutive nights with new cards each time.
5. Total spend visible in Anthropic console ≈ single-digit dollars including backfill.
