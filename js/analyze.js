// Analyse eines Kleidungsstücks (Vorder- und optional Rückseite):
// Kategorie + Art, Hauptfarben, Muster, Style und Saison. Alles lokal (FashionSigLIP + Farbanalyse).
import { classify } from './ai.js';
import { onWhite, extractColors, primaryColor } from './image.js';

// Hochzählen, wenn sich die Analyse so ändert, dass vorhandene Teile neu analysiert werden sollen.
export const ANALYSIS_VERSION = 1;

/** Bild-Vektor kompakt speichern (int8 + Skalierung, ~1 KB) – für spätere Auswertungen ohne neues Rechnen. */
export function packEmbedding(v) {
  const m = Math.max(...v.map(Math.abs)) || 1;
  const q = Int8Array.from(v, (x) => Math.round((x / m) * 127));
  let s = '';
  const u = new Uint8Array(q.buffer);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return { s: +(m / 127).toPrecision(6), q: btoa(s) };
}
export function unpackEmbedding(e) {
  const raw = Uint8Array.from(atob(e.q), (c) => c.charCodeAt(0));
  return Float32Array.from(new Int8Array(raw.buffer), (v) => v * e.s);
}

const top = (scores) => Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
const round = (scores) => Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round(v * 100) / 100]));

/** Styles mit deutlichem Anteil (mind. 30 %, sonst nur der stärkste), höchstens zwei. */
export function pickStyles(scores) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const list = sorted.filter(([, v], i) => i === 0 || v >= 0.3).slice(0, 2).map(([k]) => k);
  return list;
}

/**
 * Muster aus Vorder- und Rückseite: Ein Print auf einer Seite zählt (Maximum),
 * "uni" nur, wenn beide Seiten uni sind (Minimum).
 */
function combinePattern(f, b) {
  if (!b) return f;
  const out = {};
  for (const k of Object.keys(f)) out[k] = k === 'uni' ? Math.min(f[k], b[k]) : Math.max(f[k], b[k]);
  const sum = Object.values(out).reduce((a, c) => a + c, 0);
  for (const k of Object.keys(out)) out[k] /= sum;
  return out;
}
const average = (f, b) => (b ? Object.fromEntries(Object.keys(f).map((k) => [k, (f[k] + b[k]) / 2])) : f);

/**
 * front/back: freigestellte Bilder (back optional). onLoadProgress(0…1) beim ersten Laden des Modells.
 * Liefert alle erkannten Merkmale; was davon übernommen wird, entscheidet die Oberfläche.
 */
export async function analyzeItem({ front, back }, onLoadProgress) {
  const f = await classify(await onWhite(front), onLoadProgress);
  const b = back ? await classify(await onWhite(back)) : null;
  const colors = await extractColors(back ? [front, back] : front);
  const patternScores = combinePattern(f.attrs.pattern, b?.attrs.pattern);
  const styleScores = average(f.attrs.style, b?.attrs.style);
  const warmth = average(f.attrs.warmth, b?.attrs.warmth);
  return {
    category: f.category,
    confidence: f.confidence,
    kindLabel: f.label,
    colors,
    color: primaryColor(colors),
    pattern: top(patternScores),
    patternScores: round(patternScores),
    styles: pickStyles(styleScores),
    styleScores: round(styleScores),
    warmth: round(warmth),
    emb: packEmbedding(f.embedding),
    analysis: ANALYSIS_VERSION,
  };
}
