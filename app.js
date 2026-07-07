/* science feed — v0.1 prototype
   feed of one: no accounts, no backend. state lives in localStorage. */

const LANES = {
  orgchem:     "org chem",
  biochem:     "biochem",
  radiopharma: "radiopharma",
  startups:    "startups",
  biotechnews: "biotech news",
  wildcard:    "wildcard",
};

const STORE = {
  saved:   "sciencefeed.saved",
  read:    "sciencefeed.read",
  weights: "sciencefeed.weights",
  muted:   "sciencefeed.muted",
};

// radiopharma weighted up on purpose — it's his field.
const DEFAULT_WEIGHTS = { radiopharma: 1.35 };

const state = {
  cards: [],
  ordered: [],
  rendered: 0,
  batch: 4,
  saved: loadSet(STORE.saved),
  read: loadSet(STORE.read),
  muted: loadSet(STORE.muted),
  weights: loadObj(STORE.weights, {}),
  sheetCardId: null,
  savedFilter: "all",
};

/* ---------- storage helpers ---------- */
function loadSet(k){ try { return new Set(JSON.parse(localStorage.getItem(k) || "[]")); } catch { return new Set(); } }
function saveSet(k, set){ localStorage.setItem(k, JSON.stringify([...set])); }
function loadObj(k, d){ try { return Object.assign({}, d, JSON.parse(localStorage.getItem(k) || "{}")); } catch { return { ...d }; } }
function saveObj(k, o){ localStorage.setItem(k, JSON.stringify(o)); }

function laneWeight(lane){
  if (lane in state.weights) return state.weights[lane];
  return DEFAULT_WEIGHTS[lane] ?? 1.0;
}

/* ---------- boot ---------- */
init();

async function init(){
  try {
    const res = await fetch("feed.json", { cache: "no-cache" });
    const data = await res.json();
    state.cards = data.cards;
    document.getElementById("datestamp").textContent = fmtStamp(data.generated);
  } catch (e) {
    document.getElementById("feed").innerHTML =
      '<div class="caught-up"><span>couldn\'t load the feed</span><small>check feed.json</small></div>';
    return;
  }

  rankFeed();
  wireTabs();
  wireSheet();
  updateSavedCount();
  startLazyFeed();
  registerSW();
}

/* ---------- ranking: floor, not funnel ---------- */
function rankFeed(){
  const visible = state.cards.filter(c => !state.muted.has(c.source));

  const scored = visible.map(c => ({ c, s: scoreCard(c) }))
                        .sort((a, b) => b.s - a.s)
                        .map(x => x.c);

  // de-cluster: avoid the same lane sitting back-to-back
  for (let i = 1; i < scored.length; i++){
    if (scored[i].lane === scored[i - 1].lane){
      const j = scored.findIndex((c, k) => k > i && c.lane !== scored[i - 1].lane);
      if (j > -1){ const [m] = scored.splice(j, 1); scored.splice(i, 0, m); }
    }
  }

  // protected wildcard slot: guarantee serendipity near the top
  const wIdx = scored.findIndex(c => c.lane === "wildcard");
  if (wIdx > 5){ const [w] = scored.splice(wIdx, 1); scored.splice(4, 0, w); }

  state.ordered = scored;
}

function scoreCard(c){
  let s = laneWeight(c.lane);
  if (c.date){
    const days = (Date.now() - new Date(c.date).getTime()) / 86400000;
    s += Math.max(0, 1 - days / 120);        // freshness, decays over ~4 months
  } else {
    s += 0.5;                                 // undated (trials/compounds) sit mid
  }
  s += 0.12 * savedLaneCount(c.lane);          // engagement nudge
  return s;
}

function savedLaneCount(lane){
  let n = 0;
  for (const id of state.saved){
    const card = state.cards.find(c => c.id === id);
    if (card && card.lane === lane) n++;
  }
  return n;
}

/* ---------- lazy feed rendering ---------- */
function startLazyFeed(){
  const feed = document.getElementById("feed");
  feed.innerHTML = "";
  state.rendered = 0;
  document.getElementById("caught-up").hidden = true;

  renderBatch();

  const sentinel = document.getElementById("sentinel");
  const io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting){
      if (state.rendered >= state.ordered.length){
        io.disconnect();
        document.getElementById("caught-up").hidden = false;
      } else {
        renderBatch();
      }
    }
  }, { rootMargin: "300px" });
  io.observe(sentinel);
}

function renderBatch(){
  const feed = document.getElementById("feed");
  const end = Math.min(state.rendered + state.batch, state.ordered.length);
  for (let i = state.rendered; i < end; i++){
    feed.appendChild(renderCard(state.ordered[i]));
  }
  state.rendered = end;
}

/* ---------- card ---------- */
function renderCard(c){
  const tpl = document.createElement("template");
  const saved = state.saved.has(c.id);
  const prov = [c.source, c.provenanceNote || typeLabel(c.type), c.date ? relAge(c.date) : null]
                .filter(Boolean).join(" · ");

  tpl.innerHTML = `
    <article class="card lane-${c.lane}" data-id="${c.id}">
      <div class="card-head">
        <span class="badge">${LANES[c.lane]}</span>
        <span class="prov">${esc(prov)}</span>
      </div>
      <h2 class="title">${esc(c.title)}</h2>
      <p class="hook">${esc(c.hook)}</p>
      ${c.image && c.image.kind === "molecule" ? molMarkup(c) : ""}
      <p class="shown">shown because: ${esc(c.shownBecause)}</p>
      <div class="actions">
        <button class="act save ${saved ? "saved" : ""}" data-act="save">
          ${bookmarkSVG()}<span>${saved ? "Saved" : "Save"}</span>
        </button>
        <button class="act" data-act="explain">Explain</button>
        ${c.url ? `<a class="act" href="${esc(c.url)}" target="_blank" rel="noopener">Source ↗</a>`
                : `<button class="act" data-act="nolink">Source</button>`}
        <button class="act more" data-act="more" aria-label="More options">···</button>
      </div>
      <div class="explain"><div class="explain-inner"><div class="explain-inner-pad">
        <p class="snippet">${esc(c.explain.snippet)}</p>
        <div class="beat"><span class="beat-label">the gist</span><p>${esc(c.explain.gist)}</p></div>
        <div class="beat"><span class="beat-label">why it's interesting</span><p>${esc(c.explain.interesting)}</p></div>
        <div class="beat catch"><span class="beat-label">the catch</span><p>${esc(c.explain.catch)}</p></div>
        <button class="deeper" data-act="deeper">Go deeper in chat →</button>
      </div></div></div>
    </article>`;

  const card = tpl.content.firstElementChild;
  card.addEventListener("click", (e) => onCardClick(e, c));

  if (c.image && c.image.kind === "molecule"){
    requestAnimationFrame(() => drawMolecule(card.querySelector("canvas"), c.image));
  }
  return card;
}

function molMarkup(c){
  return `<div class="mol">
    <canvas width="620" height="380" aria-label="structure of ${esc(c.image.formula)}"></canvas>
    <span class="mol-meta">${esc(c.image.formula)} · ${esc(c.image.mw)} g/mol</span>
  </div>`;
}

function drawMolecule(canvas, image){
  if (!canvas) return;
  if (!window.SmilesDrawer || !SmilesDrawer.Drawer){ molFallback(canvas, image); return; }
  try {
    const drawer = new SmilesDrawer.Drawer({
      width: canvas.width, height: canvas.height,
      padding: 24, bondThickness: 1.4, bondLength: 22,
      terminalCarbons: true, explicitHydrogens: false, compactDrawing: false,
    });
    SmilesDrawer.parse(image.smiles, (tree) => {
      drawer.draw(tree, canvas, "light", false);
    }, () => molFallback(canvas, image));
  } catch { molFallback(canvas, image); }
}

function molFallback(canvas, image){
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#5b6470";
  ctx.textAlign = "center";
  ctx.font = "600 34px -apple-system, sans-serif";
  ctx.fillText(image.formula, canvas.width / 2, canvas.height / 2 - 6);
  ctx.font = "18px -apple-system, sans-serif";
  ctx.fillText("structure preview unavailable offline", canvas.width / 2, canvas.height / 2 + 30);
}

/* ---------- card interactions ---------- */
function onCardClick(e, c){
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const card = e.currentTarget;

  if (act === "save")    return toggleSave(c, card);
  if (act === "explain") return toggleExplain(c, card, btn);
  if (act === "deeper")  return toast("In the full app this hands the paper to a chat. Not wired up in the prototype.");
  if (act === "nolink")  return toast("No external link for this item.");
  if (act === "more"){ state.sheetCardId = c.id; openSheet(); }
}

function toggleSave(c, card){
  const btn = card.querySelector(".save");
  if (state.saved.has(c.id)){
    state.saved.delete(c.id);
    btn.classList.remove("saved");
    btn.querySelector("span").textContent = "Save";
  } else {
    state.saved.add(c.id);
    btn.classList.add("saved");
    btn.querySelector("span").textContent = "Saved";
    toast("Saved. This also nudges your ranking.");
  }
  saveSet(STORE.saved, state.saved);
  updateSavedCount();
}

function toggleExplain(c, card, btn){
  const box = card.querySelector(".explain");
  const open = box.classList.toggle("open");
  btn.textContent = open ? "Hide" : "Explain";
  if (open && !state.read.has(c.id)){
    state.read.add(c.id);
    saveSet(STORE.read, state.read);
  }
}

/* ---------- bottom sheet: more / less / mute ---------- */
function openSheet(){ document.getElementById("sheet-backdrop").hidden = false; }
function closeSheet(){ document.getElementById("sheet-backdrop").hidden = true; state.sheetCardId = null; }

function wireSheet(){
  const backdrop = document.getElementById("sheet-backdrop");
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) return closeSheet();
    const item = e.target.closest(".sheet-item");
    if (!item) return;
    const act = item.dataset.act;
    const c = state.cards.find(x => x.id === state.sheetCardId);
    if (c) applySheetAction(act, c);
    closeSheet();
  });
}

function applySheetAction(act, c){
  if (act === "cancel") return;

  if (act === "more"){
    state.weights[c.lane] = laneWeight(c.lane) + 0.25;
    saveObj(STORE.weights, state.weights);
    toast(`More ${LANES[c.lane]} — you'll see it float up next refresh.`);
  } else if (act === "less"){
    state.weights[c.lane] = Math.max(0.2, laneWeight(c.lane) - 0.25);
    saveObj(STORE.weights, state.weights);
    removeCardEl(c.id);
    toast(`Less ${LANES[c.lane]}. Won't disappear though — every lane keeps a floor.`);
  } else if (act === "mute"){
    state.muted.add(c.source);
    saveSet(STORE.muted, state.muted);
    document.querySelectorAll(`.card[data-id]`).forEach(el => {
      const card = state.cards.find(x => x.id === el.dataset.id);
      if (card && card.source === c.source) el.remove();
    });
    toast(`Muted ${c.source}. Only an explicit mute removes a source.`);
  }
}

function removeCardEl(id){
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (el){ el.style.transition = "opacity .2s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 200); }
}

/* ---------- tabs ---------- */
function wireTabs(){
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const view = tab.dataset.view;
      document.getElementById("view-feed").hidden  = view !== "feed";
      document.getElementById("view-saved").hidden = view !== "saved";
      if (view === "saved") renderSaved();
      window.scrollTo(0, 0);
    });
  });
}

/* ---------- saved view ---------- */
function updateSavedCount(){ document.getElementById("saved-count").textContent = state.saved.size; }

function renderSaved(){
  const list = document.getElementById("saved-list");
  const empty = document.getElementById("saved-empty");
  const items = state.cards.filter(c => state.saved.has(c.id));

  empty.classList.toggle("hidden", items.length > 0);
  renderSavedFilters(items);

  let shown = items;
  if (state.savedFilter === "unread") shown = items.filter(c => !state.read.has(c.id));
  else if (state.savedFilter !== "all") shown = items.filter(c => c.lane === state.savedFilter);

  // unread first, then read
  shown.sort((a, b) => (state.read.has(a.id) ? 1 : 0) - (state.read.has(b.id) ? 1 : 0));

  list.innerHTML = "";
  for (const c of shown){
    const read = state.read.has(c.id);
    const li = document.createElement("li");
    li.className = `saved-row lane-${c.lane} ${read ? "read" : ""}`;
    li.innerHTML = `
      <span class="unread-dot"></span>
      <div class="saved-main">
        <p class="saved-title">${esc(c.title)}</p>
        <p class="saved-meta"><span class="lane-tag">${LANES[c.lane]}</span> · ${esc(c.source)}</p>
      </div>
      <button class="saved-remove" aria-label="Remove">×</button>`;
    li.querySelector(".saved-main").addEventListener("click", () => {
      if (!state.read.has(c.id)){ state.read.add(c.id); saveSet(STORE.read, state.read); }
      if (c.url) window.open(c.url, "_blank", "noopener");
      else toast("No external link for this item.");
      renderSaved();
    });
    li.querySelector(".saved-remove").addEventListener("click", () => {
      state.saved.delete(c.id); saveSet(STORE.saved, state.saved);
      updateSavedCount(); renderSaved();
    });
    list.appendChild(li);
  }
}

function renderSavedFilters(items){
  const wrap = document.getElementById("saved-filters");
  const lanes = [...new Set(items.map(c => c.lane))];
  const unreadN = items.filter(c => !state.read.has(c.id)).length;
  const filters = [["all", "All"], ["unread", `Unread · ${unreadN}`], ...lanes.map(l => [l, LANES[l]])];
  wrap.innerHTML = "";
  for (const [key, label] of filters){
    const b = document.createElement("button");
    b.className = "chip" + (state.savedFilter === key ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => { state.savedFilter = key; renderSaved(); });
    wrap.appendChild(b);
  }
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.hidden = true; }, 220);
  }, 2600);
}

/* ---------- utilities ---------- */
function typeLabel(t){
  return { preprint: "preprint", trial: "trial", compound: "compound", funding: "funding", paper: "paper" }[t] || t;
}

function relAge(iso){
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "1 week ago";
  if (days < 56) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function fmtStamp(iso){
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return iso; }
}

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function bookmarkSVG(){
  return `<svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>`;
}

/* ---------- PWA service worker (only over http/https) ---------- */
function registerSW(){
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")){
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
