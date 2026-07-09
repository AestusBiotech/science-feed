# Ricky — Easter Egg Addition to the Curated Feed

**For the implementing agent:** This extends [new_plan.md](new_plan.md). Read that first — this feature reuses the scoring pass from Phase 2, the card data model from §5, and the client from Phase 5. Build this after the core v1 is done and verified. Decisions below are made; don't re-litigate.

---

## 0. Build revisions (final — these supersede any conflict below)

Design was confirmed against a mockup. Where this section conflicts with the
original text, this section wins.

- **Ricky's choice is a permanent section, not a scroll-to.** It's a lane/chip
  like "saved" (amber). Every endorsed pick lives there forever, newest-first,
  with the longer `blurb_long` write-up. Endorsed picks also appear in the
  normal feed carrying the amber border + "Ricky endorsed this" tag (short
  blurb there). Source of truth: `data/feed/ricky.json` (full cards, newest
  first). There is **no `ricky_card_id` in the manifest** and **no `expires`
  field** — §3's expiry / "no visible trace" is dropped: the tag and section
  are permanent and purely cosmetic.
- **The pop-up is decoupled from the tag.** It's just a "a new pick landed"
  notification. It fires **once per pick this device hasn't seen** (tracked in
  an IndexedDB `ricky` store), one after another, and only while a pick is
  still fresh (≤7 days from `endorsed_at`) — so old news never re-summons him.
  This is the "don't spam me on old news" guarantee, in the trigger, not the
  badge.
- **Pop-up copy (verbatim):** Ricky says "I bring important information. Read
  it. Maybe one day you'll be as smart as me." Ricky floats (transparent
  `icons/ricky.png`, bottom-right); the bubble has a thin amber border and sits
  centered above him.
- **Two buttons.** "Read it" opens the Ricky's choice section and highlights
  that pick. "Fuck off Ricky" (and a tap on the backdrop) fades him out
  quietly. Either marks the pick seen so it never re-pops.
- **Expanded text = one extra Haiku call** per endorsed pick, stored as
  `blurb_long` in `ricky.json` (shown only in the section).
- **Data model on the card:** `ricky: { "endorsed_at": ISO }` only.
- **Pipeline:** new stage `pipeline/ricky.py` runs between `rewrite` and
  `assemble`, **nightly only** (not backfill). Nomination + veto per §2; then
  the expand call; writes the tag into `cards.json` and prepends the enriched
  pick to `ricky.json`.
- Unrelated: app background changed to `#0c0f0a`.

---

## 1. What it is

An easter egg: occasionally a custom character image ("Ricky") pops up in the app saying **"Ricky says this is very good! read now!"**. Tapping the image jumps the feed to one specific card — a newly discovered, exceptionally high-relevance article. Dismissing or tapping him marks that appearance done.

Ricky is a **quality signal, not a scheduled feature**. He appears only when something genuinely great enters the feed. Some weeks he shows up twice; some weeks not at all. Never fake it.

## 2. Selection logic (pipeline, nightly)

Two-stage: score nominates, a stricter check decides.

### Stage 1 — Nomination (free, reuses Phase 2 scoring)

After the normal curation scoring, a card is a **Ricky nominee** if all hold:

1. **Never discovered before** — this is the hard novelty rule. The item's ID was not in `seen_ids.json` before this run (first time the pipeline has ever encountered it). Publication date is loose: anything published within roughly the **last 7–10 days** qualifies. An article from last week that the harvester only just found is perfectly fine — it's new *to the user*, which is what matters.
2. **Top scorer of the run** — take only the single highest-scoring card of the night (tiebreak: newest publication date).
3. **Never previously Ricky'd** — a card gets at most one Ricky endorsement, ever (persist the flag in the archive; vault resurfacing must not re-trigger).
4. At most **one Ricky per day** (implied by taking one nominee per nightly run).

If no card meets these, no nominee, no Ricky, done.

### Stage 2 — The veto (one extra Haiku call, ~fraction of a cent)

Don't trust a raw numeric threshold — LLM scores drift and cluster. Instead, ask `claude-haiku-4-5` one dedicated yes/no question about the nominee only, with a deliberately brutal prompt:

> System: contents of `interests.md`. Instruction: "Below is one article (title + snippet). Would this specific person stop mid-scroll and read it immediately? This endorsement is rare and must stay meaningful — **default to no**. Only answer yes if this is genuinely exceptional for them, not merely relevant."

Structured output: `{ "ricky": true|false, "reason": "one sentence" }`. Log the reason in the Action output for tuning; don't ship it to the client.

- `false` → no Ricky tonight. This should be the common outcome. Correct behavior is that most nights nothing qualifies.
- `true` → the card gets the endorsement.

**No frequency floor, no quota.** If the veto passes three days running because the sources had a great week, Ricky appears three days running. If nothing passes for two weeks, he's gone for two weeks. The prompt's "default to no" is the only rarity mechanism — if he ever starts appearing near-daily for weeks, tighten the prompt wording, not with a numeric cooldown.

## 3. Data model changes

On the endorsed card (see new_plan.md §5):

```json
"ricky": {
  "endorsed_at": "2026-07-08T03:12:00Z",
  "expires": "2026-07-11T03:12:00Z"
}
```

In `data/feed/manifest.json`:

```json
"ricky_card_id": "abc123...",   // or null when none is active/unexpired
```

**Expiry is anchored to discovery, not publication.** The endorsement stays active ~72 hours from `endorsed_at` — "read now!" has to mean *now*, and the card was new to the user at endorsement time regardless of when the article was published. After expiry: `ricky_card_id` goes back to null on the next nightly run; the card remains in the feed as a normal high-scorer with no visible trace of the endorsement.

## 4. Client behavior (Phase 5 addition)

- On app open, check `manifest.json`: if `ricky_card_id` is set, the endorsement is unexpired, and IndexedDB shows this card's Ricky as not yet acted on → arm the easter egg.
- **Appearance:** don't fire instantly on open. Let the user scroll a little first (e.g. after N cards or a few seconds), then the Ricky image animates in — fixed position, over the feed, with the speech bubble "Ricky says this is very good! read now!". It should feel like an interruption, not a banner.
- **Tap the image** → scroll/deep-link the feed to the endorsed card (load its chunk if needed), brief highlight animation on the card. The card behaves normally from there (outbound link).
- **Dismiss** (small ✕ or tap-away) → he leaves quietly.
- Either action writes `{card_id, acted_at}` to IndexedDB → this Ricky never re-appears, even before expiry. One appearance per endorsement per device.
- The image is a static asset in the repo (e.g. `site/icons/ricky.png`, transparent background, supplied by the user — ask them for it; don't generate a placeholder mascot without showing them).

## 5. Guardrails

- Ricky logic must never block the pipeline: if the veto call fails (API error), skip Ricky for the night and continue the normal run. Nonzero-exit rules from new_plan.md §7 apply only to the core stages.
- The veto call respects the same `MAX_ITEMS_PER_RUN` cost envelope — it's one nominee, one call, hard-capped at one per run.
- No Ricky state on the client may break the feed: if `ricky_card_id` points at a card the client can't find (chunk mismatch, stale manifest), silently disarm.

## 6. Definition of done

1. A night where a card passes both stages produces a manifest with `ricky_card_id` set and a card carrying the `ricky` block.
2. On the phone: Ricky appears after brief scrolling, tap jumps to the highlighted card, dismiss/tap prevents re-appearance; nothing re-fires on reload.
3. A night with no qualifying card produces `ricky_card_id: null` and no client-side trace.
4. Expiry works: 72h after endorsement, he's gone without manual intervention.
5. Observed frequency over the first month is "occasionally, when warranted" — not daily. If it's daily, tune the veto prompt.
