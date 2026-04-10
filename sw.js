const CACHE_NAME = 'senpixel-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// Установка воркера
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// Активация и работа в фоне
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});