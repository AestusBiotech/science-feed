// Daily feed updater.
//
// Runs in GitHub Actions (see .github/workflows/update-feed.yml). It:
//   1. pulls fresh candidate items from bioRxiv and ClinicalTrials.gov,
//   2. drops anything already in feed.json,
//   3. asks Claude to write an in-voice hook + explain-beats for each new item,
//   4. runs every generated hook through the voice linter, regenerating until it
//      passes (or dropping the item),
//   5. prepends the survivors, caps the pool, and writes feed.json.
//
// The commit that this produces is what redeploys the live site. No hook reaches
// the phone without clearing the linter first — that's the guardrail that keeps
// unattended generation from drifting into AI-tell territory.
//
// Requires ANTHROPIC_API_KEY in the environment. Optional: MODEL, EFFORT, MAX_NEW.
// Run `node scripts/update-feed.mjs --dry-run` to preview without writing.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lintHook } from "./voice-lint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEED_PATH = join(HERE, "..", "feed.json");

const MODEL = process.env.MODEL || "claude-opus-4-8";
const EFFORT = process.env.EFFORT || "medium";
const MAX_NEW = Number(process.env.MAX_NEW || 5);   // new cards published per run
const MAX_POOL = 80;                                 // total cards kept in feed.json
const DRY_RUN = process.argv.includes("--dry-run");

// ---------- the voice ----------
// Kept in sync with the hook-voice notes. This is what makes or breaks the feed,
// so it's spelled out in full rather than summarized.
const VOICE_SYSTEM = `You write one-line "why you'd care" hooks for a personal science feed. The reader is a radiopharma scientist. The hooks must sound like him, never like an AI or a press release.

Voice:
- sentence case, plain prose. no exclamation points. no em dashes or en dashes (use a hyphen or reword).
- string thoughts together with "and" and "but". 2 to 3 short sentences, no more.
- the last sentence is an honest, usually skeptical read. it never oversells. examples of the register: "whether you actually need four flavors is another question", "still a maybe", "a lab tool more than anything, but a good one", "either they know something the rest of us don't, or they've got cash to burn".
- deadpan understatement over jokes. dry, occasional, never a setup-and-punchline.

Banned (these read as AI or as reddit-nerd humor, and he hates them):
- cutesy similes or metaphors ("like Lego bricks", "dusting for fingerprints", "crime scene an hour late").
- "plot twist", wordplay, em dashes, exclamation points.
- rule-of-three lists, negative parallelism ("isn't just X, it's Y" / "not just X but Y").
- hype words: revolutionary, groundbreaking, game-changer, cutting-edge, seamless, unlock, delve, leverage, paradigm, unprecedented, must-have, state-of-the-art.

For each item you also write four short explain beats:
- snippet: one neutral factual sentence describing the study (this is the summary, not in-voice).
- gist: what it actually is, plainly.
- interesting: why it might matter.
- catch: the honest limitation. always real, never a throwaway.

Return only the JSON object requested. No preamble.`;

const HOOK_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string" },
    shownBecause: { type: "string" },
    explain: {
      type: "object",
      properties: {
        snippet: { type: "string" },
        gist: { type: "string" },
        interesting: { type: "string" },
        catch: { type: "string" },
      },
      required: ["snippet", "gist", "interesting", "catch"],
      additionalProperties: false,
    },
  },
  required: ["hook", "shownBecause", "explain"],
  additionalProperties: false,
};

const LANE_LABEL = {
  orgchem: "org chem",
  biochem: "biochem",
  radiopharma: "radiopharma",
  startups: "startups",
  biotechnews: "biotech news",
  wildcard: "wildcard",
};

// ---------- helpers ----------
function ymd(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000); }
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function laneForCategory(cat) {
  const c = (cat || "").toLowerCase();
  if (/(biochemistry|molecular biology|cell biology|systems biology|physiology|pharmacology)/.test(c)) return "biochem";
  if (/(cancer|immunology|microbiology|pathology)/.test(c)) return "biotechnews";
  if (/(synthetic biology|bioengineering|biophysics|bioinformatics|genomics|genetics)/.test(c)) return "wildcard";
  return "wildcard";
}

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// ---------- candidate sources ----------
async function fetchBiorxiv() {
  const from = ymd(daysAgo(21));
  const to = ymd(new Date());
  let coll = [];
  try {
    const data = await getJSON(`https://api.biorxiv.org/details/biorxiv/${from}/${to}/0/json`);
    coll = data.collection || [];
  } catch (e) {
    console.warn("bioRxiv fetch failed:", e.message);
    return [];
  }
  const KEEP = /(biochemistry|molecular biology|cell biology|systems biology|physiology|pharmacology|synthetic biology|bioengineering|cancer)/i;
  return coll
    .filter((p) => KEEP.test(p.category || ""))
    .map((p) => ({
      key: `https://doi.org/${p.doi}`,
      id: slug(p.title || p.doi),
      lane: laneForCategory(p.category),
      source: "bioRxiv",
      type: "preprint",
      date: p.date || null,
      provenanceNote: null,
      title: (p.title || "").trim(),
      url: `https://doi.org/${p.doi}`,
      summary: (p.abstract || "").trim(),
      meta: `preprint, bioRxiv, category: ${p.category}`,
    }));
}

async function fetchTrials() {
  const params = new URLSearchParams({
    "query.intr": "177Lu OR 225Ac OR PSMA OR radioligand OR DOTATATE OR theranostic",
    "filter.overallStatus": "RECRUITING",
    pageSize: "25",
    sort: "StartDate:desc",
  });
  let studies = [];
  try {
    const data = await getJSON(`https://clinicaltrials.gov/api/v2/studies?${params}`);
    studies = data.studies || [];
  } catch (e) {
    console.warn("ClinicalTrials fetch failed:", e.message);
    return [];
  }
  return studies.map((s) => {
    const ps = s.protocolSection || {};
    const nct = ps.identificationModule?.nctId || "";
    const phases = ps.designModule?.phases || [];
    const status = (ps.statusModule?.overallStatus || "").toLowerCase().replace(/_/g, " ");
    const phaseLabel = phases.length ? phases.join("/").replace(/PHASE/g, "Phase ").replace(/\s+/g, " ").trim() : "";
    return {
      key: `https://clinicaltrials.gov/study/${nct}`,
      id: nct.toLowerCase(),
      lane: "radiopharma",
      source: "ClinicalTrials.gov",
      type: "trial",
      date: null,
      provenanceNote: [phaseLabel, status].filter(Boolean).join(" · ") || "recruiting",
      title: (ps.identificationModule?.briefTitle || "").trim(),
      url: `https://clinicaltrials.gov/study/${nct}`,
      summary: (ps.descriptionModule?.briefSummary || "").trim(),
      meta: `clinical trial, ${ps.conditionsModule?.conditions?.slice(0, 4).join(", ") || "condition n/a"}`,
    };
  }).filter((c) => c.id && c.title);
}

// ---------- Claude call ----------
async function generateCard(cand, apiKey) {
  const userPrompt = `Write a hook and explain-beats for this item.

lane: ${LANE_LABEL[cand.lane] || cand.lane}
source: ${cand.source} (${cand.meta})
title: ${cand.title}

abstract / summary:
${cand.summary ? cand.summary.slice(0, 2200) : "(none provided; work from the title and metadata)"}

For "shownBecause", write a short phrase like "${LANE_LABEL[cand.lane] || cand.lane} — <one honest reason it's in the feed>". Keep the whole thing in voice. Output the JSON object only.`;

  const body = {
    model: MODEL,
    max_tokens: 1200,
    system: VOICE_SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: HOOK_SCHEMA } },
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") return null;
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) return null;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return null;
  }
}

async function generateCardLinted(cand, apiKey, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    let gen;
    try {
      gen = await generateCard(cand, apiKey);
    } catch (e) {
      console.warn(`  gen error (${cand.id}):`, e.message);
      return null;
    }
    if (!gen || !gen.hook) continue;
    const check = lintHook(gen.hook);
    if (check.ok) return gen;
    console.warn(`  linter rejected ${cand.id} (attempt ${attempt}): ${check.reasons.join("; ")}`);
  }
  return null;
}

// ---------- main ----------
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !DRY_RUN) {
    console.error("ANTHROPIC_API_KEY is not set. Nothing to do.");
    process.exit(1);
  }

  const feed = JSON.parse(readFileSync(FEED_PATH, "utf8"));
  const seen = new Set();
  for (const c of feed.cards) {
    seen.add(c.id);
    if (c.url) seen.add(c.url);
  }

  const [pre, trials] = await Promise.all([fetchBiorxiv(), fetchTrials()]);
  // interleave sources so a run isn't all trials or all preprints
  const pool = [];
  const maxLen = Math.max(pre.length, trials.length);
  for (let i = 0; i < maxLen; i++) {
    if (trials[i]) pool.push(trials[i]);
    if (pre[i]) pool.push(pre[i]);
  }
  const candidates = pool.filter((c) => !seen.has(c.id) && !seen.has(c.key));
  console.log(`Fetched ${pre.length} preprints + ${trials.length} trials; ${candidates.length} are new.`);

  if (DRY_RUN) {
    console.log("Dry run. First few candidates:");
    for (const c of candidates.slice(0, MAX_NEW)) console.log(`  [${c.lane}] ${c.title}`);
    return;
  }

  const fresh = [];
  for (const cand of candidates) {
    if (fresh.length >= MAX_NEW) break;
    const gen = await generateCardLinted(cand, apiKey);
    if (!gen) continue;
    fresh.push({
      id: cand.id,
      lane: cand.lane,
      source: cand.source,
      type: cand.type,
      date: cand.date,
      ...(cand.provenanceNote ? { provenanceNote: cand.provenanceNote } : {}),
      title: cand.title,
      hook: gen.hook,
      url: cand.url,
      image: { kind: "none" },
      shownBecause: gen.shownBecause || `${LANE_LABEL[cand.lane] || cand.lane} — fresh from ${cand.source}`,
      explain: gen.explain,
      auto: true,
    });
    console.log(`  + ${cand.id}`);
  }

  if (!fresh.length) {
    console.log("No new cards cleared the linter this run. Feed unchanged.");
    return;
  }

  feed.cards = [...fresh, ...feed.cards].slice(0, MAX_POOL);
  feed.generated = ymd(new Date());
  writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2) + "\n");
  console.log(`Wrote ${fresh.length} new card(s). Pool is now ${feed.cards.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
