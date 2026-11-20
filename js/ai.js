// Lokale KI im Browser (transformers.js). Alles läuft auf dem Gerät, keine Daten verlassen es.
// - Freistellen: briaai/RMBG-1.4 (auf Produktfotos trainiert; Lizenz: nur nicht-kommerzielle Nutzung)
// - Kategorie:   Marqo/marqo-fashionSigLIP (auf Mode trainiert, Apache-2.0); nur das Bild-Modell wird
//                geladen, die Text-Seite ist in labels.json vorberechnet. Im Vergleich 17/17 richtig.
// Bibliothek, Rechen-Engine und Modelle liegen im Projekt (vendor/, models/) – es wird nichts
// von fremden Servern geladen. Herkunft und Prüfsummen: vendor/README.md und vendor/SOURCES.json.

const TF_URL = new URL('../vendor/transformers/transformers.min.js', import.meta.url).href;
const MODELS_URL = new URL('../models/', import.meta.url).href;
const ORT_URL = new URL('../vendor/ort/', import.meta.url).href;
const RMBG = 'briaai/RMBG-1.4';
const CLIP = 'Marqo/marqo-fashionSigLIP';

let tfPromise;
const loadTf = () => (tfPromise ??= import(TF_URL).then((TF) => {
  TF.env.allowRemoteModels = false; // niemals von huggingface.co nachladen
  TF.env.allowLocalModels = true;
  TF.env.localModelPath = MODELS_URL;
  TF.env.backends.onnx.wasm.wasmPaths = ORT_URL; // Rechen-Engine nicht vom CDN holen
  TF.env.fetch = splitAwareFetch(TF.env.fetch);
  return TF;
}));

/**
 * GitHub erlaubt keine Dateien über 100 MB. Größere Modelle liegen daher in Teilen vor
 * (<datei>.part1, .part2 … plus <datei>.parts.json mit Größe und SHA-256).
 * Fehlt eine Datei, werden die Teile geladen, zusammengesetzt und die Prüfsumme kontrolliert.
 */
function splitAwareFetch(baseFetch) {
  return async (input, init) => {
    const url = String(input?.url ?? input);
    const res = await baseFetch(input, init);
    if (res.status !== 404 || !url.startsWith(MODELS_URL)) return res;
    const manifestRes = await baseFetch(url + '.parts.json');
    if (!manifestRes.ok) return res;
    const { size, sha256, parts } = await manifestRes.json();
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    const chunks = [];
    let loaded = 0;
    for (const part of parts) {
      const r = await baseFetch(dir + part);
      if (!r.ok) throw new Error(`Modell-Teil fehlt: ${part}`);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress({ status: 'progress', file: url, loaded, total: size });
      }
    }
    const whole = new Blob(chunks);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await whole.arrayBuffer()));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (whole.size !== size || hex !== sha256) throw new Error('Prüfsumme des Modells stimmt nicht – Datei beschädigt oder verändert.');
    return new Response(whole, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) } });
  };
}

/* Fortschritt beim Herunterladen der Modelle (über alle Dateien zusammengerechnet) */
let progressListener = null;
const files = new Map();
function onProgress(p) {
  if (p.status !== 'progress' || !p.total) return;
  files.set(p.file, { loaded: p.loaded, total: p.total });
  let loaded = 0, total = 0;
  for (const f of files.values()) { loaded += f.loaded; total += f.total; }
  progressListener?.(loaded / total);
}

async function hasWebGpu() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

/* ---------- Freistellen ---------- */
let rmbgPromise;
function loadRmbg() {
  rmbgPromise ??= (async () => {
    const TF = await loadTf();
    const base = { config: { model_type: 'custom' }, progress_callback: onProgress };
    let model;
    if (await hasWebGpu()) {
      try { model = await TF.AutoModel.from_pretrained(RMBG, { ...base, device: 'webgpu', dtype: 'fp16' }); }
      catch (err) { console.warn('WebGPU nicht nutzbar, nutze WASM', err); }
    }
    model ??= await TF.AutoModel.from_pretrained(RMBG, { ...base, device: 'wasm', dtype: 'q8' });
    const processor = await TF.AutoProcessor.from_pretrained(RMBG, {
      config: {
        do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
        image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1], resample: 2,
        rescale_factor: 1 / 255, size: { width: 1024, height: 1024 },
        feature_extractor_type: 'ImageFeatureExtractor',
      },
    });
    return { TF, model, processor };
  })().catch((err) => { rmbgPromise = null; throw err; });
  return rmbgPromise;
}

/** Liefert die Freistell-Maske (0–255 je Pixel) in Originalgröße. */
export async function segmentMask(blob, onLoadProgress) {
  progressListener = onLoadProgress;
  try {
    const { TF, model, processor } = await loadRmbg();
    const image = await TF.RawImage.fromBlob(blob);
    const { pixel_values } = await processor(image);
    const { output } = await model({ input: pixel_values });
    const mask = await TF.RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(image.width, image.height);
    return { data: mask.data, width: image.width, height: image.height };
  } finally {
    progressListener = null;
  }
}

/* ---------- Kategorie ---------- */
const fetchJson = (name) => fetch(new URL(name, import.meta.url)).then((r) => r.json());
/** Vorberechnete Text-Vektoren entpacken (int8 + Skalierung je Vektor). */
function unpackVectors(d) {
  const raw = Uint8Array.from(atob(d.emb), (c) => c.charCodeAt(0));
  const q = new Int8Array(raw.buffer);
  return d.scales.map((s, i) => Float32Array.from(q.subarray(i * d.dim, (i + 1) * d.dim), (v) => v * s));
}
// Merkmal-Vektoren (Muster, Style, Saison, Marke) – klein, ohne Bild-Modell ladbar
let attrPromise;
function loadAttrs() {
  attrPromise ??= fetchJson('./attrs.json').then((attrs) => {
    const vecs = unpackVectors(attrs);
    let k = 0;
    const groups = {};
    for (const [g, ids] of Object.entries(attrs.groups)) groups[g] = ids.map((id) => ({ id, vec: vecs[k++] }));
    return groups;
  }).catch((err) => { attrPromise = null; throw err; });
  return attrPromise;
}

let clipPromise;
function loadClip() {
  clipPromise ??= (async () => {
    const TF = await loadTf();
    const [processor, model, labels] = await Promise.all([
      TF.AutoProcessor.from_pretrained(CLIP),
      // q8 auf WASM: im Test genauso treffsicher wie größere Varianten; WebGPU brachte hier keinen Vorteil
      TF.SiglipVisionModel.from_pretrained(CLIP, { dtype: 'q8', device: 'wasm', progress_callback: onProgress }),
      fetchJson('./labels.json'),
    ]);
    return { TF, processor, model, cats: labels.cats, labels: labels.labels, emb: unpackVectors(labels) };
  })().catch((err) => { clipPromise = null; throw err; });
  return clipPromise;
}

/* ---------- Kleidung auf Fotos mit Person (CLIPSeg, Apache-2.0) ---------- */
// CLIPSeg bekommt Begriffe und liefert für jeden eine grobe Wahrscheinlichkeitskarte (352×352).
// Gegenklassen (Gesicht, Haut …) sorgen dafür, dass die Person selbst nicht als Kleidung zählt.
const CLIPSEG = 'Xenova/clipseg-rd64-refined';
export const SEG_GARMENTS = [
  ['oberteile', 'a shirt'], ['oberteile', 'a sweater'], ['jacken', 'a jacket'], ['kleider', 'a dress'],
  ['hosen', 'pants'], ['hosen', 'jeans'], ['hosen', 'a skirt'], ['schuhe', 'shoes'],
  ['accessoires', 'a bag'], ['accessoires', 'a hat'], ['accessoires', 'a belt'],
];
// Gegenklassen: 'a face', 'hair', 'an arm', 'a hand', 'skin', 'a leg', 'the background'
// Die Begriffe sind fest, daher sind ihre Token-Nummern vorberechnet (mit dem CLIPSeg-Tokenizer,
// gleiche Reihenfolge: erst SEG_GARMENTS, dann die Gegenklassen). So braucht es zur Laufzeit keinen
// Tokenizer – dessen Ladeprüfung schlägt in transformers.js 4.3.2 bei Modellen von der eigenen Adresse fehl.
const SEG_TOKENS = {
  dims: [18, 4],
  input_ids: [49406, 320, 2523, 49407, 49406, 320, 11455, 49407, 49406, 320, 6164, 49407, 49406, 320, 2595, 49407, 49406, 5003, 49407, 49407, 49406, 10157, 49407, 49407, 49406, 320, 12386, 49407, 49406, 4079, 49407, 49407, 49406, 320, 3365, 49407, 49406, 320, 3801, 49407, 49406, 320, 7373, 49407, 49406, 320, 1710, 49407, 49406, 2225, 49407, 49407, 49406, 550, 4793, 49407, 49406, 320, 2463, 49407, 49406, 3575, 49407, 49407, 49406, 320, 4924, 49407, 49406, 518, 5994, 49407],
  attention_mask: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1],
};

let segPromise;
function loadSeg() {
  segPromise ??= (async () => {
    const TF = await loadTf();
    const [processor, model] = await Promise.all([
      TF.AutoProcessor.from_pretrained(CLIPSEG),
      TF.CLIPSegForImageSegmentation.from_pretrained(CLIPSEG, { dtype: 'q8', device: 'wasm', progress_callback: onProgress }),
    ]);
    const tensor = (values) => new TF.Tensor('int64', BigInt64Array.from(values, BigInt), SEG_TOKENS.dims);
    const textInputs = { input_ids: tensor(SEG_TOKENS.input_ids), attention_mask: tensor(SEG_TOKENS.attention_mask) };
    return { TF, processor, model, textInputs };
  })().catch((err) => { segPromise = null; throw err; });
  return segPromise;
}

/**
 * Wahrscheinlichkeitskarten für Kleidung und Gegenklassen.
 * probs: Float32Array [n * h * w]; die ersten SEG_GARMENTS.length Einträge sind Kleidung, der Rest Gegenklassen.
 */
export async function garmentMaps(blob, onLoadProgress) {
  progressListener = onLoadProgress;
  try {
    const { TF, processor, model, textInputs } = await loadSeg();
    const image = await TF.RawImage.fromBlob(blob);
    const { logits } = await model({ ...textInputs, ...(await processor(image)) });
    const [n, h, w] = logits.dims;
    return { probs: logits.sigmoid().data, n, h, w, garments: SEG_GARMENTS.length };
  } finally {
    progressListener = null;
  }
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function softmax(logits) {
  const max = Math.max(...logits);
  const exp = logits.map((l) => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / sum);
}

/**
 * Erkennt die Kategorie. Das Bild sollte freigestellt auf hellem Grund liegen.
 * Liefert zusätzlich den Bild-Vektor (embedding) und die Merkmal-Wahrscheinlichkeiten (attrs).
 */
export async function classify(blob, onLoadProgress) {
  progressListener = onLoadProgress;
  try {
    const { TF, processor, model, cats, labels, emb } = await loadClip();
    const image = await TF.RawImage.fromBlob(blob);
    const { image_embeds } = await model(await processor(image));
    const img = image_embeds.normalize().data;
    const logits = emb.map((t) => 100 * dot(t, img));
    const probs = softmax(logits);
    const scores = {};
    probs.forEach((v, i) => { scores[cats[i]] = (scores[cats[i]] || 0) + v; });
    const [category, confidence] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return { category, confidence, label: labels[logits.indexOf(Math.max(...logits))], embedding: Float32Array.from(img), attrs: await scoreAttrs(img) };
  } finally {
    progressListener = null;
  }
}

/**
 * Wahrscheinlichkeiten je Merkmal-Gruppe (Muster, Style, Saison) für einen Bild-Vektor.
 * Funktioniert auch mit gespeicherten Vektoren, ohne das Bild-Modell erneut laufen zu lassen.
 */
export async function scoreAttrs(embedding) {
  const attrGroups = await loadAttrs();
  const out = {};
  for (const [g, classes] of Object.entries(attrGroups)) {
    const p = softmax(classes.map((c) => 100 * dot(c.vec, embedding)));
    out[g] = Object.fromEntries(classes.map((c, i) => [c.id, p[i]]));
  }
  return out;
}
