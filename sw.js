// Service Worker: macht die App offline-fähig.
// - App-Code: "Netzwerk zuerst" – Änderungen kommen sofort an, offline greift der Cache.
// - vendor/ (Bibliothek, Rechen-Engine): "Cache zuerst" – feste Versionen, ändern sich nie.
// - models/: nicht anfassen – transformers.js speichert die Modelle selbst im Cache "transformers-cache".
//   (Würden wir sie hier auch speichern, lägen ~135 MB doppelt auf dem Gerät.)
const APP_CACHE = 'kleiderschrank-v11';
const VENDOR_CACHE = 'kleiderschrank-vendor-v1'; // bei neuer Bibliotheks-Version hochzählen
const KEEP = [APP_CACHE, VENDOR_CACHE, 'transformers-cache'];
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/image.js', 'js/ai.js', 'js/labels.json',
  'js/analyze.js', 'js/attrs.js', 'js/attrs.json', 'js/suggest.js', 'js/weather.js',
  'js/sync.js', 'js/crypto.js', 'js/config.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const path = url.pathname;

  if (path.includes('/models/')) return; // siehe oben

  if (path.includes('/vendor/')) {
    e.respondWith(
      caches.open(VENDOR_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }

  // cache: 'no-cache' = beim Server nachfragen, ob sich die Datei geändert hat (sonst kann der
  // Browser-Zwischenspeicher alte und neue Dateien mischen, z. B. neue app.js + alte image.js).
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(APP_CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
