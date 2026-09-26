/* IBKR Realised P&L - offline shell service worker (scope: served folder root).

   Caches ONLY the static app shell allowlisted below. Everything else is left
   completely alone: /data/*, any *.csv (uploaded, dropped or fetched) and the
   cross-origin USD/AUD FX lookups (frankfurter.dev, open.er-api.com,
   cdn.jsdelivr.net) are never intercepted, never cached and never served from
   here - statement data stays in the page and localStorage exactly as before.

   Strategy: network-first, falling back to the cached shell when offline;
   `activate` purges any older shell caches. */
'use strict';

const CACHE = 'ibkr-shell-v2';

/* Explicit allowlist, resolved against this worker's location so a sub-path
   deployment (e.g. GitHub Pages) caches its own copy of the shell. */
const SHELL = [
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon-180.png'
];

const SHELL_URLS = SHELL.map((path) => new URL(path, self.location).href);
const INDEX = new URL('index.html', self.location);
const SHELL_PATHS = {};

for (const href of SHELL_URLS) SHELL_PATHS[new URL(href).pathname] = href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* Only allowlisted same-origin GETs are intercepted. Returning without calling
   respondWith leaves /data/*, *.csv and cross-origin requests entirely to the
   network - they can never enter the cache. */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // '/' is a navigation to the dashboard itself; everything else must match
  // the allowlist exactly (query strings included in the request, not the key).
  const path = url.pathname === '/' ? INDEX.pathname : url.pathname;
  const cacheKey = SHELL_PATHS[path];
  if (!cacheKey) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(cacheKey, copy));
        }
        return response;
      })
      .catch(() => caches.match(cacheKey).then((hit) => hit || caches.match(INDEX.href)))
  );
});
