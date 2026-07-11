/* personal curated feed — endless scroll, no backend.
   fresh (never-shown, newest-first) is the feed; resurfaced "vault" cards are
   rare (~5%) and only sprinkle in until fresh runs out, then fill the tail.
   what's been shown is tracked in IndexedDB so vault items come back after ~14d. */

'use strict';

const FEED_DIR = './data/feed';
const VAULT_RATE = 0.05;               // ~5% of cards are resurfaced ("vault")
const VAULT_AGE_MS = 14 * 864e5;        // resurface after ~14 days
const PAGE = 8;                         // cards rendered per scroll step

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
  clinicaltrials: 'trial',
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

/* ---- Ricky ------------------------------------------------------------- */
// "Ricky's choice" is a permanent section, like saved. Endorsed picks live
// there forever and also appear in the regular feed carrying the amber tag.
// The pop-up is decoupled: it fires once per pick that this device hasn't
// seen, and only while the pick is still fresh — so old news never re-summons
// him. Everything reads from ./data/feed/ricky.json.
const RICKY_LANE = "Ricky's choice";
const RICKY_IMG = './icons/ricky.png';
const RICKY_INDEX = `${FEED_DIR}/ricky.json`;
const RICKY_POP_MAX_AGE_MS = 7 * 864e5;   // a pick only pops within ~7 days of endorsement
const RICKY_SAY =
  'Ricky says "I bring important information. Read it. ' +
  'Maybe one day you\'ll be as smart as me."';
// small up-triangle, echoing his raised finger
const RICKY_MARK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 9H1z"/></svg>';

const els = {
  feed: document.getElementById('feed'),
  lanes: document.getElementById('lanes'),
  status: document.getElementById('status'),
  tail: document.getElementById('tail'),
  sentinel: document.getElementById('sentinel'),
};

const state = {
  manifest: null,
  loaded: [],            // all cards fetched so far, each tagged with _order
  nextChunk: -1,         // index into manifest.chunks, walked newest -> oldest
  shown: new Map(),      // id -> lastShown ms (mirror of IndexedDB)
  saved: new Map(),      // id -> card (mirror of IndexedDB 'saved' store)
  hidden: new Map(),     // id -> hiddenAt ms — "not interested", never resurfaced
  session: new Set(),    // ids rendered in this scroll session
  fresh: [],             // never-shown cards for the current lane, newest-first
  lane: 'all',
  pos: 0,                // interleave counter
  busy: false,
  done: false,
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
    try { req = indexedDB.open('feed', 4); }
    catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('shown')) d.createObjectStore('shown');
      if (!d.objectStoreNames.contains('saved')) d.createObjectStore('saved');
      if (!d.objectStoreNames.contains('ricky')) d.createObjectStore('ricky');
      if (!d.objectStoreNames.contains('hidden')) d.createObjectStore('hidden');
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
async function hideCard(id) {
  const now = Date.now();
  state.hidden.set(id, now);
  const d = await db();
  if (!d) return;
  try { d.transaction('hidden', 'readwrite').objectStore('hidden').put(now, id); }
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

function rebuildFresh() {
  // Not strict newest-first: a weighted shuffle that still leans newer, so the
  // feed feels less deterministic without throwing recency out entirely. Each
  // card gets key = random^(1/weight); newer cards get more weight and trend
  // toward the front, but any card can surface early.
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
    const weight = (0.35 + 1.65 * recency)          // newer -> higher weight
                 * (SOURCE_WEIGHT[card.source] || 1);
    card._shuf = Math.pow(Math.random() || 1e-9, 1 / weight);
  }
  pool.sort((a, b) => b._shuf - a._shuf);
  state.fresh = pool;
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
    cards.forEach((card, i) => { card._order = idx * 1e5 + i; state.loaded.push(card); });
    rebuildFresh();
    return true;
  } catch (e) {
    console.warn('chunk load failed', name, e);
    return false;
  }
}

/* ---- picking ---------------------------------------------------------- */
function pickFresh() {
  return state.fresh.length ? state.fresh.shift() : null;
}

function pickVault() {
  // vault = genuinely resurfaced items: shown before, not yet this session.
  // never-shown cards are fresh, not vault, so they're excluded here.
  const pool = state.loaded.filter(
    (c) => laneMatch(c) && state.shown.has(c.id) &&
           !state.session.has(c.id) && !state.hidden.has(c.id));
  if (!pool.length) return null;
  const now = Date.now();
  let eligible = pool.filter((c) => now - state.shown.get(c.id) > VAULT_AGE_MS);
  if (!eligible.length) eligible = pool;   // nothing "old enough" yet — still fine to resurface
  return eligible[(Math.random() * eligible.length) | 0];
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
    meta.appendChild(hide);
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
  meta.appendChild(save);

  const h = document.createElement('h2');
  h.className = 'card-title';
  const titleLink = document.createElement('a');
  titleLink.className = 'card-title-link';
  titleLink.href = card.url;
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = card.title;
  h.appendChild(titleLink);

  const p = document.createElement('p');
  p.className = 'card-blurb';
  // in the Ricky's choice section, endorsed cards show the longer write-up.
  p.textContent = (opts.expanded && card.blurb_long) ? card.blurb_long : card.blurb;

  const src = document.createElement('div');
  src.className = 'card-source';
  const age = relAge(card);
  const origin = card.venue || SOURCE_LABEL[card.source] || card.source;
  src.textContent = origin + (age ? ' · ' + age : '');

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
  }
}

function dismissCard(card, cardEl) {
  // "Not interested" — record it so it never resurfaces, then collapse it out.
  hideCard(card.id);
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
  // whole pile shown this session — loop back through it (vault-only from here),
  // silently: no divider text.
  state.session.clear();
  rebuildFresh();   // now empty (everything's been shown), so the loop serves vault
}

async function place() {
  let card = null;

  // New content leads. While there are fresh (never-shown) cards for this lane
  // the feed is essentially all-new; only a rare ~5% roll sprinkles in a
  // resurfaced item. Once fresh runs out, vault fills the tail so scroll stays
  // endless. (Returning users with nothing new therefore see resurfaced cards,
  // which is unavoidable — but never the 1-in-4 firehose it used to be.)
  if (state.fresh.length) {
    if (Math.random() < VAULT_RATE) card = pickVault();   // occasional resurface
    if (!card) card = pickFresh();
  } else {
    card = pickVault();                                    // fresh exhausted
    if (!card) card = pickFresh();
  }

  if (!card) {
    // fresh and vault both empty for this lane. loop the pile to stay endless.
    if (!state.loaded.some(laneMatch)) return false;
    resetCycle();
    card = pickVault();
    if (!card) card = pickFresh();
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
    if (!state.fresh.length && state.nextChunk >= 0) {
      await loadNextChunk();
      continue;
    }
    const ok = await place();
    if (ok) { placed += 1; continue; }
    // nothing to place — try pulling an older chunk, else stop.
    const gained = await loadNextChunk();
    if (!gained) break;
  }

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
  if (lane === state.lane) return;
  state.lane = lane;
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
  window.scrollTo({ top: 0 });
  renderRicky(highlightId);
}

/* ---- infinite scroll -------------------------------------------------- */
function nearBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 900;
}

// render until the page is tall enough to scroll (or the lane is empty).
async function fill() {
  if (state.lane === 'saved' || state.lane === RICKY_LANE) return;   // not infinite feeds
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
    '<img class="ricky-img" alt="Ricky" src="' + RICKY_IMG + '" draggable="false">' +
    '<div class="ricky-bubble" role="alertdialog" aria-label="Ricky">' +
      '<p class="ricky-say"></p>' +
      '<div class="ricky-btns">' +
        '<button type="button" class="ricky-read">Read it</button>' +
        '<button type="button" class="ricky-dismiss">Fuck off Ricky</button>' +
      '</div>' +
    '</div>';
  pop.querySelector('.ricky-say').textContent = RICKY_SAY;
  document.body.appendChild(pop);
  rickyEl = pop;
  return pop;
}

function showRickyPop(card) {
  if (!card) return;
  state.rickyBusy = true;
  const pop = buildRickyPop();
  pop.classList.remove('leaving');
  const read = pop.querySelector('.ricky-read');
  const dismiss = pop.querySelector('.ricky-dismiss');
  const scrim = pop.querySelector('.ricky-scrim');

  const done = (fn) => {                 // one-shot; a pick can't double-fire
    read.onclick = dismiss.onclick = scrim.onclick = null;
    markRickyPopped(card.id);
    fn();
  };
  read.onclick = () => done(() => {
    hideRickyPop(false);
    openRickyChoice(card.id);
    scheduleNextRicky();
  });
  const leave = () => done(() => { hideRickyPop(true); scheduleNextRicky(); });
  dismiss.onclick = leave;
  scrim.onclick = leave;

  requestAnimationFrame(() => pop.classList.add('show'));
}

function hideRickyPop(fade) {
  const pop = rickyEl;
  if (!pop) return;
  state.rickyBusy = false;
  if (fade) {
    pop.classList.add('leaving');
    setTimeout(() => pop.classList.remove('show', 'leaving'), 1150);
  } else {
    pop.classList.remove('show', 'leaving');
  }
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
  showRickyPop(state.rickyQueue.shift());
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
      loadShown(), loadSaved(), loadHidden(), loadManifest(),
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
  await loadNextChunk();
  await fill();

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  // arm the easter egg once the feed is up
  buildRickyQueue();
  armRicky();
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
