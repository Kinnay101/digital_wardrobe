import * as db from './db.js';
import {
  downscale, removeBackground, trimTransparent, detectColor, imageAspect, extractGarments,
  COLORS, colorById, primaryColor, blobToDataUrl, dataUrlToBlob,
} from './image.js';
import { analyzeItem, ANALYSIS_VERSION } from './analyze.js';
import { PATTERNS, STYLES, patternName } from './attrs.js';
import { suggest, weatherNeeds, weatherTip, OCCASIONS } from './suggest.js';
import * as weather from './weather.js';
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

/* ---------- Als App installieren ----------
   Chrome und Edge (PC, Android) melden über "beforeinstallprompt", dass die Seite installierbar ist.
   Wir fangen das ab und zeigen einen eigenen Knopf. Safari (iPhone) kennt das nicht: dort Teilen → Zum Home-Bildschirm. */
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  renderInstall();
  toast('App installiert – du findest sie im Startmenü');
});
function renderInstall() {
  const btn = document.getElementById('btn-install');
  if (btn) btn.hidden = !installPrompt || isStandalone();
}
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  if (outcome === 'accepted') installPrompt = null;
  renderInstall();
}
function installHtml() {
  if (isStandalone()) return '';
  let body;
  if (installPrompt) body = '<p class="note">Installiere den Schrank als eigenes Programm: eigenes Fenster, Eintrag im Startmenü bzw. auf dem Home-Bildschirm, funktioniert auch offline.</p><button class="btn btn-primary btn-block" id="do-install">Als App installieren</button>';
  else if (isIos()) body = '<p class="note">Auf dem iPhone: in Safari unten auf <b>Teilen</b> tippen, dann <b>„Zum Home-Bildschirm“</b>.</p>';
  else body = '<p class="note">Am Computer geht das in <b>Chrome</b> oder <b>Edge</b>: Symbol „App installieren“ rechts in der Adressleiste oder Menü ⋮ → „Kleiderschrank installieren“. Firefox kann keine Web-Apps installieren.</p>';
  return `<h3 class="section-title">Als App nutzen</h3>${body}`;
}

/* ---------- Zustand ---------- */
const state = {
  items: [],
  outfits: [],
  view: 'wardrobe',
  wardrobeFilter: 'alle',
  wardrobeBrand: 'alle', // Marke (klein geschrieben) oder 'alle'
  studioFilter: 'alle',
  studio: { id: null, name: '', pieces: [] },
  selected: null, // pid des ausgewählten Teils im Studio
};

const urls = new Map();
function urlFor(item, side = 'front') {
  const key = side === 'back' ? item.id + ':back' : item.id;
  const blob = side === 'back' ? item.back : item.image;
  if (!blob) return '';
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}
function dropUrl(id, { backOnly = false } = {}) {
  for (const key of backOnly ? [id + ':back'] : [id, id + ':back']) {
    const u = urls.get(key);
    if (u) { URL.revokeObjectURL(u); urls.delete(key); }
  }
}

/** Farbliste eines Teils (ältere Teile haben nur eine Farbe). */
const colorsOf = (it) => (it.colors?.length ? it.colors : [{ id: it.color || 'grau', share: 1 }]);

/** Foto auswählen (Kamera oder Mediathek). Liefert die Datei oder null. */
function pickPhoto() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.hidden = true;
    (sheet.open ? sheet : document.body).append(inp); // iOS braucht das Feld im Dokument
    inp.onchange = () => { resolve(inp.files[0] || null); inp.remove(); };
    inp.addEventListener('cancel', () => { resolve(null); inp.remove(); });
    inp.click();
  });
}

/** Foto verkleinern und freistellen. Liefert { original, cutout } (cutout = null, wenn es nicht klappt). */
async function preparePhoto(file, onProgress) {
  const original = await downscale(file);
  let cutout = null;
  try {
    cutout = await trimTransparent(await removeBackground(original, onProgress));
  } catch (err) {
    console.warn('Freistellen fehlgeschlagen', err);
  }
  return { original, cutout };
}
const itemById = (id) => state.items.find((i) => i.id === id);

function countByCategory(items) {
  const counts = {};
  for (const it of items) counts[it.category] = (counts[it.category] || 0) + 1;
  return counts;
}

/* ---------- Navigation ---------- */
const VIEWS = ['today', 'wardrobe', 'studio', 'outfits'];
function show(view) {
  if (!VIEWS.includes(view)) view = 'today';
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
  if (state.view === 'today') renderToday();
  else if (state.view === 'wardrobe') renderWardrobe();
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
  if (backfill.total) parts.push(`Analysiere ${Math.min(backfill.done + 1, backfill.total)}/${backfill.total} …`);
  const s = syncLabel();
  if (s) parts.push(s);
  $('#wardrobe-count').textContent = parts.join(' · ');
}

function renderWardrobe() {
  const has = state.items.length > 0;
  // Marke zuerst filtern, die Kategorie-Zahlen beziehen sich dann auf diese Marke
  const brands = knownBrands();
  if (state.wardrobeBrand !== 'alle' && !brands.some((b) => b.name.toLowerCase() === state.wardrobeBrand)) state.wardrobeBrand = 'alle';
  const byBrand = state.wardrobeBrand === 'alle' ? state.items : state.items.filter((i) => i.brand?.toLowerCase() === state.wardrobeBrand);
  const counts = countByCategory(byBrand);
  if (state.wardrobeFilter !== 'alle' && !counts[state.wardrobeFilter]) state.wardrobeFilter = 'alle';

  renderWardrobeCount();
  $('#wardrobe-empty').hidden = has;
  $('#wardrobe-filter').hidden = !has;
  $('#view-wardrobe .fab').hidden = !has;

  renderChips($('#wardrobe-filter'), state.wardrobeFilter, counts, (id) => {
    state.wardrobeFilter = id;
    renderWardrobe();
  });

  const brandEl = $('#wardrobe-brand');
  brandEl.hidden = !brands.length;
  brandEl.innerHTML = brands.length
    ? [{ key: 'alle', name: 'Alle Marken', n: state.items.length }, ...brands.map((b) => ({ key: b.name.toLowerCase(), name: b.name, n: b.n }))]
      .map((b) => `<button class="chip" data-brand="${esc(b.key)}" aria-selected="${b.key === state.wardrobeBrand}">${esc(b.name)}<span class="n">${b.n}</span></button>`).join('')
    : '';
  brandEl.onclick = (e) => {
    const b = e.target.closest('[data-brand]');
    if (!b) return;
    state.wardrobeBrand = b.dataset.brand;
    renderWardrobe();
  };

  const list = state.wardrobeFilter === 'alle' ? byBrand : byBrand.filter((i) => i.category === state.wardrobeFilter);
  $('#wardrobe-grid').innerHTML = list.map((it) => {
    const swatches = colorsOf(it).map((c) => `<span class="swatch" style="background:${colorById(c.id).hex}"></span>`).join('');
    const sub = [it.brand, catById(it.category).name, it.pattern && it.pattern !== 'uni' ? patternName(it.pattern) : ''].filter(Boolean).map(esc).join(' · ');
    return `<button class="card" data-id="${it.id}">
      <div class="card-img"><img class="${it.cutout ? 'sticker' : ''}" src="${urlFor(it)}" alt="" loading="lazy"></div>
      ${it.back ? '<span class="card-badge" title="Mit Rückseite">2 Seiten</span>' : ''}
      <div class="card-meta">
        <div class="card-title">${esc(it.name)}</div>
        <div class="card-sub"><span class="swatches">${swatches}</span><span class="card-sub-text">${sub}</span></div>
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

/* Formularfelder für Name, Kategorie, Farben, Muster und Style (beim Hinzufügen und Bearbeiten) */
function defaultName(d) {
  // Erkannte Art (z. B. "Longsleeve") nur nutzen, solange die Kategorie dazu passt
  const one = d.kind && d.kind.category === d.category ? d.kind.word : catById(d.category).one;
  if (d.color === 'bunt') return `${one} (bunt)`;
  const [c1, c2] = d.colors || [];
  if (c1?.id === d.color && c2 && c2.share >= 0.3) return `${one} in ${colorById(c1.id).name} & ${colorById(c2.id).name}`;
  return `${one} in ${colorById(d.color).name}`;
}
/* Marken: frei eintragen; bereits verwendete Marken werden vorgeschlagen (häufigste zuerst) */
function knownBrands() {
  const counts = new Map();
  for (const it of state.items) {
    if (!it.brand) continue;
    const key = it.brand.toLowerCase();
    const cur = counts.get(key) || { name: it.brand, n: 0 };
    cur.n++;
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'de'));
}
/** Schreibweise vereinheitlichen: "nike " -> "Nike", wenn es "Nike" schon gibt. */
function canonicalBrand(v) {
  const s = String(v || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return knownBrands().find((b) => b.name.toLowerCase() === s.toLowerCase())?.name || s;
}
function brandFieldHtml(d) {
  const brands = knownBrands();
  return `<div class="field"><span>Marke <small>optional</small></span>
      <input class="input" id="f-brand" list="brand-list" value="${esc(d.brand || '')}" placeholder="z. B. Nike" maxlength="40" autocomplete="off" autocapitalize="words">
      <datalist id="brand-list">${brands.map((b) => `<option value="${esc(b.name)}"></option>`).join('')}</datalist>
      ${brands.length ? `<div class="cat-picker brand-quick" id="f-brand-quick">${brands.slice(0, 8).map((b) => `<button type="button" class="chip chip-sm" data-brand="${esc(b.name)}" aria-selected="${(d.brand || '').toLowerCase() === b.name.toLowerCase()}">${esc(b.name)}</button>`).join('')}</div>` : ''}
    </div>`;
}
const pct = (v) => `${Math.round(v * 100)} %`;
function colorBarHtml(colors) {
  return `<div class="color-bar">${colors.map((c) => `<span style="flex:${c.share};background:${colorById(c.id).hex}"></span>`).join('')}</div>
    <div class="color-legend">${colors.map((c) => `${esc(colorById(c.id).name)} ${pct(c.share)}`).join(' · ')}</div>`;
}
function itemFieldsHtml(d) {
  return `
    <label class="field"><span>Name</span>
      <input class="input" id="f-name" value="${esc(d.name)}" placeholder="${esc(defaultName(d))}" maxlength="60" autocomplete="off">
    </label>
    ${brandFieldHtml(d)}
    <div class="field"><span>Kategorie</span>
      <div class="cat-picker" id="f-cat">
        ${CATEGORIES.map((c) => `<button type="button" class="chip" data-id="${c.id}" aria-selected="${c.id === d.category}">${esc(c.name)}</button>`).join('')}
      </div>
    </div>
    <div class="field"><span>Farben <small>bis zu 3 – antippen zum An- und Abwählen</small></span>
      <div id="f-colorbar">${colorBarHtml(d.colors)}</div>
      <div class="color-picker" id="f-color">
        ${COLORS.map((c) => `<button type="button" class="color-dot" data-id="${c.id}" title="${esc(c.name)}" aria-label="${esc(c.name)}" aria-pressed="${d.colors.some((x) => x.id === c.id)}" style="background:${c.hex}"></button>`).join('')}
      </div>
    </div>
    <div class="field"><span>Muster</span>
      <div class="cat-picker" id="f-pattern">
        ${PATTERNS.map((p) => `<button type="button" class="chip chip-sm" data-id="${p.id}" aria-selected="${p.id === d.pattern}">${esc(p.name)}</button>`).join('')}
      </div>
    </div>
    <div class="field"><span>Style <small>mehrere möglich</small></span>
      <div class="cat-picker" id="f-style">
        ${STYLES.map((s) => `<button type="button" class="chip chip-sm" data-id="${s.id}" aria-selected="${d.styles.includes(s.id)}">${esc(s.name)}</button>`).join('')}
      </div>
    </div>`;
}
function bindItemFields(d) {
  const nameEl = $('#f-name', sheet);
  nameEl.oninput = () => { d.name = nameEl.value; };
  const brandEl = $('#f-brand', sheet);
  const markBrand = () => sheet.querySelectorAll('#f-brand-quick [data-brand]').forEach((c) => c.setAttribute('aria-selected', c.dataset.brand.toLowerCase() === d.brand.trim().toLowerCase()));
  brandEl.oninput = () => { d.brand = brandEl.value; markBrand(); };
  $('#f-brand-quick', sheet)?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-brand]');
    if (!b) return;
    // Nochmal antippen entfernt die Marke wieder
    d.brand = d.brand.trim().toLowerCase() === b.dataset.brand.toLowerCase() ? '' : b.dataset.brand;
    brandEl.value = d.brand;
    markBrand();
  });
  $('#f-cat', sheet).onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    d.catTouched = true;
    setCategory(d, b.dataset.id);
  };
  $('#f-color', sheet).onclick = (e) => {
    const b = e.target.closest('.color-dot');
    if (!b) return;
    d.colorsTouched = true;
    toggleColor(d, b.dataset.id);
  };
  $('#f-pattern', sheet).onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    d.patternTouched = true;
    d.pattern = b.dataset.id;
    refreshFields(d);
  };
  $('#f-style', sheet).onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    d.stylesTouched = true;
    const id = b.dataset.id;
    d.styles = d.styles.includes(id) ? d.styles.filter((s) => s !== id) : [...d.styles, id];
    refreshFields(d);
  };
}
/** Formular an den Entwurf d angleichen (nach Auswahl oder neuer Analyse). */
function refreshFields(d) {
  const sel = (box, isOn, attr = 'aria-selected') => sheet.querySelectorAll(`${box} [data-id]`).forEach((c) => c.setAttribute(attr, isOn(c.dataset.id)));
  sel('#f-cat', (id) => id === d.category);
  sel('#f-color', (id) => d.colors.some((c) => c.id === id), 'aria-pressed');
  sel('#f-pattern', (id) => id === d.pattern);
  sel('#f-style', (id) => d.styles.includes(id));
  const bar = $('#f-colorbar', sheet);
  if (bar) bar.innerHTML = colorBarHtml(d.colors);
  const nameEl = $('#f-name', sheet);
  if (nameEl) nameEl.placeholder = defaultName(d);
}
function setCategory(d, id) {
  d.category = id;
  refreshFields(d);
}
/**
 * Farbe an- oder abwählen. Eine wieder angewählte Farbe bekommt ihren gemessenen (bzw. zuletzt
 * angezeigten) Anteil zurück, eine ganz neue 20 %; die übrigen Farben teilen sich den Rest.
 */
function toggleColor(d, id) {
  const memory = (d.colorMemory ||= {});
  let list = d.colors.filter((c) => c.id !== 'bunt' || id === 'bunt');
  if (id === 'bunt') list = [{ id: 'bunt', share: 1 }];
  else if (list.some((c) => c.id === id)) {
    if (list.length > 1) {
      memory[id] = list.find((c) => c.id === id).share;
      list = list.filter((c) => c.id !== id);
    }
  } else if (!list.length) list = [{ id, share: 1 }];
  else {
    const measured = d.analysisResult?.colors?.find((c) => c.id === id)?.share;
    const share = Math.min(0.9, memory[id] ?? measured ?? 0.2);
    const rest = list.slice(0, 2);
    const restSum = rest.reduce((s, c) => s + c.share, 0) || 1;
    list = [...rest.map((c) => ({ id: c.id, share: (c.share / restSum) * (1 - share) })), { id, share }];
  }
  const sum = list.reduce((s, c) => s + c.share, 0);
  d.colors = list.map((c) => ({ id: c.id, share: Math.round((c.share / sum) * 100) / 100 }));
  d.color = primaryColor(d.colors);
  refreshFields(d);
}
/** Ergebnis einer Analyse in den Entwurf übernehmen – ohne Felder zu überschreiben, die du schon geändert hast. */
function applyAnalysis(d, r) {
  d.analysisResult = r;
  d.kind = { category: r.category, word: KIND_DE[r.kindLabel] || catById(r.category).one };
  if (!d.catTouched) d.category = r.category;
  if (!d.colorsTouched) { d.colors = r.colors; d.color = r.color; }
  if (!d.patternTouched) d.pattern = r.pattern;
  if (!d.stylesTouched) d.styles = r.styles;
  refreshFields(d);
}
/** Übernimmt die Formularwerte und Analyse-Daten eines Entwurfs in ein Kleidungsstück. */
function draftToItem(d, item) {
  Object.assign(item, {
    name: d.name.trim() || defaultName(d), category: d.category,
    color: d.color, colors: d.colors, pattern: d.pattern, styles: d.styles,
  });
  const brand = canonicalBrand(d.brand);
  if (brand) item.brand = brand; else delete item.brand;
  const r = d.analysisResult;
  if (r) Object.assign(item, { kindLabel: r.kindLabel, patternScores: r.patternScores, styleScores: r.styleScores, warmth: r.warmth, emb: r.emb, analysis: r.analysis });
  return item;
}
/** Leerer Entwurf mit Standardwerten. */
const newDraft = (extra) => ({ name: '', brand: '', color: 'grau', colors: [{ id: 'grau', share: 1 }], pattern: 'uni', styles: [], ...extra });

/* Vorschau mit Umschalter Vorder-/Rückseite */
function previewHtml(id) {
  return `<div class="sheet-preview" id="${id}">
    <div class="side-switch" hidden><button type="button" data-side="front" aria-pressed="true">Vorne</button><button type="button" data-side="back" aria-pressed="false">Hinten</button></div>
  </div>`;
}
function bindPreview(el, getBlob) {
  let side = 'front';
  const sw = $('.side-switch', el);
  const showSide = (s, { scanning = false } = {}) => {
    side = s;
    const { blob, cutout } = getBlob(side);
    el.querySelector('img')?.remove();
    el.querySelector('.scan')?.remove();
    sw.querySelectorAll('[data-side]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.side === side));
    if (!blob) return;
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    img.onload = () => URL.revokeObjectURL(img.src);
    img.alt = side === 'back' ? 'Rückseite' : 'Vorderseite';
    if (cutout) img.className = 'sticker';
    el.prepend(img);
    if (scanning) el.insertAdjacentHTML('beforeend', '<div class="scan"></div>');
  };
  sw.onclick = (e) => { const b = e.target.closest('[data-side]'); if (b) showSide(b.dataset.side); };
  return {
    show: showSide,
    refresh: () => showSide(side),
    setHasBack: (has) => { sw.hidden = !has; if (!has && side === 'back') showSide('front'); },
  };
}

/* ---------- Teil hinzufügen ---------- */
let addToken = null;

async function openAddSheet(file) {
  const token = {};
  addToken = token;
  const alive = () => addToken === token;
  const d = newDraft({
    category: state.wardrobeFilter !== 'alle' ? state.wardrobeFilter : 'oberteile',
    original: null, cutout: null, useCutout: true, backOriginal: null, backCutout: null,
  });

  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>Neues Teil</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    ${previewHtml('add-preview')}
    <label class="toggle-row" id="add-cutout-row" hidden>Hintergrund entfernen <input type="checkbox" id="add-cutout" checked></label>
    <div class="row back-row" id="add-back-row" hidden>
      <button class="btn btn-ghost" id="add-back">Rückseite hinzufügen</button>
      <button class="btn btn-ghost" id="add-back-remove" hidden>Rückseite entfernen</button>
    </div>
    <button class="btn btn-ghost btn-block" id="add-multi" style="margin-bottom:14px" hidden>Foto mit Person? Teile einzeln herauslösen</button>
    ${itemFieldsHtml(d)}
    <button class="btn btn-primary btn-block" id="add-save" disabled>Wird verarbeitet …</button>
  </div>`);
  bindItemFields(d);

  const preview = $('#add-preview', sheet);
  preview.insertAdjacentHTML('beforeend', '<div class="progress-pill" id="add-progress">Foto wird geladen …</div>');
  const progress = $('#add-progress', sheet);
  // Fortschrittsanzeige: beim ersten Mal werden die KI-Modelle geladen, danach kommen sie aus dem Cache
  const loadingText = (busyText) => (f) => {
    if (!alive()) return;
    progress.textContent = f < 1 ? `KI-Modell wird geladen · ${Math.round(f * 100)} %` : busyText;
  };
  const useCut = () => !!(d.cutout && d.useCutout);
  const view = bindPreview(preview, (side) => (side === 'back'
    ? { blob: useCut() && d.backCutout ? d.backCutout : d.backOriginal, cutout: useCut() && !!d.backCutout }
    : { blob: useCut() ? d.cutout : d.original, cutout: useCut() }));

  try {
    d.original = await downscale(file);
  } catch {
    if (alive()) { toast('Das Foto konnte nicht gelesen werden'); closeSheet(); }
    return;
  }
  if (!alive()) return;
  view.show('front', { scanning: true });
  progress.textContent = 'Hintergrund wird entfernt …';

  try {
    const raw = await removeBackground(d.original, loadingText('Hintergrund wird entfernt …'));
    d.cutout = await trimTransparent(raw);
  } catch (err) {
    console.warn('Freistellen fehlgeschlagen', err);
    d.useCutout = false;
    if (alive()) toast('Freistellen nicht möglich – das Originalfoto wird verwendet');
  }
  if (!alive()) return;

  // Kategorie, Farben, Muster, Style erkennen (überschreibt nichts, was du schon selbst gewählt hast)
  const frontBlob = () => d.cutout || d.original;
  const backBlob = () => d.backCutout || d.backOriginal;
  const analyze = async () => {
    try {
      const r = await analyzeItem({ front: frontBlob(), back: backBlob() }, loadingText('Wird analysiert …'));
      if (alive()) applyAnalysis(d, r);
    } catch (err) {
      console.warn('Analyse fehlgeschlagen', err);
      // Ohne KI wenigstens die Farbe bestimmen
      if (alive() && !d.analysisResult && !d.colorsTouched) {
        d.color = await detectColor(frontBlob());
        d.colors = [{ id: d.color, share: 1 }];
        refreshFields(d);
      }
    }
  };
  progress.textContent = 'Wird analysiert …';
  await analyze();
  if (!alive()) return;

  progress.remove();
  view.show('front');
  if (d.cutout) {
    $('#add-cutout-row', sheet).hidden = false;
    $('#add-cutout', sheet).onchange = (e) => {
      d.useCutout = e.target.checked;
      view.refresh();
    };
  }

  // Rückseite (optional): eigenes Foto, wird genauso freigestellt; Muster/Farben werden neu berechnet
  const backBtn = $('#add-back', sheet);
  const backRemove = $('#add-back-remove', sheet);
  $('#add-back-row', sheet).hidden = false;
  backBtn.onclick = async () => {
    const f = await pickPhoto();
    if (!f || !alive()) return;
    backBtn.disabled = true;
    backBtn.textContent = 'Rückseite wird freigestellt …';
    try {
      const p = await preparePhoto(f);
      if (!alive()) return;
      d.backOriginal = p.original;
      d.backCutout = p.cutout;
      view.setHasBack(true);
      view.show('back', { scanning: true });
      backBtn.textContent = 'Wird analysiert …';
      await analyze();
      if (!alive()) return;
      view.show('back');
    } catch (err) {
      console.warn(err);
      toast('Die Rückseite konnte nicht gelesen werden');
    }
    backBtn.disabled = false;
    backBtn.textContent = d.backOriginal ? 'Rückseite ersetzen' : 'Rückseite hinzufügen';
    backRemove.hidden = !d.backOriginal;
  };
  backRemove.onclick = async () => {
    d.backOriginal = d.backCutout = null;
    view.setHasBack(false);
    backRemove.hidden = true;
    backBtn.textContent = 'Rückseite hinzufügen';
    await analyze();
  };
  // Mehrere Teile auf einem Foto mit Person: nur auf Wunsch (lädt beim ersten Mal ein weiteres Modell)
  const multiBtn = $('#add-multi', sheet);
  multiBtn.hidden = false;
  multiBtn.onclick = async () => {
    const label = multiBtn.textContent;
    multiBtn.disabled = true;
    multiBtn.textContent = 'Teile werden gesucht …';
    try {
      const res = await extractGarments(d.original, (f) => {
        if (alive()) multiBtn.textContent = f < 1 ? `KI-Modell wird geladen · ${Math.round(f * 100)} %` : 'Teile werden gesucht …';
      });
      if (!alive()) return;
      if (!res.pieces.length) throw new Error('none');
      if (!res.person && res.pieces.length < 2) {
        toast('Hier ist nur ein Teil zu sehen – einfach normal speichern');
      } else {
        openMultiSheet(res.pieces);
        return;
      }
    } catch (err) {
      if (err.message !== 'none') console.warn(err);
      if (alive()) toast(err.message === 'none' ? 'Keine einzelnen Teile gefunden' : 'Erkennung fehlgeschlagen');
    }
    if (alive()) { multiBtn.disabled = false; multiBtn.textContent = label; }
  };

  const saveBtn = $('#add-save', sheet);
  saveBtn.disabled = false;
  saveBtn.textContent = 'In den Schrank legen';
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const cut = useCut();
    const image = cut ? d.cutout : d.original;
    const now = Date.now();
    const item = draftToItem(d, { id: db.uid(), image, cutout: cut, aspect: await imageAspect(image), createdAt: now, updatedAt: now });
    if (d.backOriginal) {
      const backCut = cut && !!d.backCutout;
      Object.assign(item, { back: backCut ? d.backCutout : d.backOriginal, backCutout: backCut, backRev: now });
    }
    try {
      await db.put('items', item);
    } catch (err) {
      console.error(err);
      toast('Speichern fehlgeschlagen');
      saveBtn.disabled = false;
      return;
    }
    sync.markChanged('item', item.id, 'put', { image: true, back: !!item.back });
    state.items.unshift(item);
    closeSheet();
    render();
    toast(`„${item.name}“ hinzugefügt`);
  };
}

/* ---------- Mehrere Teile aus einem Foto ---------- */
function openMultiSheet(pieces) {
  const token = {};
  addToken = token;
  const alive = () => addToken === token;
  const drafts = pieces.map((p) => newDraft({
    category: p.category, kind: null, blob: p.blob, selected: true, url: URL.createObjectURL(p.blob),
  }));
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>${plural(drafts.length, 'Teil', 'Teile')} gefunden</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <p class="note">Wähle aus, was in den Schrank soll. Namen und Kategorien kannst du anpassen.</p>
    <div class="multi-list">
      ${drafts.map((dr, i) => `<div class="multi-item">
        <input type="checkbox" class="multi-check" data-sel="${i}" checked aria-label="Teil ${i + 1} übernehmen">
        <div class="multi-thumb"><img class="sticker" src="${dr.url}" alt=""></div>
        <div class="multi-fields">
          <input class="input" data-name="${i}" placeholder="${esc(defaultName(dr))}" maxlength="60" autocomplete="off">
          <select class="input" data-cat="${i}">${CATEGORIES.map((c) => `<option value="${c.id}"${c.id === dr.category ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </div>
      </div>`).join('')}
    </div>
    <button class="btn btn-primary btn-block" id="multi-save" disabled>Wird analysiert …</button>
  </div>`);
  const saveBtn = $('#multi-save', sheet);
  const refresh = (i) => { const el = sheet.querySelector(`[data-name="${i}"]`); if (el) el.placeholder = defaultName(drafts[i]); };
  const updateCount = () => {
    const n = drafts.filter((d) => d.selected).length;
    saveBtn.textContent = n ? `${plural(n, 'Teil', 'Teile')} hinzufügen` : 'Nichts ausgewählt';
    saveBtn.disabled = !n;
  };
  sheet.querySelectorAll('[data-sel]').forEach((el) => { el.onchange = () => { drafts[el.dataset.sel].selected = el.checked; updateCount(); }; });
  sheet.querySelectorAll('[data-name]').forEach((el) => { el.oninput = () => { drafts[el.dataset.name].name = el.value; }; });
  sheet.querySelectorAll('[data-cat]').forEach((el) => {
    el.onchange = () => { const d = drafts[el.dataset.cat]; d.category = el.value; d.catTouched = true; refresh(el.dataset.cat); };
  });

  // Jedes Teil einzeln nachschärfen: Farben, Art, Muster, Style (FashionSigLIP ist auf Einzelteilen sehr treffsicher)
  (async () => {
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      try {
        const r = await analyzeItem({ front: d.blob });
        if (!alive()) return;
        d.analysisResult = r;
        d.kind = { category: r.category, word: KIND_DE[r.kindLabel] || catById(r.category).one };
        Object.assign(d, { colors: r.colors, color: r.color, pattern: r.pattern, styles: r.styles });
        if (!d.catTouched && r.confidence > 0.6) {
          d.category = r.category;
          const sel = sheet.querySelector(`[data-cat="${i}"]`);
          if (sel) sel.value = r.category;
        }
        refresh(i);
      } catch (err) { console.warn('Analyse eines Teils fehlgeschlagen', err); }
    }
    if (alive()) updateCount();
  })();

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    let added = 0;
    for (const d of drafts) {
      if (!d.selected) continue;
      const now = Date.now();
      const item = draftToItem(d, { id: db.uid(), image: d.blob, cutout: true, aspect: await imageAspect(d.blob), createdAt: now, updatedAt: now });
      await db.put('items', item);
      sync.markChanged('item', item.id, 'put', { image: true });
      state.items.unshift(item);
      added++;
    }
    drafts.forEach((d) => URL.revokeObjectURL(d.url));
    closeSheet();
    render();
    toast(`${plural(added, 'Teil', 'Teile')} hinzugefügt`);
  };
}

/* ---------- Teil ansehen / bearbeiten ---------- */
function openItemSheet(item) {
  const d = {
    name: item.name, brand: item.brand || '', category: item.category, color: item.color, colors: colorsOf(item),
    pattern: item.pattern || 'uni', styles: item.styles || [],
    back: item.back || null, backCutout: !!item.backCutout, backChanged: false,
    // Bereits gespeicherte Werte gelten als "von dir gewählt": Neu analysieren schlägt nur vor
    catTouched: true,
  };
  const usedIn = state.outfits.filter((o) => o.pieces.some((p) => p.itemId === item.id)).length;
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>${esc(item.name)}</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    ${previewHtml('item-preview')}
    <div class="row back-row">
      <button class="btn btn-ghost" id="item-back">${item.back ? 'Rückseite ersetzen' : 'Rückseite hinzufügen'}</button>
      <button class="btn btn-ghost" id="item-back-remove"${item.back ? '' : ' hidden'}>Rückseite entfernen</button>
    </div>
    ${usedIn || item.wears?.length ? `<p class="note">${[
      usedIn ? `Kommt in ${plural(usedIn, 'Outfit', 'Outfits')} vor.` : '',
      item.wears?.length ? `Zuletzt getragen: ${new Date(item.wears[item.wears.length - 1] + 'T12:00:00').toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' })} (${plural(item.wears.length, 'Mal', 'Mal')} in letzter Zeit).` : '',
    ].filter(Boolean).join(' ')}</p>` : ''}
    ${itemFieldsHtml(d)}
    <button class="btn btn-ghost btn-block" id="item-reanalyze" style="margin-bottom:14px">Farben, Muster & Style neu erkennen</button>
    <div class="stack">
      <button class="btn btn-primary btn-block" id="item-save">Änderungen speichern</button>
      <div class="row">
        <button class="btn btn-ghost" id="item-studio">Im Studio verwenden</button>
        <button class="btn btn-danger" id="item-delete">Löschen</button>
      </div>
    </div>
  </div>`);
  bindItemFields(d);
  const view = bindPreview($('#item-preview', sheet), (side) => (side === 'back'
    ? { blob: d.back, cutout: d.backCutout }
    : { blob: item.image, cutout: item.cutout }));
  view.setHasBack(!!d.back);
  view.show('front');

  const backBtn = $('#item-back', sheet);
  const backRemove = $('#item-back-remove', sheet);
  const reBtn = $('#item-reanalyze', sheet);
  const reanalyze = async () => {
    reBtn.disabled = true;
    reBtn.textContent = 'Wird analysiert …';
    try {
      // Bewusst neu erkennen: Farben, Muster und Style dürfen überschrieben werden, Kategorie und Name nicht
      d.colorsTouched = d.patternTouched = d.stylesTouched = false;
      applyAnalysis(d, await analyzeItem({ front: item.image, back: d.back }, (f) => {
        if (f < 1) reBtn.textContent = `KI-Modell wird geladen · ${Math.round(f * 100)} %`;
      }));
    } catch (err) {
      console.warn(err);
      toast('Analyse fehlgeschlagen');
    }
    reBtn.disabled = false;
    reBtn.textContent = 'Farben, Muster & Style neu erkennen';
  };
  reBtn.onclick = reanalyze;
  backBtn.onclick = async () => {
    const f = await pickPhoto();
    if (!f || !sheet.open) return;
    backBtn.disabled = true;
    backBtn.textContent = 'Wird freigestellt …';
    try {
      const p = await preparePhoto(f);
      // Wie die Vorderseite: freigestellt, wenn die Vorderseite freigestellt ist
      const cut = item.cutout && !!p.cutout;
      Object.assign(d, { back: cut ? p.cutout : p.original, backCutout: cut, backChanged: true });
      view.setHasBack(true);
      view.show('back');
      backRemove.hidden = false;
      await reanalyze();
    } catch (err) {
      console.warn(err);
      toast('Die Rückseite konnte nicht gelesen werden');
    }
    backBtn.disabled = false;
    backBtn.textContent = d.back ? 'Rückseite ersetzen' : 'Rückseite hinzufügen';
  };
  backRemove.onclick = () => {
    Object.assign(d, { back: null, backCutout: false, backChanged: true });
    view.setHasBack(false);
    backRemove.hidden = true;
    backBtn.textContent = 'Rückseite hinzufügen';
    reanalyze();
  };

  $('#item-save', sheet).onclick = async () => {
    draftToItem(d, item);
    item.updatedAt = Date.now();
    if (d.backChanged) {
      dropUrl(item.id, { backOnly: true });
      if (d.back) Object.assign(item, { back: d.back, backCutout: d.backCutout, backRev: item.updatedAt });
      else { delete item.back; delete item.backCutout; item.backRev = null; }
    }
    await db.put('items', item);
    sync.markChanged('item', item.id, 'put', { back: d.backChanged });
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

/** Standard-Platz eines Teils auf der Fläche (weicht bereits belegten Plätzen aus). */
function placePiece(item, pieces) {
  const { slot } = catById(item.category);
  const aspect = item.aspect || 1;
  let w = slot.w;
  const heightPct = (w * aspect) / STAGE_RATIO;
  if (heightPct > slot.maxH) w = (slot.maxH * STAGE_RATIO) / aspect;
  let { x, y } = slot;
  let guard = 0;
  while (pieces.some((p) => Math.abs(p.x - x) < 3 && Math.abs(p.y - y) < 3) && guard++ < 10) {
    x += 6; y += 5;
  }
  return { pid: db.uid(), itemId: item.id, x: clamp(x, 5, 95), y: clamp(y, 5, 95), w: clamp(w, 8, 90), z: slot.z };
}
/** Fertig angeordnete Fläche für eine Liste von Teilen (Vorschläge, Zufall). */
function autoLayout(items) {
  const pieces = [];
  for (const it of items) pieces.push(placePiece(it, pieces));
  return pieces;
}

function addToStudio(item, { select = true } = {}) {
  const piece = placePiece(item, state.studio.pieces);
  piece.z = Math.max(piece.z, maxZ() + 1);
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

/** Zufall im Studio: ein passendes Outfit (Wetter von heute, Farben, Abwechslung) mit etwas Zufall. */
function shuffleOutfit() {
  const res = suggest(state.items, { day: forecastFor(0), date: isoDate(0), seed: Math.floor(Math.random() * 1e9), count: 3 });
  const pickOne = res.outfits[Math.floor(Math.random() * res.outfits.length)];
  if (!pickOne) { toast(res.problem || 'Füge erst Oberteile, Hosen oder Schuhe hinzu'); return; }
  state.studio = { id: null, name: '', pieces: autoLayout(pickOne.items) };
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
      <button class="btn btn-ghost btn-block" id="outfit-worn">Heute getragen</button>
      <button class="btn btn-primary btn-block" id="outfit-edit">Im Studio bearbeiten</button>
      <button class="btn btn-danger" id="outfit-delete">Outfit löschen</button>
    </div>
  </div>`);
  renderStage($('#outfit-stage', sheet), outfit.pieces, false);
  const wornBtn = $('#outfit-worn', sheet);
  const outfitItems = () => outfit.pieces.map((p) => itemById(p.itemId)).filter(Boolean);
  const refreshWorn = () => { wornBtn.textContent = isWorn(outfitItems(), isoDate(0)) ? 'Heute getragen ✓' : 'Heute getragen'; };
  refreshWorn();
  wornBtn.onclick = async () => { await toggleWorn(outfitItems(), isoDate(0)); refreshWorn(); };
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

/* ---------- Heute: Wetter + Outfit-Vorschläge ---------- */
/** Datum als 'YYYY-MM-DD' in lokaler Zeit (offset: 0 = heute, 1 = morgen). */
function isoDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const LS_TODAY = 'heute-filter';
const savedFilter = (() => { try { return JSON.parse(localStorage.getItem(LS_TODAY) || '{}'); } catch { return {}; } })();
state.today = {
  day: 0, style: savedFilter.style || null, occasion: savedFilter.occasion || null,
  pinned: [], seed: Math.floor(Math.random() * 1e9), lastShown: [],
  forecast: null, weatherState: 'idle', weatherError: '', result: null,
};
function saveFilter() {
  try { localStorage.setItem(LS_TODAY, JSON.stringify({ style: state.today.style, occasion: state.today.occasion })); } catch { /* egal */ }
}
/** Vorhersage für den gewählten Tag (null ohne Ort oder ohne Daten). */
function forecastFor(offset) {
  const days = state.today.forecast;
  if (!days) return null;
  return days.find((d) => d.date === isoDate(offset)) || days[offset] || null;
}

async function loadWeather({ force = false } = {}) {
  const loc = weather.getLocation();
  if (!loc) { state.today.weatherState = 'none'; state.today.forecast = null; renderWeather(); return; }
  state.today.weatherState = 'loading';
  renderWeather();
  try {
    state.today.forecast = await weather.getForecast(loc, { force });
    state.today.weatherState = 'ok';
  } catch (err) {
    console.warn('Wetter', err);
    state.today.weatherState = 'error';
    state.today.weatherError = err.message;
  }
  state.today.result = null;
  if (state.view === 'today') renderToday();
}

const fmtTemp = (t) => `${Math.round(t)}°`;
function renderWeather() {
  const el = $('#weather-card');
  if (!el) return;
  const t = state.today;
  const loc = weather.getLocation();
  if (t.weatherState === 'none' || !loc) {
    el.innerHTML = `<div class="weather-main"><span class="weather-icon">🌤️</span><div>
        <div class="weather-temp">Wetter einrichten</div>
        <div class="weather-text">Mit deinem Ort passen die Vorschläge zum Wetter.</div>
      </div></div>
      <button class="btn btn-ghost" data-action="weather-location">Ort festlegen</button>`;
    return;
  }
  if (t.weatherState === 'loading' && !t.forecast) {
    el.innerHTML = `<div class="weather-main"><span class="weather-icon">⏳</span><div><div class="weather-text">Wetter für ${esc(loc.name)} wird geladen …</div></div></div>`;
    return;
  }
  const day = forecastFor(t.day);
  if (!day) {
    el.innerHTML = `<div class="weather-main"><span class="weather-icon">⚠️</span><div>
        <div class="weather-temp">Wetter nicht verfügbar</div>
        <div class="weather-text">${esc(t.weatherError || 'Keine Daten')} – Vorschläge ohne Wetter.</div>
      </div></div>
      <div class="row weather-actions"><button class="btn btn-ghost" data-action="weather-retry">Nochmal</button><button class="btn btn-ghost" data-action="weather-location">${esc(loc.name)}</button></div>`;
    return;
  }
  const d = weather.describe(day.code);
  const needs = weatherNeeds(day);
  el.innerHTML = `<div class="weather-main"><span class="weather-icon" aria-hidden="true">${d.icon}</span><div>
      <div class="weather-temp">${fmtTemp(day.tMax)} <span>/ ${fmtTemp(day.tMin)}</span></div>
      <div class="weather-text">${esc(d.text)} · gefühlt ${fmtTemp(needs.feels)} · Regen ${Math.round(day.rainProb)} %${day.wind >= 30 ? ` · Wind ${Math.round(day.wind)} km/h` : ''}</div>
      <div class="weather-tip">${esc(weatherTip(needs))}</div>
    </div></div>
    <button class="btn btn-ghost weather-loc" data-action="weather-location" title="Ort ändern">
      <svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/></svg>${esc(loc.name)}
    </button>`;
}

function renderToday() {
  const t = state.today;
  const dayDate = new Date();
  dayDate.setDate(dayDate.getDate() + t.day);
  $('#today-title').textContent = t.day ? 'Morgen' : 'Heute';
  $('#today-date').textContent = dayDate.toLocaleDateString('de-CH', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#today-day').querySelectorAll('[data-day]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.day === t.day)));
  renderWeather();

  const chipRow = (el, list, current) => {
    el.innerHTML = [{ id: '', name: 'Alle' }, ...list].map((o) => `<button class="chip" data-id="${o.id}" aria-selected="${(current || '') === o.id}">${esc(o.name)}</button>`).join('');
  };
  chipRow($('#today-occasion'), OCCASIONS, t.occasion);
  chipRow($('#today-style'), STYLES, t.style);

  // Fixierte Teile (nur solche, die es noch gibt)
  t.pinned = t.pinned.filter((id) => itemById(id));
  const pinnedEl = $('#today-pinned');
  pinnedEl.hidden = !t.pinned.length;
  pinnedEl.innerHTML = t.pinned.length
    ? `<span class="filter-label">Fixiert</span>${t.pinned.map((id) => `<button class="chip chip-sm pin-chip" data-unpin="${id}">${esc(itemById(id).name)} ✕</button>`).join('')}`
    : '';

  if (t.result && t.resultSig !== itemsSig()) t.result = null; // Schrank hat sich geändert
  if (!t.result) {
    t.resultSig = itemsSig();
    t.result = suggest(state.items, {
      day: forecastFor(t.day), date: isoDate(t.day), style: t.style, occasion: t.occasion,
      pinned: t.pinned, seed: t.seed, count: 3, avoid: t.lastShown,
    });
  }
  const { outfits, problem } = t.result;
  const grid = $('#today-grid');
  const empty = $('#today-empty');
  empty.hidden = !!outfits.length;
  $('#today-reroll').hidden = !outfits.length;
  if (!outfits.length) {
    grid.innerHTML = '';
    empty.innerHTML = `<h2>Noch kein Vorschlag</h2><p>${esc(problem)}</p>
      ${state.items.length ? '' : '<button class="btn btn-primary" data-action="add-item">Teil hinzufügen</button>'}
      ${t.pinned.length || t.style || t.occasion ? '<button class="btn btn-ghost" data-action="today-reset">Filter zurücksetzen</button>' : ''}`;
    return;
  }
  grid.innerHTML = outfits.map((o, i) => {
    const worn = isWorn(o.items, isoDate(0));
    return `<div class="card outfit-card today-card" data-idx="${i}">
      <div class="stage"></div>
      <div class="card-meta" style="padding-top:12px">
        <div class="card-title">Vorschlag ${i + 1}</div>
        <div class="card-sub card-sub-text">${esc(o.items.map((it) => it.name).join(' · '))}</div>
        <div class="today-card-actions">
          ${t.day === 0 ? `<button class="btn btn-ghost btn-sm" data-act="worn" aria-pressed="${worn}">${worn ? 'Getragen ✓' : 'Heute getragen'}</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-act="save">Speichern</button>
          <button class="btn btn-ghost btn-sm" data-act="studio">Studio</button>
        </div>
      </div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.today-card').forEach((card) => {
    const o = outfits[+card.dataset.idx];
    const stage = $('.stage', card);
    // pid = Item-id, damit ein Antippen das Teil fixieren kann
    renderStage(stage, autoLayout(o.items).map((p) => ({ ...p, pid: p.itemId })), false);
    stage.querySelectorAll('.piece').forEach((p) => p.classList.toggle('pinned', t.pinned.includes(p.dataset.pid)));
  });
}

/** Neue Vorschläge berechnen (z. B. nach Filterwechsel). reroll: neue Zufallsauswahl, zuletzt gezeigte Oberteile meiden. */
function refreshSuggestions({ reroll = false } = {}) {
  const t = state.today;
  if (reroll) {
    t.lastShown = (t.result?.outfits || []).map((o) => o.items[0].id);
    t.seed = Math.floor(Math.random() * 1e9);
  }
  t.result = null;
  renderToday();
}

const itemsSig = () => `${state.items.length}:${state.items.reduce((m, i) => Math.max(m, i.updatedAt || 0), 0)}`;
const isWorn = (items, date) => items.length > 0 && items.every((it) => it.wears?.includes(date));
/** Markiert alle Teile als an diesem Tag getragen – oder nimmt die Markierung zurück. */
async function toggleWorn(items, date) {
  const undo = isWorn(items, date);
  for (const it of items) {
    const set = new Set(it.wears || []);
    if (undo) set.delete(date); else set.add(date);
    it.wears = [...set].sort().slice(-30);
    it.updatedAt = Date.now();
    await db.put('items', it);
    sync.markChanged('item', it.id, 'put');
  }
  // Die angezeigten Vorschläge bleiben stehen (sonst verschwände das gerade getragene Outfit)
  if (state.today.result) state.today.resultSig = itemsSig();
  toast(undo ? 'Markierung entfernt' : 'Als heute getragen gespeichert');
  return !undo;
}

async function saveSuggestion(items) {
  const pieces = autoLayout(items);
  const outfit = { id: db.uid(), name: suggestOutfitName(pieces), pieces, createdAt: Date.now(), updatedAt: Date.now() };
  await db.put('outfits', outfit);
  sync.markChanged('outfit', outfit.id, 'put');
  state.outfits = [outfit, ...state.outfits];
  toast(`„${outfit.name}“ gespeichert`);
}

function bindToday() {
  $('#today-day').onclick = (e) => {
    const b = e.target.closest('[data-day]');
    if (!b || +b.dataset.day === state.today.day) return;
    state.today.day = +b.dataset.day;
    refreshSuggestions();
  };
  $('#today-occasion').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.today.occasion = b.dataset.id || null;
    saveFilter();
    refreshSuggestions();
  };
  $('#today-style').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.today.style = b.dataset.id || null;
    saveFilter();
    refreshSuggestions();
  };
  $('#today-pinned').onclick = (e) => {
    const b = e.target.closest('[data-unpin]');
    if (!b) return;
    state.today.pinned = state.today.pinned.filter((id) => id !== b.dataset.unpin);
    refreshSuggestions();
  };
  $('#today-reroll').onclick = () => refreshSuggestions({ reroll: true });
  $('#today-grid').onclick = async (e) => {
    const card = e.target.closest('.today-card');
    if (!card) return;
    const o = state.today.result?.outfits[+card.dataset.idx];
    if (!o) return;
    const piece = e.target.closest('.piece');
    if (piece) {
      // Teil fixieren / lösen. Pro Kategorie nur ein fixiertes Teil.
      const t = state.today;
      const id = piece.dataset.pid;
      const cat = itemById(id)?.category;
      t.pinned = t.pinned.includes(id) ? t.pinned.filter((x) => x !== id) : [...t.pinned.filter((x) => itemById(x)?.category !== cat), id];
      refreshSuggestions();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'worn') {
      const btn = e.target.closest('[data-act]');
      btn.disabled = true;
      const worn = await toggleWorn(o.items, isoDate(0));
      btn.disabled = false;
      btn.textContent = worn ? 'Getragen ✓' : 'Heute getragen';
      btn.setAttribute('aria-pressed', String(worn));
    } else if (act === 'save') {
      const btn = e.target.closest('[data-act]');
      btn.disabled = true;
      await saveSuggestion(o.items);
      btn.textContent = 'Gespeichert';
    } else if (act === 'studio') {
      state.studio = { id: null, name: '', pieces: autoLayout(o.items) };
      state.selected = null;
      saveDraft();
      show('studio');
    }
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'weather-location') openLocationSheet();
    if (a === 'weather-retry') loadWeather({ force: true });
    if (a === 'today-reset') {
      Object.assign(state.today, { style: null, occasion: null, pinned: [] });
      saveFilter();
      refreshSuggestions();
    }
  });
}

/** Ort für das Wetter festlegen: Suche nach Name oder aktueller Standort. */
function openLocationSheet() {
  const loc = weather.getLocation();
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>Ort fürs Wetter</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <p class="note">Für die Vorhersage werden nur die (auf ca. 1 km gerundeten) Koordinaten an Open-Meteo geschickt. Der Ort bleibt auf diesem Gerät.</p>
    <form id="loc-form" class="row" style="margin-bottom:12px" novalidate>
      <input class="input" id="loc-q" placeholder="Ort, z. B. Zürich" autocomplete="off" value="${loc?.source === 'city' ? esc(loc.name) : ''}">
      <button class="btn btn-primary" type="submit" style="flex:none">Suchen</button>
    </form>
    <div class="loc-results" id="loc-results"></div>
    <button class="btn btn-ghost btn-block" id="loc-gps" style="margin-bottom:10px">Aktuellen Standort verwenden</button>
    ${loc ? '<button class="btn btn-danger btn-block" id="loc-clear">Wetter ausschalten</button>' : ''}
  </div>`);
  const results = $('#loc-results', sheet);
  const choose = async (l) => {
    weather.setLocation(l);
    closeSheet();
    await loadWeather({ force: true });
  };
  $('#loc-form', sheet).onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#loc-q', sheet).value.trim();
    if (q.length < 2) return;
    results.innerHTML = '<p class="note">Suche …</p>';
    try {
      const list = await weather.searchCity(q);
      results.innerHTML = list.length
        ? list.map((r, i) => `<button class="loc-result" data-i="${i}"><b>${esc(r.name)}</b><span>${esc(r.detail)}</span></button>`).join('')
        : '<p class="note">Kein Ort gefunden.</p>';
      results.onclick = (ev) => {
        const b = ev.target.closest('[data-i]');
        if (b) { const r = list[+b.dataset.i]; choose({ name: r.name, lat: r.lat, lon: r.lon, source: 'city' }); }
      };
    } catch (err) {
      results.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  };
  $('#loc-gps', sheet).onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Standort wird ermittelt …';
    try {
      const p = await weather.currentPosition();
      await choose({ name: 'Mein Standort', ...p, source: 'gps' });
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Aktuellen Standort verwenden';
    }
  };
  $('#loc-clear', sheet)?.addEventListener('click', async () => {
    weather.setLocation(null);
    closeSheet();
    await loadWeather();
  });
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
    ${installHtml()}
    <h3 class="section-title" style="margin-top:18px">Backup</h3>
    <p class="note">${sync.status.signedIn ? 'Zusätzlich zum Sync kannst du jederzeit eine Sicherungsdatei erstellen.' : 'Ohne Konto wird alles nur auf diesem Gerät gespeichert. Mit einer Sicherungsdatei kannst du die Daten sichern oder übertragen.'}</p>
    <div class="stack">
      <button class="btn btn-ghost btn-block" id="do-export">Backup exportieren</button>
      <button class="btn btn-ghost btn-block" id="do-import">Backup importieren</button>
    </div>
  </div>`);
  $('#do-install', sheet)?.addEventListener('click', async () => { await installApp(); if (sheet.open) openSettingsSheet(); });
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
    <p class="note" style="margin-top:14px;text-align:center">${signup ? 'Schon ein Konto? <a href="#" id="auth-switch">Anmelden</a>' : 'Noch kein Konto? <a href="#" id="auth-switch">Konto erstellen</a> · <a href="#" id="auth-forgot">Passwort vergessen?</a>'}</p>
  </div>`);
  $('#auth-switch', sheet).onclick = (e) => { e.preventDefault(); openAuthSheet(signup ? 'signin' : 'signup'); };
  $('#auth-forgot', sheet)?.addEventListener('click', (e) => { e.preventDefault(); openForgotSheet($('#auth-email', sheet).value.trim()); });
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

/** Passwort vergessen, Schritt 1: Link per E-Mail anfordern. */
function openForgotSheet(prefill = '') {
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>Passwort vergessen</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <p class="note">Du bekommst einen Link per E-Mail. Danach brauchst du deinen <b>Wiederherstellungs-Code</b> – ohne ihn lassen sich deine Daten nicht entschlüsseln.</p>
    <form id="forgot-form" novalidate>
      <label class="field"><span>E-Mail</span>
        <input class="input" type="email" id="forgot-email" autocomplete="username" value="${esc(prefill)}" required>
      </label>
      <p class="form-error" id="forgot-error" hidden></p>
      <button class="btn btn-primary btn-block" id="forgot-submit" type="submit">Link schicken</button>
    </form>
  </div>`);
  const errorEl = $('#forgot-error', sheet);
  $('#forgot-form', sheet).onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#forgot-email', sheet).value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errorEl.textContent = 'Bitte eine gültige E-Mail-Adresse eingeben.'; errorEl.hidden = false; return; }
    const btn = $('#forgot-submit', sheet);
    btn.disabled = true;
    btn.textContent = 'Einen Moment …';
    try {
      await sync.requestPasswordReset(email);
      openInfoSheet('E-Mail unterwegs', `Falls es ein Konto für <b>${esc(email)}</b> gibt, ist ein Link unterwegs. Öffne ihn (gerne direkt auf dem Gerät, auf dem du die Mail liest) und halte deinen Wiederherstellungs-Code bereit.`);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Link schicken';
    }
  };
}

/** Passwort vergessen, Schritt 2: App wurde über den Link geöffnet. */
function openResetSheet(tokens) {
  openSheet(`<div class="sheet-inner">
    <div class="sheet-head"><h2>Neues Passwort</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.close}</button></div>
    <p class="note">Gib deinen Wiederherstellungs-Code ein und lege ein neues Passwort fest.</p>
    <form id="reset-form" novalidate>
      <label class="field"><span>Wiederherstellungs-Code</span>
        <input class="input" id="reset-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" required>
      </label>
      <label class="field"><span>Neues Passwort (mind. 10 Zeichen)</span>
        <input class="input" type="password" id="reset-pw" autocomplete="new-password" required>
      </label>
      <label class="field"><span>Neues Passwort wiederholen</span>
        <input class="input" type="password" id="reset-pw2" autocomplete="new-password" required>
      </label>
      <p class="form-error" id="reset-error" hidden></p>
      <button class="btn btn-primary btn-block" id="reset-submit" type="submit">Passwort speichern</button>
    </form>
  </div>`);
  const errorEl = $('#reset-error', sheet);
  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = !msg; };
  $('#reset-form', sheet).onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#reset-code', sheet).value.trim();
    const pw = $('#reset-pw', sheet).value;
    if (code.replace(/[^A-Za-z0-9]/g, '').length !== 24) return showError('Der Code hat 24 Zeichen (6 Blöcke à 4).');
    if (pw.length < 10) return showError('Das Passwort muss mindestens 10 Zeichen lang sein.');
    if (pw !== $('#reset-pw2', sheet).value) return showError('Die Passwörter stimmen nicht überein.');
    showError('');
    const btn = $('#reset-submit', sheet);
    btn.disabled = true;
    btn.textContent = 'Einen Moment …';
    try {
      await sync.completeReset(tokens, code, pw);
      closeSheet();
      toast('Neues Passwort gespeichert – Sync läuft');
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = 'Passwort speichern';
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
  // Bilder können sich auf dem anderen Gerät geändert haben (z. B. neue Rückseite) -> Vorschau-Adressen neu erzeugen
  for (const id of [...urls.keys()]) URL.revokeObjectURL(urls.get(id));
  urls.clear();
  state.items = items.sort((a, b) => b.createdAt - a.createdAt);
  state.outfits = outfits.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  if (!sheet.open) render();
  backfillAnalysis();
}

/* ---------- Bestand nachanalysieren ----------
   Teile ohne (aktuelle) Analyse bekommen Farben, Muster, Style und Saison nachgetragen.
   Läuft im Hintergrund, ein Teil nach dem anderen. Was du selbst gesetzt hast, bleibt erhalten. */
const backfill = { running: false, done: 0, total: 0, failed: new Set() };
async function backfillAnalysis() {
  const todo = () => state.items.filter((i) => (i.analysis || 0) < ANALYSIS_VERSION && !backfill.failed.has(i.id));
  if (backfill.running || !todo().length) return;
  backfill.running = true;
  backfill.done = 0;
  try {
    for (let list = todo(); list.length; list = todo()) {
      backfill.total = backfill.done + list.length;
      renderWardrobeCount();
      const { id } = list[0];
      try {
        const start = itemById(id);
        const r = await analyzeItem({ front: start.image, back: start.back });
        const cur = itemById(id); // während der Analyse kann ein Sync die Liste ersetzt haben
        if (cur && (cur.analysis || 0) < ANALYSIS_VERSION) {
          await db.put('items', mergeAnalysis(cur, r));
          sync.markChanged('item', id, 'put');
        }
      } catch (err) {
        console.warn('Nachanalyse fehlgeschlagen', id, err);
        backfill.failed.add(id);
      }
      backfill.done++;
      if (state.view === 'wardrobe' && !sheet.open) renderWardrobe();
    }
  } finally {
    backfill.running = false;
    backfill.total = 0;
    renderWardrobeCount();
  }
}
/** Analyse in ein bestehendes Teil einfügen, ohne bereits gesetzte Werte zu überschreiben. */
function mergeAnalysis(it, r) {
  let colors = r.colors;
  // Die bisherige Farbe (evtl. von dir gewählt) bleibt Hauptfarbe. Ist sie neu gar nicht dabei,
  // ersetzt sie die erkannte Hauptfarbe (meist derselbe Ton, nur anders benannt, z. B. Creme: Weiß/Beige).
  if (it.color && it.color !== 'bunt' && colors[0].id !== it.color) {
    const own = colors.find((c) => c.id === it.color);
    colors = own
      ? [own, ...colors.filter((c) => c !== own)]
      : [{ id: it.color, share: colors[0].share }, ...colors.slice(1)];
  }
  return Object.assign(it, {
    colors: it.colors?.length ? it.colors : colors,
    color: it.color || r.color,
    pattern: it.pattern || r.pattern,
    styles: it.styles?.length ? it.styles : r.styles,
    kindLabel: it.kindLabel || r.kindLabel,
    patternScores: r.patternScores, styleScores: r.styleScores, warmth: r.warmth, emb: r.emb,
    analysis: r.analysis,
    updatedAt: Date.now(),
  });
}

async function exportBackup() {
  const btn = $('#do-export', sheet);
  if (btn) { btn.disabled = true; btn.textContent = 'Wird erstellt …'; }
  const items = await Promise.all(state.items.map(async ({ image, back, ...rest }) => ({
    ...rest, image: await blobToDataUrl(image), ...(back ? { back: await blobToDataUrl(back) } : {}),
  })));
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
      if (raw.back) item.back = await dataUrlToBlob(raw.back);
      await db.put('items', item);
      sync.markChanged('item', item.id, 'put', { image: true, back: !!item.back });
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

  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
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
  $('#btn-install').addEventListener('click', installApp);
  renderInstall();
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
  bindToday();
  // Wetter laden; bei "Mein Standort" vorher still den aktuellen Standort holen (nur wenn schon erlaubt)
  (async () => {
    const loc = weather.getLocation();
    if (loc?.source === 'gps') {
      try {
        const perm = await navigator.permissions?.query({ name: 'geolocation' });
        if (perm?.state === 'granted') {
          const p = await weather.currentPosition();
          if (p.lat !== loc.lat || p.lon !== loc.lon) weather.setLocation({ ...loc, ...p });
        }
      } catch { /* alter Standort bleibt */ }
    }
    await loadWeather();
  })();

  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (v !== state.view) show(v);
  });
  // Wurde die App über einen Link aus einer E-Mail geöffnet (Bestätigung / Passwort vergessen)?
  const authRedirect = sync.available() ? sync.readAuthRedirect() : null;
  if (authRedirect) history.replaceState(null, '', location.pathname + location.search); // Tokens aus der Adresse entfernen

  show(location.hash.slice(1) || 'today');
  db.requestPersistence();
  sync.init().catch((err) => console.warn('Sync-Start', err));
  setTimeout(backfillAnalysis, 2500); // Bestand nachanalysieren, sobald die App bereit ist

  if (authRedirect?.error) openInfoSheet('Link ungültig', `${esc(authRedirect.error)}. Bitte fordere einen neuen Link an.`);
  else if (authRedirect?.type === 'recovery') openResetSheet(authRedirect);
  else if (authRedirect?.type === 'signup') openInfoSheet('E-Mail bestätigt', 'Super! Melde dich jetzt unter dem Zahnrad mit deiner E-Mail und deinem Passwort an.');

  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker', err));
  }
}

init().catch((err) => {
  console.error(err);
  toast('Die App konnte nicht starten: ' + err.message);
});
