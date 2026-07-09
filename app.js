/* personal curated feed — endless scroll, no backend.
   fresh (never-shown, newest-first) interleaved with vault (resurfaced) at 3:1.
   what's been shown is tracked in IndexedDB so vault items come back after ~14d. */

'use strict';

const FEED_DIR = './data/feed';
const FRESH_PER_VAULT = 3;              // 3 fresh : 1 vault
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
    try { req = indexedDB.open('feed', 3); }
    catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('shown')) d.createObjectStore('shown');
      if (!d.objectStoreNames.contains('saved')) d.createObjectStore('saved');
      if (!d.objectStoreNames.contains('ricky')) d.createObjectStore('ricky');
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
    (c) => laneMatch(c) && !state.shown.has(c.id) && !state.session.has(c.id));
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
    (c) => laneMatch(c) && state.shown.has(c.id) && !state.session.has(c.id));
  if (!pool.length) return null;
  const now = Date.now();
  let eligible = pool.filter((c) => now - state.shown.get(c.id) > VAULT_AGE_MS);
  if (!eligible.length) eligible = pool;   // nothing "old enough" yet — still fine to resurface
  return eligible[(Math.random() * eligible.length) | 0];
}

/* ---- rendering -------------------------------------------------------- */
function renderCard(card, opts = {}) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = card.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.setProperty('--lane', LANE_COLORS[card.lane] || 'var(--text-faint)');
  if (card.ricky) a.classList.add('ricky');
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
  if (card.preprint) {
    const pre = document.createElement('span');
    pre.className = 'preprint-tag';
    pre.textContent = 'preprint';
    meta.appendChild(pre);
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
    e.preventDefault();          // card is an <a>; don't follow the link
    e.stopPropagation();
    toggleSave(card, save, a);
  });
  meta.appendChild(save);

  const h = document.createElement('h2');
  h.className = 'card-title';
  h.textContent = card.title;

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
    img.src = card.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';   // some hosts 403 hotlinks with a referrer
    // drop the figure (and its spacing) if the image is missing/blocked
    img.addEventListener('error', () => img.remove());
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
  const vaultSlot = state.pos % (FRESH_PER_VAULT + 1) === FRESH_PER_VAULT;
  let card = null, isVault = false;

  if (vaultSlot) {
    card = pickVault(); isVault = !!card;
    if (!card) card = pickFresh();          // no vault to resurface yet -> serve fresh
  } else {
    card = pickFresh();
    if (!card) { card = pickVault(); isVault = !!card; }
  }

  if (!card) {
    // fresh and vault both empty for this lane. loop the pile to stay endless.
    if (!state.loaded.some(laneMatch)) return false;
    resetCycle();
    card = pickVault(); isVault = !!card;
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
  const total = state.manifest.total || 0;
  els.status.textContent = total ? total.toLocaleString() + ' cards' : '';
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

/* ---- boot ------------------------------------------------------------- */
async function boot() {
  els.tail.innerHTML = '<span class="spinner"></span>';
  try {
    await Promise.all([
      loadShown(), loadSaved(), loadManifest(),
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
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

boot();
