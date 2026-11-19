# Mitgelieferte Fremd-Dateien

Die App lädt zur Laufzeit **nichts von fremden Servern**. Bibliothek, Rechen-Engine und KI-Modelle liegen hier im Projekt.
Jede Datei wurde beim Herunterladen gegen die offizielle Prüfsumme geprüft (npm: sha512 des Pakets, Hugging Face: sha256 der LFS-Datei, fest auf einen Commit gepinnt). Liste mit Herkunft und sha256 jeder Datei: `SOURCES.json`.

| Datei(en) | Herkunft | Lizenz |
|---|---|---|
| `vendor/transformers/transformers.min.js` | npm `@huggingface/transformers@4.3.2` | Apache-2.0 (siehe LICENSE) |
| `vendor/ort/*` | npm `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` (Version, die transformers.js 4.3.2 erwartet) | MIT |
| `models/briaai/RMBG-1.4/` | huggingface.co/briaai/RMBG-1.4 @ `da1d078376e6` | bria-rmbg-1.4: **nur nicht-kommerziell** |
| `models/Marqo/marqo-fashionSigLIP/` | huggingface.co/Marqo/marqo-fashionSigLIP (nur Bild-Modell, q8) | Apache-2.0 |
| `vendor/supabase/supabase.js` | npm `@supabase/supabase-js@2.119.0` (bewusst eine ≥ 2 Wochen alte Version) | MIT (siehe LICENSE) |
| `js/labels.json` | selbst berechnet mit dem Text-Modell von Marqo FashionSigLIP | Apache-2.0 (abgeleitet) |

**Lizenz-Hinweise:** RMBG-1.4 ist nur für nicht-kommerzielle Nutzung freigegeben (für dieses private Projekt in Ordnung). Bei einer kommerziellen Nutzung muss es ersetzt oder eine Lizenz bei BRIA gekauft werden.
Das frühere Modell MobileCLIP (Apple) wurde entfernt: Seine Lizenz erlaubt nur Forschungszwecke.

**Aktualisieren:** Das Skript, mit dem die Dateien geladen wurden, prüft die Prüfsummen automatisch; neue Versionen bewusst und einzeln übernehmen, nicht automatisch.
