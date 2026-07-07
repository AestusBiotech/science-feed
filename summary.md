# Science feed app — brainstorm handoff

A working summary of everything decided so far, for the next agent to pick up.

## The concept

A personal "Reddit for science" — a private, single-user PWA that replaces the user's
doomscroll habit (Reddit / Instagram / TikTok) with an infinite-scroll feed of science
content, in the same card format their thumb already knows. Feed of one: no accounts, no
moderation, no scaling, no cold-start problem.

## The user

- Works in radiopharmaceuticals at NorthStar Medical Radioisotopes (hands-on lab work,
  e.g. Ac-225 release testing). This is why radiopharma is a core lane, not an afterthought.
- Voice is dry, deadpan, skeptical. Lowercase sentence starts in his chat samples are just
  laziness — use normal capitalization.

## Lanes (content categories)

org chem · biochem · radiopharma (his field, weight up) · biotech news · startups
· plus a protected **wildcard** slot for serendipity.

## Card format (decided)

Each feed card has:
- source badge (colored per lane) + provenance line (source · type · age)
- title (the real paper/article title)
- a one-line **hook** — the LLM-generated "why you'd care" line (see voice below)
- an image when one exists: molecule structure generated from SMILES for chem;
  graphical-abstract thumbnail for preprints; article image for news; clean text-only
  fallback otherwise (never a broken image)
- action row: save · explain · link-out

Lane→color mapping used in mockups: org chem = teal, biochem = purple, radiopharma = coral,
startups = amber, wildcard = pink.

## The hook voice (THE core asset)

Hooks must sound like the user, not like AI. ~2-3 short sentences. Profile:
- Normal capitalization; sentences strung with "and" / "but"
- The closing beat is an honest, usually skeptical read — never oversells.
  e.g. "whether you actually need four flavors is another question," "still a maybe,"
  "lab tool more than anything, but a good one,"
  "either they know something the rest of us don't, or they've got cash to burn"
- Deadpan understatement over jokes; humor occasional and dry, never setup-punchline
- Swearing only when earned, not as seasoning

**Banned (he calls these "reddit nerdy humor" and "AI tell-tale signs"):**
cutesy similes/metaphors ("like Lego bricks," "dusting for fingerprints,"
"crime scene an hour late"), "plot twist," wordplay, em dashes, rule-of-three lists,
negative parallelism ("isn't just X, it's Y"), hype words, filler reassurance copy
(he rejected "All of this stays on your device. Nobody's feed but yours" as lame).

Example hooks that landed (real items pulled from bioRxiv / web during the session):
- Halogenation of premarineosin A (org chem): "Someone found a way to stick a bromine,
  chlorine, fluorine or iodine onto the same spot of this antimalarial, and it keeps killing
  the parasite no matter which one. Doing that cleanly is normally a headache. Whether you
  actually need four flavors of it is another question, but the method's nice."
- Beeline $126M (startups): "Boston biotech pulled another $126m on top of the $300m they
  already had. BMS and Bain put more in before any real data is public, which barely happens
  right now. Either they know something the rest of us don't, or they've got cash to burn."

## Card behaviors (decided)

**explain** — tap expands the card in place (no page load). Runs off the abstract (always
free, sidesteps paywalls) and breaks it into three beats in his voice:
the gist / why it's interesting / the catch (the skeptical limitation — this is what keeps
it from reading like a press release). Bottom of the expand: a "go deeper in chat" button
that hands the paper to a chat for follow-up questions.

**save** — does two jobs from one tap:
1. bookmarks to a read-later list
2. is the main ranking signal
Long-press / `···` opens finer controls: more like this / less like this / mute source.
Each card carries a "shown because…" line so ranking is never a black box.

**Saved / read-later view** — dense bordered-row list (not cards). Unread (filled dot) sorts
to top; read rows dim but stay. Per-lane filters + an "Unread · N" filter so it doubles as a
reading queue. Swipe to remove, tap bookmark to unsave.

## Personalization / ranking (decided)

Keep it LOOSE and broad — he explicitly does not want it narrowing toward irrelevance.
No ML needed for a feed of one; simple scoring works:
- score = freshness + source weight + topic-match weight
- save adds points to the item's topic keywords + source; "less like this" subtracts;
  "mute" zeroes a source
- next refresh re-sorts by score

Implement as a **floor, not a funnel**: every lane keeps a guaranteed minimum share of the
feed, saving only reorders within that, ~15% is hard-reserved for wildcard/exploration that
personalization can't suppress, and only an explicit mute removes a source. Make the weights
visible ("your feed is learning" chips + "shown because…") — legibility is a feature the big
apps can't copy.

## Sources (free APIs / feeds available)

- PubMed / Europe PMC — biochem papers (free API, keyword/journal filters)
- bioRxiv / chemRxiv — preprints, the "new & cool" lane (free API/RSS)
- RSS — C&EN, Nature news, Derek Lowe's "In the Pipeline", ACS/RSC journals, Endpoints,
  STAT, Fierce Biotech
- Reddit — r/chemistry, r/biotech, r/labrats, r/organicchemistry (official JSON API)
- Hacker News — startup/biotech news (Algolia API)
- Startup funding — biotech funding-round feeds
- ChEMBL — molecule/compound data (for generating structure images from SMILES)
- ClinicalTrials.gov — trial data
Note: abstracts are almost always free; full text often paywalled — lean on preprints for
the "new & exciting" feel.

## Platform decision

Phone web app / PWA (installable to home screen, no app store). Content must be pre-fetched
and cached so it loads instantly — any spinner and the thumb goes to Instagram.

## Build roadmap (phased)

- v0 — proof it's fun: 3-4 sources → daily batch → static card feed, no personalization.
  Just confirm he enjoys scrolling it.
- v1 — the hook: add LLM one-liners + explain-to-expand. This is the meh→nice jump.
- v2 — it learns: save button + engagement-based reweighting (floor-not-funnel) + wildcard.
- v3 — polish: offline caching, "you're caught up" marker, home-screen install, morning push.

## Status / open next steps

Prototyped in-session (as visual mockups): card format, hook voice (3 iterations to dial in),
explain view, save + ranking, saved/read-later list.

Not yet done — candidate next steps:
1. **Generator prompt** — the actual LLM instructions that reliably produce hooks in his
   voice at scale (~100/day). Highest-leverage remaining item; the feed lives or dies on this.
2. **Sources wiring reality check** — which lanes have clean free feeds vs. need scraping,
   to scope build effort per lane.
3. **More UI** — onboarding, daily-digest/notification, the "go deeper in chat" view.

Nothing has been built as code yet — this is all product/design decisions plus visual mockups.
