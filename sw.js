const CACHE_NAME = 'turntable-v2';   // ← changed name
const urlsToCache = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();   // activate immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});
