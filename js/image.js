// Bildverarbeitung: verkleinern, Hintergrund entfernen, aufräumen, zuschneiden, Farbe erkennen.
import { segmentMask } from './ai.js';

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

/* ---------- Farberkennung ---------- */

export const COLORS = [
  { id: 'schwarz', name: 'Schwarz', hex: '#1C1C1C' },
  { id: 'weiss', name: 'Weiß', hex: '#F5F5F2' },
  { id: 'grau', name: 'Grau', hex: '#9A9A98' },
  { id: 'beige', name: 'Beige', hex: '#D9C7A7' },
  { id: 'braun', name: 'Braun', hex: '#7A5234' },
  { id: 'rot', name: 'Rot', hex: '#C3312D' },
  { id: 'rosa', name: 'Rosa', hex: '#E8A3B5' },
  { id: 'orange', name: 'Orange', hex: '#E07A2E' },
  { id: 'gelb', name: 'Gelb', hex: '#E8C547' },
  { id: 'gruen', name: 'Grün', hex: '#4E7A46' },
  { id: 'dunkelgruen', name: 'Dunkelgrün', hex: '#2C3E2D' },
  { id: 'oliv', name: 'Oliv', hex: '#6B6B3A' },
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
