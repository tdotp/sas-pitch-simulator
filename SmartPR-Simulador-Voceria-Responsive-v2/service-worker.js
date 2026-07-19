const CACHE_NAME = 'smartpr-voceria-responsive-v2';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './assets/SmartPR_Logo.svg',
  './assets/SAS_Logo.svg',
  './assets/bg-login-desktop.png',
  './assets/bg-selection-desktop.png',
  './assets/bg-preparation-desktop.png',
  './assets/bg-conversation-desktop.png',
  './assets/bg-login-mobile.png',
  './assets/bg-selection-mobile.png',
  './assets/bg-preparation-mobile.png',
  './assets/bg-conversation-mobile.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      return response;
    }).catch(() => caches.match('./index.html')))
  );
});
