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
  return TF;
}));

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
let clipPromise;
function loadClip() {
  clipPromise ??= (async () => {
    const TF = await loadTf();
    const [processor, model, labels] = await Promise.all([
      TF.AutoProcessor.from_pretrained(CLIP),
      // q8 auf WASM: im Test genauso treffsicher wie größere Varianten; WebGPU brachte hier keinen Vorteil
      TF.SiglipVisionModel.from_pretrained(CLIP, { dtype: 'q8', device: 'wasm', progress_callback: onProgress }),
      fetch(new URL('./labels.json', import.meta.url)).then((r) => r.json()),
    ]);
    // Text-Vektoren entpacken (int8 + Skalierung je Vektor)
    const raw = Uint8Array.from(atob(labels.emb), (c) => c.charCodeAt(0));
    const q = new Int8Array(raw.buffer);
    const emb = labels.scales.map((s, i) => Float32Array.from(q.subarray(i * labels.dim, (i + 1) * labels.dim), (v) => v * s));
    return { TF, processor, model, cats: labels.cats, labels: labels.labels, emb };
  })().catch((err) => { clipPromise = null; throw err; });
  return clipPromise;
}

/** Erkennt die Kategorie. Das Bild sollte freigestellt auf hellem Grund liegen. */
export async function classify(blob, onLoadProgress) {
  progressListener = onLoadProgress;
  try {
    const { TF, processor, model, cats, labels, emb } = await loadClip();
    const image = await TF.RawImage.fromBlob(blob);
    const { image_embeds } = await model(await processor(image));
    const img = image_embeds.normalize().data;
    const logits = emb.map((t) => { let s = 0; for (let i = 0; i < t.length; i++) s += t[i] * img[i]; return 100 * s; });
    const max = Math.max(...logits);
    const exp = logits.map((l) => Math.exp(l - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    const scores = {};
    exp.forEach((v, i) => { scores[cats[i]] = (scores[cats[i]] || 0) + v / sum; });
    const [category, confidence] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return { category, confidence, label: labels[logits.indexOf(max)] };
  } finally {
    progressListener = null;
  }
}
