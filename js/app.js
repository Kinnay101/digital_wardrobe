import * as db from './db.js';
import {
  downscale, removeBackground, trimTransparent, detectColor, imageAspect, onWhite,
  COLORS, colorById, blobToDataUrl, dataUrlToBlob,
} from './image.js';
import { classify } from './ai.js';
import * as sync from './sync.js';

// Deutsche Bezeichnungen für die erkannten Kleidungsarten (Schlüssel = Label in labels.json)
const KIND_DE = {
  'a t-shirt': 'T-Shirt', 'a shirt': 'Hemd', 'a polo shirt': 'Poloshirt', 'a sweater': 'Pullover', 'a hoodie': 'Hoodie',
  'a sweatshirt': 'Sweatshirt', 'a long sleeve top': 'Longsleeve', 'a tank top': 'Tanktop', 'a blouse': 'Bluse',
  'a knitted pullover': 'Strickpullover', 'a jacket': 'Jacke', 'a coat': 'Mantel', 'a bomber jacket': 'Bomberjacke',
  'a denim jacket': 'Jeansjacke', 'a blazer': 'Blazer', 'a cardigan': 'Strickjacke', 'a puffer jacket': 'Daunenjacke',
  'a vest': 'Weste', 'a dress': 'Kleid', 'a jumpsuit': 'Jumpsuit', 'a long dress': 'Maxikleid', 'a summer dress': 'Sommerkleid',
  'a pair of pants': 'Hose', 'jeans': 'Jeans', 'trousers': 'Stoffhose', 'shorts': 'Shorts', 'a skirt': 'Rock',
  'sweatpants': 'Jogginghose', 'chinos': 'Chino', 'leggings': 'Leggings', 'a pair of shoes': 'Schuhe', 'sneakers': 'Sneaker',
  'boots': 'Stiefel', 'sandals': 'Sandalen', 'leather dress shoes': 'Lederschuhe', 'heels': 'High Heels', 'loafers': 'Loafer',
  'a bag': 'Tasche', 'a handbag': 'Handtasche', 'a backpack': 'Rucksack', 'a belt': 'Gürtel', 'a hat': 'Hut', 'a cap': 'Cap',
  'sunglasses': 'Sonnenbrille', 'a watch': 'Uhr', 'a scarf': 'Schal', 'jewelry': 'Schmuck', 'a necklace': 'Kette',
  'a tie': 'Krawatte', 'socks': 'Socken', 'gloves': 'Handschuhe',
};

/* ---------- Kategorien & Standard-Positionen im Studio ----------
   slot: Mittelpunkt (x/y in % der Fläche), Breite w (% der Breite), maxH (% der Höhe), z (Ebene) */
const CATEGORIES = [
  { id: 'oberteile', name: 'Oberteile', one: 'Oberteil', slot: { x: 30, y: 27, w: 44, maxH: 40, z: 2 } },
  { id: 'jacken', name: 'Jacken', one: 'Jacke', slot: { x: 72, y: 25, w: 42, maxH: 40, z: 3 } },
  { id: 'kleider', name: 'Kleider', one: 'Kleid', slot: { x: 32, y: 42, w: 46, maxH: 66, z: 2 } },
  { id: 'hosen', name: 'Hosen & Röcke', one: 'Hose', slot: { x: 70, y: 68, w: 38, maxH: 54, z: 1 } },
  { id: 'schuhe', name: 'Schuhe', one: 'Schuhe', slot: { x: 27, y: 79, w: 34, maxH: 24, z: 4 } },
  { id: 'accessoires', name: 'Accessoires', one: 'Accessoire', slot: { x: 45, y: 56, w: 22, maxH: 20, z: 5 } },
  { id: 'sonstiges', name: 'Sonstiges', one: 'Teil', slot: { x: 50, y: 50, w: 30, maxH: 34, z: 3 } },
];
const catById = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
const STAGE_RATIO = 5 / 4; // Höhe / Breite der Studio-Fläche

const ICON = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

/* ---------- Helfer ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------- Zustand ---------- */
const state = {
  items: [],
  outfits: [],
  view: 'wardrobe',
  wardrobeFilter: 'alle',
  studioFilter: 'alle',
  studio: { id: null, name: '', pieces: [] },
  selected: null, // pid des ausgewählten Teils im Studio
};

const urls = new Map();
function urlFor(item) {
  if (!urls.has(item.id)) urls.set(item.id, URL.createObjectURL(item.image));
  return urls.get(item.id);
}
function dropUrl(id) {
  const u = urls.get(id);
  if (u) { URL.revokeObjectURL(u); urls.delete(id); }
}
const itemById = (id) => state.items.find((i) => i.id === id);

function countByCategory(items) {
  const counts = {};
  for (const it of items) counts[it.category] = (counts[it.category] || 0) + 1;
  return counts;
}

/* ---------- Navigation ---------- */
const VIEWS = ['wardrobe', 'studio', 'outfits'];
function show(view) {
  if (!VIEWS.includes(view)) view = 'wardrobe';
  state.view = view;
  for (const v of VIEWS) $('#view-' + v).hidden = v !== view;
  document.querySelectorAll('.nav-btn').forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (state.view === 'wardrobe') renderWardrobe();
  else if (state.view === 'studio') renderStudio();
  else renderOutfits();
}

function renderChips(el, current, counts, onPick) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const list = [{ id: 'alle', name: 'Alle', n: total }, ...CATEGORIES.filter((c) => counts[c.id]).map((c) => ({ id: c.id, name: c.name, n: counts[c.id] }))];
  el.innerHTML = list.map((c) => `<button class="chip" role="tab" data-id="${c.id}" aria-selected="${c.id === current}">${esc(c.name)}<span class="n">${c.n}</span></button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('.chip');
    if (b) onPick(b.dataset.id);
  };
}

/* ---------- Schrank ---------- */
function renderWardrobeCount() {
  const parts = [];
  if (state.items.length) parts.push(plural(state.items.length, 'Teil', 'Teile'));
  const s = syncLabel();
  if (s) parts.push(s);
  $('#wardrobe-count').textContent = parts.join(' · ');
}

function renderWardrobe() {
  const counts = countByCategory(state.items);
  if (state.wardrobeFilter !== 'alle' && !counts[state.wardrobeFilter]) state.wardrobeFilter = 'alle';
  const has = state.items.length > 0;

  renderWardrobeCount();
  $('#wardrobe-empty').hidden = has;
  $('#wardrobe-filter').hidden = !has;
  $('#view-wardrobe .fab').hidden = !has;

  renderChips($('#wardrobe-filter'), state.wardrobeFilter, counts, (id) => {
    state.wardrobeFilter = id;
    renderWardrobe();
  });

  const list = state.wardrobeFilter === 'alle' ? state.items : state.items.filter((i) => i.category === state.wardrobeFilter);
  $('#wardrobe-grid').innerHTML = list.map((it) => {
    const col = colorById(it.color);
    return `<button class="card" data-id="${it.id}">
      <div class="card-img"><img class="${it.cutout ? 'sticker' : ''}" src="${urlFor(it)}" alt="" loading="lazy"></div>
      <div class="card-meta">
        <div class="card-title">${esc(it.name)}</div>
        <div class="card-sub"><span class="swatch" style="background:${col.hex}"></span>${esc(catById(it.category).name)}</div>
      </div>
    </button>`;
  }).join('');
}

/* ---------- Sheet (Dialog) ---------- */
const sheet = $('#sheet');
function openSheet(html) {
  sheet.innerHTML = html;
  if (!sheet.open) sheet.showModal();
  return sheet;
}
function closeSheet() {
  if (sheet.open) sheet.close();
}

/* Formularfelder für Name, Kategorie und Farbe (beim Hinzufügen und Bearbeiten) */
function defaultName(d) {
  // Erkannte Art (z. B. "Longsleeve") nur nutzen, solange die Kategorie dazu passt
  const one = d.kind && d.kind.category === d.category ? d.kind.word : catById(d.category).one;
  return d.color === 'bunt' ? `${one} (bunt)` : `${one} in ${colorById(d.color).name}`;
}
function itemFieldsHtml(d) {
  return `
    <label class="field"><span>Name</span>
      <input class="input" id="f-name" value="${esc(d.name)}" placeholder="${esc(defaultName(d))}" maxlength="60" autocomplete="off">
    </label>
    <div class="field"><span>Kategorie</span>
      <div class="cat-picker" id="f-cat">
        ${CATEGORIES.map((c) => `<button type="button" class="chip" data-id="${c.id}" aria-selected="${c.id === d.category}">${esc(c.name)}</button>`).join('')}
      </div>
    </div>
    <div class="field"><span>Farbe</span>
      <div class="color-picker" id="f-color">
        ${COLORS.map((c) => `<button type="button" class="color-dot" data-id="${c.id}" title="${esc(c.name)}" aria-label="${esc(c.name)}" aria-pressed="${c.id === d.color}" style="background:${c.hex}"></button>`).join('')}
      </div>
    </div>`;
}
function bindItemFields(d) {
  const nameEl = $('#f-name', sheet);
  const refreshPlaceholder = () => { nameEl.placeholder = defaultName(d); };
  nameEl.oninput = () => { d.name = nameEl.value; };
  $('#f-cat', sheet).onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    d.catTouched = true;
    setCategory(d, b.dataset.id);
  };
  $('#f-color', sheet).onclick = (e) => {
    const b = e.target.closest('.color-dot');
    if (!b) return;
    setColor(d, b.dataset.id);
  };
  return refreshPlaceholder;
}
function setCategory(d, id) {
  d.category = id;
  sheet.querySelectorAll('#f-cat .chip').forEach((c) => c.setAttribute('aria-selected', c.dataset.id === id));
  const nameEl = $('#f-name', sheet);
  if (nameEl) nameEl.placeholder = defaultName(d);
}
function setColor(d, id) {
  d.color = id;
  sheet.querySelectorAll('#f-color .color-dot').forEach((c) => c.setAttribute('aria-pressed', c.dataset.id === id));
  const nameEl = $('#f-name', sheet);
  if (nameEl) nameEl.placeholder = defaultName(d);
}

/* ---------- Teil hinzufügen ---------- */
let addToken = null;

async function openAddSheet(file) {
  const token = {};
  addToken = token;
  const alive = () => addToken === token;
  const d = {
    name: '', color: 'grau',
    category: state.wardrobeFilter !== 'alle' ? state.wardrobeFilter : 'oberteile',
    original: null, cutout: null, useCutout: true,
  };

  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>Neues Teil</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <div class="sheet-preview" id="add-preview"><div class="progress-pill" id="add-progress">Foto wird geladen …</div></div>
    <label class="toggle-row" id="add-cutout-row" hidden>Hintergrund entfernen <input type="checkbox" id="add-cutout" checked></label>
    ${itemFieldsHtml(d)}
    <button class="btn btn-primary btn-block" id="add-save" disabled>Wird verarbeitet …</button>
  </div>`);
  bindItemFields(d);

  const preview = $('#add-preview', sheet);
  const progress = $('#add-progress', sheet);
  // Fortschrittsanzeige: beim ersten Mal werden die KI-Modelle geladen, danach kommen sie aus dem Cache
  const loadingText = (busyText) => (f) => {
    if (!alive()) return;
    progress.textContent = f < 1 ? `KI-Modell wird geladen · ${Math.round(f * 100)} %` : busyText;
  };
  const showImage = (blob, isCutout, scanning) => {
    preview.querySelector('img')?.remove();
    preview.querySelector('.scan')?.remove();
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    img.onload = () => URL.revokeObjectURL(img.src);
    img.alt = 'Vorschau';
    if (isCutout) img.className = 'sticker';
    preview.prepend(img);
    if (scanning) preview.insertAdjacentHTML('beforeend', '<div class="scan"></div>');
  };

  try {
    d.original = await downscale(file);
  } catch {
    if (alive()) { toast('Das Foto konnte nicht gelesen werden'); closeSheet(); }
    return;
  }
  if (!alive()) return;
  showImage(d.original, false, true);
  progress.textContent = 'Hintergrund wird entfernt …';
  setColor(d, await detectColor(d.original));

  try {
    const raw = await removeBackground(d.original, loadingText('Hintergrund wird entfernt …'));
    d.cutout = await trimTransparent(raw);
    if (!alive()) return;
    setColor(d, await detectColor(d.cutout));
  } catch (err) {
    console.warn('Freistellen fehlgeschlagen', err);
    d.useCutout = false;
    if (alive()) toast('Freistellen nicht möglich – das Originalfoto wird verwendet');
  }
  if (!alive()) return;

  // Kategorie erkennen (überschreibt keine Auswahl, die du schon selbst getroffen hast)
  progress.textContent = 'Kategorie wird erkannt …';
  try {
    const r = await classify(await onWhite(d.cutout || d.original), loadingText('Kategorie wird erkannt …'));
    if (!alive()) return;
    d.kind = { category: r.category, word: KIND_DE[r.label] || catById(r.category).one };
    if (!d.catTouched) setCategory(d, r.category);
    else setCategory(d, d.category);
  } catch (err) {
    console.warn('Kategorie-Erkennung fehlgeschlagen', err);
  }
  if (!alive()) return;

  progress.remove();
  showImage(d.cutout && d.useCutout ? d.cutout : d.original, !!(d.cutout && d.useCutout), false);
  if (d.cutout) {
    $('#add-cutout-row', sheet).hidden = false;
    $('#add-cutout', sheet).onchange = (e) => {
      d.useCutout = e.target.checked;
      showImage(d.useCutout ? d.cutout : d.original, d.useCutout, false);
    };
  }
  const saveBtn = $('#add-save', sheet);
  saveBtn.disabled = false;
  saveBtn.textContent = 'In den Schrank legen';
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const useCut = !!(d.cutout && d.useCutout);
    const image = useCut ? d.cutout : d.original;
    const item = {
      id: db.uid(),
      name: d.name.trim() || defaultName(d),
      category: d.category,
      color: d.color,
      image,
      cutout: useCut,
      aspect: await imageAspect(image),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await db.put('items', item);
    } catch (err) {
      console.error(err);
      toast('Speichern fehlgeschlagen');
      saveBtn.disabled = false;
      return;
    }
    sync.markChanged('item', item.id, 'put', { image: true });
    state.items.unshift(item);
    closeSheet();
    render();
    toast(`„${item.name}“ hinzugefügt`);
  };
}

/* ---------- Teil ansehen / bearbeiten ---------- */
function openItemSheet(item) {
  const d = { name: item.name, category: item.category, color: item.color };
  const usedIn = state.outfits.filter((o) => o.pieces.some((p) => p.itemId === item.id)).length;
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>${esc(item.name)}</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <div class="sheet-preview"><img class="${item.cutout ? 'sticker' : ''}" src="${urlFor(item)}" alt=""></div>
    ${usedIn ? `<p class="note">Kommt in ${plural(usedIn, 'Outfit', 'Outfits')} vor.</p>` : ''}
    ${itemFieldsHtml(d)}
    <div class="stack">
      <button class="btn btn-primary btn-block" id="item-save">Änderungen speichern</button>
      <div class="row">
        <button class="btn btn-ghost" id="item-studio">Im Studio verwenden</button>
        <button class="btn btn-danger" id="item-delete">Löschen</button>
      </div>
    </div>
  </div>`);
  bindItemFields(d);

  $('#item-save', sheet).onclick = async () => {
    Object.assign(item, { name: d.name.trim() || defaultName(d), category: d.category, color: d.color, updatedAt: Date.now() });
    await db.put('items', item);
    sync.markChanged('item', item.id, 'put');
    closeSheet();
    render();
    toast('Gespeichert');
  };
  $('#item-studio', sheet).onclick = () => {
    closeSheet();
    addToStudio(item);
    show('studio');
  };
  $('#item-delete', sheet).onclick = async () => {
    const extra = usedIn ? ` Es verschwindet auch aus ${plural(usedIn, 'Outfit', 'Outfits')}.` : '';
    if (!confirm(`„${item.name}“ wirklich löschen?${extra}`)) return;
    await db.remove('items', item.id);
    sync.markChanged('item', item.id, 'delete');
    state.items = state.items.filter((i) => i.id !== item.id);
    state.studio.pieces = state.studio.pieces.filter((p) => p.itemId !== item.id);
    saveDraft();
    dropUrl(item.id);
    closeSheet();
    render();
    toast('Gelöscht');
  };
}

/* ---------- Studio ---------- */
function renderStage(el, pieces, interactive) {
  el.innerHTML = pieces.map((p) => {
    const it = itemById(p.itemId);
    if (!it) return '';
    const sel = interactive && p.pid === state.selected ? ' selected' : '';
    return `<div class="piece${sel}" data-pid="${p.pid}" style="left:${p.x}%;top:${p.y}%;width:${p.w}%;z-index:${p.z}">
      <img class="${it.cutout ? 'sticker' : ''}" src="${urlFor(it)}" alt="${esc(it.name)}" draggable="false">
    </div>`;
  }).join('');
}

function renderStudio() {
  const s = state.studio;
  const visible = s.pieces.filter((p) => itemById(p.itemId));
  $('#studio-title').textContent = s.id ? s.name || 'Outfit' : 'Studio';
  $('#studio-sub').textContent = visible.length
    ? `${plural(visible.length, 'Teil', 'Teile')}${s.id ? ' · gespeichertes Outfit' : ''} · Ziehen zum Verschieben`
    : 'Tippe Teile an, um sie hinzuzufügen';
  renderStage($('#stage'), s.pieces, true);
  const hint = $('#stage-hint');
  hint.hidden = visible.length > 0;
  hint.textContent = state.items.length ? 'Wähle unten Teile aus deinem Schrank aus' : 'Füge zuerst Kleidung zu deinem Schrank hinzu';
  $('#piece-tools').hidden = !visible.length;
  setToolsEnabled(s.pieces.some((p) => p.pid === state.selected));
  $('#btn-studio-save').disabled = !visible.length;
  $('#btn-studio-new').disabled = !s.pieces.length && !s.id;
  $('#btn-studio-shuffle').disabled = !state.items.length;
  renderDrawer();
}

function renderDrawer() {
  const counts = countByCategory(state.items);
  if (state.studioFilter !== 'alle' && !counts[state.studioFilter]) state.studioFilter = 'alle';
  renderChips($('#studio-filter'), state.studioFilter, counts, (id) => {
    state.studioFilter = id;
    renderDrawer();
  });
  const used = new Set(state.studio.pieces.map((p) => p.itemId));
  const list = state.studioFilter === 'alle' ? state.items : state.items.filter((i) => i.category === state.studioFilter);
  const box = $('#studio-items');
  box.innerHTML = list.length
    ? list.map((it) => `<button class="drawer-item${used.has(it.id) ? ' used' : ''}" data-id="${it.id}" title="${esc(it.name)}" aria-pressed="${used.has(it.id)}">
        <img class="${it.cutout ? 'sticker' : ''}" src="${urlFor(it)}" alt="${esc(it.name)}" loading="lazy">
      </button>`).join('')
    : `<div class="drawer-empty">Noch keine Teile. <button class="btn btn-ghost" data-action="add-item">Teil hinzufügen</button></div>`;
}

function maxZ() {
  return state.studio.pieces.reduce((m, p) => Math.max(m, p.z), 0);
}

function addToStudio(item, { select = true } = {}) {
  const { slot } = catById(item.category);
  const aspect = item.aspect || 1;
  let w = slot.w;
  const heightPct = (w * aspect) / STAGE_RATIO;
  if (heightPct > slot.maxH) w = (slot.maxH * STAGE_RATIO) / aspect;
  let { x, y } = slot;
  let guard = 0;
  while (state.studio.pieces.some((p) => Math.abs(p.x - x) < 3 && Math.abs(p.y - y) < 3) && guard++ < 10) {
    x += 6; y += 5;
  }
  const piece = { pid: db.uid(), itemId: item.id, x: clamp(x, 5, 95), y: clamp(y, 5, 95), w: clamp(w, 8, 90), z: Math.max(slot.z, maxZ() + 1) };
  state.studio.pieces.push(piece);
  if (select) state.selected = piece.pid;
  saveDraft();
  return piece;
}

function removePiece(pid) {
  state.studio.pieces = state.studio.pieces.filter((p) => p.pid !== pid);
  if (state.selected === pid) state.selected = null;
  saveDraft();
}

function selectPiece(pid) {
  state.selected = pid;
  document.querySelectorAll('#stage .piece').forEach((el) => el.classList.toggle('selected', el.dataset.pid === pid));
  setToolsEnabled(!!pid);
}

function setToolsEnabled(on) {
  document.querySelectorAll('#piece-tools .tool').forEach((b) => { b.disabled = !on; });
}

function shuffleOutfit() {
  const by = {};
  for (const it of state.items) (by[it.category] ||= []).push(it);
  const pick = (arr) => (arr?.length ? arr[Math.floor(Math.random() * arr.length)] : null);
  const chosen = [];
  const canSeparates = by.oberteile?.length || by.hosen?.length;
  if (by.kleider?.length && (!canSeparates || Math.random() < 0.3)) chosen.push(pick(by.kleider));
  else chosen.push(pick(by.oberteile), pick(by.hosen));
  if (Math.random() < 0.6) chosen.push(pick(by.jacken));
  chosen.push(pick(by.schuhe));
  if (Math.random() < 0.5) chosen.push(pick(by.accessoires));
  const final = chosen.filter(Boolean);
  if (!final.length) { toast('Füge erst Oberteile, Hosen oder Schuhe hinzu'); return; }
  state.studio = { id: null, name: '', pieces: [] };
  final.forEach((it) => {
    const p = addToStudio(it, { select: false });
    p.z = catById(it.category).slot.z;
  });
  state.selected = null;
  saveDraft();
  renderStudio();
}

function suggestOutfitName(pieces) {
  const names = [];
  for (const p of pieces) {
    const it = itemById(p.itemId);
    if (!it || it.color === 'bunt') continue;
    const n = colorById(it.color).name;
    if (!names.includes(n)) names.push(n);
  }
  return names.length ? `Outfit in ${names.slice(0, 2).join(' & ')}` : 'Neues Outfit';
}

function openSaveSheet() {
  const s = state.studio;
  const pieces = s.pieces.filter((p) => itemById(p.itemId));
  if (!pieces.length) return;
  const placeholder = suggestOutfitName(pieces);
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>Outfit speichern</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <div class="sheet-preview outfit"><div class="stage" id="save-stage"></div></div>
    <label class="field"><span>Name</span>
      <input class="input" id="outfit-name" value="${esc(s.name)}" placeholder="${esc(placeholder)}" maxlength="60" autocomplete="off">
    </label>
    <div class="stack">
      <button class="btn btn-primary btn-block" id="save-outfit">${s.id ? 'Änderungen speichern' : 'Speichern'}</button>
      ${s.id ? '<button class="btn btn-ghost btn-block" id="save-outfit-new">Als neues Outfit speichern</button>' : ''}
    </div>
  </div>`);
  renderStage($('#save-stage', sheet), pieces, false);

  const save = async (asNew) => {
    const name = $('#outfit-name', sheet).value.trim() || placeholder;
    const existing = !asNew && s.id ? state.outfits.find((o) => o.id === s.id) : null;
    const outfit = {
      id: existing?.id || db.uid(),
      name,
      pieces: structuredClone(pieces),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await db.put('outfits', outfit);
    sync.markChanged('outfit', outfit.id, 'put');
    state.outfits = [outfit, ...state.outfits.filter((o) => o.id !== outfit.id)];
    state.studio.id = outfit.id;
    state.studio.name = outfit.name;
    saveDraft();
    closeSheet();
    render();
    toast('Outfit gespeichert');
  };
  $('#save-outfit', sheet).onclick = () => save(false);
  $('#save-outfit-new', sheet)?.addEventListener('click', () => save(true));
}

/* Entwurf im Studio pro Gerät merken (nur Komfort, keine wichtigen Daten) */
function saveDraft() {
  try { localStorage.setItem('studio-draft', JSON.stringify(state.studio)); } catch { /* egal */ }
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem('studio-draft') || 'null');
    if (d && Array.isArray(d.pieces)) state.studio = { id: d.id || null, name: d.name || '', pieces: d.pieces };
  } catch { /* egal */ }
}

/* Ziehen, Pinch-Zoom und Mausrad auf der Studio-Fläche */
function bindStage() {
  const stage = $('#stage');
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  const piece = () => state.studio.pieces.find((p) => p.pid === state.selected);
  const pieceEl = (pid) => stage.querySelector(`.piece[data-pid="${pid}"]`);
  const dist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const apply = (p) => {
    const el = pieceEl(p.pid);
    if (el) Object.assign(el.style, { left: p.x + '%', top: p.y + '%', width: p.w + '%', zIndex: p.z });
  };

  stage.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.piece');
    if (!el && pointers.size === 0) { selectPiece(null); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture(e.pointerId);
    if (el && pointers.size === 1) {
      selectPiece(el.dataset.pid);
      const p = piece();
      drag = { sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
    }
    if (pointers.size === 2 && piece()) {
      pinch = { d: dist(), w: piece().w };
      drag = null;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = piece();
    if (!p) return;
    if (pinch && pointers.size >= 2) {
      p.w = clamp(pinch.w * (dist() / pinch.d), 6, 100);
    } else if (drag) {
      const r = stage.getBoundingClientRect();
      p.x = clamp(drag.ox + ((e.clientX - drag.sx) / r.width) * 100, 0, 100);
      p.y = clamp(drag.oy + ((e.clientY - drag.sy) / r.height) * 100, 0, 100);
    } else return;
    apply(p);
  });
  const end = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { drag = null; saveDraft(); }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => {
    const p = piece();
    if (!p) return;
    e.preventDefault();
    p.w = clamp(p.w * (1 - e.deltaY * 0.0015), 6, 100);
    apply(p);
    saveDraft();
  }, { passive: false });

  $('#piece-tools').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]')?.dataset.tool;
    const p = piece();
    if (!t || !p) return;
    if (t === 'smaller') p.w = clamp(p.w * 0.88, 6, 100);
    if (t === 'bigger') p.w = clamp(p.w * 1.12, 6, 100);
    if (t === 'front') p.z = maxZ() + 1;
    if (t === 'back') {
      state.studio.pieces.forEach((q) => { if (q !== p) q.z += 1; });
      p.z = 0;
    }
    if (t === 'remove') { removePiece(p.pid); renderStudio(); return; }
    saveDraft();
    state.studio.pieces.forEach(apply);
  });

  $('#studio-items').addEventListener('click', (e) => {
    const b = e.target.closest('.drawer-item');
    if (!b) return;
    const existing = state.studio.pieces.find((p) => p.itemId === b.dataset.id);
    if (existing) removePiece(existing.pid);
    else addToStudio(itemById(b.dataset.id));
    renderStudio();
  });

  $('#btn-studio-save').onclick = openSaveSheet;
  $('#btn-studio-shuffle').onclick = shuffleOutfit;
  $('#btn-studio-new').onclick = () => {
    if (state.studio.pieces.length && !state.studio.id && !confirm('Studio leeren? Nicht gespeicherte Teile gehen verloren.')) return;
    state.studio = { id: null, name: '', pieces: [] };
    state.selected = null;
    saveDraft();
    renderStudio();
  };
}

/* ---------- Outfits ---------- */
function renderOutfits() {
  const has = state.outfits.length > 0;
  $('#outfits-count').textContent = has ? plural(state.outfits.length, 'Outfit', 'Outfits') : '';
  $('#outfits-empty').hidden = has;
  const grid = $('#outfits-grid');
  grid.innerHTML = state.outfits.map((o) => {
    const n = o.pieces.filter((p) => itemById(p.itemId)).length;
    return `<button class="card outfit-card" data-id="${o.id}">
      <div class="stage"></div>
      <div class="card-meta" style="padding-top:12px">
        <div class="card-title">${esc(o.name)}</div>
        <div class="card-sub">${plural(n, 'Teil', 'Teile')}</div>
      </div>
    </button>`;
  }).join('');
  grid.querySelectorAll('.outfit-card').forEach((card) => {
    const o = state.outfits.find((x) => x.id === card.dataset.id);
    renderStage($('.stage', card), o.pieces, false);
  });
}

function openOutfitSheet(outfit) {
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>${esc(outfit.name)}</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <div class="sheet-preview outfit"><div class="stage" id="outfit-stage"></div></div>
    <div class="stack">
      <button class="btn btn-primary btn-block" id="outfit-edit">Im Studio bearbeiten</button>
      <button class="btn btn-danger" id="outfit-delete">Outfit löschen</button>
    </div>
  </div>`);
  renderStage($('#outfit-stage', sheet), outfit.pieces, false);
  $('#outfit-edit', sheet).onclick = () => {
    state.studio = { id: outfit.id, name: outfit.name, pieces: structuredClone(outfit.pieces) };
    state.selected = null;
    saveDraft();
    closeSheet();
    show('studio');
  };
  $('#outfit-delete', sheet).onclick = async () => {
    if (!confirm(`Outfit „${outfit.name}“ löschen? Die Kleidungsstücke bleiben im Schrank.`)) return;
    await db.remove('outfits', outfit.id);
    sync.markChanged('outfit', outfit.id, 'delete');
    state.outfits = state.outfits.filter((o) => o.id !== outfit.id);
    if (state.studio.id === outfit.id) { state.studio.id = null; saveDraft(); }
    closeSheet();
    render();
    toast('Outfit gelöscht');
  };
}

/* ---------- Einstellungen, Konto & Backup ---------- */
function syncLabel(s = sync.status) {
  if (!s.signedIn) return '';
  if (s.syncing) return 'Synchronisiere …';
  if (s.error) return 'Sync-Problem';
  if (s.pending) return `${s.pending} noch nicht hochgeladen`;
  return s.lastSync ? 'Synchronisiert' : 'Sync aktiv';
}
const timeLabel = (ms) => new Date(ms).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function accountHtml() {
  if (!sync.available()) return '';
  const s = sync.status;
  if (!s.signedIn) {
    return `<h3 class="section-title">Konto & Sync</h3>
      <p class="note">Mit einem Konto haben PC und iPhone denselben Schrank. Alles wird <b>auf dem Gerät verschlüsselt</b>, bevor es hochgeladen wird – der Server sieht weder Fotos noch Namen.</p>
      <div class="row" style="margin-bottom:22px">
        <button class="btn btn-primary" id="acc-signin">Anmelden</button>
        <button class="btn btn-ghost" id="acc-signup">Konto erstellen</button>
      </div>`;
  }
  const line = s.error
    ? `<span class="form-error">${esc(s.error)}</span>`
    : s.syncing ? 'Synchronisiere …'
    : s.lastSync ? `Zuletzt synchronisiert: ${timeLabel(s.lastSync)}${s.pending ? ` · ${s.pending} ausstehend` : ''}`
    : 'Noch nicht synchronisiert';
  return `<h3 class="section-title">Konto & Sync</h3>
    <div class="account-box">
      <div><b>${esc(s.email)}</b></div>
      <div class="note" id="acc-status" style="margin:4px 0 0">${line}</div>
    </div>
    <div class="row" style="margin-bottom:22px">
      <button class="btn btn-primary" id="acc-sync">Jetzt synchronisieren</button>
      <button class="btn btn-ghost" id="acc-signout">Abmelden</button>
    </div>`;
}

function openSettingsSheet() {
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>Daten & Konto</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <div class="stats">
      <div class="stat"><b>${state.items.length}</b><span>Kleidungsstücke</span></div>
      <div class="stat"><b>${state.outfits.length}</b><span>Outfits</span></div>
    </div>
    ${accountHtml()}
    <h3 class="section-title">Backup</h3>
    <p class="note">${sync.status.signedIn ? 'Zusätzlich zum Sync kannst du jederzeit eine Sicherungsdatei erstellen.' : 'Ohne Konto wird alles nur auf diesem Gerät gespeichert. Mit einer Sicherungsdatei kannst du die Daten sichern oder übertragen.'}</p>
    <div class="stack">
      <button class="btn btn-ghost btn-block" id="do-export">Backup exportieren</button>
      <button class="btn btn-ghost btn-block" id="do-import">Backup importieren</button>
    </div>
  </div>`);
  $('#do-export', sheet).onclick = exportBackup;
  $('#do-import', sheet).onclick = () => $('#import-input').click();
  $('#acc-signin', sheet)?.addEventListener('click', () => openAuthSheet('signin'));
  $('#acc-signup', sheet)?.addEventListener('click', () => openAuthSheet('signup'));
  $('#acc-sync', sheet)?.addEventListener('click', async () => { await sync.sync(); if (sheet.open) openSettingsSheet(); });
  $('#acc-signout', sheet)?.addEventListener('click', async () => {
    if (!confirm('Abmelden? Deine Kleidung bleibt auf diesem Gerät, wird aber nicht mehr abgeglichen.')) return;
    await sync.signOut();
    openSettingsSheet();
    render();
    toast('Abgemeldet');
  });
}

function openAuthSheet(mode) {
  const signup = mode === 'signup';
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>${signup ? 'Konto erstellen' : 'Anmelden'}</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <form id="auth-form" novalidate>
      <label class="field"><span>E-Mail</span>
        <input class="input" type="email" id="auth-email" autocomplete="username" required>
      </label>
      <label class="field"><span>Passwort${signup ? ' (mind. 10 Zeichen)' : ''}</span>
        <input class="input" type="password" id="auth-pw" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
      </label>
      ${signup ? `<label class="field"><span>Passwort wiederholen</span>
        <input class="input" type="password" id="auth-pw2" autocomplete="new-password" required>
      </label>
      <p class="note"><b>Wichtig:</b> Dein Passwort ist gleichzeitig der Schlüssel zu deinen Daten. Nach dem ersten Anmelden bekommst du einen <b>Wiederherstellungs-Code</b> – ohne Passwort und Code kann niemand (auch nicht der Betreiber) deine Daten wiederherstellen.</p>` : ''}
      <p class="form-error" id="auth-error" hidden></p>
      <button class="btn btn-primary btn-block" id="auth-submit" type="submit">${signup ? 'Konto erstellen' : 'Anmelden'}</button>
    </form>
    <p class="note" style="margin-top:14px;text-align:center">${signup ? 'Schon ein Konto? <a href="#" id="auth-switch">Anmelden</a>' : 'Noch kein Konto? <a href="#" id="auth-switch">Konto erstellen</a>'}</p>
  </div>`);
  $('#auth-switch', sheet).onclick = (e) => { e.preventDefault(); openAuthSheet(signup ? 'signin' : 'signup'); };
  const errorEl = $('#auth-error', sheet);
  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = !msg; };
  $('#auth-form', sheet).onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#auth-email', sheet).value.trim();
    const pw = $('#auth-pw', sheet).value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showError('Bitte eine gültige E-Mail-Adresse eingeben.');
    if (signup) {
      if (pw.length < 10) return showError('Das Passwort muss mindestens 10 Zeichen lang sein.');
      if (pw !== $('#auth-pw2', sheet).value) return showError('Die Passwörter stimmen nicht überein.');
    } else if (!pw) return showError('Bitte das Passwort eingeben.');
    showError('');
    const btn = $('#auth-submit', sheet);
    btn.disabled = true;
    btn.textContent = 'Einen Moment …';
    try {
      if (signup) {
        const r = await sync.signUp(email, pw);
        if (!r.confirmed) return openInfoSheet('Fast geschafft', `Wir haben eine E-Mail an <b>${esc(email)}</b> geschickt. Klicke auf den Link darin und melde dich danach hier an.`);
        afterSignIn(r);
      } else {
        afterSignIn(await sync.signIn(email, pw));
      }
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = signup ? 'Konto erstellen' : 'Anmelden';
    }
  };
}

function afterSignIn({ recoveryCode }) {
  if (recoveryCode) openRecoverySheet(recoveryCode);
  else { closeSheet(); toast('Angemeldet – Sync läuft'); }
}

function openInfoSheet(title, html) {
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <p>${html}</p>
    <button class="btn btn-primary btn-block" data-close>OK</button>
  </div>`);
}

/** Wiederherstellungs-Code einmalig anzeigen. Schließen erst nach Bestätigung. */
function openRecoverySheet(code) {
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>Dein Wiederherstellungs-Code</h2></div>
    <p class="note">Falls du dein Passwort vergisst, ist dies der <b>einzige Weg</b> zurück zu deinen Daten. Er wird nur jetzt angezeigt. Bewahre ihn sicher auf, z. B. in deinem Passwort-Manager.</p>
    <div class="code-box" id="rc-code">${esc(code)}</div>
    <button class="btn btn-ghost btn-block" id="rc-copy" style="margin-bottom:14px">Code kopieren</button>
    <label class="toggle-row">Ich habe den Code sicher gespeichert <input type="checkbox" id="rc-ok"></label>
    <button class="btn btn-primary btn-block" id="rc-done" disabled>Fertig</button>
  </div>`);
  sheet.dataset.locked = '1';
  $('#rc-copy', sheet).onclick = async () => {
    try { await navigator.clipboard.writeText(code); toast('Kopiert'); } catch { toast('Kopieren nicht möglich – bitte abschreiben'); }
  };
  $('#rc-ok', sheet).onchange = (e) => { $('#rc-done', sheet).disabled = !e.target.checked; };
  $('#rc-done', sheet).onclick = () => {
    delete sheet.dataset.locked;
    closeSheet();
    toast('Angemeldet – Sync läuft');
  };
}

/** Nach einem Sync: Daten neu aus der lokalen Datenbank laden. */
async function reloadFromDb() {
  const [items, outfits] = await Promise.all([db.getAll('items'), db.getAll('outfits')]);
  const ids = new Set(items.map((i) => i.id));
  for (const id of [...urls.keys()]) if (!ids.has(id)) dropUrl(id);
  state.items = items.sort((a, b) => b.createdAt - a.createdAt);
  state.outfits = outfits.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  if (!sheet.open) render();
}

async function exportBackup() {
  const btn = $('#do-export', sheet);
  if (btn) { btn.disabled = true; btn.textContent = 'Wird erstellt …'; }
  const items = await Promise.all(state.items.map(async ({ image, ...rest }) => ({ ...rest, image: await blobToDataUrl(image) })));
  const data = { app: 'kleiderschrank', version: 1, exportedAt: new Date().toISOString(), items, outfits: state.outfits };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kleiderschrank-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (btn) { btn.disabled = false; btn.textContent = 'Backup exportieren'; }
  toast('Backup erstellt');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'kleiderschrank' || !Array.isArray(data.items)) throw new Error('Kein gültiges Backup');
    const knownItems = new Set(state.items.map((i) => i.id));
    const knownOutfits = new Set(state.outfits.map((o) => o.id));
    let ni = 0, no = 0;
    for (const raw of data.items) {
      if (knownItems.has(raw.id)) continue;
      const item = { ...raw, image: await dataUrlToBlob(raw.image) };
      await db.put('items', item);
      sync.markChanged('item', item.id, 'put', { image: true });
      state.items.push(item);
      ni++;
    }
    for (const o of data.outfits || []) {
      if (knownOutfits.has(o.id)) continue;
      await db.put('outfits', o);
      sync.markChanged('outfit', o.id, 'put');
      state.outfits.push(o);
      no++;
    }
    state.items.sort((a, b) => b.createdAt - a.createdAt);
    state.outfits.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    closeSheet();
    render();
    toast(`${plural(ni, 'Teil', 'Teile')} und ${plural(no, 'Outfit', 'Outfits')} importiert`);
  } catch (err) {
    console.error(err);
    toast('Import fehlgeschlagen: ' + err.message);
  }
}

/* ---------- Start ---------- */
async function init() {
  const [items, outfits] = await Promise.all([db.getAll('items'), db.getAll('outfits')]);
  state.items = items.sort((a, b) => b.createdAt - a.createdAt);
  state.outfits = outfits.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  loadDraft();

  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="add-item"]')) $('#file-input').click();
    const g = e.target.closest('[data-goto]');
    if (g) show(g.dataset.goto);
  });
  $('#file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) openAddSheet(f);
  });
  $('#import-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importBackup(f);
  });
  $('#wardrobe-grid').addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (c) openItemSheet(itemById(c.dataset.id));
  });
  $('#outfits-grid').addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (c) openOutfitSheet(state.outfits.find((o) => o.id === c.dataset.id));
  });
  $('#btn-settings').addEventListener('click', openSettingsSheet);
  sheet.addEventListener('click', (e) => {
    if (sheet.dataset.locked) return; // z. B. Wiederherstellungs-Code muss erst bestätigt werden
    if (e.target === sheet || e.target.closest('[data-close]')) closeSheet();
  });
  sheet.addEventListener('cancel', (e) => { if (sheet.dataset.locked) e.preventDefault(); }); // Escape-Taste
  sync.onChange(reloadFromDb);
  sync.onStatus(() => {
    if (state.view === 'wardrobe') renderWardrobeCount();
    const st = $('#acc-status', sheet);
    if (st && sheet.open) openSettingsSheet();
  });
  sheet.addEventListener('close', () => {
    // Das close-Ereignis kommt verzögert; wurde inzwischen schon ein neuer Dialog geöffnet, nichts löschen
    if (sheet.open) return;
    addToken = null;
    sheet.innerHTML = '';
  });
  bindStage();

  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (v !== state.view) show(v);
  });
  show(location.hash.slice(1) || 'wardrobe');
  db.requestPersistence();
  sync.init().catch((err) => console.warn('Sync-Start', err));

  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker', err));
  }
}

init().catch((err) => {
  console.error(err);
  toast('Die App konnte nicht starten: ' + err.message);
});
