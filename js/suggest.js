// Outfit-Vorschläge: lokal, regelbasiert. Bewertet Kombinationen nach Wetter, Style/Anlass,
// Farb- und Musterharmonie und Abwechslung (zuletzt getragene Teile seltener).
// Reine Rechen-Logik ohne Oberfläche – gut testbar.

/* ---------- Wärme ---------- */
// Wie warm ein Teil ist (0 = sehr leicht, 1 = sehr warm), nach erkannter Art (kindLabel aus labels.json).
const KIND_WARMTH = {
  'a t-shirt': 0.2, 'a shirt': 0.35, 'a polo shirt': 0.25, 'a sweater': 0.7, 'a hoodie': 0.6, 'a sweatshirt': 0.55,
  'a long sleeve top': 0.4, 'a tank top': 0.05, 'a blouse': 0.3, 'a knitted pullover': 0.75,
  'a jacket': 0.6, 'a coat': 0.9, 'a bomber jacket': 0.6, 'a denim jacket': 0.45, 'a blazer': 0.4, 'a cardigan': 0.45,
  'a puffer jacket': 1, 'a vest': 0.35,
  'a dress': 0.3, 'a jumpsuit': 0.4, 'a long dress': 0.35, 'a summer dress': 0.1,
  'a pair of pants': 0.5, 'jeans': 0.5, 'trousers': 0.5, 'shorts': 0.05, 'a skirt': 0.3, 'sweatpants': 0.55,
  'chinos': 0.45, 'leggings': 0.4,
  'a pair of shoes': 0.5, 'sneakers': 0.45, 'boots': 0.85, 'sandals': 0, 'leather dress shoes': 0.5, 'heels': 0.35,
  'loafers': 0.4,
};
const SUMMER_ONLY = new Set(['shorts', 'sandals', 'a tank top', 'a summer dress']);
// Ab dieser gefühlten Temperatur zu warm
const TOO_WARM_ABOVE = { 'a puffer jacket': 11, gloves: 8, 'a coat': 16, boots: 22, 'a knitted pullover': 23 };
// Eher für Sport/Zuhause: ohne passenden Anlass seltener vorschlagen
const LOUNGE = new Set(['sweatpants', 'leggings']);
const COLD_ACCESSORIES = new Set(['a scarf', 'gloves', 'a hat']);
const SUN_ACCESSORIES = new Set(['sunglasses', 'a cap']);

/** Wärme eines Teils: erst nach Art, sonst aus der KI-Einschätzung (Sommer/Übergang/Winter). */
export function itemWarmth(it) {
  if (it.kindLabel in KIND_WARMTH) return KIND_WARMTH[it.kindLabel];
  const w = it.warmth;
  return w ? w.uebergang * 0.5 + w.winter : 0.5;
}

/**
 * Was das Wetter verlangt. day: Eintrag aus weather.getForecast (oder null = ohne Wetter).
 * feels: gefühlte Tagestemperatur, target: gewünschte Wärme 0…1, jacket: 'need' | 'maybe' | 'avoid'.
 */
export function weatherNeeds(day) {
  if (!day) return { feels: null, target: null, jacket: 'maybe', rain: false, cold: false, hot: false, sunny: false };
  const feels = 0.65 * day.feelsMax + 0.35 * day.feelsMin;
  const rain = day.rainProb >= 60 || day.rainSum >= 2;
  const target = Math.min(1, Math.max(0, (24 - feels) / 24));
  const jacket = feels < 15 || rain || (day.wind > 40 && feels < 20) ? 'need' : feels >= 23 && day.rainProb < 40 ? 'avoid' : 'maybe';
  return { feels, target, jacket, rain, cold: feels < 8, hot: feels >= 24, sunny: day.code <= 2 && feels >= 18 };
}

/** Kurzer Kleidungs-Tipp zum Wetter. */
export function weatherTip(n) {
  if (n.feels == null) return '';
  const parts = [];
  if (n.cold) parts.push('Warm anziehen');
  else if (n.hot) parts.push('Leichte Kleidung');
  else if (n.feels < 15) parts.push('Eher warm anziehen');
  else parts.push('Angenehm');
  if (n.jacket === 'need') parts.push(n.rain ? 'Jacke wegen Regen' : 'Jacke nötig');
  else if (n.jacket === 'avoid') parts.push('keine Jacke nötig');
  return parts.join(' · ');
}

/* ---------- Style & Anlass ---------- */
export const OCCASIONS = [
  { id: 'buero', name: 'Büro', styles: { smart: 1, casual: 0.35 }, never: ['sweatpants', 'shorts', 'a tank top', 'sandals', 'leggings', 'a hoodie', 'a cap'] },
  { id: 'freizeit', name: 'Freizeit', styles: { casual: 1, streetwear: 0.8, sport: 0.2 }, never: [] },
  { id: 'sport', name: 'Sport', styles: { sport: 1 }, never: ['leather dress shoes', 'heels', 'loafers', 'a blazer', 'a coat', 'a blouse', 'a shirt', 'trousers', 'chinos', 'jeans', 'a skirt', 'a dress', 'a long dress'] },
  { id: 'ausgehen', name: 'Ausgehen', styles: { smart: 0.8, streetwear: 0.8, casual: 0.4 }, never: ['sweatpants', 'leggings'] },
];
const STYLE_IDS = ['casual', 'streetwear', 'smart', 'sport'];

function wantedStyles(style, occasion) {
  const w = {};
  const occ = OCCASIONS.find((o) => o.id === occasion);
  if (occ) Object.assign(w, occ.styles);
  if (style) w[style] = (w[style] || 0) + 1;
  return Object.keys(w).length ? w : null;
}
function styleVec(it) {
  const s = it.styleScores || {};
  return STYLE_IDS.map((id) => Math.min(1, (s[id] ?? 0.25) + (it.styles?.includes(id) ? 0.5 : 0)));
}
function affinity(it, wants) {
  if (!wants) return 0.5;
  const v = styleVec(it);
  let sum = 0, tot = 0;
  for (const [id, w] of Object.entries(wants)) { sum += w * v[STYLE_IDS.indexOf(id)]; tot += w; }
  return sum / tot;
}
/**
 * Wie gut passt ein Teil zu einem gewählten Style (0…1)? Eingetragene Styles zählen voll,
 * sonst die KI-Einschätzung im Verhältnis zum stärksten Style des Teils (höchstens 0.6).
 */
export function styleMatch(it, style) {
  if (it.styles?.includes(style)) return 1;
  const s = it.styleScores;
  if (!s) return it.styles?.length ? 0.15 : 0.5;
  const max = Math.max(...STYLE_IDS.map((id) => s[id] ?? 0)) || 1;
  return 0.6 * (s[style] ?? 0) / max;
}
/** Vorherrschender Style eines Outfits (für den Namen). */
export function outfitStyle(items) {
  const core = items.filter((i) => !['accessoires', 'schuhe'].includes(i.category));
  const sum = STYLE_IDS.map(() => 0);
  for (const it of core) styleVec(it).forEach((v, k) => { sum[k] += v; });
  return STYLE_IDS[sum.indexOf(Math.max(...sum))];
}
const CORE = new Set(['oberteile', 'hosen', 'kleider', 'jacken']);
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0.5;
}

/* ---------- Farben & Muster ---------- */
// Diese Farben lassen sich mit fast allem kombinieren (Denim = Hellblau zählt dazu)
const NEUTRAL = new Set(['schwarz', 'weiss', 'grau', 'beige', 'navy', 'camel', 'braun', 'hellblau', 'oliv']);
// Ähnliche Töne gelten als eine Farbfamilie
const FAMILY = { bordeaux: 'rot', rosa: 'rot', dunkelgruen: 'gruen', blau: 'blau', lila: 'lila', orange: 'orange', gelb: 'gelb', rot: 'rot', gruen: 'gruen' };
const STATEMENT = new Set(['gestreift', 'kariert', 'gebluemt', 'gepunktet', 'camouflage', 'tierprint', 'gemustert', 'grafik']);

function colorScore(items) {
  const accents = new Set();
  let bunt = 0;
  for (const it of items) {
    if (it.color === 'bunt') { bunt++; continue; }
    if (!NEUTRAL.has(it.color)) accents.add(FAMILY[it.color] || it.color);
  }
  const n = accents.size + bunt;
  let s = n === 0 ? 0.85 : n === 1 ? 1 : n === 2 ? 0.55 : 0.15;
  // Oberteil und Hose in derselben kräftigen Farbe wirkt meist zu viel
  const top = items.find((i) => i.category === 'oberteile');
  const bottom = items.find((i) => i.category === 'hosen');
  if (top && bottom && top.color === bottom.color && !NEUTRAL.has(top.color)) s -= 0.4;
  return s;
}
function patternScore(items) {
  const n = items.filter((i) => i.category !== 'accessoires' && (STATEMENT.has(i.pattern) || i.color === 'bunt')).length;
  return n <= 1 ? 1 : n === 2 ? 0.35 : 0.1;
}

/* ---------- Abwechslung ---------- */
const RECENCY_WEIGHT = { oberteile: 1, kleider: 1, hosen: 0.4, jacken: 0.15, schuhe: 0.1, accessoires: 0.2 };
const dayNum = (iso) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 86400000);
function recency(it, date) {
  if (!it.wears?.length) return 0;
  const last = it.wears.reduce((a, b) => (a > b ? a : b));
  const d = dayNum(date) - dayNum(last);
  if (d < 0) return 0;
  return (RECENCY_WEIGHT[it.category] ?? 0.3) * Math.max(0, 1 - d / 6);
}

/* ---------- Zufall mit Startwert (gleicher Startwert = gleiche Vorschläge) ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- Vorschläge ---------- */
/**
 * items: alle Kleidungsstücke. Optionen:
 *  day (Wetter-Tag oder null), date ('YYYY-MM-DD'), style, occasion, pinned (Item-ids),
 *  seed (Zahl), count (Anzahl Vorschläge), avoid (Item-ids, die zuletzt gezeigt wurden).
 * Liefert { outfits: [{ items, score }], needs, problem } – problem erklärt, warum nichts geht.
 */
export function suggest(items, { day = null, date, style = null, occasion = null, pinned = [], seed = 1, count = 3, avoid = [] } = {}) {
  const needs = weatherNeeds(day);
  const wants = wantedStyles(style, occasion);
  const occ = OCCASIONS.find((o) => o.id === occasion);
  const rand = rng(seed);
  const pinnedSet = new Set(pinned);
  const avoidSet = new Set(avoid);
  date ||= new Date().toISOString().slice(0, 10);

  // Teile, die zum Wetter oder Anlass gar nicht passen, fallen raus (fixierte Teile bleiben immer)
  const allowed = (it) => {
    if (pinnedSet.has(it.id)) return true;
    if (occ?.never.includes(it.kindLabel)) return false;
    if (needs.feels != null) {
      if (SUMMER_ONLY.has(it.kindLabel) && (needs.feels < 16 || (it.kindLabel === 'sandals' && needs.rain))) return false;
      if (needs.feels > (TOO_WARM_ABOVE[it.kindLabel] ?? Infinity)) return false;
    }
    if (occasion === 'sport' && ['oberteile', 'hosen', 'jacken'].includes(it.category) && affinity(it, { sport: 1 }) < 0.3) return false;
    return true;
  };
  const pool = items.filter((it) => it.image && allowed(it));
  const by = (cat) => pool.filter((i) => i.category === cat);

  // Einzelbewertung je Teil (zum Vorsortieren): Wärme, Style, Abwechslung, etwas Zufall
  const unary = new Map();
  for (const it of pool) {
    let s = 2 * affinity(it, wants) - 2.5 * recency(it, date) - (avoidSet.has(it.id) ? 0.8 : 0) + rand() * 0.9;
    if (LOUNGE.has(it.kindLabel) && occasion !== 'sport') s -= 1.2;
    // Gewählter Style: deutlich bevorzugen (bei Schuhen etwas weniger, Accessoires egal)
    if (style && it.category !== 'accessoires') s += (it.category === 'schuhe' ? 1.5 : 3) * (styleMatch(it, style) - 0.5);
    if (needs.target != null && ['schuhe', 'hosen'].includes(it.category)) s -= 1.5 * Math.abs(itemWarmth(it) - (it.category === 'hosen' ? 0.15 + needs.target * 0.4 : needs.target));
    unary.set(it.id, s);
  }
  const pick = (list, k) => {
    const pin = list.filter((i) => pinnedSet.has(i.id));
    if (pin.length) return pin.slice(-1);
    return [...list].sort((a, b) => unary.get(b.id) - unary.get(a.id)).slice(0, k);
  };

  const tops = pick(by('oberteile'), 7);
  const bottoms = pick(by('hosen'), 6);
  const dresses = pick(by('kleider'), 5);
  const jackets = pick(by('jacken'), 5);
  const shoes = pick(by('schuhe'), 4);
  const pinnedCats = new Set(pool.filter((i) => pinnedSet.has(i.id)).map((i) => i.category));

  // Grundlage: Oberteil + Hose oder Kleid (fixierte Teile bestimmen, welche Variante)
  const bases = [];
  if (!pinnedCats.has('kleider')) for (const t of tops) for (const b of bottoms) bases.push([t, b]);
  if (!pinnedCats.has('oberteile') && !pinnedCats.has('hosen')) for (const d of dresses) bases.push([d]);
  if (!bases.length) {
    return { outfits: [], needs, problem: items.length ? 'Für einen Vorschlag fehlen Oberteile und Hosen (oder Kleider), die zum Wetter und Anlass passen.' : 'Füge zuerst Kleidung hinzu.' };
  }

  const jacketOptions = needs.jacket === 'avoid' && !pinnedCats.has('jacken') ? [null]
    : (needs.jacket === 'need' || pinnedCats.has('jacken')) && jackets.length ? jackets
    : [null, ...jackets];
  const shoeOptions = shoes.length ? shoes : [null];

  // Passendes Accessoire nur, wenn das Wetter danach verlangt (oder es fixiert ist)
  const accPinned = pool.filter((i) => i.category === 'accessoires' && pinnedSet.has(i.id));
  let acc = accPinned.slice(-1)[0] || null;
  if (!acc && (needs.cold || needs.sunny)) {
    const wanted = needs.cold ? COLD_ACCESSORIES : SUN_ACCESSORIES;
    acc = pick(by('accessoires').filter((i) => wanted.has(i.kindLabel)), 1)[0] || null;
  }

  const scored = [];
  for (const base of bases) {
    for (const jacket of jacketOptions) {
      for (const shoe of shoeOptions) {
        const outfit = [...base, jacket, shoe, acc].filter(Boolean);
        // Etwas Zufall pro Kombination, damit "Neu würfeln" wirklich Neues zeigt
        scored.push({ items: outfit, score: scoreOutfit(outfit, { base, jacket, shoe, needs, wants, unary, style, sport: occasion === 'sport' }) + rand() * 0.9 - (avoidSet.has(base[0].id) && !pinnedSet.has(base[0].id) ? 1.5 : 0) });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // Unterschiedliche Vorschläge auswählen: möglichst wenig gemeinsame Teile.
  // Nur Kombinationen nahe am besten Ergebnis – lieber weniger Vorschläge als schlechte.
  const floor = scored[0].score - 1.6;
  const good = scored.slice(0, 400).filter((c) => c.score >= floor);
  const chosen = [];
  for (let round = 0; round < count; round++) {
    let best = null, bestScore = -Infinity;
    for (const c of good) {
      if (chosen.includes(c)) continue;
      const shared = chosen.reduce((n, o) => n + c.items.filter((i) => o.items.includes(i) && !pinnedSet.has(i.id) && i.category !== 'accessoires').length, 0);
      const sameBase = chosen.some((o) => o.items[0] === c.items[0]) && !pinnedSet.has(c.items[0].id);
      const s = c.score - shared * 1.2 - (sameBase ? 3 : 0);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best) break;
    chosen.push(best);
  }
  // Hinweis, wenn es im gewählten Style kaum passende Oberteile/Hosen/Kleider gibt
  let note = '';
  if (style) {
    const hits = pool.filter((i) => ['oberteile', 'hosen', 'kleider'].includes(i.category) && styleMatch(i, style) >= 0.5).length;
    if (hits < 2) note = 'Kaum Teile in diesem Style – die Vorschläge kommen ihm nur so nah wie möglich. Trag den Style bei passenden Teilen ein (Teil antippen → Bearbeiten).';
  }
  return { outfits: chosen, needs, problem: '', note };
}

function scoreOutfit(items, { base, jacket, shoe, needs, wants, unary, style, sport }) {
  let s = 0;
  for (const it of items) s += unary.get(it.id) ?? 0;
  s /= items.length;
  if (!sport && items.some((i) => LOUNGE.has(i.kindLabel))) s -= 1.5;

  if (needs.target != null) {
    const top = base[0];
    const wTop = itemWarmth(top);
    const upper = jacket ? 1 - (1 - wTop) * (1 - itemWarmth(jacket) * 0.9) : wTop;
    s -= 3 * Math.abs(upper - needs.target);
    if (needs.jacket === 'need' && !jacket) s -= 2;
    // Hosen sind von Natur aus weniger warm/kalt als Oberteile -> engerer Zielbereich
    if (base[1]) s -= 2 * Math.abs(itemWarmth(base[1]) - (0.15 + needs.target * 0.4));
    if (shoe) s -= 1.2 * Math.abs(itemWarmth(shoe) - needs.target);
  }
  // Gegensätze wie Sandalen + Daunenjacke oder Shorts + Wollmantel vermeiden (auch ohne Wetter)
  const warmths = items.filter((i) => i.category !== 'accessoires').map(itemWarmth);
  const spread = Math.max(...warmths) - Math.min(...warmths);
  s -= 2.5 * Math.max(0, spread - 0.6);
  // Passen die Teile vom Style her zusammen?
  const vecs = items.filter((i) => i.category !== 'accessoires').map(styleVec);
  let coh = 0, pairs = 0;
  for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) { coh += cosine(vecs[i], vecs[j]); pairs++; }
  if (pairs) s += 1.5 * (coh / pairs);
  if (wants) s += 1.5 * items.reduce((a, it) => a + affinity(it, wants), 0) / items.length;
  if (style) {
    // Jedes Hauptteil soll zum Style passen; ein klar unpassendes Teil kostet extra
    const core = items.filter((i) => CORE.has(i.category));
    const m = core.map((i) => styleMatch(i, style));
    s += 3 * m.reduce((a, v) => a + v, 0) / (m.length || 1);
    s -= 1.5 * m.filter((v) => v < 0.35).length;
  }

  s += 2 * colorScore(items);
  s += 1.5 * patternScore(items);
  return s;
}
