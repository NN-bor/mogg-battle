// Offline support. Two caches:
//  - app shell (small, refreshed in the background on every visit),
//  - heavy assets (wasm, model, fonts; cache-first, versioned by the pinned packages).
// After the first visit the app makes no network requests at all.

const APP_VERSION = '1.6.0';
const ASSET_VERSION = 'mp-0.10.35-inter-5.3.0';
const APP_CACHE = `mog-app-${APP_VERSION}`;
const ASSET_CACHE = `mog-assets-${ASSET_VERSION}`;

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/main.js',
  'js/bus.js',
  'js/fsm.js',
  'js/util.js',
  'js/settings.js',
  'js/camera.js',
  'js/view.js',
  'js/tracker.js',
  'js/assign.js',
  'js/face.js',
  'js/metrics.js',
  'js/score.js',
  'js/render-lines.js',
  'js/render-ui.js',
  'js/audio.js',
  'js/modes/duel.js',
  'js/record.js',
  'js/stabilize.js',
  'js/still.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

const ASSET_FILES = [
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'models/face_landmarker.task',
  'fonts/inter-latin-opsz-normal.woff2',
  'fonts/inter-cyrillic-opsz-normal.woff2',
  'fonts/jetbrains-mono-latin-500-normal.woff2',
  'fonts/archivo-latin-wdth-normal.woff2',
];

const HEAVY = /\/(vendor|models|fonts)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const app = await caches.open(APP_CACHE);
      await app.addAll(APP_FILES);
      const assets = await caches.open(ASSET_CACHE);
      const missing = [];
      for (const url of ASSET_FILES) if (!(await assets.match(url))) missing.push(url);
      await assets.addAll(missing);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('mog-') && key !== APP_CACHE && key !== ASSET_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(new Request(new URL('index.html', self.registration.scope)), APP_CACHE));
  } else if (HEAVY.test(url.pathname)) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
  } else {
    event.respondWith(staleWhileRevalidate(req, APP_CACHE));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await refresh) || new Response('Offline', { status: 503 });
}
