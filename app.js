/* personal curated feed — endless scroll, no backend.
   The latest-harvest batch (the "new"-badged cards) leads: ~70% of the feed is
   new while any of the batch is unseen this session, front-loaded even higher at
   the start of a scroll. Older cards fill the rest and take over once the batch
   is exhausted; long-idle items resurface from the "vault" after ~14d.
   what's been shown is tracked in IndexedDB. */

'use strict';

const FEED_DIR = './data/feed';
const VAULT_AGE_MS = 14 * 864e5;        // resurface after ~14 days
// The feed leads with the latest harvest (the "new"-badged batch). While any of
// that batch is still unshown this session, ~NEW_TARGET of cards come from it,
// and the first NEW_RAMP cards of a scroll lean even harder to new so opening
// the app feels fresh. Older cards fill the remainder to break up long runs of
// new, then take over once the batch is exhausted for the session.
const NEW_TARGET = 0.70;               // steady-state share of "new" cards while the batch lasts
const NEW_RAMP = 10;                    // first ~N cards ease from ~all-new down to NEW_TARGET
const PAGE = 8;                         // cards rendered per scroll step
// Infinite scroll only appends, so on a long session the DOM (and every remote
// card image) grows without bound and phones start to stutter. Cap the live
// nodes: once the feed passes MAX_LIVE cards, trim the oldest ones off the top
// back down to PRUNE_TO and compensate the scroll position so nothing jumps.
// The window is deliberately generous so scrolling back up stays intact for a
// long way; only runaway sessions get trimmed.
const MAX_LIVE = 160;
const PRUNE_TO = 110;

const LANE_COLORS = {
  'org chem': '#3c6864',
  'biochem': '#6d8f6a',
  'radiopharma': '#e6af2e',
  'biotech news': '#4f7d86',
  'methods': '#8f7aa8',
  'wildcard': '#869490',
};
const SOURCE_LABEL = {
  reddit: 'reddit', hn: 'hn', arxiv: 'arXiv',
  pubmed: 'pubmed', rss: 'rss', web: 'web',
  crossref: 'journal', chemrxiv: 'ChemRxiv',
  clinicaltrials: 'trial', openalex: 'journal',
};
// Per-source lean in the fresh shuffle. Reddit threads from the reader's
// subreddits get nudged forward so they surface a bit more (they're already
// 48h-fresh, so this just tips them toward the top). 1 = neutral.
const SOURCE_WEIGHT = {
  reddit: 1.6,
};
const BOOKMARK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';
// Reddit "snoo" mark for the reddit-source badge. fill=currentColor via CSS.
const REDDIT_MARK =
  '<svg viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M10 0a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5.01 11.17c.02.16.03.32.03.49 ' +
  '0 2.5-2.91 4.53-6.5 4.53s-6.5-2.03-6.5-4.53c0-.17.01-.33.03-.49a1.5 1.5 0 1 1 ' +
  '1.66-2.42 7.9 7.9 0 0 1 4.13-1.3l.78-3.68a.33.33 0 0 1 .39-.25l2.6.55a1.05 ' +
  '1.05 0 1 1-.13.63l-2.32-.5-.7 3.3a7.9 7.9 0 0 1 4.06 1.3 1.5 1.5 0 1 1 1.66 ' +
  '2.42zM6.9 11.4a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 0 0-2.1 0zm5.72 2.68a.33.33 ' +
  '0 0 0-.46-.02c-.5.4-1.28.6-2.16.6s-1.66-.2-2.16-.6a.33.33 0 1 0-.44.5c.66.53 ' +
  '1.57.78 2.6.78s1.94-.25 2.6-.78a.33.33 0 0 0 .02-.48zm-1.67-2.68a1.05 1.05 0 ' +
  '1 0 2.1 0 1.05 1.05 0 0 0-2.1 0z"/></svg>';
// thumbs-down — "not interested", hides the card for good
const THUMBSDOWN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 ' +
  '1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36' +
  '.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>';
// share — Material "share" node icon; copies the link when there's no share sheet
const SHARE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-' +
  '.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 ' +
  '9.81A3 3 0 1 0 6 15a2.99 2.99 0 0 0 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.92 ' +
  '2.92 0 1 0 2.92-2.92z"/></svg>';
// check — shown briefly after a link is copied to the clipboard
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

/* ---- learned ranking -------------------------------------------------- */
// Your own history is the signal: a save is a vote for a card, "not interested"
// is a vote against. We tally those votes by lane, by source, and by title/blurb
// term, then nudge the fresh-shuffle weight toward what you keep and away from
// what you kill. Everything here is bounded and tunable — set STRENGTH to 0 to
// turn the learned layer off entirely and fall back to pure recency.
const AFFINITY = {
  STRENGTH: 1.0,     // global gain on the learned signal (0 = disabled)
  LANE_W: 1.0,       // how much a lane vote counts
  SOURCE_W: 0.7,     // how much a source vote counts
  TERM_W: 0.5,       // how much each title/blurb term vote counts
  MAX_TERMS: 8,      // only the strongest N term votes per card (noise control)
  MIN_MULT: 0.35,    // floor on the final weight multiplier
  MAX_MULT: 2.5,     // ceiling on the final weight multiplier
  SAVE_VOTE: 1.0,    // a save is a deliberate keep — full positive vote
  CLICK_VOTE: 0.5,   // opening a card's link is a lighter, more frequent "read
                     // more of this" vote — counts, but less than an explicit save
  HIDE_VOTE: -1.0,   // "not interested" — full negative vote
};
// tiny stoplist so common words don't become "preferences"
const STOPWORDS = new Set(
  ('the this that with from into your have been over more than what when will ' +
   'here they them their about using used uses show shows into onto also could ' +
   'would should study studies research paper news team says said first ')
    .split(/\s+/).filter(Boolean));

/* ---- Ricky ------------------------------------------------------------- */
// "Ricky's choice" is a permanent section, like saved. Endorsed picks live
// there forever and also appear in the regular feed carrying the amber tag.
// The pop-up is decoupled: it fires once per pick that this device hasn't
// seen, and only while the pick is still fresh — so old news never re-summons
// him. Everything reads from ./data/feed/ricky.json.
const RICKY_LANE = "Ricky's choice";
const RICKY_INDEX = `${FEED_DIR}/ricky.json`;
const RICKY_POP_MAX_AGE_MS = 7 * 864e5;   // a pick only pops within ~7 days of endorsement
// small up-triangle, echoing his raised finger
const RICKY_MARK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 9H1z"/></svg>';

// The cast. All four Rickys share one pop-up shell (same corner, same bubble);
// which image, line and buttons show up is data here. `w`/`ratio` size the
// image and put the bubble just above it (ratio = the PNG's height/width).
// A "say" is [id, text, tag]: for hi/think the tag gates a line to a context
// (late / morning / newday), for thumbs it names the reward that earns it.
// Lines don't repeat until their pool cycles (history in localStorage).
// A button is [label, comebacks]: every button just dismisses him, but any
// tap has a RICKY_RETORT_P chance of a comeback tied to that button — the
// bubble swaps to the retort and he sees himself out a beat later.
const RICKY_FOFF = ['Fuck off Ricky', [
  "Charming. And yet here you are, getting smarter. You're welcome.",
  "I'll fade. The ignorance won't.",
  "Rude. I'm the best thing that happens to your brain all day.",
  "Temper. That's the ignorance talking. It gets defensive near knowledge.",
  "Fine. But we both know you'll be back tomorrow, marginally smarter.",
  "Harsh. I'll allow it - you did read something today.",
]];
const RICKY_CAST = {
  choice: {
    img: './icons/ricky.png', w: 'min(48vw, 190px)', ratio: 0.815,
    pairs: [[['Read it', null], RICKY_FOFF]],
    says: [
      ['C1', "I bring important information. Read it. Maybe one day you'll be as smart as me."],
      ['C2', "I found something genuinely worth your time. That's rare. Read it."],
      ['C3', 'This one cleared my bar. My bar is very high. Read it.'],
    ],
  },
  hi: {
    img: './icons/ricky-hi.png', w: 'min(48vw, 190px)', ratio: 0.77,
    pairs: [
      [['Hi Ricky', ["Hi. That's the bare minimum of manners, but I'll accept it."]],
       RICKY_FOFF],
      [['Yeah, yeah', ['Dismissive. Bold, for someone who came here to fix their brain.']],
       ['Not now', ["'Not now' is the motto of every brain that stayed average."]]],
    ],
    says: [
      ['H1', "Oh good, you're back. The neurons were getting lonely."],
      ['H2', 'Look who returned for more knowledge. Restraint was never your strength.'],
      ['H3', "You again. Doomscrolling elsewhere would've been a waste of a perfectly good brain."],
      ['H4', 'Welcome back. Try to retain something this time.'],
      ['H5', "You returned voluntarily. That's already smarter than most of your decisions."],
      ['H6', "It's late and you chose learning over sleep. Reckless. Respect.", 'late'],
      ['H7', 'Back for more. The one addiction I actually endorse.'],
      ['H8', 'Returned again. At this rate you might accidentally become smart.'],
      ['H9', 'You keep choosing this over instagram garbage. I notice. I approve.'],
      ['H10', "New day, same under-utilized brain. Let's do something about that.", 'newday'],
      ['H11', "Up early and here. Either you're serious about getting smarter, or you couldn't sleep. I'll take it.", 'morning'],
    ],
  },
  think: {
    img: './icons/ricky-think.png', w: 'min(40vw, 150px)', ratio: 1.234,
    pairs: [
      [["I'm reading, I swear", ['Sure you are.', 'Reading. At that speed. Right. And I moonlight as a fighter pilot.']],
       ["You're not my advisor", ["No. Your advisor gave up. I didn't."]]],
      [["Fine, I'll slow down", ['See? Growth. Painful, but growth.']],
       RICKY_FOFF],
    ],
    says: [
      ['T1', "Scroll, scroll, scroll. This isn't that app. Read one. I dare you."],
      ['T2', 'Quantity of scroll ≠ quantity of thought. Ask me how I know.'],
      ['T3', "I've been watching. You're skimming. Skimming is just rotting with extra steps."],
      ['T4', "Every card you blur past is a fact you chose not to have. Just so we're clear."],
      ['T5', 'Slow down. The point was never the scroll. The point was the getting-smarter part.'],
      ['T6', "It's 2am and you're speed-running headlines. Even I have concerns.", 'late'],
      ['T7', 'Your thumb is very busy. Your brain is not. Interesting division of labor.'],
      ['T8', "You're scrolling fast. Knowledge doesn't stick at that speed. Physics, basically."],
      ['T9', "That's a lot of ground covered and nothing picked up. Impressive, in the worst way."],
      ['T10', "I can tell you're not reading. The good news is nobody's grading you. The bad news is you."],
      ['T11', 'The whole idea was to leave here smarter. So far you\'re just leaving here faster.'],
    ],
  },
  thumbs: {
    img: './icons/ricky-thumbs.png', w: 'min(46vw, 175px)', ratio: 0.948,
    pairs: [
      [['Thanks, Ricky', ["Don't thank me. Thank the attention span you didn't know you had."]],
       ["Don't get used to it", ["Wasn't planning to. My expectations remain unreasonably high."]]],
      [['Damn right', ["That's the spirit. Insufferable, but earned."]],
       RICKY_FOFF],
    ],
    says: [
      ['U1', "You actually opened it and read it. I'm almost proud. Don't let it go to your head.", 'return'],
      ['U2', 'Saved for later? Look at you, planning to be smarter. Approved.', 'save'],
      ['U3', "Three in a row, actually read. Someone's brain is doing push-ups.", 'reads3'],
      ['U4', 'You reached the end of the feed. Nobody does that. Well done, you magnificent nerd.', 'feedEnd'],
      ['U5', "Look at that. A functioning attention span. I'd almost given up on you.", 'dwell'],
      ['U6', "You opened it, actually read it - took your time - and came back. That's the whole loop. Well done.", 'return'],
      ['U7', 'You came back for the one you saved. So you did mean it. Noted, and approved.', 'savedReturn'],
      ['U8', "That's a streak. Real reading, back to back. Your brain's getting a workout it didn't consent to.", 'reads3'],
      ['U9', 'Out to read the full text, back with a fuller brain. Ricky approves.', 'return'],
      ['U10', 'You searched for something specific. Curiosity with aim. Respect.', 'search'],
      ['U11', "Day after day you show up and read. That's not a habit, that's a personality upgrade.", 'streak'],
      ['U12', "You're stockpiling good reads like a squirrel with a library card. Approved.", 'saves3'],
      ['U13', "You've been at this a while, actually reading. Your attention span called - it's alive.", 'dwell'],
      ['U14', 'You took my recommendation and read it. Correct. Obviously. But still - good.', 'choiceRead'],
    ],
  },
};

const els = {
  feed: document.getElementById('feed'),
  lanes: document.getElementById('lanes'),
  status: document.getElementById('status'),
  tail: document.getElementById('tail'),
  sentinel: document.getElementById('sentinel'),
  search: document.getElementById('search'),
};

const state = {
  manifest: null,
  loaded: [],            // all cards fetched so far, each tagged with _order
  latestHarvest: '',     // newest `harvested` date across loaded cards — the "new" batch
  nextChunk: -1,         // index into manifest.chunks, walked newest -> oldest
  shown: new Map(),      // id -> lastShown ms (mirror of IndexedDB)
  saved: new Map(),      // id -> card (mirror of IndexedDB 'saved' store)
  hidden: new Map(),     // id -> {at, lane, source, title} — "not interested" (legacy: number)
  visited: new Set(),    // ids whose source link has been opened (mirror of 'visited')
  visitedRecs: new Map(),// id -> {at, lane, source, title, blurb} for opened links — a
                         // positive "read more of this" vote (legacy entries are bare numbers)
  session: new Set(),    // ids rendered in this scroll session
  freshNew: [],          // never-shown latest-harvest ("new") cards for the lane, weighted-shuffled
  freshOld: [],          // never-shown older cards for the lane, weighted-shuffled
  lane: 'all',
  pos: 0,                // interleave counter
  busy: false,
  done: false,
  searching: false,      // true while the search box is filtering the feed
  ricky: [],             // endorsed picks (full cards, newest-first) from ricky.json
  rickyPopped: new Set(),// pick ids this device has already been shown a pop-up for
  rickyQueue: [],        // picks still owed a pop-up this session
  rickyBusy: false,      // a pop-up is currently on screen
  rickyArmed: false,     // scroll listener has been primed to fire the next pop
};

/* ---- IndexedDB (shown-set) ------------------------------------------- */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('feed', 5); }
    catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('shown')) d.createObjectStore('shown');
      if (!d.objectStoreNames.contains('saved')) d.createObjectStore('saved');
      if (!d.objectStoreNames.contains('ricky')) d.createObjectStore('ricky');
      if (!d.objectStoreNames.contains('hidden')) d.createObjectStore('hidden');
      if (!d.objectStoreNames.contains('visited')) d.createObjectStore('visited');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbp;
}
async function loadShown() {
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    const tx = d.transaction('shown', 'readonly').objectStore('shown').openCursor();
    tx.onsuccess = () => {
      const cur = tx.result;
      if (!cur) return resolve();
      state.shown.set(cur.key, cur.value);
      cur.continue();
    };
    tx.onerror = () => resolve();
  });
}
async function markShown(id) {
  const now = Date.now();
  state.shown.set(id, now);
  const d = await db();
  if (!d) return;
  try { d.transaction('shown', 'readwrite').objectStore('shown').put(now, id); }
  catch { /* private mode etc. — in-memory mirror still works */ }
}

/* ---- IndexedDB (saved-set) ------------------------------------------- */
async function loadSaved() {
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    let tx;
    try { tx = d.transaction('saved', 'readonly').objectStore('saved').openCursor(); }
    catch { return resolve(); }
    tx.onsuccess = () => {
      const cur = tx.result;
      if (!cur) return resolve();
      state.saved.set(cur.key, cur.value);
      cur.continue();
    };
    tx.onerror = () => resolve();
  });
}
async function saveCard(card) {
  card._savedAt = Date.now();
  state.saved.set(card.id, card);
  const d = await db();
  if (!d) return;
  const clean = { ...card };
  delete clean._shuf;                       // transient shuffle key, don't persist
  try { d.transaction('saved', 'readwrite').objectStore('saved').put(clean, card.id); }
  catch { /* private mode etc. — in-memory mirror still works */ }
}
async function unsaveCard(id) {
  state.saved.delete(id);
  const d = await db();
  if (!d) return;
  try { d.transaction('saved', 'readwrite').objectStore('saved').delete(id); }
  catch { /* ignore */ }
}

/* ---- IndexedDB (hidden / "not interested" set) ----------------------- */
async function loadHidden() {
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    let tx;
    try { tx = d.transaction('hidden', 'readonly').objectStore('hidden').openCursor(); }
    catch { return resolve(); }
    tx.onsuccess = () => {
      const cur = tx.result;
      if (!cur) return resolve();
      state.hidden.set(cur.key, cur.value);
      cur.continue();
    };
    tx.onerror = () => resolve();
  });
}
async function hideCard(card) {
  // store lane/source/title alongside the timestamp so the learned ranking can
  // count this as a negative vote later (old entries are bare numbers — the
  // affinity builder tolerates both). Membership checks only use the key.
  const rec = {
    at: Date.now(),
    lane: card.lane,
    source: card.source,
    title: card.title || '',
  };
  state.hidden.set(card.id, rec);
  const d = await db();
  if (!d) return;
  try { d.transaction('hidden', 'readwrite').objectStore('hidden').put(rec, card.id); }
  catch { /* private mode etc. — in-memory mirror still works */ }
}

/* ---- IndexedDB (visited set — opened source links) ------------------- */
async function loadVisited() {
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    let tx;
    try { tx = d.transaction('visited', 'readonly').objectStore('visited').openCursor(); }
    catch { return resolve(); }
    tx.onsuccess = () => {
      const cur = tx.result;
      if (!cur) return resolve();
      state.visited.add(cur.key);
      // records carry lane/source/title/blurb for the learned vote; older
      // entries are bare timestamps and just count as membership.
      if (cur.value && typeof cur.value === 'object') state.visitedRecs.set(cur.key, cur.value);
      cur.continue();
    };
    tx.onerror = () => resolve();
  });
}
async function markVisited(card, cardEl) {
  if (cardEl) cardEl.classList.add('visited');
  if (state.visited.has(card.id)) return;
  // store lane/source/title/blurb alongside the timestamp so opening the link
  // registers as a positive vote in the learned ranking (see buildAffinity).
  const rec = {
    at: Date.now(),
    lane: card.lane,
    source: card.source,
    title: card.title || '',
    blurb: card.blurb || '',
  };
  state.visited.add(card.id);
  state.visitedRecs.set(card.id, rec);
  const d = await db();
  if (!d) return;
  try { d.transaction('visited', 'readwrite').objectStore('visited').put(rec, card.id); }
  catch { /* private mode etc. — in-memory mirror still works */ }
}

/* ---- IndexedDB (ricky-popped set) ------------------------------------- */
async function loadRickyPopped() {
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    let tx;
    try { tx = d.transaction('ricky', 'readonly').objectStore('ricky').openCursor(); }
    catch { return resolve(); }
    tx.onsuccess = () => {
      const cur = tx.result;
      if (!cur) return resolve();
      state.rickyPopped.add(cur.key);
      cur.continue();
    };
    tx.onerror = () => resolve();
  });
}
async function markRickyPopped(id) {
  if (state.rickyPopped.has(id)) return;
  state.rickyPopped.add(id);
  const d = await db();
  if (!d) return;
  try { d.transaction('ricky', 'readwrite').objectStore('ricky').put(Date.now(), id); }
  catch { /* private mode etc. — in-memory mirror still works */ }
}

async function loadRickyIndex() {
  try {
    const res = await fetch(`${RICKY_INDEX}`, { cache: 'no-cache' });
    if (!res.ok) return;                       // no picks yet, or not deployed
    const list = await res.json();
    if (Array.isArray(list)) {
      // newest-first, defensively — endorsed_at is the anchor
      state.ricky = list.slice().sort(
        (a, b) => rickyTime(b) - rickyTime(a));
    }
  } catch { /* offline / missing — the section just shows empty */ }
}
function rickyTime(card) {
  return Date.parse(card.ricky && card.ricky.endorsed_at) || 0;
}

/* ---- helpers ---------------------------------------------------------- */
const laneMatch = (card) => state.lane === 'all' || card.lane === state.lane;

function relAge(card) {
  const iso = card.published || card.harvested || '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.max(0, Math.floor((Date.now() - t) / 864e5));
  if (days <= 0) return 'today';
  if (days < 7) return days + 'd';
  if (days < 60) return Math.floor(days / 7) + 'w';
  if (days < 730) return Math.floor(days / 30) + 'mo';
  return Math.floor(days / 365) + 'y';
}

// A card is "new" if it came from the most recent harvest — i.e. its `harvested`
// date matches the newest harvest date anywhere in the loaded feed. The whole
// latest batch stays badged until the next harvest lands newer cards, which
// shifts state.latestHarvest forward and retires the previous batch's badges.
function isFreshCard(card) {
  const h = (card.harvested || '').slice(0, 10);
  return !!h && h === state.latestHarvest;
}

// pull the distinctive terms out of a bit of text (title/blurb), lowercased,
// de-duped, stop-worded, and length-filtered so only meaty words vote.
function terms(text) {
  const out = new Set();
  const toks = String(text || '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [];
  for (const t of toks) {
    if (STOPWORDS.has(t)) continue;
    out.add(t);
    if (out.size >= 40) break;               // cap work on very long text
  }
  return out;
}

// a raw vote count -> a bounded, diminishing signal. One save/hide moves the
// needle; the tenth barely adds. Sign carries the direction.
function signal(n) {
  if (!n) return 0;
  return Math.sign(n) * Math.log1p(Math.abs(n));
}

// Tally votes across the whole save/hide history once, cached until it changes.
let affinity = null;
function buildAffinity() {
  const lane = new Map(), source = new Map(), term = new Map();
  const vote = (map, key, delta) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + delta);
  };
  const voteTerms = (text, delta) => {
    for (const t of terms(text)) vote(term, t, delta);
  };
  for (const card of state.saved.values()) {           // saves: strong positive votes
    vote(lane, card.lane, AFFINITY.SAVE_VOTE);
    vote(source, card.source, AFFINITY.SAVE_VOTE);
    voteTerms((card.title || '') + ' ' + (card.blurb || ''), AFFINITY.SAVE_VOTE);
  }
  for (const rec of state.visitedRecs.values()) {      // opened links: lighter positive votes
    if (!rec || typeof rec !== 'object') continue;      // legacy bare-timestamp entry
    vote(lane, rec.lane, AFFINITY.CLICK_VOTE);
    vote(source, rec.source, AFFINITY.CLICK_VOTE);
    voteTerms((rec.title || '') + ' ' + (rec.blurb || ''), AFFINITY.CLICK_VOTE);
  }
  for (const rec of state.hidden.values()) {           // hides: negative votes
    if (!rec || typeof rec !== 'object') continue;      // legacy numeric entry
    vote(lane, rec.lane, AFFINITY.HIDE_VOTE);
    vote(source, rec.source, AFFINITY.HIDE_VOTE);
    voteTerms(rec.title || '', AFFINITY.HIDE_VOTE);
  }
  affinity = { lane, source, term };
}

// Turn a card's votes into a bounded weight multiplier centered on 1.
function affinityMult(card) {
  if (!AFFINITY.STRENGTH || !affinity) return 1;
  let s = AFFINITY.LANE_W * signal(affinity.lane.get(card.lane))
        + AFFINITY.SOURCE_W * signal(affinity.source.get(card.source));
  // term votes: take only the strongest few so one hot word can't dominate.
  const tv = [];
  for (const t of terms((card.title || '') + ' ' + (card.blurb || ''))) {
    const v = affinity.term.get(t);
    if (v) tv.push(v);
  }
  tv.sort((a, b) => Math.abs(b) - Math.abs(a));
  let ts = 0;
  for (let i = 0; i < Math.min(tv.length, AFFINITY.MAX_TERMS); i++) ts += signal(tv[i]);
  s += AFFINITY.TERM_W * ts;
  const mult = Math.exp(AFFINITY.STRENGTH * 0.5 * s);
  return Math.max(AFFINITY.MIN_MULT, Math.min(AFFINITY.MAX_MULT, mult));
}

function rebuildFresh() {
  // Not strict newest-first: a weighted shuffle that still leans newer, so the
  // feed feels less deterministic without throwing recency out entirely. Each
  // card gets key = random^(1/weight); newer cards get more weight and trend
  // toward the front, but any card can surface early. On top of recency we fold
  // in the learned affinity (see affinityMult) so what you save floats up and
  // what you dismiss sinks.
  buildAffinity();
  const pool = state.loaded.filter(
    (c) => laneMatch(c) && !state.shown.has(c.id) &&
           !state.session.has(c.id) && !state.hidden.has(c.id));
  let min = Infinity, max = -Infinity;
  for (const card of pool) {
    if (card._order < min) min = card._order;
    if (card._order > max) max = card._order;
  }
  const span = (max - min) || 1;
  for (const card of pool) {
    const recency = (card._order - min) / span;    // 0..1, newest = 1
    const weight = (0.22 + 2.6 * recency)           // newer -> higher weight
                 * (SOURCE_WEIGHT[card.source] || 1)
                 * affinityMult(card);              // learned like/dislike
    card._shuf = Math.pow(Math.random() || 1e-9, 1 / weight);
  }
  pool.sort((a, b) => b._shuf - a._shuf);
  // Split the never-shown pool into the latest-harvest batch and everything
  // older, preserving the weighted-shuffle order within each. place() draws
  // mostly from the "new" side while it lasts; see NEW_TARGET / newShare().
  state.freshNew = pool.filter(isFreshCard);
  state.freshOld = pool.filter((c) => !isFreshCard(c));
}

/* ---- loading ---------------------------------------------------------- */
async function loadManifest() {
  const res = await fetch(`${FEED_DIR}/manifest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error('manifest ' + res.status);
  state.manifest = await res.json();
  state.nextChunk = (state.manifest.chunks || []).length - 1;
}

async function loadNextChunk() {
  if (state.nextChunk < 0) return false;
  const idx = state.nextChunk;
  const name = state.manifest.chunks[idx];
  state.nextChunk -= 1;
  try {
    const res = await fetch(`${FEED_DIR}/${name}`);
    if (!res.ok) throw new Error(name + ' ' + res.status);
    const cards = await res.json();
    cards.forEach((card, i) => {
      card._order = idx * 1e5 + i;
      state.loaded.push(card);
      const h = (card.harvested || '').slice(0, 10);   // track the newest harvest batch
      if (h > state.latestHarvest) state.latestHarvest = h;
    });
    rebuildFresh();
    return true;
  } catch (e) {
    console.warn('chunk load failed', name, e);
    return false;
  }
}

/* ---- picking ---------------------------------------------------------- */
// Both "sides" of the feed are keyed off the latest-harvest badge, not the
// shown-set: a new-batch card you saw yesterday is still new today, so it keeps
// leading until you've cleared the batch *this session*. freshLeft() tracks the
// never-shown pools so renderNext knows when to page in older chunks.
const freshLeft = () => state.freshNew.length + state.freshOld.length;

// A never-shown "new" card if we have one; otherwise resurface a batch card not
// yet seen this session (so the batch keeps leading even on a return visit).
function pickNew() {
  if (state.freshNew.length) return state.freshNew.shift();
  const pool = state.loaded.filter(
    (c) => laneMatch(c) && isFreshCard(c) &&
           !state.session.has(c.id) && !state.hidden.has(c.id));
  if (!pool.length) return null;
  return pool[(Math.random() * pool.length) | 0];
}

// A never-shown older card if we have one; otherwise a resurfaced "vault" item
// (shown before, not yet this session), preferring ones aged past VAULT_AGE_MS.
function pickOld() {
  if (state.freshOld.length) return state.freshOld.shift();
  const pool = state.loaded.filter(
    (c) => laneMatch(c) && !isFreshCard(c) && state.shown.has(c.id) &&
           !state.session.has(c.id) && !state.hidden.has(c.id));
  if (!pool.length) return null;
  const now = Date.now();
  let eligible = pool.filter((c) => now - state.shown.get(c.id) > VAULT_AGE_MS);
  if (!eligible.length) eligible = pool;   // nothing "old enough" yet — still fine to resurface
  return eligible[(Math.random() * eligible.length) | 0];
}

// Is there a "new"/older card left to serve this session (unshown or resurfaced)?
const hasNew = () => state.freshNew.length > 0 || state.loaded.some(
  (c) => laneMatch(c) && isFreshCard(c) &&
         !state.session.has(c.id) && !state.hidden.has(c.id));
const hasOld = () => state.freshOld.length > 0 || state.loaded.some(
  (c) => laneMatch(c) && !isFreshCard(c) &&
         !state.session.has(c.id) && !state.hidden.has(c.id));

// Target share of "new" cards at the current scroll position: ~all-new for the
// first NEW_RAMP cards, easing down to the steady NEW_TARGET.
function newShare() {
  const ramp = Math.max(0, 1 - state.pos / NEW_RAMP);   // 1 -> 0 across NEW_RAMP cards
  return NEW_TARGET + (1 - NEW_TARGET) * ramp;
}

/* ---- rendering -------------------------------------------------------- */
function renderCard(card, opts = {}) {
  // The card is a plain container, not a link: only the title opens the source
  // (new tab), the image opens the in-app zoom viewer, and the body text is inert.
  const a = document.createElement('article');
  a.className = 'card';
  a.style.setProperty('--lane', LANE_COLORS[card.lane] || 'var(--text-faint)');
  if (card.ricky) a.classList.add('ricky');
  if (card.source === 'reddit') a.classList.add('reddit');
  if (state.visited.has(card.id)) a.classList.add('visited');
  a.dataset.id = card.id;

  // permanent "Ricky endorsed this" tag on any endorsed card, everywhere.
  if (card.ricky) {
    const rib = document.createElement('div');
    rib.className = 'ricky-ribbon';
    rib.innerHTML = RICKY_MARK + '<span>Ricky endorsed this</span>';
    if (opts.isNew) {
      const n = document.createElement('span');
      n.className = 'new';
      n.textContent = '· new';
      rib.appendChild(n);
    }
    a.appendChild(rib);
  }

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  // "new" pill leads the meta row so a fresh harvest is obvious at a glance.
  // Skipped in the expanded Ricky view, which has its own "· new" marker.
  if (!opts.expanded && isFreshCard(card)) {
    const nb = document.createElement('span');
    nb.className = 'new-badge';
    nb.textContent = 'new';
    meta.appendChild(nb);
  }
  const lane = document.createElement('span');
  lane.className = 'lane-tag';
  lane.textContent = card.lane;
  meta.appendChild(lane);
  // Reddit cards carry a small orange snoo badge next to the lane tag so it's
  // instantly clear the card links to a discussion thread, not a paper.
  if (card.source === 'reddit') {
    const rb = document.createElement('span');
    rb.className = 'reddit-badge';
    rb.innerHTML = REDDIT_MARK + '<span>reddit</span>';
    meta.appendChild(rb);
  }
  if (card.preprint) {
    const pre = document.createElement('span');
    pre.className = 'preprint-tag';
    pre.textContent = 'preprint';
    meta.appendChild(pre);
  }
  // right-aligned button group: "not interested", save. Share lives down in the
  // bottom source row instead, so it can't be fat-fingered next to thumbs-down.
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  // "Not interested": hides the card for good. Not offered in the saved or
  // Ricky lanes, where hiding makes no sense.
  const inFeed = state.lane !== 'saved' && state.lane !== RICKY_LANE;
  if (inFeed) {
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'hide-btn';
    hide.innerHTML = THUMBSDOWN_SVG;
    hide.setAttribute('aria-label', 'not interested');
    hide.title = 'Not interested';
    hide.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissCard(card, a);
    });
    actions.appendChild(hide);
  }

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'save-btn';
  save.innerHTML = BOOKMARK_SVG;
  const saved = state.saved.has(card.id);
  save.classList.toggle('is-saved', saved);
  save.setAttribute('aria-pressed', saved ? 'true' : 'false');
  save.setAttribute('aria-label', saved ? 'saved' : 'save');
  save.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSave(card, save, a);
  });
  actions.appendChild(save);
  meta.appendChild(actions);

  const h = document.createElement('h2');
  h.className = 'card-title';
  const titleLink = document.createElement('a');
  titleLink.className = 'card-title-link';
  titleLink.href = card.url;
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = card.title;
  // opening the source greys the card so you can see what you've already read.
  titleLink.addEventListener('click', () => { markVisited(card, a); eggOutbound(card); });
  h.appendChild(titleLink);

  const p = document.createElement('p');
  p.className = 'card-blurb';
  // in the Ricky's choice section, endorsed cards show the longer write-up.
  p.textContent = (opts.expanded && card.blurb_long) ? card.blurb_long : card.blurb;

  const src = document.createElement('div');
  src.className = 'card-source';
  const age = relAge(card);
  const origin = card.venue || SOURCE_LABEL[card.source] || card.source;
  const srcText = document.createElement('span');
  srcText.className = 'card-source-text';
  srcText.textContent = origin + (age ? ' · ' + age : '');
  src.appendChild(srcText);

  // Share sits in the lower-right corner, well clear of the top save/hide
  // buttons so a share tap can't land on "not interested".
  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'share-btn';
  share.innerHTML = SHARE_SVG;
  share.setAttribute('aria-label', 'share');
  share.title = 'Share';
  share.addEventListener('click', (e) => {
    e.stopPropagation();
    shareCard(card, share);
  });
  src.appendChild(share);

  a.append(meta, h, p);
  if (card.image) {
    const img = document.createElement('img');
    img.className = 'card-image';
    img.alt = '';
    // Cards are already mounted lazily by the infinite scroll (only cards near
    // the viewport exist in the DOM), so native loading="lazy" is redundant —
    // and in practice it left in-view figures unfetched, so the feed looked
    // pictureless. Load eagerly: the image fetches as soon as its card mounts.
    img.loading = 'eager';
    img.decoding = 'async';
    img.src = card.image;
    img.referrerPolicy = 'no-referrer';   // some hosts 403 hotlinks with a referrer
    // drop the figure (and its spacing) if the image is missing/blocked
    img.addEventListener('error', () => img.remove());
    // tap the image to open it full-screen in-app (zoomable), not a new tab.
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(card.image, card.title);
    });
    a.append(img);
  }
  a.append(src);
  els.feed.appendChild(a);
}

function toggleSave(card, btn, cardEl) {
  if (state.saved.has(card.id)) {
    unsaveCard(card.id);
    btn.classList.remove('is-saved');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'save');
    if (state.lane === 'saved') {         // remove it live from the saved view
      cardEl.remove();
      if (!state.saved.size) renderSaved();
    }
  } else {
    saveCard(card);
    btn.classList.add('is-saved');
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', 'saved');
    egg.saves += 1;
    tryEgg('thumbs', egg.saves >= 3 ? 'saves3' : 'save');
  }
}

function dismissCard(card, cardEl) {
  // "Not interested" — record it so it never resurfaces, then collapse it out.
  hideCard(card);
  state.session.add(card.id);          // don't let this session re-place it
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    cardEl.remove();
    // keep the feed full after the gap it left
    if (state.lane !== 'saved' && state.lane !== RICKY_LANE) fill();
  };
  cardEl.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 320);             // fallback if the transition doesn't fire
  requestAnimationFrame(() => cardEl.classList.add('leaving'));
}

async function shareCard(card, btn) {
  const url = card.url;
  if (!url) return;
  // Native share sheet where it exists (mobile, some desktops); otherwise copy
  // the link and flash a check; last resort, just open it.
  if (navigator.share) {
    try {
      await navigator.share({ title: card.title, text: card.title, url });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // user closed the sheet — fine
      // any other failure falls through to the copy path
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    flashShare(btn);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

function flashShare(btn) {
  const orig = btn.innerHTML;
  btn.innerHTML = CHECK_SVG;
  btn.classList.add('copied');
  btn.title = 'Link copied';
  setTimeout(() => {
    btn.innerHTML = orig;
    btn.classList.remove('copied');
    btn.title = 'Share';
  }, 1200);
}

function renderSaved() {
  els.feed.innerHTML = '';
  els.tail.textContent = '';
  const items = [...state.saved.values()].sort(
    (a, b) => (b._savedAt || 0) - (a._savedAt || 0));
  if (!items.length) {
    els.feed.innerHTML =
      '<div class="empty">nothing saved yet.<br>' +
      'tap the bookmark on any card to keep it here.</div>';
    return;
  }
  for (const card of items) renderCard(card);
}

/* ---- Ricky's choice section ------------------------------------------- */
function renderRicky(highlightId) {
  els.feed.innerHTML = '';
  els.tail.textContent = '';
  if (!state.ricky.length) {
    els.feed.innerHTML =
      '<div class="empty">no picks yet.<br>' +
      'Ricky only speaks up when something is genuinely worth it.</div>';
    return;
  }
  for (const card of state.ricky) {
    renderCard(card, { expanded: true, isNew: !state.rickyPopped.has(card.id) });
  }
  if (highlightId) {
    const el = els.feed.querySelector(`.card[data-id="${cssEscape(highlightId)}"]`);
    if (el) {
      el.classList.add('flash');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

// minimal CSS.escape fallback (ids are hex, but be safe)
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
}

function resetCycle() {
  // whole pile shown this session — clear the session set so the pile loops,
  // silently (no divider text). With the session cleared the new-first cycle
  // restarts: the latest batch leads again, then older cards.
  // In an endless feed, seeing the whole pile out *is* reaching the end.
  if (state.lane === 'all' && window.scrollY > 2000) tryEgg('thumbs', 'feedEnd');
  state.session.clear();
  rebuildFresh();
}

async function place() {
  let card = null;

  // The latest-harvest batch leads. While any of it is still unseen this session
  // we serve ~newShare() new cards (near all-new at the very start, easing to
  // NEW_TARGET), with older/resurfaced cards filling the rest to break up long
  // runs. Once the batch is used up for the session, the feed is all older —
  // which keeps scroll endless. If only one side has anything, serve that side.
  const newAvail = hasNew();
  const oldAvail = hasOld();
  if (newAvail && (!oldAvail || Math.random() < newShare())) {
    card = pickNew();
    if (!card) card = pickOld();
  } else if (oldAvail) {
    card = pickOld();
    if (!card) card = pickNew();
  }

  if (!card) {
    // nothing left unseen this session for this lane. loop the pile to stay endless.
    if (!state.loaded.some(laneMatch)) return false;
    resetCycle();
    card = pickNew() || pickOld();
    if (!card) return false;
  }

  renderCard(card);
  state.session.add(card.id);
  markShown(card.id);
  state.pos += 1;
  return true;
}

async function renderNext(n) {
  if (state.busy || state.done) return;
  state.busy = true;
  els.tail.innerHTML = '<span class="spinner"></span>';

  let placed = 0;
  while (placed < n) {
    // Page in older chunks before resurfacing repeats: while this lane has no
    // fresh cards left but the manifest still lists un-loaded chunks, pull the
    // next one so all real content is shown before the vault loop begins.
    // (Without this, a multi-chunk feed only ever loads the newest chunk and
    // loops it — the older chunks, and their images, never appear.)
    if (!freshLeft() && state.nextChunk >= 0) {
      await loadNextChunk();
      continue;
    }
    const ok = await place();
    if (ok) { placed += 1; continue; }
    // nothing to place — try pulling an older chunk, else stop.
    const gained = await loadNextChunk();
    if (!gained) break;
  }

  pruneTop();
  updateStatus();
  if (placed === 0 && !state.loaded.some(laneMatch)) {
    state.done = true;
    els.tail.textContent = 'nothing in this lane yet.';
  } else {
    els.tail.textContent = '';
  }
  state.busy = false;
}

function updateStatus() {
  if (!state.manifest) return;
  els.status.textContent = '';
}

/* ---- lanes ------------------------------------------------------------ */
function buildLanes() {
  const lanes = ['all', RICKY_LANE, 'saved', ...(state.manifest.lanes || [])];
  els.lanes.innerHTML = '';
  for (const lane of lanes) {
    const b = document.createElement('button');
    let cls = 'chip';
    if (lane === 'saved') cls += ' chip-saved';
    else if (lane === RICKY_LANE) cls += ' chip-ricky';
    b.className = cls;
    b.textContent = lane;
    b.setAttribute('aria-pressed', lane === state.lane ? 'true' : 'false');
    b.addEventListener('click', () => selectLane(lane, b));
    els.lanes.appendChild(b);
  }
}

function selectLane(lane) {
  if (lane === state.lane && !state.searching) return;
  state.lane = lane;
  // switching lanes always drops out of search.
  state.searching = false;
  if (els.search) els.search.value = '';
  [...els.lanes.children].forEach((c) =>
    c.setAttribute('aria-pressed', c.textContent === lane ? 'true' : 'false'));
  // reset the visible feed but keep the persistent shown-set.
  els.feed.innerHTML = '';
  state.session.clear();
  state.pos = 0;
  state.done = false;
  window.scrollTo({ top: 0 });
  if (lane === RICKY_LANE) { renderRicky(); return; }
  if (lane === 'saved') { renderSaved(); return; }
  rebuildFresh();
  fill();
}

// used by the pop-up's "Read it": jump to the section and highlight the pick,
// even if we're already on the Ricky's choice lane.
function openRickyChoice(highlightId) {
  state.lane = RICKY_LANE;
  [...els.lanes.children].forEach((c) =>
    c.setAttribute('aria-pressed', c.textContent === RICKY_LANE ? 'true' : 'false'));
  state.session.clear();
  state.pos = 0;
  state.done = false;
  state.searching = false;
  if (els.search) els.search.value = '';
  window.scrollTo({ top: 0 });
  renderRicky(highlightId);
}

/* ---- search ----------------------------------------------------------- */
// Search covers the whole feed, not just what's scrolled into view, so the
// first query pages in every remaining chunk once.
let allChunksLoaded = false;
async function loadAllChunks() {
  while (state.nextChunk >= 0) await loadNextChunk();
  allChunksLoaded = true;
}

// Candidate set: everything loaded, plus saved and endorsed cards that may not
// be in the loaded chunks, de-duped by id (the live loaded copy wins so sort
// keys are current). "Not interested" cards stay out.
function searchPool() {
  const byId = new Map();
  for (const c of state.saved.values()) if (!state.hidden.has(c.id)) byId.set(c.id, c);
  for (const c of state.ricky) if (!state.hidden.has(c.id)) byId.set(c.id, c);
  for (const c of state.loaded) if (!state.hidden.has(c.id)) byId.set(c.id, c);
  return [...byId.values()];
}

function matchesQuery(card, tokens) {
  // include the source and its display label so a query like "reddit" or
  // "pubmed" works as a source filter, matching what the card shows.
  const hay = ((card.title || '') + ' ' + (card.blurb || '') + ' ' +
    (card.blurb_long || '') + ' ' + (card.venue || '') + ' ' +
    (card.lane || '') + ' ' + (card.source || '') + ' ' +
    (SOURCE_LABEL[card.source] || '')).toLowerCase();
  return tokens.every((t) => hay.includes(t));   // all words must appear
}

function renderSearch(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  els.feed.innerHTML = '';
  els.tail.textContent = '';
  const results = searchPool()
    .filter((c) => matchesQuery(c, tokens))
    .sort((a, b) => (b._order || 0) - (a._order || 0));   // newest first
  if (!results.length) {
    els.feed.innerHTML =
      '<div class="empty">no matches for “' + query + '”.<br>' +
      'try a different word.</div>';
    return;
  }
  for (const card of results) renderCard(card);
}

let searchTimer = null;
function onSearchInput() {
  const q = els.search.value.trim();
  clearTimeout(searchTimer);
  if (!q) { exitSearch(); return; }
  searchTimer = setTimeout(async () => {
    state.searching = true;
    if (!allChunksLoaded) await loadAllChunks();
    const cur = els.search.value.trim();
    if (!cur) { exitSearch(); return; }   // box cleared while chunks loaded
    window.scrollTo({ top: 0 });
    renderSearch(cur);
    if (cur.length >= 3) tryEgg('thumbs', 'search');
  }, 160);
}

// leave search mode and restore the current lane's normal view.
function exitSearch() {
  if (!state.searching) return;
  state.searching = false;
  els.feed.innerHTML = '';
  state.session.clear();
  state.pos = 0;
  state.done = false;
  window.scrollTo({ top: 0 });
  if (state.lane === RICKY_LANE) { renderRicky(); return; }
  if (state.lane === 'saved') { renderSaved(); return; }
  rebuildFresh();
  fill();
}

/* ---- infinite scroll -------------------------------------------------- */
function nearBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 900;
}

// Trim the oldest cards off the top once the feed grows past MAX_LIVE. Two
// rules keep it jump-free: never trim below PRUNE_TO cards, and never trim a
// card that isn't safely above the viewport — otherwise removing content the
// reader can see (or that sits below them) would shift the page and can't be
// fully compensated (you can't scroll above 0). We remove only far-above cards,
// then scroll by the exact height removed so the first survivor stays put. (The
// scroll container has overflow-anchor:none so the browser doesn't also shift.)
const PRUNE_MARGIN = 1500;             // keep ~1.5 screens of scroll-back above
function pruneTop() {
  if (state.lane === 'saved' || state.lane === RICKY_LANE || state.searching) return;
  const feed = els.feed;
  const over = feed.childElementCount - PRUNE_TO;
  if (feed.childElementCount <= MAX_LIVE || over <= 0) return;
  // count how many leading cards are fully above the viewport (with margin),
  // capped so at least PRUNE_TO cards remain.
  let remove = 0;
  for (let i = 0; i < over; i++) {
    if (feed.children[i].getBoundingClientRect().bottom > -PRUNE_MARGIN) break;
    remove++;
  }
  if (!remove) return;
  const anchor = feed.children[remove];      // first card that will survive
  const before = anchor.getBoundingClientRect().top;
  for (let i = 0; i < remove; i++) feed.firstElementChild.remove();
  const delta = anchor.getBoundingClientRect().top - before;   // height removed
  if (delta) window.scrollBy(0, delta);
}

// render until the page is tall enough to scroll (or the lane is empty).
async function fill() {
  if (state.lane === 'saved' || state.lane === RICKY_LANE) return;   // not infinite feeds
  if (state.searching) return;                                       // search owns the feed
  let guard = 0;
  do {
    await renderNext(PAGE);
    guard += 1;
  } while (nearBottom() && !state.done && guard < 60);
}

let lastCheck = 0;
function onScroll() {
  const now = Date.now();
  if (now - lastCheck < 120) return;   // simple time throttle (no rAF dependency)
  lastCheck = now;
  if (nearBottom() && !state.busy) fill();
  maybeFireRickyOnScroll();
  eggScroll(now, window.scrollY);
}

/* ---- Ricky pop-up ----------------------------------------------------- */
// Build the list of picks this device is still owed a pop-up for: unseen and
// still fresh. Anything unseen but stale is retired quietly so old news can't
// resurface him.
function buildRickyQueue() {
  const now = Date.now();
  const queue = [];
  const chrono = state.ricky.slice().sort((a, b) => rickyTime(a) - rickyTime(b));
  for (const card of chrono) {
    if (state.rickyPopped.has(card.id)) continue;
    if (now - rickyTime(card) <= RICKY_POP_MAX_AGE_MS) queue.push(card);
    else markRickyPopped(card.id);
  }
  state.rickyQueue = queue;
}

let rickyEl = null;
function buildRickyPop() {
  if (rickyEl) return rickyEl;
  const pop = document.createElement('div');
  pop.className = 'ricky-pop';
  pop.innerHTML =
    '<div class="ricky-scrim"></div>' +
    '<img class="ricky-img" alt="Ricky" draggable="false">' +
    '<div class="ricky-bubble" role="alertdialog" aria-label="Ricky">' +
      '<p class="ricky-say"></p>' +
      '<div class="ricky-btns">' +
        '<button type="button" class="ricky-read"></button>' +
        '<button type="button" class="ricky-dismiss"></button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(pop);
  rickyEl = pop;
  return pop;
}

// One shell, four Rickys. opts: {kind, say, top, bottom, onAct, onGo, onDone}.
// top/bottom are [label, comebacks] button tuples. `onAct` runs once on the
// first interaction (any button or the scrim); `onGo` makes the top button
// navigate (the choice pop's "Read it") instead of playing the comeback game.
// Everything else dismisses — with a RICKY_RETORT_P chance the bubble swaps
// to a comeback tied to the tapped button and he lingers RICKY_RETORT_MS.
let retortTimer = null;
function showRickyPop(opts) {
  const cast = RICKY_CAST[opts.kind];
  state.rickyBusy = true;
  const pop = buildRickyPop();
  pop.classList.remove('leaving', 'retort');
  pop.style.setProperty('--rk-w', cast.w);
  pop.style.setProperty('--rk-ratio', cast.ratio);
  const img = pop.querySelector('.ricky-img');
  if (img.getAttribute('src') !== cast.img) img.src = cast.img;
  const say = pop.querySelector('.ricky-say');
  say.textContent = opts.say;
  const topBtn = pop.querySelector('.ricky-read');
  const botBtn = pop.querySelector('.ricky-dismiss');
  const scrim = pop.querySelector('.ricky-scrim');
  topBtn.textContent = opts.top[0];
  botBtn.textContent = opts.bottom[0];

  let acted = false;                     // one-shot; a pop can't double-fire
  const finish = (fade) => {
    hideRickyPop(fade);
    if (opts.onDone) opts.onDone();
  };
  const tap = (btn, go) => {
    if (acted) return;
    acted = true;
    if (opts.onAct) opts.onAct();
    if (go) { finish(false); opts.onGo(); return; }
    if (btn[1] && Math.random() < RICKY_RETORT_P) {
      pop.classList.add('retort');
      say.textContent = btn[1][(Math.random() * btn[1].length) | 0];
      retortTimer = setTimeout(() => finish(true), RICKY_RETORT_MS);
      return;
    }
    finish(true);
  };
  topBtn.onclick = () => tap(opts.top, !!opts.onGo);
  botBtn.onclick = () => tap(opts.bottom, false);
  scrim.onclick = () => {                // tap-away: quiet exit, even mid-retort
    if (!acted) { acted = true; if (opts.onAct) opts.onAct(); }
    finish(true);
  };

  requestAnimationFrame(() => pop.classList.add('show'));
}

function hideRickyPop(fade) {
  const pop = rickyEl;
  if (!pop) return;
  clearTimeout(retortTimer);
  state.rickyBusy = false;
  if (fade) {
    pop.classList.add('leaving');
    setTimeout(() => pop.classList.remove('show', 'leaving'), 1150);
  } else {
    pop.classList.remove('show', 'leaving');
  }
}

// the endorsement pop — "a new pick landed". Read it → jump to the section.
function showChoicePop(card) {
  if (!card) return;
  const pair = RICKY_CAST.choice.pairs[0];
  egg.lastChoiceAt = Date.now();         // the trio yields to the real news
  showRickyPop({
    kind: 'choice',
    say: rickyPickSay('choice'),
    top: pair[0],
    bottom: pair[1],
    onAct: () => markRickyPopped(card.id),
    onGo: () => openRickyChoice(card.id),
    onDone: () => { egg.lastChoiceAt = Date.now(); scheduleNextRicky(); },
  });
}

function scheduleNextRicky() {
  if (!state.rickyQueue.length) return;
  state.rickyArmed = false;
  setTimeout(armRicky, 1400);
}

let rickyTimer = null;
function armRicky() {
  if (state.rickyArmed || state.rickyBusy || !state.rickyQueue.length) return;
  state.rickyArmed = true;
  clearTimeout(rickyTimer);
  rickyTimer = setTimeout(fireRicky, 6000);   // fallback if they don't scroll
}
function maybeFireRickyOnScroll() {
  if (state.rickyArmed && !state.rickyBusy && window.scrollY > 320) fireRicky();
}
function fireRicky() {
  if (state.rickyBusy || !state.rickyQueue.length) return;
  clearTimeout(rickyTimer);
  state.rickyArmed = false;
  showChoicePop(state.rickyQueue.shift());
}

/* ---- Ricky easter-egg trio (Hi / Think / ThumbsUp) --------------------- */
// The other three Rickys react to how the app is used: Hi greets a genuine
// return, Think calls out engagement-free doomscrolling, ThumbsUp hands out
// backhanded praise for real reading. Rarity is the whole point — governors,
// in order: never on top of another Ricky, never within EGG_CHOICE_QUIET_MS
// of the choice pop (real news outranks the gag), at most one trio pop per
// session and EGG_DAY_MAX per day, and each character gets exactly one EGG_P
// roll per session, spent at its first qualifying moment. Miss the roll and
// that character stays home until next visit. All knobs live here.
const EGG_P = 0.15;               // per-character chance once its trigger hits
const EGG_DAY_MAX = 2;            // trio pops per calendar day, all sessions
const EGG_WARMUP_MS = 8000;       // trio silence at session start (hi exempt)
const EGG_HI_DELAY_MS = 4500;     // the greeting beat after open
const EGG_HI_GAP_MS = 4 * 36e5;   // away this long = a return worth greeting
const EGG_CHOICE_QUIET_MS = 30000;
const EGG_FLING_PX = 2600;        // think: this much scroll…
const EGG_FLING_MS = 15000;       //   …inside this window…
const EGG_FLING_MIN_CARDS = 8;    //   …past at least this many cards
const EGG_VOLUME_CARDS = 14;      // think: cards seen with zero engagement
const EGG_DWELL_MS = 45000;       // thumbs: still mid-feed this long = reading
const EGG_AWAY_MS = 60000;        // thumbs: gone to the source at least this long
const EGG_STREAK_DAYS = 3;        // thumbs: visit-days in a row worth noting
const RICKY_RETORT_P = 0.15;      // chance a button tap earns a comeback
const RICKY_RETORT_MS = 5000;     // how long he lingers on it
const EGG_HIST = { choice: 2, hi: 8, think: 8, thumbs: 8 };  // no-repeat depth

function eggLoad() {
  try { return JSON.parse(localStorage.getItem('rickyEgg') || '{}') || {}; }
  catch { return {}; }
}
function eggSave() {
  try { localStorage.setItem('rickyEgg', JSON.stringify(egg.data)); } catch { /* private mode */ }
}

const egg = {
  data: eggLoad(),   // {lastVisit, day, dayPops, streakDay, streakLen, used:{kind:[ids]}}
  bootAt: Date.now(),
  fired: false,      // one trio pop per session, period
  rolled: { hi: false, think: false, thumbs: false },
  opens: 0,          // outbound reads this session
  saves: 0,          // saves this session
  trail: [],         // recent [t, scrollY] samples for the fling detector
  away: null,        // {at, ricky, saved} — an outbound read we may reward on return
  hiddenAt: 0,
  dwellTimer: null,
  lastChoiceAt: 0,
  newDay: false,
  streak: 1,
};

// candidate lines for a pop: thumbs lines must match the reward that fired;
// hi/think lines are open unless tagged to a context (late/morning/newday).
function rickySayPool(kind, ev) {
  const says = RICKY_CAST[kind].says;
  if (kind === 'thumbs') return says.filter((s) => s[2] === ev);
  const h = new Date().getHours();
  const ok = { late: h >= 23 || h < 5, morning: h >= 5 && h < 9, newday: egg.newDay };
  return says.filter((s) => !s[2] || ok[s[2]]);
}

// pick a line, dodging the last EGG_HIST[kind] used (persisted); when a pool
// is smaller than the window (thumbs event subsets), repeats are allowed.
function rickyPickSay(kind, ev) {
  const pool = rickySayPool(kind, ev);
  if (!pool.length) return null;
  const used = (egg.data.used = egg.data.used || {});
  const seen = used[kind] || [];
  let fresh = pool.filter((s) => !seen.includes(s[0]));
  if (!fresh.length) fresh = pool;
  const s = fresh[(Math.random() * fresh.length) | 0];
  used[kind] = seen.concat(s[0]).slice(-EGG_HIST[kind]);
  eggSave();
  return s[1];
}

function eggDayRoll(now) {
  const d = egg.data;
  const today = new Date(now).toDateString();
  const yday = new Date(now - 864e5).toDateString();
  egg.newDay = d.day !== today;
  if (egg.newDay) { d.day = today; d.dayPops = 0; }
  if (d.streakDay !== today) {
    d.streakLen = d.streakDay === yday ? (d.streakLen || 0) + 1 : 1;
    d.streakDay = today;
  }
  egg.streak = d.streakLen || 1;
}

function eggCan(kind) {
  if (egg.fired || state.rickyBusy) return false;
  if (state.rickyQueue.length) return false;   // the choice pop owns the moment
  if (Date.now() - egg.lastChoiceAt < EGG_CHOICE_QUIET_MS) return false;
  if ((egg.data.dayPops || 0) >= EGG_DAY_MAX) return false;
  if (kind !== 'hi' && Date.now() - egg.bootAt < EGG_WARMUP_MS) return false;
  if (document.visibilityState !== 'visible') return false;
  if (lbEl && lbEl.classList.contains('show')) return false;
  return true;
}

function tryEgg(kind, ev) {
  if (!eggCan(kind) || egg.rolled[kind]) return;
  egg.rolled[kind] = true;                 // one roll per character per session
  if (Math.random() >= EGG_P) return;      // he stays home
  const say = rickyPickSay(kind, ev);
  if (!say) return;
  egg.fired = true;
  egg.data.dayPops = (egg.data.dayPops || 0) + 1;
  eggSave();
  const pairs = RICKY_CAST[kind].pairs;
  const pair = pairs[(Math.random() * pairs.length) | 0];
  showRickyPop({ kind, say, top: pair[0], bottom: pair[1] });
}

// scroll feed for the trio: the fling/volume detectors (think) and the
// stillness-means-reading dwell timer (thumbs). Called from onScroll.
function eggScroll(now, y) {
  egg.trail.push([now, y]);
  while (egg.trail.length > 1 && now - egg.trail[0][0] > EGG_FLING_MS) egg.trail.shift();
  if (!egg.opens && !egg.saves && !state.searching && state.lane === 'all') {
    if (y - egg.trail[0][1] >= EGG_FLING_PX && state.session.size >= EGG_FLING_MIN_CARDS) {
      tryEgg('think');
    } else if (state.session.size >= EGG_VOLUME_CARDS && y > 1500) {
      tryEgg('think');
    }
  }
  clearTimeout(egg.dwellTimer);
  if (y > 600) {
    egg.dwellTimer = setTimeout(() => {
      if (document.visibilityState === 'visible') tryEgg('thumbs', 'dwell');
    }, EGG_DWELL_MS);
  }
}

// outbound click: they're leaving to read — remember it so the *return* can
// be rewarded (popping now would play to an empty room).
function eggOutbound(card) {
  egg.opens += 1;
  egg.away = {
    at: Date.now(),
    ricky: !!card.ricky,
    saved: state.saved.has(card.id),
  };
}

function eggVisibility() {
  if (document.visibilityState !== 'visible') {
    egg.hiddenAt = Date.now();
    return;
  }
  const now = Date.now();
  const gone = egg.hiddenAt ? now - egg.hiddenAt : 0;
  if (gone >= EGG_HI_GAP_MS) {
    // long enough away that this re-open is a fresh visit: new session budget,
    // new greeting beat. (An installed PWA resumes instead of re-booting, so
    // boot alone would only ever greet once per eviction.)
    egg.fired = false;
    egg.rolled = { hi: false, think: false, thumbs: false };
    egg.bootAt = now;
    egg.opens = 0;
    egg.saves = 0;
    egg.trail = [];
    egg.away = null;
    egg.data.lastVisit = now;
    eggDayRoll(now);
    eggSave();
    setTimeout(() => tryEgg('hi'), EGG_HI_DELAY_MS);
    return;
  }
  // back from an outbound link they sat with for a while — that's a real read.
  if (egg.away && now - egg.away.at >= EGG_AWAY_MS) {
    const a = egg.away;
    const ev = a.ricky ? 'choiceRead'
      : a.saved ? 'savedReturn'
      : egg.streak >= EGG_STREAK_DAYS ? 'streak'
      : egg.opens >= 3 ? 'reads3' : 'return';
    setTimeout(() => tryEgg('thumbs', ev), 1200);
  }
  egg.away = null;
}

function eggInit() {
  const now = Date.now();
  const prev = egg.data.lastVisit || 0;
  egg.data.lastVisit = now;
  eggDayRoll(now);
  eggSave();
  if (prev && now - prev >= EGG_HI_GAP_MS) {
    setTimeout(() => tryEgg('hi'), EGG_HI_DELAY_MS);
  }
  document.addEventListener('visibilitychange', eggVisibility);
  // warm the trio images off the critical path so a pop never waits on a fetch
  setTimeout(() => {
    for (const k of ['hi', 'think', 'thumbs']) {
      const i = new Image();
      i.src = RICKY_CAST[k].img;
    }
  }, 1500);
}

/* ---- image lightbox --------------------------------------------------- */
// Full-screen, in-app image viewer. Tap the image to toggle zoom (pan by
// scrolling when zoomed); tap outside, the ✕, or Escape to close. Never a new tab.
let lbEl = null;
function buildLightbox() {
  if (lbEl) return lbEl;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML =
    '<div class="lightbox-scrim"></div>' +
    '<div class="lightbox-stage"><img class="lightbox-img" alt="" draggable="false"></div>' +
    '<button type="button" class="lightbox-close" aria-label="close">✕</button>';
  const stage = lb.querySelector('.lightbox-stage');
  const img = lb.querySelector('.lightbox-img');
  lb.querySelector('.lightbox-scrim').addEventListener('click', hideLightbox);
  lb.querySelector('.lightbox-close').addEventListener('click', hideLightbox);
  stage.addEventListener('click', hideLightbox);   // tapping the empty area closes
  img.addEventListener('click', (e) => {
    e.stopPropagation();                           // ...but tapping the image zooms
    const z = img.classList.toggle('zoomed');
    stage.classList.toggle('zoomed', z);
    if (!z) stage.scrollTo(0, 0);
  });
  document.body.appendChild(lb);
  lbEl = lb;
  return lb;
}
function openLightbox(src, alt) {
  const lb = buildLightbox();
  const stage = lb.querySelector('.lightbox-stage');
  const img = lb.querySelector('.lightbox-img');
  img.classList.remove('zoomed');
  stage.classList.remove('zoomed');
  img.alt = alt || '';
  img.src = src;
  stage.scrollTo(0, 0);
  lb.classList.add('show');
  document.addEventListener('keydown', lbKey);
}
function hideLightbox() {
  if (!lbEl) return;
  lbEl.classList.remove('show');
  document.removeEventListener('keydown', lbKey);
}
function lbKey(e) { if (e.key === 'Escape') hideLightbox(); }

/* ---- boot ------------------------------------------------------------- */
async function boot() {
  els.tail.innerHTML = '<span class="spinner"></span>';
  try {
    await Promise.all([
      loadShown(), loadSaved(), loadHidden(), loadVisited(), loadManifest(),
      loadRickyPopped(), loadRickyIndex(),
    ]);
  } catch (e) {
    console.error(e);
    els.tail.textContent = '';
    els.feed.innerHTML =
      '<div class="empty">couldn’t load the feed.<br>if you’re offline, ' +
      'open it once online first so it can cache.</div>';
    return;
  }
  buildLanes();
  updateStatus();
  // Page in every chunk before the first fill so the whole latest-harvest batch
  // is in the pool from card #1 — the "new" cards are split across chunks, so a
  // single-chunk load would hide most of them behind lazy paging and starve the
  // new-first mix. The feed is small (a few hundred cards); search already does
  // this on its first query.
  await loadAllChunks();
  await fill();

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  if (els.search) {
    els.search.addEventListener('input', onSearchInput);
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { els.search.value = ''; exitSearch(); els.search.blur(); }
    });
  }

  // arm the easter eggs once the feed is up — the choice pop first (it owns
  // the moment when a pick is pending), then the trio's behavior engine.
  buildRickyQueue();
  armRicky();
  eggInit();
}

if ('serviceWorker' in navigator) {
  // An installed PWA resumes its session instead of re-navigating, so without a
  // nudge it can sit on an old worker forever. Reload once when a *replacement*
  // worker takes control so the fresh shell actually loads. hadController guards
  // the first-install claim (null -> worker), which isn't a replacement.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update();                                    // check for a new build now
        document.addEventListener('visibilitychange', () => {
          // reopening the installed app fires this — recheck for a new worker.
          if (document.visibilityState === 'visible') reg.update();
        });
      })
      .catch(() => {});
  });
}

boot();
