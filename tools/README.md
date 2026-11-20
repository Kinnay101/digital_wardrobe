# Entwickler-Werkzeuge

Nicht Teil der App. Alle Befehle im Projektordner ausführen.

## `fetch_vendor.py` – Bibliotheken und Modelle geprüft holen
Nur Python, keine Zusatzpakete. Prüft jede Datei gegen die offizielle Prüfsumme, pinnt Hugging-Face-Modelle auf einen Commit, zerlegt Dateien über 90 MB (GitHub-Grenze 100 MB) und trägt alles in `vendor/SOURCES.json` ein.

```
python -I tools/fetch_vendor.py info <hf-repo>             # Lizenz, Commit, Dateien + Größen
python -I tools/fetch_vendor.py hf <hf-repo> <datei> ...    # Modell-Dateien nach models/<repo>/
python -I tools/fetch_vendor.py npm <paket> <version> <datei-im-paket>=<ziel> ...
python -I tools/fetch_vendor.py verify                     # alle mitgelieferten Dateien nachprüfen
```

Vorher immer: **Lizenz prüfen** (`info`). Erlaubt sind MIT, Apache, BSD o. ä. Nicht erlaubt ist „research only“, z. B. Apple AMLR oder die NVIDIA Source Code License. npm-Versionen müssen mindestens 14 Tage alt sein, sonst bricht das Skript ab. Danach `vendor/README.md` ergänzen.

## `labels.html` – vorberechnete Daten neu erzeugen
`python -m http.server 8000` starten, dann http://localhost:8000/tools/labels.html öffnen.

1. **labels.json:** Text-Vektoren der Kleidungsarten für FashionSigLIP. Neu erzeugen, wenn sich die Liste `LABELS` in der Seite ändert. Ergebnis nach `js/labels.json` kopieren und die deutschen Namen in `KIND_DE` in `js/app.js` ergänzen. Ein Test am 20.11.2026 hat die vorhandene Datei byte-identisch reproduziert.
2. **SEG_TOKENS:** Token-Nummern der CLIPSeg-Suchbegriffe. Neu erzeugen, wenn sich `SEG_GARMENTS` in `js/ai.js` oder die Gegenklassen ändern, und das Ergebnis in `js/ai.js` ersetzen. Nötig, weil transformers.js 4.3.2 den Tokenizer bei Modellen von der eigenen Adresse nicht laden kann.

3. **attrs.json:** Text-Vektoren für Muster, Style und Saison (je Klasse über mehrere Beschreibungen gemittelt). Neu erzeugen, wenn sich `ATTR_GROUPS` in `js/attrs.js` ändert; danach `ANALYSIS_VERSION` in `js/analyze.js` hochzählen, damit vorhandene Teile neu analysiert werden.

Die Seite lädt dafür einmalig die Text-Modelle von huggingface.co. Die App selbst lädt nie etwas von dort.

## `receive.py` – Ergebnisse direkt speichern
`python tools/receive.py` (lauscht nur auf 127.0.0.1:8001). Läuft er, speichert `labels.html` die erzeugten Dateien direkt nach `js/` statt sie herunterzuladen. Nimmt nur `attrs.json` und `labels.json` an.
