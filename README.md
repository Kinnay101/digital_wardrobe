# Kleiderschrank

Ein digitaler Kleiderschrank als Web-App (PWA) für iPhone und PC: Kleidung fotografieren, automatisch freistellen und einordnen lassen, Outfits im Studio zusammenstellen.

- **Privat:** Alle Daten (Fotos, Kleidungsstücke, Outfits) bleiben im Browser des jeweiligen Geräts. Es gibt keinen Server, kein Konto und keinen Upload.
- **Lokale KI:** Freistellen und Erkennen laufen direkt auf dem Gerät.
- **Keine fremden Server:** Bibliothek, Rechen-Engine und Modelle werden mitgeliefert; eine Content Security Policy blockiert Verbindungen nach außen.
- **Offline-fähig:** Nach dem ersten Start funktioniert die App ohne Internet.

## Auf dem iPhone installieren
Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Der erste Start lädt die KI-Modelle (am besten im WLAN).

## Lokal starten
```
python -m http.server 8000
```
→ http://localhost:8000

## Verwendete Fremd-Software und Modelle
Herkunft, Prüfsummen und Lizenzen: [vendor/README.md](vendor/README.md).

- [transformers.js](https://github.com/huggingface/transformers.js) – Apache-2.0
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) – MIT
- [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) von BRIA AI – Lizenz [bria-rmbg-1.4](https://bria.ai/bria-huggingface-model-license-agreement/), nur für nicht-kommerzielle Nutzung
- [Marqo-FashionSigLIP](https://huggingface.co/Marqo/marqo-fashionSigLIP) von Marqo – Apache-2.0
- [CLIPSeg](https://huggingface.co/CIDAS/clipseg-rd64-refined) – Apache-2.0 (Kleidung auf Fotos mit Person)
- [supabase-js](https://github.com/supabase/supabase-js) – MIT (für den optionalen, verschlüsselten Sync)

Diese App ist ein privates, nicht-kommerzielles Projekt.
