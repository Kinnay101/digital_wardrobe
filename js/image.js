// Bildverarbeitung: verkleinern, Hintergrund entfernen, aufräumen, zuschneiden, Farbe erkennen.
import { segmentMask, garmentMaps, SEG_GARMENTS } from './ai.js';

const MAX_SIDE = 1200;

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht geladen werden')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Verkleinert das Foto auf max. MAX_SIDE px (spart Speicher und beschleunigt die Freistellung). */
export async function downscale(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvasToBlob(c, 'image/jpeg', 0.9);
}

/** Entfernt den Hintergrund lokal im Browser und räumt die Maske auf. onProgress(0…1) beim Modell-Download. */
export async function removeBackground(blob, onProgress) {
  const mask = await segmentMask(blob, onProgress);
  cleanMask(mask.data, mask.width, mask.height);
  const img = await loadImage(blob);
  const c = document.createElement('canvas');
  c.width = mask.width; c.height = mask.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const px = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < mask.data.length; i++) px.data[i * 4 + 3] = mask.data[i];
  ctx.putImageData(px, 0, 0);
  return canvasToBlob(c, 'image/png');
}

/**
 * Löst auf einem Foto mit Person jedes Kleidungsstück einzeln heraus.
 * RMBG liefert die scharfe Außenkante (Person vs. Hintergrund), CLIPSeg ordnet jedes Pixel einem
 * Kleidungsstück oder einer Gegenklasse (Haut, Gesicht …) zu.
 * Liefert { person: boolean, pieces: [{ category, blob, area }] } – nach Fläche sortiert.
 */
export async function extractGarments(blob, onProgress) {
  const fg = await segmentMask(blob, onProgress);
  const maps = await garmentMaps(blob, onProgress);
  const { probs, n, h, w, garments } = maps;
  const W = fg.width, H = fg.height, N = W * H;

  // Zu jedem Pixel den wahrscheinlichsten Begriff (bilinear aus dem 352er Raster)
  const label = new Int16Array(N).fill(-1);
  let fgCount = 0, personCount = 0;
  const plane = h * w;
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(h - 1, (y + 0.5) * h / H - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (fg.data[i] < 128) continue;
      fgCount++;
      const fx = Math.max(0, Math.min(w - 1, (x + 0.5) * w / W - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = y0 * w + x0, b = y0 * w + x1, c = y1 * w + x0, d = y1 * w + x1;
      const wa = (1 - tx) * (1 - ty), wb = tx * (1 - ty), wc = (1 - tx) * ty, wd = tx * ty;
      let best = -1, bp = 0;
      for (let k = 0; k < n; k++) {
        const o = k * plane;
        const p = probs[o + a] * wa + probs[o + b] * wb + probs[o + c] * wc + probs[o + d] * wd;
        if (p > bp) { bp = p; best = k; }
      }
      if (best >= garments) personCount++;
      else if (bp > 0.35) label[i] = best;
    }
  }
  const person = fgCount > 0 && personCount / fgCount > 0.04;

  // Begriffe zu Teilen zusammenfassen: eine Kategorie = ein Teil; Accessoires einzeln (Tasche ≠ Hut)
  const keyOf = (k) => {
    const [cat, text] = SEG_GARMENTS[k];
    return cat === 'accessoires' ? `accessoires:${text}` : cat;
  };
  const areas = new Map();
  for (let i = 0; i < N; i++) if (label[i] >= 0) { const k = keyOf(label[i]); areas.set(k, (areas.get(k) || 0) + 1); }
  // "Kleid" vs. "Oberteil": CLIPSeg verwechselt lange Oberteile gern mit Kleidern -> die größere Fläche gewinnt
  const top = areas.get('oberteile') || 0, dress = areas.get('kleider') || 0, pants = areas.get('hosen') || 0;
  const merge = dress && top ? (dress < top || pants > dress * 0.3 ? ['kleider', 'oberteile'] : ['oberteile', 'kleider']) : null;

  const pieces = [];
  const img = await loadImage(blob);
  for (const [key, area] of areas) {
    if (merge && key === merge[0]) continue;
    if (area < N * 0.015) continue; // Winzige Flächen ignorieren
    const keys = merge && key === merge[1] ? [merge[0], merge[1]] : [key];
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (label[i] >= 0 && keys.includes(keyOf(label[i]))) mask[i] = fg.data[i];
    cleanMask(mask, W, H);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H);
    let kept = 0;
    for (let i = 0; i < N; i++) { px.data[i * 4 + 3] = mask[i]; if (mask[i] > 128) kept++; }
    if (kept < N * 0.01) continue;
    ctx.putImageData(px, 0, 0);
    const cut = await trimTransparent(await canvasToBlob(c, 'image/png'));
    pieces.push({ category: key.split(':')[0], blob: cut, area: kept });
  }
  pieces.sort((p, q) => q.area - p.area);
  return { person, pieces };
}

/**
 * Räumt eine Freistell-Maske auf (verändert `a` direkt):
 * 1. schwache Schleier weg, fast deckende Pixel voll deckend
 * 2. nur große zusammenhängende Flächen behalten (lose Flecken und Krümel fliegen raus;
 *    ein Schuhpaar bleibt erhalten, weil beide Schuhe ähnlich groß sind)
 * 3. weiche Kanten nur direkt am Kleidungsstück behalten
 * 4. kleine Löcher im Stoff schließen (z. B. ein Aufdruck, den das Modell für Hintergrund hält)
 */
export function cleanMask(a, w, h) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    if (a[i] < 24) a[i] = 0;
    else if (a[i] > 232) a[i] = 255;
  }

  const { labels, sizes } = components(n, w, (i) => a[i] >= 128);
  if (sizes.length <= 1) return;
  const largest = Math.max(...sizes);
  const keep = sizes.map((s) => s >= largest * 0.08);
  const keepMask = new Uint8Array(n);
  let keptArea = 0;
  for (let i = 0; i < n; i++) if (keep[labels[i]] && labels[i]) { keepMask[i] = 1; keptArea++; }

  const near = dilate(keepMask, w, h, 4);
  for (let i = 0; i < n; i++) {
    if (!near[i] || (labels[i] && !keep[labels[i]])) a[i] = 0;
  }

  const holes = components(n, w, (i) => a[i] < 128, true, h);
  for (let i = 0; i < n; i++) {
    const l = holes.labels[i];
    if (l && !holes.border[l] && holes.sizes[l] < keptArea * 0.01) a[i] = 255;
  }
}

/** Zusammenhängende Flächen (4er-Nachbarschaft). Label 0 = gehört zu keiner Fläche. */
function components(n, w, inside, trackBorder = false, h = 0) {
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  const sizes = [0];
  const border = [false];
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] || !inside(i)) continue;
    cur++;
    let sp = 0, size = 0, touches = false;
    stack[sp++] = i;
    labels[i] = cur;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      if (trackBorder && (x === 0 || x === w - 1 || p < w || p >= n - w)) touches = true;
      if (x > 0 && !labels[p - 1] && inside(p - 1)) { labels[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < w - 1 && !labels[p + 1] && inside(p + 1)) { labels[p + 1] = cur; stack[sp++] = p + 1; }
      if (p >= w && !labels[p - w] && inside(p - w)) { labels[p - w] = cur; stack[sp++] = p - w; }
      if (p < n - w && !labels[p + w] && inside(p + w)) { labels[p + w] = cur; stack[sp++] = p + w; }
    }
    sizes.push(size);
    border.push(touches);
  }
  return { labels, sizes, border };
}

/** Vergrößert eine 0/1-Maske um r Pixel (getrennt nach Zeilen und Spalten, daher schnell). */
function dilate(m, w, h, r) {
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let c = 0;
    for (let x = 0; x < Math.min(r, w); x++) c += m[o + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) c += m[o + x + r];
      if (x - r - 1 >= 0) c -= m[o + x - r - 1];
      tmp[o + x] = c > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < Math.min(r, h); y++) c += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) c += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) c -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = c > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Legt ein (freigestelltes) Bild auf weißen Grund, max. 512 px – Eingabe für die Kategorie-Erkennung. */
export async function onWhite(blob) {
  const img = await loadImage(blob);
  const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.92);
}

/** Schneidet transparente Ränder ab und lässt etwas Luft. */
export async function trimTransparent(blob, pad = 8) {
  const img = await loadImage(blob);
  const { naturalWidth: w, naturalHeight: h } = img;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return blob; // komplett transparent -> unverändert
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
  return canvasToBlob(out, 'image/png');
}

/* ---------- Drehen ---------- */

/** Zeichnet ein Bild um deg Grad (im Uhrzeigersinn) gedreht auf eine passende Fläche (Ecken transparent). */
function drawRotated(img, deg, scale = 1) {
  const rad = (deg * Math.PI) / 180;
  const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * cos + h * sin));
  c.height = Math.max(1, Math.round(w * sin + h * cos));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

/** Dreht ein Bild um deg Grad im Uhrzeigersinn. Freigestellte Bilder werden danach wieder eng zugeschnitten. */
export async function rotateImage(blob, deg, { trim = false } = {}) {
  if (!blob || !(deg % 360)) return blob;
  const out = await canvasToBlob(drawRotated(await loadImage(blob), deg), 'image/png');
  return trim ? trimTransparent(out) : out;
}

/** Sichtbare Pixel (Alpha > 50 %) eines verkleinerten, gedrehten Bildes als Maske. */
function smallMask(img, deg, size = 160) {
  const c = drawRotated(img, deg, size / Math.max(img.naturalWidth, img.naturalHeight));
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0;
  return { w, h, m };
}

/** Anteil der Spalten (Rand-Zone links bzw. rechts), die quer zwei getrennte Stoffbahnen haben – wie zwei Hosenbeine. */
function legColumns(mask) {
  const { w, h, m } = mask;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return null;
  const W = x1 - x0 + 1, H = y1 - y0 + 1;
  const minRun = Math.max(2, H * 0.08), minGap = Math.max(2, H * 0.04);
  // Zusammenhängende Stoffstücke in einer Spalte; kleine Lücken (Falten, Nähte) werden überbrückt,
  // sehr kurze Stücke (Kordel, Etikett) zählen nicht
  const runsAt = (x) => {
    let runs = 0, len = 0, gap = 0;
    for (let y = y0; y <= y1; y++) {
      if (m[y * w + x]) {
        len += 1 + (len ? gap : 0);
        gap = 0;
      } else if (len && ++gap >= minGap) {
        if (len >= minRun) runs++;
        len = 0; gap = 0;
      }
    }
    if (len >= minRun) runs++;
    return runs;
  };
  const zone = Math.max(1, Math.round(W * 0.3));
  const frac = (from) => { let n = 0; for (let i = 0; i < zone; i++) if (runsAt(from + i) >= 2) n++; return n / zone; };
  return { W, H, left: frac(x0), right: frac(x1 - zone + 1) };
}

/**
 * Schlägt vor, wie ein freigestelltes Teil gedreht werden sollte (Grad im Uhrzeigersinn, 0 = passt):
 * 1. Schräg fotografiert: der Winkel (bis ±35°), bei dem der umschließende Rahmen am kleinsten ist.
 * 2. Hose liegt quer: die Seite mit zwei Beinen kommt nach unten.
 * Hochkant liegende Teile werden nie auf den Kopf gestellt (Schultern sähen sonst wie Beine aus).
 */
export async function suggestRotation(cutout) {
  const img = await loadImage(cutout);
  const base = smallMask(img, 0);
  const pts = [];
  for (let y = 0; y < base.h; y++) for (let x = 0; x < base.w; x++) if (base.m[y * base.w + x]) pts.push(x, y);
  if (pts.length < 200) return 0;
  const area = (deg) => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    let a = Infinity, b = -Infinity, e = Infinity, f = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] * c - pts[i + 1] * s, y = pts[i] * s + pts[i + 1] * c;
      if (x < a) a = x; if (x > b) b = x; if (y < e) e = y; if (y > f) f = y;
    }
    return (b - a) * (f - e);
  };
  let tilt = 0, best = area(0);
  for (let deg = -35; deg <= 35; deg++) {
    const v = area(deg);
    if (v < best) { best = v; tilt = deg; }
  }
  // Nur deutlich schräge Fotos geradestellen
  if (Math.abs(tilt) < 3 || best > area(0) * 0.97) tilt = 0;

  const legs = legColumns(tilt ? smallMask(img, tilt) : base);
  if (!legs || legs.W < legs.H * 1.15) return tilt;
  if (legs.left >= 0.55 && legs.right <= 0.15) return tilt - 90; // Beine links -> gegen den Uhrzeigersinn
  if (legs.right >= 0.55 && legs.left <= 0.15) return tilt + 90; // Beine rechts -> im Uhrzeigersinn
  return tilt;
}

/* ---------- Farberkennung ---------- */

export const COLORS = [
  { id: 'schwarz', name: 'Schwarz', hex: '#1C1C1C' },
  { id: 'weiss', name: 'Weiß', hex: '#F5F5F2' },
  { id: 'grau', name: 'Grau', hex: '#9A9A98' },
  { id: 'beige', name: 'Beige', hex: '#D9C7A7' },
  { id: 'camel', name: 'Camel', hex: '#B98A55' },
  { id: 'braun', name: 'Braun', hex: '#7A5234' },
  { id: 'rot', name: 'Rot', hex: '#C3312D' },
  { id: 'bordeaux', name: 'Bordeaux', hex: '#6E1E2A' },
  { id: 'rosa', name: 'Rosa', hex: '#E8A3B5' },
  { id: 'orange', name: 'Orange', hex: '#E07A2E' },
  { id: 'gelb', name: 'Gelb', hex: '#E8C547' },
  { id: 'gruen', name: 'Grün', hex: '#4E7A46' },
  { id: 'dunkelgruen', name: 'Dunkelgrün', hex: '#2C3E2D' },
  { id: 'oliv', name: 'Oliv', hex: '#6B6B3A' },
  { id: 'hellblau', name: 'Hellblau', hex: '#9DBBD9' },
  { id: 'blau', name: 'Blau', hex: '#3E6FB8' },
  { id: 'navy', name: 'Navy', hex: '#1F2B4A' },
  { id: 'lila', name: 'Lila', hex: '#7C5AA6' },
  { id: 'bunt', name: 'Bunt', hex: 'conic-gradient(#e44, #ec4, #4b6, #48e, #a5c, #e44)' },
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// sRGB -> CIE Lab (D65). Abstände in Lab entsprechen besser der menschlichen Wahrnehmung als RGB.
function rgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// Zusätzliche Referenztöne je Farbgruppe (kräftige/helle Varianten), damit z. B. Königsblau nicht als Lila gilt
const EXTRA_TONES = {
  blau: ['#2A55D0', '#1E4FA8'], lila: ['#5B2C8F', '#B59AD6'], rot: ['#E02020', '#A82222'], gruen: ['#2FA84F', '#8DBF7A', '#9FD8C0'],
  rosa: ['#F2C4CE', '#E0679A'], orange: ['#F28C28'], gelb: ['#F5D90A', '#F0E2A0'], hellblau: ['#B9D4EE', '#6FA8DC'],
  grau: ['#C8C8C6', '#6A6A68', '#5E5E5E'], beige: ['#EDE3CF'], navy: ['#24305E'],
  // Dunkles Braun wirkt auf Fotos kaum gesättigt (Lab etwa L 20–40, Buntheit 6–10) – sonst wird es Schwarz/Grau
  braun: ['#5A3A22', '#433129', '#56423F', '#715952'],
};
// Dunkle, fast farblose Töne (Schatten, Lichtreflexe auf Schwarz) nur Schwarz/Grau/Weiß zuordnen,
// damit die gedeckten Brauntöne oben schwarze Kleidung nicht braun färben
const MIN_DARK_CHROMA = 5;
const PALETTE = () => COLORS.filter((c) => c.hex.startsWith('#'))
  .flatMap((c) => [c.hex, ...(EXTRA_TONES[c.id] || [])].map((hex) => ({ id: c.id, lab: rgbToLab(...hexToRgb(hex)) })));
const NEUTRAL = ['schwarz', 'weiss', 'grau'];

/** Liest die sichtbaren Pixel eines Bildes als Lab-Werte (bei Fotos ohne Transparenz nur die Bildmitte). */
async function visibleLab(blob, size = 96) {
  const img = await loadImage(blob);
  const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }
  const px = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hasAlpha && (x < w * 0.25 || x > w * 0.75 || y < h * 0.2 || y > h * 0.8)) continue;
      const i = (y * w + x) * 4;
      if (d[i + 3] < 200) continue; // halbtransparente Kanten ignorieren
      px.push(rgbToLab(d[i], d[i + 1], d[i + 2]));
    }
  }
  return px;
}

// Abstand in Lab; Helligkeit schwächer gewichtet, damit Schatten und Falten keine eigene Farbe werden
const labDist = (p, q, wl = 0.5) => {
  const dl = (p[0] - q[0]) * wl, da = p[1] - q[1], db = p[2] - q[2];
  return dl * dl + da * da + db * db;
};

/**
 * Hauptfarben eines Kleidungsstücks: [{ id, share }] (max. 3, Anteile summieren sich zu 1).
 * k-means in Lab, ähnliche Gruppen werden zusammengelegt und dann den Farbgruppen zugeordnet.
 * Mehrere Bilder (Vorder- und Rückseite) werden zusammen ausgewertet.
 */
export async function extractColors(blobs) {
  const px = [];
  for (const b of [].concat(blobs).filter(Boolean)) px.push(...(await visibleLab(b)));
  if (!px.length) return [{ id: 'grau', share: 1 }];

  // k-means++-ähnlicher Start: helle, dunkle und möglichst unterschiedliche Punkte
  const K = Math.min(6, px.length);
  const centers = [px[Math.floor(px.length / 2)]];
  while (centers.length < K) {
    let best = null, bd = -1;
    for (let i = 0; i < px.length; i += 3) {
      const d = Math.min(...centers.map((c) => labDist(px[i], c)));
      if (d > bd) { bd = d; best = px[i]; }
    }
    centers.push(best);
  }
  let assign = new Int32Array(px.length);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < px.length; i++) {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < centers.length; k++) { const d = labDist(px[i], centers[k]); if (d < bd) { bd = d; bi = k; } }
      assign[i] = bi;
    }
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) { const s = sum[assign[i]]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++; }
    sum.forEach((s, k) => { if (s[3]) centers[k] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const counts = centers.map(() => 0);
  for (let i = 0; i < px.length; i++) counts[assign[i]]++;

  // Mischfarben an Kanten (z. B. Rand zwischen weißem und blauem Streifen) sind keine eigene Farbe:
  // Liegt eine kleine Gruppe nahe der Verbindungslinie zweier größerer, wird sie auf diese verteilt.
  const n = px.length;
  for (let c = 0; c < centers.length; c++) {
    if (!counts[c] || counts[c] / n > 0.2) continue;
    let done = false;
    for (let a = 0; a < centers.length && !done; a++) {
      for (let b = a + 1; b < centers.length && !done; b++) {
        if (a === c || b === c || counts[a] <= counts[c] || counts[b] <= counts[c]) continue;
        const A = centers[a], B = centers[b], C = centers[c];
        const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
        if (!len2) continue;
        const t = ((C[0] - A[0]) * ab[0] + (C[1] - A[1]) * ab[1] + (C[2] - A[2]) * ab[2]) / len2;
        if (t < 0.12 || t > 0.88) continue;
        const proj = [A[0] + t * ab[0], A[1] + t * ab[1], A[2] + t * ab[2]];
        if (labDist(C, proj, 1) > 12 * 12) continue;
        counts[a] += counts[c] * (1 - t);
        counts[b] += counts[c] * t;
        counts[c] = 0;
        done = true;
      }
    }
  }

  // Gleicher Farbton, nur heller/dunkler (Schatten, Falten) -> eine Gruppe
  for (let a = 0; a < centers.length; a++) {
    for (let b = 0; b < centers.length; b++) {
      if (a === b || !counts[a] || !counts[b] || counts[b] > counts[a]) continue;
      const A = centers[a], B = centers[b];
      const dab = Math.hypot(A[1] - B[1], A[2] - B[2]);
      const chroma = Math.max(Math.hypot(A[1], A[2]), Math.hypot(B[1], B[2]));
      // Bei bunten Farben darf die Sättigung etwas mitschwanken, bei Grautönen nicht (sonst wird Weiß zu Grau)
      const dL = Math.abs(A[0] - B[0]);
      const same = chroma > 12 ? dab < Math.max(6, chroma * 0.3) && dL < 22 : dab < 8 && dL < 12;
      if (same) {
        const w = counts[a] + counts[b];
        centers[a] = A.map((v, i) => (v * counts[a] + B[i] * counts[b]) / w);
        counts[a] = w;
        counts[b] = 0;
      }
    }
  }

  // Gruppen einer Farbgruppe zuordnen und zusammenzählen
  const palette = PALETTE();
  const shares = new Map();
  centers.forEach((c, k) => {
    if (!counts[k]) return;
    let best = null, bd = Infinity;
    const neutralOnly = c[0] < 50 && Math.hypot(c[1], c[2]) < MIN_DARK_CHROMA;
    for (const p of palette) {
      if (neutralOnly && !NEUTRAL.includes(p.id)) continue;
      const d = labDist(c, p.lab, 0.7);
      if (d < bd) { bd = d; best = p.id; }
    }
    shares.set(best, (shares.get(best) || 0) + counts[k] / px.length);
  });
  let list = [...shares.entries()].map(([id, share]) => ({ id, share })).sort((a, b) => b.share - a.share);
  list = list.filter((c, i) => i === 0 || c.share >= 0.08).slice(0, 3);
  const total = list.reduce((s, c) => s + c.share, 0);
  return list.map((c) => ({ id: c.id, share: Math.round((c.share / total) * 100) / 100 }));
}

/** Eine Farbe für Namen und Anzeige: die Hauptfarbe – oder "bunt" bei drei kräftigen Farben. */
export function primaryColor(colors) {
  const strong = colors.filter((c) => c.share >= 0.15 && !NEUTRAL.includes(c.id));
  return strong.length >= 3 ? 'bunt' : colors[0]?.id || 'grau';
}

/** Ermittelt die häufigste Farbe der sichtbaren Pixel und ordnet sie einer Farbgruppe zu. */
export async function detectColor(blob) {
  const img = await loadImage(blob);
  const size = 48;
  const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  // Bei Fotos ohne Transparenz nur die Bildmitte werten (dort ist meist das Kleidungsstück).
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }

  const palette = COLORS.filter((c) => c.hex.startsWith('#')).map((c) => ({ ...c, lab: rgbToLab(...hexToRgb(c.hex)) }));
  const votes = new Map();
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hasAlpha && (x < w * 0.25 || x > w * 0.75 || y < h * 0.2 || y > h * 0.8)) continue;
      const i = (y * w + x) * 4;
      if (d[i + 3] < 200) continue; // halbtransparente Kanten ignorieren
      const [L, A, B] = rgbToLab(d[i], d[i + 1], d[i + 2]);
      let best = null, bestDist = Infinity;
      for (const p of palette) {
        // Helligkeit etwas schwächer gewichten: Schatten/Falten sollen die Farbe nicht kippen
        const dl = (L - p.lab[0]) * 0.7, da = A - p.lab[1], db = B - p.lab[2];
        const dist = dl * dl + da * da + db * db;
        if (dist < bestDist) { bestDist = dist; best = p.id; }
      }
      votes.set(best, (votes.get(best) || 0) + 1);
      total++;
    }
  }
  if (!total) return 'grau';
  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  // Viele kräftige, verschiedene Farben -> "bunt"
  const strong = sorted.filter(([id, n]) => n / total > 0.15 && !['schwarz', 'weiss', 'grau'].includes(id));
  if (strong.length >= 3) return 'bunt';
  return sorted[0][0];
}

export function colorById(id) {
  return COLORS.find((c) => c.id === id) || COLORS[2];
}

/** Seitenverhältnis Höhe/Breite – wird für die Platzierung im Studio gebraucht. */
export async function imageAspect(blob) {
  const img = await loadImage(blob);
  return img.naturalHeight / img.naturalWidth;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}
