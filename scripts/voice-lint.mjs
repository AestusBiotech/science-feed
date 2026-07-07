// Voice linter for science-feed hooks.
//
// The whole bet of this feed is that the hooks sound like the owner, not like an
// LLM. When the daily updater generates a hook automatically, nobody reads it
// before it goes live — so this linter is the guardrail. It mechanically rejects
// the AI tells and banned patterns from the voice profile, and the generator
// regenerates (or drops the item) until a hook passes. It can't catch everything
// a human would, but it stops the obvious drift.

const BANNED = [
  { re: /—/, why: "em dash" },
  { re: /–/, why: "en dash (use a hyphen)" },
  { re: /!/, why: "exclamation point" },
  { re: /\bplot twist\b/i, why: '"plot twist"' },
  { re: /\bisn'?t just\b[^.?!]*\bit'?s\b/i, why: "negative parallelism (isn't just X, it's Y)" },
  { re: /\bnot just\b[^.?!]*\bbut\b/i, why: "negative parallelism (not just X but Y)" },
  { re: /\bnot only\b[^.?!]*\bbut\b/i, why: "not-only-but-also parallelism" },
  { re: /\bunlocks?\b/i, why: '"unlock(s)" hype verb' },
  {
    re: /\b(revolutionary|groundbreaking|game[- ]?chang\w*|cutting[- ]edge|seamless\w*|delv\w+|leverag\w+|paradigm|superchar\w+|turbochar\w+|unprecedented|must[- ]have|state[- ]of[- ]the[- ]art|best[- ]in[- ]class|world[- ]class)\b/i,
    why: "hype / AI-tell vocabulary",
  },
  // emoji / pictographs — his voice has none
  { re: /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u, why: "emoji or symbol glyph" },
];

/**
 * @param {string} text  the hook to check
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function lintHook(text) {
  const reasons = [];
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, reasons: ["empty hook"] };
  }

  for (const { re, why } of BANNED) {
    if (re.test(text)) reasons.push(why);
  }

  // soft shape guard: the voice is ~2-3 short sentences, never a wall of text
  const sentences = (text.match(/[.?!]+(\s|$)/g) || []).length;
  if (sentences > 4) reasons.push(`too many sentences (${sentences})`);
  if (text.length > 640) reasons.push(`too long (${text.length} chars)`);

  return { ok: reasons.length === 0, reasons };
}
